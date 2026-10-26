import { useEffect,useRef,useState } from 'react'
import { ChevronLeft,ChevronRight,Scissors } from 'lucide-react'
import type { Cue } from '../../shared/subtitles'
import { frameAt,frameTime,type VideoTiming } from '../../shared/video-timing'
import { tr } from '../lib/i18n'
import { formatTime,parseTime } from '../lib/utils'
import { Button,Busy,Input } from './ui'
import type { RunAction } from './Jobs'

function TimingField({label,value,onCommit,frame,frameLabel,maximum,onFrame,run}:{label:string;value:number;onCommit:(value:number)=>void;frame?:number;frameLabel:string;maximum?:number;onFrame?:(value:number)=>void;run:RunAction}){
  const [text,setText]=useState(formatTime(value)),[number,setNumber]=useState(String(frame??0))
  useEffect(()=>setText(formatTime(value)),[value])
  useEffect(()=>setNumber(String(frame??0)),[frame])
  const commitTime=()=>void run(async()=>{try{const next=parseTime(text);if(next<0||next>359999999)throw new Error(tr('时间不能超过 99:59:59,999'));if(next!==value)onCommit(next)}catch(error){setText(formatTime(value));throw error}})
  const commitFrame=()=>void run(async()=>{const next=Number(number);if(!number.trim()||!Number.isInteger(next)||next<0||next>(maximum??0)){setNumber(String(frame??0));throw new Error(tr('帧编号超出视频范围'))}try{if(next!==frame)onFrame?.(next)}catch(error){setNumber(String(frame??0));throw error}})
  return <div className="field subtitle-timing-field"><span>{label}</span><Input aria-label={label} value={text} onChange={event=>setText(event.target.value)} onBlur={commitTime} onKeyDown={event=>{if(event.key==='Enter')event.currentTarget.blur()}}/>{frame!==undefined&&onFrame&&<div className="subtitle-inline-frame"><span title={frameLabel}>{tr('帧')}</span><Input type="number" min={0} max={maximum} aria-label={frameLabel} title={frameLabel} value={number} onChange={event=>setNumber(event.target.value)} onBlur={commitFrame} onKeyDown={event=>{if(event.key==='Enter')event.currentTarget.blur()}}/><Button size="icon" variant="ghost" aria-label={tr('{0}上一帧',label)} disabled={frame<=0} onClick={()=>run(async()=>onFrame(frame-1))}><ChevronLeft size={13}/></Button><Button size="icon" variant="ghost" aria-label={tr('{0}下一帧',label)} disabled={frame>=(maximum??0)} onClick={()=>run(async()=>onFrame(frame+1))}><ChevronRight size={13}/></Button></div>}</div>
}

/** The stored project index is read once. Frame edits share the time fields. */
export function SubtitleTiming({path,active,time,cue,onSeek,onPatch,onSplit,onBoundary,startTitle,endTitle,run}:{path:string;active:boolean;time:number;cue:Cue;onSeek:(ms:number)=>void;onSplit:(ms:number)=>void;onPatch:(patch:Partial<Cue>|((cue:Cue)=>Partial<Cue>))=>void;onBoundary:(edge:'start'|'end')=>Promise<void>;startTitle:string;endTitle:string;run:RunAction}){
  const [timing,setTiming]=useState<VideoTiming>(),[loading,setLoading]=useState(false),[error,setError]=useState(''),[revision,setRevision]=useState(0),generation=useRef(0)
  useEffect(()=>{const id=++generation.current;if(!active)return;setTiming(undefined);setError('');setLoading(!!path);if(path)void window.muxivra.videoFrames(path).then(value=>{if(id===generation.current)setTiming(value)}).catch(reason=>{if(id===generation.current)setError((reason as Error).message)}).finally(()=>{if(id===generation.current)setLoading(false)});return()=>{generation.current++}},[path,revision,active])
  const current=timing?frameAt(timing,time):0,start=timing?frameAt(timing,cue.startMs):0,end=timing?frameAt(timing,cue.endMs,true):0
  const duration=(value:number)=>onPatch(item=>{if(value<=0||item.startMs+value>359999999)throw new Error(tr('时长必须大于零，结束时间不能超过 99:59:59,999'));return {endMs:item.startMs+value}})
  const seekKey=(direction:number)=>{if(!timing)return;const frame=direction<0?[...timing.keyframes].reverse().find(value=>value<current):timing.keyframes.find(value=>value>current);if(frame!==undefined)onSeek(frameTime(timing,frame))}
  return <div className="subtitle-inner-card subtitle-timing-card"><div className="form-grid">
    <TimingField label={tr('开始时间')} value={cue.startMs} onCommit={value=>onPatch({startMs:value})} frame={timing?start:undefined} frameLabel={tr('起始帧（从 0 编号）')} maximum={timing?timing.timestampsMs.length-1:0} onFrame={timing?value=>onPatch({startMs:frameTime(timing,value)}):undefined} run={run}/>
    <TimingField label={tr('结束时间')} value={cue.endMs} onCommit={value=>onPatch({endMs:value})} frame={timing?end:undefined} frameLabel={tr('结束帧（不含）')} maximum={timing?.timestampsMs.length} onFrame={timing?value=>onPatch({endMs:frameTime(timing,value)}):undefined} run={run}/>
  </div><TimingField label={tr('时长')} value={Math.max(0,cue.endMs-cue.startMs)} onCommit={duration} frame={timing?Math.max(0,end-start):undefined} frameLabel={tr('持续帧数')} maximum={timing?timing.timestampsMs.length-start:0} onFrame={timing?value=>{if(value<=0)throw new Error(tr('持续帧数必须大于零'));onPatch(item=>({endMs:frameTime(timing,frameAt(timing,item.startMs)+value)}))}:undefined} run={run}/>
  <div className="toolbar subtitle-timing-actions"><Button size="sm" variant="secondary" title={startTitle} onClick={()=>run(()=>onBoundary('start'))}>{tr('设置起点')}</Button><Button size="sm" variant="secondary" title={endTitle} onClick={()=>run(()=>onBoundary('end'))}>{tr('设置终点')}</Button><Button size="sm" variant="ghost" onClick={()=>onSeek(cue.startMs)}>{tr('定位')}</Button>{timing&&<span className="hint subtitle-frame-status">{tr('帧 {0} / {1}',current,timing.timestampsMs.length-1)} · {timing.variable?'VFR':'CFR'}</span>}</div>
  {timing&&<div className="toolbar subtitle-keyframe-actions"><Button size="sm" variant="ghost" disabled={!timing.keyframes.some(value=>value<current)} onClick={()=>seekKey(-1)}><ChevronLeft size={14}/>{tr('上一关键帧')}</Button><Button size="sm" variant="ghost" disabled={!timing.keyframes.some(value=>value>current)} onClick={()=>seekKey(1)}>{tr('下一关键帧')}<ChevronRight size={14}/></Button><Button size="icon" variant="ghost" aria-label={tr('在当前帧前拆分')} title={tr('在当前帧前拆分')} onClick={()=>run(async()=>onSplit(frameTime(timing,current)))}><Scissors size={14}/></Button><Button size="icon" variant="ghost" aria-label={tr('在当前帧后拆分')} title={tr('在当前帧后拆分')} onClick={()=>run(async()=>onSplit(frameTime(timing,current+1)))}><Scissors size={14}/><ChevronRight size={10}/></Button></div>}
  {loading&&<Busy text={tr('读取项目帧索引…')}/>} {error&&<div className="hint subtitle-index-error" role="status">{error}<Button variant="ghost" size="sm" onClick={()=>setRevision(value=>value+1)}>{tr('重试')}</Button></div>}
  </div>
}
