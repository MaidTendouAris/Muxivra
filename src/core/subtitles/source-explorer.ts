import {lstat,opendir,realpath} from 'node:fs/promises'
import {extname,join,win32} from 'node:path'
import type {SourceProjectFile} from '../../shared/source-editor'
import {isWithin,localPath} from '../media/paths'
import {isSourceTextPath,MAX_SOURCE_BYTES} from './source-file'

export const SOURCE_EXPLORER_LIMIT=500
const samePath=(left:string,right:string)=>process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right
const subtitles=new Set(['.ass','.ssa','.srt','.vtt'])
const names=new Intl.Collator('en',{numeric:true,sensitivity:'base'})

/** Only the main process chooses root; the renderer may identify a relative child. */
function parts(value:string,allowRoot:boolean):string[]{
  if(typeof value!=='string'||value.length>32760||win32.isAbsolute(value)||value.includes('\\'))throw new Error('项目资源路径无效')
  if(value===''&&allowRoot)return []
  const result=value.split('/')
  if(result.some(part=>!part||part==='.'||part==='..'||/[<>:"|?*\x00-\x1f]/.test(part)||/[. ]$/.test(part)))throw new Error('项目资源路径无效')
  return result
}

async function projectRoot(root:string):Promise<string>{
  const path=localPath(root),info=await lstat(path),canonical=await realpath(path)
  if(!info.isDirectory()||info.isSymbolicLink()||!samePath(canonical,path))throw new Error('项目资源目录已变化，已停止访问')
  return canonical
}

async function childDirectory(root:string,segments:string[]):Promise<string>{
  let current=root
  for(const segment of segments){
    const target=join(current,segment),info=await lstat(target),canonical=await realpath(target)
    if(!info.isDirectory()||info.isSymbolicLink()||!isWithin(root,canonical)||!samePath(target,canonical))throw new Error('项目资源目录已变化，已停止访问')
    current=canonical
  }
  return current
}

/** Resolve an existing ordinary file, refusing traversal and linked ancestors. */
export async function resolveSourceProjectPath(root:string,relativePath:string):Promise<string>{
  const segments=parts(relativePath,false),canonicalRoot=await projectRoot(root),directory=await childDirectory(canonicalRoot,segments.slice(0,-1)),target=join(directory,segments.at(-1)!)
  const info=await lstat(target),canonical=await realpath(target)
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||!isWithin(canonicalRoot,canonical)||!samePath(target,canonical))throw new Error('项目资源必须是未链接的普通文件')
  return canonical
}

/** A single bounded directory listing; expanding a folder requests its children. */
export async function listSourceProjectFiles(root:string,directory=''):Promise<{directory:string;entries:SourceProjectFile[];truncated:boolean}>{
  const segments=parts(directory,true),canonicalRoot=await projectRoot(root),current=await childDirectory(canonicalRoot,segments),entries:SourceProjectFile[]=[]
  let scanned=0,truncated=false
  const handle=await opendir(current)
  for await(const entry of handle){
    if(scanned++===SOURCE_EXPLORER_LIMIT){truncated=true;break}
    if(/^\.muxivra-source-/i.test(entry.name)||/\.tmp$/i.test(entry.name))continue
    const target=join(current,entry.name)
    try{
      const info=await lstat(target)
      if(info.isSymbolicLink()||!info.isDirectory()&&!info.isFile())continue
      const canonical=await realpath(target)
      if(!isWithin(canonicalRoot,canonical)||!samePath(target,canonical))continue
      const type=info.isDirectory()?'directory':'file',path=[...segments,entry.name].join('/')
      entries.push({name:entry.name,path,type,text:type==='file'&&isSourceTextPath(entry.name)&&info.size<=MAX_SOURCE_BYTES&&info.nlink===1,subtitle:type==='file'&&subtitles.has(extname(entry.name).toLowerCase())})
    }catch(error){
      // Concurrent deletion or an inaccessible entry must not hide the rest of
      // an otherwise valid folder. The selected file is checked again on open.
      if(!['ENOENT','EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code??''))throw error
    }
  }
  entries.sort((left,right)=>left.type===right.type?names.compare(left.name,right.name)||left.name.localeCompare(right.name):left.type==='directory'?-1:1)
  return {directory:segments.join('/'),entries,truncated}
}
