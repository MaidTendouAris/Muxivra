import { mkdir,mkdtemp,readFile,readdir,rm,symlink,writeFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
import { ensureProjectFonts } from '../../src/core/media/project-fonts'
import { isWithin } from '../../src/core/media/paths'
import { run } from '../../src/core/engine/process'
import { atomicRename } from '../../src/core/storage/atomic'
import type { Engine } from '../../src/shared/types'

vi.mock('../../src/core/engine/process',()=>({run:vi.fn()}))
vi.mock('../../src/core/storage/atomic',async importOriginal=>{
  const actual=await importOriginal<typeof import('../../src/core/storage/atomic')>()
  return {...actual,atomicRename:vi.fn(actual.atomicRename)}
})
const engine:Engine={id:'font-test',ffmpegPath:'ffmpeg',ffprobePath:'ffprobe',version:'test',source:'local',encoders:[],decoders:[],filters:[],detectedAt:''}
let root:string,project:string,media:string,font:Buffer,streams:Record<string,unknown>[],bytes:Buffer
beforeEach(async()=>{
  await mkdir('.test-data',{recursive:true});root=await mkdtemp(resolve('.test-data','font-unit-'));project=join(root,'project');await mkdir(project);media=join(project,'media.mkv');await writeFile(media,'managed source')
  font=await readFile(resolve('tests/fixtures/fonts/muxivra-test.ttf'));bytes=font
  streams=[{index:4,codec_type:'attachment',codec_name:'ttf',extradata_size:font.length,tags:{filename:'../../outside.ttf',mimetype:'font/ttf'}}]
  vi.mocked(run).mockReset();vi.mocked(atomicRename).mockReset();vi.mocked(atomicRename).mockImplementation((await vi.importActual<typeof import('../../src/core/storage/atomic')>('../../src/core/storage/atomic')).atomicRename)
  vi.mocked(run).mockImplementation(async(executable,args)=>{
    if(executable===engine.ffprobePath)return JSON.stringify({streams})
    for(let index=0;index<args.length;index++)if(args[index].startsWith('-dump_attachment:'))await writeFile(args[index+1],bytes)
    return ''
  })
})
afterEach(async()=>{if(root&&isWithin(resolve('.test-data'),root))await rm(root,{recursive:true,force:true})})

describe('project-local font resources',()=>{
  it('uses fixed filenames and a verified reusable cache, without trusting attachment paths',async()=>{
    const directory=await ensureProjectFonts(engine,media,project)
    expect(directory&&isWithin(join(project,'fonts'),directory)).toBe(true)
    expect(await readdir(directory!)).toEqual(['font-4.ttf'])
    expect(await readFile(join(directory!,'font-4.ttf'))).toEqual(font)
    expect(await ensureProjectFonts(engine,media,project)).toBe(directory)
    expect(run).toHaveBeenCalledTimes(2)
    expect((await readdir(join(project,'fonts'))).some(name=>name.startsWith('.'))).toBe(false)
  })
  it('rebuilds modified font bytes into a fresh generation while preserving the previous resource',async()=>{
    const first=await ensureProjectFonts(engine,media,project),damaged=Buffer.from(font);damaged[damaged.length-1]^=1
    await writeFile(join(first!,'font-4.ttf'),damaged)
    const second=await ensureProjectFonts(engine,media,project)
    expect(second).not.toBe(first);expect(await readFile(join(second!,'font-4.ttf'))).toEqual(font)
    expect(await readFile(join(first!,'font-4.ttf'))).toEqual(damaged)
    expect(run).toHaveBeenCalledTimes(4)
  })
  it('rebuilds when the managed source changes and ignores unlisted cached files',async()=>{
    const first=await ensureProjectFonts(engine,media,project)
    await writeFile(media,'changed source bytes')
    const second=await ensureProjectFonts(engine,media,project)
    expect(second).not.toBe(first)
    await writeFile(join(second!,'unlisted.ttf'),font)
    expect(await ensureProjectFonts(engine,media,project)).not.toBe(second)
  })
  it('does not expose executable bytes even when attachment metadata claims a font',async()=>{
    bytes=Buffer.alloc(font.length);bytes.write('MZ executable payload')
    expect(await ensureProjectFonts(engine,media,project)).toBeUndefined()
    const manifest=JSON.parse(await readFile(join(project,'fonts','manifest.json'),'utf8'))
    expect(manifest.fonts).toEqual([]);expect(await readdir(join(project,'fonts',manifest.directory))).toEqual([])
    expect(await ensureProjectFonts(engine,media,project)).toBeUndefined();expect(run).toHaveBeenCalledTimes(2)
  })
  it('accepts a bounded TrueType collection using the detected file signature',async()=>{
    bytes=Buffer.alloc(font.length+16);bytes.write('ttcf');bytes.writeUInt32BE(0x00010000,4);bytes.writeUInt32BE(1,8);bytes.writeUInt32BE(16,12);font.copy(bytes,16)
    for(let index=0;index<font.readUInt16BE(4);index++){const offset=16+12+index*16+8;bytes.writeUInt32BE(bytes.readUInt32BE(offset)+16,offset)}
    streams=[{...streams[0],extradata_size:bytes.length}]
    const directory=await ensureProjectFonts(engine,media,project)
    expect(await readdir(directory!)).toEqual(['font-4.ttc'])
  })
  it('rejects a font signature whose table directory points outside its attachment',async()=>{
    bytes=Buffer.from(font);bytes.writeUInt32BE(0x7fffffff,20)
    expect(await ensureProjectFonts(engine,media,project)).toBeUndefined()
  })
  it('rejects excessive attachment sizes or counts before starting extraction',async()=>{
    streams=[{...streams[0],extradata_size:33*1024*1024}]
    await expect(ensureProjectFonts(engine,media,project)).rejects.toThrow('数量或大小')
    expect(run).toHaveBeenCalledTimes(1)
    streams=Array.from({length:65},(_,index)=>({index,codec_type:'attachment',codec_name:'ttf',extradata_size:font.length}))
    await expect(ensureProjectFonts(engine,media,project)).rejects.toThrow('数量或大小')
    expect(run).toHaveBeenCalledTimes(2)
  })
  it('rejects linked font directories before probing or writing into them',async()=>{
    const outside=join(root,'outside');await mkdir(outside);await symlink(outside,join(project,'fonts'),process.platform==='win32'?'junction':'dir')
    await expect(ensureProjectFonts(engine,media,project)).rejects.toThrow('符号链接')
    expect(await readdir(outside)).toEqual([]);expect(run).not.toHaveBeenCalled()
  })
  it('honors cancellation and leaves no extraction staging on failure',async()=>{
    const signal=AbortSignal.abort()
    await expect(ensureProjectFonts(engine,media,project,signal)).rejects.toThrow()
    vi.mocked(run).mockImplementationOnce(async()=>JSON.stringify({streams})).mockImplementationOnce(async()=>{throw new Error('extraction failed')})
    await expect(ensureProjectFonts(engine,media,project)).rejects.toThrow('extraction failed')
    expect(await readdir(join(project,'fonts'))).toEqual([])
  })
  it('preserves the previous cache manifest when publication fails',async()=>{
    await ensureProjectFonts(engine,media,project)
    const previous=await readFile(join(project,'fonts','manifest.json'),'utf8')
    await writeFile(media,'changed source bytes')
    const actual=await vi.importActual<typeof import('../../src/core/storage/atomic')>('../../src/core/storage/atomic')
    vi.mocked(atomicRename).mockImplementationOnce(actual.atomicRename).mockRejectedValueOnce(new Error('publication failed'))
    await expect(ensureProjectFonts(engine,media,project)).rejects.toThrow('publication failed')
    expect(await readFile(join(project,'fonts','manifest.json'),'utf8')).toBe(previous)
    expect((await readdir(join(project,'fonts'))).some(name=>name.startsWith('.'))).toBe(false)
  })
})
