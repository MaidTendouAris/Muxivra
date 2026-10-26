import { installHeadlessTextureFixture } from './headless-texture-fixture.mjs'
import { createProject } from './gui-projects.mjs'
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'

await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const root=await mkdtemp(resolve('.test-data','asr-ui-')),source=join(root,'speech.wav'),manifest=join(root,'backend.json')
const report={executable:process.env.MUXIVRA_EXECUTABLE||'development build',errors:[],layouts:[]}
await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440','-t','3',source],{windowsHide:true})
await writeFile(join(root,'worker.cjs'),`let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{const r=JSON.parse(input);console.error('ASR smoke backend');console.log(JSON.stringify({type:'progress',percent:10}));setTimeout(()=>{console.log(JSON.stringify({type:'result',result:{language:'zh',segments:[{text:'ASR 字幕初稿🙂',startMs:500,endMs:1600},{text:'无时间戳文本'},{text:'第二句',startMs:1800,endMs:2600}]}}))},r.options.initialPrompt==='cancel'?15000:400)});`)
await mkdir(join(root,'model'));await writeFile(join(root,'model','weights.bin'),'protocol fixture data')
await writeFile(manifest,JSON.stringify({format:'muxivra-asr-backend',version:1,name:'UI protocol model',executable:process.execPath,args:[join(root,'worker.cjs')],modelPath:'model'}))
await writeFile(source.replace('.wav','.ass'),'[Script Info]\nScriptType: v4.00+\nTitle: ASR smoke project\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:00.30,Default,,0,0,0,,原有字幕\n')
const desktop=await electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE||electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_TEST_SYSTEM_LANGUAGES:'zh-CN',MUXIVRA_DATA_PATH:join(root,'profile'),MUXIVRA_ENGINE_PATH:join(root,'engines')},timeout:60000})
let page
try{
  await installHeadlessTextureFixture(desktop);page=await desktop.firstWindow();page.on('pageerror',error=>report.errors.push(error.message))
  const until=async(check,timeout=30000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await check())return;await page.waitForTimeout(40)}throw new Error('ASR smoke condition timed out')}
  report.appVersion=await desktop.evaluate(({app})=>app.getVersion())
  const nav=name=>page.locator('.navigation').getByRole('button',{name,exact:false}).click()
  const resourcesAsr=async()=>{await nav('资源管理');await page.locator('.workspace-header .resource-dock').getByRole('button',{name:'ASR',exact:true}).click()}
  const configure=async()=>{await resourcesAsr();await page.locator('.resource-model-card').filter({hasText:'UI protocol model'}).getByRole('button',{name:'配置识别参数',exact:true}).click()}
  const pick=path=>desktop.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]})},path)
  const choose=async(label,value)=>{await page.getByLabel(label,{exact:true}).click();await page.getByRole('option',{name:value,exact:true}).click()}
  const waitCues=count=>until(()=>page.evaluate(async n=>(await window.muxivra.getSession())?.cues.length===n,count))
  await page.getByRole('heading',{name:'视频处理',exact:true}).waitFor({timeout:60000});await nav('ASR 工作台')
  const project=await createProject(page,desktop,source,{subtitle:source.replace('.wav','.ass'),target:'asr'})
  await page.locator('.asr-source').waitFor()
  await resourcesAsr();await page.getByRole('button',{name:'导入模型',exact:true}).click();await choose('后端类型','自定义后端 · JSON 配置')
  await pick(manifest);await page.getByRole('button',{name:'选择文件并导入',exact:true}).click()
  await page.getByRole('dialog').waitFor({state:'hidden'});await nav('ASR 工作台')
  assert.equal(await page.getByLabel('语言代码',{exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'配置识别参数',exact:true}).count(),0)
  await configure()
  const compatibility=page.getByLabel('启用兼容分片',{exact:true}),chunkDuration=page.getByLabel('分片时长（秒）',{exact:true})
  assert.equal(await compatibility.isChecked(),false);assert.equal(await chunkDuration.count(),0)
  await compatibility.check();await chunkDuration.fill('900');assert.equal(await chunkDuration.inputValue(),'900')
  await compatibility.uncheck();assert.equal(await chunkDuration.count(),0)
  await page.getByRole('button',{name:'应用配置',exact:true}).click();await nav('ASR 工作台')
  await page.getByRole('button',{name:'生成字幕初稿',exact:true}).click()
  await until(()=>page.evaluate(async()=>{const s=await window.muxivra.snapshot();return s.jobs.some(j=>j.plan.kind==='asr'&&j.status==='completed')}))
  await page.locator('.asr-preview-table tbody tr').first().waitFor()
  const initial=await page.evaluate(async()=>{const s=await window.muxivra.snapshot();const job=s.jobs.find(j=>j.plan.kind==='asr');return {options:job.plan.asr.options,result:await window.muxivra.asrResult(job.id)}})
  assert.equal(initial.options.chunkingEnabled,false);assert.equal(initial.result.rawFiles.length,1)
  assert.equal(await page.locator('.asr-preview-table tbody tr').count(),3)
  assert.ok(await page.locator('.asr-preview-table').innerText().then(t=>t.includes('未打轴')))
  for(const format of ['ASS','SRT']){
    const target=join(root,`draft.${format.toLowerCase()}`)
    await desktop.evaluate(({dialog},path)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:path})},target)
    await page.getByRole('button',{name:`导出 ${format}`,exact:true}).click()
    await until(async()=>!!await readFile(target,'utf8').catch(()=>''))
    const text=await readFile(target,'utf8');assert.ok(text.includes('ASR 字幕初稿🙂'))
    if(format==='ASS'){assert.ok(text.includes('Comment:'));assert.ok(text.includes('无时间戳文本'))}else assert.ok(!text.includes('无时间戳文本'))
  }
  await page.locator('.asr-raw-panel summary').click();await page.getByRole('button',{name:'整段结果',exact:true}).click()
  await page.getByRole('dialog').getByText('原始模型结果',{exact:true}).waitFor();assert.ok((await page.locator('.asr-raw-json').innerText()).includes('无时间戳文本'))
  await page.keyboard.press('Escape')
  for(const [width,height,theme] of [[1440,900,'light'],[1040,720,'dark']]){
    await desktop.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().includes('devtools'))?.setSize(size.width,size.height),{width,height})
    await page.evaluate(async theme=>{const s=await window.muxivra.snapshot();await window.muxivra.saveSettings({...s.settings,theme})},theme)
    await page.waitForTimeout(200)
    const layout=await page.evaluate(()=>({width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,results:document.querySelector('.asr-results').getBoundingClientRect().toJSON()}));report.layouts.push({...layout,theme})
    assert.ok(layout.documentWidth<=layout.width,'ASR page overflows horizontally')
    await page.screenshot({path:`artifacts/qa/asr-workbench-${theme}.png`,fullPage:true})
  }
  await page.getByRole('button',{name:'编辑初稿',exact:true}).click();await page.getByRole('dialog').getByText('应用 ASR 字幕初稿',{exact:true}).waitFor()
  await page.getByRole('button',{name:'追加到工程',exact:true}).click();await waitCues(4)
  const appended=await page.evaluate(()=>window.muxivra.getSession());await writeFile('artifacts/qa/asr-ui-document.json',JSON.stringify(appended,null,2));assert.equal(appended.scriptInfo.Title,'ASR smoke project');assert.equal(appended.cues.filter(c=>c.comment).length,1)
  await page.getByRole('button',{name:'展开工程栏',exact:true}).click()
  await page.getByRole('button',{name:'撤销',exact:true}).click();await waitCues(1)
  await page.getByRole('button',{name:'重做',exact:true}).click();await waitCues(4)
  await page.getByRole('button',{name:'保存工程',exact:true}).click();await until(async()=>(await readFile(project.subtitlePath,'utf8')).includes('ASR 字幕初稿🙂'))
  await nav('ASR 工作台');await page.getByRole('button',{name:'编辑初稿',exact:true}).click();await page.getByRole('button',{name:'替换条目',exact:true}).click();await waitCues(3)
  await page.getByRole('button',{name:'撤销',exact:true}).click();await waitCues(4)
  await configure();await page.getByLabel('识别提示词',{exact:true}).fill('cancel');await page.getByRole('button',{name:'应用配置',exact:true}).click();await nav('ASR 工作台')
  await page.getByRole('button',{name:'生成字幕初稿',exact:true}).click()
  await until(()=>page.evaluate(async()=>{const s=await window.muxivra.snapshot();return s.jobs.some(j=>j.plan.kind==='asr'&&j.status==='running'&&j.processedMs>0)}))
  const running=await page.evaluate(async()=>{const s=await window.muxivra.snapshot();return s.jobs.find(j=>j.plan.kind==='asr'&&j.status==='running').id})
  assert.equal(await page.locator('.asr-record.selected').getByRole('button',{name:'删除识别记录',exact:true}).isDisabled(),true)
  await nav('任务');await page.getByRole('button',{name:'暂停',exact:true}).click()
  await until(()=>page.evaluate(async id=>(await window.muxivra.jobDetails(id)).status==='paused',running))
  const paused=await page.evaluate(id=>window.muxivra.jobDetails(id),running);await page.waitForTimeout(300)
  assert.equal((await page.evaluate(id=>window.muxivra.jobDetails(id),running)).elapsedMs,paused.elapsedMs)
  await page.getByRole('button',{name:'继续',exact:true}).click()
  await until(()=>page.evaluate(async id=>(await window.muxivra.jobDetails(id)).status==='running',running))
  await page.getByRole('button',{name:'暂停',exact:true}).click()
  await until(()=>page.evaluate(async id=>(await window.muxivra.jobDetails(id)).status==='paused',running))
  await page.getByRole('button',{name:'取消',exact:true}).click()
  await until(()=>page.evaluate(async id=>(await window.muxivra.jobDetails(id)).status==='cancelled',running))
  await page.getByRole('button',{name:'查看详细信息',exact:true}).first().click();await page.locator('.task-details-page').getByText('ASR · UI protocol model',{exact:true}).waitFor()
  await configure();await page.getByLabel('识别提示词',{exact:true}).fill('')
  await compatibility.check();await chunkDuration.fill('1');await page.getByRole('button',{name:'应用配置',exact:true}).click();await nav('ASR 工作台')
  const previous=await page.evaluate(async()=>(await window.muxivra.snapshot()).jobs.map(j=>j.id))
  await page.getByRole('button',{name:'生成字幕初稿',exact:true}).click()
  await until(()=>page.evaluate(async ids=>(await window.muxivra.snapshot()).jobs.some(j=>j.plan.kind==='asr'&&!ids.includes(j.id)&&j.status==='completed'),previous))
  const split=await page.evaluate(async ids=>{const job=(await window.muxivra.snapshot()).jobs.find(j=>!ids.includes(j.id));return {options:job.plan.asr.options,result:await window.muxivra.asrResult(job.id)}},previous)
  assert.equal(split.options.chunkingEnabled,true);assert.equal(split.options.chunkSeconds,1);assert.equal(split.result.rawFiles.length,3)
  const extra=await page.evaluate(async options=>{const ids=[];for(let i=0;i<8;i++)ids.push((await window.muxivra.asrSubmit(options)).id);return ids},initial.options)
  await until(()=>page.evaluate(async ids=>{const jobs=(await window.muxivra.snapshot()).jobs;return ids.every(id=>jobs.some(j=>j.id===id&&j.status==='completed'))},extra))
  const recordGeometry=await page.locator('.asr-record-list').evaluate(element=>({height:element.clientHeight,total:element.scrollHeight}))
  assert.ok(recordGeometry.height<=320,'ASR records exceed their maximum height');assert.ok(recordGeometry.total>recordGeometry.height,'A long ASR list must scroll inside its card')
  const beforeSource=await readFile(source),beforeProject=await readFile(project.subtitlePath),deleted=await page.evaluate(id=>window.muxivra.jobDetails(id),split.result.jobId)
  await page.locator('.asr-record.selected').getByRole('button',{name:'删除识别记录',exact:true}).click()
  await page.getByRole('dialog').getByRole('button',{name:'删除记录',exact:true}).click()
  await until(()=>page.evaluate(async id=>!(await window.muxivra.snapshot()).jobs.some(j=>j.id===id),split.result.jobId))
  await page.getByRole('dialog').waitFor({state:'hidden'})
  await assert.rejects(readFile(deleted.plan.outputPath),{code:'ENOENT'});assert.deepEqual(await readFile(source),beforeSource);assert.deepEqual(await readFile(project.subtitlePath),beforeProject)
  assert.ok((await readFile(join(root,'draft.ass'),'utf8')).includes('ASR 字幕初稿🙂'));assert.ok((await readFile(join(root,'draft.srt'),'utf8')).includes('ASR 字幕初稿🙂'))
  const selected=page.getByLabel('选择全部可删除记录',{exact:true});await selected.check()
  const remaining=await page.evaluate(async()=>{const s=await window.muxivra.snapshot();return s.jobs.filter(j=>j.plan.kind==='asr').map(j=>j.id)})
  assert.ok(remaining.length>1)
  await page.getByRole('button',{name:/^删除所选/}).click();await page.getByRole('dialog').getByRole('button',{name:'删除记录',exact:true}).click()
  await until(()=>page.evaluate(async ids=>{const s=await window.muxivra.snapshot();return ids.every(id=>!s.jobs.some(j=>j.id===id))},remaining))
  assert.deepEqual(await readFile(source),beforeSource);assert.deepEqual(await readFile(project.subtitlePath),beforeProject)
  assert.deepEqual(report.errors,[]);report.result={batchRecordDeletion:true,recordHeightLimit:true,deleteRecordPreservesMediaAndProject:true,wholeDefault:true,compatibilityCustomDuration:true,pauseResume:true,preview:true,ass:true,srt:true,raw:true,append:true,replace:true,undo:true,untimedComments:true,cancel:true}
  await writeFile('artifacts/qa/asr-smoke.json',JSON.stringify(report,null,2));console.log('ASR workbench smoke passed')
}catch(error){
  report.failure=error.stack
  if(page){report.session=await page.evaluate(()=>window.muxivra.getSession()).catch(()=>undefined);report.screen=await page.locator('body').innerText().catch(()=>undefined);await page.screenshot({path:'artifacts/qa/asr-smoke-failed.png',fullPage:true}).catch(()=>{})}
  await writeFile('artifacts/qa/asr-smoke-failed.json',JSON.stringify(report,null,2));throw error
}finally{
  await desktop.close()
  const cleanup=relative(resolve('.test-data'),root)
  if(!cleanup||cleanup==='..'||cleanup.startsWith(`..${sep}`)||isAbsolute(cleanup))throw new Error('Refusing cleanup outside .test-data')
  await rm(root,{recursive:true,force:true})
}
