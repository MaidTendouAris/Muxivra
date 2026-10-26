import { tr } from '../lib/i18n'
import { useEffect,useLayoutEffect,useRef,useState,type PointerEvent as ReactPointerEvent } from 'react'
import { ChevronLeft,ChevronRight,Minus,Plus,RotateCcw,X } from 'lucide-react'
import type { Cue } from '../../shared/types'
import type { WaveformWindow } from '../../shared/waveform'
import { Button,Busy } from './ui'
import { formatTime } from '../lib/utils'
import { PlaybackClock } from '../lib/playback-clock'
import { formatShortcut,isShortcutInput,matchShortcut,matchWheelShortcut,waveformShortcutIds,type ShortcutId,type WaveformShortcutId } from '../../shared/shortcuts'
import { useShortcuts } from './ShortcutProvider'
import { bufferedWaveformRequest,clampWaveformView,waveformPoint,waveformSelection,waveformDefaultSpan as defaultSpan,waveformMinimumSpan as minimumSpan,waveformMaximumSpan as maximumSpan,type WaveformView,type WaveformSelection } from '../lib/waveform-view'
export type { WaveformSelection } from '../lib/waveform-view'

type Gesture={kind:'select'|'start'|'end';pointer:number;x:number;anchor:number;view:WaveformView;selection?:WaveformSelection;moved:boolean;cueId?:string;draft?:WaveformSelection}
type WaveformProps={path:string;streamIndex?:number|'no';timeMs:number;durationMs:number;cue?:Cue;selection?:WaveformSelection;onSelectionChange?:(selection:WaveformSelection|undefined)=>void;onCueRangeChange?:(id:string,selection:WaveformSelection)=>void;active:boolean;playing?:boolean;speed?:number;seekRevision?:number;onSeek:(ms:number)=>void}
const waveformActions=waveformShortcutIds
type WaveformAction=WaveformShortcutId

export function AudioWaveform({path,streamIndex,timeMs,durationMs,cue,selection,onSelectionChange,onCueRangeChange,active,playing=false,speed=1,seekRevision=0,onSeek}:WaveformProps) {
  const shortcuts=useShortcuts()
  const [gain,setGain]=useState(1),[view,setView]=useState<WaveformView>({startMs:0,durationMs:defaultSpan}),[width,setWidth]=useState(1000)
  const [wave,setWave]=useState<WaveformWindow>(),[loading,setLoading]=useState(false),[error,setError]=useState(''),[hover,setHover]=useState<number>(),[drawRevision,setDrawRevision]=useState(0)
  const [request,setRequest]=useState(()=>bufferedWaveformRequest(view,width,durationMs)),[retry,setRetry]=useState(0)
  const canvas=useRef<HTMLCanvasElement>(null),container=useRef<HTMLDivElement>(null),scrollbar=useRef<HTMLInputElement>(null),startHandle=useRef<HTMLButtonElement>(null),endHandle=useRef<HTMLButtonElement>(null)
  const viewRef=useRef(view),durationRef=useRef(durationMs),widthRef=useRef(width),waveRef=useRef(wave),selectionRef=useRef(selection),gesture=useRef<Gesture|undefined>(undefined),follow=useRef(true)
  const generation=useRef(0),requestKey=useRef(''),cache=useRef(new Map<string,WaveformWindow>()),paint=useRef<(now:number)=>void>(()=>{})
  const playhead=useRef<SVGLineElement>(null),clock=useRef(new PlaybackClock()),clockRevision=useRef({path,seekRevision}),actualTime=useRef(timeMs),wasPlaying=useRef(playing),lastSample=useRef({path,position:timeMs})
  durationRef.current=durationMs;widthRef.current=width;waveRef.current=wave;selectionRef.current=selection;actualTime.current=timeMs

  function commitView(next:WaveformView,manual=false) {
    if(manual)follow.current=false
    const bounded=clampWaveformView(next,durationRef.current);viewRef.current=bounded;setView(bounded)
  }
  function emitSelection(next:WaveformSelection|undefined) {selectionRef.current=next;onSelectionChange?.(next)}
  function ensureBuffer() {
    if(!path||!active)return
    const next=bufferedWaveformRequest(viewRef.current,widthRef.current,durationRef.current),key=JSON.stringify(next)
    if(requestKey.current!==key){requestKey.current=key;setRequest(next)}
  }

  useLayoutEffect(()=>{
    // mpv's own seek bar and frame-step controls do not issue a parent seekRevision.
    // Duplicate paused reports must not pull a manually panned viewport back.
    const pausedSeek=lastSample.current.path===path&&!playing&&!wasPlaying.current&&Math.abs(timeMs-lastSample.current.position)>2
    const force=clockRevision.current.path!==path||clockRevision.current.seekRevision!==seekRevision||pausedSeek
    lastSample.current={path,position:timeMs}
    clockRevision.current={path,seekRevision};clock.current.sample(timeMs,performance.now(),active&&playing,speed,force)
    if(force||playing&&!wasPlaying.current)follow.current=true
    wasPlaying.current=playing
    if(!gesture.current&&(force||!playing&&follow.current)){
      const current=viewRef.current
      if(timeMs<current.startMs||timeMs>current.startMs+current.durationMs)commitView({...current,startMs:timeMs-current.durationMs*.35})
    }
    paint.current(performance.now())
  },[timeMs,playing,speed,active,path,seekRevision])
  useEffect(()=>{
    generation.current++;cache.current.clear();setWave(undefined);setError('');setGain(1);requestKey.current='';follow.current=true
    gesture.current=undefined;const initial={startMs:Math.max(0,timeMs-defaultSpan*.35),durationMs:defaultSpan};commitView(initial)
    return()=>{generation.current++;gesture.current=undefined}
  },[path,streamIndex])
  useEffect(()=>{
    const element=container.current;if(!element||!active)return
    const resize=()=>{if(element.clientWidth){setWidth(Math.max(32,Math.min(4096,Math.round(element.clientWidth*devicePixelRatio))));setDrawRevision(value=>value+1)}}
    const observer=new ResizeObserver(resize);observer.observe(element);resize();return()=>observer.disconnect()
  },[active])
  useEffect(()=>{
    const observer=new MutationObserver(()=>setDrawRevision(value=>value+1))
    observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});return()=>observer.disconnect()
  },[])
  useLayoutEffect(()=>{if(!cue||!active)return;const span=Math.min(maximumSpan,Math.max(viewRef.current.durationMs,(cue.endMs-cue.startMs)*1.25));commitView({durationMs:span,startMs:(cue.startMs+cue.endMs-span)/2},true);paint.current(performance.now())},[cue?.id,active])
  useEffect(()=>{ensureBuffer()},[path,streamIndex,view,width,active,retry])
  useEffect(()=>{
    const id=++generation.current;if(!path||!active)return
    const key=JSON.stringify([path,streamIndex,request]),saved=cache.current.get(key)
    if(saved){setWave(saved);setLoading(false);setError('');return}
    setLoading(true);setError('')
    // One local indexed read covers several screens; motion only reprojects it.
    const timer=setTimeout(()=>{void window.muxivra.waveform(path,{...request,streamIndex}).then(data=>{
      if(id!==generation.current)return
      cache.current.set(key,data);while(cache.current.size>16)cache.current.delete(cache.current.keys().next().value!)
      setWave(data)
    }).catch(reason=>{if(id===generation.current)setError(reason.message)}).finally(()=>{if(id===generation.current)setLoading(false)})},25)
    return()=>{clearTimeout(timer);if(id===generation.current)generation.current++}
  },[path,streamIndex,request,active,retry])

  const zoom=(factor:number,ratio=.5)=>{
    const current=viewRef.current,span=Math.max(minimumSpan,Math.min(maximumSpan,Math.round(current.durationMs*factor))),anchor=current.startMs+ratio*current.durationMs
    commitView({startMs:anchor-ratio*span,durationMs:span},true)
  }
  const perform=(action:WaveformAction,ratio=.5,wheel?:WheelEvent)=>{
    switch(action){
      case 'waveform.panLeft':case 'waveform.panRight':{
        const delta=wheel?Math.max(Math.abs(wheel.deltaX),Math.abs(wheel.deltaY))*(wheel.deltaMode===1?16:wheel.deltaMode===2?canvas.current?.clientWidth??500:1):0
        const amount=wheel?Math.min(2,delta/Math.max(1,canvas.current?.clientWidth??500))*viewRef.current.durationMs:viewRef.current.durationMs*.25
        commitView({...viewRef.current,startMs:viewRef.current.startMs+(action==='waveform.panLeft'?-1:1)*amount},true);break
      }
      case 'waveform.zoomIn':zoom(.8,ratio);break
      case 'waveform.zoomOut':zoom(1.25,ratio);break
      case 'waveform.gainUp':setGain(current=>Math.min(64,current*1.25));break
      case 'waveform.gainDown':setGain(current=>Math.max(.25,current/1.25));break
      case 'waveform.reset':setGain(1);follow.current=true;commitView({startMs:actualTime.current-defaultSpan*.35,durationMs:defaultSpan});break
      case 'waveform.clearSelection':emitSelection(undefined);break
    }
  }
  const shortcutTitle=(label:string,id:ShortcutId)=>shortcuts[id]?`${label} · ${formatShortcut(shortcuts[id]).replace('滚轮上 / 左',tr('滚轮上 / 左')).replace('滚轮下 / 右',tr('滚轮下 / 右'))}`:label
  useEffect(()=>{
    const element=container.current;if(!element||!active)return
    const wheel=(event:WheelEvent)=>{
      if(gesture.current||document.querySelector('[role="dialog"],[role="listbox"]'))return
      const action=waveformActions.find(id=>matchWheelShortcut(event,id,shortcuts));if(!action)return
      event.preventDefault();event.stopPropagation()
      const box=canvas.current!.getBoundingClientRect(),ratio=Math.max(0,Math.min(1,(event.clientX-box.left)/box.width))
      perform(action,ratio,event)
    }
    element.addEventListener('wheel',wheel,{passive:false});return()=>element.removeEventListener('wheel',wheel)
  },[active,shortcuts])
  useEffect(()=>{
    if(!active)return
    const keydown=(event:KeyboardEvent)=>{
      if(event.defaultPrevented||isShortcutInput(event.target)||document.querySelector('[role="dialog"],[role="listbox"]'))return
      if((event.target as Element)?.closest('.waveform-selection-handle,input[type="range"]')&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.code))return
      const action=waveformActions.find(id=>matchShortcut(event,id,shortcuts));if(!action)return
      event.preventDefault();event.stopPropagation();perform(action)
    }
    window.addEventListener('keydown',keydown,true);return()=>window.removeEventListener('keydown',keydown,true)
  },[active,shortcuts])

  useEffect(()=>{
    if(!active)return
    return window.muxivra.onPlayerEvent(event=>{
      if(event.owner==='subtitles'&&event.type==='waveform'&&!document.querySelector('[role="dialog"],[role="listbox"]'))perform(event.action)
    })
  },[active,shortcuts])

  paint.current=(now:number)=>{
    const element=canvas.current,context=element?.getContext('2d');if(!element||!context||!active)return
    const box=element.getBoundingClientRect();if(!box.width||!box.height)return
    const position=Math.min(durationRef.current,clock.current.position(now));let current=viewRef.current
    if(playing&&follow.current&&!gesture.current){current=clampWaveformView({...current,startMs:position-current.durationMs*.35},durationRef.current);viewRef.current=current}
    const root=container.current;if(root){root.dataset.startMs=String(current.startMs);root.dataset.durationMs=String(current.durationMs)}
    const range=scrollbar.current;if(range){range.value=String(current.startMs);range.setAttribute('aria-valuetext',formatTime(current.startMs));range.style.setProperty('--waveform-thumb-width',`${Math.max(3,Math.min(100,current.durationMs/Math.max(1,durationRef.current)*100))}%`)}
    ensureBuffer()
    const scale=devicePixelRatio,w=box.width,h=box.height,axis=19,centre=axis+(h-axis)/2,amplitude=Math.max(1,(h-axis)/2-4)
    if(element.width!==Math.round(w*scale)||element.height!==Math.round(h*scale)){element.width=Math.round(w*scale);element.height=Math.round(h*scale)}
    context.setTransform(scale,0,0,scale,0,0)
    const style=getComputedStyle(element),accent=style.getPropertyValue('--accent').trim(),muted=style.getPropertyValue('--muted').trim(),border=style.getPropertyValue('--border').trim(),foreground=style.getPropertyValue('--text').trim()
    context.clearRect(0,0,w,h)
    const x=(ms:number)=>(ms-current.startMs)/current.durationMs*w,manual=selectionRef.current,region=gesture.current?.draft??manual??cue
    if(region){const left=Math.max(0,x(region.startMs)),right=Math.min(w,x(region.endMs));if(right>left){context.fillStyle=accent;context.globalAlpha=manual?.2:.1;context.fillRect(left,axis,right-left,h-axis);context.globalAlpha=1;context.strokeStyle=accent;context.lineWidth=manual?2:1;for(const edge of [region.startMs,region.endMs]){const position=x(edge);if(position>=0&&position<=w){context.beginPath();context.moveTo(position,axis);context.lineTo(position,h);context.stroke()}}}}
    for(const [handle,ms] of [[startHandle.current,region?.startMs],[endHandle.current,region?.endMs]] as const){if(handle&&ms!==undefined){const left=x(ms);handle.style.left=`${left}px`;handle.style.visibility=left>=0&&left<=w?'visible':'hidden'}}
    const tick=[20,50,100,200,500,1000,2000,5000,10000,30000,60000].find(value=>value/current.durationMs*w>=75)??60000
    context.font='10px Segoe UI';context.fillStyle=muted;context.strokeStyle=border;context.lineWidth=1
    for(let ms=Math.ceil(current.startMs/tick)*tick;ms<current.startMs+current.durationMs;ms+=tick){const left=x(ms);context.beginPath();context.moveTo(left,axis);context.lineTo(left,h);context.stroke();const label=formatTime(ms).replace(/^00:/,'');context.fillText(label,Math.min(w-context.measureText(label).width-2,Math.max(2,left+3)),13)}
    context.beginPath();context.moveTo(0,centre);context.lineTo(w,centre);context.stroke()
    const data=waveRef.current
    if(data?.minimum.length){
      const binWidth=data.durationMs/data.width,first=Math.max(0,Math.floor((current.startMs-data.startMs)/binWidth)),last=Math.min(data.width,Math.ceil((current.startMs+current.durationMs-data.startMs)/binWidth))
      context.fillStyle=accent;context.globalAlpha=.7
      for(let i=first;i<last;i++){const left=x(data.startMs+i*binWidth),top=centre-Math.max(-1,Math.min(1,data.maximum[i]*gain))*amplitude,bottom=centre-Math.max(-1,Math.min(1,data.minimum[i]*gain))*amplitude;context.fillRect(left,top,Math.max(.5,binWidth/current.durationMs*w),Math.max(1,bottom-top))}
      context.globalAlpha=1
      for(let i=first;i<last;i++){const rms=Math.min(1,data.rms[i]*gain)*amplitude;context.fillRect(x(data.startMs+i*binWidth),centre-rms,Math.max(.5,binWidth/current.durationMs*w),Math.max(0,2*rms))}
    }
    if(hover!==undefined&&!gesture.current){context.strokeStyle=muted;context.setLineDash([3,3]);context.beginPath();context.moveTo(x(hover),axis);context.lineTo(x(hover),h);context.stroke();context.setLineDash([])}
    const line=playhead.current,percent=(position-current.startMs)/current.durationMs*100
    if(line){line.setAttribute('visibility',percent>=0&&percent<=100?'visible':'hidden');line.setAttribute('x1',percent+'%');line.setAttribute('x2',percent+'%');line.dataset.positionMs=String(position);line.style.stroke=foreground}
  }
  useLayoutEffect(()=>{paint.current(performance.now())},[wave,gain,hover,cue,selection,view,drawRevision,width,active,loading])
  useEffect(()=>{
    if(!active)return
    let frame=0
    const draw=(now:number)=>{paint.current(now);if(playing&&document.visibilityState==='visible')frame=requestAnimationFrame(draw)}
    const resume=()=>{cancelAnimationFrame(frame);clock.current.sample(actualTime.current,performance.now(),playing,speed,true);draw(performance.now())}
    draw(performance.now());document.addEventListener('visibilitychange',resume)
    return()=>{cancelAnimationFrame(frame);document.removeEventListener('visibilitychange',resume)}
  },[active,playing,speed,path])

  function timeAt(clientX:number) {const rect=canvas.current!.getBoundingClientRect();return waveformPoint(viewRef.current,clientX-rect.left,rect.width,durationRef.current)}
  function begin(event:ReactPointerEvent<HTMLElement>,kind?:Gesture['kind']) {
    if(event.button!==0||!durationRef.current)return
    event.preventDefault();event.stopPropagation();const chosen=kind??'select'
    gesture.current={kind:chosen,pointer:event.pointerId,x:event.clientX,anchor:timeAt(event.clientX),view:{...viewRef.current},selection:selectionRef.current??(chosen!=='select'?cue:undefined),cueId:chosen!=='select'&&!selectionRef.current?cue?.id:undefined,moved:false}
    follow.current=false
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function move(event:ReactPointerEvent<HTMLElement>) {
    const current=gesture.current
    if(!current||current.pointer!==event.pointerId){setHover(timeAt(event.clientX));return}
    event.preventDefault();const dx=event.clientX-current.x;if(Math.abs(dx)>=3)current.moved=true
    if(current.kind==='select'&&!current.moved)return
    const at=timeAt(event.clientX),previous=current.selection
    const next=current.kind==='start'&&previous?{startMs:Math.min(previous.endMs-1,at),endMs:previous.endMs}:current.kind==='end'&&previous?{startMs:previous.startMs,endMs:Math.max(previous.startMs+1,at)}:waveformSelection(current.anchor,at,durationRef.current)
    if(current.cueId)current.draft=next;else emitSelection(next)
    paint.current(performance.now())
  }
  function end(event:ReactPointerEvent<HTMLElement>,cancel=false) {
    const current=gesture.current;if(!current||current.pointer!==event.pointerId)return
    event.preventDefault();event.stopPropagation();gesture.current=undefined
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId)
    if(cancel){if(!current.cueId)emitSelection(current.selection);paint.current(performance.now());return}
    if(current.cueId&&current.draft&&current.cueId===cue?.id)onCueRangeChange?.(current.cueId,current.draft)
    if(current.kind==='select'&&!current.moved){follow.current=true;onSeek(timeAt(event.clientX))}
    paint.current(performance.now())
  }
  const pan=(direction:number)=>commitView({...viewRef.current,startMs:viewRef.current.startMs+direction*viewRef.current.durationMs*.5},true)
  const handle=(edge:'start'|'end')=>(selection??cue)&&<button type="button" ref={edge==='start'?startHandle:endHandle} className={`waveform-selection-handle waveform-selection-${edge}`} aria-label={tr(edge==='start'?'选区起点':'选区终点')} role="slider" aria-valuemin={0} aria-valuemax={durationMs} aria-valuenow={edge==='start'?(selection??cue)!.startMs:(selection??cue)!.endMs} title={tr('拖动微调选区边界；方向键微调 1 毫秒')} onPointerDown={event=>begin(event,edge)} onPointerMove={move} onPointerUp={event=>end(event)} onPointerCancel={event=>end(event,true)} onKeyDown={event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return
    event.preventDefault();event.stopPropagation();const current=selectionRef.current??cue;if(!current)return
    follow.current=false
    const previous=edge==='start'?current.startMs:current.endMs,next=event.key==='Home'?0:event.key==='End'?durationMs:previous+(event.key==='ArrowLeft'?-1:1)*(event.shiftKey?10:1)
    const changed=edge==='start'?{startMs:Math.max(0,Math.min(current.endMs-1,next)),endMs:current.endMs}:{startMs:current.startMs,endMs:Math.max(current.startMs+1,Math.min(durationMs,next))};if(selectionRef.current)emitSelection(changed);else if(cue)onCueRangeChange?.(cue.id,changed)
  }}/>
  const noAudio=!!wave&&!wave.hasAudio
  return <div ref={container} className={`audio-timeline${noAudio?' no-audio':''}`} data-stream-index={streamIndex??'auto'} data-start-ms={view.startMs} data-duration-ms={view.durationMs} data-sample-rate={wave?.sampleRate} data-gain={gain} data-selection-start-ms={selection?.startMs} data-selection-end-ms={selection?.endMs} data-manual-selection={!!selection} aria-busy={loading}>
    <div className="waveform-toolbar"><span>{tr('音频波形')}</span><small>{noAudio?tr('无音轨'):tr('{0} 秒',view.durationMs/1000)}</small>{loading&&wave&&<span className="waveform-buffering" title={tr('读取波形…')}><Busy text=""/></span>}{selection&&<small className="waveform-selection-summary" title={`${formatTime(selection.startMs)} → ${formatTime(selection.endMs)}`}>{((selection.endMs-selection.startMs)/1000).toFixed(2)}s</small>}<div className="waveform-actions" hidden={noAudio}>{selection&&<Button size="icon" variant="ghost" aria-label={tr('清除波形选区')} title={shortcutTitle(tr('清除波形选区'),'waveform.clearSelection')} onClick={()=>emitSelection(undefined)}><X size={13}/></Button>}<Button size="icon" variant="ghost" aria-label={tr('向左移动波形')} title={shortcutTitle(tr('向左移动波形'),'waveform.panLeft')} disabled={!Number(container.current?.dataset.startMs??view.startMs)} onClick={()=>pan(-1)}><ChevronLeft size={14}/></Button><Button size="icon" variant="ghost" aria-label={tr('向右移动波形')} title={shortcutTitle(tr('向右移动波形'),'waveform.panRight')} disabled={view.startMs+view.durationMs>=durationMs} onClick={()=>pan(1)}><ChevronRight size={14}/></Button><Button size="icon" variant="ghost" aria-label={tr('放大波形')} title={shortcutTitle(tr('放大波形横轴'),'waveform.zoomIn')} disabled={view.durationMs<=minimumSpan} onClick={()=>zoom(.8)}><Plus size={14}/></Button><Button size="icon" variant="ghost" aria-label={tr('缩小波形')} title={shortcutTitle(tr('缩小波形横轴'),'waveform.zoomOut')} disabled={view.durationMs>=maximumSpan} onClick={()=>zoom(1.25)}><Minus size={14}/></Button><span className="waveform-axis-label" title={tr('仅缩放显示，不改变音量')}>{tr('纵轴 ×')}{Number(gain.toFixed(2))}</span><Button size="icon" variant="ghost" aria-label={tr('放大波形纵轴')} title={shortcutTitle(tr('放大波形纵轴'),'waveform.gainUp')} disabled={gain>=64} onClick={()=>setGain(current=>Math.min(64,current*2))}><Plus size={14}/></Button><Button size="icon" variant="ghost" aria-label={tr('缩小波形纵轴')} title={shortcutTitle(tr('缩小波形纵轴'),'waveform.gainDown')} disabled={gain<=.25} onClick={()=>setGain(current=>Math.max(.25,current/2))}><Minus size={14}/></Button><Button size="icon" variant="ghost" aria-label={tr('重置波形')} title={shortcutTitle(tr('恢复 15 秒视窗和原始振幅'),'waveform.reset')} onClick={()=>{setGain(1);follow.current=true;commitView({startMs:timeMs-defaultSpan*.35,durationMs:defaultSpan})}}><RotateCcw size={13}/></Button></div></div>
    <div className="waveform-chart" onPointerLeave={()=>setHover(undefined)} onContextMenu={event=>{event.preventDefault();if(!durationMs)return;follow.current=false;const at=timeAt(event.clientX),anchor=selectionRef.current?.startMs??cue?.startMs??timeMs;emitSelection({startMs:Math.max(0,Math.min(anchor,at-1)),endMs:Math.max(1,at)})}}>
      <canvas ref={canvas} aria-label={tr('音频波形，滚轮左右滚动，左键定位或拖动选区，右键设置选区终点')} title={hover!==undefined?formatTime(hover):tr('滚轮操作和波形快捷键可在设置中更改')} onPointerDown={event=>begin(event)} onPointerMove={move} onPointerUp={event=>end(event)} onPointerCancel={event=>end(event,true)}/>
      {handle('start')}{handle('end')}<svg className="waveform-playhead" aria-hidden="true"><line ref={playhead} y1="19" y2="100%"/></svg>{loading&&!wave?<div className="waveform-message"><Busy text={tr('读取波形…')}/></div>:error?<div className="waveform-message error-inline" title={error}>{tr('波形不可用')}<Button size="sm" variant="ghost" onClick={()=>setRetry(value=>value+1)}>{tr('重试')}</Button></div>:noAudio?<span className="waveform-message hint">{tr('媒体没有音轨')}</span>:null}
    </div>
    <input ref={scrollbar} className="waveform-scrollbar" type="range" aria-label={tr('波形位置')} min={0} max={Math.max(0,durationMs-view.durationMs)} step={1} defaultValue={0} disabled={durationMs<=view.durationMs||noAudio} onInput={event=>commitView({...viewRef.current,startMs:Number(event.currentTarget.value)},true)} onKeyDown={event=>{if(event.key.startsWith('Arrow'))event.stopPropagation()}}/>
  </div>
}
