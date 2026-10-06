import { Power, Layers3, Plug } from 'lucide-react'
import { useState } from 'react'
import type { ExitPrompt } from '../../shared/types'
import type { RunAction } from './Jobs'
import { Button, Modal, Busy } from './ui'

export function ExitDialog({state,run}:{state:ExitPrompt;run:RunAction}) {
  const [responding,setResponding]=useState(false)
  const closing=state.phase==='closing'||responding,active=state.running+state.waiting+state.paused
  const cancel=()=>run(()=>window.muxivra.respondToExit(false))
  const confirm=async()=>{setResponding(true);await run(()=>window.muxivra.respondToExit(true));setResponding(false)}
  return <Modal title="退出 Muxivra" className="exit-dialog" locked={closing} onClose={()=>{void cancel()}}>
    <div className="exit-intro"><span className="exit-symbol"><Power size={26}/></span><div><h2>{closing?'正在退出':'确认退出应用？'}</h2><p>{closing?'正在停止任务并保存数据，请稍候。':active?'运行中的任务将停止，排队任务会保留。':'退出后将停止后台服务。'}</p></div></div>
    <div className="exit-facts"><div><Layers3 size={19}/><div><strong>处理任务</strong><span>{active?`运行 ${state.running} · 排队 ${state.waiting} · 暂停 ${state.paused}`:'没有未完成任务'}</span></div></div><div><Plug size={19}/><div><strong>MCP 服务</strong><span>{state.mcpRunning?'退出后断开 AI 客户端连接':'未开启'}</span></div></div></div>
    {state.error&&<p className="error-inline" role="alert">退出失败：{state.error}</p>}
    {closing?<div className="exit-progress" role="status"><Busy text="正在关闭应用…"/><div className="activity-line"/></div>:<div className="exit-actions"><Button variant="secondary" onClick={cancel}>继续运行</Button><Button variant="danger" loadingText="正在退出…" onClick={confirm}><Power size={16}/>退出应用</Button></div>}
  </Modal>
}
