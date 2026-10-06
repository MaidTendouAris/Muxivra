import { useState, useEffect } from 'react'
import type { Snapshot } from '../../shared/types'
import { Card, Select, Input } from '../components/ui'
import { Jobs, type RunAction } from '../components/Jobs'
import { nameOf } from '../lib/utils'
import { HardwareMonitor } from '../components/HardwareMonitor'

export function Tasks({snapshot,run,busy,visible}:{snapshot:Snapshot;run:RunAction;busy:boolean;visible:boolean}) {
  const [jobs,setJobs]=useState(snapshot.jobs),[filter,setFilter]=useState('all'),[source,setSource]=useState('all'),[order,setOrder]=useState('queue'),[search,setSearch]=useState('')
  useEffect(()=>setJobs(snapshot.jobs),[snapshot.jobs])
  useEffect(()=>{if(!visible)return;let live=true;const timer=setInterval(()=>{void window.muxivra.snapshot().then(s=>{if(live)setJobs(s.jobs)}).catch(()=>{})},1000);return()=>{live=false;clearInterval(timer)}},[visible])
  const counts=[['处理中',jobs.filter(j=>j.status==='running').length],['等待中',jobs.filter(j=>j.status==='queued').length],['已暂停',jobs.filter(j=>j.status==='paused').length],['已完成',jobs.filter(j=>j.status==='completed').length],['失败 / 中断',jobs.filter(j=>['failed','interrupted'].includes(j.status)).length]]
  const shown=jobs.filter(j=>(source==='all'||j.source===source)&&(filter==='all'||filter==='active'&&['queued','running','paused'].includes(j.status)||filter==='failed'&&['failed','interrupted'].includes(j.status)||j.status===filter)&&`${j.plan.input.name} ${nameOf(j.plan.outputPath)}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  shown.sort((a,b)=>order==='newest'?b.createdAt.localeCompare(a.createdAt):order==='oldest'?a.createdAt.localeCompare(b.createdAt):order==='name'?nameOf(a.plan.outputPath).localeCompare(nameOf(b.plan.outputPath),'zh-CN'):((a.status==='running'||a.pausedFrom==='running'?0:['queued','paused'].includes(a.status)?1:2)-(b.status==='running'||b.pausedFrom==='running'?0:['queued','paused'].includes(b.status)?1:2))||(['queued','paused','running'].includes(a.status)?jobs.indexOf(a)-jobs.indexOf(b):b.createdAt.localeCompare(a.createdAt)))
  return <div className="tasks-layout"><div className="task-stats">{counts.map(([label,count])=><div key={label}><span>{label}</span><strong>{count}</strong></div>)}</div><Card title="处理队列" aside={<span className="hint" title="暂停运行项保留进度，并占用当前并行名额">并行上限 {snapshot.settings.concurrency}</span>}>
    <div className="task-toolbar"><Input aria-label="搜索任务" placeholder="搜索输入或输出文件名" value={search} onChange={e=>setSearch(e.target.value)}/><Select aria-label="任务状态" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部状态</option><option value="active">未完成</option><option value="running">处理中</option><option value="queued">等待中</option><option value="paused">已暂停</option><option value="completed">已完成</option><option value="failed">失败 / 中断</option><option value="cancelled">已取消</option></Select><Select aria-label="任务来源" value={source} onChange={e=>setSource(e.target.value)}><option value="all">全部来源</option><option value="gui">界面提交</option><option value="mcp">AI 提交</option></Select><Select aria-label="显示顺序" value={order} onChange={e=>setOrder(e.target.value)}><option value="queue">队列顺序</option><option value="newest">最新提交</option><option value="oldest">最早提交</option><option value="name">文件名</option></Select></div>
    <Jobs jobs={shown} allJobs={jobs} run={run} busy={busy} reorder={order==='queue'}/>
  </Card><HardwareMonitor visible={visible}/></div>
}
