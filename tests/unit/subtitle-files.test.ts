import { afterEach,describe,it,expect } from 'vitest'
import { mkdtemp,mkdir,writeFile,readFile,rm,lstat,unlink } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { ProjectManager } from '../../src/core/projects'
import { PathPolicy,isWithin } from '../../src/core/media/paths'
const roots:string[]=[],stores:ProjectManager[]=[]
async function setup(){await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data','subtitle-files-'));roots.push(root);const source=join(root,'clip.mp4'),paths=new PathPolicy();await writeFile(source,'unchanged media');await paths.grantFile(source);const manager=new ProjectManager(join(root,'projects'),join(root,'profile'),paths,()=>{});stores.push(manager);await manager.initialize();const imported=await manager.importMedia(source);return {root,source,manager,...imported}}
afterEach(async()=>{for(const store of stores.splice(0))await store.shutdown();for(const root of roots.splice(0)){if(!isWithin(resolve('.test-data'),root))throw new Error('Unsafe cleanup');await rm(root,{recursive:true,force:true})}})
describe('multiple project ASS files',()=>{
  it('does not delete the last physical ASS when another listed file is missing',async()=>{
    const {manager,project}=await setup(),second=await manager.createSubtitle(project.id,'Second.ass'),id=manager.active()!.activeSubtitleId
    await unlink(project.subtitlePath);await expect(manager.deleteSubtitle(project.id,id)).rejects.toThrow('至少');expect(await readFile(second.projectPath!,'utf8')).toContain('[Events]');expect(manager.active()?.activeSubtitleId).toBe(id)
  })
  it('creates one ASS by default, numbers duplicate names, and preserves independent edits across switches and restart',async()=>{
    const {root,source,manager,project,document}=await setup();expect(project.subtitles).toHaveLength(1)
    const first={...document,scriptInfo:{...document.scriptInfo,PlayResX:'1280',PlayResY:'720'},cues:[{id:'ja',startMs:100,endMs:900,text:'日本語'}]};await manager.cache(first)
    const second=await manager.createSubtitle(project.id,'clip.ass');expect(manager.active()?.subtitles.map(s=>s.name)).toEqual(['clip.ass','clip (2).ass']);expect(second.cues).toHaveLength(0);expect(second.scriptInfo?.PlayResX).toBe('1280');expect(second.scriptInfo?.PlayResY).toBe('720');expect(second.styles).toEqual(first.styles)
    const secondId=manager.active()!.activeSubtitleId;await manager.cache({...second,cues:[{id:'en',startMs:100,endMs:900,text:'English'}]})
    const restored=await manager.selectSubtitle(project.id,project.activeSubtitleId);expect(restored.cues[0].text).toBe('日本語');await manager.cache({...second,cues:[]});expect(manager.subtitles.get()?.cues[0].text).toBe('日本語')
    expect((await manager.selectSubtitle(project.id,secondId)).cues[0].text).toBe('English');await manager.shutdown()
    const restarted=new ProjectManager(manager.root,join(root,'profile'),new PathPolicy(),()=>{});stores.push(restarted);await restarted.initialize();expect(restarted.active()?.activeSubtitleId).toBe(secondId);expect(restarted.subtitles.get()?.cues[0].text).toBe('English');expect((await restarted.selectSubtitle(project.id,project.activeSubtitleId)).cues[0].text).toBe('日本語');expect(await readFile(source,'utf8')).toBe('unchanged media')
  })
  it('renames the ASS and its recovery binding without overwriting, deletes only the selected file, and enforces the last-file rule',async()=>{
    const {source,manager,project,document}=await setup();await expect(manager.deleteSubtitle(project.id,project.activeSubtitleId)).rejects.toThrow('至少')
    await manager.cache({...document,cues:[{id:'line',startMs:0,endMs:1000,text:'Keep me'}]});const renamed=await manager.renameSubtitle(project.id,project.activeSubtitleId,'English');expect(renamed.projectPath).toBe(join(project.directory,'English.ass'));expect(renamed.cues[0].text).toBe('Keep me');await expect(lstat(project.subtitlePath)).rejects.toMatchObject({code:'ENOENT'})
    await manager.close(project.id);expect((await manager.open(project.id)).cues[0].text).toBe('Keep me')
    const second=await manager.createSubtitle(project.id,'Japanese'),secondId=manager.active()!.activeSubtitleId;await expect(manager.renameSubtitle(project.id,secondId,'English')).rejects.toThrow('同名');await expect(manager.createSubtitle(project.id,'../escape')).rejects.toThrow()
    const remaining=await manager.deleteSubtitle(project.id,secondId);expect(remaining.cues[0].text).toBe('Keep me');await expect(lstat(second.projectPath!)).rejects.toMatchObject({code:'ENOENT'});await manager.cache(second);expect(manager.subtitles.get()?.id).toBe(remaining.id);expect(manager.active()?.subtitles).toHaveLength(1);await expect(manager.deleteSubtitle(project.id,project.activeSubtitleId)).rejects.toThrow('至少');expect(await readFile(source,'utf8')).toBe('unchanged media')
  })
})
