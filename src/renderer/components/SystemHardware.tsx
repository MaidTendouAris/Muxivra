import { useState } from 'react'
import { ArrowLeft, ArrowUpRight, Cpu, MemoryStick, Monitor, RefreshCw } from 'lucide-react'
import type { Snapshot } from '../../shared/types'
import type { HardwareValue, GpuInfo } from '../../shared/hardware'
import { Button, Card, Input, Select } from './ui'
import type { RunAction } from './Jobs'
import { formatBytes } from '../lib/utils'

const shortCpu=(name:string)=>name.replace(/\(R\)|\(TM\)/g,'').replace(/\s+/g,' ').trim()
const gpuKind={physical:'实体显卡',virtual:'虚拟适配器',software:'软件渲染',unknown:'类型未确认'}
function Value<T>({field,format}:{field:HardwareValue<T>;format:(value:T)=>string}) {
  return <span className="hardware-value"><strong>{field.value===undefined?'—':format(field.value)}</strong>{field.status!=='available'&&<small className={field.status==='error'?'error-inline':''} title={field.detail}>{field.status==='error'?'读取失败':'信息缺失'}</small>}</span>
}
function Refresh({snapshot,run,busy}:{snapshot:Snapshot;run:RunAction;busy:boolean}) {
  return <Button size="sm" variant="secondary" disabled={busy||snapshot.hardwareRefreshing} onClick={()=> run(()=>window.muxivra.refreshHardware(),'硬件信息已更新')}><RefreshCw size={15} className={snapshot.hardwareRefreshing?'spin':''}/>{snapshot.hardwareRefreshing?'正在读取':'更新硬件信息'}</Button>
}
export function SystemHardware({snapshot,run,busy,onDetails}:{snapshot:Snapshot;run:RunAction;busy:boolean;onDetails:()=>void}) {
  const h=snapshot.hardware,physical=h.gpus.value?.filter(g=>g.kind==='physical')??[]
  const extra=(h.gpus.value?.length??0)-physical.length
  return <section className="card hardware-summary" aria-label="系统硬件摘要">
    <div className="card-heading"><h3>系统硬件</h3><div className="toolbar"><Refresh snapshot={snapshot} run={run} busy={busy}/><Button size="sm" variant="ghost" onClick={onDetails}>查看详细信息<ArrowUpRight size={16}/></Button></div></div>
    <div className="hardware-summary-grid">
      <div className="hardware-summary-item"><Cpu size={20}/><div><span>处理器</span><Value field={h.cpu} format={v=>v.models.map(shortCpu).join(' / ')}/><small>{h.cpu.value?`${h.cpu.value.physicalCores??'—'} 核心 / ${h.cpu.value.logicalCores} 线程`:'信息缺失'}</small></div></div>
      <div className="hardware-summary-item"><MemoryStick size={20}/><div><span>内存</span><Value field={h.memory} format={formatBytes}/><small>系统可用总容量</small></div></div>
      <div className="hardware-summary-item"><Monitor size={20}/><div><span>显卡</span>{physical.length?physical.map((gpu,index)=><div className="hardware-summary-gpu" key={gpu.id??index}><strong title={gpu.name.value}>{gpu.name.value??'未命名显卡'}</strong><span title={gpu.memoryBytes.detail}>{gpu.memoryBytes.value===undefined?'显存信息缺失':formatBytes(gpu.memoryBytes.value)}</span></div>):<Value field={h.gpus} format={()=>'实体显卡信息缺失'}/>}</div></div>
    </div>
    <div className="hardware-summary-footer"><span>{h.detectedAt?`更新于 ${new Date(h.detectedAt).toLocaleString('zh-CN')}`:'尚未完成读取'}</span>{(extra>0||h.warnings.length>0)&&<span>{extra>0?`${extra} 个其他适配器`:'部分信息不可用'}{h.warnings.length>0?' · 存在读取提示':''}</span>}</div>
  </section>
}
function GpuDetails({gpu,index}:{gpu:GpuInfo;index:number}) {
  return <article className="hardware-device"><div className="hardware-device-heading"><Monitor size={20}/><h3>{gpu.name.value??`显卡 ${index+1}`}</h3><span className="status">{gpuKind[gpu.kind]}</span></div><dl className="hardware-device-data"><div><dt>专用显存</dt><dd><Value field={gpu.memoryBytes} format={formatBytes}/></dd></div><div><dt>共享内存上限</dt><dd><Value field={gpu.sharedMemoryBytes} format={formatBytes}/></dd></div><div><dt>厂商</dt><dd><Value field={gpu.vendor} format={v=>v}/></dd></div><div><dt>驱动</dt><dd><Value field={gpu.driver} format={v=>v}/></dd></div></dl>
    <div className="hardware-device-meta"><span>容量来源：{gpu.memorySource==='NVML'?'NVIDIA 驱动物理容量':gpu.memorySource==='DXGI'?'DXGI 系统可用容量':'信息缺失'}</span>{gpu.pciAddress&&<span>PCI {gpu.pciAddress}</span>}{gpu.usableMemoryBytes!==undefined&&gpu.memorySource==='NVML'&&<span>系统可用专用显存 {formatBytes(gpu.usableMemoryBytes)}</span>}</div>
    {(gpu.memoryBytes.status!=='available'||gpu.driver.status!=='available')&&<p className="hint">{[gpu.memoryBytes.status!=='available'?gpu.memoryBytes.detail:undefined,gpu.driver.status!=='available'?gpu.driver.detail:undefined].filter(Boolean).join('；')}</p>}
    {gpu.adapterIds&&<details className="hardware-identifiers"><summary>适配器标识</summary><code>{gpu.adapterIds.join(' · ')}</code></details>}
  </article>
}
export function HardwareDetails({snapshot,run,busy,onBack}:{snapshot:Snapshot;run:RunAction;busy:boolean;onBack:()=>void}) {
  const {hardware:h,engine}=snapshot,[kind,setKind]=useState('encoders'),[search,setSearch]=useState('')
  const physical=h.gpus.value?.filter(g=>g.kind==='physical')??[],other=h.gpus.value?.filter(g=>g.kind!=='physical')??[]
  const capabilities=engine?.[kind as 'encoders'|'decoders'|'filters']??[],shown=capabilities.filter(name=>name.toLowerCase().includes(search.toLowerCase()))
  return <div className="hardware-details-page"><div className="hardware-page-heading"><div><Button size="sm" variant="ghost" onClick={onBack}><ArrowLeft size={16}/>返回设置</Button><h2>硬件详细信息</h2></div><Refresh snapshot={snapshot} run={run} busy={busy}/></div>
    <div className="hardware-overview"><Card title="处理器"><Value field={h.cpu} format={v=>v.models.join(' / ')}/><dl className="hardware-facts"><div><dt>物理核心</dt><dd>{h.cpu.value?.physicalCores??'信息缺失'}</dd></div><div><dt>逻辑线程</dt><dd>{h.cpu.value?.logicalCores??'信息缺失'}</dd></div></dl>{h.cpu.detail&&<p className="hint">{h.cpu.detail}</p>}</Card><Card title="系统"><dl className="hardware-facts"><div><dt>内存</dt><dd><Value field={h.memory} format={formatBytes}/></dd></div><div><dt>操作系统</dt><dd><Value field={h.system} format={v=>v}/></dd></div><div><dt>架构</dt><dd><Value field={h.architecture} format={v=>v}/></dd></div></dl></Card></div>
    <Card title={`显卡 · ${physical.length} 个实体设备`}><div className="hardware-devices">{physical.map((gpu,index)=><GpuDetails key={gpu.id??index} gpu={gpu} index={index}/>)}</div>{!physical.length&&<p className="hint">{h.gpus.detail??'实体显卡信息缺失'}</p>}{other.length>0&&<details className="hardware-other"><summary>其他适配器 · {other.length}</summary><div className="hardware-devices">{other.map((gpu,index)=><GpuDetails key={gpu.id??index} gpu={gpu} index={index}/>)}</div></details>}<p className="hint">共享内存是显卡可借用的系统内存上限，不计入物理显存容量。</p></Card>
    <Card title="FFmpeg 编解码能力" aside={<span className="hint">{engine?.version??'未配置引擎'}</span>}><div className="hardware-capability-toolbar"><Select aria-label="能力类型" value={kind} onChange={e=>setKind(e.target.value)}><option value="encoders">编码器 · {engine?.encoders.length??0}</option><option value="decoders">解码器 · {engine?.decoders.length??0}</option><option value="filters">滤镜 · {engine?.filters.length??0}</option></Select><Input aria-label="搜索编解码能力" placeholder="搜索名称" value={search} onChange={e=>setSearch(e.target.value)}/></div><p className="hint">硬件加速尚未进行实际验证。以下名称表示引擎包含对应后端。</p><div className="hardware-capability-list">{shown.map(name=><code key={name}>{name}</code>)}</div>{shown.length===0&&<p className="hint">{engine?'没有匹配项':'信息缺失：请配置 FFmpeg'}</p>}</Card>
    <div className="hardware-read-status"><span>{h.detectedAt?`读取时间 ${new Date(h.detectedAt).toLocaleString('zh-CN')}`:'尚未完成读取'}</span><span>来源 {h.collector}</span>{h.warnings.map((warning,index)=><p key={index} className="error-inline">{warning}</p>)}<span>开启 MCP 查询权限后，AI 可读取这些设备、能力和缺失信息。</span></div>
  </div>
}
