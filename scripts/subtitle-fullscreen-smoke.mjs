import { createProject } from './gui-projects.mjs'
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'

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
  await page.getByRole('heading',{name:'视频处理',exact:true}).waitFor({timeout:60000})
  await desktop.evaluate(({BrowserWindow,dialog},path)=>{const window=BrowserWindow.getAllWindows()[0];window.setBounds({width:1380,height:900});window.setAlwaysOnTop(true);window.show();window.focus();dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]})},video)
  await page.locator('.navigation').getByRole('button',{name:'字幕编辑',exact:true}).click()
  await createProject(page,desktop,video)
  await until(()=>page.evaluate(async()=>{const state=await window.muxivra.playerState('subtitles');return state.ready&&!state.loading&&state.videoWidth===640&&state.durationMs>=4900}))
  await page.waitForFunction(()=>document.querySelector('[data-player-owner="subtitles"] .mpv-viewport:not(.audio-viewport)'))
  await page.waitForTimeout(200)
  const canvas=page.locator('canvas[data-mpv-surface="subtitles"]')
  await page.waitForFunction(()=>Number(document.querySelector('canvas[data-mpv-surface="subtitles"]')?.dataset.presentedFrames)>0)
  const normal=await page.locator('[data-player-owner="subtitles"] .mpv-viewport').boundingBox(),card=await page.locator('.subtitle-preview-card').boundingBox()
  assert.ok(Math.abs(normal.width/normal.height-16/9)<.01);assert.ok(normal.height>200);assert.ok(normal.y+normal.height<card.y+card.height-45)
  await page.evaluate(()=>window.muxivra.playerAction('subtitles',{type:'seek',positionMs:1500}))
  await until(()=>page.evaluate(async()=>Math.abs((await window.muxivra.playerState('subtitles')).positionMs-1500)<45))
  await page.getByRole('button',{name:'播放设置与列表',exact:true}).click()
  await page.getByRole('region',{name:'播放设置与列表',exact:true}).waitFor()
  const popup=await page.getByRole('region',{name:'播放设置与列表',exact:true}).boundingBox(),preview=await page.locator('[data-player-owner="subtitles"] .mpv-viewport').boundingBox(),pixelScale=await page.evaluate(()=>devicePixelRatio)
  const overlap={left:Math.max(popup.x,preview.x),right:Math.min(popup.x+popup.width,preview.x+preview.width),top:Math.max(popup.y,preview.y),bottom:Math.min(popup.y+popup.height,preview.y+preview.height)}
  assert.ok(overlap.right>overlap.left&&overlap.bottom>overlap.top,'Fixture must place the floating settings over the native video')
  const occluded=await page.evaluate(({x,y})=>!!document.elementFromPoint(x,y)?.closest('.player-settings-popover'),{x:(overlap.left+overlap.right)/2,y:(overlap.top+overlap.bottom)/2})
  assert.ok(occluded,'Floating controls must appear above the composited video')
  await page.keyboard.press('Escape');await page.waitForTimeout(150)
  await page.evaluate(()=>{const card=document.querySelector('.subtitle-preview-card'),pad=document.createElement('div');pad.id='subtitle-scroll-fixture';pad.style.height='600px';card.append(pad)})
  await page.evaluate(()=>{
    const card=document.querySelector('.subtitle-preview-card');let index=0;const values=[20,50,15,70,35,55,10,60,25,45]
    globalThis.__subtitleScrollFinished=false
    const next=()=>{card.scrollTop=values[index++];if(index<values.length)setTimeout(next,20);else globalThis.__subtitleScrollFinished=true};next()
  })
  for(let sample=0;sample<10;sample++){
    await page.waitForTimeout(15)
    const colored=await canvas.evaluate(c=>{const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;for(let i=0;i<d.length;i+=160)if(d[i]>40||d[i+1]>40||d[i+2]>40)return true;return false})
    assert.ok(colored,'Scrolling must preserve decoded video pixels')
  }
  await page.waitForFunction(()=>globalThis.__subtitleScrollFinished)
  await page.evaluate(()=>{document.getElementById('subtitle-scroll-fixture').remove();document.querySelector('.subtitle-preview-card').scrollTop=0});await page.waitForTimeout(180)
  await page.getByRole('button',{name:'全屏',exact:true}).click()
  await until(()=>page.evaluate(async()=>{const state=await window.muxivra.playerState('subtitles');return state.fullscreen&&!!document.querySelector('[data-player-owner="subtitles"].player-fullscreen')}))
  await page.waitForFunction(()=>{const box=document.querySelector('[data-player-owner="subtitles"] .mpv-viewport').getBoundingClientRect();return box.width>=innerWidth-1&&box.height>innerHeight*.65})
  const full=await canvas.boundingBox()
  assert.ok(full.width>=await page.evaluate(()=>innerWidth)-1)
  assert.ok(await canvas.evaluate(c=>{const r=c.getBoundingClientRect();return document.elementFromPoint(r.x+r.width*.1,r.y+r.height*.15)===c}))
  await page.screenshot({path:'artifacts/qa/subtitle-fullscreen-composited.png'})
  await page.evaluate(()=>{const card=document.querySelector('.subtitle-preview-card'),pad=document.createElement('div');pad.id='fullscreen-scroll-fixture';pad.style.height='600px';card.append(pad);card.scrollTop=60})
  await page.waitForTimeout(40);assert.equal(await canvas.isVisible(),true,'Scrolling the background preview card hid a fixed fullscreen video')
  await page.evaluate(()=>{document.getElementById('fullscreen-scroll-fixture').remove();document.querySelector('.subtitle-preview-card').scrollTop=0})
  await page.getByRole('button',{name:'退出全屏',exact:true}).click()
  await until(()=>page.evaluate(async()=>!(await window.muxivra.playerState('subtitles')).fullscreen&&!document.querySelector('.player-fullscreen')))
  await page.waitForFunction(height=>Math.abs(document.querySelector('[data-player-owner="subtitles"] .mpv-viewport').getBoundingClientRect().height-height)<1,normal.height)
  await page.waitForTimeout(200);assert.equal(await canvas.isVisible(),true)
  const state=await page.evaluate(()=>window.muxivra.playerState('subtitles'));assert.ok(Math.abs(state.positionMs-1500)<45);assert.equal(state.paused,true)
  assert.deepEqual(errors,[])
  const report={appVersion:await desktop.evaluate(({app})=>app.getVersion()),executable:process.env.MUXIVRA_EXECUTABLE||'development',settingsPanelDomOcclusion:occluded,subtitleScrollKeepsVideoVisible:true,subtitleScrollVideoPixels:true,subtitleFullscreenEscapesPreviewCard:true,fullCanvasHitArea:true,backgroundScrollKeepsFullscreenVisible:true,exitRestoresAdaptivePreview:true,positionAndPausePreserved:true,errors}
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
