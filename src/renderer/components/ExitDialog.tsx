import { tr } from '../lib/i18n'
import { Power, Layers3, Plug, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import type { ExitPrompt } from '../../shared/types'
import type { RunAction } from './Jobs'
import { Button, Modal, Busy } from './ui'

export function ExitDialog({state,run,beforeConfirm}:{state:ExitPrompt;run:RunAction;beforeConfirm?:()=>Promise<void>}) {
  const [responding,setResponding]=useState(false)
  const closing=state.phase==='closing'||responding,active=state.running+state.waiting+state.paused
  const updating=state.reason==='update',ActionIcon=updating?RotateCcw:Power
  const stopped=!!state.runtimeStopped
  const cancel=()=>run(()=>window.muxivra.respondToExit(false))
  const confirm=async()=>{setResponding(true);await run(async()=>{await beforeConfirm?.();await window.muxivra.respondToExit(true)});setResponding(false)}
  const quitInstead=async()=>{setResponding(true);await run(()=>window.muxivra.requestExit());setResponding(false)}
  return <Modal title={updating?tr("安装应用更新"):tr("退出 Muxivra")} className="exit-dialog" locked={closing||stopped} onClose={()=>{if(!stopped)void cancel()}}>
    <div className="exit-intro"><span className="exit-symbol"><ActionIcon size={26}/></span><div><h2>{closing?(updating?tr("正在准备安装"):tr("正在退出")):stopped&&state.error?(updating?tr("更新未完成"):tr("退出未完成")):(updating?tr("重启安装 {0}？",state.updateVersion??tr("新版本")):tr("确认退出应用？"))}</h2><p>{closing?tr("正在停止任务并保存字幕与应用数据，请稍候。"):stopped?(updating?tr("后台服务已进入关闭流程。请重试安装，或退出应用后重新启动。"):tr("后台服务已进入关闭流程，请完成退出后重新启动应用。")):active?tr("运行中的任务将停止，排队任务会保留。"):updating?tr("保存字幕与应用数据后，重启应用并安装更新。"):tr("退出后将停止后台服务。")}</p></div></div>
    <div className="exit-facts"><div><Layers3 size={19}/><div><strong>{tr("处理任务")}</strong><span>{active?tr("运行 {0} · 排队 {1} · 暂停 {2}",state.running,state.waiting,state.paused):tr("没有未完成任务")}</span></div></div><div><Plug size={19}/><div><strong>{tr("MCP 服务")}</strong><span>{state.mcpRunning?(updating?tr("重启期间断开 AI 客户端连接"):tr("退出后断开 AI 客户端连接")):tr("未开启")}</span></div></div></div>
    {state.error&&<p className="error-inline" role="alert">{updating?tr("更新"):tr("退出")}{tr("失败：")}{state.error}</p>}
    {closing?<div className="exit-progress" role="status"><Busy text={updating?tr("正在准备更新…"):tr("正在关闭应用…")}/><div className="activity-line"/></div>:<div className="exit-actions">{stopped?(updating&&<Button variant="secondary" loadingText={tr("正在处理…")} onClick={quitInstead}><Power size={16}/>{tr("退出应用")}</Button>):<Button variant="secondary" onClick={cancel}>{tr("继续运行")}</Button>}<Button variant={updating?'default':'danger'} loadingText={updating?tr("正在准备…"):tr("正在退出…")} onClick={confirm}><ActionIcon size={16}/>{stopped?(updating?tr("重试安装"):state.error?tr("重试退出"):tr("退出应用")):updating?tr("重启并安装"):tr("退出应用")}</Button></div>}
  </Modal>
}
