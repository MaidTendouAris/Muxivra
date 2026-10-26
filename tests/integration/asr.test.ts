import { describe,it,expect,vi } from 'vitest'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { mkdir,mkdtemp,writeFile,readFile,rm,readdir } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { MediaService } from '../../src/core/service'
import { run } from '../../src/core/engine/process'
import { asrOptionsSchema,type AsrOptions } from '../../src/shared/asr'
import { isWithin } from '../../src/core/media/paths'
import { whisperRuntimeCatalog,largeV3Catalog } from '../../src/core/asr/models'
import { asrSubtitleCues } from '../../src/shared/asr'
import { createSubtitleDocument } from '../../src/shared/subtitles'
import { parseAss,serializeAss } from '../../src/core/subtitles/ass'
import { parseSrt,serializeSrt } from '../../src/core/subtitles/srt'
import { randomUUID } from 'node:crypto'

const fixture=`const fs=require('node:fs');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const r=JSON.parse(input),wav=fs.readFileSync(r.audioPath);if(r.protocol!=='muxivra-asr'||r.version!==1||wav.readUInt32LE(24)!==16000)process.exit(8);console.error('后端日志 🙂');process.stdout.write(JSON.stringify({type:'progress',percent:50})+'\\n');setTimeout(()=>{const output=JSON.stringify({type:'result',result:{language:'zh',customMetadata:{retained:true,durationMs:r.durationMs},segments:[{text:'测试台词🙂',startMs:100,endMs:700},{text:'未打轴文本'}]}})+'\\n';const bytes=Buffer.from(output),cut=bytes.indexOf(Buffer.from('🙂'))+1;process.stdout.write(bytes.subarray(0,cut));setTimeout(()=>process.stdout.end(bytes.subarray(cut)),10)},50)});`
async function wait(service:MediaService,id:string,timeout=60000){await expect.poll(()=>service.queue.get(id).status,{timeout}).toMatch(/^(completed|failed|cancelled)$/);return service.queue.get(id)}
describe('ASR 完整工作流',()=>{
  it('后端非零退出时保留明确的显存预算错误，清理临时音频且不自动分片',async()=>{
    await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data','asr-memory-failure-')),service=new MediaService(join(root,'profile'),join(root,'engines'))
    try{
      await service.initialize();const source=join(root,'source.wav');await run(service.engine.ffmpegPath,['-v','error','-f','lavfi','-i','sine=frequency=440','-t','1',source],{timeout:30000})
      const script=join(root,'failure.cjs'),manifest=join(root,'backend.json'),message='本次推理超过可用专用显存预算，未自动分片'
      await writeFile(script,`process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({type:'error',message:${JSON.stringify(message)}}),()=>{process.exitCode=1})})`)
      await writeFile(manifest,JSON.stringify({format:'muxivra-asr-backend',version:1,name:'Memory failure',executable:process.execPath,args:[script],modelPath:'.'}))
      const model=await service.asrImport({backend:'custom',name:'Memory failure',modelPath:manifest});await service.paths.grantFile(source);const project=await service.importProject({path:source})
      const job=await service.asrSubmit(asrOptionsSchema.parse({inputPath:project.project.mediaPath,modelId:model.id,audioStream:0})),done=await wait(service,job.id)
      expect(done.status).toBe('failed');expect(done.error).toBe(message);expect((await readdir(join(project.project.directory,'asr','cache',job.id))).some(file=>file.endsWith('.wav'))).toBe(false)
      expect((await service.queue.log(job.id)).split('\n').filter(line=>line.includes('"args"')&&line.includes('failure.cjs'))).toHaveLength(1)
    }finally{await service.shutdown();if(!isWithin(resolve('.test-data'),root))throw new Error('测试清理路径无效');await rm(root,{recursive:true,force:true})}
  })
  it('保留真实阶段计数，未知进度不推算音频百分比或剩余时间',async()=>{
    await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data','asr-progress-')),service=new MediaService(join(root,'profile'),join(root,'engines'))
    try{
      await service.initialize();const source=join(root,'source.wav');await run(service.engine.ffmpegPath,['-v','error','-f','lavfi','-i','sine=frequency=440','-t','2',source],{timeout:30000})
      const script=join(root,'progress.cjs'),manifest=join(root,'backend.json');await writeFile(script,`let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{console.log(JSON.stringify({type:'progress',stage:'Native tokens',percent:0,indeterminate:true,scope:'stage',completed:128,unit:'tokens'}));setTimeout(()=>console.log(JSON.stringify({type:'result',result:{segments:[{text:'Native result',startMs:100,endMs:900}]}})),1500)})`);await writeFile(manifest,JSON.stringify({format:'muxivra-asr-backend',version:1,name:'Progress fixture',executable:process.execPath,args:[script],modelPath:'.'}))
      const model=await service.asrImport({backend:'custom',name:'Progress fixture',modelPath:manifest});await service.paths.grantFile(source);const project=await service.importProject({path:source}),job=await service.asrSubmit(asrOptionsSchema.parse({inputPath:project.project.mediaPath,modelId:model.id,audioStream:0}))
      await expect.poll(()=>service.queue.get(job.id).stage,{timeout:10000}).toBe('Native tokens');const current=service.queue.get(job.id);expect(current).toMatchObject({progressIndeterminate:true,progressScope:'stage',processedMs:0,progressMetrics:{completed:128,unit:'tokens'}});expect(current.estimatedRemainingMs).toBeUndefined();expect(current.speed).toBe('');const completed=await wait(service,job.id);expect(completed).toMatchObject({status:'completed',progress:100,progressIndeterminate:false,progressScope:'job'})
    }finally{await service.shutdown();if(!isWithin(resolve('.test-data'),root))throw new Error('测试清理路径无效');await rm(root,{recursive:true,force:true})}
  })
  it.each([
    {mode:'默认整段',extra:{},durations:[11000],starts:[100]},
    {mode:'整段选定区间',extra:{chunkingEnabled:false,chunkSeconds:1,startMs:1000,endMs:10500},durations:[9500],starts:[1100]},
    {mode:'自定义兼容分片',extra:{chunkingEnabled:true,chunkSeconds:4,startMs:1000,endMs:10500},durations:[4000,4000,1500],starts:[1100,5100,9100]}
  ])('$mode：实际 FFmpeg、自定义 JSONL、Unicode、时间映射与结果持久化',async({extra,durations,starts})=>{
    await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data','asr-flow-')),service=new MediaService(join(root,'profile'),join(root,'engines'))
    try{
      await service.initialize();const source=join(root,'source.wav');await run(service.engine.ffmpegPath,['-v','error','-f','lavfi','-i','sine=frequency=440','-t','11',source],{timeout:30000})
      const script=join(root,'worker.cjs'),manifest=join(root,'backend.json');await writeFile(script,fixture);await writeFile(manifest,JSON.stringify({format:'muxivra-asr-backend',version:1,name:'Protocol fixture',executable:process.execPath,args:[script],modelPath:'.'}))
      const model=await service.asrImport({backend:'custom',name:'fixture',modelPath:manifest});await service.paths.grantFile(source);const project=await service.importProject({path:source,deleteOriginal:false}),managed=project.project.mediaPath
      const options=asrOptionsSchema.parse({inputPath:managed,modelId:model.id,audioStream:0,language:'zh',device:'cpu',threads:1,chunkSeconds:1,beamSize:1,initialPrompt:'',startMs:0,estimateUntimed:false,...extra})
      const job=await service.asrSubmit(options),done=await wait(service,job.id);expect(done.error).toBeUndefined();expect(done.status).toBe('completed')
      const result=await service.asrResult(job.id);expect(result.segments.map(s=>s.text)).toEqual(durations.flatMap(()=>['测试台词🙂','未打轴文本']));expect(result.rawFiles).toHaveLength(durations.length)
      expect(result.segments.filter(s=>s.startMs!==undefined).map(s=>s.startMs)).toEqual(starts);expect(result.segments[1].startMs).toBeUndefined()
      for(const [i,durationMs] of durations.entries())expect(JSON.parse(await service.asrRaw(job.id,i)).customMetadata.durationMs).toBe(durationMs)
      expect(JSON.parse(await service.asrRaw(job.id,0)).customMetadata.retained).toBe(true);expect(await service.queue.log(job.id)).toContain('后端日志')
      const cache=join(project.project.directory,'asr','cache',job.id);expect((await readdir(cache)).some(f=>f.endsWith('.wav'))).toBe(false)
      const doc=await service.openSubtitleMedia(managed);expect(doc.projectPath).toBe(project.project.subtitlePath);expect(doc.cues).toHaveLength(0)
      await service.saveSession({...doc,cues:result.segments.filter(s=>s.startMs!==undefined).map((s,i)=>({id:'asr-'+i,text:s.text,startMs:s.startMs!,endMs:s.endMs!}))});await service.saveSubtitleProject((await service.getSession())!)
      expect(await readFile(doc.projectPath!,'utf8')).toContain('测试台词🙂')
      await service.queue.deleteRecords([job.id]);await expect(readFile(done.plan.outputPath)).rejects.toMatchObject({code:'ENOENT'});await expect(readdir(cache)).rejects.toMatchObject({code:'ENOENT'})
      expect(await readFile(doc.projectPath!,'utf8')).toContain('测试台词🙂');expect(await readFile(script,'utf8')).toBe(fixture)
    }finally{await service.shutdown();if(!isWithin(resolve('.test-data'),root))throw new Error('测试清理路径无效');await rm(root,{recursive:true,force:true})}
  })
  it.each(['resume','cancel'] as const)('整段模式直接暂停进程后 %s，不重载模型或发布取消任务的结果',async(action)=>{
    await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data','asr-pause-')),service=new MediaService(join(root,'profile'),join(root,'engines'))
    try{
      await service.initialize();const source=join(root,'source.wav');await run(service.engine.ffmpegPath,['-v','error','-f','lavfi','-i','sine=frequency=440','-t','3',source],{timeout:30000})
      const script=join(root,'ticker.cjs'),manifest=join(root,'backend.json'),starts=join(root,'starts.txt')
      await writeFile(script,`const fs=require('node:fs');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const r=JSON.parse(input);fs.appendFileSync(${JSON.stringify(starts)},'start\\n');let i=0;const tick=setInterval(()=>{console.log(JSON.stringify({type:'progress',percent:++i*2}));if(i===30){clearInterval(tick);console.log(JSON.stringify({type:'result',result:{segments:[{text:'整段台词',startMs:120,endMs:r.durationMs-120}]}}))}},100)});`)
      await writeFile(manifest,JSON.stringify({format:'muxivra-asr-backend',version:1,name:'Ticker',executable:process.execPath,args:[script],modelPath:'.'}))
      const model=await service.asrImport({backend:'custom',name:'Ticker',modelPath:manifest});await service.paths.grantFile(source);const project=await service.importProject({path:source,deleteOriginal:false}),managed=project.project.mediaPath
      const options=asrOptionsSchema.parse({inputPath:managed,modelId:model.id,audioStream:0,chunkSeconds:1})
      const job=await service.asrSubmit(options);await expect.poll(()=>service.queue.get(job.id).processedMs,{timeout:10000}).toBeGreaterThan(0)
      await service.queue.pause(job.id);expect(service.queue.get(job.id)).toMatchObject({status:'paused',pausedFrom:'running'});expect(service.queue.get(job.id).pausing).toBeUndefined()
      await new Promise(resolve=>setTimeout(resolve,150));const paused=service.queue.get(job.id)
      await new Promise(resolve=>setTimeout(resolve,400));expect(service.queue.get(job.id).processedMs).toBe(paused.processedMs);expect(service.queue.get(job.id).elapsedMs).toBe(paused.elapsedMs)
      if(action==='resume'){
        await service.queue.resume(job.id);const done=await wait(service,job.id);expect(done.error).toBeUndefined();expect(done.status).toBe('completed')
        const result=await service.asrResult(job.id);expect(result.rawFiles).toHaveLength(1);expect(result.segments[0]).toMatchObject({startMs:120,endMs:2880})
      }else{
        await service.queue.cancel(job.id);expect((await wait(service,job.id)).status).toBe('cancelled');await expect(readFile(job.plan.outputPath)).rejects.toMatchObject({code:'ENOENT'})
      }
      expect(await readFile(starts,'utf8')).toBe('start\n')
      expect((await readdir(join(project.project.directory,'asr','cache',job.id))).some(f=>f.endsWith('.wav'))).toBe(false)
    }finally{await service.shutdown();if(!isWithin(resolve('.test-data'),root))throw new Error('测试清理路径无效');await rm(root,{recursive:true,force:true})}
  })
  it('旧自动分片任务重试改为整段，明确选择兼容分片的新任务重试保留时长',async()=>{
    await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data','asr-retry-')),service=new MediaService(join(root,'profile'),join(root,'engines'))
    try{
      await service.initialize();service.queue.concurrency=0
      const source=join(root,'source.wav');await run(service.engine.ffmpegPath,['-v','error','-f','lavfi','-i','sine=frequency=440','-t','1',source],{timeout:30000})
      const manifest=join(root,'backend.json');await writeFile(manifest,JSON.stringify({format:'muxivra-asr-backend',version:1,name:'Fixture',executable:process.execPath,modelPath:'.'}))
      const model=await service.asrImport({backend:'custom',name:'Fixture',modelPath:manifest});await service.paths.grantFile(source);const project=await service.importProject({path:source,deleteOriginal:false}),managed=project.project.mediaPath
      for(const legacy of [true,false]){
        const job=await service.asrSubmit(asrOptionsSchema.parse({inputPath:managed,modelId:model.id,audioStream:0,chunkingEnabled:true,chunkSeconds:900}))
        if(legacy){const stored=service.queue.jobs.find(j=>j.id===job.id)!;if(stored.plan.kind==='asr')delete (stored.plan.asr.options as Partial<AsrOptions>).chunkingEnabled}
        await service.queue.cancel(job.id);const retried=await service.retry(job.id)
        expect(retried.plan.kind).toBe('asr');if(retried.plan.kind==='asr')expect(retried.plan.asr.options).toMatchObject({chunkingEnabled:!legacy,chunkSeconds:900})
      }
    }finally{await service.shutdown();if(!isWithin(resolve('.test-data'),root))throw new Error('测试清理路径无效');await rm(root,{recursive:true,force:true})}
  })
  it.skipIf(process.env.MUXIVRA_ASR_REAL!=='1')('真实运行包与完整模型校验安装，Whisper large-v3 实际 NVIDIA 推理通过标准任务工作流',async()=>{
    await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data','asr-large-v3-')),service=new MediaService(join(root,'profile'),join(root,'engines'))
    const assets=new Map<string,string>([[whisperRuntimeCatalog.cpu.url,'cpu.zip'],[whisperRuntimeCatalog.cuda.url,'cuda12.zip'],[largeV3Catalog.url,'ggml-large-v3.bin']])
    const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async input=>{const file=assets.get(String(input));if(!file)throw new Error('Unexpected download URL');return new Response(Readable.toWeb(createReadStream(resolve('.runtime/asr-validation',file))) as ReadableStream)})
    try{
      await service.initialize();await service.asrModels.install('runtime','cpu');await service.asrModels.install('runtime','cuda');await service.asrModels.install('model')
      expect(service.asrModels.state().models).toEqual([])
      const model=await service.asrModels.bindAsset('whisper-large-v3',undefined,'whisper-b5454-cuda');expect(model.name).toBe('Whisper large-v3');expect(service.asrModels.state().assets?.find(asset=>asset.id==='whisper-large-v3')?.bytes).toBe(largeV3Catalog.size);expect(service.asrModels.state().runtimes).toHaveLength(2)
      const files=await readdir('example_media'),source=await service.paths.grantFile(resolve('example_media',files.find(f=>f.startsWith('0001'))!))
      const project=await service.importProject({path:source,deleteOriginal:false}),managed=project.project.mediaPath
      const options:AsrOptions={inputPath:managed,modelId:model.id,audioStream:0,language:'zh',device:'gpu',threads:4,chunkingEnabled:false,chunkSeconds:120,beamSize:5,initialPrompt:'',startMs:30000,endMs:42000,estimateUntimed:false}
      const job=await service.asrSubmit(options),done=await wait(service,job.id)
      const result=done.status==='completed'?await service.asrResult(job.id):undefined
      await mkdir('artifacts/qa',{recursive:true});await writeFile('artifacts/qa/asr-large-v3-report.json',JSON.stringify({status:done.status,error:done.error,elapsedMs:done.elapsedMs,model,options,segments:result?.segments,log:await service.queue.log(job.id)},null,2))
      expect(done.error).toBeUndefined();expect(done.status).toBe('completed')
      expect(result!.model.name).toBe('Whisper large-v3');expect(result!.segments.length).toBeGreaterThan(0);expect(result!.segments.every(s=>s.startMs!>=30000&&s.endMs!<=42000)).toBe(true)
    }finally{fetch.mockRestore();await service.shutdown();if(!isWithin(resolve('.test-data'),root))throw new Error('测试清理路径无效');await rm(root,{recursive:true,force:true})}
  },240000)
  it.skipIf(!process.env.MUXIVRA_ASR_TIMING_SOURCE).each([false,true])('完整 3:07 MP4（兼容分片=%s），推理、token 时间和 ASS/SRT 保留小数精度',async(chunkingEnabled)=>{
    await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data','asr-timing-')),service=new MediaService(join(root,'profile'),join(root,'engines'))
    try{
      await service.initialize()
      const model=await service.asrImport({backend:'whisper.cpp',name:'Whisper large-v3',modelPath:resolve('.runtime/asr-validation/ggml-large-v3.bin'),executable:resolve('.runtime/asr-validation/cuda12/Release/whisper-cli.exe')})
      const source=await service.paths.grantFile(process.env.MUXIVRA_ASR_TIMING_SOURCE!),project=await service.importProject({path:source,deleteOriginal:false}),managed=project.project.mediaPath,media=await service.inspect(source)
      expect(media.durationMs).toBeGreaterThan(187000);expect(media.durationMs).toBeLessThan(188000)
      const options:AsrOptions={inputPath:managed,modelId:model.id,audioStream:media.streams.find(s=>s.type==='audio')!.index,language:'auto',device:'gpu',threads:4,chunkingEnabled,chunkSeconds:120,beamSize:5,initialPrompt:'',startMs:0,estimateUntimed:false}
      const job=await service.asrSubmit(options)
      if(!chunkingEnabled){
        await expect.poll(()=>service.queue.get(job.id).stage?.startsWith('识别中'),{timeout:120000}).toBe(true)
        await service.queue.pause(job.id);const paused=service.queue.get(job.id);expect(paused.status).toBe('paused')
        await new Promise(resolve=>setTimeout(resolve,500));expect(service.queue.get(job.id).elapsedMs).toBe(paused.elapsedMs)
        await service.queue.resume(job.id)
      }
      const done=await wait(service,job.id,240000)
      const result=done.status==='completed'?await service.asrResult(job.id):undefined
      const fractional=(segments:{startMs:number;endMs:number}[])=>segments.filter(s=>s.startMs%1000!==0||s.endMs%1000!==0).length
      const chunks=result?await Promise.all(result.rawFiles.map(async(_,i)=>{
        const raw=JSON.parse(await service.asrRaw(job.id,i))
        const step=chunkingEnabled?120000:media.durationMs,start=i*step,segments=result.segments.filter(s=>s.startMs!==undefined&&s.startMs>=start&&s.startMs<start+step)
        return {index:i,rawSegments:raw.transcription.length,rawFractionalSegments:fractional(raw.transcription.map((s:any)=>({startMs:s.offsets.from,endMs:s.offsets.to}))),alignedSegments:segments.length,alignedFractionalSegments:fractional(segments as {startMs:number;endMs:number}[]),tokenCount:raw.transcription.reduce((count:number,s:any)=>count+(s.tokens?.length??0),0),times:segments.map(s=>({startMs:s.startMs,endMs:s.endMs,words:s.words?.length??0}))}
      })):[]
      await mkdir('artifacts/qa',{recursive:true});await writeFile(`artifacts/qa/asr-${chunkingEnabled?'timing':'whole'}-report.json`,JSON.stringify({status:done.status,error:done.error,inputDurationMs:media.durationMs,elapsedMs:done.elapsedMs,model:model.name,options,chunks,events:done.events,log:await service.queue.log(job.id)},null,2))
      expect(done.error).toBeUndefined();expect(done.status).toBe('completed');expect(chunks).toHaveLength(chunkingEnabled?2:1)
      expect((await service.queue.log(job.id)).split('\n').filter(line=>line.includes('"--model"'))).toHaveLength(chunkingEnabled?2:1)
      for(const chunk of chunks){expect(chunk.tokenCount).toBeGreaterThan(0);expect(chunk.alignedFractionalSegments).toBeGreaterThan(0)}
      expect(result!.segments.every(s=>s.startMs!==undefined&&s.endMs!>s.startMs&&s.endMs!<=media.durationMs)).toBe(true)
      const cues=asrSubtitleCues(result!.segments,()=>randomUUID()),srt=parseSrt(serializeSrt(cues)),ass=parseAss(serializeAss(createSubtitleDocument({cues})))
      expect(srt.map(c=>[c.startMs,c.endMs])).toEqual(cues.map(c=>[c.startMs,c.endMs]))
      expect(ass.cues.map(c=>[c.startMs,c.endMs])).toEqual(cues.map(c=>[Math.round(c.startMs/10)*10,Math.round(c.endMs/10)*10]))
    }finally{await service.shutdown();if(!isWithin(resolve('.test-data'),root))throw new Error('测试清理路径无效');await rm(root,{recursive:true,force:true})}
  },300000)
})
