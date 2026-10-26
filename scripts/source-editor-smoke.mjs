import {createProject} from './gui-projects.mjs'
import {_electron as electron} from 'playwright'
import electronPath from 'electron'
import {mkdir,mkdtemp,readFile,writeFile,rm,readdir,unlink} from 'node:fs/promises'
import {join,resolve,relative,isAbsolute} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import assert from 'node:assert/strict'
await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const root=await mkdtemp(resolve('.test-data','source-editor-')),profile=join(root,'profile'),video=join(root,'sample.mp4'),subtitle=join(root,'sample.ass'),srt=join(root,'external.srt')
const ass='[Script Info]\nScriptType: v4.00+\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'+Array.from({length:90},(_,i)=>`Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\i1}Line ${i}`).join('\n')+'\n'
await writeFile(subtitle,ass);await writeFile(srt,'1\r\n00:00:00,100 --> 00:00:01,900\r\nHello\r\n')
await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=10:d=2','-c:v','libx264','-preset','ultrafast',video],{windowsHide:true})
let desktop,page,source
const report={checks:[],errors:[]}
const until=async check=>{const end=Date.now()+30000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,75))}throw new Error('Source editor state timed out')}
const watch=window=>{window.on('pageerror',error=>report.errors.push(error.message));window.on('console',message=>{if(message.type()==='error')report.errors.push(message.text())});window.on('dialog',dialog=>{void dialog.dismiss().catch(error=>{if(dialog.type()!=='beforeunload'||!/No dialog is showing|Target page, context or browser has been closed|session closed/i.test(error.message))report.errors.push(error.message)})})}
const text=async(window,value)=>{await window.locator('.monaco-editor textarea').focus();await window.keyboard.press('Control+a');await window.keyboard.insertText(value)}
const launch=async()=>{desktop=await electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE||electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_TEST_SYSTEM_LANGUAGES:'zh-CN',MUXIVRA_DATA_PATH:profile,MUXIVRA_ENGINE_PATH:join(root,'engines')},timeout:60000});page=await desktop.firstWindow();watch(page);await page.getByRole('heading',{name:'视频处理',exact:true}).waitFor({timeout:60000})}
const openSource=async path=>{const newWindow=desktop.waitForEvent('window');await page.evaluate(path=>window.muxivra.openSourceEditor({path}),path);const window=await newWindow;watch(window);await window.getByTestId('source-save-status').getByText('已保存',{exact:true}).waitFor({timeout:30000});return window}
try{
 await launch();const project=await createProject(page,desktop,video,{subtitle});source=await openSource(project.subtitlePath)
 assert.equal(await source.evaluate(()=>typeof window.muxivra),'undefined');assert.equal(await source.locator('.minimap canvas').count()>0,true);assert.equal(await source.locator('.view-lines .view-line').count()>0,true)
 await source.evaluate(async()=>{await window.sourceEditor.read();await new Promise(resolve=>setTimeout(resolve,200))});report.checks.push('isolated window, real Monaco highlighting and minimap')
 const edited=(await readFile(project.subtitlePath,'utf8')).replace('Line 0','Edited in source')+'; source formatting retained\r\n';await text(source,edited)
 await until(async()=> (await page.evaluate(()=>window.muxivra.getSession())).cues[0].text.includes('Edited in source'));assert.equal(await readFile(project.subtitlePath,'utf8'),edited)
 await until(()=>source.getByTestId('source-save-status').innerText().then(v=>v==='已保存'));assert.match(await page.getByLabel('字幕文本',{exact:true}).inputValue(),/Edited in source/);report.checks.push('debounced exact-source autosave and live main editor sync')
 await page.getByLabel('字幕文本',{exact:true}).fill('Changed in main');await source.locator('.monaco-editor textarea').focus();await source.keyboard.press('Control+Home');await until(()=>source.locator('.view-lines').innerText().then(v=>v.replace(/\u00a0/g,' ').includes('Changed in main')));report.checks.push('main edits refresh the clean source buffer')
 // Invalid source is recoverable and never destroys a valid project.
 const current=await readFile(project.subtitlePath,'utf8');await text(source,'[Events]\nDialogue: broken')
 await source.getByTestId('source-save-status').getByText('保存失败 · 内容仍保留',{exact:true}).waitFor();assert.equal((await page.evaluate(()=>window.muxivra.getSession())).cues.length,90);assert.equal(await readFile(project.subtitlePath,'utf8'),current)
 assert.equal((await readdir(join(profile,'source-editor-drafts'))).length,1);report.checks.push('invalid syntax retains disk document and persists recovery draft')
 await page.getByLabel('字幕文本',{exact:true}).fill('Concurrent main change');await source.getByTestId('source-save-status').getByText('同步冲突',{exact:true}).waitFor();await source.getByRole('button',{name:'重新载入',exact:true}).click();await source.locator('.monaco-editor textarea').focus();await source.keyboard.press('Control+Home');await until(()=>source.locator('.view-lines').innerText().then(v=>v.replace(/\u00a0/g,' ').includes('Concurrent main change')));report.checks.push('concurrent edits block overwrite with explicit reload')
 await source.screenshot({path:'artifacts/qa/source-editor.png',fullPage:true})
 await page.locator('.navigation').getByRole('button',{name:'项目管理',exact:true}).click();await page.getByRole('button',{name:'关闭工程',exact:true}).click();await until(()=>source.getByTestId('source-save-status').innerText().then(v=>v==='只读'));assert.match(await readFile(video,'base64'),/./);report.checks.push('project close disconnects source writes')
 // Project Management opens a project without displaying the subtitle workspace.
 await page.getByRole('button',{name:'项目文件',exact:true}).click();await until(()=>source.getByTestId('source-save-status').innerText().then(v=>v==='已保存'))
 const hiddenEdit=(await source.evaluate(()=>window.sourceEditor.read())).text.replace('Concurrent main change','Hidden source change');await text(source,hiddenEdit);await until(async()=> (await page.evaluate(()=>window.muxivra.getSession())).cues[0].text==='Hidden source change')
 await page.locator('.navigation').getByRole('button',{name:'字幕编辑',exact:true}).click();await page.getByLabel('字幕文本',{exact:true}).waitFor();assert.equal(await page.getByLabel('字幕文本',{exact:true}).inputValue(),'Hidden source change');await until(()=>page.evaluate(async()=> (await window.muxivra.playerState('subtitles')).ready));report.checks.push('source sync while main workspace hidden also restores media')
 await desktop.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]})},srt)
 const generic=await openSource();await text(generic,'1\r\n00:00:00,200 --> 00:00:01,800\r\nSRT edited\r\n');await until(async()=> (await readFile(srt,'utf8')).includes('SRT edited'));report.checks.push('independent SRT editing and autosave')
 const srtBytes=await readFile(srt);await unlink(srt);await until(()=>generic.getByTestId('source-save-status').innerText().then(v=>v==='只读'));await writeFile(srt,srtBytes);await until(()=>generic.getByTestId('source-save-status').innerText().then(v=>v==='已保存'));report.checks.push('missing file becomes readonly without recreation and reconnects after restore')
 await generic.screenshot({path:'artifacts/qa/source-editor-srt.png',fullPage:true})
 const genericClosed=generic.waitForEvent('close');await generic.evaluate(()=>window.close());await genericClosed;report.checks.push('child-window close handshake')
 await text(source,(await source.evaluate(()=>window.sourceEditor.read())).text.replace('Hidden source change','Saved before app exit'))
 await page.evaluate(()=>window.muxivra.requestExit());const appClosed=desktop.waitForEvent('close');await page.getByRole('dialog').getByRole('button',{name:'退出应用',exact:true}).click();await appClosed;desktop=undefined;assert.match(await readFile(project.subtitlePath,'utf8'),/Saved before app exit/);report.checks.push('application exit flushes pending source edits through its confirmation dialog')
 assert.deepEqual(report.errors,[]);await writeFile('artifacts/qa/source-editor-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}catch(error){report.failure=error.stack;await source?.screenshot({path:'artifacts/qa/source-editor-failed.png',fullPage:true}).catch(()=>{});await writeFile('artifacts/qa/source-editor-failed.json',JSON.stringify(report,null,2));throw error}
finally{await desktop?.close().catch(()=>{});const inside=relative(resolve('.test-data'),root);if(!inside||inside.startsWith('..')||isAbsolute(inside))throw new Error('Unsafe test cleanup');await rm(root,{recursive:true,force:true})}
