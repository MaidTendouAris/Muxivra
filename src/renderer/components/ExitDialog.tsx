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
  return <Modal title={updating?'安装应用更新':'退出 Muxivra'} className="exit-dialog" locked={closing||stopped} onClose={()=>{if(!stopped)void cancel()}}>
    <div className="exit-intro"><span className="exit-symbol"><ActionIcon size={26}/></span><div><h2>{closing?(updating?'正在准备安装':'正在退出'):stopped&&state.error?(updating?'更新未完成':'退出未完成'):(updating?`重启安装 ${state.updateVersion??'新版本'}？`:'确认退出应用？')}</h2><p>{closing?'正在停止任务并保存字幕与应用数据，请稍候。':stopped?(updating?'后台服务已进入关闭流程。请重试安装，或退出应用后重新启动。':'后台服务已进入关闭流程，请完成退出后重新启动应用。'):active?'运行中的任务将停止，排队任务会保留。':updating?'保存字幕与应用数据后，重启应用并安装更新。':'退出后将停止后台服务。'}</p></div></div>
    <div className="exit-facts"><div><Layers3 size={19}/><div><strong>处理任务</strong><span>{active?`运行 ${state.running} · 排队 ${state.waiting} · 暂停 ${state.paused}`:'没有未完成任务'}</span></div></div><div><Plug size={19}/><div><strong>MCP 服务</strong><span>{state.mcpRunning?(updating?'重启期间断开 AI 客户端连接':'退出后断开 AI 客户端连接'):'未开启'}</span></div></div></div>
    {state.error&&<p className="error-inline" role="alert">{updating?'更新':'退出'}失败：{state.error}</p>}
    {closing?<div className="exit-progress" role="status"><Busy text={updating?'正在准备更新…':'正在关闭应用…'}/><div className="activity-line"/></div>:<div className="exit-actions">{stopped?(updating&&<Button variant="secondary" loadingText="正在处理…" onClick={quitInstead}><Power size={16}/>退出应用</Button>):<Button variant="secondary" onClick={cancel}>继续运行</Button>}<Button variant={updating?'default':'danger'} loadingText={updating?'正在准备…':'正在退出…'} onClick={confirm}><ActionIcon size={16}/>{stopped?(updating?'重试安装':state.error?'重试退出':'退出应用'):updating?'重启并安装':'退出应用'}</Button></div>}
  </Modal>
}
