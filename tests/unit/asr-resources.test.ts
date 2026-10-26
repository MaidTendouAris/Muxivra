import { afterEach,describe,expect,it,vi } from 'vitest'
import { createHash,randomUUID } from 'node:crypto'
import { mkdir,mkdtemp,readFile,readdir,rm,stat,writeFile } from 'node:fs/promises'
import { dirname,join,resolve } from 'node:path'
import * as deployment from '../../src/core/asr/deployment'
import * as nvidia from '../../src/core/asr/nvidia'
import * as asrResources from '../../src/core/asr/resources'
import { downloadDependencyResource,dependencyRequirements,importPreparedResource,prepareOfflineNvidiaPython,readResourceManifest,type ResourceManifest } from '../../src/core/asr/resources'
import { AsrModels } from '../../src/core/asr/models'
import { asrResourceRequestSchema,type AsrResource,type NvidiaDevice } from '../../src/shared/asr-deployment'
import type { AsrProbe } from '../../src/shared/asr-environments'
import { isWithin } from '../../src/core/media/paths'

const gpu:NvidiaDevice={index:0,uuid:'GPU-resource-fixture',name:'RTX fixture',driver:'576.52',computeMajor:8,computeMinor:6,totalBytes:8*1024**3,freeBytes:7*1024**3}
const probe:AsrProbe={ready:true,python:'3.12.13',platform:'win32',versions:{torch:'2.8.0+cu126',cuda:'12.6',transformers:'4.57.6'},cudaAvailable:true,devices:[],issues:[],warnings:[],checkedAt:new Date().toISOString(),vllm:false}
const hash=(data:string)=>createHash('sha256').update(data).digest('hex')
afterEach(()=>vi.restoreAllMocks())
async function local(run:(root:string)=>Promise<void>){await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data','asr-resources-'));try{await run(root)}finally{if(!isWithin(resolve('.test-data'),root))throw new Error('Unsafe cleanup');await rm(root,{recursive:true,force:true})}}
function context(root:string){return {root,gpu,profile:'cu126' as const,signal:new AbortController().signal,logPath:join(root,'logs','resource.log'),update:vi.fn()}}
async function bundle(path:string,kind:'python'|'dependencies'):Promise<AsrResource>{
  await mkdir(path,{recursive:true});const files=kind==='python'?{'python/python.exe':'interpreter','uv.exe':'tool'}:{'wheels/fixture-1.0-py3-none-any.whl':'wheel'},manifest:ResourceManifest={format:'muxivra-asr-resource',version:1,kind,versions:kind==='python'?{python:'3.12.13',uv:'0.13.1'}:{torch:'2.8.0+cu126',cuda:'12.6',transformers:'4.57.6'},...(kind==='python'?{python:'python/python.exe',uv:'uv.exe'}:{backend:'qwen3-asr' as const,profile:'cu126' as const,requirements:['fixture==1.0']}),files:[]}
  for(const [name,data] of Object.entries(files)){await mkdir(dirname(join(path,name)),{recursive:true});await writeFile(join(path,name),data!);manifest.files.push({path:name,bytes:Buffer.byteLength(data!),sha256:hash(data!)})}
  await writeFile(join(path,'muxivra-resource.json'),JSON.stringify(manifest));return {id:randomUUID(),kind,name:kind,path,versions:manifest.versions,bytes:manifest.files.reduce((sum,file)=>sum+file.bytes,0),createdAt:new Date().toISOString(),source:'download',ready:true,backend:manifest.backend,profile:manifest.profile}
}
describe('separate ASR resources and offline configuration',()=>{
  it('requires an explicit supported target for dependency resources',()=>{
    expect(()=>asrResourceRequestSchema.parse({kind:'dependencies'})).toThrow();expect(()=>asrResourceRequestSchema.parse({kind:'dependencies',assetId:'whisper-large-v3'})).toThrow();expect(()=>asrResourceRequestSchema.parse({kind:'dependencies',assetId:'mimo-v2.5-asr'})).toThrow();expect(asrResourceRequestSchema.parse({kind:'python'})).toEqual({kind:'python',gpuIndex:0})
  })
  it('keeps conflicting Transformers stacks isolated while preparing reusable CUDA wheel files',()=>local(async root=>{
    expect(dependencyRequirements('qwen3-asr','cu126')).toContain('transformers==4.57.6');expect(dependencyRequirements('moss-transcribe-diarize','cu126')).toContain('transformers==5.19.0');expect(dependencyRequirements('qwen3-asr','cu128')).toContain('torch==2.8.0+cu128')
    const storage=join(root,'asr'),python=await bundle(join(storage,'components','python'),'python'),command=vi.spyOn(deployment,'deploymentCommand').mockImplementation(async(_exe,args)=>{
      if(args.includes('wheel')&&args.includes('--wheel-dir')){const directory=args[args.indexOf('--wheel-dir')+1];await writeFile(join(directory,'fixture-1.0-py3-none-any.whl'),'same immutable wheel')}
      return args.includes('-c')?JSON.stringify({fixture:'1.0',torch:'2.8.0+cu126',cuda:'12.6',transformers:'4.57.6'}):''
    })
    const first=await downloadDependencyResource('qwen3-asr',[python],context(storage)),second=await downloadDependencyResource('qwen3-asr',[python],context(storage)),firstWheel=join(first.path,'wheels','fixture-1.0-py3-none-any.whl'),secondWheel=join(second.path,'wheels','fixture-1.0-py3-none-any.whl')
    expect(first.path).not.toBe(second.path);expect(first.versions).toMatchObject({torch:'2.8.0+cu126',cuda:'12.6'});expect(await readFile(firstWheel,'utf8')).toBe('same immutable wheel');expect((await stat(firstWheel)).ino).toBe((await stat(secondWheel)).ino);expect((await stat(firstWheel)).nlink).toBeGreaterThanOrEqual(3)
    const install=command.mock.calls.filter(([,args])=>args.includes('install'));expect(install.some(([,args])=>args.includes('--offline')&&args.includes('--no-index'))).toBe(true);expect((await readdir(storage)).some(name=>name.startsWith('.transfer-'))).toBe(false)
  }))
  it('verifies every listed byte and rejects traversal, duplicate files and unlisted executables',()=>local(async root=>{
    const resource=await bundle(join(root,'fixture'),'python'),file=join(resource.path,'muxivra-resource.json'),original=JSON.parse(await readFile(file,'utf8'))
    await expect(readResourceManifest(resource.path)).resolves.toMatchObject({kind:'python'})
    await writeFile(join(resource.path,'uv.exe'),'evil');await expect(readResourceManifest(resource.path)).rejects.toThrow('校验失败');await writeFile(join(resource.path,'uv.exe'),'tool')
    for(const manifest of [{...original,files:[{...original.files[0],path:'../escape.exe'}]},{...original,files:[...original.files,original.files[0]]},{...original,uv:'unlisted.exe'}]){await writeFile(file,JSON.stringify(manifest));await expect(readResourceManifest(resource.path)).rejects.toThrow()}
    await expect(readFile(join(root,'escape.exe'))).rejects.toThrow()
  }))
  it('imports a complete compatible wheelhouse into installation storage without executing or downloading anything',()=>local(async root=>{
    const resource=await bundle(join(root,'external-bundle'),'dependencies'),installation=join(root,'installation','asr'),request=vi.spyOn(globalThis,'fetch'),command=vi.spyOn(deployment,'deploymentCommand')
    const imported=await importPreparedResource(resource.path,'dependencies',context(installation),'qwen3-asr');expect(isWithin(join(installation,'components'),imported.path)).toBe(true);expect(imported.source).toBe('import');expect(await readResourceManifest(imported.path)).toMatchObject({backend:'qwen3-asr',profile:'cu126'});expect(await readFile(join(resource.path,'wheels','fixture-1.0-py3-none-any.whl'),'utf8')).toBe('wheel');expect(request).not.toHaveBeenCalled();expect(command).not.toHaveBeenCalled()
    await expect(importPreparedResource(resource.path,'dependencies',{...context(installation),profile:'cu128'},'qwen3-asr')).rejects.toThrow('不匹配')
  }))
  it('creates a new isolated environment entirely from verified local wheels and checks CUDA before completion',()=>local(async root=>{
    const storage=join(root,'installation','asr'),resources=[await bundle(join(storage,'components','python'),'python'),await bundle(join(storage,'components','dependencies'),'dependencies')],request=vi.spyOn(globalThis,'fetch'),command=vi.spyOn(deployment,'deploymentCommand').mockImplementation(async(_exe,args,operation)=>{
      expect(operation.offline).toBe(true)
      if(args.includes('venv')){const directory=args.at(-1)!;await mkdir(join(directory,'Scripts'),{recursive:true});await writeFile(join(directory,'Scripts','python.exe'),'new isolated interpreter')}
      return ''
    }),verify=vi.spyOn(deployment,'verifyNvidiaEnvironment').mockResolvedValue(probe)
    const prepared=await prepareOfflineNvidiaPython('qwen3-asr','adapter.py',resources,context(storage));expect(isWithin(join(storage,'environments'),prepared.directory)).toBe(true);expect(prepared.probe.versions.cuda).toBe('12.6');expect(verify).toHaveBeenCalledOnce();expect(request).not.toHaveBeenCalled()
    const install=command.mock.calls.find(([,args])=>args.includes('install'))![1];expect(install).toContain('--offline');expect(install).toContain('--no-index');expect(install).toContain('--find-links');expect(install).toContain('--require-hashes');expect(install.some(arg=>arg.startsWith('https:'))).toBe(false);expect(await readFile(join(prepared.directory,'muxivra-requirements.txt'),'utf8')).toBe('fixture==1.0 --hash=sha256:'+hash('wheel')+'\n');expect(JSON.parse(await readFile(join(prepared.directory,'muxivra-managed.json'),'utf8'))).toMatchObject({pythonResource:resources[0].id,dependencyResource:resources[1].id})
  }))
  it('refuses missing resources before any installation, and cleans only an incomplete owned environment on failure',()=>local(async root=>{
    const storage=join(root,'asr'),python=await bundle(join(storage,'components','python'),'python'),command=vi.spyOn(deployment,'deploymentCommand').mockResolvedValue(''),request=vi.spyOn(globalThis,'fetch')
    await expect(prepareOfflineNvidiaPython('qwen3-asr','adapter.py',[],context(storage))).rejects.toThrow('Python 资源');await expect(prepareOfflineNvidiaPython('qwen3-asr','adapter.py',[python],context(storage))).rejects.toThrow('依赖资源');expect(command).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled()
    const dependency=await bundle(join(storage,'components','dependencies'),'dependencies');command.mockImplementation(async(_exe,args)=>{if(args.includes('venv')){await mkdir(args.at(-1)!,{recursive:true});return ''}throw new Error('offline fixture failed')})
    await expect(prepareOfflineNvidiaPython('qwen3-asr','adapter.py',[python,dependency],context(storage))).rejects.toThrow('offline fixture failed');expect(await readdir(join(storage,'environments'))).toEqual([]);expect(await readResourceManifest(python.path)).toMatchObject({kind:'python'})
  }))
  it('stages imported models without registering a runnable model, and never downloads when configure prerequisites are missing',()=>local(async root=>{
    const source=join(root,'source');await mkdir(source,{recursive:true});await writeFile(join(source,'config.json'),JSON.stringify({model_type:'qwen3_asr'}));await writeFile(join(source,'model.safetensors'),'weights')
    const models=new AsrModels(join(root,'data'),()=>{},'adapter.py',join(root,'installation'));await models.initialize();vi.spyOn(nvidia,'detectNvidia').mockResolvedValue({devices:[gpu],checkedAt:new Date().toISOString()});const request=vi.spyOn(globalThis,'fetch')
    try{
      const staged=await models.importModelAsset({backend:'qwen3-asr',name:'Local Qwen',modelPath:source});expect(isWithin(models.storageRoot,staged.path)).toBe(true);expect(models.state().assets).toHaveLength(1);expect(models.state().models).toEqual([])
      await expect(models.configureModel({assetId:staged.id,gpuIndex:0,includeAligner:false})).rejects.toThrow('Python 资源');expect(models.state().models).toEqual([]);expect(models.state().environments).toEqual([]);expect(request).not.toHaveBeenCalled();expect(await readFile(join(source,'model.safetensors'),'utf8')).toBe('weights')
    }finally{await models.shutdown()}
  }))
  it('discovers prepared bundles and orphan managed environments from the installation directory',()=>local(async root=>{
    const storage=join(root,'installation','asr'),resource=await bundle(join(storage,'components','existing-python'),'python'),environment=join(storage,'environments','managed-qwen-old'),pythonPath=join(environment,'Scripts','python.exe');await mkdir(dirname(pythonPath),{recursive:true});await writeFile(pythonPath,'fixture');await writeFile(join(environment,'muxivra-managed.json'),JSON.stringify({version:deployment.deploymentManifest.version,backend:'qwen3-asr',profile:'cu126',gpuUuid:gpu.uuid,createdAt:new Date().toISOString()}))
    const metadata=join(environment,'Lib','site-packages','torch-2.8.0.dist-info','METADATA');await mkdir(dirname(metadata),{recursive:true});await writeFile(metadata,'Name: torch\nVersion: 2.8.0+cu126\n');await writeFile(join(environment,'pyvenv.cfg'),'version = 3.12.13\n')
    const models=new AsrModels(join(root,'data'),()=>{},'adapter.py',join(root,'installation')),inspect=vi.spyOn(models as unknown as {checkEnvironment:()=>Promise<typeof probe>},'checkEnvironment')
    try{await models.initialize();expect(models.state().resources).toHaveLength(1);expect(models.state().resources?.[0]).toMatchObject({path:resource.path,ready:true,versions:{python:'3.12.13'}});expect(models.state().environments?.[0]).toMatchObject({pythonPath,probe:{ready:false,python:'3.12.13',versions:{torch:'2.8.0+cu126'}},managed:{directory:environment}});expect(inspect).not.toHaveBeenCalled();expect(models.state().models).toEqual([])}finally{await models.shutdown()}
  }))
  it('preserves cancellation when starting a second resource operation immediately after the first',()=>local(async root=>{
    const models=new AsrModels(join(root,'data'),()=>{},'adapter.py',join(root,'installation')),resource=await bundle(join(models.storageRoot,'components','python'),'python');await models.initialize();let enter!:()=>void;const entered=new Promise<void>(done=>{enter=done})
    vi.spyOn(asrResources,'downloadPythonResource').mockResolvedValueOnce(resource).mockImplementationOnce(async context=>{enter();await new Promise<void>((_done,reject)=>context.signal.addEventListener('abort',()=>reject(new Error('Cancelled second resource')),{once:true}));throw new Error('unreachable')})
    try{await models.downloadResource({kind:'python',gpuIndex:0});const task=models.downloadResource({kind:'python',gpuIndex:0});await entered;models.cancelDeployment();await expect(task).rejects.toThrow('Cancelled second resource');expect(models.state().deployment).toMatchObject({active:false,phase:'cancelled'})}finally{await models.shutdown()}
  }))
  it('preserves a shared Qwen aligner when configuring a second model without alignment',()=>local(async root=>{
    const storage=join(root,'installation','asr'),environmentDirectory=join(storage,'environments','managed-qwen'),pythonPath=join(environmentDirectory,'Scripts','python.exe'),id=randomUUID(),assets=[]
    await mkdir(dirname(pythonPath),{recursive:true});await writeFile(pythonPath,'fixture');const aligner=join(storage,'models','aligner');await mkdir(aligner,{recursive:true})
    for(const target of ['qwen-0.6b','qwen-1.7b']){const path=join(storage,'models',target);await mkdir(path,{recursive:true});await writeFile(join(path,'config.json'),JSON.stringify({model_type:'qwen3_asr'}));await writeFile(join(path,'model.safetensors'),'weights');assets.push({id:target,name:target,backend:'qwen3-asr',role:'model',path,bytes:7,createdAt:new Date().toISOString()})}
    assets.push({id:'qwen-aligner',name:'Aligner',backend:'qwen3-asr',role:'aligner',path:aligner,bytes:0,createdAt:new Date().toISOString()});const data=join(root,'data');await mkdir(join(data,'asr'),{recursive:true});await writeFile(join(data,'asr','models.json'),JSON.stringify({version:1,models:[],runtimes:[],assets,environments:[{id,name:'Shared Qwen',backend:'qwen3-asr',pythonPath,probe,createdAt:new Date().toISOString(),managed:{version:deployment.deploymentManifest.version,profile:'cu126',gpuUuid:gpu.uuid,directory:environmentDirectory}}]}))
    vi.spyOn(nvidia,'detectNvidia').mockResolvedValue({devices:[gpu],checkedAt:new Date().toISOString()});vi.spyOn(deployment,'verifyNvidiaEnvironment').mockResolvedValue(probe);const models=new AsrModels(data,()=>{},'adapter.py',join(root,'installation'))
    try{await models.initialize();const first=await models.configureModel({assetId:'qwen-0.6b',gpuIndex:0,includeAligner:true});await new Promise(done=>setTimeout(done,0));const second=await models.configureModel({assetId:'qwen-1.7b',gpuIndex:0,includeAligner:false});expect(first.environmentId).toBe(second.environmentId);expect(models.get(first.id).environment?.alignerPath).toBe(aligner);expect(models.get(first.id).recognition?.parameters?.timestamps).toBe(true);expect(models.get(second.id).recognition?.parameters?.timestamps).toBe(false)}finally{await models.shutdown()}
  }))
})
