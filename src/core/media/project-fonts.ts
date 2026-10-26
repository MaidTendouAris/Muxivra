import { createHash,randomUUID } from 'node:crypto'
import { lstat,mkdir,readFile,readdir,realpath,rename,rm,stat,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Engine } from '../../shared/types'
import { inputFormatWhitelist } from '../../shared/media-policy'
import { run } from '../engine/process'
import { atomicRename } from '../storage/atomic'
import { canonicalInput,isWithin,localPath } from './paths'

const MAX_FONTS=64,MAX_FONT_BYTES=32*1024*1024,MAX_TOTAL_BYTES=128*1024*1024
const fontName=z.string().regex(/^font-\d+\.(?:ttf|otf|ttc)$/)
const manifestSchema=z.object({format:z.literal('muxivra-project-fonts'),version:z.literal(1),source:z.object({path:z.string(),size:z.number().int().nonnegative(),mtimeMs:z.number().nonnegative()}).strict(),directory:z.string().regex(/^attached-[a-f0-9-]{36}$/),fonts:z.array(z.object({file:fontName,size:z.number().int().positive().max(MAX_FONT_BYTES),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(MAX_FONTS)}).strict()
type FontManifest=z.infer<typeof manifestSchema>
const mimeTypes=new Set(['application/x-truetype-font','application/vnd.ms-opentype','application/x-font-ttf','application/x-font-otf','application/x-font-opentype','application/font-sfnt','font/ttf','font/otf','font/collection'])
const digest=(content:Buffer)=>createHash('sha256').update(content).digest('hex')
const sameSource=(left:FontManifest['source'],right:FontManifest['source'])=>left.path===right.path&&left.size===right.size&&left.mtimeMs===right.mtimeMs

async function ordinaryDirectory(path:string) {
  const info=await lstat(path),actual=await realpath(path)
  if(!info.isDirectory()||info.isSymbolicLink()||actual.toLowerCase()!==localPath(path).toLowerCase())throw new Error('项目字体目录已变化或包含符号链接')
  return actual
}
async function ordinaryFile(path:string,maxBytes:number) {
  const info=await lstat(path)
  if(!info.isFile()||info.isSymbolicLink()||info.size>maxBytes)throw new Error('项目字体文件无效、过大或包含符号链接')
  return info
}
/** Validate SFNT table ranges before exposing an attachment to a font renderer. */
function fontExtension(content:Buffer):'ttf'|'otf'|'ttc'|undefined {
  const sfnt=(offset:number)=>{
    if(offset+12>content.length)return false
    const signature=content.toString('ascii',offset,offset+4)
    if(content.readUInt32BE(offset)!==0x00010000&&!['OTTO','true'].includes(signature))return false
    const tables=content.readUInt16BE(offset+4)
    if(!tables||tables>4096||offset+12+tables*16>content.length)return false
    for(let index=0;index<tables;index++) {
      const table=offset+12+index*16,start=content.readUInt32BE(table+8),length=content.readUInt32BE(table+12)
      if(start+length>content.length)return false
    }
    return true
  }
  if(content.length<12)return undefined
  if(content.toString('ascii',0,4)==='ttcf') {
    const version=content.readUInt32BE(4),count=content.readUInt32BE(8)
    if(![0x00010000,0x00020000].includes(version)||!count||count>256||12+count*4>content.length)return undefined
    for(let index=0;index<count;index++)if(!sfnt(content.readUInt32BE(12+index*4)))return undefined
    return 'ttc'
  }
  return sfnt(0)?content.toString('ascii',0,4)==='OTTO'?'otf':'ttf':undefined
}
async function cachedFonts(directory:string,source:FontManifest['source'],signal?:AbortSignal):Promise<string|false|undefined> {
  try {
    const path=join(directory,'manifest.json');await ordinaryFile(path,64000)
    const manifest=manifestSchema.parse(JSON.parse(await readFile(path,'utf8')))
    if(!sameSource(manifest.source,source)||manifest.fonts.reduce((total,font)=>total+font.size,0)>MAX_TOTAL_BYTES||new Set(manifest.fonts.map(font=>font.file)).size!==manifest.fonts.length)return false
    const resources=join(directory,manifest.directory);await ordinaryDirectory(resources)
    const names=await readdir(resources)
    if(names.length!==manifest.fonts.length||names.some(name=>!manifest.fonts.some(font=>font.file===name)))return false
    for(const font of manifest.fonts) {
      signal?.throwIfAborted()
      const file=join(resources,font.file),info=await ordinaryFile(file,MAX_FONT_BYTES)
      if(info.size!==font.size)return false
      const content=await readFile(file)
      if(digest(content)!==font.sha256||fontExtension(content)!==font.file.split('.').at(-1))return false
    }
    return manifest.fonts.length?resources:undefined
  } catch(error) {
    // A bad cache is rebuilt into a new generation; never overwrite its contents.
    if(signal?.aborted||(error as NodeJS.ErrnoException).code==='EACCES')throw error
    return false
  }
}

/** Project-local font resources for external ASS burn-in; never installs system fonts. */
export async function ensureProjectFonts(engine:Engine,mediaPath:string,projectDirectory:string,signal?:AbortSignal):Promise<string|undefined> {
  signal?.throwIfAborted()
  const project=await ordinaryDirectory(projectDirectory),media=await canonicalInput(mediaPath),sourceInfo=await stat(media)
  const source={path:media,size:sourceInfo.size,mtimeMs:sourceInfo.mtimeMs},directory=join(project,'fonts')
  await mkdir(directory,{recursive:true});await ordinaryDirectory(directory)
  const cached=await cachedFonts(directory,source,signal)
  if(cached!==false) {
    signal?.throwIfAborted()
    const current=await stat(media)
    if(current.size!==source.size||current.mtimeMs!==source.mtimeMs)throw new Error('字体读取期间媒体文件已变化')
    return cached
  }
  const probe=JSON.parse(await run(engine.ffprobePath,['-v','error','-protocol_whitelist','file,pipe','-format_whitelist',inputFormatWhitelist,'-select_streams','t','-show_entries','stream=index,codec_name,codec_type,extradata_size:stream_tags=filename,mimetype','-of','json',media],{signal,maxBytes:1024*1024})) as {streams?:{index:number;codec_type?:string;codec_name?:string;extradata_size?:number;tags?:Record<string,string>}[]}
  const fonts=(probe.streams??[]).filter(stream=>stream.codec_type==='attachment'&&(/\.(?:ttf|otf|ttc)$/i.test(stream.tags?.filename??'')||mimeTypes.has((stream.tags?.mimetype??'').toLowerCase())||['ttf','otf'].includes(stream.codec_name??'')))
  if(fonts.length>MAX_FONTS||fonts.some(font=>!Number.isSafeInteger(font.index)||font.index<0||font.index>65535||!Number.isSafeInteger(font.extradata_size)||font.extradata_size! <= 0||font.extradata_size! > MAX_FONT_BYTES)||new Set(fonts.map(font=>font.index)).size!==fonts.length||fonts.reduce((total,font)=>total+font.extradata_size!,0)>MAX_TOTAL_BYTES)throw new Error('媒体字体附件数量或大小超出项目限制')
  const id=randomUUID(),staging=join(directory,`.staging-${id}`),generation=`attached-${id}`,resources=join(directory,generation),temporaryManifest=join(directory,`.manifest-${id}.tmp`)
  await ordinaryDirectory(project);await ordinaryDirectory(directory);await mkdir(staging)
  let published=false
  try {
    if(fonts.length)await run(engine.ffmpegPath,['-v','error','-n',...fonts.flatMap(font=>[`-dump_attachment:${font.index}`,join(staging,`attachment-${font.index}.bin`)]),'-protocol_whitelist','file,pipe','-format_whitelist',inputFormatWhitelist,'-i',media,'-map','0:v:0?','-map','0:a:0?','-t','0','-c','copy','-f','null','-'],{signal,timeout:120000})
    const entries:FontManifest['fonts']=[]
    for(const font of fonts) {
      signal?.throwIfAborted()
      const dumped=join(staging,`attachment-${font.index}.bin`),info=await ordinaryFile(dumped,MAX_FONT_BYTES)
      if(info.size!==font.extradata_size)throw new Error('提取期间媒体字体附件已变化')
      const content=await readFile(dumped),extension=fontExtension(content)
      // Metadata is only a candidate hint; reject non-font bytes regardless of its name.
      if(!extension)continue
      const file=`font-${font.index}.${extension}`
      await rename(dumped,join(staging,file));entries.push({file,size:content.length,sha256:digest(content)})
    }
    // Invalid font candidates are never published for libass to scan.
    for(const font of fonts)await rm(join(staging,`attachment-${font.index}.bin`),{force:true})
    signal?.throwIfAborted()
    const current=await stat(media)
    if(current.size!==source.size||current.mtimeMs!==source.mtimeMs)throw new Error('字体提取期间媒体文件已变化')
    await ordinaryDirectory(project);await ordinaryDirectory(directory);await ordinaryDirectory(staging)
    await atomicRename(staging,resources,async()=>{signal?.throwIfAborted();await ordinaryDirectory(project);await ordinaryDirectory(directory)})
    published=true
    const manifest:FontManifest={format:'muxivra-project-fonts',version:1,source,directory:generation,fonts:entries}
    await writeFile(temporaryManifest,JSON.stringify(manifest),{flag:'wx'})
    await atomicRename(temporaryManifest,join(directory,'manifest.json'),async()=>{
      signal?.throwIfAborted();await ordinaryDirectory(project);await ordinaryDirectory(directory)
      try{await ordinaryFile(join(directory,'manifest.json'),64000)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    })
    return entries.length?resources:undefined
  } finally {
    // Only paths generated by this invocation are candidates for cleanup.
    if(!isWithin(project,staging)||!isWithin(project,temporaryManifest))throw new Error('拒绝清理项目范围外的字体暂存文件')
    await ordinaryDirectory(project);await ordinaryDirectory(directory)
    if(!published) {
      try{await ordinaryDirectory(staging);await rm(staging,{recursive:true,force:true})}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    }
    await rm(temporaryManifest,{force:true})
  }
}
