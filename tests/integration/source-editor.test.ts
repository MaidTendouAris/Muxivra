import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
import { mkdir,mkdtemp,readFile,readdir,rm,symlink,link,writeFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { SourceFile,MAX_SOURCE_BYTES,parseProjectSource,sourceHash } from '../../src/core/subtitles/source-file'
import { SubtitleProjectStore,SUBTITLE_AUTOSAVE_MS } from '../../src/core/subtitles/project'
import { isWithin,PathPolicy } from '../../src/core/media/paths'
import { createSubtitleDocument } from '../../src/shared/subtitles'
import { serializeAss } from '../../src/core/subtitles/ass'

let root:string,stores:SubtitleProjectStore[]=[]
beforeEach(async()=>{await mkdir('.test-data',{recursive:true});root=await mkdtemp(resolve('.test-data','source-editor-'))})
afterEach(async()=>{vi.restoreAllMocks();for(const store of stores)await store.shutdown();stores=[];if(!isWithin(resolve('.test-data'),root))throw new Error('Unsafe cleanup');await rm(root,{recursive:true,force:true})})

async function project(){
  const directory=join(root,'project');await mkdir(directory,{recursive:true})
  const mediaPath=join(directory,'media.wav'),projectPath=join(directory,'subtitles.ass');await writeFile(mediaPath,'source media must not be changed')
  const paths=new PathPolicy();await paths.grantFile(mediaPath)
  const store=new SubtitleProjectStore(directory,paths,()=>{},{mediaPath,projectPath});stores.push(store);await store.initialize()
  const opened=await store.openManaged(mediaPath,projectPath)
  const document=(await store.save({...opened,cues:[{id:'first',startMs:120,endMs:1450,text:'Original line',style:'Default'},{id:'second',startMs:2000,endMs:3100,text:'Second line',style:'Default'}]}))!
  return {store,document,mediaPath,projectPath,directory}
}

describe('independent text source file',()=>{
  it.each(['UTF-8','UTF-8 BOM','UTF-16 LE'] as const)('preserves %s encoding and exact CRLF source content when saving',async encoding=>{
    const path=join(root,'captions.srt'),text='1\r\n00:00:00,123 --> 00:00:01,789\r\n字幕 🎵\r\n\r\n'
    const encode=(value:string)=>encoding==='UTF-16 LE'?Buffer.concat([Buffer.from([255,254]),Buffer.from(value,'utf16le')]):encoding==='UTF-8 BOM'?Buffer.concat([Buffer.from([239,187,191]),Buffer.from(value)]):Buffer.from(value)
    await writeFile(path,encode(text));const file=await SourceFile.open(path),loaded=await file.read()
    expect(loaded).toMatchObject({text,encoding,name:'captions.srt',hash:sourceHash(encode(text))})
    const changed=text.replace('字幕 🎵','Updated 字幕 🎵'),saved=await file.save(changed,loaded.hash)
    expect(saved).toMatchObject({text:changed,encoding,hash:sourceHash(encode(changed))});expect(await readFile(path)).toEqual(encode(changed))
    expect((await readdir(root)).filter(name=>name.startsWith('.muxivra-source-'))).toEqual([])
  })
  it('does not overwrite external edits or let an old window reuse its saved revision',async()=>{
    const path=join(root,'notes.md');await writeFile(path,'Initial text\n');const first=await SourceFile.open(path),second=await SourceFile.open(path),revision=await first.read()
    const saved=await first.save('Saved by first window\n',revision.hash)
    await expect(second.save('Stale second window\n',revision.hash)).rejects.toThrow('文件已更改');expect(await readFile(path,'utf8')).toBe(saved.text)
    await writeFile(path,'External edit retained\n')
    await expect(first.save('Old first window\n',saved.hash)).rejects.toThrow('文件已更改');expect(await readFile(path,'utf8')).toBe('External edit retained\n')
  })
  it('rejects binary content, invalid Unicode, unsupported types, directories and files over the size limit',async()=>{
    const binary=join(root,'binary.txt'),invalid=join(root,'invalid.txt'),oddUtf16=join(root,'odd.txt'),unsupported=join(root,'program.exe'),directory=join(root,'directory.txt'),large=join(root,'large.log')
    await writeFile(binary,Buffer.from([65,0,66]));await writeFile(invalid,Buffer.from([0xc3,0x28]));await writeFile(oddUtf16,Buffer.from([255,254,65]));await writeFile(unsupported,'text');await mkdir(directory);await writeFile(large,Buffer.alloc(MAX_SOURCE_BYTES+1,65))
    await expect(SourceFile.open(binary)).rejects.toThrow('二进制');await expect(SourceFile.open(invalid)).rejects.toThrow();await expect(SourceFile.open(oddUtf16)).rejects.toThrow('UTF-16');await expect(SourceFile.open(unsupported)).rejects.toThrow('文件类型');await expect(SourceFile.open(directory)).rejects.toThrow('普通文件');await expect(SourceFile.open(large)).rejects.toThrow('10 MB')
  })
  it('keeps the original intact when a proposed save contains NUL or exceeds the byte limit',async()=>{
    const path=join(root,'notes.txt');await writeFile(path,'Keep original');const file=await SourceFile.open(path),loaded=await file.read()
    await expect(file.save('Binary\0value',loaded.hash)).rejects.toThrow('空字节');await expect(file.save('é'.repeat(MAX_SOURCE_BYTES/2+1),loaded.hash)).rejects.toThrow('10 MB')
    expect(await readFile(path,'utf8')).toBe('Keep original');expect((await readdir(root)).filter(name=>name.startsWith('.muxivra-source-'))).toEqual([])
  })
  it('refuses hard-linked file aliases, including an alias added after the editor opens',async()=>{
    const path=join(root,'original.txt'),alias=join(root,'alias.txt');await writeFile(path,'Shared target');const file=await SourceFile.open(path),loaded=await file.read();await link(path,alias)
    await expect(SourceFile.open(alias)).rejects.toThrow('独立');await expect(file.save('Must not change both files',loaded.hash)).rejects.toThrow('独立');expect(await readFile(alias,'utf8')).toBe('Shared target')
  })
  it('refuses a symbolic link when the host allows creating file symlinks',async context=>{
    const target=join(root,'target.txt'),alias=join(root,'symbolic.txt');await writeFile(target,'Symlink target')
    try{await symlink(target,alias,'file')}catch(error){if(['EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code??'')){context.skip();return}throw error}
    await expect(SourceFile.open(alias)).rejects.toThrow('普通文件');expect(await readFile(target,'utf8')).toBe('Symlink target')
  })
})

describe('managed ASS source synchronization',()=>{
  it('preserves project identity, linked paths, export mode and stable cue IDs while parsing edited source',async()=>{
    const {document}=await project(),current=createSubtitleDocument({...document,sourcePath:join(root,'project','imports','initial.srt'),exportFormat:'srt'})
    const raw=serializeAss(current).replace('Original line','Edited {\\b1}line{\\b0}').replace('0:00:02.00','0:00:02.34')+'\r\n[Aegisub Project Garbage]\r\nVideo Position: 73\r\n'
    const parsed=parseProjectSource(raw,current)
    expect(parsed).toMatchObject({id:current.id,projectPath:current.projectPath,mediaPath:current.mediaPath,sourcePath:current.sourcePath,exportFormat:'srt'})
    expect(parsed.cues.map(cue=>cue.id)).toEqual(['first','second']);expect(parsed.cues[0].text).toBe('Edited {\\b1}line{\\b0}');expect(parsed.cues[1].startMs).toBe(2340);expect(parsed.sections).toContainEqual({name:'Aegisub Project Garbage',lines:['Video Position: 73']})
    const reordered=parseProjectSource(serializeAss({...current,cues:[current.cues[1],current.cues[0]]}),current);expect(reordered.cues.map(cue=>cue.id)).toEqual(['second','first'])
  })
  it('retains raw formatting and comments through source save, the registered 60-second autosave and restart',async()=>{
    const {store,document,mediaPath,projectPath,directory}=await project(),before=await readFile(projectPath),interval=vi.spyOn(global,'setInterval')
    // A real store initializes and registers the production interval. Invoke that
    // callback explicitly so this regression does not spend a minute waiting.
    await store.shutdown();stores=[]
    const restored=new SubtitleProjectStore(directory,new PathPolicy(),()=>{},{mediaPath,projectPath});stores.push(restored);await restored.initialize()
    const tick=interval.mock.calls.find(call=>call[1]===SUBTITLE_AUTOSAVE_MS)?.[0] as (()=>void)|undefined;expect(SUBTITLE_AUTOSAVE_MS).toBe(60_000);expect(tick).toBeTypeOf('function')
    const raw=(await readFile(projectPath,'utf8')).replace('[Events]','; Editor formatting and comments are intentional\r\n\r\n[Events]').replace('Original line','Edited source line').replace('Dialogue: 0,0:00:00.12','Dialogue:   0,0:00:00.12')
    const parsed=parseProjectSource(raw,restored.get()!)
    await restored.save(parsed,{text:raw,hash:sourceHash(before)})
    expect(await readFile(projectPath,'utf8')).toBe(raw);expect(restored.state().dirty).toBe(false);expect(restored.get()?.cues[0].text).toBe('Edited source line')
    const periodic=vi.spyOn(restored,'save');tick!();expect(periodic).toHaveBeenCalledWith();await periodic.mock.results[0].value
    expect(await readFile(projectPath,'utf8')).toBe(raw);expect(await readFile(mediaPath,'utf8')).toBe('source media must not be changed')
    await restored.shutdown();stores=[]
    const reopened=new SubtitleProjectStore(directory,new PathPolicy(),()=>{},{mediaPath,projectPath});stores.push(reopened);await reopened.initialize();expect(reopened.state()).toMatchObject({dirty:false});expect(reopened.state().recoveryPending).toBeUndefined();expect(reopened.get()?.id).toBe(document.id);expect(reopened.get()?.cues[0].id).toBe('first');expect(await readFile(projectPath,'utf8')).toBe(raw)
  })
  it('rejects invalid ASS and mismatched parsed documents without changing the document, recovery or file',async()=>{
    const {store,document,projectPath,directory}=await project(),before=await readFile(projectPath),recovery=await readFile(join(directory,'subtitle-session.json'))
    const invalid=before.toString('utf8').replace('0:00:00.12','invalid-time')
    await expect(store.save(document,{text:invalid,hash:sourceHash(before)})).rejects.toThrow('时间无效');expect(store.get()).toEqual(document);expect(await readFile(projectPath)).toEqual(before);expect(await readFile(join(directory,'subtitle-session.json'))).toEqual(recovery)
    const mismatch={...document,cues:document.cues.map((cue,index)=>index===0?{...cue,text:'Document-only edit'}:cue)}
    await expect(store.save(mismatch,{text:before.toString('utf8'),hash:sourceHash(before)})).rejects.toThrow('不一致');expect(store.get()).toEqual(document);expect(await readFile(projectPath)).toEqual(before);expect(await readFile(join(directory,'subtitle-session.json'))).toEqual(recovery)
  })
  it('rejects an external source revision or forged baseline without adopting the proposed document',async()=>{
    const {store,document,projectPath,directory}=await project(),before=await readFile(projectPath),recovery=await readFile(join(directory,'subtitle-session.json')),raw=before.toString('utf8').replace('Original line','Proposed edit'),parsed=parseProjectSource(raw,document)
    await expect(store.save(parsed,{text:raw,hash:'0'.repeat(64)})).rejects.toThrow('源码已更改');expect(store.get()).toEqual(document);expect(await readFile(projectPath)).toEqual(before)
    const external=Buffer.from(before.toString('utf8')+'\r\n; External edit wins\r\n');await writeFile(projectPath,external)
    await expect(store.save(parsed,{text:raw,hash:sourceHash(before)})).rejects.toThrow('源码已更改');expect(store.get()).toEqual(document);expect(await readFile(projectPath)).toEqual(external);expect(await readFile(join(directory,'subtitle-session.json'))).toEqual(recovery)
  })
})
