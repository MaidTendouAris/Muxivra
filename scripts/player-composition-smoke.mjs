import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { mkdir,mkdtemp,writeFile,readFile,rename,rm } from 'node:fs/promises'
import { resolve,join,relative,isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createProject } from './gui-projects.mjs'

await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const root=await mkdtemp(resolve('.test-data','player-composition-')),video=join(root,'preview.mkv'),subtitle=join(root,'preview.ass')
await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=20','-f','lavfi','-i','sine=frequency=600:duration=20','-c:v','libx265','-pix_fmt','yuv420p10le','-preset','ultrafast','-x265-params','log-level=error:pools=2:frame-threads=2','-c:a','aac',video],{windowsHide:true})
await writeFile(subtitle,'[Script Info]\nScriptType: v4.00+\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:19.00,Default,,0,0,0,,{\\c&H00FFFF&}Composited ASS\n')
const desktop=await electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE||electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_TEST_SYSTEM_LANGUAGES:'zh-CN',MUXIVRA_DATA_PATH:join(root,'profile'),MUXIVRA_ENGINE_PATH:join(root,'engines')},timeout:60000})
let page,success=false
const report={sourceCodec:'HEVC Main 10 / MKV',checks:[],errors:[],diagnostics:[],closeMs:[]}
const until=async(check,label)=>{const end=Date.now()+20000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,40))}throw new Error(label+' timed out')}
try {
  page=await desktop.firstWindow();page.on('pageerror',error=>report.errors.push(error.message));await page.getByRole('heading',{name:'视频处理',exact:true}).waitFor({timeout:60000})
  report.version=await desktop.evaluate(({app})=>app.getVersion())
  const state=owner=>page.evaluate(owner=>window.muxivra.playerState(owner),owner)
  const action=(owner,value)=>page.evaluate(({owner,value})=>window.muxivra.playerAction(owner,value),{owner,value})
  const diagnostics=()=>desktop.evaluate(({ipcMain})=>ipcMain._invokeHandlers.get('muxivra:smoke-player-diagnostics')({}))
  const canvas=owner=>page.locator(`canvas[data-mpv-surface="${owner}"]`)
  const frameCount=owner=>canvas(owner).getAttribute('data-presented-frames').then(value=>Number(value)||0)
  await desktop.evaluate(({dialog},video)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[video]})},video)
  await page.getByRole('button',{name:'选择媒体文件',exact:true}).click()
  await until(async()=>{const s=await state('single');if(s.error)throw Error(s.error);return s.ready&&!s.loading&&s.videoWidth===640},'video loaded')
  await until(async()=>await frameCount('single')>0,'GPU frame presented')
  await action('single',{type:'mute',value:true});await action('single',{type:'play'})
  await until(async()=>(await state('single')).positionMs>500,'playback')
  // Deliberately hold imported texture references across several frame periods.
  // Resize while the consumer is slow; the worker must never overwrite a busy
  // texture or grow an unbounded retired-texture queue.
  await desktop.evaluate(({sharedTexture})=>{const original=sharedTexture.sendSharedTexture.bind(sharedTexture);globalThis.restoreTextureDelivery=()=>{sharedTexture.sendSharedTexture=original};sharedTexture.sendSharedTexture=async(...args)=>{await new Promise(r=>setTimeout(r,120));return original(...args)}})
  try {for(let index=0;index<16;index++){await desktop.evaluate(({BrowserWindow},index)=>BrowserWindow.getAllWindows()[0].setSize(index%2?1420:1090,index%3?850:990),index);await page.waitForTimeout(45)}}
  finally {await desktop.evaluate(()=>{globalThis.restoreTextureDelivery();delete globalThis.restoreTextureDelivery})}
  const prior=await frameCount('single');await until(async()=>await frameCount('single')>prior+8,'rendering recovers after resize/backpressure')
  report.diagnostics.push(...await diagnostics());for(const d of report.diagnostics){assert.ok(d.maxTextures<=3);assert.ok(d.maxInFlight<=3)}
  report.checks.push('rapid resize under a delayed GPU consumer remains bounded to three textures and recovers')
  await action('single',{type:'pause'});const position=(await state('single')).positionMs
  for(let index=0;index<10;index++){
    await page.locator('.navigation').getByRole('button',{name:'设置',exact:true}).click()
    await page.locator('.navigation').getByRole('button',{name:'视频处理',exact:true}).click()
    const before=await frameCount('single');await until(async()=>await frameCount('single')>before,'page return redraw')
    assert.ok(Math.abs((await state('single')).positionMs-position)<45)
  }
  report.checks.push('ten page round trips preserve pause/time and redraw without texture starvation')
  const project=await createProject(page,desktop,video,{subtitle})
  await until(async()=>await frameCount('subtitles')>0,'ASS preview')
  const document=await page.evaluate(()=>window.muxivra.getSession());assert.ok(document.cues[0].text.includes('Composited ASS'))
  for(let index=0;index<4;index++){
    await page.locator('.navigation').getByRole('button',{name:'项目管理',exact:true}).click()
    const started=Date.now();await page.locator('.project-card').getByRole('button',{name:'关闭工程',exact:true}).click()
    await until(async()=>!(await diagnostics()).some(d=>d.owner==='subtitles'),'closed render worker released')
    report.closeMs.push(Date.now()-started)
    await rename(project.mediaPath,project.mediaPath+'.released');await rename(project.mediaPath+'.released',project.mediaPath)
    if(index<3){await page.locator('.project-card').getByRole('button',{name:'编辑字幕',exact:true}).click();await until(async()=>await frameCount('subtitles')>0,'reopened ASS preview')}
  }
  assert.ok(Math.max(...report.closeMs)<5000,'Closing must drain textures instead of hitting the six-second worker fallback')
  assert.ok((await readFile(project.subtitlePath,'utf8')).includes('Composited ASS'))
  report.checks.push('four project open/close cycles release the render worker and media file handles; saved ASS survives')
  assert.deepEqual(report.errors,[]);assert.equal(await page.locator('.toast-error').count(),0)
  success=true;await writeFile('artifacts/qa/player-composition-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}catch(error){report.failure=error.stack;report.playerStates=await page?.evaluate(async()=>({single:await window.muxivra.playerState('single'),subtitles:await window.muxivra.playerState('subtitles')})).catch(()=>undefined);await page?.screenshot({path:'artifacts/qa/player-composition-failed.png'}).catch(()=>{});await writeFile('artifacts/qa/player-composition-failed.json',JSON.stringify(report,null,2));throw error}
finally {await desktop.close();if(success){const inside=relative(resolve('.test-data'),root);if(!inside||inside.startsWith('..')||isAbsolute(inside))throw Error('Unsafe cleanup');await rm(root,{recursive:true,force:true})}}
