import { createProject } from './gui-projects.mjs'
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
  const page=await desktop.firstWindow();const until=async check=>{const end=Date.now()+30000;while(Date.now()<end){if(await check())return;await page.waitForTimeout(40)}throw new Error('Fullscreen state timed out')};page.on('pageerror',error=>errors.push(error.message))
  await page.getByRole('heading',{name:'单文件',exact:true}).waitFor({timeout:60000})
  await desktop.evaluate(({BrowserWindow,dialog},path)=>{const window=BrowserWindow.getAllWindows()[0];window.setBounds({width:1380,height:900});window.setAlwaysOnTop(true);window.show();window.focus();dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]})},video)
  await page.locator('.navigation').getByRole('button',{name:'字幕编辑',exact:true}).click()
  await createProject(page,desktop,video)
  await until(()=>page.evaluate(async()=>{const state=await window.muxivra.playerState('subtitles');return state.ready&&!state.loading&&state.videoWidth===640&&state.durationMs>=4900}))
  await page.waitForFunction(()=>document.querySelector('[data-player-owner="subtitles"] .mpv-viewport:not(.audio-viewport)'))
  await page.waitForTimeout(200)
  const user=koffi.load('user32.dll'),gdi=koffi.load('gdi32.dll'),find=user.func('uintptr_t __stdcall FindWindowExW(uintptr_t parent, uintptr_t after, str16 name, str16 title)'),visible=user.func('bool __stdcall IsWindowVisible(uintptr_t window)'),parentOf=user.func('uintptr_t __stdcall GetParent(uintptr_t window)')
  user.func('intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)')(-4)
  const pointType=koffi.struct('SubtitleFullscreenPoint',{x:'int',y:'int'}),toScreen=user.func('ClientToScreen','bool',['uintptr_t',koffi.inout(koffi.pointer(pointType))]),hitWindow=user.func('WindowFromPoint','uintptr_t',[pointType])
  const readRegion=user.func('int __stdcall GetWindowRgn(uintptr_t window, uintptr_t region)'),makeRegion=gdi.func('uintptr_t __stdcall CreateRectRgn(int left, int top, int right, int bottom)'),pointInRegion=gdi.func('bool __stdcall PtInRegion(uintptr_t region, int x, int y)'),disposeRegion=gdi.func('bool __stdcall DeleteObject(uintptr_t object)')
  const main=await desktop.evaluate(({BrowserWindow})=>Number(BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE())),surface=Number(find(main,0,'STATIC',null))
  assert.ok(surface);assert.equal(visible(surface),true)
  const normal=await page.locator('[data-player-owner="subtitles"] .mpv-viewport').boundingBox(),card=await page.locator('.subtitle-preview-card').boundingBox()
  assert.ok(Math.abs(normal.width/normal.height-16/9)<.01);assert.ok(normal.height>200);assert.ok(normal.y+normal.height<card.y+card.height-45)
  await page.evaluate(()=>window.muxivra.playerAction('subtitles',{type:'seek',positionMs:1500}))
  await until(()=>page.evaluate(async()=>Math.abs((await window.muxivra.playerState('subtitles')).positionMs-1500)<45))
  await page.getByRole('button',{name:'播放设置与列表',exact:true}).click()
  await page.getByRole('region',{name:'播放设置与列表',exact:true}).waitFor()
  const popup=await page.getByRole('region',{name:'播放设置与列表',exact:true}).boundingBox(),preview=await page.locator('[data-player-owner="subtitles"] .mpv-viewport').boundingBox(),pixelScale=await page.evaluate(()=>devicePixelRatio)
  const overlap={left:Math.max(popup.x,preview.x),right:Math.min(popup.x+popup.width,preview.x+preview.width),top:Math.max(popup.y,preview.y),bottom:Math.min(popup.y+popup.height,preview.y+preview.height)}
  assert.ok(overlap.right>overlap.left&&overlap.bottom>overlap.top,'Fixture must place the floating settings over the native video')
  const popupRegion=makeRegion(0,0,0,0);let occluded=false
  try{for(let i=0;i<100&&!occluded;i++){const kind=readRegion(surface,popupRegion);occluded=kind>0&&!pointInRegion(popupRegion,Math.round(((overlap.left+overlap.right)/2-preview.x)*pixelScale),Math.round(((overlap.top+overlap.bottom)/2-preview.y)*pixelScale));if(!occluded)await page.waitForTimeout(20)}}finally{disposeRegion(popupRegion)}
  assert.ok(occluded,'The native surface must exclude the floating settings panel');assert.equal(visible(surface),true)
  await page.keyboard.press('Escape');await page.waitForTimeout(150)
  await page.evaluate(()=>{const card=document.querySelector('.subtitle-preview-card'),pad=document.createElement('div');pad.id='subtitle-scroll-fixture';pad.style.height='600px';card.append(pad)})
  await page.evaluate(()=>{
    const card=document.querySelector('.subtitle-preview-card');let index=0;const values=[20,50,15,70,35,55,10,60,25,45]
    globalThis.__subtitleScrollFinished=false
    const next=()=>{card.scrollTop=values[index++];if(index<values.length)setTimeout(next,20);else globalThis.__subtitleScrollFinished=true};next()
  })
  const getDC=user.func('uintptr_t __stdcall GetDC(uintptr_t window)'),releaseDC=user.func('int __stdcall ReleaseDC(uintptr_t window, uintptr_t dc)'),getPixel=gdi.func('uint32_t __stdcall GetPixel(uintptr_t dc, int x, int y)'),colors=new Set(),dc=getDC(0)
  try{
    for(let sample=0;sample<10;sample++){
      await page.waitForTimeout(15);assert.equal(visible(surface),true,'Scrolling the subtitle preview hid the native video')
      const box=await page.locator('[data-player-owner="subtitles"] .mpv-viewport').boundingBox(),origin={x:0,y:0},scale=await page.evaluate(()=>devicePixelRatio);toScreen(surface,origin)
      for(const x of [.25,.5,.75])for(const y of [.3,.5,.7]){
        const point={x:Math.round(origin.x+box.width*scale*x),y:Math.round(origin.y+box.height*scale*y)}
        let hit=Number(hitWindow(point));for(let depth=0;hit&&hit!==surface&&depth<8;depth++)hit=Number(parentOf(hit))
        if(hit===surface){const color=getPixel(dc,point.x,point.y);if(color!==0xffffffff)colors.add(color)}
      }
    }
  }finally{releaseDC(0,dc)}
  assert.ok(colors.size>6,'Scrolling the subtitle preview replaced video with a black surface')
  await page.waitForFunction(()=>globalThis.__subtitleScrollFinished)
  await page.evaluate(()=>{document.getElementById('subtitle-scroll-fixture').remove();document.querySelector('.subtitle-preview-card').scrollTop=0});await page.waitForTimeout(180)
  await page.getByRole('button',{name:'全屏',exact:true}).click()
  await until(()=>page.evaluate(async()=>{const state=await window.muxivra.playerState('subtitles');return state.fullscreen&&!!document.querySelector('[data-player-owner="subtitles"].player-fullscreen')}))
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
  await until(()=>page.evaluate(async()=>!(await window.muxivra.playerState('subtitles')).fullscreen&&!document.querySelector('.player-fullscreen')))
  await page.waitForFunction(height=>Math.abs(document.querySelector('[data-player-owner="subtitles"] .mpv-viewport').getBoundingClientRect().height-height)<1,normal.height)
  await page.waitForTimeout(200);assert.equal(visible(surface),true)
  const state=await page.evaluate(()=>window.muxivra.playerState('subtitles'));assert.ok(Math.abs(state.positionMs-1500)<45);assert.equal(state.paused,true)
  assert.deepEqual(errors,[])
  const report={appVersion:await desktop.evaluate(({app})=>app.getVersion()),executable:process.env.MUXIVRA_EXECUTABLE||'development',settingsPanelNativeOcclusion:occluded,subtitleScrollKeepsVideoVisible:true,subtitleScrollVideoPixels:true,subtitleFullscreenEscapesPreviewCard:true,fullNativeHitArea:true,backgroundScrollKeepsFullscreenVisible:true,exitRestoresAdaptivePreview:true,positionAndPausePreserved:true,errors}
  await writeFile('artifacts/qa/subtitle-fullscreen-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}catch(error){
  const page=await desktop.firstWindow()
  console.log(JSON.stringify(await page.evaluate(()=>{const player=document.querySelector('[data-player-owner="subtitles"]'),viewport=player?.querySelector('.mpv-viewport'),css=player&&getComputedStyle(player),style=viewport&&getComputedStyle(viewport);return {window:{width:innerWidth,height:innerHeight,scrollY},player:player?.getBoundingClientRect().toJSON(),viewport:viewport?.getBoundingClientRect().toJSON(),playerCSS:css&&{position:css.position,height:css.height,width:css.width,display:css.display},videoCSS:style&&{height:style.height,width:style.width,flex:style.flex},className:player?.className}}),null,2));throw error
}finally{
  await desktop.close()
  const cleanup=relative(resolve('.test-data'),root)
  if(!cleanup||cleanup==='..'||cleanup.startsWith(`..${sep}`)||isAbsolute(cleanup))throw new Error('Refusing cleanup outside .test-data')
  await rm(root,{recursive:true,force:true})
}
