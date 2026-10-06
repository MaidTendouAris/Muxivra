import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, join, relative, isAbsolute, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'

const exec=promisify(execFile)
await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const root=await mkdtemp(resolve('.test-data','mcp-setup-')),output=join(root,'output'),codexHome=join(root,'codex')
await mkdir(output);await mkdir(codexHome)
const input=join(root,'测试音乐.mp3')
await exec('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440','-t','2','-c:a','libmp3lame',input],{windowsHide:true})
const portServer=createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r))
const desktop=await electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE||electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_DATA_PATH:join(root,'profile'),MUXIVRA_ENGINE_PATH:join(root,'engines')},timeout:60000})
let client,clipboardBefore
const errors=[]
const report={executable:process.env.MUXIVRA_EXECUTABLE||'development build',errors}
try {
  clipboardBefore=await desktop.evaluate(({clipboard})=>clipboard.readText())
  const page=await desktop.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.getByRole('heading',{name:'单文件',exact:true}).waitFor({timeout:60000})
  await page.locator('.navigation').getByRole('button',{name:'设置',exact:true}).click()
  await page.locator('.mcp-guide-button').last().waitFor()
  assert.equal(await page.getByRole('button',{name:'复制完整连接提示词',exact:true}).isDisabled(),true)
  const denied=await page.evaluate(()=>window.muxivra.copyMcpConnectionPrompt().then(()=>false,()=>true));assert.equal(denied,true)
  await page.getByRole('button',{name:'预览',exact:true}).click()
  const preview=await page.locator('.mcp-document').innerText();const original=await page.evaluate(()=>window.muxivra.snapshot());assert.ok(!preview.includes(original.settings.mcp.token))
  await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click()
  await desktop.evaluate(({dialog},paths)=>{let i=0;dialog.showOpenDialog=async()=>({canceled:false,filePaths:[paths[i++]]})},[root,output])
  await page.locator('.root-section').nth(0).getByRole('button',{name:'添加',exact:true}).click();await page.locator('.root-section').nth(1).getByRole('button',{name:'添加',exact:true}).click()
  await page.getByLabel('端口',{exact:true}).fill(String(port));await page.getByLabel('启用 MCP',{exact:true}).check()
  await page.getByRole('button',{name:'保存并复制完整连接提示词',exact:true}).click()
  await page.waitForFunction(async()=> (await window.muxivra.snapshot()).mcp.running)
  await page.getByText('完整连接提示词已复制',{exact:true}).waitFor()
  const saved=await page.evaluate(()=>window.muxivra.snapshot()),prompt=await desktop.evaluate(({clipboard})=>clipboard.readText())
  assert.equal(saved.settings.mcp.port,port);assert.ok(prompt.includes(saved.settings.mcp.token));assert.ok(prompt.includes(saved.mcp.url));assert.ok(prompt.includes(JSON.stringify(root)));assert.ok(prompt.includes(JSON.stringify(output)))
  assert.ok(prompt.includes('protocolVersion'));assert.ok(prompt.includes('list_skills'));assert.ok(prompt.includes('read_skill'));assert.ok(prompt.includes('不授权转码或取消现有媒体任务'))
  report.savedAndCopied=true;report.promptContainsCredential=true;report.promptLength=prompt.length
  if(process.env.MUXIVRA_EXECUTABLE)assert.ok(prompt.includes(process.env.MUXIVRA_EXECUTABLE))
  client=new Client({name:'muxivra-setup-verification',version:'1.0'})
  await client.connect(new StreamableHTTPClientTransport(new URL(saved.mcp.url),{requestInit:{headers:{Authorization:`Bearer ${saved.settings.mcp.token}`}}}))
  const tools=(await client.listTools()).tools;assert.equal(tools.length,16)
  const catalog=JSON.parse((await client.callTool({name:'list_skills',arguments:{}})).content[0].text);assert.equal(catalog.length,6)
  for(const skill of catalog){const document=await client.callTool({name:'read_skill',arguments:{id:skill.id}});assert.equal(document.isError,undefined);assert.ok(JSON.parse(document.content[0].text).markdown.includes('name: muxivra-'))}
  const audio=JSON.parse((await client.callTool({name:'read_skill',arguments:{id:'audio'}})).content[0].text)
  const request=JSON.parse(audio.markdown.match(/```json\s+([\s\S]+?)```/)[1]);request.inputPath=input;request.outputPath=join(output,'guide-audio.m4a')
  const plan=await client.callTool({name:'plan_transcode',arguments:{request}});assert.ok(!plan.isError);assert.equal(JSON.parse(plan.content[0].text).options.audio,'aac')
  const resource=await client.readResource({uri:'muxivra://reference/parameters'});assert.ok(JSON.parse(resource.contents[0].text).parameters.some(p=>p.key==='sampleRate'))
  const encoder=JSON.parse((await client.callTool({name:'get_component_capabilities',arguments:{kind:'audioEncoder',name:'aac'}})).content[0].text);assert.ok(encoder.options.some(p=>p.name==='aac_coder'))
  assert.ok((await client.getPrompt({name:'muxivra_workflow'})).messages[0].content.text.includes('媒体处理流程'))
  report.actualMcpConnection=true;report.tools=tools.length;report.guides=catalog.length;report.audioGuidePlan=true
  if(process.env.MUXIVRA_CODEX_PATH) {
    const prior='check_for_update_on_startup = false\n\n[mcp_servers.other]\nurl = "https://example.invalid/mcp"\n'
    await writeFile(join(codexHome,'config.toml'),prior)
    const env={...process.env,CODEX_HOME:codexHome,MUXIVRA_MCP_TOKEN:saved.settings.mcp.token}
    await exec(process.env.MUXIVRA_CODEX_PATH,['mcp','add','muxivra','--url',saved.mcp.url,'--bearer-token-env-var','MUXIVRA_MCP_TOKEN'],{env,windowsHide:true,timeout:30000})
    await exec(process.env.MUXIVRA_CODEX_PATH,['mcp','list'],{env,windowsHide:true,timeout:30000})
    const config=await readFile(join(codexHome,'config.toml'),'utf8');assert.ok(config.includes('[mcp_servers.other]'));assert.ok(config.includes(saved.mcp.url));assert.ok(config.includes('MUXIVRA_MCP_TOKEN'));assert.ok(!config.includes(saved.settings.mcp.token))
    report.isolatedCodexConfiguration=true
  }
  await page.getByRole('button',{name:'预览',exact:true}).click();assert.ok(!(await page.locator('.mcp-document').innerText()).includes(saved.settings.mcp.token));await page.screenshot({path:'artifacts/qa/mcp-prompt-preview.png'});await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click()
  await page.locator('.mcp-guide-button').filter({hasText:'音频转码'}).click();assert.ok((await page.locator('.mcp-document').innerText()).includes('AAC M4A'));await page.screenshot({path:'artifacts/qa/mcp-audio-guide.png'});await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click()
  await desktop.evaluate(({clipboard})=>clipboard.writeText('muxivra-copy-failure-marker'))
  await page.getByLabel('端口',{exact:true}).fill('1023');await page.getByRole('button',{name:'保存并复制完整连接提示词',exact:true}).click();await page.locator('.toast-error').waitFor()
  assert.equal(await desktop.evaluate(({clipboard})=>clipboard.readText()),'muxivra-copy-failure-marker');assert.equal((await page.evaluate(()=>window.muxivra.snapshot())).settings.mcp.port,port)
  report.failedSaveDoesNotCopy=true
  assert.ok((await page.locator('.toast-error').innerText()).includes('MCP 端口必须为'))
  await page.locator('.toast-error button').click()
  await page.getByLabel('端口',{exact:true}).fill(String(port))
  for(const theme of ['dark','light']){
    const settings=await page.evaluate(()=>window.muxivra.snapshot());await page.evaluate(value=>window.muxivra.saveSettings(value),{...settings.settings,theme});await page.waitForFunction(value=>document.documentElement.dataset.theme===value,theme)
    await page.locator('.mcp-connect-panel').scrollIntoViewIfNeeded();await page.screenshot({path:`artifacts/qa/mcp-setup-${theme}.png`,fullPage:true})
  }
  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:1040,height:720}))
  await page.waitForTimeout(100);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth));await page.locator('.mcp-connect-panel').scrollIntoViewIfNeeded();await page.screenshot({path:'artifacts/qa/mcp-setup-minimum.png',fullPage:true})
  report.minimumWindowNoOverflow=true;report.previewRedacted=true;report.themes=['dark','light'];report.appVersion=await desktop.evaluate(({app})=>app.getVersion())
  assert.deepEqual(errors,[])
  await writeFile('artifacts/qa/mcp-setup-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
} finally {
  await client?.close().catch(()=>{})
  if(clipboardBefore!==undefined)await desktop.evaluate(({clipboard},value)=>clipboard.writeText(value),clipboardBefore).catch(()=>{})
  await desktop.close()
  const local=relative(resolve('.test-data'),root);if(local&&!local.startsWith('..'+sep)&&!isAbsolute(local))await rm(root,{recursive:true,force:true})
}
