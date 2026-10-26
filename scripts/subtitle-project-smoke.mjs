import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir, chmod, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'

// Keep every media, project, export and profile under one isolated workspace.
// This suite never opens a user's project or uses the application's normal profile.
const exec=promisify(execFile)
await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const root=await mkdtemp(resolve('.test-data','subtitle-project-')),profile=join(root,'profile'),engines=join(root,'engines')
const video=join(root,'字幕视频.mp4'),audio=join(root,'existing-audio.wav'),project=join(root,'字幕视频.ass'),existing=join(root,'existing-audio.ass'),srt=join(root,'source.srt'),ssa=join(root,'legacy.ssa'),largeSrt=join(root,'large.srt')
const exportedAss=join(root,'exported.ass'),exportedSrt=join(root,'exported.srt'),exportedSsa=join(root,'exported.ssa'),conflictCopy=join(root,'conflict-copy.ass')
const deleteVideo=join(root,'delete-project.mp4'),deleteAss=join(root,'delete-project.ass')
await exec('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=480x270:rate=24','-f','lavfi','-i','sine=frequency=440','-t','8','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',video],{windowsHide:true})
await copyFile(video,deleteVideo)
await exec('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=660','-t','4',audio],{windowsHide:true})
await writeFile(srt,'1\r\n00:00:00,123 --> 00:00:01,234\r\n第一行\r\nSecond line\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,000\r\n第二条\r\n')
const srtTime=ms=>`${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`
await writeFile(largeSrt,Array.from({length:10000},(_,i)=>`${i+1}\r\n${srtTime(i*1000)} --> ${srtTime(i*1000+800)}\r\n字幕 ${i+1}\r\n`).join('\r\n'))
const assFixture=`[Script Info]
Title: Existing ASS fixture
ScriptType: v4.00+
PlayResX: 480
PlayResY: 270
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,12,12,16,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 2,0:00:00.00,0:00:02.00,Default,Narrator,0,0,0,,{\\i1}已有字幕, 含逗号\\N第二行{\\i0}
Comment: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,保留注释

[Muxivra Fixture]
Unrecognized: preserve this field
`
await writeFile(existing,assFixture)
await writeFile(ssa,`[Script Info]
Title: SSA input
ScriptType: v4.00
PlayResX: 480
PlayResY: 270

[V4 Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding
Style: Default,Arial,24,16777215,255,0,0,0,0,1,2,0,2,10,10,10,0,1

[Events]
Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: Marked=0,0:00:00.00,0:00:02.00,Default,,0,0,0,,SSA 导入验证\\N第二行
`)
const digest=async path=>createHash('sha256').update(await readFile(path)).digest('hex')
const protectedSources=await Promise.all([video,deleteVideo,audio,srt,ssa,largeSrt].map(async path=>({path,sha256:await digest(path)})))
const launch=()=>electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE||electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_DATA_PATH:profile,MUXIVRA_ENGINE_PATH:engines},timeout:60000})
let desktop=await launch(),page,originalClipboard
const errors=[],report={executable:process.env.MUXIVRA_EXECUTABLE||'development build',errors}
async function poll(read,check,description,timeout=15000){const deadline=Date.now()+timeout;let current;while(Date.now()<deadline){current=await read();if(check(current))return current;await page.waitForTimeout(100)}throw new Error(`${description}: ${JSON.stringify(current)}`)}
async function fileContains(path,text,timeout=15000){return poll(()=>readFile(path,'utf8').catch(()=>''),value=>value.includes(text),`File did not contain ${text}`,timeout)}
async function currentDocument(){return page.evaluate(()=>window.muxivra.getSession())}
async function projectState(){return page.evaluate(()=>window.muxivra.getSubtitleProjectState())}
async function selectFile(path){await desktop.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]})},path)}
async function saveDestination(path){await desktop.evaluate(({dialog},path)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:path})},path)}
async function openEditor(){page=await desktop.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.getByRole('heading',{name:'视频处理',exact:true}).waitFor({timeout:60000});await page.locator('.navigation').getByRole('button',{name:'字幕编辑',exact:true}).click()}
async function waitPlayer(){return poll(()=>page.evaluate(()=>window.muxivra.playerState('subtitles')),state=>state.ready&&!state.loading&&!!state.path,'Subtitle mpv readiness')}
async function screenshot(name){await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:`artifacts/qa/${name}.png`,fullPage:true})}
async function verifyEditorLayout(){
  await page.evaluate(()=>window.scrollTo(0,0))
  const geometry=await page.evaluate(()=>{
    const box=selector=>{const {top,bottom,left,right,height}=document.querySelector(selector).getBoundingClientRect();return {top,bottom,left,right,height}}
    return {height:innerHeight,preview:box('.subtitle-preview-card'),list:box('.subtitle-list-card'),editor:box('.subtitle-edit-card'),footer:box('.subtitle-project-card'),viewport:box('.subtitle-preview-card .mpv-viewport'),table:document.querySelector('.subtitle-event-table')?box('.subtitle-event-table'):undefined}
  })
  assert.ok(geometry.preview.top>=0&&geometry.preview.bottom<=geometry.height,'Preview outside window')
  assert.ok(geometry.list.top<geometry.height-100&&geometry.list.bottom<=geometry.height,'Cue list not visible with editor')
  assert.ok(geometry.editor.top>=0&&geometry.editor.bottom<=geometry.height,'Edit card outside window')
  assert.ok(geometry.editor.left>=geometry.list.right-1,'Editor must sit beside the cue list')
  assert.ok(geometry.footer.top>=geometry.list.bottom-2,'Project toolbar must be below workspace')
  assert.ok(geometry.footer.bottom<=geometry.height,'Project toolbar must fit inside the window')
  assert.ok(geometry.viewport.height<=206,'Subtitle preview is too tall')
  if(geometry.table)assert.ok(geometry.table.height>=100,'Cue table must retain a usable scrollable area')
  return geometry
}
async function chooseFormat(format){await page.getByRole('combobox',{name:'导出格式',exact:true}).click();await page.locator(`[role="option"][data-value="${format}"]`).click()}
async function saveProject(){await page.getByRole('button',{name:'保存工程',exact:true}).click();await poll(projectState,state=>!state.saving&&!state.dirty&&!state.error,'Project save')}
async function loadMedia(path){await selectFile(path);const button=page.getByRole('button',{name:'载入媒体',exact:true});await button.click();await poll(()=>button.isEnabled(),value=>value,'Media import complete');await poll(currentDocument,doc=>doc?.mediaPath===path,'Media project');await waitPlayer()}
async function importSubtitle(path){await selectFile(path);const button=page.getByRole('button',{name:'导入字幕',exact:true});await button.click();await poll(()=>button.isEnabled(),value=>value,'Subtitle import complete');await poll(currentDocument,doc=>doc?.sourcePath===path,'Subtitle import')}

try{
  await openEditor()
  originalClipboard=await page.evaluate(()=>window.muxivra.readClipboardText())
  report.appVersion=await desktop.evaluate(({app})=>app.getVersion())
  const initial=await page.evaluate(()=>window.muxivra.snapshot());await page.evaluate(settings=>window.muxivra.saveSettings(settings),{...initial.settings,theme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark')
  // GUI steps are intentionally explicit. API observations only read persisted
  // state or player state; editing and file conversion must use the real UI.
  await selectFile(video)
  await page.getByRole('button',{name:'载入媒体',exact:true}).click()
  await fileContains(project,'[Script Info]')
  assert.ok((await readFile(project,'utf8')).includes('[V4+ Styles]'))
  await waitPlayer();report.mediaImportCreatesSameDirectoryAssImmediately=true

  await page.getByRole('button',{name:'新增字幕',exact:true}).click()
  await poll(currentDocument,doc=>doc?.cues.length===1,'New cue recovery cache')
  const newCue=page.getByRole('button',{name:'新增字幕',exact:true})
  const pausedBefore=(await page.evaluate(()=>window.muxivra.playerState('subtitles'))).paused
  await newCue.press('Space');await poll(()=>page.evaluate(()=>window.muxivra.playerState('subtitles')),state=>state.paused!==pausedBefore,'Space after focused New cue')
  await newCue.press('Space');await poll(()=>page.evaluate(()=>window.muxivra.playerState('subtitles')),state=>state.paused===pausedBefore,'Space toggles back after focused New cue')
  assert.equal((await currentDocument()).cues.length,1,'Space should play/pause without clicking New cue again')
  const seek=page.getByLabel('播放进度',{exact:true})
  await seek.fill('1500');await seek.dispatchEvent('pointerup')
  await poll(()=>page.evaluate(()=>window.muxivra.playerState('subtitles')),state=>Math.abs(state.positionMs-1500)<150&&state.paused,'Seek for Q default')
  await newCue.press('q');await poll(currentDocument,doc=>Math.abs(doc?.cues[0]?.startMs-1500)<150,'Q sets subtitle start from focused button')
  await seek.fill('2500');await seek.dispatchEvent('pointerup')
  await poll(()=>page.evaluate(()=>window.muxivra.playerState('subtitles')),state=>Math.abs(state.positionMs-2500)<150&&state.paused,'Seek for E default')
  await newCue.press('e');await poll(currentDocument,doc=>Math.abs(doc?.cues[0]?.endMs-2500)<150,'E sets subtitle end from focused button')
  await page.getByLabel('字幕文本',{exact:true}).focus();await page.keyboard.press('Space')
  assert.equal((await page.evaluate(()=>window.muxivra.playerState('subtitles'))).paused,true,'Text editing must not toggle playback')
  report.pageShortcutsAfterButtonFocusAndTextEditorExclusion=true
  await page.locator('.navigation').getByRole('button',{name:'设置',exact:true}).click()
  await page.getByRole('heading',{name:'设置',exact:true}).waitFor()
  await page.locator('.navigation').getByRole('button',{name:'设置',exact:true}).press('Space')
  assert.equal((await page.evaluate(()=>window.muxivra.playerState('subtitles'))).paused,true,'Hidden subtitle page must not respond to player shortcuts')
  await page.locator('.navigation').getByRole('button',{name:'字幕编辑',exact:true}).click()
  report.shortcutsFollowActivePage=true
  await page.getByLabel('字幕文本',{exact:true}).fill('{\\i1}第一行, 验证字幕{\\i0}\nSecond line')
  await page.getByLabel('结束时间',{exact:true}).fill('00:00:02,500');await page.getByLabel('结束时间',{exact:true}).press('Enter')
  const beforeStyles=await page.evaluate(()=>window.muxivra.playerState('subtitles'))
  assert.ok(beforeStyles.positionMs>1000&&beforeStyles.paused)
  await page.getByRole('button',{name:'样式与脚本设置',exact:true}).click()
  await page.getByLabel('字号',{exact:true}).fill('40')
  await page.getByLabel('文字颜色',{exact:true}).fill('#ffcc44')
  await screenshot('subtitle-styles-dark')
  await page.getByRole('button',{name:'返回字幕编辑',exact:true}).click()
  const afterStyles=await poll(()=>page.evaluate(()=>window.muxivra.playerState('subtitles')),state=>state.ready&&!state.loading,'Player after returning from styles')
  assert.ok(Math.abs(afterStyles.positionMs-beforeStyles.positionMs)<=200,'Styles return must retain playback position')
  assert.equal(afterStyles.paused,beforeStyles.paused);assert.deepEqual(afterStyles.playlist,beforeStyles.playlist)
  report.styleSecondaryReturnPreservesPlayerPositionAndPlaylist=true
  await poll(currentDocument,doc=>doc?.cues[0]?.text.includes('Second line')&&doc.styles?.find(s=>s.name==='Default')?.fontSize===40,'Multiline and style edit')
  const preview=await poll(()=>page.evaluate(()=>window.muxivra.playerState('subtitles')),state=>state.tracks.filter(t=>t.type==='sub'&&t.external).length===1,'ASS preview')
  const previewPath=preview.tracks.find(t=>t.type==='sub'&&t.external)['external-filename']
  assert.ok(previewPath?.endsWith('.ass'),'Editor preview must use ASS')
  await fileContains(previewPath,'Second line');const previewContents=await readFile(previewPath,'utf8')
  assert.ok(previewContents.includes('\\NSecond line'));assert.ok(/Style: Default,Arial,40,/.test(previewContents));report.assMultilineAndStylePreview=true

  await desktop.evaluate(({ipcMain})=>{const key='muxivra:saveSubtitleProject',original=ipcMain._invokeHandlers.get(key);ipcMain.removeHandler(key);ipcMain.handle(key,async(event,...args)=>{await new Promise(r=>setTimeout(r,650));return original(event,...args)})})
  await page.getByRole('button',{name:'保存工程',exact:true}).click()
  const saving=page.getByRole('button',{name:/保存中/}).first();await saving.waitFor();assert.equal(await saving.getAttribute('aria-busy'),'true');assert.equal(await saving.isDisabled(),true)
  await poll(projectState,state=>!state.saving&&!state.dirty&&!state.error,'Manual save');report.manualSaveAndVisibleLoading=true
  const manualContents=await readFile(project,'utf8')
  assert.ok(manualContents.includes('\\NSecond line'));assert.ok(manualContents.includes('{\\i1}'))
  const manualDoc=await currentDocument();assert.equal(manualDoc.projectPath,project);assert.equal(manualDoc.format,'ass')

  // The application's real 60-second main-process timer runs unchanged. This
  // deliberately waits for the actual project file instead of advancing only
  // Date.now or calling manual save and mistaking that for an autosave.
  await page.getByLabel('字幕文本',{exact:true}).fill('60 秒周期保存验证\nSecond line')
  await poll(projectState,state=>state.dirty,'Dirty project before autosave')
  console.log('Checking the real 60-second subtitle autosave interval…')
  await fileContains(project,'60 秒周期保存验证',65000)
  const periodicState=await poll(projectState,state=>!state.saving&&!state.dirty&&!state.error&&!!state.backupPath,'Periodic autosave state')
  assert.equal(await readFile(periodicState.backupPath,'utf8'),manualContents)
  report.realSixtySecondAutosaveAndPreviousVersionBackup=true

  await chooseFormat('srt')
  assert.equal(await page.getByLabel('图层',{exact:true}).isDisabled(),true)
  assert.equal(await page.getByRole('button',{name:'样式与脚本设置',exact:true}).isDisabled(),true)
  await saveDestination(exportedSrt)
  await page.getByRole('button',{name:'导出字幕',exact:true}).click()
  const lossDialog=page.getByRole('dialog',{name:'导出 SRT',exact:true});await lossDialog.waitFor()
  assert.match(await lossDialog.innerText(),/样式/)
  await lossDialog.getByRole('button',{name:'取消',exact:true}).click()
  assert.equal(await readFile(exportedSrt,'utf8').then(()=>true).catch(()=>false),false)
  await page.getByRole('button',{name:'导出字幕',exact:true}).click();await lossDialog.waitFor();await lossDialog.getByRole('button',{name:'继续导出',exact:true}).click()
  const srtContents=await fileContains(exportedSrt,'60 秒周期保存验证')
  assert.ok(srtContents.includes('Second line'));assert.ok(!srtContents.includes('Style:'));assert.ok(!srtContents.includes('{\\'))
  assert.ok((await readFile(project,'utf8')).includes('Style: Default,Arial,40,'));report.srtRestrictionsAndConfirmedDowngradePreserveAssProject=true
  await chooseFormat('ass');await saveDestination(exportedAss);await page.getByRole('button',{name:'导出字幕',exact:true}).click()
  await fileContains(exportedAss,'[V4+ Styles]');await saveProject();await screenshot('subtitle-project-dark')

  await desktop.close();desktop=await launch();await openEditor()
  const restored=await poll(currentDocument,doc=>doc?.projectPath===project&&doc?.cues[0]?.text.includes('60 秒周期保存验证'),'Restored subtitle project')
  const restoredPlayer=await waitPlayer();assert.equal(restored.mediaPath,video);assert.equal(restoredPlayer.path,video);report.restartRestoresProjectAndMedia=true

  // Simulate another editor changing the same ASS. A GUI save must fail while
  // the user's draft remains recoverable; Save As provides a safe next action.
  const externalContents=(await readFile(project,'utf8'))+'\r\n; edited by another application\r\n'
  await writeFile(project,externalContents)
  await page.getByLabel('字幕文本',{exact:true}).fill('外部修改后保留自己的草稿')
  await poll(projectState,state=>state.dirty,'Changed draft before conflict')
  await page.getByRole('button',{name:'保存工程',exact:true}).click()
  const conflict=await poll(projectState,state=>!!state.error&&!state.saving,'External-change save refusal')
  assert.match(conflict.error,/外部|修改|变化/);assert.equal(await readFile(project,'utf8'),externalContents);assert.equal(conflict.dirty,true)
  // Confirmed exit must retain the current recovery draft even when ASS save
  // is blocked by an external edit, without trapping the user in the app.
  await page.evaluate(()=>window.muxivra.requestExit())
  await page.getByRole('dialog',{name:'退出 Muxivra',exact:true}).waitFor()
  const closed=desktop.waitForEvent('close');await page.getByRole('button',{name:'退出应用',exact:true}).click();await closed
  assert.equal(await readFile(project,'utf8'),externalContents)
  desktop=await launch();await openEditor()
  await poll(currentDocument,doc=>doc?.cues[0]?.text==='外部修改后保留自己的草稿','Conflict draft after confirmed exit')
  assert.equal((await projectState()).recoveryPending,true);report.confirmedExitDuringConflictRetainsDraftAndExternalFile=true
  await saveDestination(conflictCopy);await page.getByRole('button',{name:'工程另存为',exact:true}).click()
  await fileContains(conflictCopy,'外部修改后保留自己的草稿');assert.equal(await readFile(project,'utf8'),externalContents)
  await poll(projectState,state=>state.projectPath===conflictCopy&&!state.error&&!state.dirty,'Conflict copy saved');report.externalChangesCannotBeOverwrittenAndSaveAsWorks=true
  await page.getByLabel('字幕文本',{exact:true}).fill('另存后撤销验证');await poll(currentDocument,doc=>doc.cues[0].text==='另存后撤销验证','Edit after save-as')
  await page.getByRole('button',{name:'撤销',exact:true}).click();await poll(currentDocument,doc=>doc.cues[0].text==='外部修改后保留自己的草稿'&&doc.projectPath===conflictCopy,'Undo stays in new project')
  await saveProject();report.undoAfterSaveAsKeepsNewProjectPath=true

  const existingHash=await digest(existing)
  await chmod(existing,0o444)
  try{
    await desktop.evaluate(({dialog})=>{dialog.showSaveDialog=async()=>({canceled:true})})
    await selectFile(audio);await page.getByRole('button',{name:'载入媒体',exact:true}).click();await page.getByRole('button',{name:'载入媒体',exact:true}).waitFor()
    assert.equal((await currentDocument()).projectPath,conflictCopy);assert.equal(await digest(existing),existingHash)
    const writableCopy=join(root,'read-only-copy.ass');await saveDestination(writableCopy);await loadMedia(audio)
    assert.equal((await currentDocument()).projectPath,writableCopy);assert.ok((await readFile(writableCopy,'utf8')).includes('已有字幕'));assert.equal(await digest(existing),existingHash)
    report.readOnlyProjectChooseLocationAndCancelPreserveOriginal=true
  }finally{await chmod(existing,0o666)}
  await loadMedia(audio);const existingDoc=await currentDocument()
  assert.equal(existingDoc.projectPath,existing);assert.ok(existingDoc.cues.some(c=>c.text.includes('已有字幕, 含逗号')));assert.ok(existingDoc.cues.some(c=>c.comment));assert.equal(await digest(existing),existingHash)
  assert.ok(existingDoc.sections.some(section=>section.name==='Muxivra Fixture'));report.existingSameNameAssLoadedWithoutOverwriting=true
  assert.equal(await page.getByRole('button',{name:'删除工程',exact:true}).isDisabled(),true);report.originalAssDeletionDisabled=true
  await page.locator('[data-cue-id]').first().click();await page.getByLabel('字幕文本',{exact:true}).fill('已有工程保存验证\n第二行')
  await saveProject();const existingState=await projectState();assert.equal(await readFile(existingState.backupPath,'utf8'),assFixture)
  assert.ok((await readFile(existing,'utf8')).includes('Unrecognized: preserve this field'));report.existingAssUnknownSectionsAndOriginalBackupPreserved=true

  await importSubtitle(ssa);let imported=await currentDocument()
  assert.equal(imported.format,'ass');assert.ok(imported.cues[0].text.includes('SSA 导入验证'));assert.ok(imported.cues[0].text.includes('\n第二行'));assert.ok(imported.projectPath.endsWith('.ass'))
  await chooseFormat('ssa');await saveDestination(exportedSsa);await page.getByRole('button',{name:'导出字幕',exact:true}).click()
  // SSA export may offer a loss notice for ASS-only properties. If present,
  // explicit confirmation is required before the save dialog can be used.
  const ssaDialog=page.getByRole('dialog',{name:'导出 SSA',exact:true})
  if(await ssaDialog.waitFor({timeout:1200}).then(()=>true).catch(()=>false))await ssaDialog.getByRole('button',{name:'继续导出',exact:true}).click()
  const ssaContents=await fileContains(exportedSsa,'SSA 导入验证');assert.ok(ssaContents.includes('[V4 Styles]'));assert.ok(!ssaContents.includes('[V4+ Styles]'));await saveProject();report.ssaImportedIntoAssAndExported=true

  await importSubtitle(srt);imported=await currentDocument()
  assert.equal(imported.format,'ass');assert.equal(imported.cues[0].startMs,123);assert.equal(imported.cues[0].endMs,1234);assert.equal(imported.cues[0].text,'第一行\nSecond line');assert.ok(imported.projectPath.endsWith('.ass'))
  await page.locator('[data-cue-id]').first().click();await page.getByRole('button',{name:'复制条目',exact:true}).click();await page.getByRole('button',{name:'粘贴条目',exact:true}).click()
  await poll(currentDocument,doc=>doc.cues.length===3,'Copied cue inserted with new ID')
  const pasted=await currentDocument();assert.equal(new Set(pasted.cues.map(c=>c.id)).size,3)
  await page.getByRole('button',{name:'撤销',exact:true}).click();await poll(currentDocument,doc=>doc.cues.length===2,'Paste undo')
  await page.evaluate(()=>window.muxivra.copyText('MUXIVRA_SUBTITLE_CUES_V2\n[{"id":"bad","startMs":-1,"endMs":0,"text":null}]'))
  await page.getByRole('button',{name:'粘贴条目',exact:true}).click();await page.locator('.toast-error').waitFor()
  assert.equal((await currentDocument()).cues.length,2);await page.locator('.toast').getByRole('button').click();report.invalidClipboardCannotChangeProject=true
  await page.getByRole('button',{name:'搜索与替换',exact:true}).click();await page.getByLabel('搜索文本',{exact:true}).fill('第一行');await page.getByLabel('替换文本',{exact:true}).fill('替换后的第一行');await page.getByRole('button',{name:'替换全部',exact:true}).click()
  await poll(currentDocument,doc=>doc.cues[0].text.startsWith('替换后的第一行'),'Search replace')
  await page.getByRole('button',{name:'撤销',exact:true}).click();await poll(currentDocument,doc=>doc.cues[0].text==='第一行\nSecond line','Replace undo');await page.getByRole('button',{name:'关闭搜索',exact:true}).click();report.srtMillisecondImportCopyPasteAndBatchUndo=true
  await saveProject()

  await importSubtitle(largeSrt);await poll(currentDocument,doc=>doc.cues.length===10000,'Ten-thousand-cue import')
  assert.ok(await page.locator('[data-cue-id]').count()<=50,'Large project rendered more than one page')
  await page.getByLabel('字幕页码',{exact:true}).fill('200');await page.getByLabel('字幕页码',{exact:true}).press('Enter')
  await page.locator('[data-cue-id]').getByText('字幕 10000',{exact:true}).waitFor();assert.ok(await page.locator('[data-cue-id]').count()<=50)
  await page.locator('[data-cue-id]').last().click();await page.getByLabel('字幕文本',{exact:true}).fill('末页实时编辑验证')
  await poll(currentDocument,doc=>doc.cues.at(-1).text==='末页实时编辑验证','Last page live edit');await saveProject();report.tenThousandCuesUseFiftyRowsPerPageWithDirectPageNavigation=true

  const snapshot=await page.evaluate(()=>window.muxivra.snapshot());await page.evaluate(settings=>window.muxivra.saveSettings(settings),{...snapshot.settings,theme:'light'})
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');await screenshot('subtitle-project-light')
  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:1040,height:720}))
  await page.waitForTimeout(200);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth));report.minimumEditorLayout=await verifyEditorLayout();await screenshot('subtitle-project-minimum');report.darkLightAndMinimumWindowNoOverflow=true
  await chooseFormat('ass');await page.getByRole('button',{name:'样式与脚本设置',exact:true}).click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth));await screenshot('subtitle-styles-minimum');await page.getByRole('button',{name:'返回字幕编辑',exact:true}).click();await saveProject();report.styleSecondaryPageAtMinimumWindowNoOverflow=true
  const backupKey=createHash('sha256').update(existingDoc.id).digest('hex').slice(0,32),backups=await readdir(join(profile,'subtitle-backups',backupKey));assert.ok(backups.length<=20);report.backupRetentionWithinTwenty=true

  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:1440,height:900}));await page.waitForTimeout(200)
  await loadMedia(deleteVideo);report.normalEditorLayout=await verifyEditorLayout()
  await desktop.evaluate(({ipcMain})=>{const key='muxivra:deleteSubtitleProject',original=ipcMain._invokeHandlers.get(key);ipcMain.removeHandler(key);ipcMain.handle(key,async(event,...args)=>{await new Promise(r=>setTimeout(r,650));return original(event,...args)})})
  await page.getByRole('button',{name:'删除工程',exact:true}).click();const deleteDialog=page.getByRole('dialog',{name:'删除临时 ASS 工程？',exact:true});await deleteDialog.waitFor()
  await deleteDialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await readFile(deleteAss,'utf8').then(()=>true),true)
  const deletedId=(await currentDocument()).id
  await page.getByRole('button',{name:'删除工程',exact:true}).click();await deleteDialog.getByRole('button',{name:'删除工程',exact:true}).click()
  const deleting=deleteDialog.getByRole('button',{name:/删除工程中/});await deleting.waitFor();assert.equal(await deleting.getAttribute('aria-busy'),'true')
  await poll(currentDocument,doc=>doc.id!==deletedId&&!doc.projectPath&&doc.cues.length===0,'Deleted project reset')
  assert.equal(await readFile(deleteAss,'utf8').then(()=>true).catch(()=>false),false);assert.ok((await readFile(existing,'utf8')).includes('已有工程保存验证'))
  await desktop.close();desktop=await launch();await openEditor();await poll(currentDocument,doc=>doc&&!doc.projectPath&&doc.cues.length===0,'Deleted project remains cleared after restart')
  assert.equal(await readFile(deleteAss,'utf8').then(()=>true).catch(()=>false),false);report.deleteProjectConfirmLoadingSourceProtectionAndNoRestartRevival=true

  for(const source of protectedSources)assert.equal(await digest(source.path),source.sha256,`Source file changed: ${source.path}`)
  report.sourceFilesUnchanged=true
  assert.deepEqual(errors,[])
  await writeFile('artifacts/qa/subtitle-project-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}finally{
  if(originalClipboard!==undefined)await page.evaluate(text=>window.muxivra.copyText(text),originalClipboard).catch(()=>{})
  await desktop.close()
  const local=relative(resolve('.test-data'),root)
  if(local&&!local.startsWith('..'+sep)&&!isAbsolute(local))await rm(root,{recursive:true,force:true})
}
