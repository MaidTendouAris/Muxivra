// Prepare immutable copies of previously downloaded official assets for desktop validation.
// Fresh Python environments were installed by asr-deployment-real-validation.mjs.
import { build } from 'esbuild'
import { mkdir,readFile,writeFile,cp,stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve,join } from 'node:path'
import { pathToFileURL } from 'node:url'
const root=resolve('.runtime/asr-deployment-validation'),storage=join(root,'installation','asr'),module=join(root,'seed.cjs')
await build({stdin:{contents:"export {copyModel} from './src/core/asr/storage';export {officialAsrCatalog} from './src/shared/asr-catalog'",resolveDir:process.cwd(),loader:'ts'},outfile:module,bundle:true,platform:'node',format:'cjs',packages:'external'})
const {copyModel,officialAsrCatalog}=await import(pathToFileURL(module).href),report=JSON.parse(await readFile('artifacts/qa/asr-deployment-real-validation.json','utf8')),createdAt=new Date().toISOString(),config={version:1,models:[],runtimes:[],environments:[],assets:[]}
for(const item of report.environments)config.environments.push({id:randomUUID(),name:item.backend+' fresh NVIDIA environment',backend:item.backend,pythonPath:item.pythonPath,probe:item.probe,createdAt,managed:{version:report.manifest.version,profile:report.profile,gpuUuid:report.nvidia.devices[0].uuid,directory:item.directory}})
for(const [id,source] of [['qwen-0.6b','.runtime/asr-adapters/models/qwen'],['qwen-aligner','.runtime/asr-adapters/models/aligner'],['moss-0.9b','.runtime/asr-adapters/models/moss'],['whisper-large-v3','.runtime/asr-validation/ggml-large-v3.bin']]){
  console.log('Copying verified cached asset',id)
  const copied=await copyModel(resolve(source),storage,id,new AbortController().signal,()=>{}),asset=officialAsrCatalog.find(asset=>asset.id===id)
  config.assets.push({id,name:asset?.name??'Whisper large-v3',backend:asset?.backend??'whisper.cpp',role:asset?.role??'model',repo:asset?.repo,revision:asset?.revision,path:copied.path,bytes:copied.bytes,createdAt})
}
const runtime=join(storage,'runtimes','whisper-b5454-cuda');await mkdir(runtime,{recursive:true});await cp(resolve('.runtime/asr-validation/cuda12/Release'),runtime,{recursive:true,force:false,errorOnExist:true});await stat(join(runtime,'whisper-cli.exe'));config.runtimes.push({id:'whisper-b5454-cuda',name:'whisper.cpp b5454 NVIDIA CUDA 12.4',executable:join(runtime,'whisper-cli.exe')})
await mkdir(join(root,'asr'),{recursive:true});await writeFile(join(root,'asr','models.json'),JSON.stringify(config,null,2));console.log('Desktop seed ready',root)
