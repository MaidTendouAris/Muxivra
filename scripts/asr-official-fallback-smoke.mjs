// Cold install with the user's two failing domains deliberately refused.
// All other requests are real Chromium downloads from official channels.
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { build } from 'esbuild'
import { mkdir,mkdtemp,readFile,writeFile } from 'node:fs/promises'
import { resolve,join } from 'node:path'
import assert from 'node:assert/strict'
await mkdir('.runtime',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const root=await mkdtemp(resolve('.runtime','asr-official-fallback-')),bundle=join(root,'validation.cjs')
await build({stdin:{contents:"export * from './src/core/download-network';export {prepareDeploymentTool,deploymentCommand,deploymentManifest} from './src/core/asr/deployment';export {officialManifest,downloadOfficialModel} from './src/core/asr/official-download';export {officialAsrCatalog} from './src/shared/asr-catalog';export {traceDownloadRoute} from './src/main/download-network';",resolveDir:process.cwd()},outfile:bundle,bundle:true,platform:'node',format:'cjs',packages:'external',external:['electron']})
const app=await electron.launch({executablePath:electronPath,args:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_DATA_PATH:join(root,'profile'),MUXIVRA_ENGINE_PATH:join(root,'engine')},timeout:60000})
app.process().stdout?.on('data',data=>{if(String(data).includes('fallback-validation'))process.stdout.write(data)})
try{
  const result=await app.evaluate(async({session},{root,bundle,downloadModel})=>{
    const require=process.getBuiltinModule('module').createRequire(bundle),api=require(bundle),fs=require('node:fs/promises'),path=require('node:path'),downloads=session.fromPartition('muxivra-downloads',{cache:false}),blocked=[]
    api.configureDownloadTransport({name:'native official fallback validation',request:(url,init)=>{
      if(url.startsWith('https://github.com/astral-sh/uv/')||url.startsWith('https://huggingface.co/')){blocked.push(api.safeDownloadUrl(url));return Promise.reject(new Error('net::ERR_CONNECTION_REFUSED'))}
      return downloads.fetch(url,init)
    },resolveProxy:url=>downloads.resolveProxy(url)})
    const storage=path.join(root,'installation','asr'),logPath=path.join(storage,'logs','bootstrap.log'),context={root:storage,signal:AbortSignal.timeout(900000),logPath,gpu:{uuid:'GPU-validation'},update:()=>{}}
    const uv=await api.prepareDeploymentTool(context),uvVersion=await api.deploymentCommand(uv,['--version'],context,30000)
    process.stdout.write('fallback-validation: official PyPI uv verified\n')
    await api.deploymentCommand(uv,['--no-config','--no-progress','python','install',api.deploymentManifest.python,'--no-bin'],context,300000)
    const base=await api.deploymentCommand(uv,['--no-config','python','find',api.deploymentManifest.python,'--managed-python','--no-project'],context,30000)
    const environment=path.join(storage,'environments','cold-probe');await api.deploymentCommand(uv,['--no-config','--no-progress','venv','--python',base,'--no-python-downloads',environment],context,30000)
    await api.deploymentCommand(uv,['--no-config','--no-progress','pip','install','--python',path.join(environment,'Scripts','python.exe'),'--default-index','https://pypi.org/simple','packaging==25.0'],context,120000)
    const python=await api.deploymentCommand(path.join(environment,'Scripts','python.exe'),['-I','-c','import sys, packaging; print(sys.version); print(packaging.__version__); print(sys.prefix)'],context,30000)
    process.stdout.write('fallback-validation: cold isolated Python and PyPI dependency verified\n')
    const asset=api.officialAsrCatalog[0],manifest=await api.officialManifest(asset,context.signal);let model,last=0
    if(downloadModel)model=await api.downloadOfficialModel(asset,storage,context.signal,state=>{if(state.received&&Date.now()-last>10000){last=Date.now();process.stdout.write(`fallback-validation: Qwen official ModelScope ${Math.round(state.received/1024**2)} MiB\n`)}})
    const route=await api.traceDownloadRoute(downloads,api.deploymentManifest.uv.url,AbortSignal.timeout(30000))
    return {root,uvVersion,base,python,manifestSource:manifest.source,model,blocked,log:await fs.readFile(logPath,'utf8'),route}
  },{root,bundle,downloadModel:process.env.MUXIVRA_FALLBACK_SKIP_MODEL!=='1'})
  assert.match(result.uvVersion,/0\.13\.1/);assert.match(result.python,/3\.12\.13/);assert.match(result.python,/25\.0/);assert.ok(result.base.startsWith(root));assert.equal(result.manifestSource,'modelscope');assert.ok(result.blocked.some(url=>url.includes('huggingface.co')));assert.ok(result.log.includes('official-source-fallback'))
  if(result.model){assert.equal(result.model.bytes,1880560703);const metadata=JSON.parse(await readFile(join(result.model.path,'muxivra-download-source.json'),'utf8'));assert.equal(metadata.source,'modelscope')}
  assert.ok(result.route.hops.length>=2);assert.ok(result.route.hops.every(hop=>!hop.url.includes('?')));assert.equal(result.route.status,200)
  await writeFile('artifacts/qa/asr-official-fallback-smoke.json',JSON.stringify(result,null,2));console.log('Official source fallback smoke passed')
}finally{await app.close()}
