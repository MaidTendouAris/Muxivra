import { createProject } from './gui-projects.mjs'
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { mkdir,mkdtemp,writeFile,rm } from 'node:fs/promises'
import { join,resolve,relative,isAbsolute,sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const root=await mkdtemp(resolve('.test-data','subtitle-audio-')),source=join(root,'waveform.mp4'),subtitle=join(root,'events.ass')
await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=10:duration=40','-f','lavfi','-i',"aevalsrc='0.6*sin(2*PI*6000*t)*between(mod(t,3),0.5,1.5)':s=48000:d=40",'-c:v','libx264','-preset','ultrafast','-c:a','aac',source],{windowsHide:true})
const stamp=ms=>`${Math.floor(ms/3600000)}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(Math.round(ms%1000/10)).padStart(2,'0')}`
const lines=Array.from({length:50},(_,i)=>`Dialogue: 0,${stamp(i*200)},${stamp(i*200+190)},Default,,0,0,0,,line-${i+1}`)
lines.push('Dialogue: 0,0:00:15.20,0:00:17.80,Default,,0,0,0,,second-window','Dialogue: 1,0:00:16.00,0:00:18.00,Default,,0,0,0,,overlapping-dialogue','Comment: 0,0:00:16.00,0:00:20.00,Default,,0,0,0,,hidden-comment','Dialogue: 0,0:00:30.00,0:00:33.00,Default,,0,0,0,,third-window')
await writeFile(subtitle,'[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'+lines.join('\n')+'\n')
const desktop=await electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE||electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_DATA_PATH:join(root,'profile'),MUXIVRA_ENGINE_PATH:join(root,'engines')},timeout:60000})
const report={executable:process.env.MUXIVRA_EXECUTABLE||'development',errors:[]};let page
try{
  page=await desktop.firstWindow();page.on('pageerror',error=>report.errors.push(error.message));report.appVersion=await desktop.evaluate(({app})=>app.getVersion())
  await page.getByRole('heading',{name:'视频处理',exact:true}).waitFor({timeout:60000})
  await page.locator('.navigation').getByRole('button',{name:'字幕编辑',exact:true}).click()
  const pick=async path=>desktop.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]})},path)
  const until=async check=>{const end=Date.now()+30000;while(Date.now()<end){if(await check())return;await page.waitForTimeout(50)}throw new Error('Subtitle audio smoke timed out')}
  const seek=async ms=>{await page.evaluate(positionMs=>window.muxivra.playerAction('subtitles',{type:'seek',positionMs}),ms);await until(()=>page.evaluate(async target=>Math.abs((await window.muxivra.playerState('subtitles')).positionMs-target)<100,ms));await until(()=>page.locator('.waveform-playhead line').getAttribute('data-position-ms').then(value=>Math.abs(Number(value)-ms)<100))}
  await createProject(page,desktop,source,{subtitle})
  await until(()=>page.evaluate(async()=>{const s=await window.muxivra.playerState('subtitles');return s.ready&&!s.loading&&s.durationMs>30000}))
  const timeline=page.locator('.audio-timeline'),canvas=timeline.locator('canvas')
  await until(()=>timeline.getAttribute('aria-busy').then(value=>value==='false'));assert.equal(await timeline.getAttribute('data-duration-ms'),'15000');assert.equal(await timeline.getAttribute('data-sample-rate'),'48000')
  await until(()=>page.locator('.subtitle-file-meta>.hint').innerText().then(text=>text.includes('54')))
  const follow=page.getByRole('checkbox',{name:'跟随播放',exact:true});assert.equal(await follow.isChecked(),false)
  await follow.check();await seek(8050);await until(()=>page.getByRole('checkbox',{name:'选择第 41 条字幕',exact:true}).isChecked());assert.ok(await page.locator('.subtitle-event-table').evaluate(element=>element.scrollTop)>0,'Following should scroll the current line into view')
  await seek(16100);await until(()=>page.getByLabel('字幕页码',{exact:true}).inputValue().then(value=>value==='2'))
  await until(()=>page.getByRole('checkbox',{name:'选择第 51 条字幕',exact:true}).isChecked());assert.equal(await page.getByRole('checkbox',{name:'选择第 52 条字幕',exact:true}).isChecked(),true);assert.equal(await page.getByRole('checkbox',{name:'选择第 53 条字幕',exact:true}).isChecked(),false)
  await until(()=>timeline.evaluate(element=>{const start=Number(element.dataset.startMs),span=Number(element.dataset.durationMs);return start<=16100&&start+span>=16100}))
  await page.getByLabel('字幕文本',{exact:true}).focus();await seek(31000);assert.equal(await page.getByLabel('字幕文本',{exact:true}).inputValue(),'second-window')
  await page.locator('.workspace-header').click();await until(()=>page.getByRole('checkbox',{name:'选择第 54 条字幕',exact:true}).isChecked())
  await follow.uncheck();await seek(1000);assert.equal(await page.getByRole('checkbox',{name:'选择第 54 条字幕',exact:true}).isChecked(),true)
  await canvas.scrollIntoViewIfNeeded();const box=await canvas.boundingBox();await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5)
  await page.keyboard.down('Control');await page.mouse.wheel(0,-100);await page.keyboard.up('Control');await until(()=>timeline.getAttribute('data-duration-ms').then(value=>Number(value)<15000))
  const zoomed={startMs:Number(await timeline.getAttribute('data-start-ms')),durationMs:Number(await timeline.getAttribute('data-duration-ms'))};assert.equal(await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()),1)
  await page.getByRole('button',{name:'放大波形纵轴',exact:true}).click();assert.equal(Number(await timeline.getAttribute('data-gain')),2)
  await page.getByRole('button',{name:'缩小波形纵轴',exact:true}).click();assert.equal(Number(await timeline.getAttribute('data-gain')),1)
  const manualStart=Number(await timeline.getAttribute('data-start-ms'));await page.waitForTimeout(200);assert.ok(Math.abs(Number(await timeline.getAttribute('data-start-ms'))-manualStart)<1,'Repeated paused reports must preserve the manual viewport')
  await until(()=>timeline.getAttribute('aria-busy').then(value=>value==='false'));const clickBox=await canvas.boundingBox(),target=Number(await timeline.getAttribute('data-start-ms'))+Number(await timeline.getAttribute('data-duration-ms'))*.3
  await page.mouse.click(clickBox.x+clickBox.width*.3,clickBox.y+clickBox.height*.6);await until(()=>page.evaluate(async target=>Math.abs((await window.muxivra.playerState('subtitles')).positionMs-target)<100,target))
  const waveformScroll=timeline.getByRole('slider',{name:'波形位置',exact:true});await waveformScroll.focus();await waveformScroll.press('Home');await until(()=>timeline.getAttribute('data-start-ms').then(value=>Number(value)===0))
  const nativeSeek=page.locator('.subtitle-preview-card').getByRole('slider',{name:'播放进度',exact:true}),nativeBox=await nativeSeek.boundingBox();await page.mouse.click(nativeBox.x+nativeBox.width*.8,nativeBox.y+nativeBox.height*.5)
  await until(()=>page.evaluate(async()=>{const state=await window.muxivra.playerState('subtitles'),wave=document.querySelector('.audio-timeline'),start=Number(wave.dataset.startMs),span=Number(wave.dataset.durationMs);return state.positionMs>28000&&start>20000&&state.positionMs>=start&&state.positionMs<=start+span}))
  await page.getByRole('button',{name:'重置波形',exact:true}).click();await until(()=>timeline.getAttribute('data-duration-ms').then(value=>value==='15000'))
  await seek(14800);await follow.check();await page.evaluate(()=>window.muxivra.playerAction('subtitles',{type:'play'}));await until(async()=>(await page.getByLabel('字幕页码',{exact:true}).inputValue())==='2'&&Number(await timeline.getAttribute('data-start-ms'))>9000)
  await page.evaluate(()=>window.muxivra.playerAction('subtitles',{type:'pause'}));await follow.uncheck();await until(()=>timeline.getAttribute('aria-busy').then(value=>value==='false'))
  await seek(6000);await page.evaluate(async()=>{await window.muxivra.playerAction('subtitles',{type:'speed',value:2});await window.muxivra.playerAction('subtitles',{type:'play'})})
  const smooth=await page.evaluate(()=>new Promise(resolve=>{const values=[];let count=0;const sample=()=>{values.push({cursor:Number(document.querySelector('.waveform-playhead line')?.dataset.positionMs),start:Number(document.querySelector('.audio-timeline')?.dataset.startMs),actual:document.querySelector('.player-seek code')?.textContent});if(++count<45)requestAnimationFrame(sample);else resolve(values)};requestAnimationFrame(sample)}))
  const cursorUpdates=new Set(smooth.map(s=>Math.round(s.cursor))).size,actualUpdates=new Set(smooth.map(s=>s.actual)).size
  assert.ok(cursorUpdates>actualUpdates*1.2,`Playhead must animate between reports: cursor=${cursorUpdates}, reports=${actualUpdates}`)
  const viewportUpdates=new Set(smooth.map(s=>Math.round(s.start))).size;assert.ok(viewportUpdates>actualUpdates*1.2,`Waveform should scroll between reports: viewport=${viewportUpdates}, reports=${actualUpdates}`)
  await page.evaluate(()=>window.muxivra.playerAction('subtitles',{type:'pause'}));await page.waitForTimeout(150)
  const pausedCursor=Number(await page.locator('.waveform-playhead line').getAttribute('data-position-ms'));await page.waitForTimeout(150);assert.equal(Number(await page.locator('.waveform-playhead line').getAttribute('data-position-ms')),pausedCursor)
  report.playhead={cursorUpdates,viewportUpdates,actualUpdates,pausedCursor,speed:2};await page.evaluate(()=>window.muxivra.playerAction('subtitles',{type:'speed',value:1}));await seek(16000)
  for(const theme of ['dark','light']){await page.evaluate(async theme=>{const s=await window.muxivra.snapshot();await window.muxivra.saveSettings({...s.settings,theme})},theme);await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);await page.waitForTimeout(120);await page.screenshot({path:`artifacts/qa/subtitle-audio-${theme}.png`,fullPage:true})}
  const colors=await canvas.evaluate(element=>{const context=element.getContext('2d'),h=element.getBoundingClientRect().height,timeline=element.closest('.audio-timeline'),start=Number(timeline.dataset.startMs),span=Number(timeline.dataset.durationMs),pulse=Math.ceil((start-800)/3000)*3000+800,x=Math.floor(element.width*(pulse-start)/span),y=Math.floor((19+(h-19)/2)*devicePixelRatio),pixels=context.getImageData(Math.max(0,x-1),Math.max(0,y-1),3,3).data,candidates=Array.from({length:9},(_,i)=>[...pixels.slice(i*4,i*4+4)]);candidates.sort((a,b)=>a.slice(0,3).reduce((sum,v,i)=>sum+(v-[104,127,50][i])**2,0)-b.slice(0,3).reduce((sum,v,i)=>sum+(v-[104,127,50][i])**2,0));return {accent:getComputedStyle(element).getPropertyValue('--accent').trim(),startMs:start,span,pulse,pixel:candidates[0]}});report.themeColors=colors;assert.equal(colors.accent,'#687f32');assert.ok(colors.pixel[3]>180&&colors.pixel.slice(0,3).every((value,index)=>Math.abs(value-[104,127,50][index])<=24),'Paused waveform must preserve 6kHz audio and redraw when the theme changes at fractional DPI')
  assert.deepEqual(report.errors,[]);report.result={floatWithoutReflow:true,followOffByDefault:true,overlapSelection:true,commentsExcluded:true,paginationAndScroll:true,editingProtected:true,waveformSampleRate:48000,defaultWindowMs:15000,ctrlWheelZoom:true,verticalGain:true,pageZoomPreserved:true,clickSeek:true,pausedManualViewportStable:true,nativeSeekResumes:true,continuousWaveformFollow:true};report.zoomed=zoomed
  await writeFile('artifacts/qa/subtitle-audio-smoke.json',JSON.stringify(report,null,2));console.log('Subtitle audio smoke passed')
}catch(error){report.failure=error.stack;await page?.screenshot({path:'artifacts/qa/subtitle-audio-failed.png',fullPage:true}).catch(()=>{});await writeFile('artifacts/qa/subtitle-audio-failed.json',JSON.stringify(report,null,2));throw error}
finally{await desktop.close();const inside=relative(resolve('.test-data'),root);if(!inside||inside==='..'||inside.startsWith(`..${sep}`)||isAbsolute(inside))throw new Error('Unsafe cleanup path');await rm(root,{recursive:true,force:true})}
