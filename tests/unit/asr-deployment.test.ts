import * as resources from '../../src/core/asr/resources'
import { afterEach,describe,expect,it,vi } from 'vitest'
import { createHash,randomUUID } from 'node:crypto'
import { mkdir,mkdtemp,readFile,readdir,rm,writeFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import * as nvidia from '../../src/core/asr/nvidia'
import * as deployment from '../../src/core/asr/deployment'
import { nvidiaProfile,asrDeploymentRequestSchema,type NvidiaDevice } from '../../src/shared/asr-deployment'
import { AsrModels } from '../../src/core/asr/models'
import { officialAsrCatalog } from '../../src/shared/asr-catalog'
import { isWithin } from '../../src/core/media/paths'

const gpu:NvidiaDevice={index:0,uuid:'GPU-1234-abcd',name:'RTX 3060 Laptop GPU',driver:'576.52',computeMajor:8,computeMinor:6,totalBytes:6*1024**3,freeBytes:5*1024**3}
const probe={ready:true,python:'3.12.13',platform:'win32',versions:{torch:'2.8.0+cu126'},cudaAvailable:true,devices:[{name:gpu.name,totalBytes:gpu.totalBytes,freeBytes:gpu.freeBytes}],issues:[],warnings:[],checkedAt:new Date().toISOString(),vllm:false}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs()})
async function local(run:(root:string)=>Promise<void>){await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data','asr-deployment-'));try{await run(root)}finally{if(!isWithin(resolve('.test-data'),root))throw new Error('Unsafe test cleanup');await rm(root,{recursive:true,force:true})}}
describe('NVIDIA deployment',()=>{
  it('never switches tool sources after a checksum failure',()=>local(async root=>{
    const request=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(Buffer.alloc(deployment.deploymentManifest.uv.size)))
    await expect(deployment.prepareDeploymentTool({root,gpu,profile:'cu126',signal:new AbortController().signal,logPath:join(root,'logs','fixture.log'),update:()=>{}})).rejects.toThrow('校验失败')
    expect(request).toHaveBeenCalledTimes(1);expect((await readdir(join(root,'cache','downloads'))).length).toBe(0)
  }))
  it('reads 64-bit VRAM and selects supported architectures and driver profiles',()=>{
    const devices=nvidia.parseNvidiaDevices('0, GPU-1234-abcd, NVIDIA GeForce RTX 3060 Laptop GPU, 576.52, 8.6, 6144, 5120\n1, GPU-5678-abcd, RTX 5090, 576.52, 12.0, 32768, 30000')
    expect(devices[0].totalBytes).toBe(6*1024**3);expect(nvidiaProfile(devices[0])).toBe('cu126');expect(nvidiaProfile(devices[1])).toBe('cu128')
    expect(()=>nvidiaProfile({...gpu,computeMajor:6,computeMinor:1})).toThrow('完整驱动');expect(()=>nvidiaProfile({...gpu,driver:'551.0'})).toThrow('更新');expect(()=>nvidia.parseNvidiaDevices('0, N/A, unknown, N/A, N/A, N/A, N/A')).toThrow()
    expect(()=>asrDeploymentRequestSchema.parse({assetId:'mimo-v2.5-asr'})).toThrow()
  })
  it('isolates install/cache/temp paths and ignores inherited package indexes and Python configuration',()=>{
    for(const key of ['PYTHONPATH','PYTHONHOME','PIP_EXTRA_INDEX_URL','UV_DEFAULT_INDEX','UV_PYTHON','UV_NO_MANAGED_PYTHON'])vi.stubEnv(key,'inherited-setting')
    const root=resolve('.test-data','installation','asr'),env=deployment.deploymentEnvironment(root,gpu.uuid)
    for(const key of ['PYTHONPATH','PYTHONHOME','PIP_EXTRA_INDEX_URL','UV_DEFAULT_INDEX','UV_PYTHON','UV_NO_MANAGED_PYTHON'])expect(env[key]).toBeUndefined()
    for(const key of ['UV_CACHE_DIR','UV_PYTHON_INSTALL_DIR','UV_PYTHON_BIN_DIR','UV_TOOL_DIR','PIP_CACHE_DIR','HF_HOME','TORCH_HOME','TORCH_EXTENSIONS_DIR','NUMBA_CACHE_DIR','MPLCONFIGDIR','GRADIO_TEMP_DIR','TEMP','TMP','PYTHONUSERBASE','PYTHONPYCACHEPREFIX'])expect(isWithin(root,env[key]!)).toBe(true)
    expect(env.UV_LINK_MODE).toBe('hardlink');expect(env.CUDA_VISIBLE_DEVICES).toBe(gpu.uuid);expect(env.PYTHONNOUSERSITE).toBe('1');expect(env.UV_SYSTEM_CERTS).toBe('true')
  })
  it('verifies and repairs owned deployment archives; never publishes corrupt or cancelled data',()=>local(async root=>{
    const target=join(root,'cache','downloads','fixture.zip'),data=Buffer.from('official component'),asset={url:'https://example.invalid/fixture.zip',size:data.length,sha256:createHash('sha256').update(data).digest('hex')},controller=new AbortController(),context={root,gpu,profile:'cu126' as const,signal:controller.signal,logPath:join(root,'logs','fixture.log'),update:()=>{}}
    await mkdir(join(root,'cache','downloads'),{recursive:true});await writeFile(target,'corrupt cache')
    const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(data));await deployment.deploymentArchive(asset,target,context);expect(await readFile(target)).toEqual(data);expect(fetch).toHaveBeenCalledTimes(1)
    await deployment.deploymentArchive(asset,target,context);expect(fetch).toHaveBeenCalledTimes(1)
    fetch.mockResolvedValue(new Response(Buffer.alloc(data.length)));await expect(deployment.deploymentArchive(asset,join(root,'cache','downloads','bad.zip'),context)).rejects.toThrow('校验失败');expect(await readdir(join(root,'cache','downloads'))).toEqual(['fixture.zip'])
    controller.abort();await expect(deployment.deploymentArchive(asset,join(root,'cache','downloads','cancelled.zip'),context)).rejects.toThrow();expect(await readdir(join(root,'cache','downloads'))).toEqual(['fixture.zip'])
  }))
  it('disables legacy MiMo configuration without deleting its metadata or model files',()=>local(async root=>{
    await mkdir(join(root,'asr'));const model={id:randomUUID(),backend:'mimo-v2.5-asr',modelPath:join(root,'model.bin')};await writeFile(model.modelPath,'original weights');await writeFile(join(root,'asr','models.json'),JSON.stringify({version:1,runtimes:[],models:[model],environments:[{backend:model.backend}],assets:[{backend:model.backend}]}))
    const models=new AsrModels(root,()=>{});try{await models.initialize();expect(models.state().models).toEqual([]);expect(models.state().environments).toEqual([]);const saved=JSON.parse(await readFile(join(root,'asr','models.json'),'utf8'));expect(saved.disabled.models).toEqual([model]);expect(await readFile(model.modelPath,'utf8')).toBe('original weights')}finally{await models.shutdown()}
  }))
  it('reuses a verified managed environment, binds official assets and enforces the selected GPU',()=>local(async root=>{
    const asset=officialAsrCatalog.find(value=>value.id==='qwen-0.6b')!,directory=join(root,'asr','models','qwen'),environmentDirectory=join(root,'asr','environments','qwen'),pythonPath=join(environmentDirectory,'python.exe'),id=randomUUID()
    await mkdir(directory,{recursive:true});await mkdir(environmentDirectory,{recursive:true});await writeFile(pythonPath,'fixture');await writeFile(join(directory,'config.json'),JSON.stringify({model_type:'qwen3_asr'}));await writeFile(join(directory,'model.safetensors'),'weights')
    await writeFile(join(root,'asr','models.json'),JSON.stringify({version:1,models:[],runtimes:[],assets:[{...asset,path:directory,createdAt:new Date().toISOString()}],environments:[{id,name:'Managed fixture',backend:'qwen3-asr',pythonPath,createdAt:new Date().toISOString(),probe,managed:{version:deployment.deploymentManifest.version,profile:'cu126',gpuUuid:gpu.uuid,directory:environmentDirectory}}]}))
    // Catalog-only fields are not persisted in managed records.
    const file=join(root,'asr','models.json'),config=JSON.parse(await readFile(file,'utf8'));delete config.assets[0].license;delete config.assets[0].file;await writeFile(file,JSON.stringify(config))
    vi.spyOn(nvidia,'detectNvidia').mockResolvedValue({devices:[gpu],checkedAt:new Date().toISOString()});vi.spyOn(deployment,'verifyNvidiaEnvironment').mockResolvedValue(probe)
    const models=new AsrModels(root,()=>{});try{await models.initialize();const model=await models.deployNvidia({assetId:'qwen-0.6b',gpuIndex:0,includeAligner:false});expect(model.recognition).toMatchObject({device:'gpu',parameters:{gpuIndex:0,timestamps:false}});expect(model.nvidiaDeviceUuid).toBe(gpu.uuid);expect(model.environment?.managed?.directory).toBe(environmentDirectory);expect(models.state().deployment?.phase).toBe('completed')}finally{await models.shutdown()}
  }))
  it('checks downloaded Python, dependencies and model before deployment and reuses them without network',()=>local(async root=>{
    const asset=officialAsrCatalog.find(value=>value.id==='qwen-0.6b')!,directory=join(root,'asr','models','qwen'),environmentDirectory=join(root,'asr','environments','reused'),pythonPath=join(environmentDirectory,'python.exe'),records=[]
    await mkdir(directory,{recursive:true});await mkdir(environmentDirectory,{recursive:true});await writeFile(pythonPath,'fixture');await writeFile(join(directory,'config.json'),'{"model_type":"qwen3_asr"}');await writeFile(join(directory,'model.safetensors'),'weights')
    for(const kind of ['python','dependencies'] as const){const path=join(root,'asr','components',kind);await mkdir(path,{recursive:true});const files=kind==='python'?['python.exe','uv.exe']:['test-1.0-py3-none-any.whl'];for(const name of files)await writeFile(join(path,name),'x');const versions={python:'3.12.13'},manifest={format:'muxivra-asr-resource',version:1,kind,versions,files:files.map(name=>({path:name,bytes:1,sha256:'a'.repeat(64)})),...(kind==='python'?{python:'python.exe',uv:'uv.exe'}:{backend:'qwen3-asr',profile:'cu126',requirements:['test==1.0']})};await writeFile(join(path,'muxivra-resource.json'),JSON.stringify(manifest));records.push({id:randomUUID(),name:kind,kind,path,versions,bytes:files.length,createdAt:new Date().toISOString(),source:'download',ready:true,...(kind==='dependencies'?{backend:'qwen3-asr',profile:'cu126'}:{})})}
    await writeFile(join(root,'asr','models.json'),JSON.stringify({version:1,models:[],runtimes:[],assets:[{...asset,path:directory,createdAt:new Date().toISOString()}],resources:records}))
    vi.spyOn(nvidia,'detectNvidia').mockResolvedValue({devices:[gpu],checkedAt:new Date().toISOString()});const python=vi.spyOn(resources,'downloadPythonResource'),dependencies=vi.spyOn(resources,'downloadDependencyResource'),offline=vi.spyOn(resources,'prepareOfflineNvidiaPython').mockResolvedValue({directory:environmentDirectory,pythonPath,probe}),network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No network permitted'))
    const models=new AsrModels(root,()=>{});try{await models.initialize();const plan=await models.deploymentPlan({assetId:'qwen-0.6b',gpuIndex:0,includeAligner:false});expect(plan.items).toHaveLength(3);expect(plan.items.every(item=>item.status==='reuse')).toBe(true);await models.deployNvidia({assetId:'qwen-0.6b',gpuIndex:0,includeAligner:false});expect(offline).toHaveBeenCalledTimes(1);expect(python).not.toHaveBeenCalled();expect(dependencies).not.toHaveBeenCalled();expect(network).not.toHaveBeenCalled();expect(models.state().models[0].availability).toBe('ready')}finally{await models.shutdown()}
  }))
  it('shows deployment failure without altering existing model/environment files',()=>local(async root=>{
    vi.spyOn(nvidia,'detectNvidia').mockResolvedValue({devices:[{...gpu,computeMajor:6}],checkedAt:new Date().toISOString()})
    const models=new AsrModels(root,()=>{});try{await models.initialize();await expect(models.deployNvidia({assetId:'qwen-0.6b',gpuIndex:0,includeAligner:true})).rejects.toThrow('完整驱动');expect(models.state().deployment).toMatchObject({active:false,phase:'failed'});expect(models.state().models).toEqual([]);expect(models.state().environments).toEqual([])}finally{await models.shutdown()}
  }))
  it('retains the completed environment when a model download fails and reuses it on retry',()=>local(async root=>{
    const environmentDirectory=join(root,'asr','environments','new-qwen'),pythonPath=join(environmentDirectory,'python.exe');await mkdir(environmentDirectory,{recursive:true});await writeFile(pythonPath,'fixture environment')
    vi.spyOn(nvidia,'detectNvidia').mockResolvedValue({devices:[gpu],checkedAt:new Date().toISOString()});vi.spyOn(resources,'downloadPythonResource').mockResolvedValue({id:randomUUID(),kind:'python',name:'fixture',path:root,versions:{},bytes:0,createdAt:new Date().toISOString(),source:'download',ready:true});vi.spyOn(resources,'downloadDependencyResource').mockResolvedValue({id:randomUUID(),kind:'dependencies',name:'fixture',path:root,versions:{},bytes:0,createdAt:new Date().toISOString(),source:'download',ready:true,backend:'qwen3-asr',profile:'cu126'});const install=vi.spyOn(resources,'prepareOfflineNvidiaPython').mockResolvedValue({directory:environmentDirectory,pythonPath,probe});const verify=vi.spyOn(deployment,'verifyNvidiaEnvironment').mockResolvedValue(probe);vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Offline fixture'))
    const models=new AsrModels(root,()=>{});try{await models.initialize();await expect(models.deployNvidia({assetId:'qwen-0.6b',gpuIndex:0,includeAligner:true})).rejects.toThrow('Offline fixture');expect(models.state().environments).toHaveLength(1);expect(models.state().models).toEqual([]);expect(await readFile(pythonPath,'utf8')).toBe('fixture environment');await new Promise(done=>setTimeout(done,0));await expect(models.deployNvidia({assetId:'qwen-0.6b',gpuIndex:0,includeAligner:true})).rejects.toThrow('Offline fixture');expect(install).toHaveBeenCalledTimes(1);expect(verify).toHaveBeenCalledTimes(1)}finally{await models.shutdown()}
  }))
  it('cancels an active environment preparation and leaves existing model records editable',()=>local(async root=>{
    vi.spyOn(nvidia,'detectNvidia').mockResolvedValue({devices:[gpu],checkedAt:new Date().toISOString()});let entered!:()=>void;const started=new Promise<void>(done=>{entered=done});vi.spyOn(resources,'downloadPythonResource').mockImplementation(async(context)=>{entered();await new Promise<void>((_done,reject)=>context.signal.addEventListener('abort',()=>reject(new Error('Cancelled fixture')),{once:true}));throw new Error('unreachable')})
    const models=new AsrModels(root,()=>{});try{await models.initialize();const task=models.deployNvidia({assetId:'qwen-0.6b',gpuIndex:0,includeAligner:true});await started;await expect(models.remove(randomUUID())).rejects.toThrow('一键部署');models.cancelDeployment();await expect(task).rejects.toThrow('Cancelled fixture');expect(models.state().deployment).toMatchObject({active:false,phase:'cancelled'});await models.remove(randomUUID());expect(models.state().models).toEqual([])}finally{await models.shutdown()}
  }))
})
