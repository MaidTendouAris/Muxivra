import { tr } from '../lib/i18n'
import { useState, useEffect } from 'react'
import { FileCheck2, X, RotateCcw, FolderOpen, Bot, Pause, Play, ArrowUp, ArrowDown, ChevronsUp, Info, Trash2 } from 'lucide-react'
import { asrModeLabel } from '../../shared/asr'
import type { Job } from '../../shared/types'
import { Button, Progress, Busy } from './ui'
import { nameOf, formatDuration } from '../lib/utils'
export type RunAction = <T>(operation: () => Promise<T>, success?: string) => Promise<T | undefined>
export const statusLabels = { queued:'等待中',running:'处理中',paused:'已暂停',completed:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断' }
export function Jobs({jobs,allJobs=jobs,run,busy=false,reorder=true,onDetails,onDelete,selected,onSelect}:{jobs:Job[];allJobs?:Job[];run:RunAction;busy?:boolean;reorder?:boolean;onDetails:(id:string)=>void;onDelete:(ids:string[])=>void;selected:Set<string>;onSelect:(id:string,checked:boolean)=>void}) {
  const [cancellingIds,setCancellingIds]=useState<string[]>([])
  useEffect(()=>{setCancellingIds(ids=>{const next=ids.filter(id=>allJobs.some(j=>j.id===id&&['queued','running','paused'].includes(j.status)));return next.length===ids.length?ids:next})},[allJobs])
  const cancel=async(id:string)=>{setCancellingIds(ids=>[...ids,id]);const result=await run(()=>window.muxivra.cancel(id));if(!result)setCancellingIds(ids=>ids.filter(value=>value!==id))}
  const pending=allJobs.filter(j=>j.status==='queued'||j.status==='paused'&&j.pausedFrom==='queued')
  return <div className="jobs-list">{!jobs.length&&<p className="hint">{tr("无任务")}</p>}{jobs.map(job=>{
    const active=['queued','running','paused'].includes(job.status),index=pending.findIndex(j=>j.id===job.id),cancelling=!!job.cancelling||cancellingIds.includes(job.id)
    return <article className="job" key={job.id} data-job-id={job.id} aria-busy={cancelling||undefined}>
      <div className="job-top"><input className="job-selection" type="checkbox" aria-label={tr("选择记录 {0}",nameOf(job.plan.outputPath))} checked={selected.has(job.id)} disabled={active||busy} onChange={e=>onSelect(job.id,e.target.checked)}/><div className="job-title"><FileCheck2 size={18}/><span title={job.plan.outputPath}>{job.plan.kind==='asr'?tr("{0} · 字幕初稿",job.plan.input.name):nameOf(job.plan.outputPath)}</span>{job.source==='mcp'&&<span className="tag"><Bot size={13}/>AI</span>}</div><span className={`status status-${job.status}`}>{cancelling?<Busy text={tr("取消中…")}/>:tr(statusLabels[job.status])}</span></div>
      {active&&<Progress value={job.progress} indeterminate={job.progressIndeterminate}/>}{active&&job.stage&&<small className="hint">{job.pausing?tr("等待当前分块结束后暂停"):tr(job.stage)}</small>}
      <div className="job-timing"><span className="job-codecs">{job.plan.kind==='asr'?`ASR · ${job.plan.asr.model.name} · ${asrModeLabel(job.plan.asr.options)}`:<>{job.plan.options.container.toUpperCase()} · {job.plan.options.video==='none'?job.plan.options.audio:`${job.plan.options.video} / ${job.plan.options.audio}`}</>}</span>{active&&<span>{tr("进度")}<strong>{job.progressIndeterminate?tr("处理中"):`${job.progressScope==='stage'?tr("当前阶段 "):''}${job.progress.toFixed(1)}%`}</strong></span>}<span>{tr("已用")}<strong>{!job.startedAt||job.elapsedMs===undefined?'—':job.elapsedMs<1000?tr("{0} 秒",(job.elapsedMs/1000).toFixed(1)):formatDuration(job.elapsedMs)}</strong></span>{job.speed&&<span>{tr("速度")}<strong>{job.speed}</strong></span>}{active&&<span>{job.startedAt?tr("预计剩余"):tr("预计处理")} <strong>{job.estimatedRemainingMs===undefined?(job.startedAt?tr("估算中"):tr("暂无估算")):formatDuration(Math.ceil(job.estimatedRemainingMs/1000)*1000)}</strong>{job.estimateBasis==='history'&&tr("（历史估算）")}</span>}</div>
      <div className="job-actions">{index>=0&&reorder&&<div className="job-order"><span className="hint">{tr("队列 #")}{index+1}</span><Button variant="ghost" size="icon" aria-label={tr("置顶任务")} disabled={busy||index===0} onClick={()=>run(()=>window.muxivra.moveJob(job.id,'first'))}><ChevronsUp size={16}/></Button><Button variant="ghost" size="icon" aria-label={tr("上移任务")} disabled={busy||index===0} onClick={()=>run(()=>window.muxivra.moveJob(job.id,'up'))}><ArrowUp size={16}/></Button><Button variant="ghost" size="icon" aria-label={tr("下移任务")} disabled={busy||index===pending.length-1} onClick={()=>run(()=>window.muxivra.moveJob(job.id,'down'))}><ArrowDown size={16}/></Button></div>}
        {active&&<><Button variant="secondary" size="sm" disabled={busy||cancelling} loading={job.pausing} loadingText={job.pausing?tr("等待分块结束…"):job.status==='paused'?tr("正在继续…"):tr("正在暂停…")} onClick={()=>run(()=>job.status==='paused'?window.muxivra.resume(job.id):window.muxivra.pause(job.id))}>{job.status==='paused'?<Play size={15}/>:<Pause size={15}/>} {job.status==='paused'?tr("继续"):tr("暂停")}</Button><Button variant="ghost" size="sm" disabled={busy} loading={cancelling} loadingText={tr("取消中…")} onClick={()=>cancel(job.id)}><X size={15}/>{tr("取消")}</Button></>}
        {['failed','cancelled','interrupted'].includes(job.status)&&<Button variant="secondary" size="sm" disabled={busy} onClick={()=>run(()=>window.muxivra.retry(job.id),tr("已创建重试任务"))}><RotateCcw size={15}/>{tr("重试")}</Button>}
        <Button variant="ghost" size="sm" disabled={busy} onClick={()=>run(()=>window.muxivra.reveal(job.plan.input.path))}><FolderOpen size={15}/>{tr("查看输入文件")}</Button>
        {job.status==='completed'&&<Button variant="ghost" size="sm" disabled={busy} onClick={()=>run(()=>window.muxivra.reveal(job.plan.outputPath))}><FolderOpen size={15}/>{tr("查看输出文件")}</Button>}
        <Button variant="ghost" size="sm" onClick={()=>onDetails(job.id)}><Info size={15}/>{tr("查看详细信息")}</Button>
        {!active&&<Button variant="ghost" size="sm" disabled={busy} onClick={()=>onDelete([job.id])}><Trash2 size={15}/>{tr("删除记录")}</Button>}
      </div>
    </article>
  })}</div>
}
