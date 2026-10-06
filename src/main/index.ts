import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, Tray, Menu, nativeImage, clipboard, session } from 'electron'
import { join, dirname, resolve } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { MediaService } from '../core/service'
import { McpHost } from '../mcp/server'
import { isWithin } from '../core/media/paths'
import { z } from 'zod'
import { pathSchema } from '../shared/schema'
import { subtitleSchema } from '../shared/schema'
import { playerOwnerSchema, playerRectSchema, playerActionSchema } from '../shared/player-schema'
import type { PlayerOwner } from '../shared/player'
import type { ExitPrompt } from '../shared/types'
import { MpvPlayers } from './player'
import { skillCatalog, readSkill, skillIds } from '../mcp/skills'
import { buildMcpConnectionPrompt } from '../shared/mcp-connection'
import { APP_VERSION } from '../shared/version'

app.setName('Muxivra')
protocol.registerSchemesAsPrivileged([{ scheme: 'muxivra', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
if (process.env.MUXIVRA_DATA_PATH) app.setPath('userData',resolve(process.env.MUXIVRA_DATA_PATH))
const hasLock = app.requestSingleInstanceLock()
if (!hasLock) app.quit()
let window: BrowserWindow | undefined, tray: Tray | undefined, service: MediaService, mcp: McpHost, players:MpvPlayers
let quitting = false, exitInProgress = false, firstHide = true
let exitPrompt: ExitPrompt | undefined
const engineGrants = new Set<string>()
const devUrl = process.env.ELECTRON_RENDERER_URL
const rendererRoot = resolve(__dirname,'../renderer')

async function createWindow(): Promise<void> {
  window = new BrowserWindow({ width: 1380, height: 910, minWidth: 1040, minHeight: 720, backgroundColor: '#0c0d10', title: 'Muxivra', autoHideMenuBar: true,
    icon: join(app.getAppPath(),'resources/icon.ico'), webPreferences: { preload: join(__dirname,'../preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate',event => event.preventDefault())
  players=new MpvPlayers(window,service)
  players.on('state',state=>{if(window&&!window.isDestroyed())window.webContents.send('muxivra:player-state',state)})
  players.on('editor-event',event=>window?.webContents.send('muxivra:player-event',event))
  players.on('screenshot-request',owner=>{void takeScreenshot(owner).catch(error=>dialog.showErrorBox('截图失败',error.message))})
  players.on('action-error',message=>window?.webContents.send('muxivra:player-error',message))
  window.on('show',()=>players.show());window.on('restore',()=>players.show())
  window.on('hide',()=>players.hide());window.on('minimize',()=>players.hide());window.on('leave-full-screen',()=>players.syncFullscreen())
  window.on('close',event => {
    if (quitting) return
    if (exitInProgress) { event.preventDefault(); return }
    if (exitPrompt) setExitPrompt(undefined)
    event.preventDefault(); window?.hide()
    if (firstHide && tray && process.env.MUXIVRA_SMOKE !== '1') { firstHide = false; tray.displayBalloon({ title: 'Muxivra 仍在运行', content: '任务与 MCP 服务继续运行。双击托盘图标可打开；从托盘菜单退出应用。' }) }
  })
  window.on('closed',() => { window = undefined })
  if (devUrl) await window.loadURL(devUrl)
  else await window.loadURL('muxivra://app/index.html')
}
async function requestExit(force = false): Promise<void> {
  if (exitInProgress) return
  if (!force) {
    setExitPrompt(exitSummary('confirm'))
    if (window?.isMinimized()) window.restore()
    window?.show(); window?.focus()
    return
  }
  await finishExit()
}
function exitSummary(phase:ExitPrompt['phase']):ExitPrompt {
  const jobs=service.queue.jobs
  return {phase,running:jobs.filter(j=>j.status==='running').length,waiting:jobs.filter(j=>j.status==='queued').length,paused:jobs.filter(j=>j.status==='paused').length,mcpRunning:!!service.mcpState.running}
}
function setExitPrompt(state:ExitPrompt|undefined):void {
  exitPrompt=state
  if(window&&!window.isDestroyed())window.webContents.send('muxivra:exit-state',state)
}
async function finishExit():Promise<void> {
  if(exitInProgress)return
  exitInProgress=true
  setExitPrompt(exitSummary('closing'))
  try {
    await players?.shutdown(); await mcp.stop(); await service.shutdown(); tray?.destroy(); quitting=true; app.quit()
  } catch(error) {
    setExitPrompt({...exitSummary('confirm'),error:(error as Error).message})
    throw error
  } finally { exitInProgress = false }
}
async function takeScreenshot(owner:PlayerOwner):Promise<string|undefined>{
  const state=players.state(owner)
  const selected=await dialog.showSaveDialog(window!,{title:'保存截图',defaultPath:`${(state.title||'screenshot').replace(/[<>:"/\\|?*]/g,'_')}-${Math.floor(state.positionMs)}.png`,filters:[{name:'PNG 图片',extensions:['png']}]})
  if(!selected.filePath)return
  await service.paths.grantDirectory(dirname(selected.filePath));return players.screenshot(owner,selected.filePath)
}
function registerIpc(): void {
  const handle = (name: string, callback: (...args: any[]) => unknown) => ipcMain.handle(`muxivra:${name}`,(event,...args) => {
    const url = event.senderFrame?.url
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !(url?.startsWith('muxivra://app/') || (devUrl && new URL(url ?? '').origin === new URL(devUrl).origin))) throw new Error('IPC 来源未获授权')
    return callback(...args)
  })
  handle('snapshot',() => service.snapshot())
  handle('exitState',()=>exitPrompt)
  handle('requestExit',()=>requestExit())
  handle('respondToExit',async confirm=>{
    z.boolean().parse(confirm)
    if(exitInProgress)return
    if(!exitPrompt)throw new Error('没有待确认的退出请求')
    if(confirm)await finishExit();else setExitPrompt(undefined)
  })
  handle('selectFiles',async (kind,multiple) => {
    z.enum(['media','subtitle','subtitle-burn']).parse(kind); z.boolean().optional().parse(multiple)
    const selected = await dialog.showOpenDialog(window!,{ properties: multiple ? ['openFile','multiSelections'] : ['openFile'], filters: kind === 'subtitle' ? [{ name: 'SRT 字幕', extensions: ['srt'] }] : kind==='subtitle-burn'?[{name:'烧录字幕',extensions:['srt','ass','ssa']}]:[{ name: '媒体文件', extensions: ['mp4','mkv','mov','avi','webm','m4v','m4a','mp3','wav','flac','ogg','aac','ts','png','jpg','webp','gif'] },{ name: '所有文件', extensions: ['*'] }] })
    return Promise.all(selected.filePaths.map(path => service.paths.grantFile(path)))
  })
  handle('selectDirectory',async purpose => {
    z.enum(['output','engine','mcp-input','mcp-output']).parse(purpose)
    const selected = await dialog.showOpenDialog(window!,{ title: purpose === 'engine' ? '选择包含 ffmpeg.exe 和 ffprobe.exe 的 bin 目录' : '选择目录', properties: ['openDirectory'] })
    if (!selected.filePaths[0]) return undefined
    const path = await service.paths.grantDirectory(selected.filePaths[0]); if (purpose === 'engine') engineGrants.add(path); return path
  })
  handle('acceptDrop',async paths => { z.array(pathSchema).max(500).parse(paths); return Promise.all(paths.map((path: string) => service.paths.grantFile(path))) })
  handle('inspect',path => service.inspect(path)); handle('plan',request => service.plan(request)); handle('submit',(requests,key) => service.submit(requests,'gui',key))
  handle('planBatch',requests => service.planBatch(requests))
  handle('cancel',id => service.cancel(z.string().uuid().parse(id))); handle('retry',id => service.retry(z.string().uuid().parse(id)))
  handle('pause',id=>service.pause(z.string().uuid().parse(id)));handle('resume',id=>service.resume(z.string().uuid().parse(id)))
  handle('moveJob',(id,direction)=>service.moveJob(z.string().uuid().parse(id),z.enum(['up','down','first','last']).parse(direction)))
  handle('refreshHardware',()=>service.refreshHardware())
  handle('systemUsage',()=>service.usage.read())
  handle('detectEngine',() => service.detect())
  handle('useEngine',path => { z.string().parse(path); if (!service.snapshot().engines.some(e => e.id === path) && !engineGrants.has(path)) throw new Error('请先选择引擎目录'); return service.selectEngine(path) })
  handle('downloadEngine',() => service.downloadEngine())
  handle('saveSettings',settings => service.saveSettings(settings)); handle('savePreset',preset => service.savePreset(preset)); handle('deletePreset',id => service.deletePreset(z.string().parse(id)))
  handle('componentCapabilities',(kind,name)=>service.componentCapabilities(z.enum(['videoEncoder','audioEncoder','filter']).parse(kind),z.string().regex(/^[a-zA-Z0-9_]{1,80}$/).parse(name)))
  handle('importPresets',async()=>{const selected=await dialog.showOpenDialog(window!,{title:'导入预设',properties:['openFile'],filters:[{name:'Muxivra 预设',extensions:['json']}]});if(!selected.filePaths[0])return;return service.importPresetFile(await service.paths.grantFile(selected.filePaths[0]))})
  handle('exportPresets',async ids=>{z.array(z.string()).min(1).max(200).parse(ids);const selected=await dialog.showSaveDialog(window!,{title:'导出预设',defaultPath:'muxivra-presets.json',filters:[{name:'Muxivra 预设',extensions:['json']}]});if(!selected.filePath)return;await service.paths.grantDirectory(dirname(selected.filePath));await service.exportPresetFile(ids,selected.filePath);return selected.filePath})
  handle('readSubtitles',path => service.readSubtitles(path)); handle('saveSession',doc => service.saveSession(doc)); handle('getSession',() => service.getSession())
  handle('exportSubtitles',async doc => {
    const selected = await dialog.showSaveDialog(window!,{ title: '导出新的 SRT 文件', defaultPath: 'subtitles-edited.srt', filters: [{ name: 'SRT 字幕', extensions: ['srt'] }] })
    if (!selected.filePath) return undefined
    await service.paths.grantDirectory(dirname(selected.filePath)); await service.exportSubtitles(doc,selected.filePath); return selected.filePath
  })
  handle('inspectPlayback',path=>service.inspectPlayback(pathSchema.parse(path)))
  handle('playerState',owner=>players.state(playerOwnerSchema.parse(owner)))
  handle('playerOpen',(owner,paths,append)=>players.open(playerOwnerSchema.parse(owner),z.array(pathSchema).min(1).max(500).parse(paths),z.boolean().optional().parse(append)))
  handle('playerRect',(owner,rect)=>players.rect(playerOwnerSchema.parse(owner),playerRectSchema.parse(rect)))
  handle('playerAction',(owner,action)=>players.action(playerOwnerSchema.parse(owner),playerActionSchema.parse(action)))
  handle('playerMedia',owner=>players.media(playerOwnerSchema.parse(owner)))
  handle('playerScreenshot',owner=>takeScreenshot(playerOwnerSchema.parse(owner)))
  handle('playerSubtitles',(owner,document)=>players.subtitles(playerOwnerSchema.parse(owner),subtitleSchema.parse(document)))
  handle('playerAddTrack',async(owner,kind)=>{owner=playerOwnerSchema.parse(owner);kind=z.enum(['audio','subtitle']).parse(kind);const selected=await dialog.showOpenDialog(window!,{title:kind==='audio'?'载入音轨':'载入字幕',properties:['openFile'],filters:[kind==='audio'?{name:'音频',extensions:['m4a','mp3','wav','flac','ogg','aac','ac3','dts']}:{name:'字幕',extensions:['srt','ass','ssa','vtt']}]});if(selected.filePaths[0])await players.addTrack(owner,await service.paths.grantFile(selected.filePaths[0]),kind)})
  handle('waveform',path => service.waveform(path))
  handle('reveal',async path => {
    pathSchema.parse(path)
    const jobs = service.snapshot().jobs
    if (!jobs.some(job => job.plan.outputPath === path || job.logPath === path) && !service.paths.files.has(path) && path !== service.dataPath && path !== service.enginePath) throw new Error('路径未获授权')
    if ((await stat(path)).isDirectory()) await shell.openPath(path); else shell.showItemInFolder(path)
  })
  handle('readLog',id => service.queue.log(z.string().uuid().parse(id)))
  handle('copyText',text => { clipboard.writeText(z.string().max(100000).parse(text)) })
  const mcpSetupInfo=()=>({version:APP_VERSION,running:service.mcpState.running,executablePath:app.isPackaged?app.getPath('exe'):undefined,skills:skillCatalog()})
  handle('mcpSetupInfo',()=>mcpSetupInfo())
  handle('mcpReadSkill',id=>readSkill(z.enum(skillIds).parse(id)))
  handle('copyMcpConnectionPrompt',()=>{
    if(!service.settings.mcp.enabled||!service.mcpState.running)throw new Error('请先启用并保存 MCP，确认服务运行后再复制连接提示词')
    clipboard.writeText(buildMcpConnectionPrompt(service.settings.mcp,mcpSetupInfo()))
  })
}

app.on('second-instance',() => { window?.show(); window?.focus() })
app.on('before-quit',event => { if (!quitting && service) { event.preventDefault(); void requestExit(process.env.MUXIVRA_SMOKE === '1') } })
app.on('window-all-closed',() => {})
if (hasLock) void app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  protocol.handle('muxivra',async request => {
    const url = new URL(request.url)
    if (url.hostname !== 'app') return new Response('Not found',{ status: 404 })
    const path = resolve(rendererRoot,decodeURIComponent(url.pathname).replace(/^\/+/,''))
    if (!isWithin(rendererRoot,path)) return new Response('Forbidden',{ status: 403 })
    return net.fetch(pathToFileURL(path).toString())
  })
  const data = app.getPath('userData')
  const engines = process.env.MUXIVRA_ENGINE_PATH ? resolve(process.env.MUXIVRA_ENGINE_PATH) : join(process.env.LOCALAPPDATA ?? app.getPath('home'),'Muxivra','engines','ffmpeg')
  const outputs = join(app.isPackaged?dirname(app.getPath('exe')):app.getAppPath(),'outputs')
  service = new MediaService(data,engines,outputs,join(__dirname,'hardware-worker.js')); await service.initialize(); mcp = new McpHost(service)
  service.beforeSaveSettings = settings => mcp.configure(settings.mcp)
  if (service.settings.mcp.enabled) { try { await mcp.configure(service.settings.mcp) } catch (e) { service.mcpState = { running: false, error: (e as Error).message } } }
  let updateTimer: ReturnType<typeof setTimeout> | undefined
  service.on('update',() => { if (updateTimer) return; updateTimer = setTimeout(() => { updateTimer = undefined; if (window && !window.isDestroyed()) window.webContents.send('muxivra:update',service.snapshot()) },150) })
  registerIpc()
  tray = new Tray(nativeImage.createFromPath(join(app.getAppPath(),'resources/icon.png')).resize({ width: 32,height: 32 }))
  tray.setToolTip('Muxivra · 本地媒体工作台'); tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 Muxivra', click: () => { window?.show(); window?.focus() } },{ type: 'separator' },{ label: '退出应用', click: () => { void requestExit() } }]))
  tray.on('double-click',() => { window?.show(); window?.focus() })
  await createWindow()
  // Automated desktop checks run in an isolated profile and can exit without an interactive prompt.
  if (process.env.MUXIVRA_SMOKE === '1') ipcMain.handle('muxivra:smoke-exit',() => requestExit(true))
}).catch(async error => { dialog.showErrorBox('Muxivra 启动失败',String(error)); quitting = true; await players?.shutdown().catch(()=>{});await mcp?.stop().catch(()=>{});await service?.shutdown().catch(() => {}); app.quit() })
