import { createHash,randomUUID } from 'node:crypto'
import { lstat,realpath,readFile,open,unlink } from 'node:fs/promises'
import { basename,dirname,extname,join } from 'node:path'
import { atomicRename } from '../storage/atomic'
import { localPath } from '../media/paths'
import { parseAss } from './ass'
import { normalizeSubtitleDocument,type SubtitleDocument } from '../../shared/subtitles'

export const MAX_SOURCE_BYTES=10*1024*1024
export const sourceHash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex')
const extensions=new Set(['.ass','.ssa','.srt','.vtt','.txt','.md','.json','.jsonc','.yaml','.yml','.toml','.ini','.cfg','.log','.csv','.xml','.html','.css','.js','.ts','.py'])
export const isSourceTextPath=(path:string)=>extensions.has(extname(path).toLowerCase())
export const sourceLanguage=(path:string)=>({'.ass':'ass','.ssa':'ass','.srt':'srt','.vtt':'srt','.md':'markdown','.json':'json','.jsonc':'json','.yaml':'yaml','.yml':'yaml','.html':'html','.xml':'xml','.css':'css','.js':'javascript','.ts':'typescript','.py':'python'}[extname(path).toLowerCase()]??'plaintext')
export type TextEncoding='UTF-8'|'UTF-8 BOM'|'UTF-16 LE'
export function decodeSource(buffer:Buffer):{text:string;encoding:TextEncoding}{
  let text:string,encoding:TextEncoding
  if(buffer[0]===0xff&&buffer[1]===0xfe){if(buffer.length%2)throw new Error('UTF-16 文件字节数无效');text=new TextDecoder('utf-16le',{fatal:true}).decode(buffer.subarray(2));encoding='UTF-16 LE'}
  else{encoding=buffer[0]===0xef&&buffer[1]===0xbb&&buffer[2]===0xbf?'UTF-8 BOM':'UTF-8';text=new TextDecoder('utf-8',{fatal:true}).decode(buffer)}
  if(text.includes('\0'))throw new Error('请选择文本文件，不能编辑二进制文件')
  return {text,encoding}
}
export function encodeSource(text:string,encoding:TextEncoding){
  if(text.includes('\0'))throw new Error('文本文件不能包含空字节')
  const body=Buffer.from(text,encoding==='UTF-16 LE'?'utf16le':'utf8'),buffer=encoding==='UTF-16 LE'?Buffer.concat([Buffer.from([255,254]),body]):encoding==='UTF-8 BOM'?Buffer.concat([Buffer.from([239,187,191]),body]):body
  if(buffer.length>MAX_SOURCE_BYTES)throw new Error('文本文件超过 10 MB')
  return buffer
}
/** A window holds one explicit file grant. No renderer supplied write target. */
export class SourceFile {
  private constructor(readonly path:string){}
  static async open(input:string){const path=localPath(input);if(!isSourceTextPath(path))throw new Error('不支持此文本文件类型');const file=new SourceFile(path);await file.read();return file}
  private async verify(){const info=await lstat(this.path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||(await realpath(this.path)).toLowerCase()!==this.path.toLowerCase())throw new Error('文件路径已变化或不是独立的普通文件');if(info.size>MAX_SOURCE_BYTES)throw new Error('文本文件超过 10 MB')}
  async read(){await this.verify();const buffer=await readFile(this.path);if(buffer.length>MAX_SOURCE_BYTES)throw new Error('文本文件超过 10 MB');return {...decodeSource(buffer),hash:sourceHash(buffer),name:basename(this.path)}}
  async save(text:string,expectedHash:string){
    const current=await this.read();if(current.hash!==expectedHash)throw new Error('文件已更改，请重新载入或另存副本；未覆盖任何内容')
    const bytes=encodeSource(text,current.encoding),temporary=join(dirname(this.path),`.muxivra-source-${randomUUID()}.tmp`)
    try{const handle=await open(temporary,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync()}finally{await handle.close()}
      const check=async()=>{await this.verify();if(sourceHash(await readFile(this.path))!==expectedHash)throw new Error('保存期间文件已更改，未覆盖原文件')}
      await check();await atomicRename(temporary,this.path,check)
    }finally{await unlink(temporary).catch(()=>{})}
    return this.read()
  }
}
/** Keep project identity and stable cue IDs when parsing the editable ASS source. */
export function parseProjectSource(text:string,current:SubtitleDocument):SubtitleDocument{
  const parsed=parseAss(text,'ass'),used=new Set<string>()
  const key=(cue:SubtitleDocument['cues'][number])=>JSON.stringify([cue.startMs,cue.endMs,cue.text]),matches=new Map<string,{items:SubtitleDocument['cues'];offset:number}>()
  for(const cue of current.cues){const signature=key(cue),queue=matches.get(signature)??{items:[],offset:0};queue.items.push(cue);matches.set(signature,queue)}
  const cues=parsed.cues.map((cue,index)=>{const queue=matches.get(key(cue));while(queue&&queue.offset<queue.items.length&&used.has(queue.items[queue.offset].id))queue.offset++;const exact=queue?.items[queue.offset++],old=exact??current.cues[index];if(old&&!used.has(old.id)){used.add(old.id);return {...cue,id:old.id}}return cue})
  return normalizeSubtitleDocument({...parsed,id:current.id,projectPath:current.projectPath,mediaPath:current.mediaPath,sourcePath:current.sourcePath,exportFormat:current.exportFormat,cues})
}
