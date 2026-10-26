import { tr } from '../lib/i18n'
import { asrBackendLabels,parseAsrParameters,asrPrecisionLabel } from '../../shared/asr-parameters'
import { useEffect,useRef,useState } from 'react'
import { AudioLines,Download,Trash2,Play,FileText,ArrowRight,Copy,ChevronLeft,ChevronRight,Boxes } from 'lucide-react'
import type { Snapshot,MediaInfo,Job } from '../../shared/types'
import { asrSubtitleCues,asrUsesChunks,asrModeLabel,asrRecognitionSchema,type AsrResult } from '../../shared/asr'
import { createSubtitleDocument } from '../../shared/subtitles'
import { Button,Card,Field,Input,Select,Modal,Progress,Busy } from '../components/ui'
import { statusLabels,type RunAction } from '../components/Jobs'
import { formatDuration,formatTime,formatBytes } from '../lib/utils'

export function AsrWorkbench({snapshot,run,busy,visible,onTasks,onEdit,onProjects,onResources}:{snapshot:Snapshot;run:RunAction;busy:boolean;visible:boolean;onTasks:()=>void;onProjects:()=>void;onResources:(modelId?:string)=>void;onEdit:(id:string)=>void}) {
  const [media,setMedia]=useState<MediaInfo>(),[modelId,setModelId]=useState(''),[audioStream,setAudioStream]=useState(0)
  const [start,setStart]=useState('0'),[end,setEnd]=useState('')
  const [selectedId,setSelectedId]=useState(''),[result,setResult]=useState<AsrResult>(),[resultError,setResultError]=useState(''),[loading,setLoading]=useState(false),[raw,setRaw]=useState<string>(),[page,setPage]=useState(1),[recordPage,setRecordPage]=useState(1)
  const [deleting,setDeleting]=useState<string[]>(),[removing,setRemoving]=useState(false),[selectedRecords,setSelectedRecords]=useState<string[]>([])
  const pendingSelection=useRef<string|undefined>(undefined)
  const pendingModel=useRef<string|undefined>(undefined)
  const deployedAt=useRef<string|undefined>(undefined)
  const state=snapshot.asr,models=state?.models??[]
  useEffect(()=>{const deployed=state?.deployment;if(deployed?.phase==='completed'&&deployed.startedAt!==deployedAt.current){deployedAt.current=deployed.startedAt;const selected=models.find(value=>value.id===deployed.modelId);if(selected){pendingModel.current=selected.id;setModelId(selected.id)}}},[state?.deployment?.phase,state?.deployment?.startedAt,models])
  const project=snapshot.projects?.items.find(p=>p.id===snapshot.projects?.activeId)
  const jobs=snapshot.jobs.filter(j=>j.plan.kind==='asr'&&!!project&&j.plan.projectId===project.id).slice().reverse(),job=jobs.find(j=>j.id===selectedId),active=jobs.filter(j=>['queued','running','paused'].includes(j.status))
  const readyModels=models.filter(m=>m.availability==='ready'&&(!['qwen3-asr','moss-transcribe-diarize'].includes(m.backend)||m.environment?.probe?.ready))
  const model=readyModels.find(m=>m.id===modelId),config=asrRecognitionSchema.parse({...model?.recognition,parameters:parseAsrParameters(model?.backend??'custom',model?.recognition?.parameters)}),current=result?.jobId===selectedId?result:undefined,timed=current?.segments.filter(s=>s.startMs!==undefined)??[]
  useEffect(()=>{if(!visible)return;let live=true;if(!project){setMedia(undefined);return}void window.muxivra.inspect(project.mediaPath).then(info=>{if(live){setMedia(info);if(media?.path!==project.mediaPath){setAudioStream(info.streams.find(s=>s.type==='audio')?.index??0);setStart('0');setEnd('')}}}).catch(error=>{if(live)void run(async()=>{throw error})});return()=>{live=false}},[project?.id,visible,snapshot.engine?.id])
  useEffect(()=>{if(pendingModel.current){if(!models.some(m=>m.id===pendingModel.current))return;pendingModel.current=undefined}if(!readyModels.some(m=>m.id===modelId))setModelId(readyModels[0]?.id??'')},[JSON.stringify(readyModels.map(m=>m.id)),modelId])
  useEffect(()=>{
    // Submission can return before the corresponding queue snapshot arrives.
    if(pendingSelection.current){if(!jobs.some(j=>j.id===pendingSelection.current))return;pendingSelection.current=undefined}
    if(!selectedId&&jobs.length)setSelectedId(jobs[0].id);else if(selectedId&&!jobs.some(j=>j.id===selectedId)){setSelectedId(jobs[0]?.id??'');setResult(undefined)}
  },[jobs.map(j=>j.id).join('|'),selectedId])
  useEffect(()=>{
    if(!visible||job?.status!=='completed'){setLoading(false);return}
    let live=true;setLoading(true);setResultError('');setPage(1)
    window.muxivra.asrResult(selectedId).then(value=>{if(live)setResult(value)}).catch(error=>{if(live)setResultError((error as Error).message)}).finally(()=>{if(live)setLoading(false)})
    return()=>{live=false}
  },[selectedId,job?.status,visible])
  const submit=()=>run(async()=>{
    if(!project||!media||media.path!==project.mediaPath||!model)throw new Error(tr("请先打开已有工程并选择 ASR 模型"))
    // Resource saves can finish before the debounced renderer snapshot arrives.
    const latest=(await window.muxivra.snapshot()).asr?.models.find(value=>value.id===model.id&&value.availability==='ready')
    if(!latest)throw new Error(tr("所选模型尚未配置为可用，请前往资源管理检查。"))
    const recognition=asrRecognitionSchema.parse({...latest.recognition,parameters:parseAsrParameters(latest.backend,latest.recognition?.parameters)})
    const value=await window.muxivra.asrSubmit({inputPath:media.path,modelId:latest.id,audioStream,...recognition,startMs:Math.round(Number(start)*1000),endMs:end?Math.round(Number(end)*1000):undefined});pendingSelection.current=value.id;setSelectedId(value.id);setRecordPage(1);setResult(undefined);return value
  },tr("识别任务已加入队列"))
  const finished=jobs.filter(j=>!['queued','running','paused'].includes(j.status)),selectedFinished=selectedRecords.filter(id=>finished.some(j=>j.id===id))
  useEffect(()=>{setSelectedRecords([]);setRecordPage(1)},[project?.id])
  const deleteRecord=()=>run(async()=>{
    if(!deleting)return;setRemoving(true)
    try{
      await window.muxivra.deleteJobRecords(deleting)
      if(deleting.includes(selectedId)){setSelectedId(jobs.find(value=>!deleting.includes(value.id))?.id??'');setResult(undefined);setResultError('');setRaw(undefined)}
      setRecordPage(value=>Math.min(value,Math.max(1,Math.ceil((jobs.length-deleting.length)/10))));setSelectedRecords(value=>value.filter(id=>!deleting.includes(id)));setDeleting(undefined)
    }finally{setRemoving(false)}
  },tr("识别记录已删除"))
  const exportDraft=(format:'ass'|'srt')=>run(()=>window.muxivra.exportSubtitles(createSubtitleDocument({cues:asrSubtitleCues(format==='srt'?timed:current?.segments??[],()=>crypto.randomUUID())}),format),tr("初稿已导出"))
  const pages=Math.max(1,Math.ceil((current?.segments.length??0)/50)),shown=current?.segments.slice((page-1)*50,page*50)??[],recordPages=Math.max(1,Math.ceil(jobs.length/10))
  const jobLabel=(value:Job)=>value.plan.kind==='asr'?`${value.plan.input.name} · ${value.plan.asr.model.name}`:value.plan.input.name

  return <div className="asr-page">
    <div className="asr-workspace"><div className="asr-controls card">
      <Card title={tr("媒体")} aside={<div className="toolbar"><Button variant="secondary" size="sm" onClick={onProjects}><ArrowRight size={15}/>{tr("项目管理")}</Button></div>}>
        {media?<div className="asr-source inner-card"><AudioLines size={22}/><div><strong title={media.path}>{media.name}</strong><span className="hint">{formatDuration(media.durationMs)} · {formatBytes(media.size)}</span></div></div>:<p className="hint">{tr("请打开已有工程；新建项目请前往项目管理。")}</p>}
        {media&&<><Field label={tr("识别音轨")}><Select value={audioStream} onChange={e=>setAudioStream(Number(e.target.value))}>{media.streams.filter(s=>s.type==='audio').map(s=><option key={s.index} value={s.index}>#{s.index} · {s.codec.toUpperCase()} {s.language} {s.title}</option>)}</Select></Field><div className="parameter-grid"><Field label={tr("开始时间（秒）")}><Input type="number" min="0" step="0.001" value={start} onChange={e=>setStart(e.target.value)}/></Field><Field label={tr("结束时间（秒）")}><Input type="number" min="0" step="0.001" placeholder={tr("媒体结束")} value={end} onChange={e=>setEnd(e.target.value)}/></Field></div></>}
      </Card>
      <Card title={tr("模型")} aside={<Button size="sm" variant="secondary" onClick={()=>onResources()}><Boxes size={16}/>{tr("资源管理")}</Button>}>
        <Field label={tr("当前模型")}><Select value={modelId} onChange={e=>setModelId(e.target.value)} disabled={!readyModels.length}><option value="">{tr("请选择模型")}</option>{readyModels.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
        {model?<div className="inner-card asr-model-info"><div><strong>{tr(asrBackendLabels[model.backend])}</strong><span className="hint">{model.environment?.name??(model.backend==='whisper.cpp'?'whisper.cpp':model.backend==='custom'?tr("自定义程序"):tr("未配置"))}</span></div>{model.issue&&<p className="error-inline">{tr(model.issue)}</p>}</div>:<p className="hint">{tr("请先在资源管理下载或导入模型，并完成环境和识别参数配置。")}</p>}
      </Card>
      <Card title={tr("识别配置")} aside={<Button size="sm" variant="ghost" onClick={()=>onResources(model?.id)}>{tr("前往配置")}<ArrowRight size={14}/></Button>}>{!model?<p className="hint">{tr("资源管理中配置为可用的模型会显示在这里。")}</p>:<div className="asr-config-summary"><div><span className="hint">{tr("后端")}</span><strong>{tr(asrBackendLabels[model?.backend??'custom'])}</strong></div><div><span className="hint">{tr("模型精度")}</span><strong>{tr(asrPrecisionLabel(model?.backend??'custom',config.parameters))}</strong></div><div><span className="hint">{tr("语言 / 设备")}</span><strong>{config.language} · {config.device==='auto'?tr("自动"):config.device.toUpperCase()}</strong></div><div><span className="hint">{tr("音频范围")}</span><span>{start} {tr("秒 →")}{end||tr("媒体结束")}</span></div><div><span className="hint">{tr("提交方式")}</span><strong>{tr(asrModeLabel(config))}</strong></div></div>}<Button className="asr-start" disabled={busy||!project||!media||!model||model.availability==='missing'||!snapshot.engine} loadingText={tr("提交中…")} onClick={submit}><Play size={17}/>{tr("生成字幕初稿")}</Button></Card>
    </div><div className="asr-results">
      <Card className="asr-history-card" title={tr("识别记录")} aside={<div className="toolbar"><span className="hint">{jobs.length} {tr("条")}</span><Button variant="secondary" size="sm" onClick={onTasks}><ArrowRight size={15}/>{tr("打开任务队列")}</Button></div>}><div className="asr-history-tools"><label><input type="checkbox" aria-label={tr("选择全部可删除记录")} checked={finished.length>0&&selectedFinished.length===finished.length} disabled={!finished.length||removing} onChange={e=>setSelectedRecords(e.target.checked?finished.map(j=>j.id):[])}/>{tr("选择全部可删除记录")}</label><Button variant="ghost" size="sm" disabled={busy||!selectedFinished.length} onClick={()=>setDeleting(selectedFinished)}><Trash2 size={14}/>{tr("删除所选")} {selectedFinished.length||""}</Button></div><div className="asr-record-list">{!jobs.length&&<p className="hint">{tr("暂无识别任务。")}</p>}{jobs.slice((Math.min(recordPage,recordPages)-1)*10,Math.min(recordPage,recordPages)*10).map(value=><div key={value.id} className={`asr-record inner-card ${selectedId===value.id?'selected':''}`}><input type="checkbox" aria-label={tr("选择识别记录 {0}",value.plan.input.name)} checked={selectedFinished.includes(value.id)} disabled={busy||['queued','running','paused'].includes(value.status)} onChange={e=>setSelectedRecords(ids=>e.target.checked?[...ids,value.id]:ids.filter(id=>id!==value.id))}/><button className="asr-record-select" aria-pressed={selectedId===value.id} onClick={()=>{setSelectedId(value.id);setResultError('')}}><span title={jobLabel(value)}>{jobLabel(value)}</span><span className={`status status-${value.status}`}>{tr(statusLabels[value.status])}</span></button><Button variant="ghost" size="icon" aria-label={tr("删除识别记录")} title={['queued','running','paused'].includes(value.status)?tr("请先取消任务再删除记录"):tr("删除识别记录")} disabled={busy||['queued','running','paused'].includes(value.status)} onClick={()=>setDeleting([value.id])}><Trash2 size={15}/></Button></div>)}</div>{recordPages>1&&<div className="toolbar asr-pagination"><Button variant="ghost" size="sm" disabled={recordPage<=1} onClick={()=>setRecordPage(p=>p-1)}><ChevronLeft size={15}/></Button><span>{Math.min(recordPage,recordPages)} / {recordPages}</span><Button variant="ghost" size="sm" disabled={recordPage>=recordPages} onClick={()=>setRecordPage(p=>p+1)}><ChevronRight size={15}/></Button></div>}</Card>
      <Card className="asr-draft-card" title={tr("字幕初稿")} aside={job&&<span className={`status status-${job.status}`}>{tr(statusLabels[job.status])}</span>}><div className="asr-draft-body">
        {job&&['queued','running','paused'].includes(job.status)&&<div className="asr-processing inner-card">{job.status==='paused'?<strong>{tr("已暂停")}</strong>:<Busy text={job.pausing?tr("等待当前分块完成后暂停"):tr(job.stage)??tr(statusLabels[job.status])}/>}<Progress value={job.progress} indeterminate={job.progressIndeterminate}/><div className="toolbar"><span>{job.progressIndeterminate?tr("处理中"):`${job.progressScope==='stage'?tr("当前阶段 "):''}${job.progress.toFixed(1)}%`}</span><span className="hint">{tr("已用")}{formatDuration(job.elapsedMs??0)}</span></div><Button variant="secondary" onClick={onTasks}>{tr("管理暂停、取消与任务顺序")}</Button></div>}
        {job?.error&&<p className="error-inline">{job.error}</p>}{resultError&&<p className="error-inline">{resultError}</p>}
        {loading?<Busy text={tr("正在读取字幕初稿…")}/>:current?<><div className="asr-result-summary inner-card"><span>{current.segments.length} {tr("条 ·")}{timed.length} {tr("条带时间 ·")}{current.language??tr("未返回语言")}</span><span className="hint">{current.model.name}</span></div><div className="toolbar asr-result-actions"><Button disabled={busy||!current.segments.length} onClick={()=>onEdit(current.jobId)}><ArrowRight size={16}/>{tr("编辑初稿")}</Button><Button variant="secondary" disabled={busy||!current.segments.length} onClick={()=>exportDraft('ass')}><Download size={16}/>{tr("导出 ASS")}</Button><Button variant="secondary" disabled={busy||!timed.length} onClick={()=>exportDraft('srt')}><Download size={16}/>{tr("导出 SRT")}</Button><Button variant="ghost" size="sm" disabled={busy||!current.segments.length} onClick={()=>run(()=>window.muxivra.copyText(current.segments.map(s=>s.text).join('\n')),tr("文本已复制"))}><Copy size={15}/>{tr("复制文本")}</Button></div>
        {!!(current.segments.length-timed.length)&&<p className="hint">{current.segments.length-timed.length} {tr("条未提供时间戳，保留为未打轴文本；编辑初稿时作为 ASS 注释条目导入。")}</p>}
        <div className="asr-preview-table"><table className="asr-cue-table"><thead><tr><th>#</th><th>{tr("开始 → 结束")}</th><th>{tr("文本")}</th><th>{tr("时长")}</th></tr></thead><tbody>{shown.map((s,i)=><tr key={i}><td>{(page-1)*50+i+1}</td><td>{s.startMs===undefined?tr("未打轴"):<>{formatTime(s.startMs)} → {formatTime(s.endMs!)}{s.estimated&&<span title={tr("估算")}> ≈</span>}</>}</td><td title={s.text}>{s.speaker&&<span className="tag">{s.speaker}</span>} {s.text}</td><td>{s.startMs!==undefined&&s.endMs!==undefined?`${((s.endMs-s.startMs)/1000).toFixed(2)}s`:"—"}</td></tr>)}</tbody></table>{!current.segments.length&&<p className="hint">{tr("模型未返回字幕条目。可查看原始结果及日志。")}</p>}</div><div className="asr-pagination"><span className="hint">{tr("每页 50 条 ·")}{page} / {pages}</span><div className="toolbar"><Button variant="secondary" size="sm" disabled={page===1} onClick={()=>setPage(p=>p-1)}><ChevronLeft size={15}/>{tr("上一页")}</Button><Button variant="secondary" size="sm" disabled={page===pages} onClick={()=>setPage(p=>p+1)}>{tr("下一页")}<ChevronRight size={15}/></Button></div></div>
        <details className="asr-raw-panel"><summary>{tr("原始模型结果 ·")}{asrModeLabel(current.options)}</summary><div className="toolbar">{current.rawFiles.map((file,index)=><Button key={file} variant="secondary" size="sm" disabled={busy} onClick={()=>run(async()=>{setRaw(await window.muxivra.asrRaw(current.jobId,index))})}><FileText size={14}/>{asrUsesChunks(current.options)?tr("第 {0} 段",index+1):tr("整段结果")}</Button>)}</div></details></>:!job&&<p className="hint">{tr("提交识别任务后，在这里预览字幕初稿。")}</p>}
      </div></Card>
    </div></div>
    {deleting&&<Modal title={tr("删除识别记录")} locked={removing} onClose={()=>setDeleting(undefined)}><p>{tr("将删除 {0} 条识别记录。",deleting.length)}</p><p>{tr("删除此记录、字幕初稿、原始结果及日志？源音视频、已保存的字幕工程和导出字幕会保留。")}</p><div className="toolbar"><Button variant="secondary" disabled={removing} onClick={()=>setDeleting(undefined)}>{tr("取消")}</Button><Button disabled={busy} loading={removing} loadingText={tr("正在删除…")} onClick={deleteRecord}>{tr("删除记录")}</Button></div></Modal>}
    {raw!==undefined&&<Modal title={tr("原始模型结果")} onClose={()=>setRaw(undefined)}><pre className="code-box asr-raw-json">{raw.slice(0,100000)}</pre>{raw.length>100000&&<p className="hint">{tr("此处显示前 100000 个字符，完整结果保存在 ASR 缓存中。")}</p>}</Modal>}
  </div>
}
