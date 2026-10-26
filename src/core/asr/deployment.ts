import { resolveDownloadSource } from '../download-sources'
import { randomUUID,createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir,readFile,writeFile,appendFile,rename,rm,readdir,stat,realpath } from 'node:fs/promises'
import { join,dirname,resolve } from 'node:path'
import { spawn,type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable,Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { extractZip } from '../engine'
import { trackChildTree,terminateChild } from '../jobs/process-control'
import { isWithin,exists } from '../media/paths'
import { asrProcessEnvironment,requireSpace,writableStorage,hashFile } from './storage'
import { asrProbeSchema,type AsrProbe } from '../../shared/asr-environments'
import type { PythonAsrBackend } from '../../shared/asr-parameters'
import type { AsrDeployment,CudaProfile,NvidiaDevice } from '../../shared/asr-deployment'
import { fetchDownload,explainDownloadError,downloadProcessNetwork,safeDownloadUrl,canUseDownloadFallback } from '../download-network'
export const deploymentManifest={
  version:'nvidia-v2',python:'3.12.13',torch:'2.8.0',
  pythonDownloadUrl:'https://releases.astral.sh/github/python-build-standalone/releases/download/20260807/cpython-3.12.13%2B20260807-x86_64-pc-windows-msvc-install_only_stripped.tar.gz',
  uv:{url:'https://github.com/astral-sh/uv/releases/download/0.13.1/uv-x86_64-pc-windows-msvc.zip',sha256:'3b2661a463a5baea7f5076ea2b25ab71d77f36a6c0d809e5350651792f80a672',size:15308685},
  uvWheel:{url:'https://files.pythonhosted.org/packages/2a/8e/d23278bb327d2a75dc1d033c81b7fe23bbb28e363e02e7f306abd047924a/uv-0.13.1-py3-none-win_amd64.whl',sha256:'4f693cd4feb52f08f30474c4612f24be2050472609be65b9960b635f286da284',size:15404994},
  moss:{url:'https://codeload.github.com/OpenMOSS/MOSS-Transcribe-Diarize/zip/e3bdd93f8ad58418e04659818efd5fd87a0bc486',sha256:'94392db4ca851a271d732a8ba51b44f8ea8c303e60c921737b4ac5256f107f1a',size:217416}
} as const
export interface DeploymentContext {root:string;signal:AbortSignal;logPath:string;update:(value:Partial<AsrDeployment>)=>void;gpu:NvidiaDevice;profile:CudaProfile;offline?:boolean;captureStderr?:boolean}
export interface PreparedEnvironment {pythonPath:string;probe:AsrProbe;directory:string}
export function deploymentEnvironment(root:string,gpuUuid?:string):NodeJS.ProcessEnv {
  const env=asrProcessEnvironment(root)
  for(const key of Object.keys(env)){if(/^UV_|^PIP_|^PYTHON(?:HOME|PATH|USERBASE|PYCACHEPREFIX)$|^VIRTUAL_ENV$|^CONDA_PREFIX$|^CUDA_VISIBLE_DEVICES$/i.test(key))delete env[key]}
  return {...env,UV_SYSTEM_CERTS:'true',UV_CACHE_DIR:join(root,'cache','uv'),UV_LINK_MODE:'hardlink',UV_PYTHON_INSTALL_DIR:join(root,'python'),UV_PYTHON_BIN_DIR:join(root,'bin'),UV_TOOL_DIR:join(root,'tools'),UV_HTTP_TIMEOUT:'120',UV_HTTP_RETRIES:'4',PIP_CACHE_DIR:join(root,'cache','pip'),PIP_CONFIG_FILE:process.platform==='win32'?'NUL':'/dev/null',PIP_INDEX_URL:resolveDownloadSource('https://pypi.org/simple'),UV_PYTHON_INSTALL_MIRROR:resolveDownloadSource('https://releases.astral.sh/github/python-build-standalone/releases/download'),PYTHONNOUSERSITE:'1',PYTHONUSERBASE:join(root,'python-user'),PYTHONPYCACHEPREFIX:join(root,'cache','pycache'),...(gpuUuid?{CUDA_VISIBLE_DEVICES:gpuUuid,CUDA_DEVICE_ORDER:'PCI_BUS_ID'}:{})}
}
export async function deploymentCommand(executable:string,args:string[],context:DeploymentContext,timeout=3600000):Promise<string>{
  args=args.map(value=>value.startsWith("https://")?resolveDownloadSource(value):value)
  context.signal.throwIfAborted();await mkdir(join(context.root,'temp'),{recursive:true});if((await realpath(join(context.root,'temp'))).toLowerCase()!==resolve(context.root,'temp').toLowerCase())throw new Error('ASR 临时目录包含重定向，请保留安装目录内的普通目录');await mkdir(dirname(context.logPath),{recursive:true});await appendFile(context.logPath,JSON.stringify({executable,args})+'\n')
  const env={...deploymentEnvironment(context.root,context.gpu.uuid),...(context.offline?{UV_OFFLINE:'true',UV_PYTHON_DOWNLOADS:'never',PIP_NO_INDEX:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'}:{})},networkUrl=context.offline?undefined:args.find(value=>/^https:\/\//.test(value))??(args.includes('python')&&args.includes('install')?deploymentManifest.pythonDownloadUrl:undefined)
  const network=networkUrl?await downloadProcessNetwork(networkUrl,env):undefined
  if(network)await appendFile(context.logPath,JSON.stringify({type:'deployment-network',url:safeDownloadUrl(networkUrl!),mode:network.summary,systemCertificates:true})+'\n')
  context.signal.throwIfAborted()
  const child=spawn(executable,args,{windowsHide:true,shell:false,stdio:'pipe',cwd:context.root,env:{...env,...network?.env}}) as ChildProcessWithoutNullStreams
  let output='',tail='',bytes=0,failure:Error|undefined,last=0,writes=Promise.resolve()
  const abort=()=>terminateChild(child),timer=setTimeout(()=>{failure=new Error('部署步骤超时，请检查网络后重试');abort()},timeout)
  try{trackChildTree(child)}catch(error){failure=error as Error;child.kill()}
  context.signal.addEventListener('abort',abort,{once:true});if(context.signal.aborted)abort()
  const log=(text:string)=>{bytes+=Buffer.byteLength(text);if(bytes>8*1024**2){failure=new Error('部署输出超过大小限制');abort();return}tail=(tail+text).slice(-12000);writes=writes.then(()=>appendFile(context.logPath,text)).catch(error=>{failure=error as Error;abort()});if(Date.now()-last>150){last=Date.now();context.update({logTail:tail})}}
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',(text:string)=>{output+=text;log(text)});child.stderr.on('data',(text:string)=>{if(context.captureStderr)output+=text;log(text)});child.on('error',error=>{failure=error});child.stdin.on('error',()=>{});child.stdin.end()
  try{const code=await new Promise<number|null>(done=>child.once('close',done));await writes;context.signal.throwIfAborted();if(failure)throw failure;if(code!==0)throw new Error(`部署步骤失败（退出码 ${code}）：${tail.slice(-1800)}`);return output.trim()}
  finally{clearTimeout(timer);context.signal.removeEventListener('abort',abort);await writes;context.update({logTail:tail})}
}
export async function deploymentArchive(asset:{url:string;sha256:string;size:number},target:string,context:DeploymentContext){
  await writableStorage(context.root);await mkdir(dirname(target),{recursive:true})
  if(await exists(target)){if((await stat(target)).size===asset.size&&await hashFile(target,'sha256',undefined,context.signal)===asset.sha256)return;context.signal.throwIfAborted();const actual=await realpath(target);if(!isWithin(join(context.root,'cache','downloads'),actual)||actual!==resolve(target))throw new Error('部署下载包校验不一致，且缓存路径不属于本应用');await rm(actual,{force:true})}
  await requireSpace(context.root,asset.size*4);const partial=target+'.'+randomUUID()+'.part'
  try{
    await mkdir(dirname(context.logPath),{recursive:true});await appendFile(context.logPath,JSON.stringify({type:'download',url:safeDownloadUrl(asset.url),bytes:asset.size})+'\n')
    const response=await fetchDownload(asset.url,{signal:context.signal,label:'部署组件下载',timeoutMs:3600000,onRetry:message=>context.update({message})});if(!response.body)throw new Error('运行依赖下载没有返回文件内容')
    let count=0,last=0;const hash=createHash('sha256'),meter=new Transform({transform(chunk:Buffer,_encoding,done){count+=chunk.length;if(count>asset.size){done(new Error('下载包超出官方清单大小'));return}hash.update(chunk);if(Date.now()-last>200){last=Date.now();context.update({message:`下载部署组件 ${(count/1024**2).toFixed(1)} / ${(asset.size/1024**2).toFixed(1)} MB`})}done(null,chunk)}})
    await pipeline(Readable.fromWeb(response.body as never),meter,createWriteStream(partial,{flags:'wx'}),{signal:context.signal});context.signal.throwIfAborted()
    if(count!==asset.size||hash.digest('hex')!==asset.sha256)throw new Error('部署组件 SHA-256 校验失败');await rename(partial,target)
  }catch(error){throw explainDownloadError(error,asset.url,'部署组件下载')}finally{await rm(partial,{force:true})}
}
export async function verifyNvidiaEnvironment(pythonPath:string,backend:PythonAsrBackend,adapterPath:string,context:DeploymentContext):Promise<AsrProbe>{
  context.update({phase:'verifying',message:'检查模型依赖与实际 CUDA 运算'})
  const probe=asrProbeSchema.parse(JSON.parse(await deploymentCommand(pythonPath,['-I','-u',adapterPath,'--probe',backend],context,120000)))
  if(!probe.ready||!probe.cudaAvailable)throw new Error('CUDA 环境检查未通过：'+probe.issues.join('；'))
  if(probe.versions.torch!==deploymentManifest.torch+'+'+context.profile)throw new Error('实际 PyTorch CUDA 构建与部署清单不一致')
  await deploymentCommand(pythonPath,['-I','-c',"import torch; assert torch.cuda.is_available(); x=torch.ones((64,64),device='cuda:0',dtype=torch.float16); y=x@x; torch.cuda.synchronize(); assert float(y[0,0])==64; print(torch.cuda.get_device_name(0),torch.cuda.get_device_capability(0),torch.cuda.get_arch_list())"],context,120000)
  if(probe.versions.bitsandbytes&&probe.versions['optimum-quanto']){
    await deploymentCommand(pythonPath,['-I','-c',"import torch, bitsandbytes as bnb; from optimum.quanto import quantize, freeze, qfloat8; x=torch.ones((2,64),device='cuda:0',dtype=torch.float16); layer=bnb.nn.Linear4bit(64,64,bias=False,compute_dtype=torch.float16,quant_type='fp4').to('cuda:0'); assert torch.isfinite(layer(x)).all(); net=torch.nn.Sequential(torch.nn.Linear(64,64,bias=False)).half().to('cuda:0'); quantize(net,weights=qfloat8); freeze(net); assert torch.isfinite(net(x)).all(); torch.cuda.synchronize(); print('FP4 / FP8 CUDA quantization verified')"],context,120000)
  }
  return probe
}
export async function prepareNvidiaPython(backend:PythonAsrBackend,adapterPath:string,context:DeploymentContext):Promise<PreparedEnvironment>{
  await requireSpace(context.root,12*1024**3);await mkdir(join(context.root,'temp'),{recursive:true});const uv=await prepareDeploymentTool(context)
  context.signal.throwIfAborted();await deploymentCommand(uv,['--no-config','--no-progress','python','install',deploymentManifest.python,'--no-bin'],context)
  const python=await deploymentCommand(uv,['--no-config','python','find',deploymentManifest.python,'--managed-python','--no-project'],context,30000)
  const basePython=await realpath(python);if(!isWithin(join(context.root,'python'),basePython))throw new Error('受管 Python 不属于应用安装目录')
  const directory=join(context.root,'environments',`managed-${backend}-${context.profile}-${randomUUID()}`);await mkdir(dirname(directory),{recursive:true});let completed=false
  try{
    await deploymentCommand(uv,['--no-config','--no-progress','venv','--python',basePython,'--no-python-downloads',directory],context)
    const pythonPath=join(directory,'Scripts','python.exe'),constraints=join(directory,'muxivra-constraints.txt'),cuda=deploymentManifest.torch+'+'+context.profile
    await writeFile(constraints,`torch==${cuda}\ntorchaudio==${cuda}\n`)
    context.update({phase:'dependencies',message:'安装 NVIDIA CUDA 推理依赖，首次下载可能较大'})
    await deploymentCommand(uv,['--no-config','--no-progress','pip','install','--python',pythonPath,'--default-index','https://download.pytorch.org/whl/'+context.profile,'torch=='+cuda,'torchaudio=='+cuda],context)
    const common=['--no-config','--no-progress','pip','install','--python',pythonPath,'--default-index','https://pypi.org/simple','--constraint',constraints]
    if(backend==='qwen3-asr')await deploymentCommand(uv,[...common,'qwen-asr==0.0.6'],context)
    else{
      await deploymentCommand(uv,[...common,'setuptools==80.9.0','wheel==0.45.1','transformers==5.19.0','accelerate==1.15.0'],context)
      const mossArchive=join(context.root,'cache','downloads','moss-'+deploymentManifest.moss.sha256+'.zip'),source=join(directory,'official-source');await deploymentArchive(deploymentManifest.moss,mossArchive,context);await extractZip(mossArchive,source,32*1024**2);const entries=await readdir(source);if(entries.length!==1)throw new Error('MOSS 官方源码目录结构不正确')
      await deploymentCommand(uv,[...common,'--no-build-isolation',join(source,entries[0])],context)
    }
    context.update({phase:'dependencies',message:'安装 FP4/NF4/INT8 与 FP8 量化依赖'})
    await deploymentCommand(uv,[...common,'bitsandbytes==0.50.2','optimum-quanto==0.2.7'],context)
    await deploymentCommand(uv,['--no-config','pip','check','--python',pythonPath],context,120000)
    const probe=await verifyNvidiaEnvironment(pythonPath,backend,adapterPath,context);await writeFile(join(directory,'muxivra-managed.json'),JSON.stringify({version:deploymentManifest.version,backend,profile:context.profile,gpuUuid:context.gpu.uuid,createdAt:new Date().toISOString()}));completed=true;return {pythonPath,probe,directory}
  }finally{if(!completed&&await exists(directory)){context.update({message:'清理未完成的独立环境…'});const actual=await realpath(directory);if(!isWithin(join(context.root,'environments'),actual)||actual!==resolve(directory))throw new Error('环境清理路径已变化');await rm(actual,{recursive:true,force:true,maxRetries:8,retryDelay:300})}}
}

export async function prepareDeploymentTool(context:DeploymentContext){
  await mkdir(join(context.root,'temp'),{recursive:true})
  const tools=join(context.root,'tools','uv-0.13.1'),uv=join(tools,'uv.exe');let archive=join(context.root,'cache','downloads','uv-0.13.1.zip'),entry='uv.exe'
  context.update({phase:'runtime',message:'准备应用独立 Python 安装工具'})
  try{await deploymentArchive(deploymentManifest.uv,archive,context)}catch(error){
    context.signal.throwIfAborted();if(!canUseDownloadFallback(error))throw error
    const message='GitHub 部署工具连接失败，改用 Astral 官方 PyPI 包（固定版本与 SHA-256）'
    context.update({message});await appendFile(context.logPath,JSON.stringify({type:'official-source-fallback',message,reason:(error as Error).message})+'\n')
    archive=join(context.root,'cache','downloads','uv-0.13.1.whl');entry='uv-0.13.1.data/scripts/uv.exe'
    try{await deploymentArchive(deploymentManifest.uvWheel,archive,context)}catch(alternate){context.signal.throwIfAborted();throw new Error(`GitHub 与官方 PyPI 两个部署工具入口均未完成下载。\n${(error as Error).message}\n${(alternate as Error).message}`)}
  }
  // Wheels are ZIP files. No existing Python is needed to extract the native
  // binary, and only a hash-verified publisher archive is ever executed.
  const stage=join(context.root,`.transfer-${randomUUID()}`)
  try{await extractZip(archive,stage,128*1024**2);context.signal.throwIfAborted();const executable=join(stage,...entry.split('/'));if(!await exists(executable))throw new Error('官方 uv 包内缺少 uv.exe');await mkdir(tools,{recursive:true});await writeFile(uv,await readFile(executable))}finally{await rm(stage,{recursive:true,force:true})}
  return uv
}
