import { createHash,randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir,readFile,writeFile } from 'node:fs/promises'
import { dirname,join } from 'node:path'
import { Readable,Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import type { OfficialAsrAsset } from '../../shared/asr-catalog'
import { requireSpace,ownedCleanup,type StorageProgress } from './storage'
import { fetchDownload,explainDownloadError,canUseDownloadFallback } from '../download-network'
import modelscopeManifests from './modelscope-manifests.json'
import { atomicRename } from '../storage/atomic'
const entrySchema=z.object({rfilename:z.string().min(1).max(1024),size:z.number().int().nonnegative().max(40*1024**3),blobId:z.string().regex(/^[a-f0-9]{40}$/),lfs:z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().nonnegative()}).optional()})
const manifestSchema=z.object({sha:z.string().regex(/^[a-f0-9]{40}$/),siblings:z.array(entrySchema).max(2000)})
type OfficialFile=z.infer<typeof entrySchema>&{modelscopeRevision?:string}
function alternateManifest(asset:OfficialAsrAsset){
  const value=modelscopeManifests[asset.id as keyof typeof modelscopeManifests]
  return value?.repo===asset.repo&&value.revision===asset.revision?value:undefined
}
export function modelscopeFileUrl(asset:OfficialAsrAsset,file:OfficialFile){
  const alternate=alternateManifest(asset)?.files.find(value=>value.rfilename===file.rfilename)
  if(!alternate||alternate.size!==file.size||alternate.blobId!==file.blobId||('lfs' in alternate?alternate.lfs?.sha256:undefined)!==file.lfs?.sha256)return undefined
  return `https://modelscope.cn/models/${asset.repo}/resolve/${alternate.modelscopeRevision}/${file.rfilename.split('/').map(encodeURIComponent).join('/')}`
}
export function modelFileName(name:string){return !name.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.')||/[\\<>:"|?*\x00-\x1f]/.test(part)||/[. ]$/.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))&&(/\.(json|safetensors|bin|model|txt|tiktoken|jinja)$/i.test(name)||/^(LICENSE|NOTICE)(\..*)?$/i.test(name))}
export async function officialManifest(asset:OfficialAsrAsset,signal:AbortSignal){
  const url=`https://huggingface.co/api/models/${asset.repo}/revision/${asset.revision}?blobs=true`
  let text:string
  try{const response=await fetchDownload(url,{signal,label:'官方模型清单',timeoutMs:45000});text=await response.text().catch(error=>{throw explainDownloadError(error,url,'官方模型清单')})}catch(error){
    signal.throwIfAborted();const alternate=alternateManifest(asset)
    if(!alternate||!canUseDownloadFallback(error))throw error
    // Bundled at build time and cross-checked byte-for-byte with the pinned HF
    // revision. Never depend on mutable "master" or a third-party mirror.
    return {files:alternate.files as OfficialFile[],total:alternate.files.reduce((sum,file)=>sum+file.size,0),source:'modelscope' as const,reason:(error as Error).message}
  }
  if(Buffer.byteLength(text)>4*1024**2)throw new Error('官方模型清单过大')
  const manifest=manifestSchema.parse(JSON.parse(text));if(manifest.sha!==asset.revision)throw new Error('官方模型版本与固定清单不一致')
  const files=manifest.siblings.filter(file=>modelFileName(file.rfilename));if(!files.some(f=>f.rfilename==='config.json')||!files.some(f=>/\.(safetensors|bin)$/.test(f.rfilename)))throw new Error('官方模型清单缺少配置或权重')
  const total=files.reduce((sum,file)=>sum+file.size,0);if(total>80*1024**3)throw new Error('模型文件总大小超过限制')
  for(const file of files)if(file.lfs&&file.lfs.size!==file.size)throw new Error('官方权重大小不一致')
  return {files:files as OfficialFile[],total,source:'huggingface' as const,reason:undefined}
}
export async function downloadOfficialModel(asset:OfficialAsrAsset,root:string,signal:AbortSignal,set:StorageProgress){
  set({active:true,phase:'preparing',label:asset.name,received:0,total:0,percent:0,message:'正在读取官方模型清单'})
  const {files,total,source,reason}=await officialManifest(asset,signal);await requireSpace(root,total)
  const staging=join(root,`.transfer-${randomUUID()}`),target=join(root,'models',`${asset.id}-${asset.revision.slice(0,8)}-${randomUUID().slice(0,8)}`);await mkdir(staging,{recursive:true});let received=0,last=0
  set({phase:'downloading',total,message:source==='modelscope'?'Hugging Face 连接失败，转至 Qwen 官方 ModelScope（校验固定版本）':'正在连接 Hugging Face 官方仓库'})
  try{
    const sources:{file:string;source:'huggingface'|'modelscope'}[]=[]
    for(const file of files){signal.throwIfAborted();const output=join(staging,...file.rfilename.split('/'));await mkdir(dirname(output),{recursive:true})
      const primary=`https://huggingface.co/${asset.repo}/resolve/${asset.revision}/${file.rfilename.split('/').map(encodeURIComponent).join('/')}`,alternate=modelscopeFileUrl(asset,file)
      let url=source==='modelscope'?alternate!:primary,response:Response
      try{response=await fetchDownload(url,{signal,label:`下载 ${file.rfilename}`,onRetry:message=>set({message})})}catch(error){
        signal.throwIfAborted();if(source==='modelscope'||!alternate||!canUseDownloadFallback(error))throw error
        set({message:`${file.rfilename} 连接失败，转至 Qwen 官方 ModelScope`});url=alternate
        response=await fetchDownload(url,{signal,label:`下载 ${file.rfilename}（Qwen 官方 ModelScope）`,onRetry:message=>set({message})})
      }
      if(!response.body)throw new Error(`下载 ${file.rfilename} 没有返回文件内容`)
      const hash=createHash(file.lfs?'sha256':'sha1');if(!file.lfs)hash.update(`blob ${file.size}\0`);let size=0
      const meter=new Transform({transform(chunk:Buffer,_encoding,done){size+=chunk.length;received+=chunk.length;if(size>file.size){done(new Error('下载文件超过官方清单大小'));return}hash.update(chunk);if(Date.now()-last>150){last=Date.now();set({phase:'downloading',received,percent:Math.min(99,received/total*100),message:`正在下载 ${file.rfilename}`})}done(null,chunk)}})
      try{await pipeline(Readable.fromWeb(response.body as never),meter,createWriteStream(output,{flags:'wx'}),{signal})}catch(error){throw explainDownloadError(error,url,`下载 ${file.rfilename}`)}set({phase:'verifying',message:`校验 ${file.rfilename}`})
      if(size!==file.size||hash.digest('hex')!==(file.lfs?.sha256??file.blobId))throw new Error(`官方文件校验失败：${file.rfilename}`)
      sources.push({file:file.rfilename,source:url===primary?'huggingface':'modelscope'})
    }
    const index=files.find(f=>f.rfilename==='model.safetensors.index.json');if(index){const data=JSON.parse(await readFile(join(staging,index.rfilename),'utf8'));for(const name of Object.values(data.weight_map??{}))if(typeof name!=='string'||!files.some(f=>f.rfilename===name))throw new Error('官方模型缺少分片权重')}
    await writeFile(join(staging,'muxivra-download-source.json'),JSON.stringify({repo:asset.repo,revision:asset.revision,source,files:sources,reason,checkedAt:new Date().toISOString()},null,2))
    signal.throwIfAborted();await mkdir(dirname(target),{recursive:true});await atomicRename(staging,target,async()=>signal.throwIfAborted());return {path:target,bytes:total}
  }finally{await ownedCleanup(root,staging)}
}
