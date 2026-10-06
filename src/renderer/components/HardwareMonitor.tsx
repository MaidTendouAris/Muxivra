import { useEffect, useState } from 'react'
import { Activity, ChevronDown, ChevronUp, Cpu, MemoryStick, Monitor } from 'lucide-react'
import type { HardwareValue, SystemUsage, GpuUsage } from '../../shared/hardware'
import { Button, Busy } from './ui'
import { formatBytes } from '../lib/utils'

const percent=(value:number)=>`${value.toFixed(1)}%`
const display=(field?:HardwareValue<number>)=>field?.value===undefined?'—':`${Math.round(field.value)}%`
function Meter({value}:{value?:number}){return <span className={`usage-meter ${value===undefined?'unavailable':''}`}><span style={{width:`${Math.min(100,Math.max(0,value??0))}%`}}/></span>}
function Sparkline({values}:{values:(number|undefined)[]}) {
  const points=values.flatMap((value,index)=>value===undefined?[]:[`${index*100/Math.max(1,values.length-1)},${28-value*0.26}`]).join(' ')
  return <svg className="usage-sparkline" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke"/></svg>
}
function GpuMetric({label,field}:{label:string;field:HardwareValue<number>}) {
  return <div className="usage-gpu-metric" title={field.detail}><span>{label}</span><strong>{field.value===undefined?'不可用':percent(field.value)}</strong><Meter value={field.value}/></div>
}
function MemoryMetric({label,field,total}:{label:string;field:HardwareValue<number>;total?:number}) {
  return <div className="usage-memory-metric" title={field.detail}><div><span>{label}</span><strong>{field.value===undefined?'不可用':`${formatBytes(field.value)}${total===undefined?'':` / ${formatBytes(total)}`}`}</strong></div><Meter value={field.value!==undefined&&total?field.value/total*100:undefined}/></div>
}
function GpuPanel({gpu,index}:{gpu:GpuUsage;index:number}) {
  return <article className="usage-gpu"><h4><Monitor size={16}/><span>GPU {index} · {gpu.name}</span></h4><div className="usage-gpu-metrics"><GpuMetric label="整体占用" field={gpu.utilization}/><GpuMetric label="编码器" field={gpu.encoder}/><GpuMetric label="解码器" field={gpu.decoder}/></div><MemoryMetric label="专用显存" field={gpu.dedicatedBytes} total={gpu.dedicatedTotal}/><MemoryMetric label="共享内存" field={gpu.sharedBytes} total={gpu.sharedTotal}/>{gpu.engines.length>0&&<details className="usage-engines"><summary>所有 GPU 引擎 · {gpu.engines.length}</summary><div>{gpu.engines.map((engine,i)=><div key={i}><span>{engine.name}</span><strong>{percent(engine.utilization)}</strong><Meter value={engine.utilization}/></div>)}</div></details>}{gpu.utilization.status!=='available'&&<small className="hint">{gpu.utilization.detail}</small>}</article>
}
export function HardwareMonitor({visible}:{visible:boolean}) {
  const [expanded,setExpanded]=useState(false),[usage,setUsage]=useState<SystemUsage>(),[error,setError]=useState(''),[history,setHistory]=useState<{cpu:(number|undefined)[];gpu:(number|undefined)[]}>({cpu:[],gpu:[]})
  useEffect(()=>{
    if(!visible)return
    setUsage(undefined);setHistory({cpu:[],gpu:[]});setError('')
    let live=true,timer:ReturnType<typeof setTimeout>|undefined,inFlight=false
    const sample=async()=>{
      if(!live||document.hidden||inFlight)return
      clearTimeout(timer);inFlight=true
      try {
        const value=await window.muxivra.systemUsage()
        if(live&&!document.hidden){setUsage(value);setError('');setHistory(old=>({cpu:[...old.cpu,value.cpu.value].slice(-60),gpu:[...old.gpu,value.gpu.value].slice(-60)}))}
      }catch(e){if(live){setError((e as Error).message);setUsage(undefined)}}
      finally{inFlight=false;if(live&&!document.hidden)timer=setTimeout(()=>void sample(),1000)}
    }
    const visibility=()=>{if(document.hidden){clearTimeout(timer);setUsage(undefined);setHistory({cpu:[],gpu:[]})}else void sample()}
    void sample();document.addEventListener('visibilitychange',visibility)
    return()=>{live=false;clearTimeout(timer);document.removeEventListener('visibilitychange',visibility)}
  },[visible])
  if(!visible)return null
  return <section className={`hardware-monitor ${expanded?'expanded':''}`} aria-label="实时硬件监控" onKeyDown={e=>{if(e.key==='Escape')setExpanded(false)}}>
    <div className="usage-header"><div className="usage-title"><Activity size={18}/><strong>硬件监控</strong><span className="usage-live" title={error||'每秒采样'}>{error?'采样失败':usage?'实时':<Busy text="采样中…"/>}</span></div><div className="usage-summary"><div title={usage?.cpu.detail}><Cpu size={16}/><span>CPU</span><strong>{display(usage?.cpu)}</strong><Sparkline values={history.cpu}/></div><div title={usage?.gpu.detail}><Monitor size={16}/><span>GPU</span><strong>{display(usage?.gpu)}</strong><Sparkline values={history.gpu}/></div><div className="usage-summary-memory"><MemoryStick size={16}/><span>内存</span><strong>{usage?`${Math.round(usage.memory.percent)}%`:'—'}</strong></div></div><Button size="icon" variant="ghost" aria-label={expanded?'收起硬件监控':'展开硬件监控'} aria-expanded={expanded} aria-controls="hardware-monitor-detail" onClick={()=>setExpanded(!expanded)}>{expanded?<ChevronDown size={20}/>:<ChevronUp size={20}/>}</Button></div>
    {expanded&&<div id="hardware-monitor-detail" className="usage-detail"><div className="usage-detail-grid"><article className="usage-cpu"><div className="usage-section-heading"><h4>CPU 逻辑线程</h4><span>{usage?.threads.value?.length??'—'} 个线程</span></div><div className="usage-thread-grid">{usage?.threads.value?.map((value,index)=><div className="usage-thread" key={index} title={`线程 ${index+1}：${percent(value)}`}><span>T{String(index+1).padStart(2,'0')}</span><strong>{Math.round(value)}%</strong><Meter value={value}/></div>)}</div>{!usage?.threads.value&&<p className="hint">{usage?.threads.detail??(error||'等待 CPU 样本')}</p>}<div className="usage-ram"><div className="usage-section-heading"><h4>系统内存</h4><strong>{usage?percent(usage.memory.percent):'—'}</strong></div><Meter value={usage?.memory.percent}/><div><span>已用 {usage?formatBytes(usage.memory.usedBytes):'—'}</span><span>可用 {usage?formatBytes(usage.memory.totalBytes-usage.memory.usedBytes):'—'}</span><span>总计 {usage?formatBytes(usage.memory.totalBytes):'—'}</span></div></div></article><div className="usage-gpus">{usage?.gpus.map((gpu,index)=><GpuPanel gpu={gpu} index={index} key={gpu.id}/>)}{!usage?.gpus.length&&<p className="hint">{usage?.gpu.detail??(error||'等待 GPU 样本')}</p>}</div></div><div className="usage-footer"><span>{usage?`采样于 ${new Date(usage.sampledAt).toLocaleTimeString('zh-CN')}`:'等待采样'}</span><span title="GPU 整体占用取最忙引擎；多显卡摘要取最忙显卡。">系统整体占用 · GPU 取最忙引擎</span></div></div>}
  </section>
}
