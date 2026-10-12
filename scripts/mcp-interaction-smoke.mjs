import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'

const exec=promisify(execFile)
await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const root=await mkdtemp(resolve('.test-data','interaction-')),media=join(root,'input'),profile=join(root,'profile'),engines=join(root,'engines')
await mkdir(media);const input=join(media,'测试音乐.mp3'),video=join(media,'preview.mp4')
await exec('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=660','-t','2','-c:a','libmp3lame',input],{windowsHide:true})
await exec('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24','-t','5','-c:v','libx264',video],{windowsHide:true})
const portServer=createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r))
const launch=()=>electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE||electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_DATA_PATH:profile,MUXIVRA_ENGINE_PATH:engines},timeout:60000})
let desktop=await launch(),client,output
const errors=[],report={executable:process.env.MUXIVRA_EXECUTABLE||'development build',errors}
const call=async(name,args={})=>{const value=await client.callTool({name,arguments:args});assert.ok(!value.isError,value.content[0].text);return JSON.parse(value.content[0].text)}
async function connect(snapshot){client=new Client({name:'muxivra-interaction-smoke',version:'1.0'});await client.connect(new StreamableHTTPClientTransport(new URL(snapshot.mcp.url),{requestInit:{headers:{Authorization:`Bearer ${snapshot.settings.mcp.token}`}}}))}
async function poll(page,fn,check){for(let i=0;i<300;i++){const value=await page.evaluate(fn);if(check(value))return value;await page.waitForTimeout(50)}throw new Error('State timeout')}
try{
  let page=await desktop.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.getByRole('heading',{name:'单文件',exact:true}).waitFor({timeout:60000})
  const base=await page.evaluate(()=>window.muxivra.snapshot())
  await page.evaluate(settings=>window.muxivra.saveSettings(settings),{...base.settings,theme:'light',mcp:{...base.settings.mcp,enabled:true,port,allowSubmit:false,inputRoots:[]}})
  let snapshot=await page.evaluate(()=>window.muxivra.snapshot());await connect(snapshot)
  assert.ok(client.getInstructions().includes('request_directory_access'));assert.equal((await client.listTools()).tools.length,20);assert.ok(!(await client.listTools()).tools.some(tool=>/approv|review/.test(tool.name)))
  assert.equal((await client.callTool({name:'list_media_files',arguments:{directory:media}})).isError,true)
  const args={path:media,permission:'input',reason:'读取用户选择的测试音乐与视频',requestKey:'directory-once'},directory=await call('request_directory_access',args)
  assert.equal(directory.status,'pending');assert.deepEqual((await page.evaluate(()=>window.muxivra.snapshot())).settings.mcp.inputRoots,[])
  assert.equal((await call('request_directory_access',args)).id,directory.id)
  await page.locator('.navigation').getByRole('button',{name:/^MCP 交互/}).click();await page.getByRole('button',{name:'查看并确认',exact:true}).click()
  assert.ok((await page.locator('.mcp-interaction').innerText()).includes(media))
  await page.getByLabel('备注（可选）',{exact:true}).fill('仅授权此测试输入目录')
  await desktop.evaluate(({ipcMain})=>{const name='muxivra:reviewMcpRequest',original=ipcMain._invokeHandlers.get(name);ipcMain.removeHandler(name);ipcMain.handle(name,async(event,...args)=>{await new Promise(r=>setTimeout(r,650));return original(event,...args)})})
  await page.getByRole('button',{name:'批准目录访问',exact:true}).click();const approving=page.getByRole('button',{name:'正在批准…',exact:true});await approving.waitFor();assert.equal(await approving.getAttribute('aria-busy'),'true');assert.equal(await approving.isDisabled(),true)
  await page.getByText('审核备注：仅授权此测试输入目录',{exact:true}).waitFor();assert.equal((await call('get_request',{id:directory.id})).status,'approved')
  assert.ok((await call('list_media_files',{directory:media})).includes(input));report.folderApprovalBlocksAccessUntilConfirmed=true;report.approvalLoadingFeedback=true
  snapshot=await page.evaluate(()=>window.muxivra.snapshot());assert.deepEqual(snapshot.settings.mcp.inputRoots,[media]);output=join(snapshot.defaultMcpOutputPath,`${root.split(sep).at(-1)}.m4a`)
  const request={inputPath:input,outputPath:output,options:{container:'m4a',video:'none',audio:'aac',quality:22,speed:'medium',audioBitrate:192,subtitles:'none',conflict:'reject'}}
  assert.equal((await client.callTool({name:'submit_jobs',arguments:{requests:[request]}})).isError,true)
  const taskArgs={requests:[request],reason:'将这首测试音乐转为 AAC M4A',requestKey:'transcode-once'},application=await call('request_transcode',taskArgs)
  assert.equal(application.status,'pending');assert.equal((await page.evaluate(()=>window.muxivra.snapshot())).jobs.length,0)
  await page.getByRole('button',{name:'返回 MCP 交互',exact:true}).click();await page.getByRole('button',{name:'查看并确认',exact:true}).click()
  await page.getByText('创建 1 个转码任务',{exact:true}).waitFor();await page.getByRole('button',{name:'批准并创建任务',exact:true}).click();await page.getByRole('button',{name:'查看任务',exact:true}).waitFor()
  const approved=await call('get_request',{id:application.id});assert.equal(approved.status,'approved');assert.equal(approved.jobIds.length,1)
  assert.equal((await call('request_transcode',taskArgs)).id,application.id)
  let final;for(let i=0;i<300;i++){final=await call('get_job',{id:approved.jobIds[0]});if(final.finishedAt)break;await page.waitForTimeout(50)}assert.equal(final.status,'completed')
  const actual=JSON.parse((await exec('ffprobe',['-v','error','-show_streams','-show_format','-of','json',output],{windowsHide:true})).stdout);assert.equal(actual.streams[0].codec_name,'aac');assert.ok(actual.format.format_name.includes('m4a'))
  assert.equal((await page.evaluate(()=>window.muxivra.snapshot())).jobs.length,1);assert.equal((await page.evaluate(()=>window.muxivra.snapshot())).settings.mcp.allowSubmit,false)
  report.oneTimeAacApprovalWithSubmitDisabled=true;report.requestRetriesDoNotDuplicateJobs=true
  const refused=await call('request_directory_access',{path:root,permission:'output',reason:'测试拒绝后不授权',requestKey:'rejected-output'})
  await page.getByRole('button',{name:'返回 MCP 交互',exact:true}).click();await page.getByRole('button',{name:'查看并确认',exact:true}).click();await page.getByLabel('备注（可选）').fill('保留默认 outputs')
  await page.getByRole('button',{name:'拒绝申请',exact:true}).click();await page.getByText('审核备注：保留默认 outputs',{exact:true}).waitFor();assert.equal((await call('get_request',{id:refused.id})).status,'rejected');assert.ok(!(await page.evaluate(()=>window.muxivra.snapshot())).settings.mcp.outputRoots.includes(root));report.rejectionDoesNotGrantAccess=true
  await page.getByRole('button',{name:'返回 MCP 交互',exact:true}).click();await page.screenshot({path:'artifacts/qa/mcp-interaction-light.png',fullPage:true})
  snapshot=await page.evaluate(()=>window.muxivra.snapshot());await page.evaluate(settings=>window.muxivra.saveSettings(settings),{...snapshot.settings,theme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');await page.screenshot({path:'artifacts/qa/mcp-interaction-dark.png',fullPage:true})
  // Edit a real binding in its secondary page, then apply through the navigation guard.
  await page.locator('.navigation').getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'编辑快捷键',exact:true}).click()
  const toggle=page.locator('[data-shortcut="player.toggle"]');await toggle.getByRole('button',{name:'播放 / 暂停快捷键',exact:true}).click();await page.keyboard.press('Control+p');assert.ok(await toggle.evaluate(e=>e.classList.contains('setting-changed')))
  const mute=page.locator('[data-shortcut="player.mute"]');await mute.getByRole('button',{name:'静音 / 取消静音快捷键',exact:true}).click();await page.keyboard.press('Control+p');await page.getByText('请先解决快捷键冲突，再保存设置。播放器快捷键也用于字幕页。',{exact:true}).waitFor()
  await mute.getByRole('button',{name:'重置静音 / 取消静音快捷键',exact:true}).click();await page.screenshot({path:'artifacts/qa/shortcuts-dark.png',fullPage:true})
  await page.locator('.navigation').getByRole('button',{name:'单文件',exact:true}).click();const leave=page.getByRole('dialog',{name:'应用设置更改？',exact:true});await leave.waitFor();await leave.getByRole('button',{name:'应用并离开',exact:true}).click();await page.getByRole('button',{name:'选择媒体文件',exact:true}).waitFor()
  snapshot=await page.evaluate(()=>window.muxivra.snapshot());assert.equal(snapshot.settings.shortcuts['player.toggle'],'Ctrl+KeyP')
  await desktop.evaluate(({dialog},video)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[video]})},video)
  await page.getByRole('button',{name:'选择媒体文件',exact:true}).click();await poll(page,()=>window.muxivra.playerState('single'),state=>state.ready&&state.path&&!state.loading)
  await desktop.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.setAlwaysOnTop(true);window.show();window.focus()})
  await page.getByLabel('音量百分比',{exact:true}).click();await page.locator('.mpv-player[data-player-owner="single"]').evaluate(e=>e.focus());await page.waitForTimeout(150);await page.keyboard.press('Control+p');await poll(page,()=>window.muxivra.playerState('single'),state=>!state.paused)
  await page.keyboard.press('Space');await page.waitForTimeout(150);assert.equal((await page.evaluate(()=>window.muxivra.playerState('single'))).paused,false)
  await page.evaluate(()=>window.muxivra.playerAction('single',{type:'pause'}))
  await desktop.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.setAlwaysOnTop(true);window.show();window.focus()});await page.locator('.mpv-viewport').click();await page.waitForTimeout(100)
  await page.evaluate(()=>window.muxivra.playerAction('single',{type:'pause'}));await poll(page,()=>window.muxivra.playerState('single'),state=>state.paused);await page.keyboard.press('Control+p');await poll(page,()=>window.muxivra.playerState('single'),state=>!state.paused)
  await page.keyboard.press('Space');await page.waitForTimeout(150);assert.equal((await page.evaluate(()=>window.muxivra.playerState('single'))).paused,false);report.customShortcutWorksInRendererAndNativeVideo=true
  await desktop.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.setAlwaysOnTop(false);window.setBounds({width:1040,height:720})})
  await page.locator('.navigation').getByRole('button',{name:/^MCP 交互/}).click();await page.waitForTimeout(100);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth));await page.screenshot({path:'artifacts/qa/mcp-interaction-minimum.png',fullPage:true});report.minimumWindowNoOverflow=true
  await client.close();client=undefined;await desktop.close();desktop=await launch();page=await desktop.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.getByRole('heading',{name:'单文件',exact:true}).waitFor({timeout:60000})
  snapshot=await page.evaluate(()=>window.muxivra.snapshot());assert.equal(snapshot.settings.shortcuts['player.toggle'],'Ctrl+KeyP');await connect(snapshot)
  assert.equal((await call('request_transcode',taskArgs)).id,application.id);assert.equal((await call('get_request',{id:application.id})).status,'approved');assert.equal(snapshot.jobs.length,1)
  const data=JSON.parse(await readFile(join(profile,'mcp-requests.json'),'utf8'));assert.equal(data.records.length,3);assert.equal(data.records.find(r=>r.id===directory.id).reviewerNote,'仅授权此测试输入目录')
  report.requestsAndShortcutsSurviveRestart=true;report.appVersion=await desktop.evaluate(({app})=>app.getVersion());assert.deepEqual(errors,[])
  await writeFile('artifacts/qa/mcp-interaction-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}finally{
  await client?.close().catch(()=>{});await desktop.close()
  if(output)await rm(output,{force:true})
  const local=relative(resolve('.test-data'),root);if(local&&!local.startsWith('..'+sep)&&!isAbsolute(local))await rm(root,{recursive:true,force:true})
}
