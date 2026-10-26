import { installHeadlessTextureFixture } from './headless-texture-fixture.mjs'
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { mkdir,mkdtemp,readFile,writeFile,rm } from 'node:fs/promises'
import { join,resolve,relative,isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createProject } from './gui-projects.mjs'

await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const root=await mkdtemp(resolve('.test-data','waveform-shortcuts-')),profile=join(root,'profile'),video=join(root,'shortcuts.mp4')
await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=10:d=35','-f','lavfi','-i','sine=frequency=900:sample_rate=48000:duration=35','-map','0:v','-map','1:a','-c:v','libx264','-preset','ultrafast','-c:a','aac',video],{windowsHide:true})
let desktop,page,success=false
const report={checks:[],errors:[]}
const until=async(check,label='Waveform shortcut state')=>{const end=Date.now()+30000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50))}throw new Error(label+' timed out')}
const launch=async()=>{desktop=await electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE||electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_TEST_SYSTEM_LANGUAGES:'zh-CN',MUXIVRA_DATA_PATH:profile,MUXIVRA_ENGINE_PATH:join(root,'engines')},timeout:60000});await installHeadlessTextureFixture(desktop);page=await desktop.firstWindow();page.on('pageerror',error=>report.errors.push(error.message));await page.getByRole('heading',{name:'视频处理',exact:true}).waitFor({timeout:60000});await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1000))}
const settings=()=>page.evaluate(()=>window.muxivra.snapshot()).then(snapshot=>snapshot.settings)
const player=()=>page.evaluate(()=>window.muxivra.playerState('subtitles'))
// Exercise the actual native mpv input -> main process -> renderer bridge.
// The composited video never takes native keyboard focus.
const nativeKey=async()=>{await page.locator('.mpv-viewport').click({position:{x:8,y:8}});await page.keyboard.press('Control+Alt+Equal')}

try{
  await launch();await createProject(page,desktop,video);await desktop.close();desktop=undefined
  // The old configuration really has no waveform fields, and owns the new reset default.
  const file=join(profile,'config.json'),legacy=JSON.parse(await readFile(file,'utf8'));for(const key of Object.keys(legacy.settings.shortcuts))if(key.startsWith('waveform.'))delete legacy.settings.shortcuts[key];legacy.settings.shortcuts['player.screenshot']='Alt+KeyR';await writeFile(file,JSON.stringify(legacy))
  await launch();const migrated=await settings();assert.equal(migrated.shortcuts['player.screenshot'],'Alt+KeyR');assert.equal(migrated.shortcuts['waveform.reset'],'');assert.equal(migrated.shortcuts['waveform.panRight'],'WheelDown');report.checks.push('real pre-waveform configuration loads, keeps custom key and fills conflict-free defaults')
  await page.locator('.navigation').getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'编辑快捷键',exact:true}).click()
  const geometry=await page.locator('.shortcut-group').first().locator('.shortcut-row').evaluateAll(rows=>rows.slice(0,2).map(row=>row.getBoundingClientRect().toJSON()));assert.ok(geometry[1].left>geometry[0].right,'Shortcut rows must use two columns');assert.ok(Math.abs(geometry[1].top-geometry[0].top)<1);report.geometry=geometry
  const binding=id=>page.locator(`[data-shortcut="${id}"] .shortcut-binding`)
  await binding('waveform.panRight').click();await page.keyboard.down('Alt');await page.mouse.wheel(0,120);await page.keyboard.up('Alt');await until(()=>binding('waveform.panRight').innerText().then(text=>text.includes('Alt')&&text.includes('滚轮下')))
  await binding('waveform.zoomIn').click();await page.keyboard.press('Control+Alt+=');await until(()=>binding('waveform.zoomIn').innerText().then(text=>text.includes('Ctrl')&&text.includes('Alt')&&text.includes('=')))
  await binding('waveform.clearSelection').click({button:'right'});assert.equal(await binding('waveform.clearSelection').innerText(),'未设置');assert.equal((await settings()).shortcuts['waveform.panRight'],'WheelDown','Draft changes must wait for Save')
  await page.screenshot({path:'artifacts/qa/waveform-shortcuts-two-columns.png',fullPage:true});await page.locator('.settings-save').getByRole('button',{name:'保存设置',exact:true}).click();await until(()=>settings().then(value=>value.shortcuts['waveform.panRight']==='Alt+WheelDown'&&value.shortcuts['waveform.zoomIn']==='Ctrl+Alt+Equal'));await page.locator('.settings-save:not(.settings-dirty)').waitFor();report.checks.push('two-column recorder captures keyboard and modified wheel; right click clears; Save applies')
  await page.locator('.navigation').getByRole('button',{name:'字幕编辑',exact:true}).click();const timeline=page.locator('.audio-timeline'),canvas=timeline.locator('canvas');await until(()=>player().then(state=>state.ready&&!state.loading));await page.evaluate(()=>window.muxivra.playerAction('subtitles',{type:'seek',positionMs:20000}));await until(()=>page.locator('.waveform-playhead line').getAttribute('data-position-ms').then(value=>Math.abs(Number(value)-20000)<100))
  const view=()=>timeline.getAttribute('data-start-ms').then(Number),span=()=>timeline.getAttribute('data-duration-ms').then(Number),hover=async()=>{const box=await canvas.boundingBox();await page.mouse.move(box.x+box.width*.7,box.y+box.height*.6)}
  await hover();const before=await view();await page.mouse.wheel(0,-90);await until(async()=>await view()<before);const left=await view();await page.mouse.wheel(0,90);await page.waitForTimeout(200);assert.equal(await view(),left,'Old plain-wheel binding must no longer act after rebinding')
  await page.keyboard.down('Alt');await page.mouse.wheel(0,90);await page.keyboard.up('Alt');await until(async()=>await view()>left);const oldSpan=await span();await page.locator('.workspace-header h1').click();await page.keyboard.press('Control+Alt+=');await until(async()=>await span()<oldSpan);report.checks.push('saved pan and zoom bindings execute on the active subtitle page')
  const nativeSpan=await span();await nativeKey('Ctrl+Alt+=');await until(async()=>await span()<nativeSpan,'Native mpv shortcut forwarded to waveform');report.checks.push('keyboard shortcuts stay in Chromium when the video is focused')
  const box=await canvas.boundingBox();await page.mouse.move(box.x+box.width*.5,box.y+box.height*.6);await page.keyboard.down('Control');await page.keyboard.down('Shift');await page.mouse.wheel(0,-80);await page.keyboard.up('Shift');await page.keyboard.up('Control');await until(()=>timeline.getAttribute('data-gain').then(value=>Number(value)>1));const paused=(await player()).paused;await page.keyboard.press('Space');await until(()=>player().then(state=>state.paused!==paused));await page.keyboard.press('Space');await until(()=>player().then(state=>state.paused===paused));report.checks.push('vertical zoom remains configurable and Space over waveform still toggles playback')
  await desktop.close();desktop=undefined;await launch();const restored=await settings();assert.equal(restored.shortcuts['waveform.panRight'],'Alt+WheelDown');assert.equal(restored.shortcuts['waveform.zoomIn'],'Ctrl+Alt+Equal');assert.equal(restored.shortcuts['waveform.clearSelection'],'');report.checks.push('bindings and disabled actions survive restart')
  assert.deepEqual(report.errors,[]);success=true;await writeFile('artifacts/qa/waveform-shortcuts-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}catch(error){report.failure=error.stack;await page?.screenshot({path:'artifacts/qa/waveform-shortcuts-failed.png',fullPage:true}).catch(()=>{});await writeFile('artifacts/qa/waveform-shortcuts-failed.json',JSON.stringify(report,null,2));throw error}
finally{await desktop?.close().catch(()=>{});if(success){const inside=relative(resolve('.test-data'),root);if(!inside||inside.startsWith('..')||isAbsolute(inside))throw new Error('Unsafe cleanup');await rm(root,{recursive:true,force:true})}}
