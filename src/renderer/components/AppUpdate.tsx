import { useState } from 'react'
import { AlertCircle, CheckCircle2, Download, RefreshCw, RotateCcw, X } from 'lucide-react'
import type { AppUpdateState } from '../../shared/app-update'
import { Button, Busy, Card, Progress } from './ui'

export interface AppUpdateControls {
  state: AppUpdateState
  pending?: 'check' | 'download' | 'install'
  onCheck: () => Promise<void>
  onDownload: () => Promise<void>
  onInstall: () => Promise<void>
}

const formatBytes = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`
const formatDate = (value?: string) => {
  if (!value) return '尚未检查'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false })
}
const labels: Record<AppUpdateState['phase'], string> = {
  disabled: '暂不可用', idle: '待检查', checking: '检查中', current: '已是最新版本', available: '有新版本',
  downloading: '下载中', downloaded: '可安装', installing: '安装中', error: '更新失败'
}

function UpdateProgress({ state }: { state: AppUpdateState }) {
  const percent = Math.min(100, Math.max(0, state.percent || 0))
  return <div className="app-update-progress" aria-live="polite">
    {state.total > 0 ? <Progress value={percent}/> : <div className="activity-line"/>}
    <div><span>{state.total > 0 ? `${percent.toFixed(1)}% · ${formatBytes(state.transferred)} / ${formatBytes(state.total)}` : '正在准备下载…'}</span>{state.bytesPerSecond > 0 && <span>{formatBytes(state.bytesPerSecond)}/s</span>}</div>
  </div>
}

export function AppUpdateCard({ state, pending, onCheck, onDownload, onInstall }: AppUpdateControls) {
  const working = ['checking', 'downloading', 'installing'].includes(state.phase) || !!pending
  const hasDownload = state.phase === 'available' || state.phase === 'error' && !!state.version
  const downloading = state.phase === 'downloading' || pending === 'download'
  return <Card title="应用更新" className="app-update-card" aside={<span className={`status ${state.phase === 'error' ? 'status-failed' : state.phase === 'current' || state.phase === 'downloaded' ? 'status-completed' : ''}`}>{labels[state.phase]}</span>}>
    <div className="app-update-main"><div className="app-update-versions"><strong>Muxivra <span>{state.currentVersion}</span></strong>{state.version && state.version !== state.currentVersion && <span className="app-update-next">新版本 {state.version}</span>}<small>GitHub Releases · 每次启动检查更新</small></div><div className="toolbar wrap">
      <Button variant="secondary" disabled={working || ['disabled','downloaded'].includes(state.phase)} loading={state.phase === 'checking' || pending === 'check'} loadingText="正在检查…" onClick={onCheck}><RefreshCw size={16}/>检查更新</Button>
      {hasDownload && <Button disabled={working} onClick={onDownload}><Download size={16}/>{state.phase === 'error' ? '重试下载' : '下载更新'}</Button>}
      {state.phase === 'downloaded' && <Button disabled={working} loadingText="正在准备…" onClick={onInstall}><RotateCcw size={16}/>重启并安装</Button>}
    </div></div>
    {downloading && <UpdateProgress state={state}/>}
    {state.phase === 'installing' && <div className="app-update-status" role="status"><Busy text="正在安装更新…"/></div>}
    {state.error || state.phase === 'error' ? <p className="app-update-error" role="alert"><AlertCircle size={16}/><span>{state.error || state.message}</span></p> : <p className="app-update-status hint">{state.message}</p>}
    <div className="app-update-meta"><span>上次检查：{formatDate(state.checkedAt)}</span>{state.releaseDate && <span>发布时间：{formatDate(state.releaseDate)}</span>}</div>
    {state.releaseNotes && <details className="app-update-notes"><summary>版本说明</summary><p>{state.releaseNotes}</p></details>}
  </Card>
}

export function AppUpdateNotice({ state, pending, onDownload, onInstall, onSettings }: AppUpdateControls & { onSettings: () => void }) {
  const [dismissed, setDismissed] = useState('')
  const key = `${state.phase}:${state.version ?? ''}`
  if (!['available', 'downloading', 'downloaded'].includes(state.phase) || dismissed === key) return null
  const downloading = state.phase === 'downloading' || pending === 'download'
  return <div className="notice app-update-notice" role="status" data-update-phase={state.phase}>
    {downloading ? <Busy text={`正在下载 ${state.version ?? '更新'}${state.total > 0 ? ` · ${Math.min(100, Math.max(0, state.percent || 0)).toFixed(0)}%` : ''}`}/> : <><CheckCircle2 size={17}/><span>{state.phase === 'downloaded' ? `Muxivra ${state.version} 已下载` : `发现新版本 ${state.version}`}</span></>}
    <div className="app-update-notice-actions"><Button variant="ghost" size="sm" onClick={onSettings}>查看更新</Button>{state.phase === 'available' && <Button size="sm" disabled={!!pending} loadingText="正在下载…" onClick={onDownload}>下载更新</Button>}{state.phase === 'downloaded' && <Button size="sm" disabled={!!pending} loadingText="正在准备…" onClick={onInstall}>重启并安装</Button>}<Button variant="ghost" size="icon" aria-label="稍后查看更新" onClick={() => setDismissed(key)}><X size={15}/></Button></div>
  </div>
}
