import { expect,it } from 'vitest'
import { copyFile,link,mkdir,mkdtemp,readFile,stat,writeFile } from 'node:fs/promises'
import { dirname,join,relative,resolve } from 'node:path'
import { collectFiles,hashFile } from '../../src/core/asr/storage'
import { downloadDependencyResource,prepareOfflineNvidiaPython,type ResourceManifest } from '../../src/core/asr/resources'
import { detectNvidia } from '../../src/core/asr/nvidia'
import { nvidiaProfile,type AsrResource } from '../../src/shared/asr-deployment'

// Opt-in full resource validation. It intentionally retains the prepared
// resources and logs in .runtime for inspection/reuse; no models are downloaded.
it.skipIf(process.env.MUXIVRA_ASR_RESOURCE_FULL!=='1'||process.platform!=='win32')('downloads the complete official Qwen dependency wheelhouse and configures it offline with real CUDA verification',async()=>{
  await mkdir('.runtime',{recursive:true});const root=await mkdtemp(resolve('.runtime','asr-resource-full-')),storage=join(root,'installation','asr'),base=join(storage,'components','python'),source=resolve('.runtime/asr-deployment-validation/installation/asr/python/cpython-3.12.13-windows-x86_64-none'),uv=resolve('.runtime/asr-deployment-validation/installation/asr/tools/uv-0.13.1/uv.exe'),report=join(root,'report.json')
  let result:unknown,error:string|undefined
  console.log('Full ASR resource validation root:',root)
  try{
    await mkdir(base,{recursive:true});for(const file of await collectFiles(source)){const target=join(base,'python',file.relative);await mkdir(dirname(target),{recursive:true});try{await link(file.path,target)}catch{await copyFile(file.path,target)}}await copyFile(uv,join(base,'uv.exe'))
    const files=[];for(const file of await collectFiles(base))files.push({path:relative(base,file.path).replaceAll('\\','/'),bytes:file.size,sha256:await hashFile(file.path)})
    const manifest:ResourceManifest={format:'muxivra-asr-resource',version:1,kind:'python',python:'python/python.exe',uv:'uv.exe',versions:{python:'3.12.13',uv:'0.13.1'},files};await writeFile(join(base,'muxivra-resource.json'),JSON.stringify(manifest))
    const python:AsrResource={id:'00000000-0000-4000-8000-000000000001',name:'Official portable Python fixture',kind:'python',path:base,versions:manifest.versions,bytes:files.reduce((sum,file)=>sum+file.bytes,0),createdAt:new Date().toISOString(),source:'import',ready:true},detection=await detectNvidia(),gpu=detection.devices[0];if(!gpu)throw new Error(detection.issue??'NVIDIA GPU unavailable')
    let lastPhase='';const context={root:storage,signal:new AbortController().signal,logPath:join(storage,'logs','full-qwen-resource.log'),gpu,profile:nvidiaProfile(gpu),update:(value:{phase?:string;message?:string})=>{if(value.phase&&value.phase!==lastPhase){lastPhase=value.phase;console.log(value.phase,value.message)}if(value.message)void writeFile(join(root,'progress.txt'),value.message).catch(()=>{})}}
    const dependency=await downloadDependencyResource('qwen3-asr',[python],context),prepared=await prepareOfflineNvidiaPython('qwen3-asr',resolve('resources/asr/adapter.py'),[python,dependency],{...context,offline:true});result={python,dependency,prepared};expect(prepared.probe.ready).toBe(true);expect(prepared.probe.versions.cuda).toBe('12.6');expect(prepared.probe.versions.transformers).toBe('4.57.6');expect((await readFile(context.logPath,'utf8')).includes('--no-index')).toBe(true)
  }catch(caught){error=(caught as Error).stack??String(caught);throw caught}
  finally{await writeFile(report,JSON.stringify({root,result,error,finishedAt:new Date().toISOString()},null,2));console.log('Full ASR resource validation report:',report)}
},1800000)

it.skipIf(!process.env.MUXIVRA_ASR_RESOURCE_RECONFIGURE||process.platform!=='win32')('reconfigures a complete Qwen bundle offline twice and shares expanded Torch files through stable local wheel URLs',async()=>{
  const root=resolve(process.env.MUXIVRA_ASR_RESOURCE_RECONFIGURE!),saved=JSON.parse(await readFile(join(root,'report.json'),'utf8')),resources=[saved.result.python,saved.result.dependency] as AsrResource[],storage=join(root,'installation','asr'),gpu=(await detectNvidia()).devices[0];if(!gpu)throw new Error('NVIDIA GPU unavailable')
  const context={root:storage,signal:new AbortController().signal,logPath:join(storage,'logs','canonical-wheel-cache.log'),gpu,profile:nvidiaProfile(gpu),offline:true,update:()=>{}}
  const first=await prepareOfflineNvidiaPython('qwen3-asr',resolve('resources/asr/adapter.py'),resources,context),second=await prepareOfflineNvidiaPython('qwen3-asr',resolve('resources/asr/adapter.py'),resources,context),firstDll=join(first.directory,'Lib','site-packages','torch','lib','c10.dll'),secondDll=join(second.directory,'Lib','site-packages','torch','lib','c10.dll'),a=await stat(firstDll),b=await stat(secondDll)
  expect(first.probe.ready).toBe(true);expect(second.probe.ready).toBe(true);expect(a.ino).toBe(b.ino);expect(a.dev).toBe(b.dev);expect(a.nlink).toBeGreaterThanOrEqual(3)
  const index=await readFile(join(second.directory,'muxivra-wheels.html'),'utf8');expect(index).toContain('file:///');expect(index).toContain('/packages/wheels/');expect(index).not.toContain('.transfer-');await writeFile(join(root,'canonical-cache-report.json'),JSON.stringify({first,second,torchDll:{first:firstDll,second:secondDll,ino:a.ino,nlink:a.nlink},finishedAt:new Date().toISOString()},null,2))
},600000)
