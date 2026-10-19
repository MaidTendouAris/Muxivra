import { describe,it,expect } from 'vitest'
import { mkdir,mkdtemp,writeFile,readFile,rm } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { MediaService } from '../../src/core/service'
import { run } from '../../src/core/engine/process'
import { isWithin } from '../../src/core/media/paths'
import { createSubtitleDocument } from '../../src/shared/subtitles'
import { JobHistoryStore } from '../../src/core/jobs/history'
async function wait(service:MediaService,id:string){for(let i=0;i<800;i++){const job=service.queue.get(id);if(['completed','failed','cancelled'].includes(job.status)&&!job.cancelling)return job;await new Promise(resolve=>setTimeout(resolve,30))}throw new Error('Project export timed out')}
describe('project exports and isolation',()=>{
  it('exports the selected language file from an immutable snapshot while other ASS files are switched or deleted',async()=>{
    await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data','project-languages-')),service=new MediaService(join(root,'profile'),join(root,'engines'))
    try{
      await service.initialize();const source=join(root,'source.mp4');await run(service.engine.ffmpegPath,['-v','error','-f','lavfi','-i','color=black:s=320x180:r=25','-t','1','-c:v','libx264',source]);await service.paths.grantFile(source)
      const {project,document}=await service.importProject({path:source});await service.saveSubtitleProject({...document,cues:[{id:'original',startMs:0,endMs:900,text:'Original language'}]})
      const alternate=await service.projects.createSubtitle(project.id,'English.ass'),alternateId=service.projects.active()!.activeSubtitleId
      await service.saveSubtitleProject({...alternate,cues:[{id:'english',startMs:0,endMs:900,text:'Selected English track'}]});const directory=join(project.directory,'exports');await mkdir(directory,{recursive:true});service.queue.concurrency=0
      const job=await service.exportProjectVideo({mode:'embed',container:'mkv',video:'libx264',audio:'copy',quality:22,speed:'medium'},join(directory,'english.mkv'))
      await service.queue.pause(job.id);await service.projects.deleteSubtitle(project.id,alternateId);expect(service.projects.active()?.activeSubtitleId).toBe(project.activeSubtitleId);service.queue.concurrency=1;await service.queue.resume(job.id)
      const done=await wait(service,job.id);expect(done.error).toBeUndefined();expect(done.status).toBe('completed')
      const text=await run(service.engine.ffmpegPath,['-v','error','-i',done.plan.outputPath,'-map','0:s:0','-f','ass','pipe:1']);expect(text).toContain('Selected English track');expect(text).not.toContain('Original language');expect((await service.getSession())?.cues[0].text).toBe('Original language')
    }finally{await service.shutdown();if(!isWithin(resolve('.test-data'),root))throw new Error('Unsafe cleanup');await rm(root,{recursive:true,force:true})}
  })
  it('validates initial project options before source deletion and rejects creation through the editor API',async()=>{
    await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data','project-create-')),service=new MediaService(join(root,'profile'),join(root,'engines'))
    try{
      await service.initialize();const source=join(root,'clip.wav'),subtitle=join(root,'initial.srt');await run(service.engine.ffmpegPath,['-v','error','-f','lavfi','-i','sine=frequency=440','-t','1',source]);await service.paths.grantFile(source);await writeFile(subtitle,'1\n00:00:00,123 --> 00:00:00,987\nInitial subtitle\n');await service.paths.grantFile(subtitle)
      await expect(service.openSubtitleMedia(source)).rejects.toThrow('项目管理');expect(service.projects.state().items).toHaveLength(0)
      await expect(service.importProject({path:source,subtitlePath:subtitle,resolutionMode:'custom',deleteOriginal:true})).rejects.toThrow();expect(await readFile(source)).toBeTruthy();expect(service.projects.state().items).toHaveLength(0)
      const result=await service.importProject({path:source,subtitlePath:subtitle,name:'Initial project',resolutionMode:'custom',resolution:{width:1280,height:720},exportFormat:'srt'})
      expect(result.project.name).toBe('Initial project');expect(result.document.scriptInfo?.PlayResX).toBe('1280');expect(result.document.exportFormat).toBe('srt');expect(result.document.cues[0]).toMatchObject({startMs:123,endMs:987,text:'Initial subtitle'})
      await service.closeProject(result.project.id);expect(await service.getSession()).toBeUndefined();await service.saveSession(result.document);expect(await service.getSession()).toBeUndefined();expect(service.snapshot().subtitleProject?.dirty).toBe(false)
      await service.openProject(result.project.id);await service.archiveProject(result.project.id);await service.saveSession(result.document);expect(await service.getSession()).toBeUndefined();const next=await service.importProject({path:source});await service.saveSession(result.document);expect((await service.getSession())?.id).toBe(next.document.id);expect(await readFile(source)).toBeTruthy()
    }finally{await service.shutdown();if(!isWithin(resolve('.test-data'),root))throw new Error('Unsafe cleanup');await rm(root,{recursive:true,force:true})}
  })
  it('exports real styled MKV, MP4 text subtitles and burned frames using an immutable subtitle snapshot',async()=>{
    await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data','project-export-')),service=new MediaService(join(root,'profile'),join(root,'engines'))
    try{
      await service.initialize();const source=join(root,'source.mp4');await run(service.engine.ffmpegPath,['-v','error','-f','lavfi','-i','color=black:s=320x180:r=25','-f','lavfi','-i','sine=frequency=440','-t','2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',source]);await service.paths.grantFile(source)
      const original=await readFile(source),imported=await service.importProject({path:source,deleteOriginal:false}),directory=join(imported.project.directory,'exports');await mkdir(directory)
      const document={...imported.document,cues:[{id:'line',startMs:100,endMs:1500,text:'Project subtitle',style:'Default'}]};await service.saveSubtitleProject(document)
      service.queue.concurrency=0;const mkv=await service.exportProjectVideo({mode:'embed',container:'mkv',video:'libx264',audio:'copy',quality:22,speed:'medium'},join(directory,'styled.mkv'))
      await service.queue.pause(mkv.id);await service.saveSubtitleProject({...document,cues:[{...document.cues[0],text:'Later edit'}]});service.queue.concurrency=1;await service.queue.resume(mkv.id)
      const done=await wait(service,mkv.id);expect(done.error).toBeUndefined();expect(done.status).toBe('completed');expect(done.plan.projectId).toBe(imported.project.id);expect(isWithin(imported.project.directory,done.logPath)).toBe(true)
      const meta=await service.inspect(done.plan.outputPath);expect(meta.streams.find(s=>s.type==='subtitle')?.codec).toBe('ass')
      const text=await run(service.engine.ffmpegPath,['-v','error','-i',done.plan.outputPath,'-map','0:s:0','-f','ass','pipe:1']);expect(text).toContain('Project subtitle');expect(text).not.toContain('Later edit')
      const mp4=await service.exportProjectVideo({mode:'embed',container:'mp4',video:'libx264',audio:'copy',quality:22,speed:'medium'},join(directory,'text.mp4'));expect((await wait(service,mp4.id)).status).toBe('completed');expect((await service.inspect(mp4.plan.outputPath)).streams.find(s=>s.type==='subtitle')?.codec).toBe('mov_text')
      const burned=await service.exportProjectVideo({mode:'burn',container:'mp4',video:'libx264',audio:'copy',quality:22,speed:'fast'},join(directory,'burned.mp4'));const burnDone=await wait(service,burned.id);expect(burnDone.error).toBeUndefined();expect(burnDone.status).toBe('completed');expect((await service.inspect(burned.plan.outputPath)).streams.some(s=>s.type==='subtitle')).toBe(false)
      const frame=async(path:string)=>(await run(service.engine.ffmpegPath,['-v','error','-ss','0.8','-i',path,'-map','0:v:0','-frames:v','1','-f','framemd5','pipe:1'])).split('\n').filter(v=>!v.startsWith('#')).join('')
      expect(await frame(burned.plan.outputPath)).not.toBe(await frame(source));expect(await readFile(source)).toEqual(original);expect((await new JobHistoryStore(imported.project.directory).read()).some(j=>j.id===burned.id)).toBe(true)
      const copy=await service.duplicateProject();expect(copy.mediaPath).not.toBe(document.mediaPath);expect(copy.cues[0].text).toBe('Later edit');expect(await readFile(copy.mediaPath!)).toEqual(original)
      const external=(await readFile(copy.projectPath!,'utf8'))+'\n; External change kept\n';await writeFile(copy.projectPath!,external);const rescued=await service.duplicateProject();expect(rescued.cues[0].text).toBe('Later edit');expect(rescued.projectPath).not.toBe(copy.projectPath);expect(await readFile(copy.projectPath!,'utf8')).toBe(external)
    }finally{await service.shutdown();if(!isWithin(resolve('.test-data'),root))throw new Error('Unsafe cleanup');await rm(root,{recursive:true,force:true})}
  })
})
