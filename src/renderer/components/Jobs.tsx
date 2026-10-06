import { useState, useEffect } from 'react'
import { FileCheck2, X, RotateCcw, FolderOpen, Terminal, Bot, Pause, Play, ArrowUp, ArrowDown, ChevronsUp } from 'lucide-react'
import type { Job } from '../../shared/types'
import { Button, Progress, Modal, Busy } from './ui'
import { nameOf, formatDuration } from '../lib/utils'
export type RunAction = <T>(operation: () => Promise<T>, success?: string) => Promise<T | undefined>
export const statusLabels = { queued: '等待中', running: '处理中', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' }
export function Jobs({ jobs, allJobs=jobs, run, busy=false, reorder=true }: { jobs: Job[]; allJobs?:Job[]; run: RunAction; busy?:boolean;reorder?:boolean }) {
  const [log,setLog] = useState<string>()
  const [cancellingIds,setCancellingIds]=useState<string[]>([])
  useEffect(()=>{setCancellingIds(ids=>{const next=ids.filter(id=>allJobs.some(j=>j.id===id&&['queued','running','paused'].includes(j.status)));return next.length===ids.length?ids:next})},[allJobs])
  const cancel=async(id:string)=>{
    setCancellingIds(ids=>[...ids,id])
    const result=await run(()=>window.muxivra.cancel(id))
    if(!result)setCancellingIds(ids=>ids.filter(value=>value!==id))
  }
  const pending=allJobs.filter(j=>j.status==='queued'||j.status==='paused'&&j.pausedFrom==='queued')
  return <div className="jobs-list">{!jobs.length&&<p className="hint">无任务</p>}{jobs.map(job=>{
    const active=['queued','running','paused'].includes(job.status),index=pending.findIndex(j=>j.id===job.id),cancelling=!!job.cancelling||cancellingIds.includes(job.id)
    return <article className="job" key={job.id} data-job-id={job.id} aria-busy={cancelling||undefined}>
      <div className="job-top"><div className="job-title"><FileCheck2 size={18}/><span title={job.plan.outputPath}>{nameOf(job.plan.outputPath)}</span>{job.source==='mcp'&&<span className="tag"><Bot size={13}/>AI</span>}</div><span className={`status status-${job.status}`}>{cancelling?<Busy text="取消中…"/>:statusLabels[job.status]}</span></div>
      <p className="job-input" title={job.plan.input.path}>输入：{job.plan.input.name}</p>
      <div className="job-detail"><span>{job.plan.options.container.toUpperCase()} · {job.plan.options.video} / {job.plan.options.audio}</span><span>{new Date(job.createdAt).toLocaleString('zh-CN')}</span></div>
      {active&&<Progress value={job.progress}/>}
      <div className="job-timing"><span>进度 <strong>{job.progress.toFixed(1)}%</strong></span><span>已用 <strong>{!job.startedAt?'—':(job.elapsedMs??0)<1000?`${((job.elapsedMs??0)/1000).toFixed(1)} 秒`:formatDuration(job.elapsedMs??0)}</strong></span><span>速度 <strong>{job.speed||'—'}</strong></span>{active&&<span>{job.startedAt?'预计剩余':'预计处理'} <strong>{job.estimatedRemainingMs===undefined?(job.startedAt?'估算中':'暂无估算'):formatDuration(Math.ceil(job.estimatedRemainingMs/1000)*1000)}</strong>{job.estimateBasis==='history'&&'（历史估算）'}{job.status==='paused'&&' · 已暂停'}</span>}</div>
      <div className="job-actions">{index>=0&&reorder&&<div className="job-order"><span className="hint">队列 #{index+1}</span><Button variant="ghost" size="icon" aria-label="置顶任务" disabled={busy||index===0} onClick={()=> run(()=>window.muxivra.moveJob(job.id,'first'))}><ChevronsUp size={16}/></Button><Button variant="ghost" size="icon" aria-label="上移任务" disabled={busy||index===0} onClick={()=> run(()=>window.muxivra.moveJob(job.id,'up'))}><ArrowUp size={16}/></Button><Button variant="ghost" size="icon" aria-label="下移任务" disabled={busy||index===pending.length-1} onClick={()=> run(()=>window.muxivra.moveJob(job.id,'down'))}><ArrowDown size={16}/></Button></div>}
      {active&&<><Button variant="secondary" size="sm" disabled={busy||cancelling} loadingText={job.status==='paused'?'正在继续…':'正在暂停…'} onClick={()=> run(()=>job.status==='paused'?window.muxivra.resume(job.id):window.muxivra.pause(job.id))}>{job.status==='paused'?<Play size={15}/>:<Pause size={15}/>} {job.status==='paused'?'继续':'暂停'}</Button><Button variant="ghost" size="sm" disabled={busy} loading={cancelling} loadingText="取消中…" onClick={()=>cancel(job.id)}><X size={15}/>取消</Button></>}
      {['failed','cancelled','interrupted'].includes(job.status)&&<Button variant="secondary" size="sm" disabled={busy} onClick={()=> run(()=>window.muxivra.retry(job.id),'已创建重试任务')}><RotateCcw size={15}/>重试</Button>}
      {job.status==='completed'&&<Button variant="ghost" size="sm" onClick={()=> run(()=>window.muxivra.reveal(job.plan.outputPath))}><FolderOpen size={15}/>查看文件</Button>}<Button variant="ghost" size="sm" onClick={()=> run(async()=>setLog(await window.muxivra.readLog(job.id)))}><Terminal size={15}/>日志</Button></div>
      <details className="job-paths"><summary>路径与参数</summary><p className="path-text">输出：{job.plan.outputPath}</p><p className="path-text">输入：{job.plan.input.path}</p><pre className="code-box">{job.plan.args.map(a=>JSON.stringify(a)).join(' ')}</pre></details>{job.error&&job.status!=='cancelled'&&<p className="error-inline">{job.error}</p>}
    </article>
  })}{log!==undefined&&<Modal title="任务诊断日志" onClose={()=>setLog(undefined)}><pre className="code-box">{log||'暂无执行日志'}</pre></Modal>}</div>
}
