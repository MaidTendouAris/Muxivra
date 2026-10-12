import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
import koffi from 'koffi'

// Exercise a real subtitle preview inside its scrolling card with an isolated
// media/project/profile. A fixed fullscreen surface must escape that card.
const exec=promisify(execFile)
await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const root=await mkdtemp(resolve('.test-data','subtitle-fullscreen-')),video=join(root,'preview.mp4')
await exec('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24','-t','5','-c:v','libx264','-preset','ultrafast',video],{windowsHide:true})
const desktop=await electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE||electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_DATA_PATH:join(root,'profile'),MUXIVRA_ENGINE_PATH:join(root,'engines')},timeout:60000})
const errors=[]
try{
  const page=await desktop.firstWindow();page.on('pageerror',error=>errors.push(error.message))
  await page.getByRole('heading',{name:'单文件',exact:true}).waitFor({timeout:60000})
  await desktop.evaluate(({BrowserWindow,dialog},path)=>{const window=BrowserWindow.getAllWindows()[0];window.setBounds({width:1380,height:900});window.setAlwaysOnTop(true);window.show();window.focus();dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]})},video)
  await page.locator('.navigation').getByRole('button',{name:'字幕编辑',exact:true}).click()
  await page.getByRole('button',{name:'载入媒体',exact:true}).click()
  await page.waitForFunction(async()=>{const state=await window.muxivra.playerState('subtitles');return state.ready&&!state.loading&&state.videoWidth===640&&state.durationMs>=4900})
  await page.waitForFunction(()=>document.querySelector('[data-player-owner="subtitles"] .mpv-viewport:not(.audio-viewport)'))
  await page.waitForTimeout(200)
  const user=koffi.load('user32.dll'),gdi=koffi.load('gdi32.dll'),find=user.func('uintptr_t __stdcall FindWindowExW(uintptr_t parent, uintptr_t after, str16 name, str16 title)'),visible=user.func('bool __stdcall IsWindowVisible(uintptr_t window)'),parentOf=user.func('uintptr_t __stdcall GetParent(uintptr_t window)')
  user.func('intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)')(-4)
  const pointType=koffi.struct('SubtitleFullscreenPoint',{x:'int',y:'int'}),toScreen=user.func('ClientToScreen','bool',['uintptr_t',koffi.inout(koffi.pointer(pointType))]),hitWindow=user.func('WindowFromPoint','uintptr_t',[pointType])
  const readRegion=user.func('int __stdcall GetWindowRgn(uintptr_t window, uintptr_t region)'),makeRegion=gdi.func('uintptr_t __stdcall CreateRectRgn(int left, int top, int right, int bottom)'),pointInRegion=gdi.func('bool __stdcall PtInRegion(uintptr_t region, int x, int y)'),disposeRegion=gdi.func('bool __stdcall DeleteObject(uintptr_t object)')
  const main=await desktop.evaluate(({BrowserWindow})=>Number(BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE())),surface=Number(find(main,0,'STATIC',null))
  assert.ok(surface);assert.equal(visible(surface),true)
  const normal=await page.locator('[data-player-owner="subtitles"] .mpv-viewport').boundingBox(),card=await page.locator('.subtitle-preview-card').boundingBox()
  assert.ok(normal.height<=206);assert.ok(card.height<500)
  await page.evaluate(()=>window.muxivra.playerAction('subtitles',{type:'seek',positionMs:1500}))
  await page.waitForFunction(async()=>Math.abs((await window.muxivra.playerState('subtitles')).positionMs-1500)<45)
  await page.getByRole('button',{name:'全屏',exact:true}).click()
  await page.waitForFunction(async()=>{const state=await window.muxivra.playerState('subtitles');return state.fullscreen&&document.querySelector('[data-player-owner="subtitles"].player-fullscreen')})
  await page.waitForFunction(()=>{const box=document.querySelector('[data-player-owner="subtitles"] .mpv-viewport').getBoundingClientRect();return box.width>=innerWidth-1&&box.height>innerHeight*.65})
  const full=await page.locator('[data-player-owner="subtitles"] .mpv-viewport').boundingBox(),scale=await page.evaluate(()=>devicePixelRatio)
  // Check actual native hit areas outside the original preview card. Reading
  // the region alone is insufficient when an unclipped HWND uses no HRGN.
  let aligned=false
  for(let attempt=0;attempt<100&&!aligned;attempt++){
    const origin={x:0,y:0},client={x:0,y:0};toScreen(surface,origin);toScreen(main,client)
    aligned=visible(surface)&&Math.abs(origin.x-client.x-Math.round(full.x*scale))<=1&&Math.abs(origin.y-client.y-Math.round(full.y*scale))<=1
    if(!aligned)await page.waitForTimeout(20)
  }
  assert.ok(aligned,'Fullscreen native surface did not match the full DOM preview')
  const region=makeRegion(0,0,0,0);assert.ok(region)
  try{
    const kind=readRegion(surface,region),origin={x:0,y:0};toScreen(surface,origin)
    for(const [x,y] of [[.1,.15],[.5,.5],[.9,.75]]){
      const px=Math.round(full.width*scale*x),py=Math.round(full.height*scale*y)
      if(kind>0)assert.equal(pointInRegion(region,px,py),true,'Fullscreen remains clipped by the ordinary preview card')
      const hit=Number(hitWindow({x:origin.x+px,y:origin.y+py}));assert.ok(hit===surface||Number(parentOf(hit))===surface,'Fullscreen video hit area did not cover the complete preview')
    }
  }finally{disposeRegion(region)}
  await page.evaluate(()=>{const card=document.querySelector('.subtitle-preview-card'),pad=document.createElement('div');pad.id='fullscreen-scroll-fixture';pad.style.height='600px';card.append(pad);card.scrollTop=60})
  await page.waitForTimeout(40);assert.equal(visible(surface),true,'Scrolling the background preview card hid a fixed fullscreen video')
  await page.evaluate(()=>{document.getElementById('fullscreen-scroll-fixture').remove();document.querySelector('.subtitle-preview-card').scrollTop=0})
  await page.getByRole('button',{name:'退出全屏',exact:true}).click()
  await page.waitForFunction(async()=>!(await window.muxivra.playerState('subtitles')).fullscreen&&!document.querySelector('.player-fullscreen'))
  await page.waitForFunction(()=>document.querySelector('[data-player-owner="subtitles"] .mpv-viewport').getBoundingClientRect().height<=206)
  await page.waitForTimeout(200);assert.equal(visible(surface),true)
  const state=await page.evaluate(()=>window.muxivra.playerState('subtitles'));assert.ok(Math.abs(state.positionMs-1500)<45);assert.equal(state.paused,true)
  assert.deepEqual(errors,[])
  const report={appVersion:await desktop.evaluate(({app})=>app.getVersion()),executable:process.env.MUXIVRA_EXECUTABLE||'development',subtitleFullscreenEscapesPreviewCard:true,fullNativeHitArea:true,backgroundScrollKeepsFullscreenVisible:true,exitRestoresCompactPreview:true,positionAndPausePreserved:true,errors}
  await writeFile('artifacts/qa/subtitle-fullscreen-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}finally{
  await desktop.close()
  const cleanup=relative(resolve('.test-data'),root)
  if(!cleanup||cleanup==='..'||cleanup.startsWith(`..${sep}`)||isAbsolute(cleanup))throw new Error('Refusing cleanup outside .test-data')
  await rm(root,{recursive:true,force:true})
}
