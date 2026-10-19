import { afterEach,describe,expect,it,vi } from 'vitest'
import { createHash,randomUUID } from 'node:crypto'
import { mkdir,mkdtemp,readFile,readdir,rm,writeFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { AsrModels } from '../../src/core/asr/models'
import { officialAsrCatalog } from '../../src/shared/asr-catalog'
import { asrSetupPrompt } from '../../src/shared/asr-setup-prompt'
import { modelFileName,officialManifest,modelscopeFileUrl,downloadOfficialModel } from '../../src/core/asr/official-download'
import { asrProcessEnvironment,copyModel,requireSpace } from '../../src/core/asr/storage'
import { isWithin } from '../../src/core/media/paths'
import { discoveredPythonPaths } from '../../src/core/asr/python-discovery'
afterEach(()=>vi.restoreAllMocks())
async function local(run:(root:string)=>Promise<void>){await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data','asr-assets-'));try{await run(root)}finally{if(!isWithin(resolve('.test-data'),root))throw new Error('Unsafe test cleanup');await rm(root,{recursive:true,force:true})}}
const asset=officialAsrCatalog[0],config=Buffer.from(JSON.stringify({model_type:'qwen3_asr'})),weights=Buffer.from('fixture weights'),template=Buffer.from('fixture template')
function mockOfficial(corrupt=false){const files=[['config.json',config,false],['model.safetensors',weights,true],['chat_template.json',template,false]] as const
  return vi.spyOn(globalThis,'fetch').mockImplementation(async url=>{const address=String(url)
    if(address.includes('/api/models/'))return new Response(JSON.stringify({sha:asset.revision,siblings:files.map(([rfilename,data,lfs])=>({rfilename,size:data.length,blobId:createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex'),...(lfs?{lfs:{size:data.length,sha256:corrupt?'0'.repeat(64):createHash('sha256').update(data).digest('hex')}}:{})}))}))
    const file=files.find(([name])=>address.endsWith('/'+name));if(!file)throw new Error('Unexpected official URL');return new Response(file[1])
  })}
describe('ASR assets and setup',()=>{
  it('uses only the pinned Qwen publisher fallback and cleans corrupt fallback files',()=>local(async root=>{
    const refused=()=>new TypeError('fetch failed',{cause:{code:'ECONNREFUSED'}})
    const request=vi.spyOn(globalThis,'fetch').mockImplementation(async url=>{if(String(url).includes('huggingface.co'))throw refused();return new Response(Buffer.alloc(1161))})
    const manifest=await officialManifest(asset,new AbortController().signal);expect(manifest.source).toBe('modelscope');expect(manifest.total).toBe(asset.bytes)
    expect(modelscopeFileUrl(asset,manifest.files[0])).toMatch(/modelscope\.cn\/models\/Qwen\/Qwen3-ASR-0.6B\/resolve\/[a-f0-9]{40}\/chat_template.json$/)
    expect(modelscopeFileUrl(asset,{...manifest.files[0],blobId:'0'.repeat(40)})).toBeUndefined()
    await expect(downloadOfficialModel(asset,root,new AbortController().signal,()=>{})).rejects.toThrow('校验失败');expect((await readdir(root)).some(name=>name.startsWith('.transfer-'))).toBe(false)
    expect(request.mock.calls.some(([url])=>String(url).includes('modelscope.cn'))).toBe(true)
    const moss=officialAsrCatalog.find(value=>value.backend==='moss-transcribe-diarize')!;await expect(officialManifest(moss,new AbortController().signal)).rejects.toThrow('连接下载源失败')
  }))
  it('does not switch channels on certificate failures, invalid manifests, or cancellation',async()=>{
    const request=vi.spyOn(globalThis,'fetch').mockRejectedValue(new TypeError('fetch failed',{cause:{code:'CERT_HAS_EXPIRED'}}))
    await expect(officialManifest(asset,new AbortController().signal)).rejects.toThrow('证书');expect(request).toHaveBeenCalledTimes(1)
    request.mockReset().mockResolvedValue(new Response(JSON.stringify({sha:'0'.repeat(40),siblings:[]})));await expect(officialManifest(asset,new AbortController().signal)).rejects.toThrow('版本');expect(request).toHaveBeenCalledTimes(1)
    const controller=new AbortController();controller.abort(new Error('user cancel'));request.mockClear();await expect(officialManifest(asset,controller.signal)).rejects.toThrow('user cancel');expect(request).not.toHaveBeenCalled()
  })
  it('downloads and verifies official files to the installation disk, then binds without making another copy',()=>local(async root=>{
    const profile=join(root,'profile'),installation=join(root,'installation'),environmentId=randomUUID();await mkdir(join(profile,'asr'),{recursive:true})
    await writeFile(join(profile,'asr','models.json'),JSON.stringify({version:1,runtimes:[],models:[],environments:[{id:environmentId,name:'Fixture',backend:'qwen3-asr',pythonPath:process.execPath,createdAt:new Date().toISOString(),probe:{ready:true,python:'fixture',platform:'win32',versions:{},cudaAvailable:false,devices:[],issues:[],warnings:[],checkedAt:new Date().toISOString(),vllm:false}}]}))
    const models=new AsrModels(profile,()=>{},undefined,installation);mockOfficial();try{await models.initialize();const downloaded=await models.downloadModel(asset.id)
      expect(isWithin(join(installation,'asr','models'),downloaded.path)).toBe(true);expect(await readFile(join(downloaded.path,'model.safetensors'))).toEqual(weights);expect(await readdir(join(profile,'asr'))).not.toContain('models')
      expect(JSON.parse(await readFile(join(downloaded.path,'muxivra-download-source.json'),'utf8'))).toMatchObject({source:'huggingface',revision:asset.revision,files:[{file:'config.json',source:'huggingface'},{file:'model.safetensors',source:'huggingface'},{file:'chat_template.json',source:'huggingface'}]})
      expect(models.state().models).toHaveLength(0);const bound=await models.bindAsset(asset.id,environmentId);expect(bound.modelPath).toBe(downloaded.path);expect(bound.storageRoot).toBe(join(installation,'asr'));expect(models.state().download.phase).toBe('completed')
      const restored=new AsrModels(profile,()=>{},undefined,installation);await restored.initialize();expect(restored.state().assets?.[0].revision).toBe(asset.revision);await restored.shutdown()
    }finally{await models.shutdown()}
  }))
  it('does not publish corrupt downloads, cleans its staging folder and retains a visible failure',()=>local(async root=>{
    const models=new AsrModels(join(root,'profile'),()=>{},undefined,join(root,'installation'));mockOfficial(true)
    try{await models.initialize();await expect(models.downloadModel(asset.id)).rejects.toThrow('校验失败');expect(models.state().assets).toEqual([]);expect(models.state().download).toMatchObject({active:false,phase:'failed'});expect((await readdir(models.storageRoot)).some(name=>name.startsWith('.transfer-'))).toBe(false)}finally{await models.shutdown()}
  }))
  it('rejects mismatching official revisions and unsafe or incomplete weight listings',async()=>{
    vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({sha:'0'.repeat(40),siblings:[]})));await expect(officialManifest(asset,new AbortController().signal)).rejects.toThrow('版本')
    for(const name of ['../model.bin','folder\\weights.bin','NUL.bin','x/model.exe','model.bin:stream','file. /x.json','.cache/model.bin'])expect(modelFileName(name)).toBe(false)
    expect(modelFileName('chat_template.jinja')).toBe(true);expect(modelFileName('model-00001-of-00007.safetensors')).toBe(true)
  })
  it('copies local model files with Unicode names, preserves originals and avoids nesting its own storage',()=>local(async root=>{
    const source=join(root,'模型'),storage=join(source,'managed');await mkdir(source);await writeFile(join(source,'weights.bin'),weights)
    const copied=await copyModel(source,storage,'Model fixture',new AbortController().signal,()=>{})
    expect(copied.path).not.toBe(source);expect(await readFile(join(source,'weights.bin'))).toEqual(weights);expect(await readFile(join(copied.path,'weights.bin'))).toEqual(weights);expect(await readdir(copied.path)).not.toContain('managed')
  }))
  it('cancels local copying without publishing a model or deleting its source',()=>local(async root=>{
    const source=join(root,'weights.bin'),storage=join(root,'installation','asr'),controller=new AbortController();await writeFile(source,Buffer.alloc(4*1024**2,17))
    await expect(copyModel(source,storage,'Cancel fixture',controller.signal,state=>{if(state.received)controller.abort()})).rejects.toThrow();expect((await readFile(source)).length).toBe(4*1024**2);expect((await readdir(storage)).some(name=>name.startsWith('.transfer-'))).toBe(false)
  }))
  it('checks disk capacity before creating transfer files and directs runtime caches to the installation directory',()=>local(async root=>{
    await expect(requireSpace(root,Number.MAX_SAFE_INTEGER)).rejects.toThrow('空间不足');const env=asrProcessEnvironment(root);expect(env.HF_HOME).toBe(join(root,'cache','huggingface'));expect(env.TEMP).toBe(join(root,'temp'));expect(env.PIP_CACHE_DIR).toBe(join(root,'cache','pip'));expect(env.PYTHONDONTWRITEBYTECODE).toBe('1')
  }))
  it('parses Python launcher paths with spaces and produces platform-neutral AI setup information',()=>{
    expect(discoveredPythonPaths(' -V:3.12 * D:\\Python Install\\python.exe\r\n -V:3.9 C:\\Python39\\python.exe')).toEqual(['D:\\Python Install\\python.exe','C:\\Python39\\python.exe'])
    const text=asrSetupPrompt('qwen3-asr',{models:[],runtimes:[],storageRoot:'D:\\Muxivra\\asr',adapterPath:'D:\\Muxivra\\resources\\asr\\adapter.py',download:{active:false,phase:'idle',label:'',percent:0,received:0,total:0,message:''},discovery:{active:false,candidates:[],issues:[]}})
    expect(text).toContain('D:\\Muxivra\\asr\\environments\\qwen');expect(text).toContain('qwen-asr==0.0.6');expect(text).toContain('PIP_CACHE_DIR');expect(text).toContain('HF_HOME');expect(text).not.toContain('MUXIVRA_MCP_TOKEN')
    expect(()=>asrSetupPrompt('mimo-v2.5-asr',{models:[],runtimes:[],download:{active:false,phase:'idle',label:'',percent:0,received:0,total:0,message:''}})).toThrow('暂不支持')
  })
})
