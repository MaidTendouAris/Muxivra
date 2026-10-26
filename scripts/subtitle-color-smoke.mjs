import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { mkdir,mkdtemp,readFile,readdir,writeFile,rm } from 'node:fs/promises'
import { join,resolve,relative,isAbsolute,sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createProject } from './gui-projects.mjs'

// Real project/editor state is compared throughout pointer motion. The picker
// must keep a local draft until Apply; no synthetic replacement input is used.
await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const root=await mkdtemp(resolve('.test-data','subtitle-color-')),profile=join(root,'profile'),video=join(root,'color.mp4'),subtitle=join(root,'color.ass')
await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=4','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=4','-c:v','libx264','-preset','ultrafast','-c:a','aac','-shortest',video],{windowsHide:true,timeout:60000})
await writeFile(subtitle,'[Script Info]\nScriptType: v4.00+\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:03.00,Default,,0,0,0,,Alpha middle Omega\nDialogue: 0,0:00:03.00,0:00:03.90,Default,,0,0,0,,Unchanged second line\n')
let desktop,page,success=false
const report={version:undefined,executable:process.env.MUXIVRA_EXECUTABLE||'development',checks:[],errors:[],layouts:[]}
const until=async(check,label='Color picker state',timeout=30000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await new Promise(done=>setTimeout(done,50))}throw new Error(label+' timed out')}
const session=()=>page.evaluate(()=>window.muxivra.getSession())
const modal=()=>page.getByRole('dialog')
const colorButton=()=>page.locator('.subtitle-format-tools').getByRole('button',{name:'文字颜色',exact:true})
const openTextColor=async()=>{await colorButton().click();await modal().getByRole('heading',{name:'文字颜色',exact:true}).waitFor();return modal()}
const closeColor=async()=>{await modal().getByRole('button',{name:'取消',exact:true}).click();await modal().waitFor({state:'hidden'})}
const applyColor=async()=>{await modal().getByRole('button',{name:'应用颜色',exact:true}).click();await modal().waitFor({state:'hidden'})}
const drag=async(locator,from,to,steps=48)=>{const box=await locator.boundingBox();assert.ok(box&&box.width>50&&box.height>5,'Custom color surface must be visible');await page.mouse.move(box.x+box.width*from[0],box.y+box.height*from[1]);await page.mouse.down();await page.mouse.move(box.x+box.width*to[0],box.y+box.height*to[1],{steps});await page.mouse.up()}
const setHex=async value=>{await modal().getByLabel('HEX',{exact:true}).fill(value);await modal().getByLabel('HEX',{exact:true}).press('Tab')}
const toAss=(hex,alpha)=>'&H'+alpha.toString(16).padStart(2,'0').toUpperCase()+hex.slice(5,7).toUpperCase()+hex.slice(3,5).toUpperCase()+hex.slice(1,3).toUpperCase()
try{
  desktop=await electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE||electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_TEST_SYSTEM_LANGUAGES:'zh-CN',MUXIVRA_DATA_PATH:profile,MUXIVRA_ENGINE_PATH:join(root,'engines')},timeout:60000})
  page=await desktop.firstWindow();page.on('pageerror',error=>report.errors.push(error.message));await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1000));report.version=await desktop.evaluate(({app})=>app.getVersion())
  await page.getByRole('heading',{name:'视频处理',exact:true}).waitFor({timeout:60000})
  await page.locator('.navigation').getByRole('button',{name:'项目管理',exact:true}).click();await page.getByRole('button',{name:'新建项目',exact:true}).click();assert.equal(await page.getByRole('heading',{name:'项目预处理',exact:true}).count(),0,'Remove explanatory preprocessing card from creation');await page.getByRole('button',{name:'取消',exact:true}).click()
  const project=await createProject(page,desktop,video,{subtitle});await page.getByLabel('字幕文本',{exact:true}).waitFor();await until(()=>session().then(value=>value?.cues.length===2),'Imported subtitles cached')
  const analysis=JSON.parse(await readFile(join(project.directory,'analysis','media.json'),'utf8'));assert.equal(analysis.format,'muxivra-media-analysis');assert.equal(analysis.audio.length,1);assert.ok((await readdir(join(project.directory,'analysis'))).includes('video-timing.json'));assert.equal(await page.locator('input[type="color"]').count(),0)
  report.checks.push('project creation omits explanatory card but still produces persistent audio/frame analysis; no native color input remains')
  const initial=await session(),disk=await readFile(project.subtitlePath,'utf8')
  await openTextColor()
  const initialized=await modal().locator('.color-sv').evaluate(c=>{const d=c.getContext('2d').getImageData(c.width-2,c.height-2,1,1).data;return Math.max(d[0],d[1],d[2])<10})
  assert.ok(initialized,'Color canvas must paint immediately on first portal mount, before hue changes')
  const localBefore=await modal().getByLabel('HEX',{exact:true}).inputValue()
  await page.evaluate(()=>{window.colorSmokeFrames=0;window.colorSmokeSampling=true;const tick=()=>{window.colorSmokeFrames++;if(window.colorSmokeSampling)requestAnimationFrame(tick)};requestAnimationFrame(tick)})
  await drag(modal().locator('.color-sv'),[.08,.1],[.88,.85],100);await drag(modal().locator('.color-hue'),[.04,.5],[.93,.5],80)
  const localAfter=await modal().getByLabel('HEX',{exact:true}).inputValue();assert.notEqual(localAfter.toLowerCase(),localBefore.toLowerCase(),'Dragging custom surfaces updates local color preview')
  await page.waitForTimeout(1100);assert.deepEqual(await session(),initial,'Dragging must not write any intermediate sample to the parent subtitle document');assert.equal(await readFile(project.subtitlePath,'utf8'),disk)
  report.dragFrames=await page.evaluate(()=>{window.colorSmokeSampling=false;return window.colorSmokeFrames});assert.ok(report.dragFrames>=10,'Color drag should keep the renderer producing animation frames')
  await closeColor();assert.deepEqual(await session(),initial);report.checks.push('180 custom color pointer steps update draft only, keep parent/disk unchanged, and cancel cleanly')
  await openTextColor();await setHex('#123456');await modal().getByLabel('红',{exact:true}).fill('999');await modal().getByLabel('红',{exact:true}).press('Tab');await modal().getByRole('alert').filter({hasText:'RGB 通道必须为 0–255 的整数'}).waitFor();await setHex('#123456');assert.equal(Number(await modal().getByLabel('红',{exact:true}).inputValue()),18);assert.equal(Number(await modal().getByLabel('绿',{exact:true}).inputValue()),52);assert.equal(Number(await modal().getByLabel('蓝',{exact:true}).inputValue()),86);assert.equal(await modal().getByRole('alert').count(),0);assert.deepEqual(await session(),initial,'Correcting an invalid RGB draft remains local');await closeColor();report.checks.push('re-entering the unchanged valid HEX restores invalid RGB draft channels without committing');
  const area=page.getByLabel('字幕文本',{exact:true});await area.focus();await area.evaluate(element=>{element.setSelectionRange(6,12);element.dispatchEvent(new Event('select',{bubbles:true}))})
  await openTextColor();await setHex('#123456');assert.equal(Number(await modal().getByLabel('红',{exact:true}).inputValue()),18);assert.equal(Number(await modal().getByLabel('绿',{exact:true}).inputValue()),52);assert.equal(Number(await modal().getByLabel('蓝',{exact:true}).inputValue()),86)
  assert.deepEqual(await session(),initial);await applyColor();const expected='Alpha {\\c&H563412&}middle{\\c} Omega';await until(()=>session().then(value=>value.cues[0].text===expected),'Single selected-text color apply');assert.equal((await session()).cues[1].text,initial.cues[1].text)
  assert.equal((await session()).cues[0].text.match(/\\c&H/g)?.length,1,'Applying color inserts one pair, not one tag per sampled color')
  const selected=await area.evaluate(element=>({start:element.selectionStart,end:element.selectionEnd,text:element.value.slice(element.selectionStart,element.selectionEnd)}));assert.ok(selected.text.includes('middle'),'Formatting retains the chosen text range')
  await page.locator('.subtitle-event-table tbody tr').first().focus();await page.keyboard.press('Control+z');await until(()=>session().then(value=>value.cues[0].text===initial.cues[0].text),'One undo restores color transaction');report.checks.push('captured substring receives one BGR ASS color transaction; RGB/HEX agree; one undo restores original')
  // Chromium EyeDropper is checked through the actual UI and cancelled by Escape.
  // Deterministic chosen-pixel validation is performed by screen-color-smoke.
  await openTextColor();const beforeScreen=await session();await modal().getByRole('button',{name:'屏幕取色',exact:true}).click();await page.locator('.color-picker[data-screen-picking="true"]').waitFor({state:'attached',timeout:10000});await page.waitForTimeout(800);await page.keyboard.press('Escape');await until(()=>page.locator('.color-picker').getAttribute('data-screen-picking').then(value=>value!=='true'),'Escape cancels screen picking');assert.equal(await modal().count(),1,'Escaping screen pick keeps the color dialog open');assert.deepEqual(await session(),beforeScreen);await closeColor();report.checks.push('real screen picker can be cancelled with Escape without closing dialog or modifying subtitle')
  for(const theme of ['dark','light']){
    await page.evaluate(async theme=>{const state=await window.muxivra.snapshot();await window.muxivra.saveSettings({...state.settings,theme})},theme);await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme)
    await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1040,720));await openTextColor();await setHex('#2874B9');await page.waitForTimeout(100)
    const geometry=await modal().evaluate(element=>{const box=element.getBoundingClientRect();return {top:box.top,bottom:box.bottom,left:box.left,right:box.right,width:innerWidth,height:innerHeight}});assert.ok(geometry.top>=0&&geometry.bottom<=geometry.height&&geometry.left>=0&&geometry.right<=geometry.width,'Custom picker fits small window');report.layouts.push({theme,...geometry});await page.screenshot({path:`artifacts/qa/subtitle-color-${theme}.png`,fullPage:true});await closeColor()
  }
  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1000));await page.getByRole('button',{name:'样式与脚本设置',exact:true}).click();await page.getByRole('heading',{name:'样式属性',exact:true}).waitFor();assert.equal(await page.locator('input[type="color"]').count(),0)
  for(const [label,key,hex] of [['文字颜色','primaryColour','#2478AB'],['次要颜色','secondaryColour','#D4B051'],['描边颜色','outlineColour','#167C34'],['阴影颜色','backColour','#314159']]){
    const before=await session(),style=before.styles.find(style=>style.name==='Default'),alpha=key==='backColour'?77:parseInt(style[key].replace(/^&H/i,'').slice(0,2),16)
    await page.getByRole('button',{name:label,exact:true}).click();await modal().getByRole('heading',{name:label,exact:true}).waitFor();await drag(modal().locator('.color-sv'),[.2,.2],[.8,.7],24);await page.waitForTimeout(850);assert.deepEqual(await session(),before,'Style swatch drag must remain local');await closeColor();assert.deepEqual(await session(),before)
    await page.getByRole('button',{name:label,exact:true}).click();await setHex(hex);if(key==='backColour'){await modal().getByLabel('透明度数值',{exact:true}).fill(String(alpha));await modal().getByLabel('透明度数值',{exact:true}).press('Tab')}
    assert.deepEqual(await session(),before);await applyColor();await until(()=>session().then(value=>value.styles.find(style=>style.name==='Default')[key]===toAss(hex,alpha)),label+' applied')
    const after=await session();assert.deepEqual(after.cues,before.cues,'Style colors must not rewrite cue text');for(const other of ['primaryColour','secondaryColour','outlineColour','backColour'].filter(other=>other!==key))assert.equal(after.styles.find(style=>style.name==='Default')[other],style[other]);report.checks.push(label+': local preview/cancel, atomic apply, alpha and other fields preserved')
  }
  await page.getByRole('button',{name:'返回字幕编辑',exact:true}).click();await page.locator('.subtitle-event-table tbody tr').first().focus();await page.keyboard.press('Control+z');await until(()=>session().then(value=>value.styles.find(style=>style.name==='Default').backColour===initial.styles.find(style=>style.name==='Default').backColour),'One style undo');report.checks.push('style colors and opacity are one undoable document transaction')
  assert.deepEqual(report.errors,[]);assert.equal(await page.locator('.toast-error').count(),0);success=true;await writeFile('artifacts/qa/subtitle-color-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}catch(error){report.failure=error.stack;report.screen=await page?.locator('body').innerText().catch(()=>undefined);await page?.screenshot({path:'artifacts/qa/subtitle-color-failed.png',fullPage:true}).catch(()=>{});await writeFile('artifacts/qa/subtitle-color-failed.json',JSON.stringify(report,null,2));throw error}
finally{await desktop?.close().catch(()=>{});if(success){const inside=relative(resolve('.test-data'),root);if(!inside||inside==='..'||inside.startsWith(`..${sep}`)||isAbsolute(inside))throw new Error('Unsafe cleanup path');await rm(root,{recursive:true,force:true})}}
