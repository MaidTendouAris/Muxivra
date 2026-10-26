import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {link,mkdir,mkdtemp,rm,symlink,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {listSourceProjectFiles,resolveSourceProjectPath,SOURCE_EXPLORER_LIMIT} from '../../src/core/subtitles/source-explorer'
import {MAX_SOURCE_BYTES} from '../../src/core/subtitles/source-file'
import {isWithin} from '../../src/core/media/paths'

let fixture:string,root:string,outside:string
beforeEach(async()=>{await mkdir('.test-data',{recursive:true});fixture=await mkdtemp(resolve('.test-data','source-explorer-'));root=join(fixture,'project');outside=join(fixture,'outside');await mkdir(root);await mkdir(outside)})
afterEach(async()=>{if(!isWithin(resolve('.test-data'),fixture)||fixture===resolve('.test-data'))throw new Error('Unsafe test cleanup');await rm(fixture,{recursive:true,force:true})})

describe('bounded project source explorer',()=>{
  it('lists one level, sorts folders first and preserves case, Unicode and text classifications',async()=>{
    await mkdir(join(root,'Subtitles'));await mkdir(join(root,'cache'));await mkdir(join(root,'Subtitles','深层'))
    await writeFile(join(root,'日本語.ASS'),'[Events]');await writeFile(join(root,'english.srt'),'1');await writeFile(join(root,'movie.mp4'),'binary media');await writeFile(join(root,'project.json'),'{}');await writeFile(join(root,'.editor.md'),'notes');await writeFile(join(root,'.muxivra-source-ignore.tmp'),'incomplete');await writeFile(join(root,'other.tmp'),'incomplete');await writeFile(join(root,'Subtitles','简体中文.SRT'),'1')
    const listing=await listSourceProjectFiles(root)
    expect(listing.directory).toBe('');expect(listing.truncated).toBe(false)
    expect(listing.entries.slice(0,2).map(entry=>entry.name)).toEqual(['cache','Subtitles'])
    expect(listing.entries.find(entry=>entry.name==='日本語.ASS')).toMatchObject({path:'日本語.ASS',type:'file',text:true,subtitle:true})
    expect(listing.entries.find(entry=>entry.name==='movie.mp4')).toMatchObject({type:'file',text:false,subtitle:false})
    expect(listing.entries.find(entry=>entry.name==='project.json')?.text).toBe(true);expect(listing.entries.some(entry=>entry.name==='.editor.md')).toBe(true)
    expect(listing.entries.some(entry=>entry.name.endsWith('.tmp'))).toBe(false);expect(listing.entries.some(entry=>entry.name==='简体中文.SRT')).toBe(false)
    const nested=await listSourceProjectFiles(root,'Subtitles')
    expect(nested.entries.map(entry=>entry.path)).toEqual(['Subtitles/深层','Subtitles/简体中文.SRT'])
    expect(await resolveSourceProjectPath(root,'Subtitles/简体中文.SRT')).toBe(join(root,'Subtitles','简体中文.SRT'))
  })

  it.each(['..','../outside','Subtitles/../outside','/absolute','C:/Windows','C:Windows','//server/share','\\\\server\\share','Subtitles\\nested','Subtitles//nested','./Subtitles','Subtitles/','Subtitles/..','Subtitles.','Subtitles ','a:b','a\0b'])('rejects unsafe relative path %j for both listing and selection',async path=>{
    await expect(listSourceProjectFiles(root,path)).rejects.toThrow('路径无效');await expect(resolveSourceProjectPath(root,path)).rejects.toThrow('路径无效')
  })

  it('rejects root selection, nonexistent children and directory-as-file without leaving the project',async()=>{
    await mkdir(join(root,'folder'));await writeFile(join(outside,'secret.ass'),'secret')
    await expect(resolveSourceProjectPath(root,'')).rejects.toThrow('路径无效');await expect(resolveSourceProjectPath(root,'folder')).rejects.toThrow('普通文件');await expect(listSourceProjectFiles(root,'missing')).rejects.toMatchObject({code:'ENOENT'})
  })

  it('does not traverse linked directories or expose their contents',async()=>{
    await writeFile(join(outside,'secret.ass'),'secret')
    const alias=join(root,'linked');await symlink(outside,alias,process.platform==='win32'?'junction':'dir')
    expect((await listSourceProjectFiles(root)).entries.some(entry=>entry.name==='linked')).toBe(false)
    await expect(listSourceProjectFiles(root,'linked')).rejects.toThrow('目录已变化');await expect(resolveSourceProjectPath(root,'linked/secret.ass')).rejects.toThrow('目录已变化')
    await expect(listSourceProjectFiles(alias)).rejects.toThrow('目录已变化')
  })

  it('does not traverse a linked ancestor that points back inside the project',async()=>{
    await mkdir(join(root,'actual'));await writeFile(join(root,'actual','inside.ass'),'[Events]')
    await symlink(join(root,'actual'),join(root,'alias'),process.platform==='win32'?'junction':'dir')
    await expect(listSourceProjectFiles(root,'alias')).rejects.toThrow('目录已变化');await expect(resolveSourceProjectPath(root,'alias/inside.ass')).rejects.toThrow('目录已变化')
  })

  it('marks oversized and hard-linked files unreadable and refuses selecting hard links',async()=>{
    await writeFile(join(root,'oversized.ass'),Buffer.alloc(MAX_SOURCE_BYTES+1));await writeFile(join(root,'original.srt'),'caption');await link(join(root,'original.srt'),join(root,'linked.srt'))
    const entries=(await listSourceProjectFiles(root)).entries
    expect(entries.find(entry=>entry.name==='oversized.ass')).toMatchObject({subtitle:true,text:false})
    expect(entries.find(entry=>entry.name==='original.srt')?.text).toBe(false);expect(entries.find(entry=>entry.name==='linked.srt')?.text).toBe(false)
    await expect(resolveSourceProjectPath(root,'linked.srt')).rejects.toThrow('普通文件')
  })

  it('caps directory enumeration without recursively walking descendants',async()=>{
    await Promise.all(Array.from({length:SOURCE_EXPLORER_LIMIT+3},(_,index)=>writeFile(join(root,`line-${index}.ass`),'[Events]')))
    const listing=await listSourceProjectFiles(root)
    expect(listing.entries).toHaveLength(SOURCE_EXPLORER_LIMIT);expect(listing.truncated).toBe(true);expect(new Set(listing.entries.map(entry=>entry.path)).size).toBe(SOURCE_EXPLORER_LIMIT)
  })
})
