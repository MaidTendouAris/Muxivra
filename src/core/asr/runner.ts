import { spawn,type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir,readFile,writeFile,stat,realpath,rm,lstat,unlink } from 'node:fs/promises'
import { join,dirname,resolve } from 'node:path'
import type { Job } from '../../shared/types'
import { mapAsrSegments,whisperOutput,asrOutputSchema,asrUsesChunks,type AsrResult,type AsrPlan } from '../../shared/asr'
import { isWithin,canonicalInput } from '../media/paths'
import { inputFormatWhitelist } from '../../shared/media-policy'
import { JsonStore } from '../storage/json'
import { stopProcess } from '../engine/process'
import { trackChildTree,terminateChild } from '../jobs/process-control'
import { asrProcessEnvironment } from './storage'
import { deploymentEnvironment } from './deployment'

export interface AsrExecutionContext {
  signal:AbortSignal;checkpoint(chunkBoundary?:boolean):Promise<void>;progress(stage:string,percent:number,processedMs:number,detail?:{indeterminate?:boolean;scope?:'job'|'stage';metrics?:Job['progressMetrics']}):void;
  log(text:string):void;child(child:ChildProcessWithoutNullStreams|undefined):void
}
const MAX_RESULT_BYTES=64*1024*1024
async function processOutput(executable:string,args:string[],context:AsrExecutionContext,onOutput?:(text:string)=>void,request?:unknown,onStdout?:(text:string)=>void,storageRoot?:string,gpuUuid?:string):Promise<string>{
  await context.checkpoint(false);context.signal.throwIfAborted();context.log(JSON.stringify({executable,args})+'\n')
  if(storageRoot)await mkdir(join(storageRoot,'temp'),{recursive:true})
  const child=spawn(executable,args,{shell:false,windowsHide:true,stdio:'pipe',cwd:dirname(executable),env:gpuUuid&&storageRoot?deploymentEnvironment(storageRoot,gpuUuid):asrProcessEnvironment(storageRoot)})
  trackChildTree(child)
  context.child(child)
  let output='',outputBytes=0,failure:Error|undefined,clearStop:(()=>void)|undefined
  const abort=()=>{clearStop=stopProcess(child)}
  context.signal.addEventListener('abort',abort,{once:true});if(context.signal.aborted)abort()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data',(text:string)=>{outputBytes+=Buffer.byteLength(text);if(outputBytes>MAX_RESULT_BYTES){failure=new Error('后端输出超过 64 MB');terminateChild(child)}else{output+=text;if(request===undefined)context.log(text);onOutput?.(text);onStdout?.(text)}})
  child.stderr.setEncoding('utf8')
  child.stderr.on('data',(text:string)=>{context.log(text);onOutput?.(text)})
  child.on('error',error=>{failure=error})
  child.stdin.on('error',error=>{if((error as NodeJS.ErrnoException).code!=='EPIPE')failure=error})
  child.stdin.end(request===undefined?undefined:JSON.stringify(request)+'\n')
  try{
    const code=await new Promise<number|null>(resolve=>child.once('close',resolve))
    context.signal.throwIfAborted()
    if(failure)throw failure
    if(code!==0)throw new Error(`ASR 处理进程退出码 ${code}，请查看任务日志`)
    return output
  }finally{context.signal.removeEventListener('abort',abort);clearStop?.();context.child(undefined)}
}
async function readBounded(path:string):Promise<string>{if((await stat(path)).size>MAX_RESULT_BYTES)throw new Error('ASR 结果超过 64 MB');const buffer=await readFile(path);if(buffer.length>MAX_RESULT_BYTES)throw new Error('ASR 结果超过 64 MB');return buffer.toString('utf8').replace(/^\uFEFF/,'')}
export function asrResultPath(root:string,id:string):string{if(!/^[a-f0-9-]{36}$/i.test(id))throw new Error('ASR 任务标识无效');return join(root,'asr','results',`${id}.json`)}
export async function cleanAsrArtifacts(root:string,id:string):Promise<void>{
  const result=asrResultPath(root,id),cache=resolve(root,'asr','cache',id),ownedRoot=await realpath(root)
  for(const target of [result,cache]){
    let info;try{info=await lstat(target)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error}
    const parent=await realpath(dirname(target));if(!isWithin(ownedRoot,parent))throw new Error('拒绝清理配置目录以外的 ASR 数据')
    if(info.isSymbolicLink()){await unlink(target);continue}
    const actual=await realpath(target);if(!isWithin(parent,actual)||!isWithin(ownedRoot,actual))throw new Error('ASR 数据路径已变化，未清理')
    await rm(actual,{recursive:info.isDirectory(),force:true})
  }
}
export async function readAsrResult(root:string,job:Job):Promise<AsrResult>{
  if(job.plan.kind!=='asr'||job.status!=='completed')throw new Error('识别尚未完成，无法读取初稿')
  const value=JSON.parse(await readBounded(asrResultPath(root,job.id))) as AsrResult
  if(value.format!=='muxivra-asr-result'||value.version!==1||value.jobId!==job.id||value.inputPath!==job.plan.input.path)throw new Error('ASR 结果记录无效')
  asrOutputSchema.parse(value);return value
}
export async function readAsrRaw(root:string,job:Job,index:number):Promise<string>{
  const result=await readAsrResult(root,job),directory=join(root,'asr','cache',job.id),file=result.rawFiles[index]
  if(!file||!/^raw-\d+\.json$/.test(file))throw new Error('原始结果不存在')
  const path=await realpath(join(directory,file));if(!isWithin(directory,path))throw new Error('原始结果路径已变化')
  return readBounded(path)
}
export async function executeAsr(root:string,job:Job,context:AsrExecutionContext):Promise<void>{
  if(job.plan.kind!=='asr')throw new Error('任务不是 ASR 任务')
  const plan:AsrPlan=job.plan,{model,options}=plan.asr,cache=join(root,'asr','cache',job.id)
  if(await canonicalInput(plan.input.path)!==plan.input.path||await canonicalInput(model.executable)!==model.executable||await realpath(model.modelPath)!==model.modelPath)throw new Error('媒体、模型或运行程序在提交后发生变化，请重新导入')
  await mkdir(cache,{recursive:true});await mkdir(dirname(plan.outputPath),{recursive:true})
  const result:AsrResult={format:'muxivra-asr-result',version:1,jobId:job.id,inputPath:plan.input.path,model,options,segments:[],createdAt:new Date().toISOString(),rawFiles:[]}
  const end=Math.min(options.endMs??plan.input.durationMs,plan.input.durationMs),total=end-options.startMs,chunking=asrUsesChunks(options),step=chunking?options.chunkSeconds*1000:total
  if(total<=0)throw new Error('识别区间无效')
  const part=(index:number)=>chunking?`第 ${index+1} / ${Math.ceil(total/step)} 段`:'整段音频'
  context.log(JSON.stringify({mode:chunking?'compatibility-chunks':'whole-audio',startMs:options.startMs,endMs:end,...(chunking?{chunkSeconds:options.chunkSeconds}:{})})+'\n')
  const checkpoint=new JsonStore<AsrResult>(join(cache,'checkpoint.json'))
  for(let start=options.startMs,index=0;start<end;start+=step,index++){
    await context.checkpoint();const duration=Math.min(step,end-start),processed=start-options.startMs,audio=join(cache,`audio-${index}.wav`)
    context.progress(`提取音频 · ${part(index)}`,processed/total*100,processed,{indeterminate:true})
    try{
      const args=['-v','error','-nostdin','-protocol_whitelist','file,pipe','-format_whitelist',inputFormatWhitelist,'-copyts','-start_at_zero','-i',plan.input.path,'-map',`0:${options.audioStream}`,'-vn','-af','aresample=async=1:first_pts=0','-ss',(start/1000).toFixed(3),'-t',(duration/1000).toFixed(3),'-ac',String(model.channels),'-ar',String(model.sampleRate),'-c:a','pcm_s16le','-f','wav',audio]
      await processOutput(plan.engine.ffmpegPath,args,context)
      context.signal.throwIfAborted()
      context.progress(`加载模型并识别 · ${part(index)}`,processed/total*100,processed,{indeterminate:true})
      let raw:unknown,normalized:ReturnType<typeof whisperOutput>
      if(model.backend==='whisper.cpp'){
        const prefix=join(cache,`whisper-${index}`)
        const args=['--model',model.modelPath,'--file',audio,'--language',options.language,'--threads',String(options.threads),'--beam-size',String(options.beamSize),'--output-json-full','--output-file',prefix,'--print-progress',...(options.device==='cpu'?['--no-gpu']:[]),...(options.initialPrompt?['--prompt',options.initialPrompt]:[])]
        let progressBuffer='',diagnostics='',gpuEnabled=false
        await processOutput(model.executable,args,context,text=>{
          diagnostics=(diagnostics+text).slice(-32000);gpuEnabled||=/using (?:CUDA|Vulkan|OpenCL|SYCL)|CUDA\d+ backend|using GPU/i.test(diagnostics);progressBuffer=(progressBuffer+text).slice(-4000)
          const matches=[...progressBuffer.matchAll(/progress\s*=\s*(\d+)%/g)];if(matches.length){const percent=Math.min(99,Number(matches.at(-1)![1]));context.progress(`识别中 · ${part(index)}`,(processed+duration*percent/100)/total*99,(processed+duration*percent/100));progressBuffer=''}
        },undefined,undefined,model.storageRoot,model.nvidiaDeviceUuid)
        if(options.device==='gpu'&&!gpuEnabled)throw new Error('该运行包未实际启用 GPU，请使用 NVIDIA 运行包或改为 CPU/自动')
        raw=JSON.parse(await readBounded(prefix+'.json'));normalized=whisperOutput(raw)
      }else{
        const request={protocol:'muxivra-asr',version:1,audioPath:audio,modelPath:model.modelPath,sampleRate:model.sampleRate,channels:model.channels,...(model.environment?{backend:model.backend,environment:model.environment}:{}),options:{language:options.language,device:options.device,threads:options.threads,beamSize:options.beamSize,initialPrompt:options.initialPrompt,...(model.environment?{parameters:options.parameters}:{})},durationMs:duration,timebase:'chunk-relative-ms'}
        let lineBuffer='',protocolFailure:Error|undefined,final:unknown,lastProgressLog=0
        const accept=(line:string)=>{if(!line.trim())return;try{const event=JSON.parse(line);if(event.type==='progress'){if(typeof event.percent!=='number'||!Number.isFinite(event.percent)||event.percent<0||event.percent>100)throw new Error('后端进度无效');const scope=event.scope==='stage'?'stage':'job',metrics=typeof event.completed==='number'&&Number.isFinite(event.completed)&&event.completed>=0&&['audioMs','tokens','windows'].includes(event.unit)?{completed:event.completed,unit:event.unit,...(typeof event.total==='number'&&Number.isFinite(event.total)&&event.total>=event.completed?{total:event.total}:{})}:undefined;context.progress(typeof event.stage==='string'?event.stage.slice(0,200):'识别中',scope==='stage'?event.percent:(processed+duration*event.percent/100)/total*99,scope==='stage'?processed:processed+duration*event.percent/100,{indeterminate:event.indeterminate===true,scope,metrics});if(Date.now()-lastProgressLog>=5000){lastProgressLog=Date.now();context.log(JSON.stringify({type:'asr-progress',stage:event.stage,percent:event.percent,indeterminate:event.indeterminate===true,scope,metrics})+'\n')}}else if(event.type==='result'){if(final!==undefined)throw new Error('后端重复返回结果');final=event.result}else if(event.type==='error')throw new Error(String(event.message??'后端识别失败'));else throw new Error('后端返回未知消息类型')}catch(error){protocolFailure=error as Error}}
        // Only stdout carries JSONL; stderr remains free for diagnostics.
        try{await processOutput(model.executable,model.args,context,undefined,request,text=>{lineBuffer+=text;const lines=lineBuffer.split(/\r?\n/);lineBuffer=lines.pop()??'';for(const line of lines)accept(line)},model.storageRoot,model.nvidiaDeviceUuid)}catch(error){accept(lineBuffer);if(protocolFailure&&!context.signal.aborted)throw protocolFailure;throw error}
        accept(lineBuffer)
        if(protocolFailure)throw protocolFailure
        if(final===undefined)throw new Error('后端没有返回识别结果')
        raw=final;normalized=asrOutputSchema.parse(final)
      }
      const file=`raw-${index}.json`;await writeFile(join(cache,file),JSON.stringify(raw,null,2),{flag:'wx'})
      result.rawFiles.push(file);result.language??=normalized.language
      result.segments.push(...mapAsrSegments(normalized,start,duration,options.estimateUntimed))
      if(result.segments.length>100000)throw new Error('字幕初稿超过 100000 条，请分区间识别')
      context.signal.throwIfAborted();await checkpoint.write(result)
      context.progress(chunking?`已识别 ${index+1} / ${Math.ceil(total/step)} 段`:'整段识别完成',(processed+duration)/total*99,processed+duration)
    }finally{await rm(audio,{force:true})}
  }
  await context.checkpoint();context.progress('整理字幕初稿',99,total)
  const json=JSON.stringify(result,null,2);if(Buffer.byteLength(json)>MAX_RESULT_BYTES)throw new Error('识别结果超过 64 MB，请分区间识别')
  context.signal.throwIfAborted();await writeFile(plan.outputPath,json,{flag:'wx',mode:0o600});job.outputSize=Buffer.byteLength(json)
  context.log(JSON.stringify({segments:result.segments.length,timed:result.segments.filter(s=>s.startMs!==undefined).length,language:result.language,model:model.name})+'\n')
}
