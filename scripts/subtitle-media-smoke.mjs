import { createProject } from './gui-projects.mjs'
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { mkdir,mkdtemp,writeFile,readFile,readdir,rm } from 'node:fs/promises'
import { join,resolve,relative,isAbsolute,sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const root=await mkdtemp(resolve('.test-data','subtitle-media-ui-')),source=join(root,'quiet.mp4'),subtitle=join(root,'events.ass')
const originalSubtitle=join(root,'original.srt');await writeFile(originalSubtitle,'1\n00:00:00,000 --> 00:00:05,000\nOriginal subtitle\n')
await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=10:duration=10','-f','lavfi','-i','aevalsrc=0.008*sin(2*PI*440*t):s=48000:d=10','-i',originalSubtitle,'-map','0:v','-map','1:a','-map','2:s','-c:v','libx264','-preset','ultrafast','-c:a','aac','-c:s','mov_text',source],{windowsHide:true})
await writeFile(subtitle,'[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'+Array.from({length:50},(_,i)=>`Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,line ${i+1}`).join('\n')+'\n')
const desktop=await electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE||electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_DATA_PATH:join(root,'profile'),MUXIVRA_ENGINE_PATH:join(root,'engines')},timeout:60000})
const report={errors:[]};let page
try{
  page=await desktop.firstWindow();page.on('pageerror',error=>report.errors.push(error.message));report.appVersion=await desktop.evaluate(({app})=>app.getVersion())
  await page.getByRole('heading',{name:'单文件',exact:true}).waitFor({timeout:60000})
  await page.evaluate(async()=>{const s=await window.muxivra.snapshot();await window.muxivra.saveSettings({...s.settings,theme:'light'})})
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='light')
  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,900))
  const until=async check=>{const end=Date.now()+30000;while(Date.now()<end){if(await check())return;await page.waitForTimeout(50)}throw new Error('Subtitle handoff state timed out')}
  await desktop.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]})},source)
  await page.getByRole('button',{name:'选择媒体文件',exact:true}).click();await until(()=>page.evaluate(async()=>{const s=await window.muxivra.playerState('single');return s.ready&&!s.loading&&s.durationMs>9000}))
  const project=await createProject(page,desktop,source,{subtitle})
  await until(()=>page.evaluate(async()=>{const s=await window.muxivra.playerState('subtitles');return s.ready&&!s.loading&&s.durationMs>9000}))
  await page.locator('.subtitle-preview-card .mpv-viewport:not(.audio-viewport)').waitFor()
  const timeline=page.locator('.audio-timeline'),canvas=timeline.locator('canvas')
  await page.waitForFunction(()=>document.querySelector('.audio-timeline')?.getAttribute('aria-busy')==='false')
  const signalHeight=()=>canvas.evaluate(el=>{const ctx=el.getContext('2d'),x=Math.round(el.width*.22),data=ctx.getImageData(x,Math.ceil(20*devicePixelRatio),1,el.height-Math.ceil(20*devicePixelRatio)).data,ys=[];for(let y=0;y<data.length/4;y++)if(data[y*4+3]>150&&Math.abs(data[y*4]-104)<3&&Math.abs(data[y*4+1]-127)<3&&Math.abs(data[y*4+2]-50)<3)ys.push(y);return ys.length?Math.max(...ys)-Math.min(...ys)+1:0})
  const volume=(await page.evaluate(()=>window.muxivra.playerState('subtitles'))).volume,before=await signalHeight()
  for(let i=0;i<5;i++)await page.getByRole('button',{name:'放大波形纵轴',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('.audio-timeline')?.dataset.gain==='32');await page.waitForTimeout(100)
  const after=await signalHeight();assert.ok(after>before+3,`Quiet waveform should become visible: ${before} -> ${after}`)
  assert.equal(await timeline.getAttribute('data-duration-ms'),'15000');assert.equal((await page.evaluate(()=>window.muxivra.playerState('subtitles'))).volume,volume)
  const box=await canvas.boundingBox();await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.keyboard.down('Control');await page.keyboard.down('Shift');await page.mouse.wheel(0,100);await page.keyboard.up('Shift');await page.keyboard.up('Control')
  await page.waitForFunction(()=>Number(document.querySelector('.audio-timeline')?.dataset.gain)<32);assert.equal(await timeline.getAttribute('data-duration-ms'),'15000')
  await page.getByRole('button',{name:'重置波形',exact:true}).click();assert.equal(await timeline.getAttribute('data-gain'),'1')
  report.verticalZoom={before,after,volumePreserved:true,ctrlShiftWheel:true,reset:true}
  report.layouts=[]
  for(const [width,height] of [[1040,720],[1440,900],[1920,1080]]){
    await desktop.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setSize(...size),[width,height]);await page.waitForTimeout(200)
    const geometry=()=>page.evaluate(()=>{const box=s=>document.querySelector(s).getBoundingClientRect().toJSON(),time=document.querySelector('.subtitle-row-time');return {preview:box('.subtitle-preview-card .mpv-viewport'),list:box('.subtitle-list-card'),row:box('.subtitle-event-table tbody tr'),editor:box('.subtitle-edit-card'),times:[...time.children].map(el=>el.getBoundingClientRect().toJSON()),pageScroll:document.scrollingElement.scrollHeight-innerHeight,horizontalOverflow:document.documentElement.scrollWidth-innerWidth,trigger:box('.subtitle-preview-card .player-settings-trigger'),toolbar:box('.subtitle-preview-card .player-toolbar')}})
    const normal=await geometry();assert.ok(normal.row.height<=40,'Subtitle row should remain compact');assert.ok(Math.abs(normal.times[0].top-normal.times[2].top)<1,'Start/end must stay on one line');assert.ok(normal.pageScroll<=1&&normal.horizontalOverflow<=1);assert.ok(normal.trigger.right>=normal.toolbar.right-3,'Settings trigger should sit at the right of the control row')
    await page.getByRole('button',{name:'播放设置与列表',exact:true}).click();await page.getByRole('region',{name:'播放设置与列表',exact:true}).waitFor();await page.waitForTimeout(100)
    assert.deepEqual(await geometry(),normal,'Floating player settings must not move or resize editing panes')
    const popup=await page.getByRole('region',{name:'播放设置与列表',exact:true}).boundingBox(),windowSize=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));assert.ok(popup.x>=0&&popup.y>=0&&popup.x+popup.width<=windowSize.width+1&&popup.y+popup.height<=windowSize.height+1)
    await page.getByLabel('循环模式',{exact:true}).click();await page.keyboard.press('Escape');assert.equal(await page.getByRole('region',{name:'播放设置与列表',exact:true}).isVisible(),true,'Escape should close an inner select before its floating panel');await page.keyboard.press('Escape');assert.equal(await page.getByRole('region',{name:'播放设置与列表',exact:true}).count(),0)
    report.layouts.push({width,height,rowHeight:normal.row.height,popup})
  }
  await page.getByRole('checkbox',{name:'选择第 1 条字幕',exact:true}).check();await page.getByLabel('字幕文本',{exact:true}).fill('Transferred latest edit')
  await page.getByRole('button',{name:'转到单文件处理',exact:true}).click();await page.getByRole('heading',{name:'单文件',exact:true}).waitFor();await page.getByLabel('字幕处理方式',{exact:true}).waitFor()
  assert.equal(await page.locator('.single-layout').getByLabel('输出格式',{exact:true}).innerText(),'MKV');assert.equal(await page.locator('.single-layout').getByLabel('视频编码',{exact:true}).innerText(),'复制视频');assert.equal(await page.getByLabel('字幕处理方式',{exact:true}).innerText(),'封装为字幕轨道')
  const snapshotPath=await page.locator('.single-subtitle-card .path-text').innerText();assert.ok((await readFile(snapshotPath,'utf8')).includes('Transferred latest edit'));assert.ok((await readFile(project.subtitlePath,'utf8')).includes('Transferred latest edit'))
  const originalTrack=page.locator('.single-layout .track').filter({hasText:'字幕'}).getByRole('checkbox');assert.equal(await originalTrack.isChecked(),false);await originalTrack.check()
  await page.getByRole('button',{name:'检查处理计划',exact:true}).click();await page.getByRole('dialog',{name:'处理计划',exact:true}).waitFor();await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();await originalTrack.uncheck()
  await page.getByLabel('源文件字幕轨道',{exact:true}).click();await page.getByRole('option',{name:'保留',exact:true}).click();assert.equal(await originalTrack.isChecked(),true)
  await page.getByLabel('源文件字幕轨道',{exact:true}).click();await page.getByRole('option',{name:'不保留',exact:true}).click();assert.equal(await originalTrack.isChecked(),false)
  await page.getByRole('button',{name:'检查处理计划',exact:true}).click();await page.getByRole('dialog',{name:'处理计划',exact:true}).waitFor()
  await page.getByRole('button',{name:'开始处理',exact:true}).click();await page.getByRole('heading',{name:'任务',exact:true}).waitFor()
  await until(()=>page.evaluate(async()=>{const j=(await window.muxivra.snapshot()).jobs[0];if(j?.status==='failed')throw new Error(j.error);return j?.status==='completed'}))
  const job=await page.evaluate(async()=>{const s=await window.muxivra.snapshot();return s.jobs[0]});report.job={id:job.id,status:job.status,outputPath:job.plan.outputPath};report.files=await readdir(join(project.directory,'exports'));assert.equal(job.plan.projectId,project.id)
  const output=await page.evaluate(path=>window.muxivra.inspect(path),job.plan.outputPath);assert.ok(output.streams.some(s=>s.type==='subtitle'&&s.codec==='ass'))
  await page.locator('.navigation').getByRole('button',{name:'单文件',exact:true}).click();await page.getByLabel('字幕处理方式',{exact:true}).click();await page.getByRole('option',{name:'烧录到视频画面',exact:true}).click();assert.equal(await page.locator('.single-layout').getByLabel('视频编码',{exact:true}).innerText(),'H.264 · 软件')
  await page.getByRole('button',{name:'检查处理计划',exact:true}).click();await page.getByRole('dialog',{name:'处理计划',exact:true}).waitFor();await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click()
  report.handoff={latestEditSaved:true,snapshotIsolated:true,mkvWithAssTrack:true,projectLinked:true,burnEnablesEncoder:true,sourceSubtitleCheckboxAndKeepSwitch:true,existingSingleMediaReplaced:true};assert.deepEqual(report.errors,[])
  await page.locator('.navigation').getByRole('button',{name:'字幕编辑',exact:true}).click();await page.getByRole('button',{name:'播放设置与列表',exact:true}).click();await page.screenshot({path:'artifacts/qa/subtitle-media-controls.png',fullPage:true})
  await writeFile('artifacts/qa/subtitle-media-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}catch(error){report.failure=error.stack;report.player=await page?.evaluate(()=>window.muxivra.playerState('subtitles')).catch(()=>{});await page?.screenshot({path:'artifacts/qa/subtitle-media-failed.png',fullPage:true}).catch(()=>{});await writeFile('artifacts/qa/subtitle-media-failed.json',JSON.stringify(report,null,2));throw error}
finally{await desktop.close();const inside=relative(resolve('.test-data'),root);if(!inside||inside==='..'||inside.startsWith(`..${sep}`)||isAbsolute(inside))throw new Error('Unsafe cleanup');await rm(root,{recursive:true,force:true})}
