import { randomUUID } from 'node:crypto'
import { createReadStream,createWriteStream } from 'node:fs'
import { copyFile,link,lstat,mkdir,readFile,readdir,realpath,rename,rm,stat,writeFile } from 'node:fs/promises'
import { basename,dirname,isAbsolute,join,relative,resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { setTimeout as delay } from 'node:timers/promises'
import { pipeline } from 'node:stream/promises'
import { isWithin,exists,localPath } from '../media/paths'
import { extractZip } from '../engine'
import { collectFiles,hashFile,requireSpace,writableStorage } from './storage'
import { deploymentArchive,deploymentCommand,deploymentManifest,prepareDeploymentTool,verifyNvidiaEnvironment,type DeploymentContext,type PreparedEnvironment } from './deployment'
import { asrResourceSchema,type AsrResource } from '../../shared/asr-deployment'
import type { PythonAsrBackend } from '../../shared/asr-parameters'

const manifestName='muxivra-resource.json'
const resourceFileSchema=z.object({path:z.string().min(1).max(4096),bytes:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
export const resourceManifestSchema=z.object({format:z.literal('muxivra-asr-resource'),version:z.literal(1),kind:z.enum(['python','dependencies']),backend:z.enum(['qwen3-asr','moss-transcribe-diarize']).optional(),profile:z.enum(['cu126','cu128']).optional(),python:z.string().optional(),uv:z.string().optional(),requirements:z.array(z.string().regex(/^[A-Za-z0-9_.-]+==[A-Za-z0-9_.+!-]+$/)).max(2000).optional(),versions:z.record(z.string(),z.string()),files:z.array(resourceFileSchema).min(1).max(30000)}).strict()
export type ResourceManifest=z.infer<typeof resourceManifestSchema>
const tooling=['pip==25.3','setuptools==80.9.0','wheel==0.45.1']

function safeMember(root:string,path:string){
  if(isAbsolute(path)||path.includes(':')||path.split(/[\\/]/).some(value=>!value||value==='.'||value==='..'))throw new Error('资源清单包含无效相对路径')
  const result=resolve(root,path);if(!isWithin(root,result)||result===resolve(root))throw new Error('资源文件超出资源包目录');return result
}
async function ordinaryFile(root:string,path:string){const value=safeMember(root,path),info=await lstat(value),actual=await realpath(value);if(!info.isFile()||info.isSymbolicLink()||actual.toLowerCase()!==resolve(value).toLowerCase()||!isWithin(await realpath(root),actual))throw new Error('资源包包含重定向或非普通文件');return value}
export async function readResourceManifest(directory:string,signal?:AbortSignal,verify=true):Promise<ResourceManifest>{
  const file=join(directory,manifestName);if((await stat(file)).size>8*1024**2)throw new Error('资源清单超过 8 MB')
  const manifest=resourceManifestSchema.parse(JSON.parse(await readFile(file,'utf8'))),seen=new Set<string>()
  for(const member of manifest.files){signal?.throwIfAborted();const name=member.path.toLowerCase();if(seen.has(name))throw new Error('资源清单含重复文件');seen.add(name);const path=await ordinaryFile(directory,member.path);if((await stat(path)).size!==member.bytes||verify&&await hashFile(path,'sha256',undefined,signal)!==member.sha256)throw new Error('资源校验失败：'+member.path)}
  for(const executable of [manifest.python,manifest.uv].filter((value):value is string=>!!value))if(!seen.has(executable.toLowerCase()))throw new Error('运行文件未包含于资源校验清单')
  if(manifest.kind==='python'&&(!manifest.python||!manifest.uv||manifest.versions.python?.split('.').slice(0,2).join('.')!=='3.12'))throw new Error('Python 资源包必须包含 Python 3.12 与 uv 安装工具')
  if(manifest.kind==='dependencies'&&(!manifest.backend||!manifest.profile||!manifest.requirements?.length||manifest.files.some(value=>!value.path.toLowerCase().endsWith('.whl'))))throw new Error('依赖资源包必须包含后端、CUDA 配置和离线 wheel 文件')
  return manifest
}
async function describe(directory:string,source:AsrResource['source'],manifest:ResourceManifest):Promise<AsrResource>{return asrResourceSchema.parse({id:randomUUID(),kind:manifest.kind,name:manifest.kind==='python'?`Python ${manifest.versions.python} · uv ${manifest.versions.uv}`:`${manifest.backend} · ${manifest.profile} · 离线依赖`,path:directory,backend:manifest.backend,profile:manifest.profile,versions:manifest.versions,bytes:manifest.files.reduce((sum,file)=>sum+file.bytes,0),createdAt:new Date().toISOString(),source,ready:true})}
async function publish(stage:string,context:DeploymentContext,manifest:ResourceManifest,source:AsrResource['source']){
  context.signal.throwIfAborted();await writeFile(join(stage,manifestName),JSON.stringify(resourceManifestSchema.parse(manifest),null,2));const target=join(context.root,'components',`${manifest.kind}-${manifest.backend??'shared'}-${manifest.profile??'win-x64'}-${randomUUID().slice(0,8)}`);await mkdir(dirname(target),{recursive:true})
  // Windows scanners can briefly hold newly hashed/hardlinked DLL or wheel
  // files. Keep publication atomic while allowing that transient handle to close.
  for(let attempt=0;;attempt++){context.signal.throwIfAborted();try{await rename(stage,target);break}catch(error){if(attempt>=8||!['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code??''))throw error;await delay(150,undefined,{signal:context.signal})}}
  return describe(target,source,manifest)
}
async function manifestFiles(directory:string,signal:AbortSignal){const files=await collectFiles(directory);const output:ResourceManifest['files']=[];for(const file of files){signal.throwIfAborted();output.push({path:file.relative.replaceAll('\\','/'),bytes:file.size,sha256:await hashFile(file.path,'sha256',undefined,signal)})}return output}
async function cleanup(root:string,path:string){if(!isWithin(root,path)||!basename(path).startsWith('.transfer-')&&!(isWithin(join(root,'environments'),path)&&basename(path).startsWith('managed-')))throw new Error('拒绝清理非受管目录');if(await exists(path)){const actual=await realpath(path);if(actual.toLowerCase()!==resolve(path).toLowerCase()||!isWithin(root,actual))throw new Error('资源清理目录已变化');await rm(actual,{recursive:true,force:true,maxRetries:8,retryDelay:300})}}
async function findPython(directory:string,depth=0):Promise<string>{if(depth>3)throw new Error('资源目录中没有 Python');if(await exists(join(directory,'python.exe')))return join(directory,'python.exe');for(const entry of await readdir(directory,{withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink()){try{return await findPython(join(directory,entry.name),depth+1)}catch{}}throw new Error('资源目录中没有 Python')}

/** Downloads a portable interpreter/tool bundle; it never installs a model environment. */
export async function downloadPythonResource(context:DeploymentContext):Promise<AsrResource>{
  await requireSpace(context.root,1024**3);const uv=await prepareDeploymentTool(context),stage=join(context.root,`.transfer-${randomUUID()}`);await mkdir(stage,{recursive:true})
  try{
    context.update({phase:'runtime',message:'下载独立 Python 3.12；文件保存在安装目录'})
    await deploymentCommand(uv,['--no-config','--no-progress','python','install',deploymentManifest.python,'--no-bin','--install-dir',join(stage,'python')],context)
    const python=await findPython(join(stage,'python')),version=await deploymentCommand(python,['-I','-c','import sys,struct; assert struct.calcsize("P")==8; print(sys.version.split()[0])'],context,30000)
    if(!version.startsWith('3.12.'))throw new Error('受管解释器版本不正确')
    await copyFile(uv,join(stage,'uv.exe'));const manifest:ResourceManifest={format:'muxivra-asr-resource',version:1,kind:'python',python:relative(stage,python).replaceAll('\\','/'),uv:'uv.exe',versions:{python:version,uv:'0.13.1'},files:await manifestFiles(stage,context.signal)}
    return await publish(stage,context,manifest,'download')
  }finally{await cleanup(context.root,stage)}
}
export async function importPreparedResource(input:string,kind:'python'|'dependencies',context:DeploymentContext,backend?:PythonAsrBackend):Promise<AsrResource>{
  const source=await realpath(localPath(input)),manifest=await readResourceManifest(source,context.signal)
  if(manifest.kind!==kind||kind==='dependencies'&&(manifest.backend!==backend||manifest.profile!==context.profile))throw new Error('所选资源包与目标类型、模型后端或 CUDA 配置不匹配')
  const bytes=manifest.files.reduce((sum,file)=>sum+file.bytes,0);await requireSpace(context.root,bytes);const stage=join(context.root,`.transfer-${randomUUID()}`);await mkdir(stage,{recursive:true})
  try{
    for(const member of manifest.files){context.signal.throwIfAborted();context.update({phase:'runtime',message:'导入资源：'+member.path});const target=safeMember(stage,member.path);await mkdir(dirname(target),{recursive:true});await pipeline(createReadStream(await ordinaryFile(source,member.path)),createWriteStream(target,{flags:'wx'}),{signal:context.signal});if(await hashFile(target,'sha256',undefined,context.signal)!==member.sha256)throw new Error('资源复制校验失败：'+member.path)}
    if(kind==='python'){
      manifest.versions.python=await deploymentCommand(safeMember(stage,manifest.python!),['-I','-c','import sys,struct; assert sys.version_info[:2]==(3,12) and struct.calcsize("P")==8; print(sys.version.split()[0])'],{...context,offline:true},30000)
      const tool=await deploymentCommand(safeMember(stage,manifest.uv!),['--version'],{...context,offline:true},30000),version=/^uv\s+(\S+)/.exec(tool)?.[1];if(!version)throw new Error('资源包内的 uv 工具校验失败');manifest.versions.uv=version
    }
    return await publish(stage,context,manifest,'import')
  }finally{await cleanup(context.root,stage)}
}
function pythonResource(resources:AsrResource[]){const value=[...resources].reverse().find(resource=>resource.kind==='python'&&resource.ready);if(!value)throw new Error('请先在环境页下载或导入 Python 资源');return value}
export async function discoverPreparedResource(path:string){return describe(path,'import',await readResourceManifest(path,undefined,false))}
export async function downloadedResourceStatus(resource:AsrResource):Promise<AsrResource>{try{await readResourceManifest(resource.path,undefined,false);return {...resource,ready:true,issue:undefined}}catch(error){return {...resource,ready:false,issue:(error as Error).message}}}
async function shareWheel(path:string,context:DeploymentContext){
  const hash=await hashFile(path,'sha256',undefined,context.signal),target=join(context.root,'packages','wheels',hash,basename(path));await mkdir(dirname(target),{recursive:true})
  if((await realpath(dirname(target))).toLowerCase()!==resolve(dirname(target)).toLowerCase())throw new Error('共享 wheel 缓存目录包含重定向')
  if(await exists(target)){
    if((await realpath(target)).toLowerCase()!==resolve(target).toLowerCase())throw new Error('共享 wheel 缓存文件包含重定向')
    const sourceInfo=await stat(path),targetInfo=await stat(target)
    if(sourceInfo.dev===targetInfo.dev&&sourceInfo.ino===targetInfo.ino)return {path:'wheels/'+basename(path),sha256:hash,bytes:sourceInfo.size}
  }
  if(await exists(target)&&await hashFile(target,'sha256',undefined,context.signal)!==hash){const actual=await realpath(target);if(actual.toLowerCase()!==resolve(target).toLowerCase()||!isWithin(join(context.root,'packages','wheels'),actual))throw new Error('共享 wheel 缓存路径不属于应用');await rm(actual,{force:true})}
  if(!await exists(target)){
    const partial=target+'.'+randomUUID()+'.part'
    try{await pipeline(createReadStream(path),createWriteStream(partial,{flags:'wx'}),{signal:context.signal});context.signal.throwIfAborted();await rename(partial,target)}finally{await rm(partial,{force:true})}
  }
  await rm(path);try{await link(target,path)}catch{await copyFile(target,path)}
  return {path:'wheels/'+basename(path),sha256:hash,bytes:(await stat(target)).size}
}
async function wheelIndex(files:ResourceManifest['files'],path:string,context:DeploymentContext){
  // A local HTML index points at immutable, content-addressed wheel URLs.
  // uv then reuses the same expanded cache across bundles and environments;
  // pointing it at staging or per-model directories would duplicate CUDA DLLs.
  const links=files.map(file=>`<a href="${pathToFileURL(join(context.root,'packages','wheels',file.sha256,basename(file.path))).href.replaceAll('&','&amp;')}">${basename(file.path)}</a>`)
  const index=join(context.root,'packages','wheels.html'),html='<!doctype html><html><body>'+links.join('\n')+'</body></html>'
  if(await exists(index)&&((await realpath(index)).toLowerCase()!==resolve(index).toLowerCase()))throw new Error('离线索引文件包含重定向')
  // uv's cache namespace also includes the index URL. Keep that URL stable,
  // while each isolated environment retains an audit copy of its exact index.
  await writeFile(index,html);if(path!==index)await writeFile(path,html);return index
}
function hashedRequirements(manifest:ResourceManifest){
  const normalize=(name:string)=>name.toLowerCase().replace(/[_.-]+/g,'-')
  return manifest.requirements!.map(requirement=>{const [name,version]=requirement.split('=='),matches=manifest.files.filter(file=>{const [wheelName,wheelVersion]=basename(file.path).split('-');return normalize(wheelName)===normalize(name)&&wheelVersion.toLowerCase()===version.toLowerCase()});if(!matches.length)throw new Error('离线依赖缺少锁定 wheel：'+requirement);return requirement+matches.map(file=>' --hash=sha256:'+file.sha256).join('')}).join('\n')+'\n'
}
export function dependencyRequirements(backend:PythonAsrBackend,profile:'cu126'|'cu128'){
  return [...tooling,`torch==${deploymentManifest.torch}+${profile}`,`torchaudio==${deploymentManifest.torch}+${profile}`,...(backend==='qwen3-asr'?['qwen-asr==0.0.6','transformers==4.57.6','accelerate==1.12.0']:['transformers==5.19.0','accelerate==1.15.0']),'bitsandbytes==0.50.2','optimum-quanto==0.2.7']
}
/** Builds a complete wheelhouse explicitly. The subsequent configure operation is offline. */
export async function downloadDependencyResource(backend:PythonAsrBackend,resources:AsrResource[],context:DeploymentContext):Promise<AsrResource>{
  const base=pythonResource(resources),baseManifest=await readResourceManifest(base.path,context.signal),uv=safeMember(base.path,baseManifest.uv!),python=safeMember(base.path,baseManifest.python!)
  await requireSpace(context.root,14*1024**3);const stage=join(context.root,`.transfer-${randomUUID()}`),build=join(context.root,`.transfer-${randomUUID()}`);await mkdir(join(stage,'wheels'),{recursive:true});await mkdir(build,{recursive:true})
  try{
    context.update({phase:'dependencies',message:'准备离线依赖下载工具；不配置识别环境'})
    await deploymentCommand(uv,['--no-config','--no-progress','venv','--python',python,'--no-python-downloads',join(build,'builder')],context)
    const builder=join(build,'builder','Scripts','python.exe'),wheels=join(stage,'wheels'),constraints=join(build,'constraints.txt'),cuda=deploymentManifest.torch+'+'+context.profile
    await writeFile(constraints,`torch==${cuda}\ntorchaudio==${cuda}\n`)
    await deploymentCommand(uv,['--no-config','--no-progress','pip','install','--python',builder,'--default-index','https://pypi.org/simple',...tooling],context)
    context.update({phase:'dependencies',message:'下载 PyTorch 与所需 CUDA 运行库（不需要系统 CUDA Toolkit）'})
    await deploymentCommand(builder,['-I','-m','pip','wheel','--disable-pip-version-check','--wheel-dir',wheels,'--index-url','https://download.pytorch.org/whl/'+context.profile,'torch=='+cuda,'torchaudio=='+cuda],context)
    const requirements=dependencyRequirements(backend,context.profile)
    if(backend==='moss-transcribe-diarize'){
      const archive=join(context.root,'cache','downloads','moss-'+deploymentManifest.moss.sha256+'.zip'),source=join(build,'source');await deploymentArchive(deploymentManifest.moss,archive,context);await extractZip(archive,source,32*1024**2);const entries=await readdir(source);if(entries.length!==1)throw new Error('MOSS 官方源码目录结构不正确')
      context.update({phase:'dependencies',message:'将固定版本 MOSS 官方源码打包为离线 wheel'})
      await deploymentCommand(builder,['-I','-m','pip','wheel','--disable-pip-version-check','--no-deps','--no-build-isolation','--wheel-dir',wheels,join(source,entries[0])],context)
      const wheel=(await readdir(wheels)).find(value=>/^moss[_-].*\.whl$/i.test(value));if(!wheel)throw new Error('MOSS 官方源码未生成模型后端 wheel');const [name,version]=wheel.split('-');requirements.push(name+'=='+version)
    }
    context.update({phase:'dependencies',message:'下载并构建目标模型全部依赖 wheel；完成后可断网配置'})
    await deploymentCommand(builder,['-I','-m','pip','wheel','--disable-pip-version-check','--prefer-binary','--wheel-dir',wheels,'--find-links',wheels,'--index-url','https://pypi.org/simple','--constraint',constraints,...requirements],context)
    const files:ResourceManifest['files']=[]
    for(const name of await readdir(wheels)){if(!name.endsWith('.whl'))throw new Error('离线依赖目录出现非 wheel 文件');context.update({phase:'verifying',message:'校验并共享依赖文件：'+name});files.push(await shareWheel(join(wheels,name),context))}
    const index=await wheelIndex(files,join(build,'wheels.html'),context),offline={...context,offline:true};context.update({phase:'verifying',message:'离线检查依赖包是否完整'})
    await deploymentCommand(uv,['--offline','--no-config','--no-progress','pip','install','--python',builder,'--no-index','--find-links',index,...requirements],offline)
    await deploymentCommand(uv,['--offline','--no-config','pip','check','--python',builder],offline,120000)
    const versions=JSON.parse(await deploymentCommand(builder,['-I','-c','import importlib.metadata,json,torch; print(json.dumps({**{d.metadata["Name"].lower().replace("_","-"):d.version for d in importlib.metadata.distributions()},"cuda":str(torch.version.cuda) if torch.version.cuda else "CPU"}))'],offline,120000)) as Record<string,string>
    const locked=Object.entries(versions).filter(([name])=>name!=='cuda').map(([name,version])=>`${name}==${version}`)
    const manifest:ResourceManifest={format:'muxivra-asr-resource',version:1,kind:'dependencies',backend,profile:context.profile,versions:{...versions,python:baseManifest.versions.python},requirements:locked,files}
    return await publish(stage,context,manifest,'download')
  }finally{await cleanup(context.root,stage);await cleanup(context.root,build)}
}
export async function prepareOfflineNvidiaPython(backend:PythonAsrBackend,adapterPath:string,resources:AsrResource[],context:DeploymentContext):Promise<PreparedEnvironment>{
  const base=pythonResource(resources),dependencies=[...resources].reverse().find(resource=>resource.kind==='dependencies'&&resource.backend===backend&&resource.profile===context.profile&&resource.ready)
  if(!dependencies)throw new Error(`请先在环境页下载或导入 ${backend} / ${context.profile} 依赖资源`)
  context.update({phase:'verifying',message:'校验本地 Python 与依赖资源；配置过程不会联网'})
  const pythonManifest=await readResourceManifest(base.path,context.signal),manifest=await readResourceManifest(dependencies.path,context.signal),python=safeMember(base.path,pythonManifest.python!),uv=safeMember(base.path,pythonManifest.uv!),directory=join(context.root,'environments',`managed-${backend}-${context.profile}-${randomUUID()}`),offline={...context,offline:true}
  // A freshly imported wheelhouse has no extracted uv cache yet. CUDA DLLs
  // expand substantially; existing hardlinks must not hide this first-use cost.
  await requireSpace(context.root,Math.max(1024**3,manifest.files.reduce((sum,file)=>sum+file.bytes,0)*3));let completed=false
  try{
    context.update({phase:'runtime',message:'创建隔离识别环境；共用只读 Python 与相同版本依赖文件'})
    await deploymentCommand(uv,['--offline','--no-config','--no-progress','venv','--python',python,'--no-python-downloads',directory],offline)
    const pythonPath=join(directory,'Scripts','python.exe'),lock=join(directory,'muxivra-requirements.txt');await writeFile(lock,hashedRequirements(manifest))
    for(const file of manifest.files)await shareWheel(safeMember(dependencies.path,file.path),context)
    const index=await wheelIndex(manifest.files,join(directory,'muxivra-wheels.html'),context)
    context.update({phase:'dependencies',message:'从本地资源配置 PyTorch / CUDA / Transformers，不下载模型或依赖'})
    await deploymentCommand(uv,['--offline','--no-config','--no-progress','pip','install','--python',pythonPath,'--no-index','--find-links',index,'--require-hashes','--requirements',lock],offline)
    await deploymentCommand(uv,['--offline','--no-config','pip','check','--python',pythonPath],offline,120000)
    const probe=await verifyNvidiaEnvironment(pythonPath,backend,adapterPath,offline);await writeFile(join(directory,'muxivra-managed.json'),JSON.stringify({version:deploymentManifest.version,backend,profile:context.profile,gpuUuid:context.gpu.uuid,createdAt:new Date().toISOString(),pythonResource:base.id,dependencyResource:dependencies.id}));completed=true;return {pythonPath,directory,probe}
  }finally{if(!completed)await cleanup(context.root,directory)}
}
