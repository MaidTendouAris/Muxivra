import { it,expect } from 'vitest'
import { mkdir,mkdtemp,readFile,writeFile,rm } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { MediaService } from '../../src/core/service'
import { run } from '../../src/core/engine/process'
import { isWithin } from '../../src/core/media/paths'
import { subtitleTransferOptions,changeSubtitleMode } from '../../src/shared/subtitle-media'
async function finish(service:MediaService,id:string){for(let i=0;i<800;i++){const job=service.queue.get(id);if(['completed','failed','cancelled'].includes(job.status)&&!job.cancelling){expect(job.error).toBeUndefined();expect(job.status).toBe('completed');return job}await new Promise(resolve=>setTimeout(resolve,30))}throw new Error('Subtitle handoff job timed out')}
it('hands saved subtitle snapshots to real single-file MKV/MP4 muxing and burn-in without modifying project media',async()=>{
  await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data','subtitle-media-')),service=new MediaService(join(root,'profile'),join(root,'engines'))
  try{
    await service.initialize();const source=join(root,'source.mp4'),oldSubtitle=join(root,'original.srt');await writeFile(oldSubtitle,'1\n00:00:00,000 --> 00:00:02,000\nOriginal subtitle\n')
    await run(service.engine.ffmpegPath,['-v','error','-f','lavfi','-i','color=black:s=320x180:r=25','-f','lavfi','-i','sine=frequency=440','-i',oldSubtitle,'-map','0:v','-map','1:a','-map','2:s','-t','2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-c:s','mov_text',source]);await service.paths.grantFile(source)
    const original=await readFile(source),imported=await service.importProject({path:source}),document={...imported.document,cues:[{id:'line',startMs:100,endMs:1500,text:'Bridge snapshot',style:'Default'}]}
    const transfer=await service.prepareSubtitleMedia(document),snapshot=await readFile(transfer.subtitlePath,'utf8')
    expect(snapshot).toContain('Bridge snapshot');expect(transfer.media.path).toBe(imported.project.mediaPath);expect(isWithin(imported.project.directory,transfer.subtitlePath)).toBe(true)
    expect((await service.getSession())?.cues[0].text).toBe('Bridge snapshot')
    await service.saveSubtitleProject({...document,cues:[{...document.cues[0],text:'A later edit'}]})
    const options=subtitleTransferOptions(transfer.subtitlePath),request={inputPath:transfer.media.path,outputPath:join(transfer.outputDirectory,'styled.mkv'),options}
    const mkv=(await service.submit([request]))[0],done=await finish(service,mkv.id)
    expect(done.plan.projectId).toBe(imported.project.id)
    expect((await service.inspect(done.plan.outputPath)).streams.find(s=>s.type==='subtitle')?.codec).toBe('ass')
    const extract=await run(service.engine.ffmpegPath,['-v','error','-i',done.plan.outputPath,'-map','0:s:0','-f','ass','pipe:1']);expect(extract).toContain('Bridge snapshot');expect(extract).not.toContain('A later edit')
    const keep=(await service.submit([{...request,outputPath:join(transfer.outputDirectory,'keep.mkv'),options:{...options,subtitles:'copy'}}]))[0];await finish(service,keep.id)
    expect((await service.inspect(keep.plan.outputPath)).streams.filter(s=>s.type==='subtitle').map(s=>s.codec)).toEqual(['ass','ass'])
    const originalText=await run(service.engine.ffmpegPath,['-v','error','-i',keep.plan.outputPath,'-map','0:s:0','-f','srt','pipe:1']);expect(originalText).toContain('Original subtitle')
    const mp4Options={...options,container:'mp4' as const},mp4=(await service.submit([{...request,outputPath:join(transfer.outputDirectory,'text.mp4'),options:mp4Options}]))[0]
    expect(mp4.plan.warnings.some(w=>w.includes('样式'))).toBe(true);await finish(service,mp4.id);expect((await service.inspect(mp4.plan.outputPath)).streams.find(s=>s.type==='subtitle')?.codec).toBe('mov_text')
    const burned=(await service.submit([{...request,outputPath:join(transfer.outputDirectory,'burned.mkv'),options:changeSubtitleMode(options,'burn')}]))[0]
    await finish(service,burned.id);expect((await service.inspect(burned.plan.outputPath)).streams.some(s=>s.type==='subtitle')).toBe(false);expect(burned.plan.args.join(' ')).toContain('subtitles=filename=')
    const frame=async(path:string)=>(await run(service.engine.ffmpegPath,['-v','error','-ss','0.8','-i',path,'-frames:v','1','-f','framemd5','pipe:1'])).split('\n').filter(v=>!v.startsWith('#')).join('')
    expect(await frame(burned.plan.outputPath)).not.toBe(await frame(source))
    expect(await readFile(source)).toEqual(original);expect(await readFile(imported.project.mediaPath)).toEqual(original);expect(await readFile(transfer.subtitlePath,'utf8')).toBe(snapshot)
    await expect(service.prepareSubtitleMedia({...document,id:'stale'})).rejects.toThrow('当前字幕工程')
    await service.closeProject(imported.project.id);await expect(service.prepareSubtitleMedia(document)).rejects.toThrow('当前字幕工程')
  }finally{await service.shutdown();if(!isWithin(resolve('.test-data'),root))throw new Error('Unsafe cleanup');await rm(root,{recursive:true,force:true})}
})
