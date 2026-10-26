import { createProject } from './gui-projects.mjs'
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { mkdir,mkdtemp,writeFile,readFile,rm } from 'node:fs/promises'
import { join,resolve,relative,isAbsolute,sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const root=await mkdtemp(resolve('.test-data','project-lifecycle-')),profile=join(root,'profile'),audio=join(root,'clip.wav'),subtitle=join(root,'initial.srt'),report={executable:process.env.MUXIVRA_EXECUTABLE||'development',errors:[]}
await mkdir(join(profile,'empty-subtitle-workspace'),{recursive:true})
await writeFile(join(profile,'empty-subtitle-workspace','subtitle-session.json'),JSON.stringify({id:'old-empty-cache',cues:[]}))
await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440','-t','2',audio],{windowsHide:true})
await writeFile(subtitle,'1\n00:00:00,123 --> 00:00:01,234\nInitial project subtitle\n')
const original=await readFile(audio)
const launch=()=>electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE||electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_DATA_PATH:profile,MUXIVRA_ENGINE_PATH:join(root,'engines')},timeout:60000})
let desktop=await launch(),page
try{
  page=await desktop.firstWindow();page.on('pageerror',error=>report.errors.push(error.message));report.version=await desktop.evaluate(({app})=>app.getVersion())
  const nav=async name=>{await page.locator('.navigation').getByRole('button',{name,exact:true}).click();await page.getByRole('heading',{name,exact:true,level:1}).waitFor()}
  const wait=async test=>{const end=Date.now()+30000;while(Date.now()<end){if(await test())return;await page.waitForTimeout(50)}throw new Error('Project lifecycle timed out')}
  const session=()=>page.evaluate(()=>window.muxivra.getSession())
  await page.getByRole('heading',{name:'视频处理',exact:true}).waitFor({timeout:60000});assert.equal(await session(),undefined)
  await nav('字幕编辑');assert.equal(await page.getByRole('button',{name:'导入媒体',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'导入字幕',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'删除工程',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'打开工程',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'关闭工程',exact:true}).count(),0)
  const a=await createProject(page,desktop,audio,{subtitle,name:'First project',resolution:{width:1280,height:720}});await wait(()=>page.getByLabel('字幕文本',{exact:true}).inputValue().then(text=>text==='Initial project subtitle'))
  await page.getByLabel('字幕文本',{exact:true}).fill('Pending edit before delete')
  assert.equal((await session()).scriptInfo.PlayResX,'1280');assert.equal((await session()).scriptInfo.PlayResY,'720')
  await nav('项目管理');const old=await session();assert.ok((await readFile(a.subtitlePath,'utf8')).includes('Pending edit before delete'))
  await page.locator('.project-card').getByRole('button',{name:'删除项目',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'删除项目',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'})
  // A delayed editor request from the deleted document must never recreate it.
  await page.evaluate(document=>window.muxivra.saveSession(document),old);assert.equal(await session(),undefined)
  await nav('字幕编辑');await page.waitForTimeout(1100);assert.equal(await page.locator('.toast-error').count(),0)
  for(const name of ['视频处理','音频处理','批量处理','任务','MCP 交互','预设','设置','ASR 工作台','字幕编辑','项目管理'])await nav(name)
  const b=await createProject(page,desktop,audio,{name:'Second project'});await wait(()=>page.getByRole('button',{name:'新增字幕',exact:true}).isEnabled());await page.getByRole('button',{name:'新增字幕',exact:true}).click();await page.getByLabel('字幕文本',{exact:true}).fill('Saved on close')
  assert.equal(await page.getByRole('button',{name:'关闭工程',exact:true}).count(),0);await nav('项目管理');await page.locator('.project-card').filter({hasText:'Second project'}).getByRole('button',{name:'关闭工程',exact:true}).click();await wait(async()=>!await session());assert.ok((await readFile(b.subtitlePath,'utf8')).includes('Saved on close'))
  await page.locator('.project-card').filter({hasText:'Second project'}).getByRole('button',{name:'编辑字幕',exact:true}).click();await wait(()=>page.getByLabel('字幕文本',{exact:true}).inputValue().then(v=>v==='Saved on close'))
  await nav('项目管理');await page.locator('.project-card').filter({hasText:'Second project'}).getByRole('button',{name:'项目文件',exact:true}).click()
  await desktop.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]})},subtitle)
  await page.getByRole('button',{name:'导入字幕',exact:true}).click();await wait(async()=>(await session())?.cues[0]?.text==='Initial project subtitle');await nav('字幕编辑');await wait(()=>page.getByLabel('字幕文本',{exact:true}).inputValue().then(v=>v==='Initial project subtitle'));await page.waitForTimeout(1000);assert.equal((await session()).cues[0].text,'Initial project subtitle')
  await nav('ASR 工作台');assert.equal(await page.getByRole('button',{name:'选择媒体',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'打开工程',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'关闭工程',exact:true}).count(),0);await nav('项目管理');if(await page.getByRole('button',{name:'返回项目管理',exact:true}).count())await page.getByRole('button',{name:'返回项目管理',exact:true}).click();await page.locator('.project-card').filter({hasText:'Second project'}).getByRole('button',{name:'关闭工程',exact:true}).click();await wait(async()=>!await session());await nav('字幕编辑');await nav('项目管理')
  if(await page.getByRole('button',{name:'返回项目管理',exact:true}).count())await page.getByRole('button',{name:'返回项目管理',exact:true}).click()
  await page.locator('.project-card').filter({hasText:'Second project'}).getByRole('button',{name:'项目文件',exact:true}).click()
  const external=(await readFile(b.subtitlePath,'utf8'))+'\n; External edit retained\n';await writeFile(b.subtitlePath,external)
  await page.getByRole('button',{name:'复制工程',exact:true}).click();await wait(()=>page.evaluate(async id=>(await window.muxivra.snapshot()).projects.activeId!==id,b.id));assert.equal(await readFile(b.subtitlePath,'utf8'),external)
  await writeFile(subtitle,'1\n00:00:00,123 --> 00:00:01,234\nManaged changes at shutdown\n')
  await desktop.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]})},subtitle)
  await page.getByRole('button',{name:'导入字幕',exact:true}).click();await wait(async()=>(await session())?.cues[0]?.text==='Managed changes at shutdown')
  await desktop.close();desktop=await launch();page=await desktop.firstWindow();page.on('pageerror',error=>report.errors.push(error.message));await page.getByRole('heading',{name:'视频处理',exact:true}).waitFor({timeout:60000})
  assert.equal((await session()).cues[0].text,'Managed changes at shutdown')
  assert.deepEqual(await readFile(audio),original);assert.equal(await page.locator('.toast-error').count(),0);assert.deepEqual(report.errors,[])
  report.result={copyPreservesExternalChanges:true,hiddenEditorCannotOverwriteOnQuit:true,customCreationOptions:true,legacyBlankIgnored:true,deleteThenNavigateAndCreate:true,lateCacheIgnored:true,closeSavesDraft:true,reopenPreservesDraft:true,projectLifecycleOnlyInProjectManagement:true,managedImportRefreshesEditor:true,asrExistingOnly:true,sourcePreserved:true}
  await writeFile('artifacts/qa/project-lifecycle-smoke.json',JSON.stringify(report,null,2));console.log('Project lifecycle smoke passed')
}catch(error){report.failure=error.stack;report.screen=await page?.locator('body').innerText().catch(()=>undefined);await page?.screenshot({path:'artifacts/qa/project-lifecycle-failed.png'}).catch(()=>{});await writeFile('artifacts/qa/project-lifecycle-failed.json',JSON.stringify(report,null,2));throw error}
finally{await desktop.close();const inside=relative(resolve('.test-data'),root);if(!inside||inside==='..'||inside.startsWith(`..${sep}`)||isAbsolute(inside))throw new Error('Unsafe cleanup');await rm(root,{recursive:true,force:true})}
