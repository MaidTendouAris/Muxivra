import { createProject } from './gui-projects.mjs'
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises'
import { join,resolve,relative,isAbsolute,sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const root=await mkdtemp(resolve('.test-data','projects-ui-')),source=join(root,'[KitaujiSub] Seitokai ni mo Ana wa Aru [01][Uncensored][WebRip][HEVC_AAC][CHS&CHT] Long-media-name-layout-verification.mp4'),audio=join(root,'delete-selected.wav')
await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24','-f','lavfi','-i','sine=frequency=440','-t','3','-c:v','libx264','-c:a','aac',source],{windowsHide:true})
await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440','-t','1',audio],{windowsHide:true})
const original=await readFile(source),originalAudio=await readFile(audio),report={executable:process.env.MUXIVRA_EXECUTABLE||'development',errors:[]}
const desktop=await electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE||electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_DATA_PATH:join(root,'profile'),MUXIVRA_ENGINE_PATH:join(root,'engines')},timeout:60000})
let page
try{
  page=await desktop.firstWindow();page.on('pageerror',e=>report.errors.push(e.message));report.appVersion=await desktop.evaluate(({app})=>app.getVersion())
  const until=async(check,timeout=60000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await page.waitForTimeout(50)}throw new Error('Project smoke state timed out')}
  const nav=async name=>{await page.locator('.navigation').getByRole('button',{name,exact:true}).click();await page.getByRole('heading',{name,exact:true}).waitFor()}
  const pick=path=>desktop.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]})},path)
  const select=async(label,value)=>{await page.getByLabel(label,{exact:true}).click();await page.getByRole('option',{name:value,exact:true}).click()}
  const snapshot=()=>page.evaluate(()=>window.muxivra.snapshot())
  await page.getByRole('heading',{name:'单文件',exact:true}).waitFor({timeout:60000})
  assert.deepEqual(await page.locator('.nav-section').allTextContents(),['Media','Sub'])
  const names=await page.locator('.navigation nav button').allTextContents();assert.ok(names.findIndex(v=>v==='任务')>names.findIndex(v=>v==='ASR 工作台'));assert.ok(names.findIndex(v=>v==='MCP 交互')<names.findIndex(v=>v==='预设'))
  await nav('字幕编辑');assert.equal(await page.getByRole('button',{name:'收起工程栏',exact:true}).count(),1)
  await createProject(page,desktop,source)
  const first=(await snapshot()).projects.items.find(p=>!p.archived);assert.deepEqual(await readFile(first.mediaPath),original);assert.deepEqual(await readFile(source),original)
  await until(()=>page.evaluate(async()=>{const s=await window.muxivra.playerState('subtitles');return !!s.path&&s.path.includes('projects')&&s.ready&&!s.loading&&s.videoWidth>0}))
  assert.equal(await page.getByRole('button',{name:'展开工程栏',exact:true}).count(),1)
  for(let i=0;i<15;i++)await page.getByRole('button',{name:'新增字幕',exact:true}).click()
  await page.getByLabel('字幕文本',{exact:true}).fill('GUI project subtitle');await page.getByRole('button',{name:'保存工程',exact:true}).click()
  await until(async()=>!!(await readFile(first.subtitlePath,'utf8')).includes('GUI project subtitle'))
  for(const [width,height] of [[1040,720],[1920,1080],[2560,1440]]){
    await desktop.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setSize(...size),[width,height]);await page.waitForTimeout(400)
    const geometry=await page.evaluate(()=>({scrollable:document.scrollingElement.scrollHeight>innerHeight,listHeight:document.querySelector('.subtitle-list-body').clientHeight,dock:document.querySelector('.subtitle-dock').getBoundingClientRect().toJSON(),padding:parseFloat(getComputedStyle(document.querySelector('.subtitle-ass-editor')).paddingBottom)}))
    assert.equal(geometry.scrollable,false);assert.ok(geometry.listHeight>=110);assert.ok(geometry.dock.bottom<height);const list=await page.locator('.subtitle-list-card').boundingBox();assert.ok(geometry.dock.left>=list.x+list.width+10,'Collapsed toolbar overlaps the cue list')
    await page.locator('.subtitle-event-properties summary').click();await page.getByLabel('效果',{exact:true}).fill('event-test');await page.getByLabel('效果',{exact:true}).scrollIntoViewIfNeeded();await page.waitForTimeout(150)
    const bottom=await page.getByLabel('效果',{exact:true}).boundingBox(),dock=await page.locator('.subtitle-dock').boundingBox();assert.ok(bottom.y+bottom.height<=dock.y-10,'Project controls cover subtitle attributes')
    await page.locator('.subtitle-event-properties summary').click();await page.evaluate(()=>window.scrollTo(0,0));await page.waitForTimeout(100)
  }
  await nav('项目管理');await page.getByRole('button',{name:'项目文件',exact:true}).click();await page.getByRole('button',{name:'导出视频',exact:true}).click();await select('字幕方式','封装为字幕轨道');await select('视频容器','MP4')
  const output=join(first.directory,'exports','ui-embedded.mp4');await desktop.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file})},output)
  await page.getByRole('dialog').getByRole('button',{name:'选择位置并导出',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'})
  await until(async()=>{const jobs=(await snapshot()).jobs;return jobs.some(j=>j.plan.outputPath===output&&j.status==='completed')})
  const info=await page.evaluate(path=>window.muxivra.inspect(path),output);assert.equal(info.streams.find(s=>s.type==='subtitle')?.codec,'mov_text')
  await nav('项目管理');await page.getByRole('button',{name:'返回项目管理',exact:true}).click();const card=page.locator('.project-card').filter({hasText:'Long-media-name-layout-verification.mp4'});await card.getByRole('button',{name:'重命名项目',exact:true}).click();await page.getByLabel('项目名称',{exact:true}).fill('字幕工程长名称排版验证 '+ 'LongName'.repeat(15));await page.getByRole('button',{name:'保存名称',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'})
  report.projectLayouts=[]
  for(const [width,height] of [[1040,720],[1920,1080],[2560,1440]]){
    await desktop.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setSize(...size),[width,height]);await page.waitForTimeout(150)
    const geometry=await card.evaluate(element=>{const bounds=element.getBoundingClientRect();return {width:innerWidth,card:bounds.toJSON(),children:[...element.children,...element.querySelectorAll('.project-card-heading>*,.project-card-media>*')].map(e=>e.getBoundingClientRect().toJSON()),titleTruncated:element.querySelector('strong').scrollWidth>element.querySelector('strong').clientWidth,pageWidth:document.scrollingElement.scrollWidth}})
    assert.ok(geometry.children.every(b=>b.left>=geometry.card.left&&b.right<=geometry.card.right),'Long project names escape the card')
    assert.ok(geometry.titleTruncated,'Long project title should be truncated inside the card')
    assert.ok(geometry.pageWidth<=geometry.width,'Project page has horizontal overflow')
    report.projectLayouts.push(geometry);await page.screenshot({path:`artifacts/qa/projects-manager-${width}.png`,fullPage:true})
  }
  await card.getByRole('button',{name:'删除项目',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'删除项目',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});assert.deepEqual(await readFile(source),original)
  await page.getByRole('button',{name:'回收站',exact:true}).click();await page.getByRole('button',{name:'恢复项目',exact:true}).click();await until(async()=>!(await snapshot()).projects.items.find(p=>p.id===first.id).archived)
  await page.getByRole('button',{name:'返回项目库',exact:true}).click();await page.locator('.project-card').getByRole('button',{name:'编辑字幕',exact:true}).click();await until(()=>page.evaluate(async()=>(await window.muxivra.getSession())?.cues.some(c=>c.text==='GUI project subtitle')));await page.locator('[data-cue-id]').filter({hasText:'GUI project subtitle'}).click();await until(()=>page.getByLabel('字幕文本',{exact:true}).inputValue().then(v=>v==='GUI project subtitle'))
  await createProject(page,desktop,audio,{deleteOriginal:true,target:'asr'})
  const second=(await snapshot()).projects.items.find(p=>p.sourceName==='delete-selected.wav');await assert.rejects(readFile(audio),{code:'ENOENT'});assert.deepEqual(await readFile(second.mediaPath),originalAudio)
  await page.evaluate(async()=>{const s=await window.muxivra.snapshot();await window.muxivra.saveSettings({...s.settings,theme:'light'})});await nav('字幕编辑')
  assert.equal(await page.locator('.mpv-player').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(8, 9, 11)')
  await page.screenshot({path:'artifacts/qa/projects-light.png',fullPage:true});await nav('项目管理');await page.screenshot({path:'artifacts/qa/projects-manager.png',fullPage:true})
  assert.deepEqual(report.errors,[]);report.result={verifiedCopy:true,sourceDeletionOptIn:true,sourcePreservedByDefault:true,projectManagement:true,archiveRestore:true,videoExport:true,blackPreviewFill:true,fixedSubtitleWorkspace:true,collapsedDockInRightColumn:true,longProjectNamesContained:true,subtitleAttributesClearDock:true,largerSubtitleList:true,navigationGroups:true}
  await writeFile('artifacts/qa/projects-smoke.json',JSON.stringify(report,null,2));console.log('Managed project UI smoke passed')
}catch(error){report.failure=error.stack;report.screen=await page?.locator('body').innerText().catch(()=>undefined);await page?.screenshot({path:'artifacts/qa/projects-smoke-failed.png',fullPage:true}).catch(()=>{});await writeFile('artifacts/qa/projects-smoke-failed.json',JSON.stringify(report,null,2));throw error}
finally{await desktop.close();const check=relative(resolve('.test-data'),root);if(!check||check==='..'||check.startsWith(`..${sep}`)||isAbsolute(check))throw new Error('Unsafe cleanup');await rm(root,{recursive:true,force:true})}
