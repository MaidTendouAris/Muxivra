import { installHeadlessTextureFixture } from './headless-texture-fixture.mjs'
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { mkdir,mkdtemp,readFile,readdir,stat,writeFile,rm } from 'node:fs/promises'
import { join,resolve,relative,isAbsolute,sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { createProject } from './gui-projects.mjs'

// Real media, project preprocessing, pointer interactions and native playback.
// This test only writes to a new .test-data directory; no existing projects are used.
await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const root=await mkdtemp(resolve('.test-data','subtitle-waveform-interaction-')),source=join(root,'waveform-interaction.mp4')
await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=10:duration=40','-f','lavfi','-i',"aevalsrc='0.35*sin(2*PI*440*t)*between(mod(t,4),0.4,2.8)':s=48000:d=40",'-f','lavfi','-i',"aevalsrc='0.65*sin(2*PI*6000*t)*between(mod(t,3),0.3,1.6)':s=48000:d=40",'-map','0:v','-map','1:a','-map','2:a','-c:v','libx264','-preset','ultrafast','-g','10','-c:a','aac','-shortest',source],{windowsHide:true,timeout:60000})
let desktop,page,sourceWindow,success=false
const report={executable:process.env.MUXIVRA_EXECUTABLE||'development',fixture:root,checks:[],errors:[],layouts:[]}
const until=async(check,label='Waveform state',timeout=30000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await new Promise(done=>setTimeout(done,40))}throw new Error(label+' timed out')}
const launch=async()=>{desktop=await electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE||electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_TEST_SYSTEM_LANGUAGES:'zh-CN',MUXIVRA_DATA_PATH:join(root,'profile'),MUXIVRA_ENGINE_PATH:join(root,'engines')},timeout:60000});await installHeadlessTextureFixture(desktop);page=await desktop.firstWindow();page.on('pageerror',error=>report.errors.push(error.message));await page.getByRole('heading',{name:'视频处理',exact:true}).waitFor({timeout:60000})}
try{
  await launch();report.version=await desktop.evaluate(({app})=>app.getVersion())
  await page.evaluate(()=>{window.waveformSmokePhases=[];window.muxivra.onUpdate(state=>{const phase=state.projects?.import?.phase;if(phase&&!window.waveformSmokePhases.includes(phase))window.waveformSmokePhases.push(phase)})})
  const project=await createProject(page,desktop,source)
  report.projectCreationPhases=await page.evaluate(()=>window.waveformSmokePhases)
  const analysisPath=join(project.directory,'analysis'),manifest=JSON.parse(await readFile(join(analysisPath,'media.json'),'utf8')),timing=JSON.parse(await readFile(join(analysisPath,'video-timing.json'),'utf8'))
  assert.equal(manifest.format,'muxivra-media-analysis');assert.equal(manifest.version,1);assert.equal(manifest.sampleRate,48000);assert.equal(manifest.audio.length,2,'Project creation must preprocess every audio track');assert.ok(manifest.durationMs>=39900);assert.equal(manifest.video,true)
  assert.equal(timing.timestampsMs.length,400,'Project creation must index every displayed video frame');assert.equal(timing.timestampsMs[0],0);assert.equal(timing.timestampsMs[10],1000);assert.ok(timing.keyframes.length>1)
  const originalAnalysis={}
  for(const name of await readdir(analysisPath)){const file=join(analysisPath,name),info=await stat(file);if(info.isFile())originalAnalysis[name]={size:info.size,mtimeMs:info.mtimeMs}}
  for(const audio of manifest.audio){assert.ok(audio.sampleFrames>=48000*39.9);assert.ok(audio.levels.length>=2,'Waveforms need a persistent multiresolution pyramid');for(const level of audio.levels){const inside=relative(analysisPath,resolve(analysisPath,level.file));assert.ok(inside&&!inside.startsWith('..')&&!isAbsolute(inside),'Waveform bins must stay inside the project');assert.equal((await stat(join(analysisPath,level.file))).size,level.bins*12)}}
  report.analysis={audioTracks:manifest.audio.length,sampleRate:manifest.sampleRate,frames:timing.timestampsMs.length,files:originalAnalysis};report.checks.push('project is committed only with full 48 kHz multitrack waveform files and frame index inside its own folder')
  const timeline=page.locator('.audio-timeline'),canvas=timeline.locator('canvas'),session=()=>page.evaluate(()=>window.muxivra.getSession()),player=()=>page.evaluate(()=>window.muxivra.playerState('subtitles'))
  await until(()=>player().then(state=>state.ready&&!state.loading&&state.durationMs>39000),'Player loaded')
  await until(()=>timeline.getAttribute('aria-busy').then(value=>value==='false'),'Preprocessed waveform loaded')
  assert.equal(await timeline.getAttribute('data-duration-ms'),'15000');assert.equal(await timeline.getAttribute('data-sample-rate'),'48000');assert.equal(await page.getByRole('button',{name:'建立帧索引',exact:true}).count(),0)
  assert.equal(await page.locator('.subtitle-preview-card .audio-timeline').count(),0);assert.equal(await page.locator('.subtitle-edit-column .audio-timeline').count(),1)
  for(const [width,height] of [[1440,900],[1040,720]]){
    await desktop.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows().find(window=>!window.webContents.getURL().includes('window=source-editor')).setSize(size.width,size.height),{width,height});await page.waitForTimeout(200)
    const geometry=await page.evaluate(()=>{const box=selector=>document.querySelector(selector).getBoundingClientRect().toJSON();return {width:innerWidth,height:innerHeight,scrollHeight:document.scrollingElement.scrollHeight,preview:box('.subtitle-preview-card'),waveform:box('.audio-timeline'),editor:box('.subtitle-edit-card'),column:box('.subtitle-edit-column'),list:box('.subtitle-list-card'),dock:box('.subtitle-project-card')}})
    assert.ok(geometry.scrollHeight<=geometry.height+1,'Only cards may scroll');assert.ok(geometry.waveform.left>=geometry.column.left-1);assert.ok(geometry.waveform.bottom<=geometry.editor.top+1,'Waveform must be above the editing card');assert.ok(geometry.list.bottom<=geometry.height&&geometry.dock.bottom<=geometry.height);assert.ok(geometry.preview.right<=geometry.waveform.left+1,'Waveform must be beside the player');assert.ok(geometry.list.height>=200,'Subtitle list retains useful space')
    report.layouts.push(geometry);await page.screenshot({path:`artifacts/qa/subtitle-waveform-interaction-${width}.png`,fullPage:true})
  }
  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(window=>!window.webContents.getURL().includes('window=source-editor')).setSize(1440,900));await page.waitForTimeout(200)
  const view=async()=>({start:Number(await timeline.getAttribute('data-start-ms')),span:Number(await timeline.getAttribute('data-duration-ms'))})
  const point=async(ratio,y=.65)=>{const box=await canvas.boundingBox();return {x:box.x+box.width*ratio,y:box.y+box.height*y}}
  const click=async(ratio,options)=>{const p=await point(ratio);await page.mouse.click(p.x,p.y,options)}
  const drag=async(from,to)=>{const a=await point(from),b=await point(to);await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:12});await page.mouse.up()}
  let rangeView=await view();await click(.2);await until(()=>player().then(state=>Math.abs(state.positionMs-(rangeView.start+rangeView.span*.2))<120),'Single click seeks video');report.checks.push('single left click seeks to the waveform timestamp')
  await drag(.25,.45)
  const selection=async()=>({start:Number(await timeline.getAttribute('data-selection-start-ms')),end:Number(await timeline.getAttribute('data-selection-end-ms')),manual:await timeline.getAttribute('data-manual-selection')})
  await until(()=>selection().then(value=>value.manual==='true'&&value.end>value.start),'Drag selects a manual range');let chosen=await selection();assert.ok(Math.abs(chosen.start-(rangeView.start+rangeView.span*.25))<50);assert.ok(Math.abs(chosen.end-(rangeView.start+rangeView.span*.45))<50)
  const moveHandle=async(selector,ratio)=>{const handle=timeline.locator(selector),box=await handle.boundingBox(),end=await point(ratio);assert.ok(box,'Accessible waveform boundary handle must be visible');await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:10});await page.mouse.up()}
  await moveHandle('.waveform-selection-start',.2);chosen=await selection();assert.ok(Math.abs(chosen.start-(rangeView.start+rangeView.span*.2))<60)
  await moveHandle('.waveform-selection-end',.6);chosen=await selection();assert.ok(Math.abs(chosen.end-(rangeView.start+rangeView.span*.6))<60)
  await click(.7,{button:'right'});chosen=await selection();assert.ok(Math.abs(chosen.end-(rangeView.start+rangeView.span*.7))<60);report.checks.push('left drag selects, either boundary can be adjusted, right click changes the selected end')
  const nativeBeforeHandleKeys=(await player()).positionMs,beforeHandleKeys={...chosen}
  await timeline.locator('.waveform-selection-start').focus();await page.keyboard.press('ArrowRight');await until(()=>selection().then(value=>value.start===beforeHandleKeys.start+1),'Keyboard start boundary one millisecond')
  await timeline.locator('.waveform-selection-end').focus();await page.keyboard.press('ArrowLeft');await until(()=>selection().then(value=>value.end===beforeHandleKeys.end-1),'Keyboard end boundary one millisecond')
  assert.ok(Math.abs((await player()).positionMs-nativeBeforeHandleKeys)<=1,'Boundary arrow keys must not seek native playback');chosen=await selection();report.checks.push('focused boundary arrow keys change the manual range by1ms without moving native playback')
  await page.getByRole('button',{name:'新增字幕',exact:true}).click();await until(()=>session().then(document=>document.cues.length===1),'New subtitle from range')
  let cue=(await session()).cues[0];assert.ok(Math.abs(cue.startMs-chosen.start)<20);assert.ok(Math.abs(cue.endMs-chosen.end)<20);report.selectionCue={selection:chosen,cue};report.checks.push('new subtitle uses the manual waveform range rather than the video playhead')
  await page.getByLabel('字幕文本',{exact:true}).fill('Waveform-selected subtitle');await page.locator('.workspace-header h1').click()
  const beforePan=await view(),wasPaused=(await player()).paused
  const a=await point(.85);await page.mouse.move(a.x,a.y);await page.mouse.wheel(0,180)
  await until(()=>view().then(value=>value.start>beforePan.start+1000),'Mouse wheel pans waveform');assert.equal((await player()).paused,wasPaused);assert.equal(await timeline.getAttribute('data-manual-selection'),'false')
  const forward=await view();await page.mouse.wheel(0,-100);await until(()=>view().then(value=>value.start<forward.start),'Reverse wheel pans left')
  await page.keyboard.press('Space');await until(()=>player().then(state=>state.paused!==wasPaused),'Space retains playback shortcut over waveform');await page.keyboard.press('Space');await until(()=>player().then(state=>state.paused===wasPaused),'Space pauses again')
  report.checks.push('plain mouse wheel pans either direction; Space remains playback toggle over the waveform')
  const scrollbar=timeline.getByLabel('波形位置',{exact:true});const scrollBox=await scrollbar.boundingBox();assert.ok(scrollBox&&scrollBox.width>100)
  const scrollRange=await scrollbar.evaluate(element=>({min:Number(element.min),max:Number(element.max),value:Number(element.value),thumbPercent:parseFloat(element.style.getPropertyValue('--waveform-thumb-width'))})),thumb=Math.max(18,scrollBox.width*scrollRange.thumbPercent/100),startX=scrollBox.x+thumb/2+(scrollBox.width-thumb)*(scrollRange.value-scrollRange.min)/(scrollRange.max-scrollRange.min),endX=scrollBox.x+thumb/2+(scrollBox.width-thumb)*.8
  await page.mouse.move(startX,scrollBox.y+scrollBox.height/2);await page.mouse.down();await page.mouse.move(endX,scrollBox.y+scrollBox.height/2,{steps:14});await page.mouse.up();await until(()=>view().then(value=>value.start>scrollRange.max*.65),'Waveform scrollbar pans');report.checks.push('draggable scrollbar below waveform moves through the full media')
  const startFrame=page.getByLabel('起始帧（从 0 编号）',{exact:true}),endFrame=page.getByLabel('结束帧（不含）',{exact:true}),frameDuration=page.getByLabel('持续帧数',{exact:true})
  await startFrame.fill('20');await startFrame.press('Tab');await until(()=>session().then(document=>document.cues[0].startMs===2000),'Start frame edits timestamp')
  await endFrame.fill('50');await endFrame.press('Tab');await until(()=>session().then(document=>document.cues[0].endMs===5000),'End frame edits timestamp');assert.equal(await frameDuration.inputValue(),'30')
  await page.getByLabel('开始时间',{exact:true}).fill('00:00:01,000');await page.getByLabel('开始时间',{exact:true}).press('Tab');await until(()=>startFrame.inputValue().then(value=>value==='10'),'Timestamp updates integrated frame field')
  await frameDuration.fill('20');await frameDuration.press('Tab');await until(()=>session().then(document=>document.cues[0].endMs===3000),'Frame duration edits exclusive end')
  report.checks.push('start/end/duration frame fields share the cached index and synchronize bidirectionally with timestamp fields')
  await page.screenshot({path:'artifacts/qa/subtitle-waveform-interaction-editing.png',fullPage:true})
  await page.locator('.workspace-header h1').click();await page.getByRole('button',{name:'重置波形',exact:true}).click();await page.evaluate(()=>window.muxivra.playerAction('subtitles',{type:'seek',positionMs:14000}));await until(()=>player().then(state=>Math.abs(state.positionMs-14000)<120),'Seek before continuous follow')
  await page.evaluate(()=>window.muxivra.playerAction('subtitles',{type:'play'}))
  // Starting playback may align an already sought playhead within the viewport.
  // Measure steady playback after that explicit seek, not the seek discontinuity.
  await until(()=>view().then(value=>value.start>8000),'Playback viewport aligned after explicit seek')
  const samples=await page.evaluate(()=>new Promise(resolve=>{const data=[];let count=0;const sample=()=>{const timeline=document.querySelector('.audio-timeline');data.push({at:performance.now(),start:Number(timeline.dataset.startMs),cursor:Number(document.querySelector('.waveform-playhead line')?.dataset.positionMs)});if(++count<100)requestAnimationFrame(sample);else resolve(data)};requestAnimationFrame(sample)}))
  await page.evaluate(()=>window.muxivra.playerAction('subtitles',{type:'pause'}))
  report.followSamples=samples
  const updates=samples.slice(1).map((sample,index)=>sample.start-samples[index].start).filter(delta=>Math.abs(delta)>.01),maxStep=Math.max(0,...updates.map(Math.abs));assert.ok(updates.length>15,`Follow must move continuously rather than page: ${updates.length} updates`);assert.ok(maxStep<1000,`Waveform must not jump an entire page: ${maxStep}ms`)
  report.continuousFollow={samples:samples.length,updates:updates.length,maxStep,totalMove:samples.at(-1).start-samples[0].start};report.checks.push('waveform scrolls continuously with the playback clock instead of flipping 15-second pages')
  for(const [name,expected] of Object.entries(originalAnalysis)){const info=await stat(join(analysisPath,name));assert.equal(info.size,expected.size);assert.equal(info.mtimeMs,expected.mtimeMs,'Editing and panning must reuse analysis without rewriting it')}
  const opened=desktop.waitForEvent('window');await page.locator('.subtitle-project-card').getByRole('button',{name:'源码编辑',exact:true}).click();sourceWindow=await opened;sourceWindow.on('pageerror',error=>report.errors.push(error.message));await sourceWindow.getByTestId('source-save-status').getByText('已保存',{exact:true}).waitFor({timeout:30000});assert.equal((await sourceWindow.evaluate(()=>window.sourceEditor.read())).path,project.subtitlePath);report.checks.push('collapsed project toolbar opens the current subtitle in the independent source editor')
  const sourceClosed=sourceWindow.waitForEvent('close');await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('window=source-editor')).close());await sourceClosed;sourceWindow=undefined
  const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex'),mediaBeforeRebuild=await hash(project.mediaPath),subtitleBeforeRebuild=Object.fromEntries(await Promise.all(project.subtitles.map(async file=>[file.path,await hash(file.path)]))),manifestBeforeRebuild=(await stat(join(analysisPath,'media.json'))).mtimeMs
  await page.locator('.navigation').getByRole('button',{name:'项目管理',exact:true}).click();await page.locator('.project-card').filter({hasText:project.name}).getByRole('button',{name:'项目文件',exact:true}).click()
  await page.getByRole('button',{name:'重新预处理',exact:true}).click();await page.getByRole('button',{name:'预处理中…',exact:true}).waitFor({timeout:5000})
  await until(async()=>{if((await page.evaluate(()=>window.muxivra.snapshot())).projects.import.active)return false;const file=await stat(join(analysisPath,'media.json'));return file.mtimeMs>manifestBeforeRebuild},'Explicit project preprocessing completed',60000)
  assert.equal(await hash(project.mediaPath),mediaBeforeRebuild,'Reprocessing must leave the media copy byte-identical');for(const [path,expected] of Object.entries(subtitleBeforeRebuild))assert.equal(await hash(path),expected,'Reprocessing must preserve every ASS file byte-for-byte')
  const rebuiltManifest=JSON.parse(await readFile(join(analysisPath,'media.json'),'utf8'));assert.equal(rebuiltManifest.audio.length,2);assert.equal(JSON.parse(await readFile(join(analysisPath,'video-timing.json'),'utf8')).timestampsMs.length,400)
  await page.getByRole('button',{name:'返回项目管理',exact:true}).click();await page.locator('.project-card').filter({hasText:project.name}).getByRole('button',{name:'编辑字幕',exact:true}).click();await until(()=>player().then(state=>state.ready&&!state.loading),'Reopened editor player');await until(()=>timeline.getAttribute('aria-busy').then(value=>value==='false'),'Reopened cached waveform');assert.equal(await page.getByLabel('字幕文本',{exact:true}).inputValue(),'Waveform-selected subtitle');await startFrame.waitFor()
  const rebuiltView=await view();await click(.45);await until(()=>player().then(state=>Math.abs(state.positionMs-(rebuiltView.start+rebuiltView.span*.45))<150),'Cached waveform remains interactive after rebuild')
  report.rebuild={mediaPreserved:true,allSubtitlesPreserved:true,persistentDataReplaced:true,audioTracks:rebuiltManifest.audio.length};report.checks.push('Project Files explicit reprocessing shows progress, rebuilds persistent analysis, preserves media andASS bytes and returns an operational cached editor')
  assert.deepEqual(report.errors,[]);assert.equal(await page.locator('.toast-error').count(),0);success=true
  await writeFile('artifacts/qa/subtitle-waveform-interaction-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify({version:report.version,checks:report.checks,continuousFollow:report.continuousFollow,analysis:{audioTracks:report.analysis.audioTracks,sampleRate:report.analysis.sampleRate,frames:report.analysis.frames},errors:report.errors},null,2))
}catch(error){report.failure=error.stack;report.screen=await page?.locator('body').innerText().catch(()=>undefined);await page?.screenshot({path:'artifacts/qa/subtitle-waveform-interaction-failed.png',fullPage:true}).catch(()=>{});await writeFile('artifacts/qa/subtitle-waveform-interaction-failed.json',JSON.stringify(report,null,2));throw error}
finally{await desktop?.close().catch(()=>{});if(success){const inside=relative(resolve('.test-data'),root);if(!inside||inside==='..'||inside.startsWith(`..${sep}`)||isAbsolute(inside))throw new Error('Unsafe cleanup path');await rm(root,{recursive:true,force:true})}}
