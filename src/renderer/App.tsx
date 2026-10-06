import { useState, useEffect, useCallback, useRef } from 'react'
import { Layers3, Film, ListVideo, Captions, Settings2, ArrowUpRight, AlertCircle, X, CheckCircle2, Loader2, SlidersHorizontal } from 'lucide-react'
import type { Snapshot, ExitPrompt } from '../shared/types'
import { Button, Busy } from './components/ui'
import type { RunAction } from './components/Jobs'
import { APP_VERSION } from '../shared/version'
import { Single } from './pages/Single'
import { Batch } from './pages/Batch'
import { Subtitles } from './pages/Subtitles'
import { Settings } from './pages/Settings'
import { Presets } from './pages/Presets'
import { Tasks } from './pages/Tasks'
import { ExitDialog } from './components/ExitDialog'

const pages = [
  { id: 'single', label: '单文件', icon: Film },
  { id: 'batch', label: '批量处理', icon: ListVideo },
  { id: 'tasks', label: '任务', icon: Layers3 },
  { id: 'subtitles', label: '字幕编辑', icon: Captions },
  { id: 'presets', label: '预设', icon: SlidersHorizontal },
  { id: 'settings', label: '设置', icon: Settings2 }
]
export function App() {
  const [snapshot,setSnapshot] = useState<Snapshot>(), [page,setPage] = useState('single'), [pending,setPending] = useState(0), [fatal,setFatal] = useState(''), [toast,setToast] = useState<{ message: string; error: boolean }>()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [exitPrompt,setExitPrompt]=useState<ExitPrompt>()
  const run: RunAction = useCallback(async (operation,success) => {
    setPending(value => value+1)
    try { const result = await operation(); if (success && result !== undefined) { setToast({ message: success,error: false }); clearTimeout(timer.current); timer.current = setTimeout(() => setToast(undefined),5000) } return result }
    catch (error) { setToast({ message: (error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,''),error: true }); clearTimeout(timer.current); return undefined }
    finally { setPending(value => value-1) }
  },[])
  useEffect(() => {
    if (!window.muxivra) { setFatal('请通过 Electron 桌面应用启动 Muxivra，浏览器不具备本机媒体处理接口。'); return }
    const unsubscribe = window.muxivra.onUpdate(setSnapshot)
    let live=true,exitEvent=false
    const stopExit=window.muxivra.onExitState(state=>{exitEvent=true;if(live)setExitPrompt(state)})
    void window.muxivra.exitState().then(state=>{if(live&&!exitEvent)setExitPrompt(state)}).catch(error=>setFatal(error.message))
    const stopErrors=window.muxivra.onPlayerError(message=>{setToast({message,error:true});clearTimeout(timer.current)})
    void window.muxivra.snapshot().then(setSnapshot).catch(error => setFatal(error.message))
    return()=>{live=false;unsubscribe();stopErrors();stopExit()}
  },[])
  useEffect(() => {
    const preference = snapshot?.settings.theme ?? 'dark'
    const query = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => document.documentElement.dataset.theme = preference === 'system' ? query.matches ? 'dark' : 'light' : preference
    apply(); query.addEventListener('change',apply); return () => query.removeEventListener('change',apply)
  },[snapshot?.settings.theme])
  const current = pages.find(item => item.id === page)!
  const running = snapshot?.jobs.filter(job => ['queued','running','paused'].includes(job.status)).length ?? 0
  if (fatal) return <main className="fatal"><AlertCircle size={30}/><h2>无法启动工作台</h2><p>{fatal}</p></main>
  if (!snapshot) return <main className="fatal"><Busy text="正在准备媒体工作台…"/></main>
  return <div className="app-shell"><aside className="navigation"><div className="brand"><div className="brand-symbol">M</div><div className="brand-wordmark"><span>Muxivra</span><small>MEDIA WORKSPACE</small></div></div><nav>{pages.map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => setPage(item.id)}><item.icon size={19}/><span>{item.label}</span>{item.id === 'tasks' && running > 0 && <span className="nav-count">{running}</span>}</button>)}</nav><div className="nav-footer"><button className="engine-status" onClick={() => setPage('settings')}><span className={`status-dot ${snapshot.engine ? 'ready' : ''}`}/><span>{snapshot.engine ? 'FFmpeg 已就绪' : '配置 FFmpeg'}</span><ArrowUpRight size={14}/></button><div className="version">v{APP_VERSION} <span>GPL v3</span></div></div></aside>
    <main className="workspace"><header className="workspace-header"><h1>{current.label}</h1><div className="header-status">{pending > 0 && <div className="operation-status" role="status"><Busy text="正在处理…"/><div className="activity-line"/></div>}</div></header>{(snapshot.notice || !snapshot.engine) && <div className="notice"><AlertCircle size={17}/><span>{snapshot.notice ?? '未配置 FFmpeg，转码和波形功能不可用。'}</span><Button variant="ghost" size="sm" onClick={() => setPage('settings')}>打开设置</Button></div>}
    <div className="page-content"><div hidden={page !== 'single'}><Single snapshot={snapshot} run={run} busy={pending > 0} visible={page === 'single'} onSubmitted={()=>setPage('tasks')}/></div><div hidden={page !== 'batch'}><Batch snapshot={snapshot} run={run} busy={pending > 0} onSubmitted={()=>setPage('tasks')}/></div><div hidden={page !== 'tasks'}><Tasks snapshot={snapshot} run={run} busy={pending>0} visible={page==='tasks'}/></div><div hidden={page !== 'subtitles'}><Subtitles run={run} busy={pending > 0} visible={page === 'subtitles'}/></div><div hidden={page !== 'presets'}><Presets snapshot={snapshot} run={run} busy={pending > 0}/></div><div hidden={page !== 'settings'}><Settings snapshot={snapshot} run={run} busy={pending > 0}/></div></div></main>
    {toast && <div className={`toast ${toast.error ? 'toast-error' : ''}`} role="alert">{toast.error ? <AlertCircle size={20}/> : <CheckCircle2 size={20}/>}<p>{toast.message}</p><Button variant="ghost" size="icon" aria-label="关闭提示" onClick={() => setToast(undefined)}><X size={16}/></Button></div>}
    {exitPrompt&&<ExitDialog state={exitPrompt} run={run}/>}
  </div>
}
