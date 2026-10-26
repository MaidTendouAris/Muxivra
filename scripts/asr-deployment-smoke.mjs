import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { mkdir,readFile,writeFile } from 'node:fs/promises'
import { resolve,join } from 'node:path'
import assert from 'node:assert/strict'
import { createProject } from './gui-projects.mjs'
const root=resolve('.runtime/asr-deployment-validation'),source=resolve('tests/media/TED演讲：神奇的斐波那契数列_P1_中英字幕.mp4')
await mkdir('artifacts/qa',{recursive:true})
// This fixed validation profile owns only copied test assets; reset bindings for repeatable UI checks.
const configPath=join(root,'asr','models.json'),configuration=JSON.parse(await readFile(configPath,'utf8'));configuration.models=[];await writeFile(configPath,JSON.stringify(configuration,null,2))
const report={startedAt:new Date().toISOString(),executable:process.env.MUXIVRA_EXECUTABLE||'development',errors:[],layouts:[],models:[]},desktop=await electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE||electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_DATA_PATH:root,MUXIVRA_ENGINE_PATH:join(root,'engines')},timeout:60000})
let page
async function until(predicate,timeout=60000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const state=await page.evaluate(()=>window.muxivra.snapshot());if(predicate(state))return state;await new Promise(done=>setTimeout(done,100))}throw new Error('State wait timed out')}
try{
  page=await desktop.firstWindow();page.on('pageerror',error=>report.errors.push(error.message));await page.getByRole('heading',{name:'视频处理',exact:true}).waitFor({timeout:60000})
  await page.locator('.navigation').getByRole('button',{name:'资源管理',exact:true}).click();await page.getByRole('navigation',{name:'资源分类',exact:true}).getByRole('button',{name:'环境',exact:true}).click()
  await until(s=>!!s.asr.nvidia?.devices.length);report.nvidia=(await page.evaluate(()=>window.muxivra.snapshot())).asr.nvidia
  assert.ok(report.nvidia.devices[0].name.includes('NVIDIA'));assert.equal(await page.locator('.resource-local-python').evaluate(el=>el.open),false);assert.equal(await page.getByText(/MiMo/i).count(),0)
  for(const [width,height,theme] of [[1440,900,'light'],[1040,720,'dark']]){await desktop.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setSize(size.width,size.height),{width,height});await page.evaluate(async theme=>{const s=await window.muxivra.snapshot();await window.muxivra.saveSettings({...s.settings,theme})},theme);await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);const layout=await page.evaluate(()=>({width:innerWidth,total:document.documentElement.scrollWidth}));assert.ok(layout.total<=layout.width);report.layouts.push({...layout,theme});await page.screenshot({path:`artifacts/qa/asr-deployment-${theme}.png`,fullPage:true})}
  // This long-running compatibility smoke deliberately exercises the retained
  // legacy API against its reusable validation cache. Resource UI file preparation
  // and offline configuration are covered separately by resources smoke/unit tests.
  const deploy=assetId=>page.evaluate(assetId=>window.muxivra.asrDeployNvidia({assetId,gpuIndex:0,includeAligner:true}),assetId)
  await deploy('qwen-0.6b');await until(s=>s.asr.deployment?.active&&s.asr.deployment.phase==='verifying');await page.getByRole('button',{name:'取消部署',exact:true}).click();await until(s=>s.asr.deployment?.phase==='cancelled');assert.equal((await page.evaluate(()=>window.muxivra.snapshot())).asr.models.length,0);report.cancellation=true
  await desktop.evaluate(({clipboard})=>{globalThis.__deployClipboard=[];clipboard.writeText=text=>globalThis.__deployClipboard.push(text)})
  for(const assetId of ['qwen-0.6b','moss-0.9b','whisper-large-v3']){
    await deploy(assetId);await until(s=>!s.asr.deployment?.active,300000)
    const state=await page.evaluate(()=>window.muxivra.snapshot());assert.equal(state.asr.deployment.phase,'completed',state.asr.deployment.message);const model=state.asr.models.find(value=>value.id===state.asr.deployment.modelId);assert.equal(model.recognition.device,'gpu');assert.equal(model.nvidiaDeviceUuid,report.nvidia.devices[0].uuid);assert.ok(model.modelPath.startsWith(join(root,'installation','asr')));if(model.environment)assert.ok(model.environment.pythonPath.startsWith(join(root,'installation','asr')))
    await page.getByRole('navigation',{name:'资源分类',exact:true}).getByRole('button',{name:'ASR',exact:true}).click();await page.locator('.resource-model-card').filter({hasText:model.name}).waitFor();await page.getByRole('button',{name:'复制完整部署日志',exact:true}).click();const log=await desktop.evaluate(()=>globalThis.__deployClipboard.at(-1));assert.ok(log.includes('executable'));report.models.push({id:model.id,backend:model.backend,name:model.name,modelPath:model.modelPath,environment:model.environment,device:model.recognition.device,gpu:model.nvidiaDeviceUuid,logPath:state.asr.deployment.logPath})
    await page.getByRole('navigation',{name:'资源分类',exact:true}).getByRole('button',{name:'环境',exact:true}).click()
  }
  await page.getByRole('navigation',{name:'资源分类',exact:true}).getByRole('button',{name:'环境',exact:true}).click();assert.equal(await page.locator('.resource-local-python').evaluate(el=>el.open),false);assert.equal(await page.locator('.resource-environment-card').filter({has:page.locator('.resource-version-grid')}).count(),2);await page.locator('.resource-local-python > summary').click();report.manualCompatibility=true;report.visibleEnvironmentInventory=true;report.legacyDeploymentApi=true
  const project=await createProject(page,desktop,source,{name:'NVIDIA managed environment validation',target:'asr'});report.project=project.directory
  for(const item of process.env.MUXIVRA_ASR_SKIP_INFERENCE==='1'?[]:report.models){
    const state=await page.evaluate(()=>window.muxivra.snapshot()),model=state.asr.models.find(m=>m.id===item.id),media=await page.evaluate(path=>window.muxivra.inspect(path),project.mediaPath),options={modelId:model.id,inputPath:project.mediaPath,audioStream:media.streams.find(s=>s.type==='audio').index,...model.recognition,language:'auto',startMs:0,endMs:15000,threads:8}
    const job=await page.evaluate(options=>window.muxivra.asrSubmit(options),options);console.log('Running actual GPU inference',item.name,job.id)
    const completed=await until(s=>s.jobs.some(j=>j.id===job.id&&['completed','failed','cancelled'].includes(j.status)),600000),current=completed.jobs.find(j=>j.id===job.id);assert.equal(current.status,'completed',current.error)
    const result=await page.evaluate(id=>window.muxivra.asrResult(id),job.id);assert.ok(result.segments.length);assert.ok(result.segments.some(s=>s.startMs!==undefined));assert.equal(result.rawFiles.length,1);item.inference={status:current.status,elapsedMs:current.elapsedMs,segments:result.segments.length,timed:result.segments.filter(s=>s.startMs!==undefined).length,preview:result.segments.slice(0,3)};await writeFile('artifacts/qa/asr-deployment-smoke-progress.json',JSON.stringify(report,null,2))
  }
  assert.deepEqual(report.errors,[]);report.inferenceSkipped=process.env.MUXIVRA_ASR_SKIP_INFERENCE==='1';report.finishedAt=new Date().toISOString();await writeFile(process.env.MUXIVRA_EXECUTABLE?'artifacts/qa/packaged-asr-deployment-smoke.json':'artifacts/qa/asr-deployment-smoke.json',JSON.stringify(report,null,2));console.log('NVIDIA desktop deployment validation passed')
}catch(error){report.failure=error.stack;if(page){report.screen=await page.locator('body').innerText().catch(()=>undefined);report.state=await page.evaluate(()=>window.muxivra.snapshot()).catch(()=>undefined);await page.screenshot({path:'artifacts/qa/asr-deployment-failed.png',fullPage:true}).catch(()=>{})}await writeFile('artifacts/qa/asr-deployment-failed.json',JSON.stringify(report,null,2));throw error}
finally{await desktop.close().catch(()=>{})}
