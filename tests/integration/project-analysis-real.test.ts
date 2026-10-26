import { expect,it,vi } from 'vitest'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir,mkdtemp,readFile,readdir,rm,stat,writeFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { MediaService } from '../../src/core/service'
import { makeWaveform } from '../../src/core/media/waveform'
import { isWithin } from '../../src/core/media/paths'
const hash=async(path:string)=>{const value=createHash('sha256');for await(const chunk of createReadStream(path))value.update(chunk);return value.digest('hex')}

// Opt-in repository media validation. All created projects live in .test-data;
// the supplied TED source is read only and its hash is checked at the end.
it.skipIf(process.env.MUXIVRA_PROJECT_ANALYSIS_REAL!=='1')('preprocesses the supplied TED video and aligns persistent waves and frame timestamps without runtime decoding',async()=>{
  await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
  const root=await mkdtemp(resolve('.test-data','project-analysis-real-')),source=resolve('tests/media/TED演讲：神奇的斐波那契数列_P1_中英字幕.mp4'),service=new MediaService(join(root,'profile'),join(root,'engines')),phases:{phase:string;percent:number;elapsedMs:number}[]=[],started=performance.now(),sourceHash=await hash(source)
  const report:Record<string,unknown>={source,root,startedAt:new Date().toISOString(),sourceSha256:sourceHash}
  try{
    await service.initialize();await service.paths.grantFile(source);const media=await service.inspect(source)
    service.on('update',()=>{const progress=service.projects.state().import;if(progress.active&&(phases.at(-1)?.phase!==progress.phase||progress.percent-(phases.at(-1)?.percent??0)>=10))phases.push({phase:progress.phase,percent:progress.percent,elapsedMs:Math.round(performance.now()-started)})})
    const begin=performance.now(),{project}=await service.importProject({path:source}),preprocessMs=performance.now()-begin,analysis=join(project.directory,'analysis'),manifest=JSON.parse(await readFile(join(analysis,'media.json'),'utf8')),timing=await service.videoFrames(project.mediaPath)
    const stream=manifest.audio[0].streamIndex,windows=[]
    for(const startMs of [0,30678,180123,Math.max(0,media.durationMs-8000)]){
      const begin=performance.now(),cached=await service.waveform(project.mediaPath,{streamIndex:stream,startMs,durationMs:15000,width:1000}),readMs=performance.now()-begin,reference=await makeWaveform(service.engine,media,{streamIndex:stream,startMs,durationMs:15000,width:1000}),difference=cached.rms.reduce((sum,value,index)=>sum+Math.abs(value-reference.rms[index]),0)/cached.width
      expect(difference).toBeLessThan(.025);expect(cached.maximum.some(value=>value>0)).toBe(true);windows.push({startMs,readMs,meanAbsoluteRmsDifference:difference})
    }
    const inspect=vi.spyOn(service,'inspect').mockRejectedValue(new Error('No live decoder/probe permitted'))
    const lookup=performance.now();await service.waveform(project.mediaPath,{streamIndex:stream,startMs:60000,durationMs:45000,width:4096});expect((await service.videoFrames(project.mediaPath)).timestampsMs.length).toBe(timing.timestampsMs.length);const cacheOnlyLookupMs=performance.now()-lookup;inspect.mockRestore()
    const files=await Promise.all((await readdir(analysis)).map(async name=>({name,bytes:(await stat(join(analysis,name))).size})))
    expect(manifest.durationMs).toBe(media.durationMs);expect(Math.abs(timing.endMs-media.durationMs)).toBeLessThan(1000);expect(manifest.audio[0].sampleFrames/48000*1000).toBeLessThanOrEqual(media.durationMs+10);expect(timing.timestampsMs.length).toBeGreaterThan(8000);expect(await hash(source)).toBe(sourceHash)
    Object.assign(report,{success:true,mediaDurationMs:media.durationMs,preprocessMs,phases,analysisFiles:files,analysisBytes:files.reduce((sum,file)=>sum+file.bytes,0),frameCount:timing.timestampsMs.length,indexedEndMs:timing.endMs,variableFrameRate:timing.variable,audioSampleFrames:manifest.audio[0].sampleFrames,windows,cacheOnlyLookupMs,sourceUnchanged:true})
  }catch(error){Object.assign(report,{success:false,error:(error as Error).stack,phases});throw error}
  finally{await service.shutdown();await writeFile(resolve('artifacts/qa/project-analysis-real.json'),JSON.stringify({...report,finishedAt:new Date().toISOString()},null,2));if(!isWithin(resolve('.test-data'),root))throw new Error('Unsafe cleanup');await rm(root,{recursive:true,force:true})}
},300000)
