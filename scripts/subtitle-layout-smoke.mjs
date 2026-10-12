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
  await page.getByRole('heading',{name:'单文件',exact:true}).waitFor({timeout:60000})
  await page.locator('.navigation').getByRole('button',{name:'字幕编辑',exact:true}).click()
  await desktop.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]})},video)
  await page.getByRole('button',{name:'载入媒体',exact:true}).click()
  await page.waitForFunction(async()=>{const state=await window.muxivra.playerState('subtitles');return state.ready&&!state.loading&&state.durationMs>0&&state.videoWidth>0})
  await page.locator('.subtitle-preview-card .mpv-viewport:not(.audio-viewport)').waitFor()
  await page.getByRole('button',{name:'新增字幕',exact:true}).click()
  await page.getByLabel('字幕文本',{exact:true}).fill('布局验证字幕')
  if(process.env.MUXIVRA_LAYOUT_SOURCE_CSS){const css=await readFile('src/renderer/styles.css','utf8');await page.addStyleTag({content:css.slice(css.lastIndexOf('.subtitle-ass-editor { gap:12px; }'))})}
  for(const [width,height] of [[1040,720],[1440,900]]){
    await desktop.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows().find(window=>!window.webContents.getURL().includes('devtools'))?.setSize(size.width,size.height),{width,height})
    await page.waitForTimeout(400);await page.evaluate(()=>window.scrollTo(0,0))
    const geometry=await page.evaluate(()=>{const box=selector=>{const {top,bottom,left,right,height}=document.querySelector(selector).getBoundingClientRect();return {top,bottom,left,right,height}};return {height:innerHeight,width:innerWidth,preview:box('.subtitle-preview-card'),list:box('.subtitle-list-card'),editor:box('.subtitle-edit-card'),footer:box('.subtitle-project-card'),viewport:box('.subtitle-preview-card .mpv-viewport'),table:box('.subtitle-list-body'),row:box('.subtitle-event-table tbody tr'),volume:box('.subtitle-preview-card .player-volume')}})
    report.layouts.push(geometry)
    await page.screenshot({path:`artifacts/qa/subtitle-layout-${width}.png`,fullPage:true})
    console.log(JSON.stringify(geometry))
    assert.ok(geometry.preview.top>=0&&geometry.preview.bottom<=geometry.height,'Preview outside window')
    assert.ok(geometry.list.top<geometry.height-100&&geometry.list.bottom<=geometry.height,'Cue list not visible with editor')
    assert.ok(geometry.editor.top>=0&&geometry.editor.bottom<=geometry.height,'Edit card outside window')
    assert.ok(geometry.editor.left>=geometry.list.right-1,'Editor must sit beside the cue list')
    assert.ok(geometry.footer.top>=geometry.list.bottom-2,'Project toolbar must be below workspace')
    assert.ok(geometry.footer.bottom<=geometry.height,'Project toolbar outside window')
    assert.ok(geometry.footer.left>=0&&geometry.footer.right<=geometry.width,'Project toolbar outside horizontal workspace')
    assert.ok(geometry.viewport.height<=206,'Subtitle preview is too tall')
    assert.ok(geometry.table.height>=100,'Cue table has no usable viewport')
    assert.ok(geometry.row.bottom<=geometry.table.bottom,'The first subtitle row must remain fully visible')
    assert.ok(geometry.volume.right-geometry.volume.left>=175,'The volume control must remain long enough')
    await page.locator('.subtitle-preview-card .player-options summary').click();await page.waitForTimeout(150)
    const expanded=await page.evaluate(()=>({listBottom:document.querySelector('.subtitle-list-card').getBoundingClientRect().bottom,footerTop:document.querySelector('.subtitle-project-card').getBoundingClientRect().top,previewHeight:document.querySelector('.subtitle-preview-card').getBoundingClientRect().height,previewScrollable:document.querySelector('.subtitle-preview-card').scrollHeight>document.querySelector('.subtitle-preview-card').clientHeight}))
    assert.ok(expanded.footerTop>=expanded.listBottom-2,'Expanded player controls must not push the cue list under the toolbar')
    assert.ok(Math.abs(expanded.previewHeight-geometry.preview.height)<1,'Expanded controls must remain inside the preview card')
    assert.equal(expanded.previewScrollable,true,'Expanded player controls must be scrollable')
    report.layouts[report.layouts.length-1].expanded=expanded
    await page.locator('.subtitle-preview-card .player-options summary').click()
    await page.getByRole('button',{name:'搜索与替换',exact:true}).click();await page.waitForTimeout(100)
    const searching=await page.evaluate(()=>{const list=document.querySelector('.subtitle-list-card'),table=document.querySelector('.subtitle-list-body');return {listScrollable:list.scrollHeight>list.clientHeight,tableHeight:table.getBoundingClientRect().height,listBottom:list.getBoundingClientRect().bottom,footerTop:document.querySelector('.subtitle-project-card').getBoundingClientRect().top}})
    assert.ok(searching.tableHeight>=100,'Searching must retain a usable cue table')
    assert.ok(searching.footerTop>=searching.listBottom-2,'Searching must not overlap the project toolbar')
    await page.locator('.subtitle-list-card .task-pagination').scrollIntoViewIfNeeded()
    assert.equal(await page.getByLabel('字幕页码',{exact:true}).isVisible(),true)
    report.layouts[report.layouts.length-1].searching=searching
    await page.getByRole('button',{name:'搜索与替换',exact:true}).click()
    await page.locator('.subtitle-list-card').evaluate(element=>{element.scrollTop=0})
  }
  assert.deepEqual(report.errors,[])
  await writeFile('artifacts/qa/subtitle-layout-smoke.json',JSON.stringify(report,null,2));console.log('Subtitle layout smoke passed')
} finally {
  await desktop.close()
  const cleanup=relative(resolve('.test-data'),root)
  if(!cleanup||cleanup==='..'||cleanup.startsWith(`..${sep}`)||isAbsolute(cleanup))throw new Error('Refusing cleanup outside .test-data')
  await rm(root,{recursive:true,force:true})
}
