import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { mkdir,mkdtemp,writeFile,rm } from 'node:fs/promises'
import { join,resolve,relative,isAbsolute,sep } from 'node:path'
import assert from 'node:assert/strict'
await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const root=await mkdtemp(resolve('.test-data','software-info-')),report={executable:process.env.MUXIVRA_EXECUTABLE||'development',errors:[]}
const launch=()=>electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE||electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_UPDATE_TEST:'1',MUXIVRA_DATA_PATH:join(root,'profile'),MUXIVRA_ENGINE_PATH:join(root,'engines')},timeout:60000})
let desktop=await launch(),page
const setup=async()=>{page=await desktop.firstWindow();page.on('pageerror',error=>report.errors.push(error.message));await page.getByRole('heading',{name:'视频处理',exact:true}).waitFor({timeout:60000});await page.locator('.navigation').getByRole('button',{name:'设置',exact:true}).click()}
try{
  await setup();report.version=await desktop.evaluate(({app})=>app.getVersion());let card=page.locator('.software-info-card')
  assert.equal(await page.locator('.settings-layout>fieldset>.card').last().locator('h3').innerText(),'软件信息')
  assert.ok((await card.innerText()).includes('GPL-3.0-only'));assert.ok((await card.innerText()).includes('mpv 播放器许可证'))
  const engine=(await page.evaluate(()=>window.muxivra.snapshot())).engine;assert.ok(engine.license);assert.ok((await card.innerText()).includes(engine.license))
  await desktop.evaluate(({shell})=>{globalThis.__testLinks=[];shell.openExternal=async url=>{globalThis.__testLinks.push(url)}})
  for(const name of ['GitHub 仓库','问题反馈','手动更新'])await card.getByRole('button',{name,exact:true}).click()
  assert.deepEqual(await desktop.evaluate(()=>globalThis.__testLinks),['https://github.com/MaidTendouAris/Muxivra','https://github.com/MaidTendouAris/Muxivra/issues','https://github.com/MaidTendouAris/Muxivra/releases'])
  const auto=card.getByLabel('自动检查更新',{exact:true});assert.equal(await auto.isChecked(),true);await auto.uncheck();assert.equal(await card.locator('.setting-changed .setting-marker').count(),1)
  await page.locator('.navigation').getByRole('button',{name:'视频处理',exact:true}).click();await page.getByRole('dialog',{name:'应用设置更改？',exact:true}).getByRole('button',{name:'应用并离开',exact:true}).click();await page.getByRole('heading',{name:'视频处理',exact:true}).waitFor();assert.equal((await page.evaluate(()=>window.muxivra.snapshot())).settings.autoUpdate,false)
  await desktop.close();desktop=await launch();await setup();card=page.locator('.software-info-card');await page.waitForTimeout(500);assert.equal(await desktop.evaluate(()=>globalThis.__muxivraUpdateTest().checks),0);assert.equal(await card.getByLabel('自动检查更新',{exact:true}).isChecked(),false)
  await card.getByRole('button',{name:'检查更新',exact:true}).click();await page.waitForFunction(async()=>(await window.muxivra.appUpdateState()).phase==='available');assert.equal(await desktop.evaluate(()=>globalThis.__muxivraUpdateTest().checks),1)
  for(const theme of ['light','dark']){await page.evaluate(async theme=>{const s=await window.muxivra.snapshot();await window.muxivra.saveSettings({...s.settings,theme})},theme);await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1040,720));await page.locator('.software-info-card').scrollIntoViewIfNeeded();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`artifacts/qa/software-info-${theme}.png`})}
  assert.deepEqual(report.errors,[]);report.result={bottomCard:true,licensesFromActualComponents:true,fixedLinks:true,changedMarkerAndLeavePrompt:true,autoUpdatePersistsAcrossRestart:true,manualCheckWhenAutoOff:true,minimumWindowThemes:true};await writeFile('artifacts/qa/software-info-smoke.json',JSON.stringify(report,null,2));console.log('Software information smoke passed')
}catch(error){report.failure=error.stack;report.screen=await page?.locator('body').innerText().catch(()=>undefined);await page?.screenshot({path:'artifacts/qa/software-info-failed.png'}).catch(()=>{});await writeFile('artifacts/qa/software-info-failed.json',JSON.stringify(report,null,2));throw error}
finally{await desktop.close();const inside=relative(resolve('.test-data'),root);if(!inside||inside==='..'||inside.startsWith(`..${sep}`)||isAbsolute(inside))throw new Error('Unsafe cleanup');await rm(root,{recursive:true,force:true})}
