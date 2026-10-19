import { mkdir,writeFile,readFile } from 'node:fs/promises'
import { resolve,join } from 'node:path'
import { randomUUID,createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
await mkdir('.runtime/asr-adapters',{recursive:true})
await build({entryPoints:['src/core/service.ts'],outfile:'.runtime/asr-adapters/service.mjs',bundle:true,platform:'node',format:'esm',packages:'external'})
const {MediaService}=await import('../.runtime/asr-adapters/service.mjs')
const backend=process.env.MUXIVRA_ASR_BACKEND||'qwen',prefix=resolve('.runtime','asr-adapters'),profile=resolve('.test-data','asr-real-'+backend+'-'+randomUUID()),source=resolve('tests/media/TED演讲：神奇的斐波那契数列_P1_中英字幕.mp4')
await mkdir('artifacts/qa',{recursive:true});await mkdir(profile,{recursive:true})
const hash=path=>readFile(path).then(buffer=>createHash('sha256').update(buffer).digest('hex'))
const before=await hash(source),service=new MediaService(profile,join(profile,'engines')),id=backend==='qwen'?'qwen3-asr':'moss-transcribe-diarize'
const device=process.env.MUXIVRA_ASR_DEVICE||'cpu',report={backend:id,device,source,sourceSha256:before,startedAt:new Date().toISOString(),errors:[]}
try{
  await service.initialize();await service.paths.grantFile(source)
  const environment=await service.asrModels.saveEnvironment({name:backend+' validation',backend:id,pythonPath:join(prefix,backend+'-env','Scripts','python.exe'),sourcePath:join(prefix,'upstream',backend),...(backend==='qwen'?{alignerPath:join(prefix,'models','aligner')}:{})})
  report.environment=environment;assert.equal(environment.probe.ready,true,JSON.stringify(environment.probe.issues))
  const model=await service.asrImport({name:backend==='qwen'?'Qwen3-ASR 0.6B':'MOSS-Transcribe-Diarize 0.9B',backend:id,modelPath:join(prefix,'models',backend),environmentId:environment.id})
  const project=await service.importProject({path:source});report.projectDirectory=project.project.directory
  const parameters=backend==='qwen'?{timestamps:true,alignerDevice:'cpu',batchSize:1,maxNewTokens:8192,dtype:device==='cpu'?'float32':'auto'}:{maxNewTokens:16384,dtype:device==='cpu'?'float32':'auto'}
  const job=await service.asrSubmit({modelId:model.id,inputPath:project.project.mediaPath,audioStream:(await service.inspect(project.project.mediaPath)).streams.find(s=>s.type==='audio').index,language:process.env.MUXIVRA_ASR_LANGUAGE||'auto',device,threads:8,parameters})
  report.jobId=job.id;console.log(JSON.stringify({started:id,job:job.id,durationMs:job.plan.durationMs,profile}))
  let last='',completed
  while(true){const current=service.queue.get(job.id);if(current.stage!==last){last=current.stage;console.log(JSON.stringify({stage:last,progress:current.progress,elapsedMs:current.elapsedMs}))}if(['completed','failed','cancelled'].includes(current.status)){completed=current;break}await new Promise(resolve=>setTimeout(resolve,1000))}
  report.status=completed.status;report.elapsedMs=completed.elapsedMs;report.error=completed.error;report.logPath=completed.logPath
  assert.equal(completed.status,'completed',completed.error+'\n'+await service.queue.log(job.id))
  const result=await service.asrResult(job.id);assert.ok(result.segments.length>0)
  report.segments=result.segments.length;report.timed=result.segments.filter(s=>s.startMs!==undefined).length;report.speakers=[...new Set(result.segments.map(s=>s.speaker).filter(Boolean))];report.rawFiles=result.rawFiles;report.fractional=!!result.segments.some(s=>s.startMs%1000||s.endMs%1000);report.language=result.language
  assert.ok(report.timed>0);assert.equal(result.rawFiles.length,1,'Application must submit the whole input once')
  await build({stdin:{contents:"export {asrSubtitleCues} from './src/shared/asr'; export {createSubtitleDocument} from './src/shared/subtitles';",resolveDir:process.cwd()},outfile:'.runtime/asr-adapters/subtitles.mjs',bundle:true,platform:'node',format:'esm',packages:'external'})
  const {asrSubtitleCues,createSubtitleDocument}=await import('../.runtime/asr-adapters/subtitles.mjs')
  const cues=asrSubtitleCues(result.segments,()=>randomUUID());await service.saveSubtitleProject({...project.document,cues});const output=join(project.project.directory,'exports');await mkdir(output);await service.paths.grantDirectory(output);await service.exportSubtitles(createSubtitleDocument({cues}),join(output,'draft.srt'),'srt')
  report.preview=result.segments.slice(0,12);report.resultPath=job.plan.outputPath;report.sourceUnchanged=await hash(source)===before;assert.equal(report.sourceUnchanged,true)
  await writeFile('artifacts/qa/asr-real-'+backend+'-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify({completed:id,segments:report.segments,timed:report.timed,elapsedMs:report.elapsedMs}))
}catch(error){report.errors.push(error.stack);throw error}
finally{report.finishedAt=new Date().toISOString();await writeFile('artifacts/qa/asr-real-'+backend+'-report.json',JSON.stringify(report,null,2));await service.shutdown()}
