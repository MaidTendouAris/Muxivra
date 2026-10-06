import { useState, useRef, useEffect } from 'react'
import { Plus, Download, Undo2, Redo2, Film, Subtitles as SubtitleIcon, Trash2, Clock3, Play } from 'lucide-react'
import type { Cue, SubtitleDocument, MediaInfo } from '../../shared/types'
import { Button, Card, Empty, Input, Field, DropZone, Busy } from '../components/ui'
import type { RunAction } from '../components/Jobs'
import { MpvPlayer } from '../components/MpvPlayer'
import { formatTime, parseTime, nameOf } from '../lib/utils'

function cueErrors(cues:Cue[]):string[]{return cues.flatMap((cue,index)=>!Number.isSafeInteger(cue.startMs)||cue.startMs<0||cue.endMs<=cue.startMs||cue.endMs>359999999?[`第 ${index+1} 条时间不合法`]:cue.text.trim()===''?[`第 ${index+1} 条文本为空`]:index&&cue.startMs<cues[index-1].endMs?[`第 ${index+1} 条与上一条重叠`]:[])}
function TimeInput({label,value,onCommit,run}:{label:string;value:number;onCommit:(value:number)=>void;run:RunAction}){
  const [text,setText]=useState(formatTime(value));useEffect(()=>setText(formatTime(value)),[value])
  const commit=()=>void run(async()=>{const time=parseTime(text);if(time!==value)onCommit(time)})
  return <Field label={label}><Input value={text} onChange={event=>setText(event.target.value)} onBlur={commit} onKeyDown={event=>{if(event.key==='Enter')event.currentTarget.blur()}}/></Field>
}
export function Subtitles({run,busy,visible}:{run:RunAction;busy:boolean;visible:boolean}){
  const [document,setDocument]=useState<SubtitleDocument>({id:crypto.randomUUID(),cues:[]}),[selected,setSelected]=useState<string>(),[history,setHistory]=useState<Cue[][]>([]),[future,setFuture]=useState<Cue[][]>([])
  const [media,setMedia]=useState(''),[loadId,setLoadId]=useState(0),[time,setTime]=useState(0),[duration,setDuration]=useState(0),[waveform,setWaveform]=useState<number[]>([]),[waveformError,setWaveformError]=useState(''),[offset,setOffset]=useState(0),[loaded,setLoaded]=useState(false),[saved,setSaved]=useState(false)
  const [waveformLoading,setWaveformLoading]=useState(false)
  const canvas=useRef<HTMLCanvasElement>(null),mediaGeneration=useRef(0),waveformSource=useRef(''),playerReady=useRef(false),openingMedia=useRef(''),pendingSeek=useRef<number|undefined>(undefined),cue=document.cues.find(item=>item.id===selected),errors=cueErrors(document.cues)
  useEffect(()=>{let active=true;void window.muxivra.getSession().then(session=>{if(active&&session){setDocument(session);setSelected(session.cues[0]?.id)}}).catch(error=>void run(async()=>{throw error})).finally(()=>{if(active)setLoaded(true)});return()=>{active=false}},[])
  useEffect(()=>{if(!loaded)return;let current=true;setSaved(false);const timer=setTimeout(()=>{void window.muxivra.saveSession(document).then(()=>{if(current)setSaved(true)}).catch(error=>void run(async()=>{throw error}))},800);return()=>{current=false;clearTimeout(timer)}},[document,loaded])
  useEffect(()=>{if(!media)return;const timer=setTimeout(()=>void window.muxivra.playerSubtitles('subtitles',document).catch(error=>void run(async()=>{throw error})),250);return()=>clearTimeout(timer)},[media,document])
  function edit(cues:Cue[]){setHistory(previous=>[...previous.slice(-99),structuredClone(document.cues)]);setFuture([]);setDocument(previous=>({...previous,cues}))}
  function update(patch:Partial<Cue>){if(cue)edit(document.cues.map(item=>item.id===cue.id?{...item,...patch}:item))}
  function undo(){if(!history.length)return;setFuture([document.cues,...future]);setDocument({...document,cues:history[history.length-1]});setHistory(history.slice(0,-1))}
  function redo(){if(!future.length)return;setHistory([...history,document.cues]);setDocument({...document,cues:future[0]});setFuture(future.slice(1))}
  function addCue(){const created:Cue={id:crypto.randomUUID(),startMs:time,endMs:time+2000,text:''};edit([...document.cues,created].sort((a,b)=>a.startMs-b.startMs));setSelected(created.id)}
  function seek(ms:number){setTime(ms);if(!media)return;if(!playerReady.current){pendingSeek.current=ms;return}void window.muxivra.playerAction('subtitles',{type:'seek',positionMs:ms}).catch(error=>void run(async()=>{throw error}))}
  async function importSrt(path:string){if(document.cues.length&&!confirm('替换当前字幕会话？'))return;const next=await window.muxivra.readSubtitles(path);setDocument(next);setSelected(next.cues[0]?.id);setHistory([]);setFuture([])}
  function updateWaveform(info:Pick<MediaInfo,'path'>){if(waveformSource.current===info.path)return;waveformSource.current=info.path;setWaveform([]);setWaveformError('');setWaveformLoading(true);const generation=++mediaGeneration.current;void window.muxivra.waveform(info.path).then(waveform=>{if(generation===mediaGeneration.current)setWaveform(waveform)}).catch(error=>{if(generation===mediaGeneration.current)setWaveformError(error.message)}).finally(()=>{if(generation===mediaGeneration.current)setWaveformLoading(false)})}
  async function loadMedia(path:string){playerReady.current=false;openingMedia.current=path;pendingSeek.current=undefined;setDuration(0);setTime(0);setMedia(path);setLoadId(value=>value+1);updateWaveform({path})}
  useEffect(()=>{
    if(!visible)return
    const listener=(event:KeyboardEvent)=>{const target=event.target as HTMLElement;if(target.isContentEditable||['INPUT','TEXTAREA','SELECT','BUTTON'].includes(target.tagName))return;if(event.key==='['&&cue){event.preventDefault();update({startMs:time})}if(event.key===']'&&cue){event.preventDefault();update({endMs:time})}if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?redo():undo()}}
    const off=window.muxivra.onPlayerEvent(event=>{if(event.owner!=='subtitles')return;switch(event.type){case 'set-start':update({startMs:event.positionMs});break;case 'set-end':update({endMs:event.positionMs});break;case 'undo':undo();break;case 'redo':redo();break}})
    window.addEventListener('keydown',listener);return()=>{off();window.removeEventListener('keydown',listener)}
  },[visible,cue,document,history,future,time])
  useEffect(()=>{
    const element=canvas.current,context=element?.getContext('2d');if(!element||!context)return
    const {width,height}=element;context.clearRect(0,0,width,height);context.fillStyle='#8ea65d';const step=Math.max(1,Math.floor(waveform.length/width))
    for(let x=0;x<width;x+=2){let amplitude=0;for(let i=Math.floor(x/width*waveform.length);i<Math.min(waveform.length,Math.floor(x/width*waveform.length)+step);i++)amplitude=Math.max(amplitude,waveform[i]);const size=Math.max(1,amplitude*height*.85);context.fillRect(x,(height-size)/2,1,size)}
    context.strokeStyle='#cfdf8c';const x=duration?time/duration*width:0;context.beginPath();context.moveTo(x,0);context.lineTo(x,height);context.stroke()
  },[waveform,time,duration,visible])
  return <div className="subtitle-layout"><div className="subtitle-tools"><div className="toolbar">
    <Button variant="secondary" disabled={busy} onClick={()=> run(async()=>{const paths=await window.muxivra.selectFiles('subtitle');if(paths[0])await importSrt(paths[0])})}><SubtitleIcon size={16}/>导入 SRT</Button>
    <Button variant="secondary" disabled={busy} onClick={()=> run(async()=>{const paths=await window.muxivra.selectFiles('media');if(paths[0])await loadMedia(paths[0])})}><Film size={16}/>载入媒体</Button>
    <Button variant="ghost" size="icon" aria-label="撤销" title="撤销 · Ctrl+Z" disabled={!history.length} onClick={undo}><Undo2 size={17}/></Button><Button variant="ghost" size="icon" aria-label="重做" title="重做 · Ctrl+Shift+Z" disabled={!future.length} onClick={redo}><Redo2 size={17}/></Button>
  </div><div className="toolbar">{saved?<span className="hint">已保存</span>:<Busy text={loaded?'保存中…':'读取会话…'}/>}<Button disabled={busy||!document.cues.length} onClick={()=> run(async()=>window.muxivra.exportSubtitles(document),'字幕已导出')}><Download size={16}/>导出 SRT</Button></div></div>
    <div className="subtitle-workspace"><Card title="媒体" aside={<span className="hint">{nameOf(media)}</span>}>
      {media?<MpvPlayer owner="subtitles" path={media} loadId={loadId} active={visible} run={run} onMediaChange={updateWaveform} onState={state=>{if(openingMedia.current&&state.path!==openingMedia.current)return;openingMedia.current='';playerReady.current=state.ready&&!state.loading&&!!state.path;setDuration(state.durationMs);if(playerReady.current&&pendingSeek.current!==undefined){const target=pendingSeek.current;pendingSeek.current=undefined;seek(target)}else setTime(state.positionMs)}}/>:<Empty title="未载入媒体" description=""/>}
      {waveformLoading&&<div className="waveform-loading" role="status"><Busy text="正在生成音频波形…"/><div className="activity-line"/></div>}{waveform.length>0&&<canvas className="waveform" ref={canvas} width={1000} height={72} aria-label="音频波形，点击定位" onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();seek(Math.round((event.clientX-rect.left)/rect.width*duration))}}/>}{waveformError&&<small className="hint" title={waveformError}>波形不可用</small>}
    </Card><Card title="字幕" aside={cue&&<Button variant="ghost" size="icon" aria-label="删除当前字幕" onClick={()=>{edit(document.cues.filter(item=>item.id!==cue.id));setSelected(undefined)}}><Trash2 size={16}/></Button>}>
      {cue?<><div className="form-grid"><TimeInput label="开始时间" value={cue.startMs} onCommit={value=>update({startMs:value})} run={run}/><TimeInput label="结束时间" value={cue.endMs} onCommit={value=>update({endMs:value})} run={run}/></div><TimeInput label="时长" value={Math.max(0,cue.endMs-cue.startMs)} onCommit={value=>{if(value<=0||cue.startMs+value>359999999)throw new Error('时长必须大于零，结束时间不能超过 99:59:59,999');update({endMs:cue.startMs+value})}} run={run}/>
        <div className="toolbar"><Button size="sm" variant="secondary" title="快捷键 [" onClick={()=>update({startMs:time})}>设置起点</Button><Button size="sm" variant="secondary" title="快捷键 ]" onClick={()=>update({endMs:time})}>设置终点</Button><Button size="sm" variant="ghost" onClick={()=>seek(cue.startMs)}><Play size={14}/>定位</Button></div>
        <Field label="字幕文本"><textarea className="input cue-text" value={cue.text} onChange={event=>update({text:event.target.value})}/></Field>
      </>:<p className="hint">未选择字幕</p>}
      <div className="divider"/><Field label="整体偏移（毫秒）"><div className="input-action"><Input type="number" value={offset} onChange={event=>setOffset(+event.target.value)}/><Button variant="secondary" onClick={()=> run(async()=>{const shifted=document.cues.map(item=>({...item,startMs:item.startMs+offset,endMs:item.endMs+offset}));if(!Number.isSafeInteger(offset)||shifted.some(item=>item.startMs<0||item.endMs>359999999))throw new Error('偏移后时间不合法');edit(shifted)})}><Clock3 size={16}/>应用</Button></div></Field>
      {errors.length>0&&<div className="validation-note">{errors.slice(0,4).map(error=><p key={error}>{error}</p>)}{errors.length>4&&<p>另有 {errors.length-4} 条提示</p>}</div>}
    </Card></div>
    <Card title={`字幕条目 · ${document.cues.length}`} aside={<Button variant="secondary" size="sm" onClick={addCue}><Plus size={15}/>新增字幕</Button>}>
      <DropZone onFiles={files=>void run(async()=>{const paths=await window.muxivra.acceptDrop(files);if(paths.length!==1||!paths[0].toLowerCase().endsWith('.srt'))throw new Error('请拖入一个 SRT 文件');await importSrt(paths[0])})}>
        {document.cues.length?<div className="cue-list"><table className="file-table"><thead><tr><th>#</th><th>开始 → 结束</th><th>文本</th><th>时长</th></tr></thead><tbody>{document.cues.map((item,index)=><tr tabIndex={0} key={item.id} className={selected===item.id?'selected-row':''} onClick={()=>{setSelected(item.id);seek(item.startMs)}} onKeyDown={event=>{if(event.key==='Enter'){setSelected(item.id);seek(item.startMs)}}}><td>{String(index+1).padStart(2,'0')}</td><td><code>{formatTime(item.startMs)} → {formatTime(item.endMs)}</code></td><td className="cue-row-text">{item.text||<span className="hint">空字幕</span>}</td><td>{((item.endMs-item.startMs)/1000).toFixed(3)}s</td></tr>)}</tbody></table></div>:<Empty title="无字幕" description=""/>}
      </DropZone>
    </Card>
  </div>
}
