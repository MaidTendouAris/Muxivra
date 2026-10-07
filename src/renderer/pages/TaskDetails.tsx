import { useEffect, useState } from 'react'
import { ArrowLeft, FolderOpen, RefreshCw, Copy, Trash2, ChevronLeft, ChevronRight } from 'lucide-react'
import type { Job, JobLogPage } from '../../shared/types'
import { Button, Card, Busy } from '../components/ui'
import { statusLabels, type RunAction } from '../components/Jobs'
import { formatTime, formatBytes, nameOf } from '../lib/utils'
const date=(value?:string)=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'—'
const size=(value:number)=>value<1024?`${value} B`:value<1024**2?`${(value/1024).toFixed(1)} KB`:formatBytes(value)
export function TaskDetails({id,visible,run,busy,onBack,onDelete}:{id:string;visible:boolean;run:RunAction;busy:boolean;onBack:()=>void;onDelete:(ids:string[])=>void}) {
  const [job,setJob]=useState<Job>(),[error,setError]=useState(''),[log,setLog]=useState<JobLogPage>(),[positions,setPositions]=useState([0]),[logIndex,setLogIndex]=useState(0),[logLoading,setLogLoading]=useState(false)
  useEffect(()=>{let live=true,pending=false;const refresh=async()=>{if(pending)return;pending=true;try{const value=await window.muxivra.jobDetails(id);if(live){setJob(value);setError('')}}catch(e){if(live)setError((e as Error).message)}finally{pending=false}};void refresh();const timer=visible?setInterval(refresh,1000):undefined;return()=>{live=false;clearInterval(timer)}},[id,visible])
  useEffect(()=>{let live=true;setLogLoading(true);window.muxivra.readLogPage(id,0).then(value=>{if(live)setLog(value)}).catch(e=>{if(live)setError((e as Error).message)}).finally(()=>{if(live)setLogLoading(false)});return()=>{live=false}},[id])
  const read=(offset:number,index:number)=>run(async()=>{setLogLoading(true);try{const value=await window.muxivra.readLogPage(id,offset);setLog(value);setLogIndex(index);setPositions(old=>[...old.slice(0,index),offset]);return true}finally{setLogLoading(false)}})
  if(!job)return <div className="task-details-page"><Button variant="ghost" onClick={onBack}><ArrowLeft size={16}/>返回任务</Button>{error?<p className="error-inline">{error}</p>:<Busy text="正在读取任务记录…"/>}</div>
  const active=['queued','running','paused'].includes(job.status)
  return <div className="task-details-page">
    <div className="task-details-heading"><div><Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft size={16}/>返回任务</Button><h2>任务详细信息</h2><p className="task-detail-name">{nameOf(job.plan.outputPath)}</p></div><div className="toolbar"><span className={`status status-${job.status}`}>{statusLabels[job.status]}</span>{!active&&<Button variant="secondary" disabled={busy} onClick={()=>onDelete([id])}><Trash2 size={16}/>删除记录</Button>}</div></div>
    {error&&<p className="error-inline">{error}</p>}
    <Card title="处理记录"><dl className="task-record-grid">
      <div><dt>提交时间</dt><dd>{date(job.createdAt)}</dd></div><div><dt>开始时间</dt><dd>{date(job.startedAt)}</dd></div><div><dt>结束时间</dt><dd>{date(job.finishedAt)}</dd></div>
      <div><dt>处理时长</dt><dd>{job.startedAt?job.elapsedMs===undefined?'未记录':formatTime(Math.floor(job.elapsedMs)):'未开始'}</dd></div><div><dt>提交来源</dt><dd>{job.source==='mcp'?'AI / MCP':'界面'}</dd></div><div><dt>处理进度 / 速度</dt><dd>{job.progress.toFixed(1)}% · {job.speed||'—'}</dd></div>
      <div><dt>输出大小</dt><dd>{job.outputSize!==undefined?size(job.outputSize):'—'}</dd></div><div><dt>进程退出码</dt><dd>{job.exitCode??(job.exitSignal?`信号 ${job.exitSignal}`:'未记录')}</dd></div><div><dt>任务 ID</dt><dd className="task-record-id">{job.id}</dd></div>
    </dl>{job.error&&<p className="error-inline">{job.error}</p>}{job.plan.warnings.map((warning,i)=><p className="hint" key={i}>{warning}</p>)}</Card>
    <Card title="文件"><div className="task-file-record"><div><span className="hint">输入文件</span><p className="path-text">{job.plan.input.path}</p></div><Button variant="secondary" disabled={busy} onClick={()=>run(()=>window.muxivra.reveal(job.plan.input.path))}><FolderOpen size={16}/>查看输入文件</Button></div><div className="task-file-record"><div><span className="hint">输出文件</span><p className="path-text">{job.plan.outputPath}</p></div>{job.status==='completed'&&<Button variant="secondary" disabled={busy} onClick={()=>run(()=>window.muxivra.reveal(job.plan.outputPath))}><FolderOpen size={16}/>查看输出文件</Button>}</div></Card>
    <Card title="参数与引擎"><div className="task-engine-record"><strong>{job.plan.options.container.toUpperCase()} · {job.plan.options.video} / {job.plan.options.audio}</strong><span className="hint">FFmpeg {job.plan.engine.version}</span></div><p className="path-text">{job.plan.engine.ffmpegPath}</p><h4>完整处理参数</h4><pre className="code-box">{JSON.stringify(job.plan.options,null,2)}</pre><h4>{job.executedArgs?'实际执行参数':'计划参数'}</h4><pre className="code-box">{(job.executedArgs??job.plan.args).map(a=>JSON.stringify(a)).join(' ')}</pre></Card>
    <Card title="处理事件">{job.events?.length?<ol className="task-event-list">{job.events.map((event,i)=><li key={i}><time>{date(event.at)}</time><span>{event.message}</span></li>)}</ol>:<p className="hint">这条旧记录未保存事件明细。</p>}</Card>
    <Card title="完整日志" aside={<Button size="sm" variant="secondary" disabled={busy||logLoading} loading={logLoading} onClick={()=>read(positions[logIndex],logIndex)}><RefreshCw size={14}/>更新日志</Button>}>
      <div className="task-log-toolbar"><span className="hint">第 {logIndex+1} 段 · 共 {size(log?.totalBytes??0)}</span><div className="toolbar"><Button variant="ghost" size="sm" disabled={busy||!log?.text} onClick={()=>run(async()=>{await window.muxivra.copyText(log!.text);return true},'日志已复制')}><Copy size={14}/>复制当前日志</Button><Button variant="ghost" size="sm" disabled={busy||!log?.totalBytes} onClick={()=>run(()=>window.muxivra.reveal(job.logPath))}><FolderOpen size={14}/>查看日志文件</Button></div></div>
      {logLoading?<Busy text="正在读取日志…"/>:<pre className="code-box task-full-log">{log?.text||'暂无执行日志'}</pre>}
      <div className="task-log-pagination"><Button variant="secondary" size="sm" disabled={busy||logLoading||logIndex===0} onClick={()=>read(positions[logIndex-1],logIndex-1)}><ChevronLeft size={15}/>上一段</Button><Button variant="secondary" size="sm" disabled={busy||logLoading||!log?.hasMore} onClick={()=>read(log!.nextOffset,logIndex+1)}>下一段<ChevronRight size={15}/></Button></div>
    </Card>
  </div>
}
