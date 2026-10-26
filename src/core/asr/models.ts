import { createHash,randomUUID } from 'node:crypto'
import { createReadStream,createWriteStream } from 'node:fs'
import { mkdir,readFile,writeFile,appendFile,stat,realpath,rename,rm,open,readdir } from 'node:fs/promises'
import { join,resolve,dirname,extname } from 'node:path'
import { Readable,Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile,type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promisify } from 'node:util'
import { JsonStore } from '../storage/json'
import { isWithin,localPath,canonicalInput,exists } from '../media/paths'
import { extractZip } from '../engine'
import { asrModelSchema,customAsrManifestSchema,asrRecognitionSchema,type AsrRecognition,type AsrModel,type AsrState,type AsrDownload,type AsrImportRequest } from '../../shared/asr'
import { asrEnvironmentRequestSchema,asrEnvironmentSchema,asrProbeSchema,type AsrEnvironment,type AsrEnvironmentRequest } from '../../shared/asr-environments'
import { pythonAsrBackends,parseAsrParameters } from '../../shared/asr-parameters'
import { trackChildTree,terminateChild } from '../jobs/process-control'
import { fetchDownload,explainDownloadError } from '../download-network'
import { managedAsrAssetSchema,officialAsrCatalog,type ManagedAsrAsset } from '../../shared/asr-catalog'
import { copyModel,asrProcessEnvironment,requireSpace,collectFiles } from './storage'
import { downloadOfficialModel } from './official-download'
import { discoverPython } from './python-discovery'
import type { PythonDiscovery } from '../../shared/asr-environments'
import { asrDeploymentRequestSchema,asrConfigureModelSchema,asrResourceRequestSchema,asrResourceSchema,nvidiaProfile,type AsrDeployment,type AsrDeploymentRequest,type NvidiaDetection,type AsrResource,type AsrResourceRequest,type AsrConfigureModelRequest } from '../../shared/asr-deployment'
import { detectNvidia } from './nvidia'
import { prepareNvidiaPython,verifyNvidiaEnvironment,deploymentManifest,deploymentCommand,type PreparedEnvironment,type DeploymentContext } from './deployment'
import { downloadPythonResource,downloadDependencyResource,importPreparedResource,downloadedResourceStatus,prepareOfflineNvidiaPython,discoverPreparedResource } from './resources'

export const whisperRuntimeCatalog = {
  cpu:{name:'whisper.cpp b5454 · CPU',url:'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',sha256:'6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',size:8928640},
  cuda:{name:'whisper.cpp b5454 · NVIDIA CUDA 12.4',url:'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-win-cuda-12.4.0-x64.zip',sha256:'afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a',size:684913404}
} as const
export const largeV3Catalog = {name:'Whisper large-v3',file:'ggml-large-v3.bin',url:'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin',sha256:'64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2',size:3095033483} as const
const exec=promisify(execFile)
type Runtime=AsrState['runtimes'][number]
interface Config {version:1;models:AsrModel[];runtimes:Runtime[];environments?:AsrEnvironment[];assets?:ManagedAsrAsset[];resources?:AsrResource[];disabled?:{models:unknown[];environments:unknown[];assets:unknown[]}}
export async function verifyWhisperRuntime(input:string,context?:DeploymentContext):Promise<string> {
  const executable=await canonicalInput(input)
  const result=context?undefined:await exec(executable,['--help'],{windowsHide:true,timeout:15000,maxBuffer:1024*1024})
  const help=context?await deploymentCommand(executable,['--help'],{...context,offline:true,captureStderr:true},15000):result!.stdout+result!.stderr
  if(!help.includes('--output-json-full')||!help.includes('--model'))throw new Error('请选择支持完整 JSON 时间戳输出的 whisper-cli.exe，不能使用其他程序')
  return executable
}
export async function verifyWhisperModel(path:string):Promise<void> {
  const file=await open(path,'r')
  try{const header=Buffer.alloc(4);const {bytesRead}=await file.read(header,0,4,0);if(bytesRead!==4||header.readUInt32LE()!==0x67676d6c)throw new Error('模型不是 whisper.cpp GGML 格式，请导入转换后的完整模型文件')}finally{await file.close()}
}
export class AsrModels {
  readonly root:string
  readonly storageRoot:string
  private store:JsonStore<Config>
  private models:AsrModel[]=[]
  private runtimes:Runtime[]=[]
  private environments:AsrEnvironment[]=[]
  private assets:ManagedAsrAsset[]=[]
  private resources:AsrResource[]=[]
  private disabled:NonNullable<Config['disabled']>={models:[],environments:[],assets:[]}
  private deployment:AsrDeployment={active:false,phase:'idle',message:'',logTail:''}
  private nvidia?:NvidiaDetection
  private deploymentController?:AbortController
  private deploymentTask?:Promise<unknown>
  private discovery:PythonDiscovery={active:false,candidates:[],issues:[]}
  private discoveryTask?:Promise<void>
  private operation:Promise<unknown>=Promise.resolve()
  private controller?:AbortController
  private downloading?:Promise<void>
  private closing=false
  private environmentChecks=new AbortController()
  download:AsrDownload={active:false,phase:'idle',label:'',percent:0,received:0,total:0,message:''}
  constructor(dataPath:string,private update:()=>void,readonly adapterPath=resolve('resources','asr','adapter.py'),installationDirectory=dataPath){this.root=join(dataPath,'asr');this.storageRoot=join(installationDirectory,'asr');this.store=new JsonStore(join(this.root,'models.json'))}
  async initialize():Promise<void>{
    const saved=await this.store.read({version:1,models:[],runtimes:[]})
    if(saved.version!==1||!Array.isArray(saved.models)||saved.models.length>500||!Array.isArray(saved.runtimes))throw new Error('ASR 模型配置无效，请保留配置文件')
    const retired=(value:unknown)=>!!value&&typeof value==='object'&&(value as {backend?:string}).backend==='mimo-v2.5-asr'
    this.disabled={models:[...(saved.disabled?.models??[]),...saved.models.filter(retired)],environments:[...(saved.disabled?.environments??[]),...(saved.environments??[]).filter(retired)],assets:[...(saved.disabled?.assets??[]),...(saved.assets??[]).filter(retired)]}
    this.models=saved.models.filter(value=>!retired(value)).map(model=>asrModelSchema.parse(model));this.runtimes=saved.runtimes
    this.environments=(saved.environments??[]).filter(value=>!retired(value)).map(value=>asrEnvironmentSchema.parse(value))
    this.assets=(saved.assets??[]).filter(value=>!retired(value)).map(value=>managedAsrAssetSchema.parse(value))
    this.resources=await Promise.all((saved.resources??[]).map(value=>asrResourceSchema.parse(value)).map(async value=>value.kind==='whisper-runtime'?{...value,ready:await exists(value.path)}:downloadedResourceStatus(value)))
    for(const environment of this.environments)if(!await exists(environment.pythonPath))environment.probe={ready:false,python:environment.probe?.python??'无法读取',platform:process.platform,versions:environment.probe?.versions??{},cudaAvailable:false,devices:[],issues:['环境解释器不存在，请重新配置或导入'],warnings:[],checkedAt:new Date().toISOString(),vllm:false}
    this.assets=(await Promise.all(this.assets.map(async asset=>await exists(asset.path)?asset:undefined))).filter((asset):asset is ManagedAsrAsset=>!!asset)
    for(const model of this.models){try{await stat(model.modelPath);await canonicalInput(this.environments.find(e=>e.id===model.environmentId)?.pythonPath??model.executable);model.availability='ready';delete model.issue}catch{model.availability='missing';model.issue='模型或运行程序无法读取，请重新导入'}}
    this.runtimes=(await Promise.all(this.runtimes.map(async r=>await exists(r.executable)?r:undefined))).filter((r):r is Runtime=>!!r)
    await this.discoverStoredResources()
    await mkdir(join(this.root,'results'),{recursive:true});await this.save()
  }
  state():AsrState{return structuredClone({models:this.models.map(model=>this.resolveModel(model)),runtimes:this.runtimes,download:this.download,environments:this.environments,assets:this.assets,storageRoot:this.storageRoot,adapterPath:this.adapterPath,discovery:this.discovery,deployment:this.deployment,nvidia:this.nvidia,resources:this.resources})}
  private resolveModel(model:AsrModel):AsrModel{
    model={...model,storageRoot:this.storageRoot}
    if(!model.environmentId)return model
    const environment=this.environments.find(e=>e.id===model.environmentId)
    if(!environment)return {...model,availability:'missing',issue:'运行环境记录缺失，请重新导入模型'}
    return {...model,executable:environment.pythonPath,args:['-u',this.adapterPath],environment,nvidiaDeviceUuid:environment.managed?.gpuUuid??model.nvidiaDeviceUuid,availability:environment.probe?.ready&&model.availability==='ready'?'ready':'missing',issue:environment.probe?.ready?model.issue:'运行环境检查未通过，请前往运行环境管理'}
  }
  get(id:string):AsrModel{const model=this.models.find(m=>m.id===id);if(!model)throw new Error('ASR 模型不存在，请先导入模型');return structuredClone(this.resolveModel(model))}
  runtime(id:string):string{const runtime=this.runtimes.find(r=>r.id===id);if(!runtime)throw new Error('推理运行包不存在');return runtime.executable}
  private exclusive<T>(fn:()=>Promise<T>):Promise<T>{const task=this.operation.catch(()=>{}).then(fn);this.operation=task;return task}
  private async save(){await this.store.write({version:1,models:this.models,runtimes:this.runtimes,environments:this.environments,assets:this.assets,resources:this.resources,disabled:this.disabled});this.update()}
  private guardDeployment(internal=false){if(this.deployment.active&&!internal)throw new Error('一键部署正在进行，请等待完成或取消后再修改模型环境')}
  private async checkEnvironment(pythonPath:string,args:string[]):Promise<AsrEnvironment['probe']>{
    this.environmentChecks.signal.throwIfAborted()
    await mkdir(join(this.storageRoot,'temp'),{recursive:true})
    const operation=exec(pythonPath,args,{windowsHide:true,maxBuffer:4*1024*1024,env:asrProcessEnvironment(this.storageRoot)}),child=operation.child as ChildProcessWithoutNullStreams
    const abort=()=>terminateChild(child);let timer:ReturnType<typeof setTimeout>|undefined,timedOut=false
    try{
      trackChildTree(child);this.environmentChecks.signal.addEventListener('abort',abort,{once:true});if(this.environmentChecks.signal.aborted)abort()
      timer=setTimeout(()=>{timedOut=true;terminateChild(child)},90000)
      const result=await operation;if(timedOut)throw new Error('运行环境检查超过 90 秒，请检查依赖和 Python 路径')
      return asrProbeSchema.parse(JSON.parse(result.stdout.trim()))
    }catch(error){await operation.catch(()=>{});if(timedOut)throw new Error('运行环境检查超过 90 秒，请检查依赖和 Python 路径');throw error}
    finally{if(timer)clearTimeout(timer);this.environmentChecks.signal.removeEventListener('abort',abort)}
  }
  private async discoverStoredResources(){
    const components=join(this.storageRoot,'components')
    if(await exists(components))for(const entry of (await readdir(components,{withFileTypes:true})).slice(0,200)){const path=join(components,entry.name);if(!entry.isDirectory()||entry.isSymbolicLink()||this.resources.some(value=>resolve(value.path).toLowerCase()===resolve(path).toLowerCase()))continue;try{const actual=await realpath(path);if(actual.toLowerCase()!==resolve(path).toLowerCase())continue;this.resources.push(await discoverPreparedResource(actual))}catch(error){this.resources.push({id:randomUUID(),kind:entry.name.startsWith('python')?'python':'dependencies',name:entry.name,path,versions:{},bytes:0,createdAt:new Date().toISOString(),source:'import',ready:false,issue:'资源清单无法读取（大小未统计）：'+(error as Error).message})}}
    const directory=join(this.storageRoot,'environments')
    if(!await exists(directory))return
    for(const entry of (await readdir(directory,{withFileTypes:true})).slice(0,100)){
      if(!entry.isDirectory()||entry.isSymbolicLink())continue
      const path=join(directory,entry.name),pythonPath=join(path,'Scripts','python.exe'),file=join(path,'muxivra-managed.json')
      if(this.environments.some(value=>resolve(value.pythonPath).toLowerCase()===resolve(pythonPath).toLowerCase())||!await exists(file)||!await exists(pythonPath))continue
      try{
        if((await stat(file)).size>65536||(await realpath(path)).toLowerCase()!==resolve(path).toLowerCase())continue
        const manifest=JSON.parse(await readFile(file,'utf8'))
        if(!pythonAsrBackends.includes(manifest.backend)||!['cu126','cu128'].includes(manifest.profile)||typeof manifest.gpuUuid!=='string'||typeof manifest.version!=='string')continue
        // Inventory must not launch an unregistered interpreter or delay app
        // startup on a broken environment. Read its installed metadata only;
        // explicit Refresh performs the real import/CUDA checks later.
        const versions:Record<string,string>={},site=join(path,'Lib','site-packages')
        if(await exists(site)&&(await realpath(site)).toLowerCase()===resolve(site).toLowerCase())for(const item of (await readdir(site,{withFileTypes:true})).filter(value=>value.isDirectory()&&!value.isSymbolicLink()&&value.name.endsWith('.dist-info')).slice(0,500)){
          const metadata=join(site,item.name,'METADATA');try{if((await stat(metadata)).size>1024*1024||(await realpath(metadata)).toLowerCase()!==resolve(metadata).toLowerCase())continue;const text=await readFile(metadata,'utf8'),name=/^Name:\s*(.+)$/m.exec(text)?.[1]?.trim().toLowerCase().replaceAll('_','-'),version=/^Version:\s*(.+)$/m.exec(text)?.[1]?.trim();if(name&&version)versions[name]=version}catch{}
        }
        let python='未验证';const config=join(path,'pyvenv.cfg');if(await exists(config)&&(await stat(config)).size<65536)python=/^version\s*=\s*(.+)$/m.exec(await readFile(config,'utf8'))?.[1]?.trim()??python
        const torchVersion=join(site,'torch','version.py');if(await exists(torchVersion)&&(await stat(torchVersion)).size<65536&&(await realpath(torchVersion)).toLowerCase()===resolve(torchVersion).toLowerCase()){const text=await readFile(torchVersion,'utf8');versions.cuda=/^cuda(?:\s*:\s*[^=]+)?\s*=\s*['"]([^'"]+)['"]/m.exec(text)?.[1]??(/^cuda(?:\s*:\s*[^=]+)?\s*=\s*None/m.test(text)?'CPU':'未验证')}
        const probe={ready:false,python,platform:process.platform,versions,cudaAvailable:false,devices:[],issues:['检测到未登记的本地环境；请点击重新检测验证后使用'],warnings:[],checkedAt:new Date().toISOString(),vllm:false}
        this.environments.push(asrEnvironmentSchema.parse({id:randomUUID(),name:manifest.backend+' · 已发现环境',backend:manifest.backend,pythonPath,probe,createdAt:manifest.createdAt??new Date().toISOString(),managed:{version:manifest.version,profile:manifest.profile,gpuUuid:manifest.gpuUuid,directory:path}}))
      }catch{}
    }
  }
  saveEnvironment(input:AsrEnvironmentRequest){return this.exclusive(async()=>{
    this.guardDeployment()
    if(this.closing)throw new Error('应用正在退出')
    const request=asrEnvironmentRequestSchema.parse(input),pythonPath=await canonicalInput(request.pythonPath)
    if(/\.(bat|cmd|ps1)$/i.test(pythonPath))throw new Error('请选择 Python 可执行文件')
    const old=request.id?this.environments.find(e=>e.id===request.id):undefined
    if(request.id&&!old)throw new Error('运行环境不存在')
    if(old&&old.backend!==request.backend&&this.models.some(m=>m.environmentId===old.id))throw new Error('仍有模型使用此环境，不能更改后端类型')
    if(!old&&this.environments.length>=100)throw new Error('最多保存 100 个运行环境')
    const extra:Record<string,string|undefined>={}
    for(const key of ['sourcePath','alignerPath'] as const){if(request[key]){let path=await realpath(localPath(request[key]!));if(!(await stat(path)).isDirectory())throw new Error('请选择普通目录');if(key!=='sourcePath'&&!isWithin(this.storageRoot,path)){const copied=await this.transfer('转存辅助模型',signal=>copyModel(path,this.storageRoot,'辅助模型',signal,update=>this.setTransfer(update)));path=copied.path}extra[key]=path}}
    const value=asrEnvironmentSchema.parse({...request,...extra,pythonPath,id:old?.id??randomUUID(),createdAt:old?.createdAt??new Date().toISOString()})
    const args=['-u',await canonicalInput(this.adapterPath),'--probe',request.backend,...(extra.sourcePath?['--source',extra.sourcePath]:[])]
    try{value.probe=await this.checkEnvironment(pythonPath,args)}
    catch(error){if(this.closing)throw new Error('应用退出，环境检查已停止');value.probe={ready:false,python:'无法读取',platform:process.platform,versions:{},cudaAvailable:false,devices:[],issues:[(error as Error).message.slice(0,4000)],warnings:[],checkedAt:new Date().toISOString(),vllm:false}}
    for(const model of this.models.filter(m=>m.environmentId===value.id)){try{await stat(model.modelPath);await canonicalInput(pythonPath);model.availability='ready';delete model.issue}catch{model.availability='missing';model.issue='模型目录或运行程序无法读取'}}
    const previous=this.environments;this.environments=[...previous.filter(e=>e.id!==value.id),value];try{await this.save()}catch(error){this.environments=previous;throw error}return structuredClone(value)
  })}
  refreshEnvironment(id:string){const environment=this.environments.find(e=>e.id===id);if(!environment)throw new Error('运行环境不存在');if(environment.managed)return this.exclusive(async()=>{this.guardDeployment();const detected=await this.detectNvidia(),gpu=detected.devices.find(value=>value.uuid===environment.managed!.gpuUuid);if(!gpu)throw new Error('自动环境绑定的 NVIDIA GPU 不可用');const probe=await verifyNvidiaEnvironment(environment.pythonPath,environment.backend,this.adapterPath,{root:this.storageRoot,signal:this.environmentChecks.signal,logPath:join(this.storageRoot,'logs',`check-${randomUUID()}.log`),gpu,profile:nvidiaProfile(gpu),update:()=>{}}),value={...environment,probe};this.environments=this.environments.map(item=>item.id===id?value:item);await this.save();return structuredClone(value)});const {probe,createdAt,managed,...request}=environment;return this.saveEnvironment(request)}
  removeEnvironment(id:string){return this.exclusive(async()=>{this.guardDeployment();if(this.models.some(m=>m.environmentId===id))throw new Error('仍有模型使用此环境，请先移除模型记录');const previous=this.environments;this.environments=previous.filter(e=>e.id!==id);try{await this.save()}catch(error){this.environments=previous;throw error}})}
  async import(request:AsrImportRequest,internal=false):Promise<AsrModel>{
    this.guardDeployment(internal)
    if(this.closing)throw new Error('应用正在退出')
    const python=pythonAsrBackends.includes(request.backend as typeof pythonAsrBackends[number])
    const input=python?await realpath(localPath(request.modelPath)):await canonicalInput(request.modelPath)
    let model:AsrModel
    if(python){
      const environment=this.environments.find(e=>e.id===request.environmentId&&e.backend===request.backend)
      if(!environment)throw new Error('请先配置与模型对应的运行环境')
      if(!(await stat(input)).isDirectory())throw new Error('请选择完整模型目录')
      const config=join(input,'config.json');if((await stat(config)).size>1024*1024)throw new Error('模型配置超过 1 MB')
      const metadata=JSON.parse(await readFile(config,'utf8'))
      const expected={'qwen3-asr':['qwen3_asr'],'moss-transcribe-diarize':['moss_transcribe_diarize','moss_td','moss_asr']}[request.backend as typeof pythonAsrBackends[number]]
      if(!expected.includes(metadata.model_type))throw new Error('模型 config.json 与所选后端不匹配')
      if(!(await readdir(input)).some(name=>/\.(safetensors|bin)$/.test(name)))throw new Error('模型目录没有权重文件，请选择完整下载目录')
      model=asrModelSchema.parse({id:randomUUID(),name:request.name,backend:request.backend,modelPath:input,executable:environment.pythonPath,args:['-u',this.adapterPath],sampleRate:16000,channels:1,environmentId:environment.id,importedAt:new Date().toISOString(),availability:'ready'})
    }else if(request.backend==='custom'){
      if((await stat(input)).size>1024*1024)throw new Error('后端配置不能超过 1 MB')
      const manifest=customAsrManifestSchema.parse(JSON.parse((await readFile(input,'utf8')).replace(/^\uFEFF/,''))),base=dirname(input)
      const executable=await canonicalInput(resolve(base,manifest.executable)),modelPath=await realpath(localPath(resolve(base,manifest.modelPath)))
      if(/\.(bat|cmd|ps1)$/i.test(executable))throw new Error('请选择可直接启动的可执行程序；脚本应通过明确的解释器运行')
      await stat(modelPath)
      model=asrModelSchema.parse({id:randomUUID(),name:manifest.name,backend:'custom',modelPath,executable,args:manifest.args.map(arg=>arg.replaceAll('{manifestDir}',base)),sampleRate:manifest.sampleRate,channels:manifest.channels,importedAt:new Date().toISOString(),availability:'ready'})
    }else{
      if(!request.executable)throw new Error('请选择或下载 whisper.cpp 运行包')
      await verifyWhisperModel(input)
      model=asrModelSchema.parse({id:randomUUID(),name:request.name||'Whisper 模型',backend:'whisper.cpp',modelPath:input,executable:await verifyWhisperRuntime(request.executable),args:[],sampleRate:16000,channels:1,importedAt:new Date().toISOString(),size:(await stat(input)).size,availability:'ready'})
    }
    if(!isWithin(this.storageRoot,model.modelPath)){
      const transferred=await this.transfer(model.name,signal=>copyModel(model.modelPath,this.storageRoot,model.name,signal,update=>this.setTransfer(update)))
      model={...model,modelPath:transferred.path,size:transferred.bytes}
    }
    return this.exclusive(async()=>{if(this.models.length>=500)throw new Error('最多保存 500 个模型');const previous=this.models;this.models=[...previous,model];try{await this.save()}catch(error){this.models=previous;throw error}return structuredClone(this.resolveModel(model))})
  }
  private setTransfer(update:Partial<AsrDownload>){this.download={...this.download,...update};this.update()}
  private async transfer<T>(label:string,operation:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    if(this.closing)throw new Error('应用正在退出');if(this.controller)throw new Error('已有模型下载或导入正在进行')
    const controller=new AbortController();this.controller=controller;this.setTransfer({active:true,phase:'preparing',label,received:0,total:0,percent:0,message:'正在准备模型文件'})
    const task=operation(controller.signal);this.downloading=task.then(()=>{},()=>{})
    try{const value=await task;this.setTransfer({active:false,phase:'completed',percent:100,message:'文件已保存至安装目录'});return value}
    catch(error){this.setTransfer({active:false,phase:controller.signal.aborted?'cancelled':'failed',message:controller.signal.aborted?'操作已取消':(error as Error).message});throw error}
    finally{this.controller=undefined;this.downloading=undefined}
  }
  async downloadModel(id:string,internal=false){
    this.guardDeployment(internal)
    const asset=officialAsrCatalog.find(value=>value.id===id);if(!asset)throw new Error('模型不在官方下载列表中')
    if(this.assets.some(value=>value.id===id&&value.revision===asset.revision))throw new Error('模型已下载，请选择现有文件并绑定环境')
    const downloaded=await this.transfer(asset.name,signal=>downloadOfficialModel(asset,this.storageRoot,signal,update=>this.setTransfer(update)))
    const value:ManagedAsrAsset={id:asset.id,name:asset.name,backend:asset.backend,role:asset.role,path:downloaded.path,bytes:downloaded.bytes,repo:asset.repo,revision:asset.revision,createdAt:new Date().toISOString()}
    await this.exclusive(async()=>{this.assets.push(value);await this.save()});return value
  }
  async importModelAsset(request:{name:string;backend:'whisper.cpp'|typeof pythonAsrBackends[number];modelPath:string}){
    this.guardDeployment();if(!request.name.trim()||request.name.length>200)throw new Error('请输入有效模型名称')
    const input=await realpath(localPath(request.modelPath))
    if(request.backend==='whisper.cpp')await verifyWhisperModel(input)
    else{
      if(!pythonAsrBackends.includes(request.backend)||!(await stat(input)).isDirectory())throw new Error('请选择支持的完整模型目录')
      const config=join(input,'config.json');if((await stat(config)).size>1024*1024)throw new Error('模型配置超过 1 MB');const metadata=JSON.parse(await readFile(config,'utf8'))
      if(!({'qwen3-asr':['qwen3_asr'],'moss-transcribe-diarize':['moss_transcribe_diarize','moss_td','moss_asr']}[request.backend].includes(metadata.model_type))||!(await readdir(input)).some(name=>/\.(safetensors|bin)$/.test(name)))throw new Error('模型 config.json 与后端不匹配，或缺少完整权重')
    }
    const copied=await this.transfer('导入模型文件',signal=>copyModel(input,this.storageRoot,request.name,signal,update=>this.setTransfer(update))),value:ManagedAsrAsset={id:randomUUID(),name:request.name.trim(),backend:request.backend,role:'model',path:copied.path,bytes:copied.bytes,createdAt:new Date().toISOString()}
    await this.exclusive(async()=>{this.assets.push(value);await this.save()});return value
  }
  async importComponent(path:string,role:'aligner'){
    this.guardDeployment();if(role!=='aligner')throw new Error('此辅助模型暂不支持')
    const input=await realpath(localPath(path));if(!(await stat(input)).isDirectory())throw new Error('请选择完整辅助模型目录')
    const config=join(input,'config.json');if((await stat(config)).size>1024*1024)throw new Error('辅助模型配置超过 1 MB');const metadata=JSON.parse(await readFile(config,'utf8'));if(!metadata||typeof metadata!=='object'||Array.isArray(metadata)||!Object.keys(metadata).length||!(await readdir(input)).some(name=>/\.(safetensors|bin)$/.test(name)))throw new Error('辅助模型缺少有效配置或权重')
    const copied=await this.transfer('导入对齐模型',signal=>copyModel(input,this.storageRoot,role,signal,update=>this.setTransfer(update)))
    const value:ManagedAsrAsset={id:randomUUID(),name:copied.path.split(/[\\/]/).at(-1)??role,backend:'qwen3-asr',role,path:copied.path,bytes:copied.bytes,createdAt:new Date().toISOString()}
    await this.exclusive(async()=>{this.assets.push(value);await this.save()});return value
  }
  bindAsset(id:string,environmentId?:string,runtimeId?:string,internal=false){this.guardDeployment(internal);const asset=this.assets.find(value=>value.id===id&&value.role==='model');if(!asset)throw new Error('下载模型记录不存在');return this.import({backend:asset.backend as AsrImportRequest['backend'],name:asset.name,modelPath:asset.path,environmentId,executable:runtimeId?this.runtime(runtimeId):undefined},internal)}
  async storeModel(id:string){this.guardDeployment();const model=this.get(id);if(isWithin(this.storageRoot,model.modelPath))return model;const transferred=await this.transfer(model.name,signal=>copyModel(model.modelPath,this.storageRoot,model.name,signal,update=>this.setTransfer(update)));return this.exclusive(async()=>{this.models=this.models.map(value=>value.id===id?{...value,modelPath:transferred.path,size:transferred.bytes}:value);await this.save();return this.get(id)})}
  discoverEnvironments(){
    if(this.closing)throw new Error('应用正在退出');if(this.discovery.active)return
    this.discovery={...this.discovery,active:true,issues:[]};this.update()
    this.discoveryTask=(async()=>{try{await mkdir(join(this.storageRoot,'temp'),{recursive:true});await discoverPython(this.storageRoot,this.environments.map(environment=>environment.pythonPath),this.environmentChecks.signal,state=>{this.discovery=state;this.update()})}catch(error){this.discovery={...this.discovery,active:false,checkedAt:new Date().toISOString(),issues:[(error as Error).message]};this.update()}})()
  }
  async remove(id:string):Promise<void>{await this.exclusive(async()=>{this.guardDeployment();const previous=this.models;this.models=previous.filter(m=>m.id!==id);try{await this.save()}catch(error){this.models=previous;throw error}})}
  saveRecognition(id:string,input:AsrRecognition){return this.exclusive(async()=>{this.guardDeployment();const model=this.get(id),recognition=asrRecognitionSchema.parse(input);recognition.parameters=parseAsrParameters(model.backend,recognition.parameters);const previous=this.models;this.models=previous.map(m=>m.id===id?{...m,recognition}:m);try{await this.save()}catch(error){this.models=previous;throw error}return recognition})}
  async detectNvidia(){this.nvidia=await detectNvidia();this.update();return structuredClone(this.nvidia)}
  private resourceOperation<T>(request:AsrResourceRequest,operation:(context:DeploymentContext)=>Promise<T>):Promise<T>{
    if(this.closing)throw new Error('应用正在退出');if(this.deploymentController||this.controller)throw new Error('已有 ASR 资源操作正在进行')
    const controller=new AbortController();this.deploymentController=controller
    this.deployment={active:true,phase:request.kind==='python'?'runtime':'detecting',assetId:request.assetId,gpuIndex:request.gpuIndex,message:'正在准备资源操作…',logTail:'',startedAt:new Date().toISOString(),logPath:join(this.storageRoot,'logs',`resource-${randomUUID()}.log`)};this.update()
    const task=(async()=>{
      const detection=request.kind==='python'?undefined:await this.detectNvidia(),gpu=detection?.devices.find(value=>value.index===request.gpuIndex)
      if(request.kind!=='python'&&!gpu)throw new Error(detection?.issue??'所选 NVIDIA GPU 不可用')
      const context:DeploymentContext={root:this.storageRoot,signal:controller.signal,logPath:this.deployment.logPath!,gpu:gpu??{index:0,uuid:'',name:'',driver:'',computeMajor:0,computeMinor:0,totalBytes:0,freeBytes:0},profile:gpu?nvidiaProfile(gpu):'cu126',update:value=>{this.deployment={...this.deployment,...value};this.update()}}
      return operation(context)
    })().catch(async error=>{
      const detail=JSON.stringify({type:controller.signal.aborted?'cancelled':'resource-error',message:(error as Error).message})+'\n';await mkdir(dirname(this.deployment.logPath!),{recursive:true}).then(()=>appendFile(this.deployment.logPath!,detail)).catch(()=>{})
      this.deployment={...this.deployment,logTail:(this.deployment.logTail+'\n'+detail).slice(-12000)};throw error
    })
    this.deploymentTask=task
    void task.then(()=>{this.deploymentController=undefined;this.deploymentTask=undefined;this.deployment={...this.deployment,active:false,phase:'completed',message:'资源已准备完成，可在环境页执行离线配置',finishedAt:new Date().toISOString()};this.update()},error=>{
      this.deploymentController=undefined;this.deploymentTask=undefined;this.deployment={...this.deployment,active:false,phase:controller.signal.aborted?'cancelled':'failed',message:controller.signal.aborted?'资源操作已取消':(error as Error).message,finishedAt:new Date().toISOString()};this.update()
    })
    return task
  }
  downloadResource(input:AsrResourceRequest){const request=asrResourceRequestSchema.parse(input);return this.resourceOperation(request,async context=>{
    let resource:AsrResource
    if(request.kind==='python')resource=await downloadPythonResource(context)
    else if(request.kind==='dependencies')resource=await downloadDependencyResource(officialAsrCatalog.find(value=>value.id===request.assetId)!.backend,this.resources,context)
    else{
      if(!this.runtimes.some(value=>value.id==='whisper-b5454-cuda'))await this.install('runtime','cuda',true)
      const runtime=this.runtimes.find(value=>value.id==='whisper-b5454-cuda')!,path=dirname(runtime.executable)
      resource={id:randomUUID(),kind:'whisper-runtime',name:whisperRuntimeCatalog.cuda.name,path,backend:'whisper.cpp',runtimeId:runtime.id,versions:{'whisper.cpp':'b5454',cuda:'12.4'},bytes:(await collectFiles(path)).reduce((sum,file)=>sum+file.size,0),createdAt:new Date().toISOString(),source:'download',ready:true}
    }
    await this.exclusive(async()=>{context.signal.throwIfAborted();if(this.closing)throw new Error('应用正在退出');this.resources.push(resource);await this.save()});return resource
  })}
  importResource(input:AsrResourceRequest,path:string){const request=asrResourceRequestSchema.parse(input);return this.resourceOperation(request,async context=>{
    let resource:AsrResource
    if(request.kind==='whisper-runtime'){
      const source=await realpath(localPath(path));await verifyWhisperRuntime(await findCli(source),context);const copied=await copyModel(source,this.storageRoot,'Whisper CUDA 运行包',context.signal,value=>context.update({message:value.message})),executable=await verifyWhisperRuntime(await findCli(copied.path),context),runtime={id:`whisper-import-${randomUUID()}-cuda`,name:'Whisper · 导入运行包',executable}
      resource={id:randomUUID(),kind:'whisper-runtime',name:runtime.name,path:copied.path,backend:'whisper.cpp',runtimeId:runtime.id,versions:{'whisper.cpp':'导入（配置时验证 GPU）'},bytes:copied.bytes,createdAt:new Date().toISOString(),source:'import',ready:true};context.signal.throwIfAborted();await this.exclusive(async()=>{context.signal.throwIfAborted();if(this.closing)throw new Error('应用正在退出');this.runtimes.push(runtime);await this.save()})
    }else resource=await importPreparedResource(path,request.kind,context,request.kind==='dependencies'?officialAsrCatalog.find(value=>value.id===request.assetId)!.backend:undefined)
    await this.exclusive(async()=>{context.signal.throwIfAborted();if(this.closing)throw new Error('应用正在退出');this.resources.push(resource);await this.save()});return resource
  })}
  cancelDeployment(){this.deploymentController?.abort();this.cancelDownload();if(this.deployment.active){this.deployment={...this.deployment,message:'正在取消部署并清理未完成环境…'};this.update()}}
  async deploymentPlan(input:AsrDeploymentRequest):Promise<import('../../shared/asr-deployment').AsrDeploymentPlan>{
    const request=asrDeploymentRequestSchema.parse(input),detection=await this.detectNvidia(),gpu=detection.devices.find(item=>item.index===request.gpuIndex);if(!gpu)throw new Error(detection.issue??'NVIDIA GPU unavailable');const profile=nvidiaProfile(gpu)
    await this.discoverStoredResources();this.resources=await Promise.all(this.resources.map(item=>item.kind==='whisper-runtime'?item:downloadedResourceStatus(item)));await this.save()
    const backend=request.assetId==='whisper-large-v3'?'whisper.cpp':officialAsrCatalog.find(item=>item.id===request.assetId)!.backend
    const environment=this.environments.find(item=>item.backend===backend&&item.managed?.version===deploymentManifest.version&&item.managed.profile===profile&&item.managed.gpuUuid===gpu.uuid)
    const items:import('../../shared/asr-deployment').AsrDeploymentPlan['items']=[]
    const add=async(name:string,path?:string)=>items.push({name,status:path&&await exists(path)?'reuse':'download',path})
    if(backend==='whisper.cpp')await add('Whisper CUDA',this.runtimes.find(item=>item.id.endsWith('-cuda'))?.executable)
    else if(environment&&await exists(environment.pythonPath))await add('Python / PyTorch / CUDA / Transformers',environment.pythonPath)
    else{await add('Python 3.12',this.resources.find(item=>item.kind==='python'&&item.ready)?.path);await add(backend+' / '+profile,this.resources.find(item=>item.kind==='dependencies'&&item.backend===backend&&item.profile===profile&&item.ready)?.path)}
    await add(request.assetId,this.assets.find(item=>item.id===request.assetId)?.path)
    if(backend==='qwen3-asr'&&request.includeAligner)await add('Qwen ForcedAligner',this.assets.find(item=>item.id==='qwen-aligner')?.path)
    return {checkedAt:new Date().toISOString(),assetId:request.assetId,gpuIndex:gpu.index,profile,items}
  }
  deployNvidia(input:AsrDeploymentRequest):Promise<AsrModel>{
    return this.beginDeployment(asrDeploymentRequestSchema.parse(input))
  }
  configureModel(input:AsrConfigureModelRequest):Promise<AsrModel>{return this.beginDeployment(asrConfigureModelSchema.parse(input),true)}
  private beginDeployment(request:AsrConfigureModelRequest,offline=false):Promise<AsrModel>{
    if(this.closing)throw new Error('应用正在退出');if(this.deploymentController||this.controller)throw new Error('已有 ASR 下载或部署正在进行')
    const controller=new AbortController();this.deploymentController=controller
    this.deployment={active:true,phase:'detecting',assetId:request.assetId,gpuIndex:request.gpuIndex,message:'读取 NVIDIA GPU 与驱动…',logTail:'',startedAt:new Date().toISOString(),logPath:join(this.storageRoot,'logs',`deploy-${randomUUID()}.log`)};this.update()
    const task=this.performDeployment(request,controller.signal,offline).catch(async error=>{
      const detail=JSON.stringify({type:controller.signal.aborted?'cancelled':'deployment-error',phase:this.deployment.phase,message:(error as Error).message})+'\n'
      await mkdir(dirname(this.deployment.logPath!),{recursive:true}).then(()=>appendFile(this.deployment.logPath!,detail)).catch(()=>{})
      this.deployment={...this.deployment,logTail:(this.deployment.logTail+'\n'+detail).slice(-12000)}
      throw error
    })
    this.deploymentTask=task
    void task.then(model=>{this.deployment={...this.deployment,active:false,phase:'completed',message:'部署完成，模型已启用 NVIDIA GPU',modelId:model.id,finishedAt:new Date().toISOString()};this.update()},error=>{this.deployment={...this.deployment,active:false,phase:controller.signal.aborted?'cancelled':'failed',message:controller.signal.aborted?'部署已取消；已完成的模型与环境保留':(error as Error).message,finishedAt:new Date().toISOString()};this.update()}).finally(()=>{this.deploymentController=undefined;this.deploymentTask=undefined})
    return task
  }
  private async performDeployment(request:AsrConfigureModelRequest,signal:AbortSignal,offline=false):Promise<AsrModel>{
    if(!offline){this.deployment.message='Checking reusable local resources before downloads';this.update();await this.deploymentPlan(request as AsrDeploymentRequest);signal.throwIfAborted()}
    const preparedAsset=this.assets.find(value=>value.id===request.assetId&&value.role==='model'),catalogAsset=officialAsrCatalog.find(value=>value.id===request.assetId&&value.role==='model'),whisper=preparedAsset?.backend==='whisper.cpp'||request.assetId==='whisper-large-v3'
    if(offline&&!preparedAsset)throw new Error('请先在资源管理 ASR 页下载或导入目标模型文件')
    if(offline&&preparedAsset?.backend==='qwen3-asr'&&request.includeAligner&&!this.assets.some(value=>value.role==='aligner'&&value.backend==='qwen3-asr'))throw new Error('请先下载或导入 Qwen 对齐模型，或关闭词级对齐')
    const detected=await this.detectNvidia(),gpu=detected.devices.find(value=>value.index===request.gpuIndex);signal.throwIfAborted();if(!gpu)throw new Error(detected.issue??'所选 NVIDIA GPU 不可用')
    const profile=nvidiaProfile(gpu),context:DeploymentContext={root:this.storageRoot,signal,logPath:this.deployment.logPath!,gpu,profile,offline,update:value=>{this.deployment={...this.deployment,...value};this.update()}}
    await requireSpace(this.storageRoot,64*1024**2)
    let environment:AsrEnvironment|undefined,executable:string|undefined
    if(whisper){
      context.update({phase:'runtime',message:'安装 NVIDIA Whisper 运行包'})
      const runtime=this.runtimes.find(value=>value.id==='whisper-b5454-cuda')??this.runtimes.find(value=>value.id.endsWith('-cuda'))
      if(!runtime&&offline)throw new Error('请先在环境页下载或导入 Whisper CUDA 运行包')
      if(!runtime)await this.install('runtime','cuda',true);signal.throwIfAborted();executable=runtime?.executable??this.runtime('whisper-b5454-cuda')
      context.update({phase:'model',message:'准备官方 Whisper large-v3 模型'})
      if(!offline&&!this.assets.some(value=>value.id===request.assetId))await this.install('model','cuda',true)
    }else{
      const asset=preparedAsset??catalogAsset;if(!asset||!pythonAsrBackends.includes(asset.backend as typeof pythonAsrBackends[number]))throw new Error('目标模型后端不支持 NVIDIA 环境配置');const backend=asset.backend as typeof pythonAsrBackends[number]
      const previous=this.environments.find(value=>value.backend===backend&&value.managed?.version===deploymentManifest.version&&value.managed.profile===profile&&value.managed.gpuUuid===gpu.uuid&&isWithin(this.storageRoot,value.managed.directory)&&isWithin(value.managed.directory,value.pythonPath))
      let prepared:PreparedEnvironment|undefined
      if(previous){try{prepared={directory:previous.managed!.directory,pythonPath:previous.pythonPath,probe:await verifyNvidiaEnvironment(previous.pythonPath,backend,this.adapterPath,context)}}catch(error){signal.throwIfAborted();context.update({message:'已有自动环境检查未通过，准备新的独立环境',logTail:String(error)})}}
      if(!prepared){
        if(!offline){
          if(!this.resources.some(item=>item.kind==='python'&&item.ready)){const resource=await downloadPythonResource(context);this.resources.push(resource);await this.save()}
          if(!this.resources.some(item=>item.kind==='dependencies'&&item.backend===backend&&item.profile===profile&&item.ready)){const resource=await downloadDependencyResource(backend,this.resources,context);this.resources.push(resource);await this.save()}
        }
        prepared=await prepareOfflineNvidiaPython(backend,this.adapterPath,this.resources,context)
      }
      signal.throwIfAborted()
      environment=asrEnvironmentSchema.parse({...previous,id:previous?.id??randomUUID(),name:backend+' · NVIDIA 自动部署',backend,pythonPath:prepared.pythonPath,probe:prepared.probe,createdAt:previous?.createdAt??new Date().toISOString(),managed:{version:deploymentManifest.version,profile,gpuUuid:gpu.uuid,directory:prepared.directory}})
      await this.exclusive(async()=>{this.environments=[...this.environments.filter(value=>value.id!==environment!.id),environment!];await this.save()})
      context.update({phase:'model',message:'准备官方模型与对齐资源'})
      if(!offline&&!this.assets.some(value=>value.id===request.assetId))await this.downloadModel(request.assetId,true)
      if(!offline&&backend==='qwen3-asr'&&request.includeAligner&&!this.assets.some(value=>value.id==='qwen-aligner'))await this.downloadModel('qwen-aligner',true)
      signal.throwIfAborted()
      if(backend==='qwen3-asr'&&request.includeAligner){environment={...environment,alignerPath:this.assets.find(value=>value.id==='qwen-aligner')?.path??this.assets.find(value=>value.role==='aligner'&&value.backend==='qwen3-asr')?.path};await this.exclusive(async()=>{this.environments=this.environments.map(value=>value.id===environment!.id?environment!:value);await this.save()})}
    }
    signal.throwIfAborted();const asset=this.assets.find(value=>value.id===request.assetId);if(!asset)throw new Error('模型资源未完成下载')
    if(whisper){
      context.update({phase:'verifying',message:'验证 Whisper 模型加载与实际 NVIDIA 推理'})
      const directory=join(this.storageRoot,`.transfer-${randomUUID()}`);await mkdir(directory,{recursive:true})
      try{
        const wav=Buffer.alloc(44+32000);wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32000,40);const audio=join(directory,'gpu-check.wav');await writeFile(audio,wav)
        const result=await deploymentCommand(executable!,['--model',asset.path,'--file',audio,'--language','en','--threads','4','--beam-size','1','--output-json-full','--output-file',join(directory,'check')],context,300000)
        const logs=await readFile(context.logPath,'utf8');if(!/CUDA\d+ backend|using CUDA|using GPU/i.test(logs+result))throw new Error('Whisper 未实际启用 NVIDIA GPU；请使用兼容配置')
      }finally{if(!isWithin(this.storageRoot,directory))throw new Error('无效部署校验目录');await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200})}
    }
    signal.throwIfAborted();context.update({phase:'verifying',message:'绑定模型到 ASR 工作台'})
    const old=this.models.find(value=>value.backend===asset.backend&&value.modelPath===asset.path),model=old??await this.import({name:asset.name,backend:asset.backend as AsrModel['backend'],modelPath:asset.path,environmentId:environment?.id,executable},true)
    await this.exclusive(async()=>{this.models=this.models.map(value=>value.id===model.id?{...value,environmentId:environment?.id,executable:environment?.pythonPath??executable!,nvidiaDeviceUuid:gpu.uuid,availability:'ready',issue:undefined,recognition:asrRecognitionSchema.parse({...value.recognition,device:'gpu',parameters:parseAsrParameters(value.backend,{...value.recognition?.parameters,...(environment?{gpuIndex:0}:{}),...(value.backend==='qwen3-asr'?{timestamps:request.includeAligner}: {})})})}:value);await this.save()})
    return this.get(model.id)
  }
  async install(kind:'model'|'runtime',runtime:'cpu'|'cuda'='cpu',internal=false):Promise<void>{
    this.guardDeployment(internal)
    if(this.controller)throw new Error('已有 ASR 下载正在进行')
    if(this.closing)throw new Error('应用正在退出')
    if(kind==='runtime'&&(process.platform!=='win32'||process.arch!=='x64'))throw new Error('自动运行包下载仅支持 Windows x64，请导入本地运行程序')
    this.controller=new AbortController();const signal=this.controller.signal
    this.downloading=this.downloadAsset(kind,runtime,signal,internal)
    try{await this.downloading}catch(error){this.download={...this.download,active:false,phase:signal.aborted?'cancelled':'failed',message:signal.aborted?'下载已取消':(error as Error).message};this.update();if(!signal.aborted)throw error}
    finally{this.controller=undefined;this.downloading=undefined}
  }
  cancelDownload():void{this.controller?.abort();this.deploymentController?.abort()}
  async deploymentLog(){const path=this.deployment.logPath;if(!path||!await exists(path))return this.deployment.message;const actual=await realpath(path);if(!isWithin(join(this.storageRoot,'logs'),actual)||(await stat(actual)).size>8*1024**2)throw new Error('部署日志无法读取');return readFile(actual,'utf8')}
  private async downloadAsset(kind:'model'|'runtime',runtime:'cpu'|'cuda',signal:AbortSignal,skipBinding=false):Promise<void>{
    const asset=kind==='model'?largeV3Catalog:whisperRuntimeCatalog[runtime],id=kind==='model'?'whisper-large-v3':`whisper-b5454-${runtime}`,target=join(this.storageRoot,kind==='model'?'models':'runtimes',id)
    if(await exists(target))throw new Error('此资源已存在；请导入现有资源或选择其他运行包')
    await requireSpace(this.storageRoot,kind==='model'?asset.size:asset.size*4)
    const staging=join(this.storageRoot,`.download-${randomUUID()}`);await mkdir(staging,{recursive:true})
    const set=(state:Partial<AsrDownload>)=>{this.download={...this.download,...state};this.update()}
    set({active:true,phase:'downloading',label:asset.name,percent:0,received:0,total:asset.size,message:'正在连接下载源'})
    try{
      const response=await fetchDownload(asset.url,{signal,label:asset.name,onRetry:message=>set({message})})
      if(!response.ok||!response.body)throw new Error(`下载失败：HTTP ${response.status}`)
      let received=0,last=0;const hash=createHash('sha256'),file=join(staging,kind==='model'?largeV3Catalog.file:'runtime.zip')
      const meter=new Transform({transform(chunk:Buffer,_encoding,done){received+=chunk.length;if(received>asset.size){done(new Error('下载大小与清单不符'));return}hash.update(chunk);if(Date.now()-last>200){last=Date.now();set({received,percent:Math.min(99,received/asset.size*100),message:`已下载 ${(received/1024**2).toFixed(0)} / ${(asset.size/1024**2).toFixed(0)} MB`})}done(null,chunk)}})
      await pipeline(Readable.fromWeb(response.body as never),meter,createWriteStream(file,{flags:'wx'}),{signal})
      set({phase:'verifying',received,percent:100,message:'正在核对 SHA-256'})
      if(received!==asset.size||hash.digest('hex')!==asset.sha256)throw new Error('下载文件校验失败，未安装')
      signal.throwIfAborted()
      let executable:string|undefined
      if(kind==='runtime'){
        set({phase:'extracting',message:'正在解压并验证运行包'})
        const extracted=join(staging,'extracted');await extractZip(file,extracted,2*1024**3)
        executable=await findCli(extracted);await verifyWhisperRuntime(executable);signal.throwIfAborted()
        await mkdir(dirname(target),{recursive:true});await rename(extracted,target);executable=resolve(target,executable.slice(extracted.length+1))
        await this.exclusive(async()=>{this.runtimes=[...this.runtimes.filter(value=>value.id!==id),{id,name:asset.name,executable:executable!}];await this.save()})
      }else{
        await verifyWhisperModel(file);await mkdir(dirname(target),{recursive:true});await rename(staging,target)
      }
      set({active:false,phase:'completed',message:kind==='model'?`模型已下载：${join(target,largeV3Catalog.file)}。请选择运行包后导入。`:'运行包已安装',percent:100})
      if(kind==='model'){
        await this.exclusive(async()=>{this.assets.push({id,name:asset.name,backend:'whisper.cpp',role:'model',path:join(target,largeV3Catalog.file),bytes:asset.size,createdAt:new Date().toISOString()});await this.save()})
        // A model download only stages files. Configuring its runtime and GPU
        // is an explicit operation from resource management.
      }
    }catch(error){throw explainDownloadError(error,asset.url,asset.name)}finally{if(!isWithin(this.storageRoot,staging)||!staging.startsWith(join(this.storageRoot,'.download-')))throw new Error('拒绝清理非 ASR 临时目录');await rm(staging,{recursive:true,force:true})}
  }
  async shutdown():Promise<void>{this.closing=true;this.environmentChecks.abort();this.cancelDeployment();this.cancelDownload();await this.deploymentTask?.catch(()=>{});await this.discoveryTask?.catch(()=>{});await this.downloading?.catch(()=>{});await this.operation.catch(()=>{});await this.store.flush()}
}
async function findCli(root:string,depth=0):Promise<string>{
  if(depth>3)throw new Error('运行包中没有 whisper-cli.exe')
  const files=await readdir(root,{withFileTypes:true});const match=files.find(f=>f.isFile()&&f.name==='whisper-cli.exe');if(match)return join(root,match.name)
  for(const file of files.filter(f=>f.isDirectory())){try{return await findCli(join(root,file.name),depth+1)}catch{}}
  throw new Error('运行包中没有 whisper-cli.exe')
}
