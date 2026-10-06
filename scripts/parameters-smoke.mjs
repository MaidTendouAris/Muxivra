import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { mkdir,mkdtemp,writeFile,readFile,rm } from 'node:fs/promises'
import { join,resolve,relative,isAbsolute,sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
import koffi from 'koffi'
const exec=promisify(execFile)
await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const root=await mkdtemp(resolve('.test-data','parameters-')),output=join(root,'output');await mkdir(output)
const input=join(root,'parameters.mp4'),file=join(output,'presets.json'),bad=join(output,'bad.json')
await exec('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=480x270:rate=24','-f','lavfi','-i','sine=frequency=440','-t','4','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',input],{windowsHide:true})
const desktop=await electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE||electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_DATA_PATH:join(root,'profile'),MUXIVRA_ENGINE_PATH:join(root,'engines')},timeout:60000})
try {
  const page=await desktop.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.getByRole('heading',{name:'单文件',exact:true}).waitFor({timeout:60000})
  await desktop.evaluate(({dialog},values)=>{dialog.showOpenDialog=async(_window,options)=>({canceled:false,filePaths:[options.properties.includes('openDirectory')?values.output:options.title==='导入预设'?values.file:values.input]});dialog.showSaveDialog=async()=>({canceled:false,filePath:values.file})},{input,output,file})
  const choose=async(name,value)=>{await page.getByRole('combobox',{name,exact:true}).click();await page.locator(`[role="option"][data-value="${value}"]`).click()}
  const shot=async name=>page.screenshot({path:`artifacts/qa/${name}.png`,fullPage:true})
  await page.getByRole('button',{name:'选择媒体文件',exact:true}).click()
  for(let i=0;i<100;i++){if((await page.evaluate(()=>window.muxivra.playerState('single'))).videoWidth===480)break;await page.waitForTimeout(100)}
  const user=koffi.load('user32.dll'),find=user.func('uintptr_t __stdcall FindWindowExW(uintptr_t parent, uintptr_t after, str16 name, str16 title)'),visible=user.func('bool __stdcall IsWindowVisible(uintptr_t window)'),main=await desktop.evaluate(({BrowserWindow})=>Number(BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE())),surface=Number(find(main,0,'STATIC',null))
  await page.getByRole('combobox',{name:'视频编码',exact:true}).click();await page.waitForTimeout(100);assert.equal(visible(surface),true);await page.getByRole('listbox').waitFor();console.log('Dropdown geometry',await page.getByRole('listbox').boundingBox());await page.screenshot({path:'artifacts/qa/dropdown-dark.png'});await page.keyboard.press('Escape');await page.waitForTimeout(100);assert.equal(visible(surface),true)
  assert.ok(await page.locator('body').evaluate(e=>parseFloat(getComputedStyle(e).fontSize))>=16)
  await page.getByRole('button',{name:'详细参数',exact:true}).click();await page.getByRole('dialog',{name:'详细参数'}).waitFor();await page.waitForTimeout(100);assert.equal(visible(surface),true)
  const overlap=await page.evaluate(()=>{const video=document.querySelector('[data-player-owner="single"] .mpv-viewport').getBoundingClientRect(),dialog=document.querySelector('[role="dialog"]').getBoundingClientRect();return{x:((Math.max(video.left,dialog.left)+Math.min(video.right,dialog.right))/2-video.left)*devicePixelRatio,y:((Math.max(video.top,dialog.top)+Math.min(video.bottom,dialog.bottom))/2-video.top)*devicePixelRatio}})
  const gdi=koffi.load('gdi32.dll'),region=gdi.func('uintptr_t __stdcall CreateRectRgn(int left, int top, int right, int bottom)')(0,0,1,1)
  try {assert.ok(user.func('int __stdcall GetWindowRgn(uintptr_t window, uintptr_t region)')(surface,region));assert.equal(gdi.func('bool __stdcall PtInRegion(uintptr_t region, int x, int y)')(region,Math.round(overlap.x),Math.round(overlap.y)),false)}finally{gdi.func('bool __stdcall DeleteObject(uintptr_t object)')(region)}
  await page.getByLabel('开始时间（秒）',{exact:true}).fill('0.5');await page.getByLabel('结束时间（秒）',{exact:true}).fill('2.5')
  await page.getByRole('button',{name:'视频滤镜',exact:true}).click();await choose('添加视频滤镜','crop');await page.getByRole('dialog',{name:'详细参数'}).getByRole('button',{name:'添加',exact:true}).click()
  await page.getByLabel('裁剪宽度 · out_w',{exact:true}).fill('256');await page.getByLabel('裁剪高度 · out_h',{exact:true}).fill('144');await shot('advanced-filters-dark')
  await page.getByRole('button',{name:'音频',exact:true}).click();await page.getByLabel('采样率（Hz）',{exact:true}).fill('44100');await page.getByLabel('声道数',{exact:true}).fill('1')
  await page.getByRole('button',{name:'编码器专用参数',exact:true}).click();await choose('自适应量化模式 · aq-mode','variance')
  await page.locator('.internal-parameters > summary').click();await page.getByLabel('量化曲线压缩 · qcomp',{exact:true}).fill('0.7');
  await page.getByRole('button',{name:'应用参数',exact:true}).click();await page.locator('.single-settings').getByLabel('帧率',{exact:true}).fill('12')
  await page.getByRole('button',{name:'详细参数'}).first().click();await page.getByLabel('搜索参数',{exact:true}).fill('gop');await page.getByLabel('关键帧间隔（帧）',{exact:true}).fill('72');await page.getByRole('button',{name:'取消',exact:true}).click()
  await page.getByRole('button',{name:'保存为预设',exact:true}).click();await page.getByLabel('预设名称',{exact:true}).fill('GUI 参数集');await page.getByRole('button',{name:'保存预设',exact:true}).click()
  await page.getByRole('button',{name:'选择输出目录',exact:true}).click();await page.getByRole('button',{name:'检查处理计划',exact:true}).click();await page.getByRole('dialog',{name:'处理计划'}).waitFor()
  await page.getByRole('button',{name:'开始处理',exact:true}).click();await page.locator('.tasks-layout .job .status-completed').first().waitFor({timeout:60000})
  const snapshot=await page.evaluate(()=>window.muxivra.snapshot()),job=snapshot.jobs[0];assert.equal(job.status,'completed');assert.equal(job.plan.options.advanced.gop,undefined);assert.equal(job.plan.options.filters[0].name,'crop');assert.equal(job.plan.durationMs,2000)
  await page.getByRole('button',{name:'单文件',exact:true}).click()
  await desktop.evaluate(async({dialog},outputPath)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[outputPath]})},job.plan.outputPath)
  await page.getByRole('button',{name:'更换文件',exact:true}).click();const info=await page.evaluate(path=>window.muxivra.inspect(path),job.plan.outputPath);assert.equal(info.streams[0].width,256);assert.equal(info.streams[0].height,144);assert.equal(info.streams[0].frameRate,'12/1');assert.equal(info.streams[1].sampleRate,44100)
  await page.getByRole('button',{name:'预设',exact:true}).click();await page.getByLabel('选择预设 GUI 参数集',{exact:true}).check();await page.getByRole('button',{name:'导出所选 (1)',exact:true}).click()
  const saved=JSON.parse(await readFile(file,'utf8'));assert.equal(saved.format,'muxivra-presets');assert.equal(saved.version,1);assert.equal(saved.presets[0].options.filters[0].options.out_w,'256');assert.equal(saved.presets[0].options.encoderOptions[0].value,'variance');assert.equal(saved.presets[0].options.codecParameters.qcomp,'0.7')
  await desktop.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]})},file)
  await page.getByRole('button',{name:'导入',exact:true}).click();await page.waitForFunction(async()=>{const s=await window.muxivra.snapshot();return s.presets.filter(p=>p.name==='GUI 参数集').length===2})
  for(let i=0;i<30;i++){if(await page.getByText('GUI 参数集',{exact:true}).count()===2)break;await page.waitForTimeout(100)}assert.equal(await page.getByText('GUI 参数集',{exact:true}).count(),2)
  await shot('presets-dark')
  saved.version=9;await writeFile(bad,JSON.stringify(saved));await desktop.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]})},bad);await page.getByRole('button',{name:'导入',exact:true}).click();await page.locator('.toast-error').waitFor();assert.equal((await page.evaluate(()=>window.muxivra.snapshot())).presets.filter(p=>p.name==='GUI 参数集').length,2);await page.getByRole('button',{name:'关闭提示',exact:true}).click()
  await page.getByRole('button',{name:'设置',exact:true}).click();await choose('界面主题','light');await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.waitForFunction(()=>document.documentElement.dataset.theme==='light')
  await page.getByRole('button',{name:'单文件',exact:true}).click();await page.getByRole('button',{name:'详细参数'}).first().click();await shot('advanced-light')
  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:1040,height:720}));await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await page.locator('.parameter-content').evaluate(e=>e.scrollWidth>e.clientWidth),false);await shot('advanced-minimum-light')
  assert.deepEqual(errors,[])
  const report={appVersion:await desktop.evaluate(({app})=>app.getVersion()),executable:process.env.MUXIVRA_EXECUTABLE||'development',categories:11,commonAndAdvanced:true,dynamicEngineOptions:true,realCropAndTrim:true,realAudioSettings:true,presetGuiRoundtrip:true,invalidImportAtomic:true,dialogCancel:true,readableFonts:true,dropdownNativeOverlay:true,themes:['light','dark'],minimumWindow:[1040,720],errors};await writeFile('artifacts/qa/parameters-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
} finally {await desktop.close();const rel=relative(resolve('.test-data'),root);if(rel&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel))await rm(root,{recursive:true,force:true})}
