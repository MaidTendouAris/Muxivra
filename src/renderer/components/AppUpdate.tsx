import { tr, uiLocale } from '../lib/i18n'
import { useState } from 'react'
import { AlertCircle, CheckCircle2, Download, RefreshCw, RotateCcw, X } from 'lucide-react'
import type { AppUpdateState } from '../../shared/app-update'
import { Button, Busy, Card, Progress } from './ui'
import type { Snapshot } from '../../shared/types'
import type { RunAction } from './Jobs'
import mpv from '../../../resources/mpv-manifest.json'

export interface AppUpdateControls {
  state: AppUpdateState
  pending?: 'check' | 'download' | 'install'
  onCheck: () => Promise<void>
  onDownload: () => Promise<void>
  onInstall: () => Promise<void>
}

const formatBytes = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`
const formatDate = (value?: string) => {
  if (!value) return tr("尚未检查")
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(uiLocale(), { hour12: false })
}
const labels: Record<AppUpdateState['phase'], string> = {
  disabled: '暂不可用', idle: '待检查', checking: '检查中', current: '已是最新版本', available: '有新版本',
  downloading: '下载中', downloaded: '可安装', installing: '安装中', error: '更新失败'
}

function UpdateProgress({ state }: { state: AppUpdateState }) {
  const percent = Math.min(100, Math.max(0, state.percent || 0))
  return <div className="app-update-progress" aria-live="polite">
    {state.total > 0 ? <Progress value={percent}/> : <div className="activity-line"/>}
    <div><span>{state.total > 0 ? `${percent.toFixed(1)}% · ${formatBytes(state.transferred)} / ${formatBytes(state.total)}` : tr("正在准备下载…")}</span>{state.bytesPerSecond > 0 && <span>{formatBytes(state.bytesPerSecond)}/s</span>}</div>
  </div>
}

export function AppUpdateCard({ state, pending, onCheck, onDownload, onInstall }: AppUpdateControls) {
  const working = ['checking', 'downloading', 'installing'].includes(state.phase) || !!pending
  const hasDownload = state.phase === 'available' || state.phase === 'error' && !!state.version
  const downloading = state.phase === 'downloading' || pending === 'download'
  return <Card title={tr("应用更新")} className="app-update-card" aside={<span className={`status ${state.phase === 'error' ? 'status-failed' : state.phase === 'current' || state.phase === 'downloaded' ? 'status-completed' : ''}`}>{tr(labels[state.phase])}</span>}>
    <div className="app-update-main"><div className="app-update-versions"><strong>Muxivra <span>{state.currentVersion}</span></strong>{state.version && state.version !== state.currentVersion && <span className="app-update-next">{tr("新版本")}{state.version}</span>}<small>{tr("GitHub Releases · 每次启动检查更新")}</small></div><div className="toolbar wrap">
      <Button variant="secondary" disabled={working || ['disabled','downloaded'].includes(state.phase)} loading={state.phase === 'checking' || pending === 'check'} loadingText={tr("正在检查…")} onClick={onCheck}><RefreshCw size={16}/>{tr("检查更新")}</Button>
      {hasDownload && <Button disabled={working} onClick={onDownload}><Download size={16}/>{state.phase === 'error' ? tr("重试下载") : tr("下载更新")}</Button>}
      {state.phase === 'downloaded' && <Button disabled={working} loadingText={tr("正在准备…")} onClick={onInstall}><RotateCcw size={16}/>{tr("重启并安装")}</Button>}
    </div></div>
    {downloading && <UpdateProgress state={state}/>}
    {state.phase === 'installing' && <div className="app-update-status" role="status"><Busy text={tr("正在安装更新…")}/></div>}
    {state.error || state.phase === 'error' ? <p className="app-update-error" role="alert"><AlertCircle size={16}/><span>{tr(state.error || state.message)}</span></p> : <p className="app-update-status hint">{tr(state.message)}</p>}
    <div className="app-update-meta"><span>{tr("上次检查：")}{formatDate(state.checkedAt)}</span>{state.releaseDate && <span>{tr("发布时间：")}{formatDate(state.releaseDate)}</span>}</div>
    {state.releaseNotes && <details className="app-update-notes"><summary>{tr("版本说明")}</summary><p>{state.releaseNotes}</p></details>}
  </Card>
}

export function SoftwareInfoCard({state,pending,onCheck,onDownload,onInstall,snapshot,autoUpdate,changed,onAutoUpdate,run,busy}:AppUpdateControls&{snapshot:Snapshot;autoUpdate:boolean;changed:boolean;onAutoUpdate:(value:boolean)=>void;run:RunAction;busy:boolean}) {
  const working=['checking','downloading','installing'].includes(state.phase)||!!pending,hasDownload=state.phase==='available'||state.phase==='error'&&!!state.version
  return <Card title={tr("软件信息")} className="app-update-card software-info-card" aside={<span className="tag">v{state.currentVersion}</span>}><div className="software-info-grid"><div className="inner-card"><strong>Muxivra</strong><div className="setting-value"><span>{tr("软件版本")}</span><strong>{state.currentVersion}</strong></div><div className="setting-value"><span>{tr("软件许可证")}</span><span>GPL-3.0-only</span></div></div><div className="inner-card"><strong>{tr("媒体组件")}</strong><div className="setting-value"><span>{tr("FFmpeg 许可证")}</span><span>{snapshot.engine?.license??(snapshot.engine?tr("未读取"):tr("未配置"))}</span></div><div className="setting-value"><span>{tr("mpv 播放器许可证")}</span><span>{mpv.license.split(' (')[0]}</span></div><small className="hint">mpv {mpv.version}</small></div></div><div className="toolbar wrap software-links">{([['repository',tr("GitHub 仓库")],['issues',tr("问题反馈")],['releases',tr("手动更新")]] as const).map(([kind,label])=><Button variant="secondary" key={kind} disabled={busy} onClick={()=>run(()=>window.muxivra.openAppLink(kind))}>{tr(label)}</Button>)}</div><div className="software-updates"><label className={`switch-label ${changed?'setting-changed':''}`}><input type="checkbox" aria-label={tr("自动检查更新")} checked={autoUpdate} disabled={busy} onChange={event=>onAutoUpdate(event.target.checked)}/>{tr("启动时自动检查更新")}{changed&&<small className="setting-marker">{tr("未保存")}</small>}</label><div className="toolbar wrap"><Button variant="secondary" disabled={working||['disabled','downloaded'].includes(state.phase)} loading={state.phase==='checking'||pending==='check'} loadingText={tr("正在检查…")} onClick={onCheck}><RefreshCw size={16}/>{tr("检查更新")}</Button>{hasDownload&&<Button disabled={working} onClick={onDownload}><Download size={16}/>{state.phase==='error'?tr("重试下载"):tr("下载更新")}</Button>}{state.phase==='downloaded'&&<Button disabled={working} onClick={onInstall}><RotateCcw size={16}/>{tr("重启并安装")}</Button>}</div></div><div className="app-update-meta"><span className="status">{tr(labels[state.phase])}</span>{state.version&&state.version!==state.currentVersion&&<span>{tr("新版本")}{state.version}</span>}<span>{tr("上次检查：")}{formatDate(state.checkedAt)}</span></div>{state.phase==='downloading'&&<UpdateProgress state={state}/>}<p className={state.error?'app-update-error':'app-update-status hint'}>{tr(state.error||state.message)}</p>{state.releaseNotes&&<details className="app-update-notes"><summary>{tr("版本说明")}</summary><p>{state.releaseNotes}</p></details>}</Card>
}

export function AppUpdateNotice({ state, pending, onDownload, onInstall, onSettings }: AppUpdateControls & { onSettings: () => void }) {
  const [dismissed, setDismissed] = useState('')
  const key = `${state.phase}:${state.version ?? ''}`
  if (!['available', 'downloading', 'downloaded'].includes(state.phase) || dismissed === key) return null
  const downloading = state.phase === 'downloading' || pending === 'download'
  return <div className="notice app-update-notice" role="status" data-update-phase={state.phase}>
    {downloading ? <Busy text={tr("正在下载 {0}{1}",state.version ?? tr("更新"),state.total > 0 ? ` · ${Math.min(100, Math.max(0, state.percent || 0)).toFixed(0)}%` : '')}/> : <><CheckCircle2 size={17}/><span>{state.phase === 'downloaded' ? tr("Muxivra {0} 已下载",state.version) : tr("发现新版本 {0}",state.version)}</span></>}
    <div className="app-update-notice-actions"><Button variant="ghost" size="sm" onClick={onSettings}>{tr("查看更新")}</Button>{state.phase === 'available' && <Button size="sm" disabled={!!pending} loadingText={tr("正在下载…")} onClick={onDownload}>{tr("下载更新")}</Button>}{state.phase === 'downloaded' && <Button size="sm" disabled={!!pending} loadingText={tr("正在准备…")} onClick={onInstall}>{tr("重启并安装")}</Button>}<Button variant="ghost" size="icon" aria-label={tr("稍后查看更新")} onClick={() => setDismissed(key)}><X size={15}/></Button></div>
  </div>
}
