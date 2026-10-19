// Actual official downloads and isolated Python/CUDA installation. No model inference fixtures.
import { build } from 'esbuild'
import { mkdir,writeFile } from 'node:fs/promises'
import { resolve,join } from 'node:path'
import { pathToFileURL } from 'node:url'
const root=resolve('.runtime','asr-deployment-validation'),storage=join(root,'installation','asr');await mkdir(storage,{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const module=join(root,'deployment.cjs');await build({stdin:{contents:"export {prepareNvidiaPython,verifyNvidiaEnvironment,deploymentManifest} from './src/core/asr/deployment';export {detectNvidia} from './src/core/asr/nvidia';export {nvidiaProfile} from './src/shared/asr-deployment'",resolveDir:process.cwd(),loader:'ts'},outfile:module,bundle:true,platform:'node',format:'cjs',packages:'external'})
const {prepareNvidiaPython,detectNvidia,nvidiaProfile,deploymentManifest}=await import(pathToFileURL(module).href),nvidia=await detectNvidia();if(!nvidia.devices.length)throw new Error(nvidia.issue)
const gpu=nvidia.devices[0],profile=nvidiaProfile(gpu),report={checkedAt:new Date().toISOString(),nvidia,profile,manifest:deploymentManifest,environments:[]}
for(const backend of process.argv.slice(2).length?process.argv.slice(2):['qwen3-asr','moss-transcribe-diarize']){
  let stage='';const logPath=join(storage,'logs',backend+'.log'),context={root:storage,gpu,profile,signal:new AbortController().signal,logPath,update:value=>{if(value.phase&&stage!==value.phase){stage=value.phase;console.log(backend,stage,value.message)}}}
  try{const prepared=await prepareNvidiaPython(backend,resolve('resources/asr/adapter.py'),context);report.environments.push({backend,...prepared,logPath});await writeFile('artifacts/qa/asr-deployment-real-validation.json',JSON.stringify(report,null,2));console.log(backend,'CUDA installation verified')}
  catch(error){report.failure=String(error.stack);await writeFile('artifacts/qa/asr-deployment-real-validation.json',JSON.stringify(report,null,2));throw error}
}
