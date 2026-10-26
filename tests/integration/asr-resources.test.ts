import { expect,it,vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile,link,mkdir,mkdtemp,readFile,rm,stat,writeFile } from 'node:fs/promises'
import { dirname,join,relative,resolve } from 'node:path'
import { collectFiles,hashFile } from '../../src/core/asr/storage'
import { prepareOfflineNvidiaPython,type ResourceManifest } from '../../src/core/asr/resources'
import * as deployment from '../../src/core/asr/deployment'
import { isWithin } from '../../src/core/media/paths'
import type { AsrResource } from '../../src/shared/asr-deployment'
const run=promisify(execFile)

it.skipIf(process.env.MUXIVRA_ASR_RESOURCE_REAL!=='1'||process.platform!=='win32')('real portable CPython and uv install a locally built wheel into an isolated environment with network unavailable',async()=>{
  await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data','asr-resource-offline-')),storage=join(root,'installation','asr'),source=resolve('.runtime/asr-deployment-validation/installation/asr/python/cpython-3.12.13-windows-x86_64-none'),uv=resolve('.runtime/asr-deployment-validation/installation/asr/tools/uv-0.13.1/uv.exe'),base=join(storage,'components','python'),dependencies=join(storage,'components','dependencies'),records:AsrResource[]=[]
  try{
    await mkdir(base,{recursive:true});await mkdir(join(dependencies,'wheels'),{recursive:true})
    for(const file of await collectFiles(source)){const target=join(base,'python',file.relative);await mkdir(dirname(target),{recursive:true});try{await link(file.path,target)}catch{await copyFile(file.path,target)}}
    await copyFile(uv,join(base,'uv.exe'))
    const python=join(base,'python','python.exe'),wheel=join(dependencies,'wheels','muxivra_offline_fixture-1.0-py3-none-any.whl')
    const script='import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("muxivra_offline_fixture.py","VALUE=42\\n"); z.writestr("muxivra_offline_fixture-1.0.dist-info/METADATA","Metadata-Version: 2.1\\nName: muxivra-offline-fixture\\nVersion: 1.0\\n"); z.writestr("muxivra_offline_fixture-1.0.dist-info/WHEEL","Wheel-Version: 1.0\\nGenerator: fixture\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n"); z.writestr("muxivra_offline_fixture-1.0.dist-info/RECORD",""); z.close()'
    await run(python,['-I','-c',script,wheel],{windowsHide:true})
    for(const [kind,path] of [['python',base],['dependencies',dependencies]] as const){
      const files=[];for(const file of await collectFiles(path))files.push({path:relative(path,file.path).replaceAll('\\','/'),bytes:file.size,sha256:await hashFile(file.path)})
      const manifest:ResourceManifest={format:'muxivra-asr-resource',version:1,kind,versions:{python:'3.12.13'},files,...(kind==='python'?{python:'python/python.exe',uv:'uv.exe'}:{backend:'qwen3-asr',profile:'cu126',requirements:['muxivra-offline-fixture==1.0']})}
      await writeFile(join(path,'muxivra-resource.json'),JSON.stringify(manifest));records.push({id:kind==='python'?'00000000-0000-4000-8000-000000000001':'00000000-0000-4000-8000-000000000002',name:kind,kind,path,versions:manifest.versions,bytes:files.reduce((sum,file)=>sum+file.bytes,0),createdAt:new Date().toISOString(),source:'import',ready:true,backend:manifest.backend,profile:manifest.profile})
    }
    const request=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Network must remain unavailable')),verify=vi.spyOn(deployment,'verifyNvidiaEnvironment').mockResolvedValue({ready:true,python:'3.12.13',platform:'win32',versions:{},cudaAvailable:true,devices:[],issues:[],warnings:[],checkedAt:new Date().toISOString(),vllm:false}),gpu={index:0,uuid:'GPU-fixture',name:'Fixture',driver:'576.52',computeMajor:8,computeMinor:6,totalBytes:8*1024**3,freeBytes:7*1024**3}
    const result=await prepareOfflineNvidiaPython('qwen3-asr','unused-adapter',records,{root:storage,signal:new AbortController().signal,logPath:join(storage,'logs','offline.log'),gpu,profile:'cu126',update:()=>{}})
    const check=await run(result.pythonPath,['-I','-c','import muxivra_offline_fixture,sys; assert muxivra_offline_fixture.VALUE==42; assert sys.prefix!=sys.base_prefix; print(sys.prefix)'],{windowsHide:true})
    const second=await prepareOfflineNvidiaPython('qwen3-asr','unused-adapter',records,{root:storage,signal:new AbortController().signal,logPath:join(storage,'logs','offline.log'),gpu,profile:'cu126',update:()=>{}}),a=await stat(join(result.directory,'Lib','site-packages','muxivra_offline_fixture.py')),b=await stat(join(second.directory,'Lib','site-packages','muxivra_offline_fixture.py'))
    expect(a.ino).toBe(b.ino);expect(a.nlink).toBeGreaterThanOrEqual(3);expect(check.stdout.trim().toLowerCase()).toBe(result.directory.toLowerCase());expect(verify).toHaveBeenCalledTimes(2);expect(request).not.toHaveBeenCalled();const log=await readFile(join(storage,'logs','offline.log'),'utf8');expect(log).toContain('--offline');expect(log).toContain('--no-index');expect(log).toContain('--require-hashes');expect(log).not.toContain('https://')
  }finally{vi.restoreAllMocks();if(!isWithin(resolve('.test-data'),root))throw new Error('Unsafe fixture cleanup');await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
},120000)
