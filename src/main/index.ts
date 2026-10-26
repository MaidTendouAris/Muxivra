import { downloadSourcesSchema } from '../shared/download-sources'
import { translateUi } from '../shared/i18n'
import { resolveUiLocale } from '../shared/locale'
import type { OpenDialogOptions,SaveDialogOptions } from 'electron'
import { asrRecognitionSchema,asrBackends } from '../shared/asr'
import { asrEnvironmentRequestSchema } from '../shared/asr-environments'
import { asrAssetIdSchema } from '../shared/asr-catalog'
import { asrDeploymentRequestSchema,asrResourceRequestSchema,asrConfigureModelSchema } from '../shared/asr-deployment'
import { initializeDownloadNetworking } from './download-network'
import { checkDownloadNetwork } from '../core/download-network'
import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, Tray, Menu, nativeImage, clipboard, session } from 'electron'
import { join, dirname, resolve, basename, extname } from 'node:path'
import { readFile, stat,mkdir } from 'node:fs/promises'
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
import { defaultShortcuts } from '../shared/shortcuts'
import { SubtitleProjectLocationError } from '../core/subtitles/project'
import { projectImportSchema,projectVideoExportSchema } from '../shared/projects'
import type { SubtitleDocument } from '../shared/types'
import { AppUpdates } from './app-updater'
import { UpdateFixture } from './update-fixture'
import { GuardedNsisUpdater } from './nsis-updater'
import { SubtitleEditorBridge } from './subtitle-editor-bridge'
import { SourceEditors,SourceEditorCloseCancelled } from './source-editors'
import { readMediaMetadata } from './media-metadata'

app.setName('Muxivra')
protocol.registerSchemesAsPrivileged([{ scheme: 'muxivra', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
if (process.env.MUXIVRA_DATA_PATH) app.setPath('userData',resolve(process.env.MUXIVRA_DATA_PATH))
const hasLock = app.requestSingleInstanceLock()
if (!hasLock) app.quit()
let window: BrowserWindow | undefined, tray: Tray | undefined, service: MediaService, mcp: McpHost, players:MpvPlayers
let quitting = false, exitInProgress = false, firstHide = true
let exitPrompt: ExitPrompt | undefined
let appUpdates: AppUpdates
let runtimeStopped=false
let subtitleEditorBridge:SubtitleEditorBridge
let sourceEditors:SourceEditors
const engineGrants = new Set<string>()
const mainLocale=()=>resolveUiLocale(service?.settings.language??'system',service?.systemLanguages??app.getPreferredSystemLanguages())
const ui=(text:string,...values:unknown[])=>translateUi(text,mainLocale(),...values)
const dialogOptions=<T extends OpenDialogOptions|SaveDialogOptions>(options:T):T=>({...options,title:options.title?ui(options.title):undefined,buttonLabel:options.buttonLabel?ui(options.buttonLabel):undefined,filters:options.filters?.map(filter=>({...filter,name:ui(filter.name)}))})
const openDialog=(options:OpenDialogOptions)=>dialog.showOpenDialog(window!,dialogOptions(options))
const saveDialog=(options:SaveDialogOptions)=>dialog.showSaveDialog(window!,dialogOptions(options))
let trayLanguage=''
function localizeTray(){if(!tray||trayLanguage===mainLocale())return;trayLanguage=mainLocale();tray.setToolTip(ui('Muxivra · 本地媒体工作台'));tray.setContextMenu(Menu.buildFromTemplate([{label:ui('打开 Muxivra'),click:()=>{window?.show();window?.focus()}},{type:'separator'},{label:ui('退出应用'),click:()=>{void requestExit()}}]))}
const devUrl = process.env.ELECTRON_RENDERER_URL
const rendererRoot = resolve(__dirname,'../renderer')

async function createWindow(): Promise<void> {
  window = new BrowserWindow({ width: 1380, height: 910, minWidth: 1040, minHeight: 720, backgroundColor: '#0c0d10', title: 'Muxivra', autoHideMenuBar: true,
    icon: join(app.getAppPath(),'resources/icon.ico'), webPreferences: { preload: join(__dirname,'../preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  subtitleEditorBridge=new SubtitleEditorBridge(()=>window);service.mcpSubtitles.access=subtitleEditorBridge
  window.webContents.on('will-navigate',event => event.preventDefault())
  players=new MpvPlayers(window,service,service.settings.shortcuts)
  players.on('state',state=>{if(window&&!window.isDestroyed())window.webContents.send('muxivra:player-state',state)})
  players.on('editor-event',event=>window?.webContents.send('muxivra:player-event',event))
  players.on('screenshot-request',owner=>{void takeScreenshot(owner).catch(error=>dialog.showErrorBox('截图失败',error.message))})
  players.on('action-error',message=>window?.webContents.send('muxivra:player-error',message))
  window.on('show',()=>players.show());window.on('restore',()=>players.show())
  window.on('hide',()=>players.hide());window.on('minimize',()=>players.hide());window.on('leave-full-screen',()=>players.syncFullscreen())
  window.on('close',event => {
    if (quitting) return
    if (exitInProgress) { event.preventDefault(); return }
    if (runtimeStopped) { event.preventDefault(); window?.show(); return }
    if (exitPrompt) setExitPrompt(undefined)
    event.preventDefault(); window?.hide()
    if (firstHide && tray && process.env.MUXIVRA_SMOKE !== '1') { firstHide = false; tray.displayBalloon({ title: 'Muxivra 仍在运行', content: '任务与 MCP 服务继续运行。双击托盘图标可打开；从托盘菜单退出应用。' }) }
  })
  window.on('closed',() => { subtitleEditorBridge.close();window = undefined })
  if (devUrl) await window.loadURL(devUrl)
  else await window.loadURL('muxivra://app/index.html')
}
async function requestExit(force = false): Promise<void> {
  if (exitInProgress) return
  if (!force) {
    setExitPrompt(undefined)
    setExitPrompt(exitSummary('confirm'))
    if (window?.isMinimized()) window.restore()
    window?.show(); window?.focus()
    return
  }
  setExitPrompt(undefined)
  await finishExit()
}
function exitSummary(phase:ExitPrompt['phase']):ExitPrompt {
  const jobs=service.queue.jobs
  return {phase,running:jobs.filter(j=>j.status==='running').length,waiting:jobs.filter(j=>j.status==='queued').length,paused:jobs.filter(j=>j.status==='paused').length,mcpRunning:!!service.mcpState.running,runtimeStopped,...(exitPrompt?.reason==='update'?{reason:'update',updateVersion:exitPrompt.updateVersion}: {})}
}
function setExitPrompt(state:ExitPrompt|undefined):void {
  exitPrompt=state
  if(window&&!window.isDestroyed())window.webContents.send('muxivra:exit-state',state)
}
async function finishExit():Promise<void> {
  if(exitInProgress)return
  const installingUpdate=exitPrompt?.reason==='update'
  if(installingUpdate)appUpdates.assertReady()
  exitInProgress=true
  setExitPrompt(exitSummary('closing'))
  try {
    await sourceEditors?.shutdown()
    runtimeStopped=true
    await players?.shutdown(); await mcp.stop(); await service.shutdown(); quitting=true
    if(installingUpdate)await appUpdates.install();else app.quit()
    tray?.destroy()
  } catch(error) {
    if(error instanceof SourceEditorCloseCancelled){setExitPrompt(undefined);return}
    quitting=false
    if(installingUpdate)appUpdates.markInstallError(error)
    setExitPrompt({...exitSummary('confirm'),error:(error as Error).message})
    throw error
  } finally { exitInProgress = false }
}
async function takeScreenshot(owner:PlayerOwner):Promise<string|undefined>{
  const state=players.state(owner)
  const selected=await saveDialog({title:'保存截图',defaultPath:`${(state.title||'screenshot').replace(/[<>:"/\\|?*]/g,'_')}-${Math.floor(state.positionMs)}.png`,filters:[{name:'PNG 图片',extensions:['png']}]})
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
  handle('openSourceEditor',async input=>{const request=z.object({path:pathSchema.optional()}).strict().optional().parse(input);if(request?.path&&!service.projects.state().items.some(project=>project.subtitles.some(track=>track.path===request.path))&&!service.paths.files.has(request.path))throw new Error('文本文件未获授权，请通过文件选择器打开');await sourceEditors.open(request?.path)})
  handle('saveSourceSubtitle',async(doc,text,hash)=>{const source=z.object({text:z.string().max(10*1024*1024),hash:z.string().regex(/^[a-f0-9]{64}$/)}).parse({text,hash});const saved=await service.projects.save(subtitleSchema.parse(doc),source);if(!saved)throw new Error('工程已切换，源码未保存');return saved})
  handle('subtitleEditorReply',reply=>{if(!reply||typeof reply!=='object'||!z.string().uuid().safeParse(reply.id).success)throw new Error('字幕回复无效');subtitleEditorBridge.reply(reply)})
  handle('asrImport',async input=>{
    const request=z.object({name:z.string().max(200),backend:z.enum(asrBackends),runtimeId:z.string().max(100).optional(),environmentId:z.string().uuid().optional()}).strict().parse(input)
    const selected=await openDialog({title:request.backend==='custom'?'导入 ASR 后端配置':request.backend==='whisper.cpp'?'导入 whisper.cpp 模型':'选择完整 ASR 模型目录',properties:request.backend==='custom'||request.backend==='whisper.cpp'?['openFile']:['openDirectory'],filters:request.backend==='custom'?[{name:'Muxivra ASR 后端',extensions:['json']}]:[{name:'Whisper GGML 模型',extensions:['bin']}]})
    if(!selected.filePaths[0])return
    let executable:string|undefined
    if(request.backend==='whisper.cpp'){
      if(request.runtimeId)executable=service.asrModels.runtime(request.runtimeId)
      else{const runtime=await openDialog({title:'选择 whisper-cli.exe（同目录需保留运行库）',properties:['openFile'],filters:[{name:'whisper.cpp 程序',extensions:['exe']}]});if(!runtime.filePaths[0])return;executable=runtime.filePaths[0]}
    }
    return service.asrImport({...request,modelPath:selected.filePaths[0],executable})
  })
  const environmentInUse=(id:string)=>service.queue.jobs.some(j=>j.plan.kind==='asr'&&j.plan.asr.model.environment?.id===id&&['queued','running','paused'].includes(j.status))
  handle('asrSaveRecognition',(id,config)=>service.asrModels.saveRecognition(z.string().uuid().parse(id),asrRecognitionSchema.parse(config)))
  handle('asrSaveEnvironment',request=>{request=asrEnvironmentRequestSchema.parse(request);if(request.id&&environmentInUse(request.id))throw new Error('此环境有未完成任务，请完成或取消后再修改');return service.asrModels.saveEnvironment(request)})
  handle('asrRefreshEnvironment',id=>service.asrModels.refreshEnvironment(z.string().uuid().parse(id)))
  handle('asrDiscoverPython',()=>service.asrModels.discoverEnvironments())
  handle('asrDownloadModel',id=>{id=asrAssetIdSchema.parse(id);if(service.asrModels.state().download.active)throw new Error('已有模型操作正在进行');void service.asrModels.downloadModel(id).catch(()=>{})})
  handle('asrBindAsset',(id,environmentId,runtimeId)=>service.asrModels.bindAsset(z.string().min(1).max(100).parse(id),z.string().uuid().optional().parse(environmentId),z.string().max(100).optional().parse(runtimeId)))
  handle('asrStoreModel',id=>{id=z.string().uuid().parse(id);if(service.queue.jobs.some(j=>j.plan.kind==='asr'&&j.plan.asr.model.id===id&&['queued','running','paused'].includes(j.status)))throw new Error('模型有未完成任务，请先完成或取消');return service.asrModels.storeModel(id)})
  handle('asrImportComponent',async role=>{role=z.literal('aligner').parse(role);const selected=await openDialog({title:'导入对齐模型',properties:['openDirectory']});if(!selected.filePaths[0])return;return service.asrModels.importComponent(selected.filePaths[0],role)})
  handle('asrRemoveEnvironment',id=>{id=z.string().uuid().parse(id);if(environmentInUse(id))throw new Error('此环境有未完成任务');return service.asrModels.removeEnvironment(id)})
  handle('asrSelectPath',async kind=>{kind=z.enum(['python','folder']).parse(kind);const selected=await openDialog({title:kind==='python'?'选择 Python 可执行文件':'选择目录',properties:kind==='python'?['openFile']:['openDirectory'],...(kind==='python'?{filters:[{name:'Python',extensions:['exe']}]}:{})});return selected.filePaths[0]})
  handle('asrRemoveModel',async id=>{id=z.string().uuid().parse(id);if(service.queue.jobs.some(j=>j.plan.kind==='asr'&&j.plan.asr.model.id===id&&['queued','running','paused'].includes(j.status)))throw new Error('该模型仍有未完成任务，请先取消任务');await service.asrModels.remove(id)})
  handle('asrDownload',(kind,runtime)=>{kind=z.enum(['model','runtime']).parse(kind);runtime=z.enum(['cpu','cuda']).default('cpu').parse(runtime);if(service.asrModels.state().download.active)throw new Error('已有 ASR 下载正在进行');void service.asrModels.install(kind,runtime).catch(()=>{})})
  handle('asrCancelDownload',()=>service.asrModels.cancelDownload())
  handle('asrDetectNvidia',()=>service.asrModels.detectNvidia())
  handle('asrDeploymentPlan',request=>service.asrModels.deploymentPlan(asrDeploymentRequestSchema.parse(request)))
  handle('asrDeployNvidia',request=>{const parsed=asrDeploymentRequestSchema.parse(request);void service.asrModels.deployNvidia(parsed).catch(()=>{})})
  handle('asrDownloadResource',request=>{const parsed=asrResourceRequestSchema.parse(request);void service.asrModels.downloadResource(parsed).catch(()=>{})})
  handle('asrImportResource',async request=>{const parsed=asrResourceRequestSchema.parse(request),selected=await openDialog({title:parsed.kind==='whisper-runtime'?'导入 Whisper CUDA 运行包目录':'导入完整资源包目录（含 muxivra-resource.json）',properties:['openDirectory']});if(!selected.filePaths[0])return;void service.asrModels.importResource(parsed,selected.filePaths[0]).catch(()=>{})})
  handle('asrConfigureModel',request=>{const parsed=asrConfigureModelSchema.parse(request);void service.asrModels.configureModel(parsed).catch(()=>{})})
  handle('asrImportModelAsset',async request=>{const parsed=z.object({name:z.string().trim().min(1).max(200),backend:z.enum(['whisper.cpp','qwen3-asr','moss-transcribe-diarize'])}).strict().parse(request),selected=await openDialog({title:'导入模型文件至安装目录',properties:parsed.backend==='whisper.cpp'?['openFile']:['openDirectory'],...(parsed.backend==='whisper.cpp'?{filters:[{name:'Whisper GGML',extensions:['bin','ggml']}]}:{})});if(!selected.filePaths[0])return;return service.asrModels.importModelAsset({...parsed,modelPath:selected.filePaths[0]})})
  handle('asrCancelDeployment',()=>service.asrModels.cancelDeployment())
  handle('asrDeploymentLog',()=>service.asrModels.deploymentLog())
  handle('downloadSources',()=>service.downloadSources.state())
  handle('saveDownloadSources',(value,revision)=>service.saveDownloadSources(downloadSourcesSchema.parse(value),z.string().regex(/^[a-f0-9]{64}$/).parse(revision)))
  handle('mcpActivity',page=>service.mcpActivity.page(z.number().int().min(1).max(10000000).parse(page)))
  handle('asrCheckNetwork',async()=>{const sources=service.downloadSources.state();return {...await checkDownloadNetwork(),sources,appVersion:APP_VERSION,platform:process.platform,architecture:process.arch}})
  handle('asrSubmit',options=>service.asrSubmit(options))
  handle('asrResult',id=>service.asrResult(z.string().uuid().parse(id)))
  handle('asrRaw',(id,index)=>service.asrRaw(z.string().uuid().parse(id),z.number().int().min(0).max(100000).parse(index)))
  handle('appUpdateState',()=>appUpdates.state)
  handle('openAppLink',kind=>{const urls={repository:'https://github.com/MaidTendouAris/Muxivra',issues:'https://github.com/MaidTendouAris/Muxivra/issues',releases:'https://github.com/MaidTendouAris/Muxivra/releases'};return shell.openExternal(urls[z.enum(['repository','issues','releases']).parse(kind)])})
  handle('checkAppUpdate',()=>appUpdates.check())
  handle('downloadAppUpdate',()=>appUpdates.download())
  handle('installAppUpdate',()=>{
    if(exitInProgress)return
    appUpdates.assertReady()
    setExitPrompt({...exitSummary('confirm'),reason:'update',updateVersion:appUpdates.state.version})
    if(window?.isMinimized())window.restore()
    window?.show();window?.focus()
  })
  handle('mcpRequests',()=>service.mcpRequests())
  handle('mcpRequest',id=>service.mcpRequest(z.string().uuid().parse(id)))
  handle('reviewMcpRequest',(id,approve,note)=>service.reviewMcpRequest(z.string().uuid().parse(id),z.boolean().parse(approve),z.string().max(1000).optional().parse(note)))
  handle('exitState',()=>exitPrompt)
  handle('requestExit',()=>requestExit())
  handle('respondToExit',async confirm=>{
    z.boolean().parse(confirm)
    if(exitInProgress)return
    if(!exitPrompt)throw new Error('没有待确认的退出请求')
    if(!confirm&&runtimeStopped)throw new Error('后台服务已停止，请重试安装或退出应用')
    if(confirm)await finishExit();else setExitPrompt(undefined)
  })
  handle('selectFiles',async (kind,multiple) => {
    z.enum(['media','subtitle','subtitle-burn']).parse(kind); z.boolean().optional().parse(multiple)
    const selected = await openDialog({ properties: multiple ? ['openFile','multiSelections'] : ['openFile'], filters: kind === 'subtitle' ? [{ name: '字幕', extensions: ['srt','ass','ssa'] }] : kind==='subtitle-burn'?[{name:'烧录字幕',extensions:['srt','ass','ssa']}]:[{ name: '媒体文件', extensions: ['mp4','mkv','mov','avi','webm','m4v','m4a','mp3','wav','flac','ogg','aac','ts','png','jpg','webp','gif'] },{ name: '所有文件', extensions: ['*'] }] })
    return Promise.all(selected.filePaths.map(path => service.paths.grantFile(path)))
  })
  handle('selectDirectory',async purpose => {
    z.enum(['output','engine','mcp-input','mcp-output']).parse(purpose)
    const selected = await openDialog({ title: purpose === 'engine' ? '选择包含 ffmpeg.exe 和 ffprobe.exe 的 bin 目录' : '选择目录', properties: ['openDirectory'] })
    if (!selected.filePaths[0]) return undefined
    const path = await service.paths.grantDirectory(selected.filePaths[0]); if (purpose === 'engine') engineGrants.add(path); return path
  })
  handle('acceptDrop',async paths => { z.array(pathSchema).max(500).parse(paths); return Promise.all(paths.map((path: string) => service.paths.grantFile(path))) })
  handle('mediaMetadata',async path=>readMediaMetadata(await service.paths.input(pathSchema.parse(path))))
  handle('importLyrics',async()=>{
    const selected=await openDialog({title:'导入歌词',properties:['openFile'],filters:[{name:'歌词文本',extensions:['lrc','txt']}]})
    if(!selected.filePaths[0])return
    const path=await service.paths.grantFile(selected.filePaths[0]);if((await stat(path)).size>64000)throw new Error('歌词文件不能超过 64 KB')
    const text=new TextDecoder('utf-8',{fatal:true}).decode(await readFile(path)).replace(/^\uFEFF/,'')
    if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))throw new Error('歌词文件需要使用 UTF-8 文本格式')
    return text
  })
  handle('reviewCommand',(request,command)=>service.reviewCommand(request,z.string().max(100000).parse(command)))
  handle('submitCommand',reviewId=>service.submitCommand(z.string().uuid().parse(reviewId)))
  handle('inspect',path => service.inspect(path)); handle('plan',request => service.plan(request)); handle('submit',(requests,key) => service.submit(requests,'gui',key))
  handle('planBatch',requests => service.planBatch(requests))
  handle('cancel',id => service.cancel(z.string().uuid().parse(id))); handle('retry',id => service.retry(z.string().uuid().parse(id)))
  handle('pause',id=>service.pause(z.string().uuid().parse(id)));handle('resume',id=>service.resume(z.string().uuid().parse(id)))
  handle('moveJob',(id,direction)=>service.moveJob(z.string().uuid().parse(id),z.enum(['up','down','first','last']).parse(direction)))
  handle('jobDetails',id=>service.job(z.string().uuid().parse(id)))
  handle('deleteJobRecords',ids=>service.deleteJobRecords(z.array(z.string().uuid()).min(1).max(1000).parse(ids)))
  handle('readLogPage',(id,offset)=>service.queue.logPage(z.string().uuid().parse(id),z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0).parse(offset)))
  handle('refreshHardware',()=>service.refreshHardware())
  handle('systemUsage',()=>service.usage.read())
  handle('detectEngine',() => service.detect())
  handle('useEngine',path => { z.string().parse(path); if (!service.snapshot().engines.some(e => e.id === path) && !engineGrants.has(path)) throw new Error('请先选择引擎目录'); return service.selectEngine(path) })
  handle('downloadEngine',() => service.downloadEngine())
  handle('saveSettings',settings => service.saveSettings(settings)); handle('savePreset',preset => service.savePreset(preset)); handle('deletePreset',id => service.deletePreset(z.string().parse(id)))
  handle('componentCapabilities',(kind,name)=>service.componentCapabilities(z.enum(['videoEncoder','audioEncoder','filter']).parse(kind),z.string().regex(/^[a-zA-Z0-9_]{1,80}$/).parse(name)))
  handle('importPresets',async()=>{const selected=await openDialog({title:'导入预设',properties:['openFile'],filters:[{name:'Muxivra 预设',extensions:['json']}]});if(!selected.filePaths[0])return;return service.importPresetFile(await service.paths.grantFile(selected.filePaths[0]))})
  handle('exportPresets',async ids=>{z.array(z.string()).min(1).max(200).parse(ids);const selected=await saveDialog({title:'导出预设',defaultPath:'muxivra-presets.json',filters:[{name:'Muxivra 预设',extensions:['json']}]});if(!selected.filePath)return;await service.paths.grantDirectory(dirname(selected.filePath));await service.exportPresetFile(ids,selected.filePath);return selected.filePath})
  const archiveProject=async(id:string)=>{
    id=z.string().uuid().parse(id);const project=service.projects.get(id)
    if(service.queue.jobs.some(j=>j.plan.projectId===id&&['queued','running','paused'].includes(j.status)))throw new Error('项目仍有未结束任务，请先取消或完成任务')
    await players.releaseProject(project.directory)
    return service.archiveProject(id)
  }
  handle('importProject',request=>service.importProject(projectImportSchema.parse(request)))
  handle('importProjectSubtitle',(id,path)=>service.importProjectSubtitle(z.string().uuid().parse(id),pathSchema.parse(path)))
  handle('projectEmbeddedSubtitles',id=>service.projectEmbeddedSubtitles(z.string().uuid().parse(id)))
  handle('importEmbeddedProjectSubtitle',(id,index)=>service.importEmbeddedProjectSubtitle(z.string().uuid().parse(id),z.number().int().min(0).max(10000).parse(index)))
  handle('cancelProjectImport',()=>service.projects.cancelImport())
  handle('rebuildProjectAnalysis',id=>service.rebuildProjectAnalysis(z.string().uuid().parse(id)))
  handle('openProject',id=>service.openProject(z.string().uuid().parse(id)))
  handle('closeProject',async id=>{id=z.string().uuid().parse(id);if(service.projects.state().activeId!==id)return;await players.releaseProject(service.projects.get(id).directory);await service.closeProject(id)})
  handle('renameProject',(id,name)=>service.projects.rename(z.string().uuid().parse(id),z.string().trim().min(1).max(150).parse(name)))
  handle('archiveProject',archiveProject)
  handle('restoreProject',id=>service.projects.restore(z.string().uuid().parse(id)))
  handle('duplicateProject',()=>service.duplicateProject())
  handle('selectProjectSubtitle',(projectId,id)=>service.projects.selectSubtitle(z.string().uuid().parse(projectId),z.string().uuid().parse(id)))
  handle('createProjectSubtitle',(projectId,name)=>service.projects.createSubtitle(z.string().uuid().parse(projectId),z.string().trim().min(1).max(180).optional().parse(name)))
  handle('renameProjectSubtitle',(projectId,id,name)=>service.projects.renameSubtitle(z.string().uuid().parse(projectId),z.string().uuid().parse(id),z.string().trim().min(1).max(180).parse(name)))
  handle('deleteProjectSubtitle',(projectId,id)=>service.projects.deleteSubtitle(z.string().uuid().parse(projectId),z.string().uuid().parse(id)))
  handle('exportProjectVideo',async input=>{
    const request=projectVideoExportSchema.parse(input),project=service.projects.active();if(!project)throw new Error('请先打开项目')
    const directory=join(project.directory,'exports');await mkdir(directory,{recursive:true})
    const selected=await saveDialog({title:request.mode==='burn'?'导出烧录字幕视频':'导出字幕封装视频',defaultPath:join(directory,`${basename(project.mediaPath,extname(project.mediaPath))}-${request.mode}.${request.container}`),filters:[{name:request.container.toUpperCase(),extensions:[request.container]}]})
    if(!selected.filePath)return;await service.paths.grantDirectory(dirname(selected.filePath));return service.exportProjectVideo(request,selected.filePath)
  })
  handle('readSubtitles',path => service.readSubtitles(pathSchema.parse(path))); handle('openSubtitleMedia',path=>service.openSubtitleMedia(pathSchema.parse(path)))
  handle('saveSession',doc => service.saveSession(doc)); handle('getSession',() => service.getSession())
  handle('getSubtitleProjectState',()=>service.subtitleProjects.state())
  handle('saveSubtitleProject',doc=>service.saveSubtitleProject(subtitleSchema.parse(doc)))
  handle('prepareSubtitleMedia',doc=>service.prepareSubtitleMedia(subtitleSchema.parse(doc)))
  handle('saveSubtitleProjectAs',doc=>service.saveSubtitleProjectAs(subtitleSchema.parse(doc)))
  handle('deleteSubtitleProject',async id=>{if(service.subtitleProjects.get()?.id!==z.string().uuid().parse(id))throw new Error('当前工程已切换');return archiveProject(service.projects.active()!.id)})
  handle('subtitleExportLosses',(doc,format)=>service.subtitleExportLosses(doc,z.enum(['ass','ssa','srt']).parse(format)))
  handle('readClipboardText',()=>clipboard.readText())
  handle('exportSubtitles',async (doc,format) => {
    format=z.enum(['ass','ssa','srt']).default('ass').parse(format)
    doc=subtitleSchema.parse(doc)
    const project=service.projects.active();const directory=project?join(project.directory,'exports'):service.defaultOutputPath!;await mkdir(directory,{recursive:true})
    const base=join(directory,doc.projectPath?basename(doc.projectPath,'.ass'):'subtitles')
    const selected = await saveDialog({ title: `导出 ${format.toUpperCase()} 字幕`, defaultPath: `${base}-export.${format}`, filters: [{ name: `${format.toUpperCase()} 字幕`, extensions: [format] }] })
    if (!selected.filePath) return undefined
    if(extname(selected.filePath).toLowerCase()!==`.${format}`)throw new Error('导出文件扩展名与所选格式不一致')
    await service.paths.grantDirectory(dirname(selected.filePath)); await service.exportSubtitles(doc,selected.filePath,format); return selected.filePath
  })
  handle('inspectPlayback',path=>service.inspectPlayback(pathSchema.parse(path)))
  handle('playerState',owner=>players.state(playerOwnerSchema.parse(owner)))
  handle('playerOpen',(owner,paths,append)=>players.open(playerOwnerSchema.parse(owner),z.array(pathSchema).min(1).max(500).parse(paths),z.boolean().optional().parse(append)))
  handle('playerRect',(owner,rect)=>players.rect(playerOwnerSchema.parse(owner),playerRectSchema.parse(rect)))
  handle('playerAction',(owner,action)=>players.action(playerOwnerSchema.parse(owner),playerActionSchema.parse(action)))
  handle('playerMedia',owner=>players.media(playerOwnerSchema.parse(owner)))
  handle('playerScreenshot',owner=>takeScreenshot(playerOwnerSchema.parse(owner)))
  handle('playerSubtitles',(owner,document)=>players.subtitles(playerOwnerSchema.parse(owner),subtitleSchema.parse(document)))
  handle('playerAddTrack',async(owner,kind)=>{owner=playerOwnerSchema.parse(owner);kind=z.enum(['audio','subtitle']).parse(kind);const selected=await openDialog({title:kind==='audio'?'载入音轨':'载入字幕',properties:['openFile'],filters:[kind==='audio'?{name:'音频',extensions:['m4a','mp3','wav','flac','ogg','aac','ac3','dts']}:{name:'字幕',extensions:['srt','ass','ssa','vtt']}]});if(selected.filePaths[0])await players.addTrack(owner,await service.paths.grantFile(selected.filePaths[0]),kind)})
  handle('videoFrames',path=>service.videoFrames(pathSchema.parse(path)));handle('videoFrameProgress',()=>service.videoFrameProgress());handle('cancelVideoFrames',()=>service.cancelVideoFrames())
  handle('importSubtitleStyles',path=>service.importSubtitleStyles(pathSchema.parse(path)))
  handle('subtitleTools',()=>service.subtitleTools());handle('saveSubtitleTools',value=>service.saveSubtitleTools(value))
  handle('waveform',(path,options) => service.waveform(path,options))
  handle('reveal',async path => {
    pathSchema.parse(path)
    const jobs = service.snapshot().jobs
    const project=service.projects.state().items.find(p=>[p.directory,p.mediaPath,p.subtitlePath].includes(path));if(project)await service.projects.validate(project.id)
    if (!project&&!jobs.some(job => job.plan.input.path === path || job.plan.outputPath === path || job.logPath === path) && !service.paths.files.has(path) && path !== service.dataPath && path !== service.enginePath) throw new Error('路径未获授权')
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
  initializeDownloadNetworking()
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
  const engines = process.env.MUXIVRA_ENGINE_PATH ? resolve(process.env.MUXIVRA_ENGINE_PATH) : join(app.isPackaged?dirname(app.getPath('exe')):app.getAppPath(),'engines','ffmpeg')
  const outputs = join(app.isPackaged?dirname(app.getPath('exe')):app.getAppPath(),'outputs')
  const projects=process.env.MUXIVRA_SMOKE==='1'?join(data,'projects'):join(dirname(outputs),'projects')
  service = new MediaService(data,engines,outputs,join(__dirname,'hardware-worker.js'),projects,app.isPackaged?join(process.resourcesPath,'asr','adapter.py'):join(app.getAppPath(),'resources','asr','adapter.py'),process.env.MUXIVRA_SMOKE==='1'?join(data,'installation'):undefined); service.systemLanguages=process.env.MUXIVRA_SMOKE==='1'&&process.env.MUXIVRA_TEST_SYSTEM_LANGUAGES?process.env.MUXIVRA_TEST_SYSTEM_LANGUAGES.split(','):app.getPreferredSystemLanguages(); await service.initialize(); mcp = new McpHost(service)
  const testUpdates=process.env.MUXIVRA_SMOKE==='1'&&process.env.MUXIVRA_UPDATE_TEST==='1'
  const fixture=testUpdates?new UpdateFixture(()=>app.quit(),APP_VERSION):undefined
  const updater=fixture??(app.isPackaged&&process.platform==='win32'&&process.env.MUXIVRA_SMOKE!=='1'?new GuardedNsisUpdater():undefined)
  if(updater&&!fixture){
    const nativeUpdater=updater as GuardedNsisUpdater
    nativeUpdater.disableWebInstaller=true
    // GitHub cannot serve the previous release's blockmap from the new release.
    // A full installer also supports users skipping several releases.
    nativeUpdater.disableDifferentialDownload=true
  }
  appUpdates=new AppUpdates(updater,APP_VERSION,process.env.MUXIVRA_SMOKE==='1'?'自动测试模式不连接更新服务器':'开发模式不检查应用更新，请使用 Windows 安装版。')
  appUpdates.on('state',state=>{if(window&&!window.isDestroyed())window.webContents.send('muxivra:app-update',state)})
  if(fixture)Object.defineProperty(globalThis,'__muxivraUpdateTest',{value:(request:unknown)=>{
    if(request!==undefined){
      const value=z.object({mode:z.enum(['available','current','error','download-error','downloaded','install-error']),delayMs:z.number().min(50).max(3000).optional()}).parse(request)
      fixture.mode=value.mode;if(value.delayMs!==undefined)fixture.delayMs=value.delayMs
      if(value.mode==='downloaded'){fixture.emit('update-available',fixture.release);fixture.emit('update-downloaded',fixture.release)}
    }
    return {state:appUpdates.state,checks:fixture.checks,downloads:fixture.downloads,installs:fixture.installs}
  }})
  service.beforeSaveSettings = async settings => {await mcp.configure(settings.mcp);await players?.setShortcuts(settings.shortcuts??defaultShortcuts)}
  if (service.settings.mcp.enabled) { try { await mcp.configure(service.settings.mcp) } catch (e) { service.mcpState = { running: false, error: (e as Error).message } } }
  let updateTimer: ReturnType<typeof setTimeout> | undefined
  service.on('update',() => { localizeTray(); if (updateTimer) return; updateTimer = setTimeout(() => { updateTimer = undefined; if (window && !window.isDestroyed()) window.webContents.send('muxivra:update',service.snapshot()) },150) })
  sourceEditors=new SourceEditors(service,()=>subtitleEditorBridge,devUrl,join(__dirname,'../preload/source-editor.js'),()=>window)
  registerIpc()
  tray = new Tray(nativeImage.createFromPath(join(app.getAppPath(),'resources/icon.png')).resize({ width: 32,height: 32 }))
  localizeTray()
  tray.on('double-click',() => { window?.show(); window?.focus() })
  await createWindow()
  // Check once per process launch, after the first window is ready. A failed
  // network request changes updater state without delaying the application.
  void appUpdates.startup(service.snapshot().settings.autoUpdate!==false)
  // Automated desktop checks run in an isolated profile and can exit without an interactive prompt.
  if (process.env.MUXIVRA_SMOKE === '1') {
    ipcMain.handle('muxivra:smoke-exit',() => requestExit(true))
    ipcMain.handle('muxivra:smoke-player-diagnostics',() => players.diagnostics())
  }
}).catch(async error => { dialog.showErrorBox('Muxivra 启动失败',String(error)); quitting = true; await players?.shutdown().catch(()=>{});await mcp?.stop().catch(()=>{});await service?.shutdown().catch(() => {}); app.quit() })
