import { _electron as electron } from 'playwright'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, join, relative, isAbsolute, sep, dirname, basename } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import electronPath from 'electron'
import { createServer } from 'node:net'
import koffi from 'koffi'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import assert from 'node:assert/strict'
const exec=promisify(execFile)
await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const root=await mkdtemp(resolve('.test-data','desktop-')),output=join(root,'output');await mkdir(output)
const input=join(root,'desktop-input.mp4'),srt=join(root,'source.srt')
const slowInput=join(root,'queue-input.mp4')
await exec('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=480x270:rate=24','-f','lavfi','-i','sine=frequency=440','-t','3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',input],{windowsHide:true})
await writeFile(srt,'1\n00:00:00,000 --> 00:00:01,500\nDesktop subtitle\n')
await exec('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=1280x720:rate=24','-t','12','-c:v','libx264','-preset','ultrafast',slowInput],{windowsHide:true})
const desktop=await electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE || electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_DATA_PATH:join(root,'profile'),MUXIVRA_ENGINE_PATH:join(root,'engines')},timeout:60000})
const errors=[]
try {
  const page=await desktop.firstWindow();page.on('pageerror',error=>errors.push(error.message));await page.getByRole('heading',{name:'单文件',exact:true}).waitFor({timeout:60000})
  const location=await desktop.evaluate(({app})=>({packaged:app.isPackaged,exe:app.getPath('exe'),root:app.getAppPath()})),defaultOutput=join(location.packaged?dirname(location.exe):location.root,'outputs')
  assert.equal((await page.evaluate(()=>window.muxivra.snapshot())).defaultOutputPath,defaultOutput)
  assert.equal(await page.locator('.single-settings .input-action input').inputValue(),defaultOutput)
  assert.equal(await page.locator('.batch-destination .input-action input').inputValue(),defaultOutput)
  async function waitPlayer(owner,predicate){for(let attempt=0;attempt<150;attempt++){const state=await page.evaluate(owner=>window.muxivra.playerState(owner),owner);if(state.error)throw new Error(state.error);if(predicate(state))return state;await page.waitForTimeout(100)}throw new Error(`mpv ${owner} timeout`)}
  async function waitSnapshot(predicate){for(let attempt=0;attempt<300;attempt++){const value=await page.evaluate(()=>window.muxivra.snapshot());if(predicate(value))return value;await page.waitForTimeout(100)}throw new Error('Snapshot condition timeout')}
  const nativeUser=koffi.load('user32.dll'),nativeFind=nativeUser.func('uintptr_t __stdcall FindWindowExW(uintptr_t parent, uintptr_t after, str16 name, str16 title)'),nativeVisible=nativeUser.func('bool __stdcall IsWindowVisible(uintptr_t window)');const mainHandle=await desktop.evaluate(({BrowserWindow})=>Number(BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE()));
  async function screenshot(name) { await page.evaluate(()=>window.scrollTo(0,0)); await page.screenshot({path:`artifacts/qa/${name}.png`,fullPage:true}) }
  await desktop.evaluate(({dialog},values)=>{
    dialog.showOpenDialog=async(_parent,options)=>({canceled:false,filePaths:options.properties.includes('openDirectory')?[values.output]:options.filters?.[0]?.extensions?.includes('srt')?[values.srt]:[values.input]})
    dialog.showSaveDialog=async()=>({canceled:false,filePath:values.exported})
  },{input,output,srt,exported:join(output,'desktop-edited.srt')})
  await page.getByRole('button',{name:'选择媒体文件',exact:true}).click();await page.getByText('desktop-input.mp4',{exact:true}).first().waitFor()
  await waitPlayer('single',s=>s.ready&&!s.loading&&s.videoWidth===480)
  const defaultPlan=await page.evaluate(async values=>{const snapshot=await window.muxivra.snapshot();return window.muxivra.plan({...values,options:snapshot.presets.find(p=>p.id==='h264-1080').options})},{inputPath:input,outputPath:join(defaultOutput,basename(root)+'-default.mp4')});assert.equal(dirname(defaultPlan.outputPath),defaultOutput)
  await page.getByRole('button',{name:'选择输出目录',exact:true}).click();await page.getByRole('button',{name:'检查处理计划',exact:true}).click();await page.getByRole('dialog',{name:'处理计划'}).waitFor();await page.waitForTimeout(150);if(!nativeVisible(nativeFind(mainHandle,0,'STATIC',null)))throw new Error('处理计划弹窗不应隐藏整个原生画面');await page.getByRole('button',{name:'开始处理',exact:true}).click();await page.locator('.tasks-layout .job .status-completed').first().waitFor({timeout:60000});await screenshot('tasks-dark');await page.getByRole('button',{name:'单文件',exact:true}).click()
  await waitPlayer('single',s=>s.ready&&!s.loading&&s.videoWidth===480)
  await page.evaluate(()=>window.muxivra.playerAction('single',{type:'mute',value:true}))
  await page.evaluate(()=>window.muxivra.playerAction('single',{type:'play'}))
  await waitPlayer('single',s=>s.positionMs>250)
  await page.evaluate(()=>window.muxivra.playerAction('single',{type:'pause'}))
  const playback=await page.evaluate(()=>window.muxivra.playerState('single'));if(playback.error||!playback.ready)throw new Error(`mpv failed: ${JSON.stringify(playback)}`)
  await screenshot('single-dark')
  await page.getByRole('button',{name:'批量处理',exact:true}).click();await page.getByRole('button',{name:'添加媒体文件',exact:true}).click();await page.locator('.batch-layout').getByText('desktop-input.mp4',{exact:true}).first().waitFor();await screenshot('batch-dark')
  await page.getByRole('button',{name:'字幕编辑',exact:true}).click();await page.getByRole('button',{name:'导入 SRT',exact:true}).click();await page.locator('.cue-list').getByText('Desktop subtitle',{exact:true}).waitFor();await page.getByRole('button',{name:'载入媒体',exact:true}).click();await waitPlayer('subtitles',s=>s.ready&&!s.loading&&s.videoWidth===480)
  await page.evaluate(()=>window.muxivra.playerAction('subtitles',{type:'seek',positionMs:0}))
  await page.locator('.cue-list').getByText('Desktop subtitle',{exact:true}).click()
  await page.getByLabel('时长',{exact:true}).fill('00:00:01,250');await page.getByLabel('时长',{exact:true}).press('Enter')
  if(await page.getByLabel('结束时间',{exact:true}).inputValue()!=='00:00:01,250')throw new Error('字幕时长未更新结束时间')
  await page.getByRole('button',{name:'撤销',exact:true}).click();if(await page.getByLabel('结束时间',{exact:true}).inputValue()!=='00:00:01,500')throw new Error('一次时长修改需要多次撤销')
  await page.getByRole('button',{name:'重做',exact:true}).click();await page.locator('.cue-text').fill('桌面编辑验证');await page.getByRole('button',{name:'导出 SRT',exact:true}).click();await page.waitForTimeout(500)
  const exportedSubtitle=await readFile(join(output,'desktop-edited.srt'),'utf8');if(!exportedSubtitle.includes('桌面编辑验证')||!exportedSubtitle.includes('00:00:01,250'))throw new Error('桌面字幕导出内容或时间不匹配')
  await waitPlayer('subtitles',s=>s.tracks.some(t=>t.type==='sub'&&t.external));const editorSubs=(await page.evaluate(()=>window.muxivra.playerState('subtitles'))).tracks.filter(t=>t.type==='sub'&&t.external);if(editorSubs.length!==1)throw new Error('编辑字幕被重复载入');await page.waitForTimeout(500);if(await page.locator('.toast-error').count())throw new Error(await page.locator('.toast-error').innerText());await screenshot('subtitles-dark')
  await page.getByRole('button',{name:'设置',exact:true}).click();const firstHardware=await page.evaluate(()=>window.muxivra.snapshot());assert.ok(firstHardware.hardware.detectedAt);assert.ok((await readFile(join(root,'profile','hardware.json'),'utf8')).includes(firstHardware.hardware.detectedAt));await page.getByRole('button',{name:'更新硬件信息',exact:true}).click();await waitSnapshot(s=>s.hardware.detectedAt!==firstHardware.hardware.detectedAt&&!s.hardwareRefreshing);await page.getByRole('button',{name:'更新硬件信息',exact:true}).waitFor();await screenshot('settings-dark')
  assert.ok((await page.locator('.hardware-summary').boundingBox()).height<300,'硬件摘要占位过大')
  await page.getByRole('combobox',{name:'界面主题',exact:true}).click();await page.locator('[role="option"][data-value="light"]').click()
  await page.getByRole('button',{name:'查看详细信息',exact:true}).click();await page.getByRole('heading',{name:'硬件详细信息',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'保存设置',exact:true}).count(),0);await screenshot('hardware-details-dark');await page.getByRole('button',{name:'返回设置',exact:true}).click();assert.equal(await page.getByRole('combobox',{name:'界面主题',exact:true}).innerText(),'浅色','二级页面丢失未保存设置')
  await page.locator('.navigation').getByRole('button',{name:/^任务/}).click();await page.getByRole('button',{name:'展开硬件监控',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.usage-thread').length>0,undefined,{timeout:15000});await screenshot('hardware-monitor-dark');await page.getByRole('button',{name:'收起硬件监控',exact:true}).click();await screenshot('hardware-monitor-compact-dark');await page.getByRole('button',{name:'设置',exact:true}).click()
  await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');await page.getByRole('button',{name:'单文件',exact:true}).click();assert.equal(await page.getByRole('region',{name:'实时硬件监控'}).count(),0);await screenshot('single-light')
  await page.waitForTimeout(7000);const restartedUsage=await page.evaluate(()=>window.muxivra.systemUsage());assert.equal(restartedUsage.threads.status,'missing','离开任务页后采样线程没有停止');await page.waitForTimeout(1100);const resumedUsage=await page.evaluate(()=>window.muxivra.systemUsage());assert.equal(resumedUsage.threads.status,'available');assert.ok(resumedUsage.gpus.some(g=>g.utilization.status==='available'),'监控停止后未能重新启动')
  await page.getByRole('button',{name:'设置',exact:true}).click()
  await desktop.evaluate(({dialog},values)=>{let count=0;dialog.showOpenDialog=async()=>({canceled:false,filePaths:[count++===0?values.root:values.output]})},{root,output})
  await page.locator('.root-section').nth(0).getByRole('button',{name:'添加',exact:true}).click();await page.locator('.root-section').nth(1).getByRole('button',{name:'添加',exact:true}).click();const portServer=createServer();await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));await page.getByLabel('端口',{exact:true}).fill(String(port));await page.getByLabel('启用 MCP',{exact:true}).check();await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.getByText('运行中',{exact:true}).waitFor()
  const connection=await page.evaluate(()=>window.muxivra.snapshot()),client=new Client({name:'muxivra-desktop-verification',version:'1.0'})
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.mcp.url),{requestInit:{headers:{Authorization:`Bearer ${connection.settings.mcp.token}`}}}))
  try {
    const hardware=await client.callTool({name:'get_system_hardware',arguments:{}});assert.equal(hardware.isError,undefined);assert.equal(JSON.parse(hardware.content[0].text).hardware.detectedAt,connection.hardware.detectedAt);const preset=connection.presets.find(item=>item.id==='h264-1080'),submission=await client.callTool({name:'submit_jobs',arguments:{requests:[{inputPath:input,outputPath:join(output,'desktop-ai.mp4'),options:preset.options}],requestKey:'desktop-ai-once'}})
    if(submission.isError)throw new Error(JSON.stringify(submission));const job=JSON.parse(submission.content[0].text).jobs[0]
    await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());if(await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()))throw new Error('关闭窗口未隐藏到托盘')
    let completed=false;for(let attempt=0;attempt<60;attempt++){const response=await client.callTool({name:'get_job',arguments:{id:job.id}}),current=JSON.parse(response.content[0].text);if(current.status==='failed')throw new Error(current.error);if(current.status==='completed'){completed=true;break}await new Promise(resolve=>setTimeout(resolve,100))}if(!completed)throw new Error('托盘后台任务未完成')
    await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());await page.locator('.navigation').getByRole('button',{name:/^任务/}).click();await page.locator('.tasks-layout').getByText('desktop-ai.mp4',{exact:true}).waitFor();await screenshot('mcp-tray-light')
  } finally {await client.close()}
  await desktop.evaluate(({dialog},path)=>{const previous=dialog.showOpenDialog;dialog.showOpenDialog=async()=>{dialog.showOpenDialog=previous;return {canceled:false,filePaths:[path]}}},slowInput)
  await page.evaluate(()=>window.muxivra.selectFiles('media'))
  const queued=await page.evaluate(async values=>{
    const snapshot=await window.muxivra.snapshot(),options=snapshot.presets.find(p=>p.id==='h264-1080').options
    return window.muxivra.submit(values.names.map((name,index)=>({inputPath:values.input,outputPath:values.output+'\\'+name,options:index===0?{...options,video:'libx265',speed:'veryslow',advanced:{encodeThreads:1},audio:'none'}:options})))
  },{input:slowInput,output,names:['queue-running.mp4','queue-held.mp4','queue-first.mp4','queue-last.mp4']})
  const row=id=>page.locator(`.tasks-layout [data-job-id="${id}"]`)
  await waitSnapshot(s=>s.jobs.find(j=>j.id===queued[0].id)?.processedMs>0&&s.jobs.find(j=>j.id===queued[0].id)?.elapsedMs>=1000)
  await row(queued[0].id).getByRole('button',{name:'暂停',exact:true}).click();await row(queued[0].id).getByText('已暂停',{exact:true}).waitFor()
  const beforePause=(await page.evaluate(()=>window.muxivra.snapshot())).jobs.find(j=>j.id===queued[0].id);await page.waitForTimeout(350)
  const afterPause=(await page.evaluate(()=>window.muxivra.snapshot())).jobs.find(j=>j.id===queued[0].id);assert.equal(afterPause.elapsedMs,beforePause.elapsedMs);assert.ok(afterPause.estimatedRemainingMs>=0)
  await row(queued[1].id).getByRole('button',{name:'暂停',exact:true}).click();await row(queued[1].id).getByText('已暂停',{exact:true}).waitFor()
  await row(queued[3].id).getByRole('button',{name:'置顶任务',exact:true}).click();await waitSnapshot(s=>s.jobs.filter(j=>queued.slice(1).some(k=>k.id===j.id)).map(j=>j.id).join()===[queued[3].id,queued[1].id,queued[2].id].join())
  await row(queued[3].id).getByText('队列 #1',{exact:true}).waitFor()
  await page.getByRole('button',{name:'展开硬件监控',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.usage-thread').length>0)
  const monitorSample=await page.evaluate(()=>window.muxivra.systemUsage());assert.equal(monitorSample.threads.value.length,(await page.evaluate(()=>window.muxivra.snapshot())).hardware.cpu.value.logicalCores);assert.ok(monitorSample.cpu.value>=0&&monitorSample.cpu.value<=100);assert.ok(monitorSample.gpus.length>0);assert.ok(monitorSample.gpus.some(g=>g.utilization.status==='available'&&g.dedicatedBytes.status==='available'));assert.ok(monitorSample.memory.usedBytes>0&&monitorSample.memory.usedBytes<monitorSample.memory.totalBytes);await screenshot('hardware-monitor-light');await writeFile('artifacts/qa/hardware-usage.json',JSON.stringify(monitorSample,null,2))
  await page.locator('.usage-engines summary').first().click();assert.ok(await page.locator('.usage-engines[open] .usage-meter').count()>0);await page.locator('.usage-engines summary').first().click()
  await page.getByRole('button',{name:'收起硬件监控',exact:true}).click();await screenshot('tasks-paused-light')
  await row(queued[0].id).getByRole('button',{name:'继续',exact:true}).click();await row(queued[0].id).getByText('处理中',{exact:true}).waitFor();await row(queued[0].id).getByRole('button',{name:'暂停',exact:true}).click();await row(queued[0].id).getByText('已暂停',{exact:true}).waitFor()
  for(const job of queued.slice(1))await row(job.id).getByRole('button',{name:'取消',exact:true}).click()
  await row(queued[0].id).getByRole('button',{name:'取消',exact:true}).click();await row(queued[0].id).getByText('已取消',{exact:true}).waitFor()
  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:1040,height:720}));await page.evaluate(()=>window.scrollTo(0,0));if(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth))throw new Error('最小窗口尺寸出现横向溢出');await screenshot('batch-minimum-light')
  await page.getByRole('button',{name:'展开硬件监控',exact:true}).click();const monitorBounds=await page.locator('.hardware-monitor').boundingBox();assert.ok(monitorBounds.x>=184&&monitorBounds.x+monitorBounds.width<=1040&&monitorBounds.y>=0&&monitorBounds.y+monitorBounds.height<=720);await screenshot('hardware-monitor-minimum-light');await page.getByRole('button',{name:'收起硬件监控',exact:true}).click();await page.getByRole('button',{name:'设置',exact:true}).click();await screenshot('settings-minimum-light');assert.ok((await page.locator('.hardware-summary').boundingBox()).height<300);await page.getByRole('button',{name:'查看详细信息',exact:true}).click();await screenshot('hardware-details-minimum-light');await page.getByRole('button',{name:'返回设置',exact:true}).click()
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);if(overflow)throw new Error('窗口出现横向溢出');if(errors.length)throw new Error(`页面错误：${errors.join('; ')}`)
  const snapshot=await page.evaluate(()=>window.muxivra.snapshot());const report={appVersion:await desktop.evaluate(({app})=>app.getVersion()),executable:process.env.MUXIVRA_EXECUTABLE||'development build',engine:snapshot.engine?.version,defaultOutputDirectory:defaultOutput,defaultOutputPlan:true,completed:snapshot.jobs.filter(job=>job.status==='completed').length,mediaPlayback:playback,pages:['single','batch','tasks','subtitles','settings'],hardwareFirstReadAndRefresh:true,hardwareSummaryAndDetails:true,settingsDraftPreserved:true,liveSystemUsage:monitorSample,hardware: snapshot.hardware,themes:['dark','light'],mcpSharedQueue:true,taskGuiPauseResumeCancelOrderAndEta:true,trayBackground:true,minimumWindow:[1040,720],errors};await writeFile('artifacts/qa/desktop-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
} finally {
  await desktop.close();const rel=relative(resolve('.test-data'),root);if(rel&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel))await rm(root,{recursive:true,force:true})
}
