import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { mkdir,mkdtemp,readFile,writeFile,rm } from 'node:fs/promises'
import { join,resolve,relative,isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

await mkdir('.runtime',{recursive:true});await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const bundle=resolve('.runtime/download-network-validation.cjs')
await build({stdin:{contents:"export * from './src/core/download-network'; export {deploymentArchive,deploymentManifest,deploymentCommand} from './src/core/asr/deployment'; export {extractZip} from './src/core/engine';",resolveDir:process.cwd()},outfile:bundle,bundle:true,platform:'node',format:'cjs',packages:'external'})
const root=await mkdtemp(resolve('.test-data','asr-network-')),profile=join(root,'profile'),payload=Buffer.from('cold-cache verified deployment archive'),requests=[]
const proxy=createServer((req,res)=>{requests.push({method:req.method,url:req.url});res.writeHead(200,{'Content-Length':payload.length});res.end(payload)})
proxy.on('connect',(req,socket)=>{requests.push({method:'CONNECT',url:req.url});socket.end('HTTP/1.1 502 Test proxy unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')})
await new Promise(done=>proxy.listen(0,'127.0.0.1',done));const port=proxy.address().port
const report={executable:process.env.MUXIVRA_EXECUTABLE||'development',errors:[],requests},desktop=await electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE||electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_DATA_PATH:profile,MUXIVRA_ENGINE_PATH:join(root,'engines')},timeout:60000});let page
async function until(predicate,timeout=60000){const end=Date.now()+timeout;while(Date.now()<end){const value=await page.evaluate(()=>window.muxivra.snapshot());if(predicate(value))return value;await new Promise(done=>setTimeout(done,100))}throw new Error('State wait timed out')}
try{
  page=await desktop.firstWindow();page.on('pageerror',error=>report.errors.push(error.message));await page.getByRole('heading',{name:'单文件',exact:true}).waitFor({timeout:60000})
  await desktop.evaluate(async({session},port)=>{const downloads=session.fromPartition('muxivra-downloads');await downloads.setProxy({mode:'fixed_servers',proxyRules:`http=127.0.0.1:${port};https=127.0.0.1:${port}`});await downloads.closeAllConnections()},port)
  // A new device without Node proxy setup cannot resolve this hostname. The
  // native download session must route it through the configured system stack.
  await assert.rejects(fetch('http://muxivra-download.invalid/archive',{signal:AbortSignal.timeout(1500)}))
  const native=await desktop.evaluate(async({session},{bundle,root,size,sha256})=>{
    const require=process.getBuiltinModule('module').createRequire(bundle),api=require(bundle),downloads=session.fromPartition('muxivra-downloads');api.configureDownloadTransport({name:'native test session',request:(url,init)=>downloads.fetch(url,init),resolveProxy:url=>downloads.resolveProxy(url)})
    const target=require('node:path').join(root,'cache','downloads','fixture.zip'),context={root,signal:new AbortController().signal,logPath:require('node:path').join(root,'logs','fixture.log'),gpu:{uuid:'GPU-fixture'},update:()=>{}}
    await api.deploymentArchive({url:'http://muxivra-download.invalid/archive',size,sha256},target,context)
    return {target,network:await api.downloadProcessNetwork('https://github.com',{})}
  },{bundle,root:join(root,'cold-fixture'),size:payload.length,sha256:createHash('sha256').update(payload).digest('hex')})
  assert.deepEqual(await readFile(native.target),payload);assert.equal(native.network.env.HTTPS_PROXY,`http://127.0.0.1:${port}`);report.systemProxyDownload=true

  await page.locator('.navigation').getByRole('button',{name:'ASR 工作台',exact:true}).click();await page.getByRole('button',{name:'下载与管理',exact:true}).click();await until(s=>!!s.asr.nvidia?.devices.length)
  await desktop.evaluate(({clipboard})=>{globalThis.__networkCopies=[];clipboard.writeText=text=>globalThis.__networkCopies.push(text)})
  await page.getByRole('button',{name:'检查下载网络',exact:true}).click();await page.getByRole('button',{name:'复制诊断',exact:true}).waitFor({timeout:45000});await page.getByRole('button',{name:'复制诊断',exact:true}).click()
  const diagnostics=JSON.parse(await desktop.evaluate(()=>globalThis.__networkCopies.at(-1)));assert.equal(diagnostics.checks.length,8);assert.ok(diagnostics.checks.every(check=>!check.ok&&check.message.includes('https://')));assert.ok(diagnostics.checks.every(check=>check.route?.hops[0]?.proxy));report.diagnostics=diagnostics
  const card=page.locator('.asr-asset-grid > .card.asr-asset-card').filter({has:page.getByText('Qwen3-ASR-0.6B',{exact:true})})
  await card.getByRole('button',{name:'一键安装部署',exact:true}).click();const failed=await until(s=>s.asr.deployment?.phase==='failed',60000)
  assert.match(failed.asr.deployment.message,/github\.com\/astral-sh\/uv/);assert.match(failed.asr.deployment.message,/代理|连接/);assert.equal(failed.asr.environments.length,0);assert.equal(failed.asr.models.length,0)
  await page.getByRole('button',{name:'复制完整部署日志',exact:true}).click();report.failureLog=await desktop.evaluate(()=>globalThis.__networkCopies.at(-1));assert.ok(report.failureLog.includes('deployment-error'));assert.ok(report.failureLog.includes('"phase":"runtime"'));assert.ok(report.failureLog.includes('github.com/astral-sh/uv'))
  await page.screenshot({path:'artifacts/qa/asr-network-diagnostics.png',fullPage:true});report.coldFailureExplained=true

  // Remove only this isolated session's test override. Real cold download uses
  // the machine's system proxy and normal TLS validation, not fixture data.
  await desktop.evaluate(async({session})=>{const downloads=session.fromPartition('muxivra-downloads');await downloads.setProxy({mode:'system'});await downloads.closeAllConnections()})
  if(process.env.MUXIVRA_NETWORK_SKIP_REAL!=='1'){
    report.coldOfficial=await desktop.evaluate(async(_,{bundle,root})=>{
      const require=process.getBuiltinModule('module').createRequire(bundle),api=require(bundle),path=require('node:path'),fs=require('node:fs/promises'),context={root,signal:new AbortController().signal,logPath:path.join(root,'logs','cold.log'),gpu:{uuid:'GPU-fixture'},update:()=>{}},target=path.join(root,'cache','downloads','uv.zip')
      await api.deploymentArchive(api.deploymentManifest.uv,target,context)
      await api.extractZip(target,path.join(root,'tools'),128*1024**2)
      await fs.writeFile(path.join(root,'probe.in'),'packaging==25.0\n')
      const output=await api.deploymentCommand(path.join(root,'tools','uv.exe'),['--no-config','--no-progress','pip','compile','--default-index','https://pypi.org/simple',path.join(root,'probe.in'),'--output-file',path.join(root,'probe.lock')],context,120000)
      return {bytes:(await fs.stat(target)).size,uvVersion:await api.deploymentCommand(path.join(root,'tools','uv.exe'),['--version'],context,30000),compiled:await fs.readFile(path.join(root,'probe.lock'),'utf8'),output}
    },{bundle,root:join(root,'cold-official')})
    assert.equal(report.coldOfficial.bytes,15308685);assert.match(report.coldOfficial.uvVersion,/0\.13\.1/);assert.match(report.coldOfficial.compiled,/packaging==25\.0/)
  }
  assert.deepEqual(report.errors,[]);await writeFile(process.env.MUXIVRA_EXECUTABLE?'artifacts/qa/packaged-asr-network-smoke.json':'artifacts/qa/asr-network-smoke.json',JSON.stringify(report,null,2));console.log('ASR network smoke passed')
}catch(error){report.failure=error.stack;await writeFile('artifacts/qa/asr-network-failed.json',JSON.stringify(report,null,2));throw error}
finally{await desktop.close().catch(()=>{});await new Promise(done=>proxy.close(done));const path=relative(resolve('.test-data'),root);if(!path||path.startsWith('..')||isAbsolute(path))throw new Error('Unsafe cleanup');await rm(root,{recursive:true,force:true})}
