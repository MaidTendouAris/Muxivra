import { describe,it,expect } from 'vitest'
import { mkdir,mkdtemp,writeFile,readFile,rm } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { MediaService } from '../../src/core/service'
import { run } from '../../src/core/engine/process'
import { isWithin } from '../../src/core/media/paths'
import { serializeAss } from '../../src/core/subtitles/ass'
import { createSubtitleDocument } from '../../src/shared/subtitles'

describe('existing project subtitle import',()=>{
  it('extracts selectable text tracks and imports SRT as new ASS without replacing existing subtitles',async()=>{
    await mkdir('.test-data',{recursive:true})
    const root=await mkdtemp(resolve('.test-data','subtitle-import-')),service=new MediaService(join(root,'profile'),join(root,'engines'))
    try{
      await service.initialize()
      const video=join(root,'video.mp4'),source=join(root,'source.mkv'),first=join(root,'Chinese.ass'),second=join(root,'English.srt')
      const effect='{\\an7\\pos(30,40)\\t(0,600,\\fscx120)\\clip(0,0,320,180)}Complex text'
      await writeFile(first,serializeAss(createSubtitleDocument({scriptInfo:{PlayResX:'320',PlayResY:'180'},cues:[{id:'effect',startMs:120,endMs:900,text:effect,layer:7,name:'Actor'}]})))
      await writeFile(second,'1\n00:00:00,230 --> 00:00:00,980\n<i>English draft</i>\n')
      await run(service.engine.ffmpegPath,['-v','error','-f','lavfi','-i','color=black:s=320x180:r=25:d=1','-c:v','libx264',video])
      await run(service.engine.ffmpegPath,['-v','error','-i',video,'-i',first,'-i',second,'-map','0:v','-map','1:0','-map','2:0','-c','copy','-metadata:s:s:0','language=chi','-metadata:s:s:1','language=eng',source])
      const sourceBefore=await readFile(source),srtBefore=await readFile(second)
      await service.paths.grantFile(source);await service.paths.grantFile(second)
      const {project,document}=await service.importProject({path:source})
      await service.saveSubtitleProject({...document,cues:[{id:'keep',startMs:0,endMs:400,text:'Keep original project subtitle'}]})
      const original=await readFile(project.subtitlePath),tracks=await service.projectEmbeddedSubtitles(project.id)
      expect(tracks.map(track=>track.language)).toEqual(['chi','eng'])
      const chinese=await service.importEmbeddedProjectSubtitle(project.id,tracks[0].index)
      expect(chinese.exportFormat).toBe('ass');expect(chinese.cues[0]).toMatchObject({startMs:120,endMs:900,text:effect,layer:7,name:'Actor'})
      const chineseTrack=service.projects.active()!.activeSubtitleId
      const english=await service.importEmbeddedProjectSubtitle(project.id,tracks[1].index)
      expect(english.cues[0].text).toContain('English draft');expect(service.projects.active()?.subtitles).toHaveLength(3)
      const imported=await service.importProjectSubtitle(project.id,second)
      expect(imported.exportFormat).toBe('ass');expect(imported.projectPath).toMatch(/English\.ass$/);expect(imported.cues[0]).toMatchObject({startMs:230,endMs:980,text:'{\\i1}English draft{\\i0}'})
      expect(service.projects.active()?.subtitles).toHaveLength(4)
      expect(await readFile(project.subtitlePath)).toEqual(original);expect(await readFile(source)).toEqual(sourceBefore);expect(await readFile(second)).toEqual(srtBefore)
      const active=service.projects.active()!.activeSubtitleId
      await expect(service.importEmbeddedProjectSubtitle(project.id,9999)).rejects.toThrow('文本字幕轨道')
      expect(service.projects.active()?.activeSubtitleId).toBe(active)
      await service.projects.selectSubtitle(project.id,chineseTrack)
      const edited=(await service.getSession())!;edited.cues[0].text=effect+' edited';await service.saveSubtitleProject(edited)
      await service.closeProject(project.id);const reopened=await service.openProject(project.id)
      expect(reopened.cues[0].text).toBe(effect+' edited');expect(reopened.cues[0].layer).toBe(7);expect(service.projects.active()?.subtitles).toHaveLength(4)
    }finally{await service.shutdown();if(!isWithin(resolve('.test-data'),root))throw new Error('Unsafe import test cleanup');await rm(root,{recursive:true,force:true})}
  },120000)
})
