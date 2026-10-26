import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest'
import { mkdir,mkdtemp,readFile,readdir,rm,stat,writeFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { MediaService } from '../../src/core/service'
import { inspectMedia } from '../../src/core/media/probe'
import { prepareProjectAnalysis,readProjectVideoTiming,readProjectWaveform } from '../../src/core/media/project-analysis'
import { isWithin } from '../../src/core/media/paths'
import type { Engine } from '../../src/shared/types'
const run=promisify(execFile),engine={ffmpegPath:'ffmpeg',ffprobePath:'ffprobe'} as Engine
let root:string,source:string
describe('project preprocessing and persistent analysis',()=>{
  beforeAll(async()=>{
    await mkdir('.test-data',{recursive:true});root=await mkdtemp(resolve('.test-data','project-analysis-'));source=join(root,'two-tracks.mkv')
    await run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=96x64:rate=10:duration=3','-f','lavfi','-i','aevalsrc=0:s=48000:d=3','-itsoffset','0.5','-f','lavfi','-i','aevalsrc=0.8*sin(2*PI*8000*t)|-0.8*sin(2*PI*8000*t):s=48000:d=2','-map','0:v','-map','1:a','-map','2:a','-c:v','libx264','-preset','ultrafast','-g','10','-c:a','pcm_f32le',source],{windowsHide:true})
  })
  afterAll(async()=>{if(root){if(!isWithin(resolve('.test-data'),root))throw new Error('Unsafe cleanup');await rm(root,{recursive:true,force:true})}})
  it('creates signed high-resolution pyramids for every track and a video frame index before publishing',async()=>{
    const service=new MediaService(join(root,'profile'),join(root,'engines')),phases:string[]=[]
    try{
      await service.initialize();await service.paths.grantFile(source);service.on('update',()=>{const state=service.projects.state();if(state.import.active)phases.push(state.import.phase)})
      const {project}=await service.importProject({path:source}),analysis=join(project.directory,'analysis'),manifest=JSON.parse(await readFile(join(analysis,'media.json'),'utf8'))
      expect(manifest).toMatchObject({format:'muxivra-media-analysis',version:1,sampleRate:48000,video:true});expect(manifest.audio.map((track:any)=>track.streamIndex)).toEqual([1,2]);expect(manifest.audio.every((track:any)=>track.levels.length>1)).toBe(true)
      expect(phases).toContain('预处理音频波形 · 音轨 #1');expect(phases).toContain('预处理音频波形 · 音轨 #2');expect(phases).toContain('建立视频帧索引')
      const silent=await service.waveform(project.mediaPath,{streamIndex:1,startMs:0,durationMs:1000,width:100}),tone=await service.waveform(project.mediaPath,{streamIndex:2,startMs:700,durationMs:1000,width:500}),delayed=await service.waveform(project.mediaPath,{streamIndex:2,startMs:0,durationMs:1000,width:100})
      expect(silent.rms.every(value=>value===0)).toBe(true);expect(tone.maximum.every(value=>value>.6)).toBe(true);expect(tone.minimum.every(value=>value< -.6)).toBe(true);expect(tone.rms.every(value=>value>.5&&value<.6)).toBe(true)
      expect(delayed.maximum.slice(0,45).every(value=>value===0)).toBe(true);expect(delayed.maximum.slice(55).every(value=>value>.6)).toBe(true)
      const timing=await service.videoFrames(project.mediaPath);expect(timing.timestampsMs).toHaveLength(30);expect(timing.keyframes).toEqual([0,10,20])
      // A cold service reads only project artifacts: neither inspector nor decoder
      // is available after the import completes.
      const inspect=vi.spyOn(service,'inspect').mockRejectedValue(new Error('No runtime probing allowed'))
      expect((await service.waveform(project.mediaPath,{streamIndex:2,startMs:800,durationMs:250,width:4096})).maximum.some(value=>value>.6)).toBe(true)
      expect((await service.videoFrames(project.mediaPath)).timestampsMs).toEqual(timing.timestampsMs);inspect.mockRestore()
      const files=await readdir(analysis),before=await Promise.all(files.map(file=>stat(join(analysis,file)).then(info=>info.mtimeMs)))
      await service.closeProject(project.id);await service.openProject(project.id)
      expect((await service.waveform(project.mediaPath,{streamIndex:2,startMs:1200,durationMs:360000,width:4096})).hasAudio).toBe(true)
      expect(await Promise.all(files.map(file=>stat(join(analysis,file)).then(info=>info.mtimeMs)))).toEqual(before)
    }finally{await service.shutdown()}
  },60000)
  it('does not fall back to live processing when a managed project cache is missing or corrupt',async()=>{
    const directory=join(root,'corrupt');await mkdir(directory);const media=await inspectMedia(engine,source)
    await expect(readProjectWaveform(directory,source)).rejects.toThrow('预处理')
    await prepareProjectAnalysis(engine,media,directory,new AbortController().signal,()=>{})
    const manifest=JSON.parse(await readFile(join(directory,'analysis','media.json'),'utf8')),file=join(directory,'analysis',manifest.audio[1].levels[0].file)
    await writeFile(file,Buffer.alloc(12));await expect(readProjectWaveform(directory,source,{streamIndex:2,durationMs:250,width:4096})).rejects.toThrow('不完整')
    await writeFile(join(directory,'analysis','video-timing.json'),'broken');await expect(readProjectVideoTiming(directory,source)).rejects.toThrow()
  },60000)
  it('cancels preprocessing before source deletion, keeps the old active project, and removes the unpublished copy',async()=>{
    const service=new MediaService(join(root,'cancel-profile'),join(root,'cancel-engines'))
    try{
      await service.initialize();await service.paths.grantFile(source);const original=await service.importProject({path:source}),bytes=await readFile(source)
      const cancel=()=>{const progress=service.projects.state().import;if(progress.phase.startsWith('预处理音频波形')&&progress.percent>30)service.projects.cancelImport()};service.on('update',cancel)
      await expect(service.importProject({path:source,deleteOriginal:true})).rejects.toThrow('取消');service.removeListener('update',cancel)
      expect(await readFile(source)).toEqual(bytes);expect(service.projects.state().activeId).toBe(original.project.id);expect(service.projects.state().items).toHaveLength(1)
      expect((await readdir(service.projects.root)).filter(name=>!name.startsWith('.'))).toEqual([original.project.folder])
    }finally{await service.shutdown()}
  },60000)
  it('rebuilds existing analysis explicitly without touching media, ASS, or project state; cancellation preserves the previous analysis',async()=>{
    const service=new MediaService(join(root,'rebuild-profile'),join(root,'rebuild-engines'))
    try{
      await service.initialize();await service.paths.grantFile(source);const {project}=await service.importProject({path:source}),subtitle=await readFile(project.subtitlePath),sourceInfo=await stat(project.mediaPath),projectManifest=await readFile(join(project.directory,'project.json'))
      const analysis=join(project.directory,'analysis'),previous=await readFile(join(analysis,'media.json')),cancel=()=>{const progress=service.projects.state().import;if(progress.phase.startsWith('预处理音频波形')&&progress.percent>0)service.projects.cancelImport()}
      service.on('update',cancel);await expect(service.rebuildProjectAnalysis(project.id)).rejects.toThrow('取消');service.removeListener('update',cancel)
      expect(await readFile(join(analysis,'media.json'))).toEqual(previous);expect((await service.waveform(project.mediaPath,{streamIndex:2,startMs:1000,durationMs:250,width:100})).hasAudio).toBe(true)
      // Simulate an older project lacking the analysis directory.
      await rm(analysis,{recursive:true});await expect(service.videoFrames(project.mediaPath)).rejects.toThrow('项目管理');await service.rebuildProjectAnalysis(project.id)
      expect((await service.videoFrames(project.mediaPath)).timestampsMs).toHaveLength(30);expect(await readFile(project.subtitlePath)).toEqual(subtitle);expect(await readFile(join(project.directory,'project.json'))).toEqual(projectManifest);expect((await stat(project.mediaPath)).mtimeMs).toBe(sourceInfo.mtimeMs);expect(service.projects.active()?.id).toBe(project.id)
      expect((await readdir(project.directory)).filter(name=>name.startsWith('.analysis-'))).toEqual([])
    }finally{await service.shutdown()}
  },60000)
  it('restores the previous analysis if publication fails or is cancelled after the backup swap',async()=>{
    const directory=join(root,'rollback');await mkdir(directory);const media=await inspectMedia(engine,source);await prepareProjectAnalysis(engine,media,directory,new AbortController().signal,()=>{})
    const manifest=await readFile(join(directory,'analysis','media.json'));let validations=0
    await expect(prepareProjectAnalysis(engine,media,directory,new AbortController().signal,()=>{},{replace:true,beforePublish:async()=>{if(++validations===2)throw new Error('Injected publication failure')}})).rejects.toThrow('Injected publication failure')
    expect(await readFile(join(directory,'analysis','media.json'))).toEqual(manifest);expect((await readdir(directory)).filter(name=>name.startsWith('.analysis-'))).toEqual([])
    const controller=new AbortController();validations=0
    await expect(prepareProjectAnalysis(engine,media,directory,controller.signal,()=>{},{replace:true,beforePublish:async()=>{if(++validations===2)controller.abort()}})).rejects.toThrow('取消')
    expect(await readFile(join(directory,'analysis','media.json'))).toEqual(manifest);expect((await readProjectVideoTiming(directory,source)).timestampsMs).toHaveLength(30);expect((await readdir(directory)).filter(name=>name.startsWith('.analysis-'))).toEqual([])
  },60000)
})
