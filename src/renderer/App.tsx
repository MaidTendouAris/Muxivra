import { tr, setUiLanguage } from './lib/i18n'
import { useState, useEffect, useCallback, useRef } from 'react'
import { Layers3, Film, ListVideo, Captions, Settings2, ArrowUpRight, AlertCircle, X, CheckCircle2, MessageSquare, SlidersHorizontal,AudioLines } from 'lucide-react'
import type { Snapshot, ExitPrompt, Settings as SettingsType } from '../shared/types'
import { Button, Busy, Modal } from './components/ui'
import type { RunAction } from './components/Jobs'
import { APP_VERSION } from '../shared/version'
import { Single } from './pages/Single'
import { Batch } from './pages/Batch'
import { Subtitles } from './pages/Subtitles'
import { Settings } from './pages/Settings'
import { Presets } from './pages/Presets'
import { Tasks } from './pages/Tasks'
import { ExitDialog } from './components/ExitDialog'
import { McpInteraction } from './pages/McpInteraction'
import { ShortcutProvider } from './components/ShortcutProvider'
import type { AppUpdateState } from '../shared/app-update'
import { AppUpdateNotice } from './components/AppUpdate'
import { AsrWorkbench } from './pages/AsrWorkbench'
import type { SubtitleMediaTransfer } from '../shared/subtitle-media'
import { Projects } from './pages/Projects'
import { Folder } from 'lucide-react'

const pages = [
  { id: 'single', label: '单文件', icon: Film,group:'Media' },
  { id: 'batch', label: '批量处理', icon: ListVideo,group:'Media' },
  { id: 'projects', label: '项目管理', icon: Folder,group:'Sub' },
  { id: 'subtitles', label: '字幕编辑', icon: Captions,group:'Sub' },
  { id: 'asr', label: 'ASR 工作台', icon: AudioLines,group:'Sub' },
  { id: 'tasks', label: '任务', icon: Layers3,group:'' },
  { id: 'mcp', label: 'MCP 交互', icon: MessageSquare,group:'' },
  { id: 'presets', label: '预设', icon: SlidersHorizontal,group:'' },
  { id: 'settings', label: '设置', icon: Settings2,group:'' }
]
export function App() {
  const [snapshot,setSnapshot] = useState<Snapshot>(), [page,setPage] = useState('single'), [pending,setPending] = useState(0), [fatal,setFatal] = useState(''), [toast,setToast] = useState<{ message: string; error: boolean }>()
  const locale=setUiLanguage(snapshot?.settings.language??'system',snapshot?.systemLanguages??navigator.languages)
  useEffect(()=>{document.documentElement.lang=locale},[locale])
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [exitPrompt,setExitPrompt]=useState<ExitPrompt>()
  const [settingsDraft,setSettingsDraft]=useState<SettingsType>(),[leaveSettings,setLeaveSettings]=useState<string>(),[savingSettings,setSavingSettings]=useState(false)
  const [appUpdate,setAppUpdate]=useState<AppUpdateState>({phase:'idle',currentVersion:APP_VERSION,percent:0,transferred:0,total:0,bytesPerSecond:0,message:tr("等待检查更新")})
  const [updatePending,setUpdatePending]=useState<'check'|'download'|'install'>()
  const updateRequestRunning=useRef(false)
  const savedSettings=JSON.stringify(snapshot?.settings)
  const subtitleFlush=useRef<(()=>Promise<void>)|undefined>(undefined)
  const subtitleExitFlush=useRef<(()=>Promise<void>)|undefined>(undefined)
  const subtitleLeaving=useRef(false)
  const [asrJobId,setAsrJobId]=useState<string>()
  const [singleTransfer,setSingleTransfer]=useState<SubtitleMediaTransfer>()
  const consumeAsr=useCallback(()=>setAsrJobId(undefined),[])
  const registerSubtitleFlush=useCallback((save:()=>Promise<void>)=>{subtitleFlush.current=save},[])
  const registerSubtitleExitFlush=useCallback((save:()=>Promise<void>)=>{subtitleExitFlush.current=save},[])
  useEffect(()=>{if(snapshot)setSettingsDraft(snapshot.settings)},[savedSettings])
  const navigate=(target:string)=>{
    if(target===page)return
    if(page==='settings'&&settingsDraft&&JSON.stringify(settingsDraft)!==savedSettings)setLeaveSettings(target)
    else if(page==='subtitles'){if(subtitleLeaving.current)return;subtitleLeaving.current=true;void run(async()=>{try{await subtitleFlush.current?.();setPage(target)}finally{subtitleLeaving.current=false}})}
    else setPage(target)
  }
  const applyAndLeave=async()=>{
    if(!settingsDraft||!leaveSettings)return
    setSavingSettings(true)
    try {
      const next=await run(()=>window.muxivra.saveSettings(settingsDraft),tr("设置已应用"))
      if(next){setSnapshot(next);setSettingsDraft(next.settings);const target=leaveSettings;setLeaveSettings(undefined);await completeSettingsTransition(target)}
    }finally{setSavingSettings(false)}
  }
  const run: RunAction = useCallback(async (operation,success) => {
    setPending(value => value+1)
    try { const result = await operation(); if (success && result !== undefined) { setToast({ message: success,error: false }); clearTimeout(timer.current); timer.current = setTimeout(() => setToast(undefined),5000) } return result }
    catch (error) { setToast({ message: (error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,''),error: true }); clearTimeout(timer.current); return undefined }
    finally { setPending(value => value-1) }
  },[])
  const updateRequest=async(action:'check'|'download'|'install')=>{
    if(updateRequestRunning.current)return
    updateRequestRunning.current=true;setUpdatePending(action)
    try {
      if(action==='install')await window.muxivra.installAppUpdate()
      else if(action==='download')await window.muxivra.downloadAppUpdate()
      else await window.muxivra.checkAppUpdate()
    }catch(error){setAppUpdate(current=>({...current,phase:'error',error:(error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,''),message:tr("更新操作失败")}))}
    finally{updateRequestRunning.current=false;setUpdatePending(undefined)}
  }
  const completeSettingsTransition=async(target:string)=>{
    if(target==='__app_update__')await updateRequest('install')
    else setPage(target)
  }
  const requestInstall=async()=>{
    if(settingsDraft&&JSON.stringify(settingsDraft)!==savedSettings){setLeaveSettings('__app_update__');return}
    await updateRequest('install')
  }
  const updateControls={state:appUpdate,pending:updatePending,onCheck:()=>updateRequest('check'),onDownload:()=>updateRequest('download'),onInstall:requestInstall}
  useEffect(() => {
    if (!window.muxivra) { setFatal(tr("请通过 Electron 桌面应用启动 Muxivra，浏览器不具备本机媒体处理接口。")); return }
    const unsubscribe = window.muxivra.onUpdate(setSnapshot)
    let live=true,exitEvent=false,updateEvent=false
    const stopAppUpdate=window.muxivra.onAppUpdate(state=>{updateEvent=true;if(live)setAppUpdate(state)})
    void window.muxivra.appUpdateState().then(state=>{if(live&&!updateEvent)setAppUpdate(state)}).catch(error=>{if(live)setAppUpdate(current=>({...current,phase:'error',message:tr("无法读取更新状态"),error:error.message}))})
    const stopExit=window.muxivra.onExitState(state=>{exitEvent=true;if(live)setExitPrompt(state)})
    void window.muxivra.exitState().then(state=>{if(live&&!exitEvent)setExitPrompt(state)}).catch(error=>setFatal(error.message))
    const stopErrors=window.muxivra.onPlayerError(message=>{setToast({message,error:true});clearTimeout(timer.current)})
    void window.muxivra.snapshot().then(setSnapshot).catch(error => setFatal(error.message))
    return()=>{live=false;unsubscribe();stopErrors();stopExit();stopAppUpdate()}
  },[])
  useEffect(() => {
    const preference = snapshot?.settings.theme ?? 'dark'
    const query = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => document.documentElement.dataset.theme = preference === 'system' ? query.matches ? 'dark' : 'light' : preference
    apply(); query.addEventListener('change',apply); return () => query.removeEventListener('change',apply)
  },[snapshot?.settings.theme])
  const current = pages.find(item => item.id === page)!
  const running = snapshot?.jobs.filter(job => ['queued','running','paused'].includes(job.status)).length ?? 0
  if (fatal) return <main className="fatal"><AlertCircle size={30}/><h2>{tr("无法启动工作台")}</h2><p>{fatal}</p></main>
  if (!snapshot) return <main className="fatal"><Busy text={tr("正在准备媒体工作台…")}/></main>
  return <ShortcutProvider bindings={snapshot.settings.shortcuts}><div className="app-shell"><aside className="navigation"><div className="brand"><div className="brand-symbol">M</div><div className="brand-wordmark"><span>Muxivra</span><small>MEDIA WORKSPACE</small></div></div><nav>{['Media','Sub',''].map(group => <section className={`nav-group${group?'':' nav-group-common'}`} key={group||'common'} aria-label={group||tr("其他功能")}>{group&&<div className="nav-section">{tr(group)}</div>}{pages.filter(item=>item.group===group).map(item =><button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)}><item.icon size={19}/><span>{tr(item.label)}</span>{item.id === 'tasks' && running > 0 && <span className="nav-count">{running}</span>}{item.id==='mcp'&&snapshot.mcpRequests.pending>0&&<span className="nav-count">{snapshot.mcpRequests.pending}</span>}</button>)}</section>)}</nav><div className="nav-footer"><button className="engine-status" onClick={() => navigate('settings')}><span className={`status-dot ${snapshot.engine ? 'ready' : ''}`}/><span>{snapshot.engine ? tr("FFmpeg 已就绪") : tr("配置 FFmpeg")}</span><ArrowUpRight size={14}/></button><div className="version">v{APP_VERSION} <span>GPL v3</span></div></div></aside>
    <main className={`workspace${page==='subtitles'?' subtitle-workspace-page':''}`}><header className="workspace-header"><h1>{tr(current.label)}</h1><div className="header-status">{pending > 0 && <div className="operation-status" role="status"><Busy text={tr("正在处理…")}/><div className="activity-line"/></div>}</div></header>{(snapshot.notice || !snapshot.engine) && <div className="notice"><AlertCircle size={17}/><span>{snapshot.notice ?? tr("未配置 FFmpeg，转码和波形功能不可用。")}</span><Button variant="ghost" size="sm" onClick={() => navigate('settings')}>{tr("打开设置")}</Button></div>}
    <AppUpdateNotice {...updateControls} onSettings={()=>navigate('settings')}/>
    <div className="page-content"><div hidden={page !== 'single'}><Single transfer={singleTransfer} snapshot={snapshot} run={run} busy={pending > 0} visible={page === 'single'} onSubmitted={()=>navigate('tasks')}/></div><div hidden={page !== 'batch'}><Batch snapshot={snapshot} run={run} busy={pending > 0} onSubmitted={()=>navigate('tasks')}/></div><div hidden={page !== 'tasks'}><Tasks snapshot={snapshot} run={run} busy={pending>0} visible={page==='tasks'}/></div><div hidden={page!=='mcp'}><McpInteraction snapshot={snapshot} visible={page==='mcp'} run={run} busy={pending>0} onSettings={()=>navigate('settings')} onTasks={()=>navigate('tasks')}/></div><div hidden={page !== 'asr'}><AsrWorkbench snapshot={snapshot} run={run} busy={pending>0||!!snapshot.asr?.deployment?.active} visible={page==='asr'} onProjects={()=>navigate('projects')} onTasks={()=>navigate('tasks')} onEdit={id=>{setAsrJobId(id);navigate('subtitles')}}/></div><div hidden={page !== 'subtitles'}><Subtitles onSingle={transfer=>{setSingleTransfer(transfer);setPage('single')}} snapshot={snapshot} projectId={snapshot.projects?.activeId} onTasks={()=>navigate('tasks')} onProjects={()=>navigate('projects')} asrJobId={asrJobId} onAsrConsumed={consumeAsr} run={run} busy={pending > 0} visible={page === 'subtitles'} onBeforeLeave={registerSubtitleFlush} onBeforeExit={registerSubtitleExitFlush}/></div><div hidden={page !== 'projects'}><Projects snapshot={snapshot} run={run} busy={pending>0} onOpen={navigate}/></div><div hidden={page !== 'presets'}><Presets snapshot={snapshot} run={run} busy={pending > 0}/></div><div hidden={page !== 'settings'}><Settings snapshot={snapshot} draft={settingsDraft??snapshot.settings} onChange={setSettingsDraft} run={run} busy={pending > 0} appUpdate={updateControls}/></div></div></main>
    {toast && <div className={`toast ${toast.error ? 'toast-error' : ''}`} role="alert">{toast.error ? <AlertCircle size={20}/> : <CheckCircle2 size={20}/>}<p>{tr(toast.message)}</p><Button variant="ghost" size="icon" aria-label={tr("关闭提示")} onClick={() => setToast(undefined)}><X size={16}/></Button></div>}
    {exitPrompt&&<ExitDialog state={exitPrompt} run={run} beforeConfirm={()=>subtitleExitFlush.current?.()??Promise.resolve()}/>}
    {leaveSettings&&<Modal title={tr("应用设置更改？")} onClose={()=>setLeaveSettings(undefined)} locked={savingSettings||pending>0} className="settings-leave-dialog"><p>{leaveSettings==='__app_update__'?tr("重启安装前，需要处理尚未保存的设置。应用此次修改，或放弃更改后继续。"):tr("设置有尚未保存的更改。应用更改后再离开，或放弃此次修改。")}</p><div className="settings-leave-actions"><Button variant="ghost" disabled={savingSettings||pending>0} onClick={()=>setLeaveSettings(undefined)}>{tr("继续编辑")}</Button><Button variant="secondary" disabled={savingSettings||pending>0} onClick={async()=>{setSettingsDraft(snapshot.settings);const target=leaveSettings;setLeaveSettings(undefined);await completeSettingsTransition(target)}}>{tr("放弃更改")}</Button><Button disabled={savingSettings||pending>0} loadingText={tr("正在应用…")} onClick={applyAndLeave}>{leaveSettings==='__app_update__'?tr("应用并继续"):tr("应用并离开")}</Button></div></Modal>}
  </div></ShortcutProvider>
}
