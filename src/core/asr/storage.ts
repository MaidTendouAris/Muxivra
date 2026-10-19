import { createHash,randomUUID } from 'node:crypto'
import { createReadStream,createWriteStream,constants } from 'node:fs'
import { access,lstat,mkdir,readdir,realpath,rename,rm,stat,statfs } from 'node:fs/promises'
import { basename,dirname,join,resolve } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isWithin,localPath } from '../media/paths'
import type { AsrDownload } from '../../shared/asr'
export type StorageProgress=(update:Partial<AsrDownload>)=>void
export async function writableStorage(root:string){
  try{await mkdir(root,{recursive:true});const canonical=await realpath(root);if(canonical.toLowerCase()!==resolve(root).toLowerCase())throw new Error('存储目录包含重定向或符号链接');await access(canonical,constants.W_OK)}
  catch(error){throw new Error(`安装目录下的 ASR 存储不可写：${root}。请使用可写的安装位置。${(error as Error).message}`)}
}
export async function requireSpace(root:string,bytes:number){await writableStorage(root);const disk=await statfs(root,{bigint:true});if(disk.bavail*disk.bsize<BigInt(bytes)+256n*1024n*1024n)throw new Error('安装目录所在磁盘空间不足，请至少预留资源大小加 256 MB')}
export async function hashFile(path:string,algorithm:'sha256'|'sha1'='sha256',gitBlobSize?:number,signal?:AbortSignal){const hash=createHash(algorithm);if(gitBlobSize!==undefined)hash.update(`blob ${gitBlobSize}\0`);for await(const chunk of createReadStream(path)){signal?.throwIfAborted();hash.update(chunk)}return hash.digest('hex')}
export async function ownedCleanup(root:string,path:string){if(!isWithin(root,path)||!basename(path).startsWith('.transfer-'))throw new Error('拒绝清理非 ASR 临时目录');await rm(path,{recursive:true,force:true})}
export async function collectFiles(path:string,files:{path:string;relative:string;size:number;mtimeMs:number}[]=[],relative='',depth=0,excludedRoot?:string){
  if(excludedRoot&&isWithin(excludedRoot,path))return files
  if(depth>30||files.length>20000)throw new Error('模型目录层级或文件数量过多')
  const info=await lstat(path);if(info.isSymbolicLink())throw new Error('模型导入不支持符号链接，请选择完整本地副本')
  if(info.isFile()){files.push({path,relative:relative||basename(path),size:info.size,mtimeMs:info.mtimeMs});return files}
  if(!info.isDirectory())throw new Error('模型包含非普通文件')
  for(const entry of await readdir(path,{withFileTypes:true})){if(['.git','.cache','__pycache__'].includes(entry.name))continue;await collectFiles(join(path,entry.name),files,join(relative,entry.name),depth+1,excludedRoot)}return files
}
export async function copyModel(source:string,root:string,label:string,signal:AbortSignal,set:StorageProgress):Promise<{path:string;bytes:number}> {
  const input=await realpath(localPath(source));await writableStorage(root)
  if(isWithin(root,input))return {path:input,bytes:(await collectFiles(input)).reduce((sum,file)=>sum+file.size,0)}
  const files=await collectFiles(input,[],'',0,root),bytes=files.reduce((sum,file)=>sum+file.size,0);await requireSpace(root,bytes)
  const directory=(await stat(input)).isDirectory(),staging=join(root,`.transfer-${randomUUID()}`),target=join(root,'models',`${basename(input).replace(/[^\p{L}\p{N}._-]/gu,'_').slice(0,100)||'model'}-${randomUUID().slice(0,8)}`)
  await mkdir(staging,{recursive:true});let received=0,last=0
  set({active:true,phase:'copying',label,received:0,total:bytes,percent:0,message:'正在将模型转存至安装目录'})
  try{
    for(const file of files){signal.throwIfAborted();const output=join(staging,file.relative);await mkdir(dirname(output),{recursive:true});const hash=createHash('sha256')
      const meter=new Transform({transform(chunk:Buffer,_encoding,done){received+=chunk.length;hash.update(chunk);if(Date.now()-last>150){last=Date.now();set({received,percent:bytes?Math.min(99,received/bytes*100):0,message:`正在复制 ${file.relative}`})}done(null,chunk)}})
      await pipeline(createReadStream(file.path),meter,createWriteStream(output,{flags:'wx'}),{signal});const after=await stat(file.path)
      set({phase:'verifying',message:`校验 ${file.relative}`});if(after.size!==file.size||after.mtimeMs!==file.mtimeMs||await hashFile(output,'sha256',undefined,signal)!==hash.digest('hex'))throw new Error(`模型复制校验失败：${file.relative}，源文件可能正在修改`)
      set({phase:'copying'})
    }
    signal.throwIfAborted();await mkdir(dirname(target),{recursive:true});await rename(staging,target);return {path:directory?target:join(target,basename(input)),bytes}
  }finally{await ownedCleanup(root,staging)}
}
export function asrProcessEnvironment(root?:string):NodeJS.ProcessEnv {return {...process.env,PYTHONDONTWRITEBYTECODE:'1',...(root?{HF_HOME:join(root,'cache','huggingface'),HF_HUB_CACHE:join(root,'cache','huggingface','hub'),HUGGINGFACE_HUB_CACHE:join(root,'cache','huggingface','hub'),TRANSFORMERS_CACHE:join(root,'cache','huggingface','hub'),HF_ASSETS_CACHE:join(root,'cache','huggingface','assets'),TORCH_HOME:join(root,'cache','torch'),TORCH_EXTENSIONS_DIR:join(root,'cache','torch-extensions'),TORCHINDUCTOR_CACHE_DIR:join(root,'cache','torchinductor'),CUDA_CACHE_PATH:join(root,'cache','cuda'),PIP_CACHE_DIR:join(root,'cache','pip'),XDG_CACHE_HOME:join(root,'cache'),TRITON_CACHE_DIR:join(root,'cache','triton'),HF_DATASETS_CACHE:join(root,'cache','datasets'),NUMBA_CACHE_DIR:join(root,'cache','numba'),MPLCONFIGDIR:join(root,'cache','matplotlib'),GRADIO_TEMP_DIR:join(root,'temp','gradio'),TEMP:join(root,'temp'),TMP:join(root,'temp')}:{}),PYTHONIOENCODING:'utf-8'}}
