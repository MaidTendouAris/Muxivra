import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { resolve, join, relative, isAbsolute, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
import koffi from 'koffi'
const exec=promisify(execFile)
await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const root=await mkdtemp(resolve('.test-data','player-')),output=join(root,'output');await mkdir(output)
const video=join(root,'video.mkv'),audio=join(root,'audio.flac'),portrait=join(root,'portrait.mp4'),rotated=join(root,'rotated.mp4'),srt=join(root,'external.srt'),shot=join(output,'frame.png')
await writeFile(srt,'1\n00:00:00,000 --> 00:00:08,000\nmpv subtitle test\n')
await exec('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=480x270:rate=24','-f','lavfi','-i','sine=frequency=440','-f','lavfi','-i','sine=frequency=880','-i',srt,'-map','0:v','-map','1:a','-map','2:a','-map','3:s','-t','8','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-c:s','srt',video],{windowsHide:true})
await exec('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=220','-t','8','-c:a','flac',audio],{windowsHide:true})
await exec('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=270x480:rate=24','-t','2','-c:v','libx264','-pix_fmt','yuv420p',portrait],{windowsHide:true})
await exec('ffmpeg',['-v','error','-display_rotation','90','-i',video,'-map','0:v','-c:v','copy',rotated],{windowsHide:true})
const rotationInfo=JSON.parse((await exec('ffprobe',['-v','error','-show_streams','-of','json',rotated],{windowsHide:true})).stdout);assert.ok(rotationInfo.streams[0].side_data_list.some(data=>Math.abs(data.rotation)===90))
const desktop=await electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE||electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,PATH:process.env.SystemRoot+'\\System32',MUXIVRA_SMOKE:'1',MUXIVRA_DATA_PATH:join(root,'profile'),MUXIVRA_ENGINE_PATH:join(root,'engines')},timeout:60000})
const errors=[]
try {
  const page=await desktop.firstWindow();page.on('pageerror',error=>errors.push(error.message))
  await page.getByRole('heading',{name:'单文件',exact:true}).waitFor({timeout:60000})
  await desktop.evaluate(({dialog},values)=>{
    dialog.showOpenDialog=async(_parent,options)=>({canceled:false,filePaths:options.title==='载入音轨'?[values.audio]:options.title==='载入字幕'?[values.srt]:[values.video]})
    dialog.showSaveDialog=async()=>({canceled:false,filePath:values.shot})
  },{video,audio,srt,shot})
  await page.getByRole('button',{name:'选择媒体文件',exact:true}).click()
  const choose=async(name,value)=>{await page.getByRole('combobox',{name,exact:true}).click();await page.locator(`[role="option"][data-value="${value}"]`).click()}
  const state=()=>page.evaluate(()=>window.muxivra.playerState('single'))
  const wait=async predicate=>{const end=Date.now()+15000;let current;while(Date.now()<end){current=await state();if(current.error)throw new Error(current.error);if(predicate(current))return current;await page.waitForTimeout(100)}throw new Error(`Player timeout: ${JSON.stringify(current)}`)}
  await wait(s=>s.ready&&!s.loading&&s.durationMs>7000&&s.videoWidth===480)
  assert.equal((await state()).volume,50)
  const volume=page.getByLabel('音量',{exact:true});assert.ok((await volume.boundingBox()).width>=175)
  await volume.press('ArrowRight');await wait(s=>s.volume===55);await volume.press('ArrowLeft');await wait(s=>s.volume===50)
  await volume.dispatchEvent('pointerdown');for(const value of ['44','65','84'])await volume.fill(value)
  const stale={...(await state()),volume:10};await desktop.evaluate(({BrowserWindow},value)=>BrowserWindow.getAllWindows()[0].webContents.send('muxivra:player-state',value),stale);await page.waitForTimeout(100);assert.equal(await volume.inputValue(),'84')
  await volume.dispatchEvent('pointerup');await wait(s=>s.volume===84)
  await page.getByLabel('音量百分比',{exact:true}).fill('50');await wait(s=>s.volume===50)
  await page.getByLabel('音量百分比',{exact:true}).press('ArrowUp');await wait(s=>s.volume===55);await page.getByLabel('音量百分比',{exact:true}).press('ArrowDown');await wait(s=>s.volume===50)
  await page.waitForFunction(()=>{const box=document.querySelector('[data-player-owner="single"] .mpv-viewport').getBoundingClientRect();return Math.abs(box.width/box.height-16/9)<.01})
  assert.equal((await page.evaluate(()=>window.muxivra.snapshot())).engine,undefined)
  const user=koffi.load('user32.dll'),find=user.func('uintptr_t __stdcall FindWindowExW(uintptr_t parent, uintptr_t after, str16 name, str16 title)'),parentOf=user.func('uintptr_t __stdcall GetParent(uintptr_t window)'),isVisible=user.func('bool __stdcall IsWindowVisible(uintptr_t window)'),post=user.func('bool __stdcall PostMessageW(uintptr_t window, uint32_t message, uintptr_t wParam, intptr_t lParam)')
  user.func('intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)')(-4)
  const main=await desktop.evaluate(({BrowserWindow})=>Number(BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE()))
  const native=Number(find(main,0,'STATIC',null));assert.ok(native);assert.equal(Number(parentOf(native)),main)
  await page.waitForTimeout(200);assert.equal(isVisible(native),true)
  const mpvChild=Number(find(native,0,null,null));assert.ok(mpvChild)
  console.log('Native mpv child window:',mpvChild)
  assert.equal(isVisible(mpvChild),true)
  await page.getByRole('combobox',{name:'视频编码',exact:true}).click();await page.getByRole('listbox').waitFor();await page.waitForTimeout(100);assert.equal(isVisible(native),true);await page.keyboard.press('Escape')
  post(mpvChild,0x100,0x20,0);post(mpvChild,0x101,0x20,0);await wait(s=>!s.paused&&s.positionMs>200)
  post(mpvChild,0x100,0x20,0);post(mpvChild,0x101,0x20,0);await wait(s=>s.paused)
  const rectType=koffi.struct('MuxivraSmokeRect',{left:'int',top:'int',right:'int',bottom:'int'}),getRect=user.func('GetClientRect','bool',['uintptr_t',koffi.out(koffi.pointer(rectType))]),getDC=user.func('uintptr_t __stdcall GetDC(uintptr_t window)'),releaseDC=user.func('int __stdcall ReleaseDC(uintptr_t window, uintptr_t dc)'),gdi=koffi.load('gdi32.dll'),getPixel=gdi.func('uint32_t __stdcall GetPixel(uintptr_t dc, int x, int y)')
  await desktop.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setAlwaysOnTop(true);w.show()});await page.waitForTimeout(500)
  await page.getByRole('combobox',{name:'播放速度',exact:true}).click();await page.getByRole('listbox').waitFor();await page.waitForTimeout(150)
  const pointType=koffi.struct('MuxivraSmokePoint',{x:'int',y:'int'}),toScreen=user.func('ClientToScreen','bool',['uintptr_t',koffi.inout(koffi.pointer(pointType))]),hitWindow=user.func('WindowFromPoint','uintptr_t',[pointType]),ancestor=user.func('uintptr_t __stdcall GetAncestor(uintptr_t window, uint32_t flags)')
  const nativeRect={},origin={x:0,y:0};getRect(mpvChild,nativeRect);toScreen(mpvChild,origin);const dc=getDC(0),colors=new Set()
  try{
    const menu=await page.getByRole('listbox').boundingBox(),scale=await page.evaluate(()=>devicePixelRatio),clientPoint={x:0,y:0};toScreen(main,clientPoint)
    const box={left:Math.round(clientPoint.x+menu.x*scale),top:Math.round(clientPoint.y+menu.y*scale),right:Math.round(clientPoint.x+(menu.x+menu.width)*scale),bottom:Math.round(clientPoint.y+(menu.y+menu.height)*scale)}
    const ring=[]
    for(let y=box.top+5;y<box.bottom-5;y+=9)for(const x of [box.left-1,box.right])if(x>origin.x+1&&x<origin.x+nativeRect.right-1&&y>origin.y+1&&y<origin.y+nativeRect.bottom-1)ring.push({x,y})
    for(let x=box.left+5;x<box.right-5;x+=9)for(const y of [box.top-1,box.bottom])if(x>origin.x+1&&x<origin.x+nativeRect.right-1&&y>origin.y+1&&y<origin.y+nativeRect.bottom-1)ring.push({x,y})
    assert.ok(ring.length>10,'Speed menu must overlap native video')
    for(const theme of ['dark','light']) {
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.waitForTimeout(150)
      const withMenu=ring.map(p=>getPixel(dc,p.x,p.y))
      await page.keyboard.press('Escape');await page.waitForTimeout(200);const baseline=ring.map(p=>getPixel(dc,p.x,p.y))
      // D3D output dithering can vary a channel by 1 between paused redraws.
      for(let index=0;index<ring.length;index++)for(const shift of [0,8,16])assert.ok(Math.abs(((withMenu[index]>>shift)&255)-((baseline[index]>>shift)&255))<=3,'Menu clipping exposed a dark perimeter outside the popup: '+theme)
      await page.getByRole('combobox',{name:'播放速度',exact:true}).click();await page.getByRole('listbox').waitFor();await page.waitForTimeout(150)
    }
    for(let x=2;x<8;x++)for(let y=2;y<8;y++){const sample={x:origin.x+Math.round(nativeRect.right*x/10),y:origin.y+Math.round(nativeRect.bottom*y/10)};assert.equal(Number(ancestor(hitWindow(sample),2)),main,'Sampled area must belong to the test application');colors.add(getPixel(dc,sample.x,sample.y))}
    const client={},clientOrigin={x:0,y:0};getRect(main,client);toScreen(main,clientOrigin)
    const width=client.right,height=client.bottom
    for(const x of [2,width/2,width-2])for(const y of [2,height/2,height-2])assert.equal(Number(ancestor(hitWindow({x:Math.round(clientOrigin.x+x),y:Math.round(clientOrigin.y+y)}),2)),main)
    const createDC=gdi.func('uintptr_t __stdcall CreateCompatibleDC(uintptr_t dc)'),createBitmap=gdi.func('uintptr_t __stdcall CreateCompatibleBitmap(uintptr_t dc, int width, int height)'),select=gdi.func('uintptr_t __stdcall SelectObject(uintptr_t dc, uintptr_t object)'),blit=gdi.func('bool __stdcall BitBlt(uintptr_t dest, int x, int y, int width, int height, uintptr_t source, int sourceX, int sourceY, uint32_t flags)'),bits=gdi.func('int __stdcall GetDIBits(uintptr_t dc, uintptr_t bitmap, uint32_t start, uint32_t lines, void *pixels, void *info, uint32_t usage)'),deleteObject=gdi.func('bool __stdcall DeleteObject(uintptr_t object)'),deleteDC=gdi.func('bool __stdcall DeleteDC(uintptr_t dc)')
    const memory=createDC(dc),bitmap=createBitmap(dc,width,height),old=select(memory,bitmap),pixels=Buffer.alloc(width*height*4),info=Buffer.alloc(40)
    info.writeUInt32LE(40,0);info.writeInt32LE(width,4);info.writeInt32LE(-height,8);info.writeUInt16LE(1,12);info.writeUInt16LE(32,14)
    try{assert.ok(blit(memory,0,0,width,height,dc,clientOrigin.x,clientOrigin.y,0x00cc0020));select(memory,old);assert.equal(bits(memory,bitmap,0,height,pixels,info,0),height);for(let i=3;i<pixels.length;i+=4)pixels[i]=255
      const png=await desktop.evaluate(({nativeImage},value)=>nativeImage.createFromBitmap(Buffer.from(value.bytes,'base64'),value.size).toPNG().toString('base64'),{bytes:pixels.toString('base64'),size:{width,height}});await writeFile('artifacts/qa/player-native.png',Buffer.from(png,'base64'))
    }finally{select(memory,old);deleteObject(bitmap);deleteDC(memory)}
  }finally{releaseDC(0,dc);await page.keyboard.press('Escape');await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setAlwaysOnTop(false))}
  console.log('Native video pixels verified');assert.ok(colors.size>6,'Native surface did not render video pixels')
  console.log('Video decoded by mpv')
  assert.equal(await page.locator('video,audio').count(),0)
  await page.getByRole('button',{name:'播放',exact:true}).click();await wait(s=>!s.paused&&s.positionMs>300)
  await page.getByRole('button',{name:'暂停',exact:true}).click();await wait(s=>s.paused)
  await page.getByLabel('播放进度',{exact:true}).fill('1000');await page.getByLabel('播放进度',{exact:true}).dispatchEvent('pointerup');await wait(s=>Math.abs(s.positionMs-1000)<45)
  await choose('播放速度','2');await wait(s=>s.speed===2)
  await page.getByRole('button',{name:'静音',exact:true}).click();await wait(s=>s.muted)
  await page.getByLabel('音量',{exact:true}).fill('37');await page.getByLabel('音量',{exact:true}).dispatchEvent('change');await wait(s=>Math.round(s.volume)===37)
  await page.locator('.player-options > summary').click()
  await page.getByLabel('跳转时间',{exact:true}).fill('00:00:02,000');await page.getByRole('button',{name:'跳转',exact:true}).click();await wait(s=>Math.abs(s.positionMs-2000)<45)
  const before=(await state()).positionMs;await page.getByRole('button',{name:'下一帧',exact:true}).click();await wait(s=>s.positionMs>before+20)
  await page.getByRole('button',{name:'上一帧',exact:true}).click();await wait(s=>s.positionMs<=before+10)
  await page.getByRole('button',{name:'设置 A',exact:true}).click();await wait(s=>s.loopA!==undefined)
  await page.getByLabel('跳转时间',{exact:true}).fill('00:00:03,000');await page.getByRole('button',{name:'跳转',exact:true}).click();await wait(s=>s.positionMs>=2990)
  await page.getByRole('button',{name:'设置 B',exact:true}).click();await wait(s=>s.loopB>=2990)
  await page.getByRole('button',{name:'播放',exact:true}).click();await wait(s=>!s.paused)
  const positions=[];for(let i=0;i<12;i++){positions.push((await state()).positionMs);await page.waitForTimeout(100)}
  assert.ok(positions.some((value,index)=>index>0&&value<positions[index-1]-100),'A–B playback did not loop');assert.ok(Math.max(...positions)<3150)
  await page.getByRole('button',{name:'暂停',exact:true}).click();await wait(s=>s.paused)
  await page.getByRole('button',{name:'清除 A–B',exact:true}).click();await wait(s=>s.loopA===undefined&&s.loopB===undefined)
  await choose('循环模式','file');await wait(s=>s.loop==='file');await choose('循环模式','none');await wait(s=>s.loop==='none')
  const audioTracks=(await state()).tracks.filter(t=>t.type==='audio');assert.equal(audioTracks.length,2)
  await choose('播放音轨',String(audioTracks[1].id));await wait(s=>s.audioTrack===audioTracks[1].id)
  await page.getByLabel('音轨延迟（秒）',{exact:true}).fill('0.3');await wait(s=>s.audioDelay===0.3)
  await page.getByLabel('字幕延迟（秒）',{exact:true}).fill('-0.2');await wait(s=>s.subtitleDelay===-0.2)
  await choose('播放字幕','no');await wait(s=>s.subtitleTrack==='no')
  await page.waitForFunction(()=>document.querySelector('[aria-label="播放字幕"]')?.textContent?.includes('关闭'))
  // Delay UI notifications to reproduce choosing the same displayed option
  // immediately after mpv automatically selects a newly loaded external track.
  await desktop.evaluate(({BrowserWindow})=>{const contents=BrowserWindow.getAllWindows()[0].webContents,original=contents.send.bind(contents);let pending;globalThis.__resumePlayerUpdates=()=>{contents.send=original;if(pending)original('muxivra:player-state',...pending)};contents.send=(channel,...args)=>{if(channel==='muxivra:player-state')pending=args;else original(channel,...args)}})
  try {
    await page.getByRole('button',{name:'载入字幕',exact:true}).click();await wait(s=>s.tracks.some(t=>t.type==='sub'&&t.external)&&s.subtitleTrack!=='no')
    await choose('播放字幕','no');await wait(s=>s.subtitleTrack==='no')
    const track=(await state()).tracks.find(t=>t.type==='sub'&&t.external)
    await page.evaluate(id=>window.muxivra.playerAction('single',{type:'subtitle-track',value:id}),track.id);await wait(s=>s.subtitleTrack===track.id)
    await page.getByRole('combobox',{name:'播放字幕',exact:true}).click();await page.locator('[role="option"][data-value="no"]').focus();await page.keyboard.press('Enter');await wait(s=>s.subtitleTrack==='no')
  } finally {await desktop.evaluate(()=>{globalThis.__resumePlayerUpdates();delete globalThis.__resumePlayerUpdates})}
  await page.waitForFunction(()=>document.querySelector('[aria-label="播放字幕"]')?.textContent?.includes('关闭'))
  const externalSubtitle=(await state()).tracks.find(t=>t.type==='sub'&&t.external)
  await page.getByRole('combobox',{name:'播放字幕',exact:true}).click();await page.getByRole('option').filter({hasText:'external.srt'}).waitFor();await page.keyboard.press('Escape')
  await choose('播放字幕',String(externalSubtitle.id));await wait(s=>s.subtitleTrack===externalSubtitle.id)
  await page.getByRole('button',{name:'载入音轨',exact:true}).click();await wait(s=>s.tracks.some(t=>t.type==='audio'&&t.external))
  await page.getByRole('button',{name:'截图',exact:true}).click();await page.waitForTimeout(500)
  const png=await readFile(shot);assert.equal(png.readUInt32BE(16),480);assert.equal(png.readUInt32BE(20),270)
  await assert.rejects(page.evaluate(()=>window.muxivra.playerScreenshot('single')),/EEXIST|exists/);assert.deepEqual(await readFile(shot),png)
  await page.getByRole('button',{name:'全屏',exact:true}).click();await wait(s=>s.fullscreen)
  assert.equal(await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFullScreen()),true)
  await page.getByRole('button',{name:'退出全屏',exact:true}).click();await wait(s=>!s.fullscreen);await page.waitForFunction(()=>!document.querySelector('.player-fullscreen'))
  await page.screenshot({path:'artifacts/qa/player-controls.png',fullPage:true})
  await desktop.evaluate(({dialog},audio)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[audio]})},audio)
  await page.getByRole('button',{name:'添加到列表',exact:true}).click();await wait(s=>s.playlist.length===2)
  await page.getByRole('button',{name:'下一项',exact:true}).click();await wait(s=>s.playlistIndex===1&&!s.loading&&s.tracks.some(t=>t.type==='audio')&&!s.tracks.some(t=>t.type==='video'))
  await page.getByRole('button',{name:'播放',exact:true}).click();await wait(s=>!s.paused&&s.positionMs>250)
  assert.ok(await page.locator('.audio-viewport').evaluate(e=>e.getBoundingClientRect().height)<100)
  assert.equal(isVisible(native),false)
  await page.getByRole('button',{name:'暂停',exact:true}).click();await wait(s=>s.paused)
  await page.screenshot({path:'artifacts/qa/player-audio.png',fullPage:true})
  await page.getByRole('button',{name:'移除播放项 1',exact:true}).click();await wait(s=>s.playlist.length===1)
  await desktop.evaluate(({dialog},video)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[video]})},video)
  await page.getByRole('button',{name:'更换文件',exact:true}).click();await wait(s=>s.path===video&&s.videoWidth===480&&!s.loading&&s.playlist.length===1)
  await page.getByRole('button',{name:'停止',exact:true}).click();await wait(s=>s.paused&&s.positionMs===0)
  for(const path of [portrait,rotated]){
    await desktop.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]})},path)
    await page.getByRole('button',{name:'更换文件',exact:true}).click();await wait(s=>s.path===path&&!s.loading&&Math.abs(s.videoAspect-9/16)<.01)
    await page.waitForFunction(()=>{const box=document.querySelector('[data-player-owner="single"] .mpv-viewport').getBoundingClientRect();return Math.abs(box.width/box.height-9/16)<.01&&box.height<=Math.min(540,innerHeight*.6)+1})
    await page.screenshot({path:`artifacts/qa/player-${path===portrait?'portrait':'rotated'}.png`,fullPage:true})
  }
  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:1040,height:720}));await page.waitForTimeout(300)
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  assert.deepEqual(errors,[])
  const report={appVersion:await desktop.evaluate(({app})=>app.getVersion()),executable:process.env.MUXIVRA_EXECUTABLE||'development',version:(await state()).version,features:['video','audio','pause','seek','speed','volume','mute','frames','ab-loop','repeat','audio-tracks','external-audio','external-subtitles','delays','screenshot','fullscreen','playlist'],noProcessingEnginePlayback:true,nativeChildWindow:true,nativeKeyboard:true,nativeVideoPixels:true,menuPerimeterPixelsMatchVideo:true,delayedStateReselectMouseAndKeyboard:true,defaultVolume:50,volumeKeyboardStep:5,volumeDragIgnoresStaleState:true,portraitAndRotationAspect:true,viewportMaxHeight:540,parameterMenuKeepsVideoVisible:true,chromiumMediaElements:0,errors}
  await writeFile('artifacts/qa/player-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
} finally {
  await desktop.close();const rel=relative(resolve('.test-data'),root);if(rel&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel))await rm(root,{recursive:true,force:true})
}
