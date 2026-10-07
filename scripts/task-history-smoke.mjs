import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { mkdir, mkdtemp, writeFile, readFile, copyFile, stat, rm } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
const exec=promisify(execFile)
await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const root=await mkdtemp(resolve('.test-data','tasks-')),profile=join(root,'profile'),output=join(root,'output'),logs=join(profile,'logs')
await mkdir(logs,{recursive:true});await mkdir(output)
const input=join(root,'input.wav'),encoded=join(root,'fixture.m4a')
await exec('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-c:a','pcm_s16le',input],{windowsHide:true})
await exec('ffmpeg',['-v','error','-i',input,'-c:a','aac','-b:a','192k',encoded],{windowsHide:true})
const ffmpeg=(await exec('where.exe',['ffmpeg'],{windowsHide:true})).stdout.trim().split(/\r?\n/)[0]
const ffprobe=(await exec('where.exe',['ffprobe'],{windowsHide:true})).stdout.trim().split(/\r?\n/)[0]
const options={container:'m4a',video:'none',audio:'aac',quality:22,speed:'medium',audioBitrate:192,subtitles:'none',conflict:'reject'}
const engine={id:'legacy-fixture',ffmpegPath:ffmpeg,ffprobePath:ffprobe,version:'fixture',source:'path',detectedAt:new Date().toISOString(),encoders:['aac'],decoders:['pcm_s16le'],filters:['volume']}
const info={path:input,name:'input.wav',durationMs:2000,size:(await stat(input)).size,format:'wav',streams:[{index:0,type:'audio',codec:'pcm_s16le',channels:1,sampleRate:48000}]}
const longLog='日志开始\n'+('你好🙂完整日志记录\n'.repeat(9000))+'日志结束\n'
// Synthetic legacy records exercise paging/migration; their files are copies
// of one real AAC output. A separate real queue execution is verified below.
const records=Array.from({length:105},(_,i)=>{
  const id=randomUUID(),createdAt=new Date(Date.UTC(2026,9,7,0,0,i)).toISOString(),startedAt=new Date(Date.parse(createdAt)+1000).toISOString(),finishedAt=new Date(Date.parse(startedAt)+12345).toISOString(),path=join(output,`record-${String(i).padStart(3,'0')}.m4a`)
  return {id,source:i%2?'gui':'mcp',status:'completed',createdAt,startedAt,finishedAt,elapsedMs:12345,progress:100,processedMs:2000,speed:'1.25x',outputSize:100,exitCode:0,events:[{at:createdAt,type:'queued',message:'任务已提交'},{at:startedAt,type:'started',message:'开始处理'},{at:finishedAt,type:'completed',message:'处理完成'}],plan:{input:info,outputPath:path,options,engine,args:['-i',input,'-c:a','aac',path],warnings:[]},executedArgs:['-i',input,'-c:a','aac',path],logPath:join(logs,`${id}.log`),logTail:'tail only',temporaryPath:join(output,`.${id}.part.m4a`)}
})
await Promise.all(records.map(async record=>{await copyFile(encoded,record.plan.outputPath);await writeFile(record.logPath,longLog)}))
delete records[104].elapsedMs
const paused={...records[0],id:randomUUID(),source:'gui',status:'paused',pausedFrom:'queued',startedAt:undefined,finishedAt:undefined,elapsedMs:0,progress:0,processedMs:0,speed:'',events:[],outputSize:undefined,plan:{...records[0].plan,outputPath:join(output,'paused.m4a')},logPath:'',logTail:''}
await writeFile(join(profile,'jobs.json'),JSON.stringify([...records,paused]))
let desktop,closed=false,version;const errors=[],deleted=new Set()
const launch=()=>electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE||electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_DATA_PATH:profile,MUXIVRA_ENGINE_PATH:join(root,'engines')},timeout:60000})
try {
  desktop=await launch();const page=await desktop.firstWindow();page.on('pageerror',e=>errors.push(e.message))
  await page.getByRole('heading',{name:'单文件',exact:true}).waitFor({timeout:60000});version=await desktop.evaluate(({app})=>app.getVersion())
  await page.locator('.navigation').getByRole('button',{name:/^任务/}).click()
  const rows=page.locator('.jobs-list .job'),row=id=>page.locator(`.job[data-job-id="${id}"]`)
  const count=async n=>page.waitForFunction(n=>document.querySelectorAll('.jobs-list .job').length===n,n)
  await count(50);assert.equal(await row(paused.id).getByRole('checkbox').isDisabled(),true);assert.equal(await row(paused.id).getByRole('button',{name:'删除记录',exact:true}).count(),0)
  assert.equal(await page.locator('.job-input,.job-paths').count(),0);assert.equal(await rows.first().locator('.job-timing .job-codecs').count(),1)
  await page.getByRole('combobox',{name:'任务状态',exact:true}).click();await page.getByRole('listbox').waitFor()
  assert.ok(await page.getByRole('listbox').evaluate(e=>parseFloat(getComputedStyle(e).borderTopLeftRadius)>=8))
  await page.keyboard.press('Escape');assert.ok(await page.getByRole('combobox',{name:'任务状态',exact:true}).evaluate(e=>parseFloat(getComputedStyle(e).borderTopLeftRadius)>=8))
  await row(records[104].id).getByRole('button',{name:'查看详细信息',exact:true}).click();await page.getByRole('heading',{name:'任务详细信息',exact:true}).waitFor()
  await page.locator('.task-record-grid > div').filter({has:page.locator('dt').filter({hasText:'处理时长'})}).getByText('未记录',{exact:true}).waitFor()
  await page.getByRole('button',{name:'返回任务',exact:true}).click();await count(50)
  await page.getByRole('button',{name:'下一页',exact:true}).click();await count(50)
  await page.getByLabel('跳转页码',{exact:true}).fill('3');await page.getByLabel('跳转页码',{exact:true}).press('Enter');await count(6)
  const lastIds=await rows.evaluateAll(elements=>elements.map(e=>e.dataset.jobId)),first=lastIds[0],record=records.find(j=>j.id===first)
  await desktop.evaluate(({shell})=>{globalThis.__taskReveals=[];shell.showItemInFolder=path=>globalThis.__taskReveals.push(path)})
  await row(first).getByRole('button',{name:'查看输入文件',exact:true}).click();await row(first).getByRole('button',{name:'查看输出文件',exact:true}).click()
  assert.deepEqual(await desktop.evaluate(()=>globalThis.__taskReveals),[input,record.plan.outputPath])
  await row(first).getByRole('button',{name:'查看详细信息',exact:true}).click()
  await page.getByRole('heading',{name:'任务详细信息',exact:true}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await rows.count(),0)
  assert.equal(await page.locator('.task-record-grid dt').count(),9)
  const value=label=>page.locator('.task-record-grid > div').filter({has:page.locator('dt').filter({hasText:label})}).locator('dd')
  assert.ok((await value('开始时间').innerText()).includes('2026'));assert.ok((await value('结束时间').innerText()).includes('2026'));assert.equal(await value('处理时长').innerText(),'00:00:12,345');assert.equal(await value('进程退出码').innerText(),'0')
  assert.ok((await page.locator('.code-box').allTextContents()).join('\n').includes('audioBitrate'));assert.equal(await page.locator('.task-event-list li').count(),3)
  await page.waitForFunction(()=>document.querySelector('.task-full-log')?.textContent.startsWith('日志开始'))
  let text=await page.locator('.task-full-log').innerText(),segments=1
  while(await page.getByRole('button',{name:'下一段',exact:true}).isEnabled()){
    const previous=text.length;await page.getByRole('button',{name:'下一段',exact:true}).click();segments++
    await page.getByText(`第 ${segments} 段`,{exact:false}).waitFor();await page.locator('.task-full-log').waitFor();text+=await page.locator('.task-full-log').innerText();assert.ok(text.length>previous)
  }
  assert.equal(text,longLog);assert.ok(segments>2)
  await page.getByRole('button',{name:'返回任务',exact:true}).click();await count(6);assert.equal(await page.getByLabel('跳转页码',{exact:true}).inputValue(),'3')
  await page.getByRole('checkbox',{name:'选择本页记录',exact:true}).check();await page.getByRole('button',{name:'删除所选',exact:true}).click()
  const modal=page.getByRole('dialog',{name:'删除任务记录',exact:true});await modal.waitFor();await modal.getByRole('button',{name:'取消',exact:true}).click();await modal.waitFor({state:'hidden'});await count(6)
  await desktop.evaluate(({ipcMain})=>{const key='muxivra:deleteJobRecords',original=ipcMain._invokeHandlers.get(key);ipcMain.removeHandler(key);ipcMain.handle(key,async(event,...args)=>{await new Promise(r=>setTimeout(r,800));return original(event,...args)})})
  await page.getByRole('button',{name:'删除所选',exact:true}).click();await modal.getByRole('button',{name:'删除记录',exact:true}).click()
  await modal.getByRole('button',{name:'正在删除…',exact:true}).waitFor();assert.equal(await modal.getByRole('button',{name:'正在删除…',exact:true}).getAttribute('aria-busy'),'true')
  await page.keyboard.press('Escape');assert.equal(await modal.isVisible(),true);await page.screenshot({path:'artifacts/qa/tasks-delete-feedback.png'})
  await modal.waitFor({state:'hidden'});lastIds.forEach(id=>deleted.add(id));await count(50);assert.equal(await page.getByLabel('跳转页码',{exact:true}).inputValue(),'2')
  const singleId=await rows.first().getAttribute('data-job-id');await row(singleId).getByRole('button',{name:'删除记录',exact:true}).click();await modal.getByRole('button',{name:'删除记录',exact:true}).click();await modal.waitFor({state:'hidden'});deleted.add(singleId);await count(49)
  // Selection survives page changes, allowing a single batch across two pages.
  const secondId=await rows.first().getAttribute('data-job-id');await rows.first().getByRole('checkbox').check();await page.getByRole('button',{name:'上一页',exact:true}).click();await count(50)
  const thirdRow=rows.filter({has:page.locator('.job-selection:not(:disabled)')}).first(),thirdId=await thirdRow.getAttribute('data-job-id');await thirdRow.getByRole('checkbox').check();await page.getByText('已选 2 条',{exact:true}).waitFor()
  await page.getByRole('button',{name:'删除所选',exact:true}).click();await modal.getByRole('button',{name:'删除记录',exact:true}).click();await modal.waitFor({state:'hidden'});[secondId,thirdId].forEach(id=>deleted.add(id))
  await page.getByLabel('搜索任务',{exact:true}).fill('record-000');await count(0);await page.getByLabel('搜索任务',{exact:true}).fill('');await count(50)
  await desktop.evaluate(({dialog},{input,output})=>{dialog.showOpenDialog=async(_parent,options)=>({canceled:false,filePaths:options.properties.includes('openDirectory')?[output]:[input]})},{input,output})
  const real=await page.evaluate(async({input,output,options})=>{await window.muxivra.selectFiles('media',false);await window.muxivra.selectDirectory('output');const s=await window.muxivra.snapshot();if(!s.engine)await window.muxivra.detectEngine();return (await window.muxivra.submit([{inputPath:input,outputPath:output+'\\real-queue.m4a',options}]))[0]},{input,output,options})
  let completed
  for(let i=0;i<300;i++){completed=await page.evaluate(id=>window.muxivra.jobDetails(id),real.id);if(completed.status==='completed'&&completed.finishedAt)break;if(completed.status==='failed')throw new Error(completed.error);await page.waitForTimeout(100)}
  assert.ok(completed.startedAt&&completed.finishedAt&&completed.elapsedMs>0);assert.equal(completed.exitCode,0);assert.deepEqual(completed.events.map(e=>e.type),['queued','started','completed']);assert.ok(completed.executedArgs.includes(completed.temporaryPath))
  const fullLog=await readFile(completed.logPath,'utf8');assert.ok(fullLog.startsWith('{"engine":'));const footer=JSON.parse(fullLog.trim().split(/\r?\n/).at(-1));assert.equal(footer.status,'completed');assert.equal(footer.elapsedMs,completed.elapsedMs)
  await exec(ffmpeg,['-v','error','-i',completed.plan.outputPath,'-f','null','-'],{windowsHide:true})
  for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.screenshot({path:`artifacts/qa/tasks-history-${theme}.png`})}
  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:1040,height:720}));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  await page.screenshot({path:'artifacts/qa/tasks-history-minimum.png'})
  await row(real.id).getByRole('button',{name:'查看详细信息',exact:true}).click();await page.getByRole('heading',{name:'任务详细信息',exact:true}).waitFor();await page.screenshot({path:'artifacts/qa/tasks-detail-minimum.png'})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  // All media remains; only selected record logs have been removed.
  const expectedHash=createHash('sha256').update(await readFile(encoded)).digest('hex')
  for(const item of records){assert.equal(createHash('sha256').update(await readFile(item.plan.outputPath)).digest('hex'),expectedHash);if(deleted.has(item.id))await assert.rejects(readFile(item.logPath));else assert.equal(await readFile(item.logPath,'utf8'),longLog)}
  const quit=async()=>{const exit=desktop.waitForEvent('close');await page.evaluate(()=>window.muxivra.requestExit());await page.getByRole('button',{name:'退出应用',exact:true}).click();await exit}
  await quit();closed=true
  const historyRoot=join(profile,'job-history'),index=JSON.parse(await readFile(join(historyRoot,'index.json'),'utf8'));assert.equal(index.pageSize,50);assert.equal(index.pages.length,2)
  const saved=(await Promise.all(index.pages.map(async name=>{const json=await readFile(join(historyRoot,name),'utf8'),page=JSON.parse(json);assert.ok(page.jobs.length<=50);assert.equal(name,`page-${createHash('sha256').update(json).digest('hex')}.json`);return page.jobs}))).flat()
  assert.equal(saved.length,98);assert.equal(saved.find(j=>j.id===paused.id).status,'paused');await assert.rejects(readFile(join(profile,'jobs.json')))
  desktop=await launch();closed=false;const reopened=await desktop.firstWindow();await reopened.getByRole('heading',{name:'单文件',exact:true}).waitFor({timeout:60000})
  const after=await reopened.evaluate(()=>window.muxivra.snapshot());assert.equal(after.jobs.length,98);assert.ok(after.jobs.every(j=>!deleted.has(j.id)));assert.equal(after.jobs.find(j=>j.id===paused.id).status,'paused')
  assert.deepEqual(errors,[])
  const report={appVersion:version,executable:process.env.MUXIVRA_EXECUTABLE||'development',legacyFixtures:106,pageSize:50,pagesBefore:3,pagesAfter:2,deletedRecords:deleted.size,singleAndCrossPageBatchDeletion:true,confirmationCancelAndBusyLock:true,activeDeletionDisabled:true,compactRows:true,separateInputOutputReveal:true,secondaryDetails:true,timestampsAndElapsed:true,completeUnicodeLogSegments:segments,realAacExecutionRecord:true,actualArgsAndExitCode:true,fullLogCompletionFooter:true,mediaHashesPreserved:true,migrationAndRestart:true,roundedDropdowns:true,themes:['light','dark'],minimumWindow:[1040,720],errors}
  await writeFile('artifacts/qa/task-history-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
} finally {
  if(desktop&&!closed)await desktop.close();const rel=relative(resolve('.test-data'),root);if(rel&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel))await rm(root,{recursive:true,force:true})
}
