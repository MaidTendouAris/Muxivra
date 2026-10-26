import { createProject } from './gui-projects.mjs'
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { mkdir, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'

const exec=promisify(execFile)
await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const root=await mkdtemp(resolve('.test-data','subtitle-layout-')),video=join(root,'layout.mp4')
await exec('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=480x270:rate=24','-f','lavfi','-i','sine=frequency=440','-t','4','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',video],{windowsHide:true})
const desktop=await electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE||electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_DATA_PATH:join(root,'profile'),MUXIVRA_ENGINE_PATH:join(root,'engines')},timeout:60000})
const report={executable:process.env.MUXIVRA_EXECUTABLE||'development build',errors:[],layouts:[]}
try {
  const page=await desktop.firstWindow();page.on('pageerror',error=>report.errors.push(error.message))
  report.appVersion=await desktop.evaluate(({app})=>app.getVersion())
  await page.getByRole('heading',{name:'视频处理',exact:true}).waitFor({timeout:60000})
  await page.locator('.navigation').getByRole('button',{name:'字幕编辑',exact:true}).click()
  await desktop.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]})},video)
  await createProject(page,desktop,video)
  const until=async(check)=>{const end=Date.now()+30000;while(Date.now()<end){if(await check())return;await page.waitForTimeout(40)}throw new Error('Subtitle layout state timed out')}
  await until(()=>page.evaluate(async()=>{const state=await window.muxivra.playerState('subtitles');return state.ready&&!state.loading&&state.durationMs>0&&state.videoWidth>0}))
  await page.locator('.subtitle-preview-card .mpv-viewport:not(.audio-viewport)').waitFor()
  await page.getByRole('button',{name:'新增字幕',exact:true}).click()
  await page.getByLabel('字幕文本',{exact:true}).fill('布局验证字幕')
  if(process.env.MUXIVRA_LAYOUT_SOURCE_CSS){const css=await readFile('src/renderer/styles.css','utf8');await page.addStyleTag({content:css.slice(css.lastIndexOf('.subtitle-ass-editor { gap:12px; }'))})}
  for(const [width,height] of [[1040,720],[1440,900],[1920,1080],[2560,1440]]){
    await desktop.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows().find(window=>!window.webContents.getURL().includes('devtools'))?.setSize(size.width,size.height),{width,height})
    await page.waitForTimeout(400);await page.evaluate(()=>window.scrollTo(0,0))
    const geometry=await page.evaluate(()=>{const box=selector=>{const {top,bottom,left,right,height,width}=document.querySelector(selector).getBoundingClientRect();return {top,bottom,left,right,height,width}};return {height:innerHeight,width:innerWidth,preview:box('.subtitle-preview-card'),list:box('.subtitle-list-card'),editor:box('.subtitle-edit-card'),footer:box('.subtitle-project-card'),viewport:box('.subtitle-preview-card .mpv-viewport'),table:box('.subtitle-list-body'),row:box('.subtitle-event-table tbody tr'),volume:box('.subtitle-preview-card .player-volume')}})
    report.layouts.push(geometry)
    await page.screenshot({path:`artifacts/qa/subtitle-layout-${width}.png`,fullPage:true})
    console.log(JSON.stringify(geometry))
    assert.ok(geometry.preview.top>=0&&geometry.preview.bottom<=geometry.height,'Preview outside window')
    assert.ok(geometry.list.height>=240&&geometry.table.height>=110,'Cue list has insufficient editing space')
    assert.ok(geometry.editor.top>=0,'Edit card starts outside window')
    assert.ok(geometry.editor.left>=geometry.list.right-1,'Editor must sit beside the cue list')
    assert.ok(await page.evaluate(()=>document.scrollingElement.scrollHeight<=innerHeight+1),'Subtitle page must fit the viewport without page scrolling');assert.ok(geometry.list.bottom<=geometry.height-10,'Cue list extends outside the window');assert.ok(geometry.footer.left>=geometry.list.right+10,'Collapsed project toolbar must stay entirely in the right column');assert.ok(geometry.editor.bottom<=geometry.footer.top-10,'Project toolbar overlaps the editor')
    assert.ok(geometry.footer.bottom<=geometry.height,'Project toolbar outside window')
    assert.ok(geometry.footer.left>=0&&geometry.footer.right<=geometry.width,'Project toolbar outside horizontal workspace')
    assert.ok(Math.abs(geometry.viewport.width/geometry.viewport.height-16/9)<.01,'The 16:9 preview has the wrong aspect ratio')
    assert.ok(geometry.viewport.bottom<geometry.preview.bottom-50,'Preview must leave room for player controls')
    if(height>=1080)assert.ok(geometry.viewport.height>240,'Large windows still use the old small preview height')
    assert.ok(geometry.table.height>=100,'Cue table has no usable viewport')
    assert.ok(geometry.row.bottom<=geometry.table.bottom,'The first subtitle row must remain fully visible')
    assert.ok(geometry.volume.right-geometry.volume.left>=175,'The volume control must remain long enough')
    await page.getByRole('button',{name:'播放设置与列表',exact:true}).click();await page.waitForTimeout(150)
    const expanded=await page.evaluate(()=>({listBottom:document.querySelector('.subtitle-list-card').getBoundingClientRect().bottom,footerTop:document.querySelector('.subtitle-project-card').getBoundingClientRect().top,previewHeight:document.querySelector('.subtitle-preview-card').getBoundingClientRect().height,previewScrollable:document.querySelector('.subtitle-preview-card').scrollHeight>document.querySelector('.subtitle-preview-card').clientHeight}))
    assert.ok(expanded.footerTop<geometry.height,'Project toolbar must stay accessible')
    assert.ok(Math.abs(expanded.previewHeight-geometry.preview.height)<1,'Expanded controls must remain inside the preview card')
    assert.equal(expanded.previewScrollable,false,'Floating player controls must not introduce preview scrolling')
    report.layouts[report.layouts.length-1].expanded=expanded
    await page.getByRole('button',{name:'播放设置与列表',exact:true}).click()
    await page.getByRole('button',{name:'搜索与替换',exact:true}).click();await page.waitForTimeout(100)
    const searching=await page.evaluate(()=>{const list=document.querySelector('.subtitle-list-card'),table=document.querySelector('.subtitle-list-body');return {listScrollable:list.scrollHeight>list.clientHeight,tableHeight:table.getBoundingClientRect().height,listBottom:list.getBoundingClientRect().bottom,footerTop:document.querySelector('.subtitle-project-card').getBoundingClientRect().top}})
    assert.ok(searching.tableHeight>=100,'Searching must retain a usable cue table')
    assert.ok(searching.footerTop<geometry.height,'Search must retain access to the project toolbar')
    await page.locator('.subtitle-list-card .task-pagination').scrollIntoViewIfNeeded()
    assert.equal(await page.getByLabel('字幕页码',{exact:true}).isVisible(),true)
    report.layouts[report.layouts.length-1].searching=searching
    await page.getByRole('button',{name:'搜索与替换',exact:true}).click()
    await page.locator('.subtitle-list-card').evaluate(element=>{element.scrollTop=0})
    await page.getByRole('button',{name:'展开工程栏',exact:true}).click();await page.waitForTimeout(150)
    const dockOpen=await page.evaluate(()=>{const box=s=>document.querySelector(s).getBoundingClientRect().toJSON();return {list:box('.subtitle-list-card'),preview:box('.subtitle-preview-card'),dock:box('.subtitle-project-card'),editor:box('.subtitle-edit-card'),scrollHeight:document.scrollingElement.scrollHeight,height:innerHeight}})
    assert.ok(dockOpen.dock.left<=dockOpen.list.left+1&&dockOpen.dock.right>=dockOpen.editor.right-1,'Expanded project toolbar must span the workspace')
    assert.ok(Math.abs(dockOpen.list.top-geometry.list.top)<1&&Math.abs(dockOpen.list.height-geometry.list.height)<1&&Math.abs(dockOpen.editor.height-geometry.editor.height)<1&&Math.abs(dockOpen.preview.height-geometry.preview.height)<1,'Expanded project toolbar must float without rearranging editing panes')
    assert.ok(dockOpen.scrollHeight<=dockOpen.height+1,'Expanding the project toolbar must not introduce page scrolling')
    report.layouts.at(-1).dockOpen=dockOpen
    await page.getByRole('button',{name:'收起工程栏',exact:true}).click();await page.waitForTimeout(100)
    await page.evaluate(()=>window.scrollTo(0,500));assert.equal(await page.evaluate(()=>scrollY),0)
    await page.locator('.subtitle-preview-card').evaluate(e=>e.scrollTop=0)

  }
  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1040,720));await page.waitForTimeout(200)
  await page.getByRole('button',{name:'展开工程栏',exact:true}).click()
  await page.getByLabel('编辑模式',{exact:true}).click();await page.getByRole('option',{name:'SRT',exact:true}).click()
  await page.getByRole('button',{name:'收起工程栏',exact:true}).click();await page.waitForTimeout(150)
  report.srtLayout=await page.evaluate(()=>({scrollHeight:document.scrollingElement.scrollHeight,height:innerHeight,tableHeight:document.querySelector('.subtitle-list-body').clientHeight,note:document.querySelector('.subtitle-format-note').getBoundingClientRect().toJSON(),list:document.querySelector('.subtitle-list-card').getBoundingClientRect().toJSON()}))
  assert.ok(report.srtLayout.scrollHeight<=report.srtLayout.height+1&&report.srtLayout.tableHeight>=90,'SRT note must fit without page scrolling or hiding the cue table')
  await page.getByRole('button',{name:'展开工程栏',exact:true}).click();await page.getByLabel('编辑模式',{exact:true}).click();await page.getByRole('option',{name:'ASS',exact:true}).click();await page.getByRole('button',{name:'收起工程栏',exact:true}).click()
  await page.evaluate(()=>window.muxivra.playerAction('subtitles',{type:'seek',positionMs:1200}));await page.waitForTimeout(150)
  const beforeStyles=await page.evaluate(()=>window.muxivra.playerState('subtitles'))
  await page.getByRole('button',{name:'样式与脚本设置',exact:true}).click();await page.waitForTimeout(100)
  assert.ok(await page.evaluate(()=>document.scrollingElement.scrollHeight<=innerHeight+1),'Style editor must use internal scrolling')
  await page.getByRole('button',{name:'返回字幕编辑',exact:true}).click();await page.waitForTimeout(150)
  const afterStyles=await page.evaluate(()=>window.muxivra.playerState('subtitles'))
  assert.equal(afterStyles.path,beforeStyles.path);assert.ok(Math.abs(afterStyles.positionMs-beforeStyles.positionMs)<45,'Returning from styles must preserve playback position')
  report.styleReturn={positionMs:afterStyles.positionMs,paused:afterStyles.paused,internalScroll:true}
  assert.deepEqual(report.errors,[])

  await writeFile('artifacts/qa/subtitle-layout-smoke.json',JSON.stringify(report,null,2));console.log('Subtitle layout smoke passed')
} finally {
  await desktop.close()
  const cleanup=relative(resolve('.test-data'),root)
  if(!cleanup||cleanup==='..'||cleanup.startsWith(`..${sep}`)||isAbsolute(cleanup))throw new Error('Refusing cleanup outside .test-data')
  await rm(root,{recursive:true,force:true})
}
