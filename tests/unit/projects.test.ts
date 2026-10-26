import { afterEach,describe,it,expect } from 'vitest'
import { mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink } from 'node:fs/promises'
import { utimesSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { ProjectManager } from '../../src/core/projects'
import { PathPolicy,isWithin } from '../../src/core/media/paths'
import { createSubtitleDocument } from '../../src/shared/subtitles'
import { parseSubtitleText } from '../../src/core/subtitles/ass'
const roots:string[]=[],stores:ProjectManager[]=[]
async function setup(onUpdate?:(manager:ProjectManager,source:string)=>void){await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data','managed-project-'));roots.push(root);const source=join(root,'clip.mp4'),paths=new PathPolicy();await writeFile(source,Buffer.alloc(64*1024,7));await paths.grantFile(source);let manager:ProjectManager;manager=new ProjectManager(join(root,'install','projects'),join(root,'profile'),paths,()=>onUpdate?.(manager,source));stores.push(manager);await manager.initialize();return {root,source,manager,paths}}
afterEach(async()=>{for(const store of stores.splice(0))await store.shutdown();for(const root of roots.splice(0)){if(!isWithin(resolve('.test-data'),root))throw new Error('Unsafe cleanup');await rm(root,{recursive:true,force:true})}})
describe('managed media projects',()=>{
  it('retains the previous manifest and subtitle when the old store cannot shut down during import activation',async()=>{
    const {source,manager}=await setup(),initial=await manager.importMedia(source)
    await manager.save({...initial.document,cues:[{id:'retained',startMs:100,endMs:900,text:'Retain the current subtitle'}]})
    const manifestPath=join(initial.project.directory,'project.json'),beforeManifest=await readFile(manifestPath),beforeAss=await readFile(initial.project.subtitlePath),beforeId=manager.subtitles.get()!.id
    const old=manager.subtitles,shutdown=old.shutdown.bind(old)
    old.shutdown=async()=>{throw new Error('Subtitle store flush failure')}
    try{
      const content=Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nImported cue\n'),document=parseSubtitleText(content.toString(),'srt')
      await expect(manager.importSubtitle(initial.project.id,{name:'New subtitle.srt',content,document})).rejects.toThrow('store flush failure')
      expect(await readFile(manifestPath)).toEqual(beforeManifest)
      expect(await readFile(initial.project.subtitlePath)).toEqual(beforeAss)
      expect(manager.subtitles.get()?.id).toBe(beforeId)
      expect(manager.active()?.subtitlePath).toBe(initial.project.subtitlePath)
      expect(manager.active()?.subtitles).toHaveLength(1)
      expect(await readdir(join(initial.project.directory,'imports'))).toEqual([])
      await expect(readFile(join(initial.project.directory,'New subtitle.ass'))).rejects.toMatchObject({code:'ENOENT'})
    }finally{old.shutdown=shutdown}
  },60000)
  it('retains an imported track and its raw source when activation publishes the manifest before pointer persistence fails',async()=>{
    const {source,manager}=await setup(),initial=await manager.importMedia(source),beforeAss=await readFile(initial.project.subtitlePath)
    const pointer=(manager as unknown as {pointer:{write(value:{id?:string}):Promise<void>}}).pointer,write=pointer.write.bind(pointer)
    pointer.write=async()=>{throw new Error('Active project pointer failure')}
    const content=Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nKeep this imported track\n'),document=parseSubtitleText(content.toString(),'srt')
    try{
      await expect(manager.importSubtitle(initial.project.id,{name:'Published.srt',content,document})).rejects.toThrow('pointer failure')
      const manifest=JSON.parse(await readFile(join(initial.project.directory,'project.json'),'utf8'))
      expect(manifest.subtitleFile).toBe('Published.ass')
      expect(manager.active()?.subtitlePath).toBe(join(initial.project.directory,'Published.ass'))
      expect(manager.active()?.subtitles).toHaveLength(2)
      expect(manager.subtitles.get()?.cues[0].text).toBe('Keep this imported track')
      expect(await readFile(join(initial.project.directory,'Published.ass'),'utf8')).toContain('Keep this imported track')
      expect(await readFile(join(initial.project.directory,'imports','Published.srt'))).toEqual(content)
      expect(await readFile(initial.project.subtitlePath)).toEqual(beforeAss)
    }finally{pointer.write=write}
    await manager.close(initial.project.id)
    expect((await manager.open(initial.project.id)).cues[0].text).toBe('Keep this imported track')
  },60000)
  it('imports subtitles as distinct numbered ASS files and retains every original track and source copy',async()=>{
    const {source,manager}=await setup(),initial=await manager.importMedia(source)
    await manager.save({...initial.document,cues:[{id:'original',startMs:0,endMs:500,text:'Keep original'}]})
    const old=await readFile(initial.project.subtitlePath),content=Buffer.from('1\n00:00:00,120 --> 00:00:01,340\n<i>Imported text</i>\n'),document=parseSubtitleText(content.toString(),'srt')
    const first=await manager.importSubtitle(initial.project.id,{name:'English.srt',content,document})
    expect(first.projectPath).toBe(join(initial.project.directory,'English.ass'));expect(first.exportFormat).toBe('ass');expect(first.cues[0].text).toBe('{\\i1}Imported text{\\i0}')
    const second=await manager.importSubtitle(initial.project.id,{name:'English.srt',content,document})
    expect(second.projectPath).toBe(join(initial.project.directory,'English (2).ass'));expect(manager.active()?.subtitles).toHaveLength(3)
    expect(await readFile(initial.project.subtitlePath)).toEqual(old);expect(await readFile(join(initial.project.directory,'imports','English.srt'))).toEqual(content);expect(await readFile(join(initial.project.directory,'imports','English (2).srt'))).toEqual(content)
    await manager.selectSubtitle(initial.project.id,initial.project.activeSubtitleId);expect(manager.subtitles.get()?.cues[0].text).toBe('Keep original')
    await manager.close(initial.project.id);await manager.open(initial.project.id);expect(manager.active()?.subtitles).toHaveLength(3)
  },60000)
  it('keeps the current subtitle when extraction fails, the project changes, or the import folder is redirected',async()=>{
    const {root,source,manager}=await setup(),initial=await manager.importMedia(source),before=await readFile(initial.project.subtitlePath)
    await expect(manager.importSubtitle(initial.project.id,async()=>{throw new Error('Subtitle extraction failed')})).rejects.toThrow('extraction failed')
    const content=Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nText\n'),document=parseSubtitleText(content.toString(),'srt')
    const outside=join(root,'outside');await mkdir(outside);await symlink(outside,join(initial.project.directory,'imports'),process.platform==='win32'?'junction':'dir')
    await expect(manager.importSubtitle(initial.project.id,{name:'Subtitle.srt',content,document})).rejects.toThrow('导入目录已变化')
    expect(await readdir(outside)).toEqual([]);expect(manager.active()?.subtitles).toHaveLength(1);expect(await readFile(initial.project.subtitlePath)).toEqual(before)
    const next=await manager.importMedia(source)
    await expect(manager.importSubtitle(initial.project.id,{name:'Subtitle.srt',content,document})).rejects.toThrow('项目已切换')
    expect(manager.active()?.id).toBe(next.project.id)
  },60000)
  it('never publishes or deletes the source when required preprocessing fails',async()=>{
    const {source,manager}=await setup(),bytes=await readFile(source),original=await manager.importMedia(source)
    manager.prepareMedia=async(_path,directory,_signal,progress)=>{progress('建立视频帧索引',20);await writeFile(join(directory,'partial-index.bin'),'not complete');throw new Error('frame index disk failure')}
    await expect(manager.importMedia(source,true)).rejects.toThrow('frame index disk failure')
    expect(await readFile(source)).toEqual(bytes);expect(manager.state().activeId).toBe(original.project.id);expect(manager.state().items).toHaveLength(1);expect(await readdir(manager.root)).toEqual([original.project.folder])
  },60000)
  it('ignores legacy empty sessions and stale edits after deleting or closing a project',async()=>{
    const {source,root,manager}=await setup(),legacy=join(root,'profile','empty-subtitle-workspace');await mkdir(legacy,{recursive:true});await writeFile(join(legacy,'subtitle-session.json'),JSON.stringify(createSubtitleDocument()))
    const a=await manager.importMedia(source),edited={...a.document,cues:[{id:'cue',startMs:0,endMs:1000,text:'Saved before deletion'}]}
    await manager.cache(edited);await manager.archive(a.project.id);await manager.cache(edited);await manager.cache(createSubtitleDocument());expect(manager.subtitles.get()).toBeUndefined();expect(manager.subtitles.state().dirty).toBe(false)
    const b=await manager.importMedia(source);await manager.cache(edited);expect(await manager.save(edited)).toBeUndefined();expect(manager.subtitles.get()?.id).toBe(b.document.id);expect(manager.subtitles.get()?.cues).toHaveLength(0)
    await manager.close(b.project.id);await manager.cache(b.document);expect(manager.state().activeId).toBeUndefined();expect(manager.subtitles.get()).toBeUndefined();await manager.open(b.project.id);expect(manager.subtitles.get()?.id).toBe(b.document.id)
    await manager.close(b.project.id);const fresh=new ProjectManager(manager.root,join(root,'profile'),new PathPolicy(),()=>{});stores.push(fresh);await fresh.initialize();expect(fresh.subtitles.get()).toBeUndefined();expect(fresh.subtitles.state().dirty).toBe(false)
  },60000)
  it('creates an isolated project with initial subtitles, a display name, custom resolution and format',async()=>{
    const {source,manager}=await setup(),subtitle=createSubtitleDocument({cues:[{id:'cue',startMs:20,endMs:990,text:'Initial subtitle'}]})
    const initial=Buffer.from('[Events]\n'),result=await manager.importMedia(source,false,false,{name:'Custom project',subtitle:{name:'initial.ass',content:initial,document:subtitle},resolution:{width:1280,height:720},exportFormat:'srt'})
    expect(result.project.name).toBe('Custom project');expect(result.project.folder).toBe('clip');expect(result.document.scriptInfo?.PlayResX).toBe('1280');expect(result.document.scriptInfo?.PlayResY).toBe('720');expect(result.document.exportFormat).toBe('srt');expect(result.document.cues[0].text).toBe('Initial subtitle');expect(result.document.id).not.toBe(subtitle.id)
    expect(await readFile(join(result.project.directory,'imports','initial.ass'))).toEqual(initial);await manager.close(result.project.id);expect((await manager.open(result.project.id)).cues[0].text).toBe('Initial subtitle')
  },60000)
  it('copies verified media, ignores legacy sidecars, numbers collisions, and keeps project recovery inside its directory',async()=>{
    const {source,manager}=await setup();const original=await readFile(source);await writeFile(source.replace('.mp4','.ass'),'legacy ASS stays untouched')
    const first=await manager.importMedia(source);expect(await readFile(first.project.mediaPath)).toEqual(original);expect(first.document.cues).toHaveLength(0);expect(first.document.projectPath).toBe(first.project.subtitlePath)
    const edited={...first.document,cues:[{id:'cue',startMs:20,endMs:1000,text:'Saved project'}]};await manager.subtitles.cache(edited);await manager.subtitles.save()
    expect(await readFile(join(first.project.directory,'subtitle-session.json'),'utf8')).toContain('Saved project');expect(await readFile(first.project.subtitlePath,'utf8')).toContain('Saved project');expect(await readdir(join(first.project.directory,'subtitle-backups'))).toHaveLength(1)
    const second=await manager.importMedia(source);expect(second.project.folder).toBe('clip (2)');expect(second.project.id).not.toBe(first.project.id)
    await manager.open(first.project.id);expect(manager.subtitles.get()?.cues[0].text).toBe('Saved project');expect(await readFile(source)).toEqual(original);expect(await readFile(source.replace('.mp4','.ass'),'utf8')).toBe('legacy ASS stays untouched')
  },60000)
  it('deletes the original only after a verified complete project is published',async()=>{
    const {source,manager}=await setup();const bytes=await readFile(source),result=await manager.importMedia(source,true)
    await expect(readFile(source)).rejects.toMatchObject({code:'ENOENT'});expect(await readFile(result.project.mediaPath)).toEqual(bytes);expect(await readFile(result.project.subtitlePath,'utf8')).toContain('[Events]');expect(JSON.parse(await readFile(join(result.project.directory,'project.json'),'utf8')).id).toBe(result.project.id)
  },60000)
  it('cancels copying without deleting the source or publishing a partial project',async()=>{
    const {source,manager}=await setup((m)=>{if(m.state().import.active&&m.state().import.transferred>0)m.cancelImport()});const bytes=await readFile(source)
    await expect(manager.importMedia(source,true)).rejects.toThrow('取消');expect(await readFile(source)).toEqual(bytes);expect(manager.state().items).toHaveLength(0);expect(await readdir(manager.root)).toHaveLength(0)
  },60000)
  it('refuses source deletion when the original changes during import',async()=>{
    let changed=false;const {source,manager}=await setup((m,s)=>{if(!changed&&m.state().import.transferred>0){changed=true;utimesSync(s,new Date(),new Date(Date.now()+10000))}})
    await expect(manager.importMedia(source,true)).rejects.toThrow('发生变化');expect((await readFile(source)).length).toBe(64*1024);expect(manager.state().items).toHaveLength(0)
  },60000)
  it('archives and restores the complete project without touching its original',async()=>{
    const {source,manager}=await setup(),result=await manager.importMedia(source);await manager.rename(result.project.id,'Renamed project')
    await manager.archive(result.project.id);expect(manager.state().activeId).toBeUndefined();expect(manager.state().items[0].archived).toBe(true);expect(await readFile(source)).toEqual(await readFile(join(manager.root,'.trash',result.project.id,'clip.mp4')))
    await manager.restore(result.project.id);await manager.open(result.project.id);expect(manager.active()?.name).toBe('Renamed project');expect(manager.subtitles.get()?.mediaPath).toBe(result.project.mediaPath)
  },60000)
  it('refuses a redirected project root',async()=>{
    const {root,source,manager}=await setup();await rm(manager.root,{recursive:true});const outside=join(root,'redirected');await mkdir(outside);await symlink(outside,manager.root,process.platform==='win32'?'junction':'dir')
    await expect(manager.importMedia(source,true)).rejects.toThrow('符号链接');expect(await readdir(outside)).toEqual([]);expect(await readFile(source)).toBeTruthy()
  },60000)
})
