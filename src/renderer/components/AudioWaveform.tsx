import { tr } from '../lib/i18n'
import { useEffect,useLayoutEffect,useRef,useState } from 'react'
import { ChevronLeft,ChevronRight,Minus,Plus,RotateCcw } from 'lucide-react'
import type { Cue } from '../../shared/types'
import type { WaveformWindow } from '../../shared/waveform'
import { Button,Busy } from './ui'
import { formatTime } from '../lib/utils'
import { PlaybackClock } from '../lib/playback-clock'

const minimumSpan=250,maximumSpan=120000,defaultSpan=15000
export function AudioWaveform({path,timeMs,durationMs,cue,active,playing=false,speed=1,seekRevision=0,onSeek}:{path:string;timeMs:number;durationMs:number;cue?:Cue;active:boolean;playing?:boolean;speed?:number;seekRevision?:number;onSeek:(ms:number)=>void}) {
  const [gain,setGain]=useState(1)
  const [view,setView]=useState({startMs:0,durationMs:defaultSpan}),[width,setWidth]=useState(1000),[wave,setWave]=useState<WaveformWindow>(),[loading,setLoading]=useState(false),[error,setError]=useState(''),[hover,setHover]=useState<number>(),[drawRevision,setDrawRevision]=useState(0)
  const canvas=useRef<HTMLCanvasElement>(null),container=useRef<HTMLDivElement>(null),viewRef=useRef(view),durationRef=useRef(durationMs),generation=useRef(0),cache=useRef(new Map<string,WaveformWindow>())
  const playhead=useRef<SVGLineElement>(null),clock=useRef(new PlaybackClock()),clockRevision=useRef({path,seekRevision}),actualTime=useRef(timeMs)
  viewRef.current=view;durationRef.current=durationMs
  actualTime.current=timeMs
  useLayoutEffect(()=>{
    const force=clockRevision.current.path!==path||clockRevision.current.seekRevision!==seekRevision
    clockRevision.current={path,seekRevision};clock.current.sample(timeMs,performance.now(),active&&playing,speed,force)
  },[timeMs,playing,speed,active,path,seekRevision])
  useEffect(()=>{
    if(!active)return
    let frame=0
    const draw=(now:number)=>{
      const line=playhead.current;if(!line)return
      const position=Math.min(durationRef.current,clock.current.position(now)),current=viewRef.current,percent=(position-current.startMs)/current.durationMs*100
      line.setAttribute('visibility',percent>=0&&percent<=100?'visible':'hidden')
      line.setAttribute('x1',percent+'%');line.setAttribute('x2',percent+'%');line.dataset.positionMs=String(position)
      if(playing&&document.visibilityState==='visible')frame=requestAnimationFrame(draw)
    }
    const resume=()=>{cancelAnimationFrame(frame);clock.current.sample(actualTime.current,performance.now(),playing,speed,true);draw(performance.now())}
    draw(performance.now());document.addEventListener('visibilitychange',resume)
    return()=>{cancelAnimationFrame(frame);document.removeEventListener('visibilitychange',resume)}
  },[active,playing,speed,path,view,timeMs,seekRevision])
  useEffect(()=>{cache.current.clear();setWave(undefined);setError('');setGain(1);setView({startMs:0,durationMs:defaultSpan})},[path])
  useEffect(()=>{
    if(!active||!durationMs)return
    const position=Math.max(0,Math.min(timeMs,durationMs-1))
    setView(current=>position<current.startMs||position>=current.startMs+current.durationMs?{...current,startMs:Math.floor(position/current.durationMs)*current.durationMs}:current)
  },[timeMs,path,durationMs,active])
  useEffect(()=>{
    const element=container.current;if(!element||!active)return
    const resize=()=>{if(element.clientWidth){setWidth(Math.max(32,Math.min(4096,Math.round(element.clientWidth*devicePixelRatio))));setDrawRevision(value=>value+1)}}
    const observer=new ResizeObserver(resize);observer.observe(element);resize();return()=>observer.disconnect()
  },[active])
  useEffect(()=>{
    const observer=new MutationObserver(()=>setDrawRevision(value=>value+1))
    observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});return()=>observer.disconnect()
  },[])
  useEffect(()=>{
    const id=++generation.current;if(!path||!active)return
    const key=JSON.stringify([path,view,width]),cached=cache.current.get(key)
    if(cached){setWave(cached);setLoading(false);setError('');return}
    setLoading(true);setError('')
    // Coalesce resize and wheel bursts; the service aborts obsolete decoders.
    const timer=setTimeout(()=>{void window.muxivra.waveform(path,{...view,width}).then(data=>{
      if(id!==generation.current)return
      cache.current.set(key,data);while(cache.current.size>32)cache.current.delete(cache.current.keys().next().value!)
      setWave(data)
    }).catch(reason=>{if(id===generation.current)setError(reason.message)}).finally(()=>{if(id===generation.current)setLoading(false)})},90)
    return()=>{clearTimeout(timer);if(id===generation.current)generation.current++}
  },[path,view,width,active])
  const zoom=(factor:number,ratio=.5)=>setView(current=>{
    const span=Math.max(minimumSpan,Math.min(maximumSpan,Math.round(current.durationMs*factor)))
    const anchor=current.startMs+ratio*current.durationMs
    return {startMs:Math.round(Math.max(0,Math.min(Math.max(0,durationRef.current-span),anchor-ratio*span))),durationMs:span}
  })
  useEffect(()=>{
    const element=canvas.current;if(!element)return
    const wheel=(event:WheelEvent)=>{
      if(!event.ctrlKey&&!event.metaKey)return
      event.preventDefault();event.stopPropagation()
      const box=element.getBoundingClientRect(),ratio=Math.max(0,Math.min(1,(event.clientX-box.left)/box.width))
      if(event.shiftKey)setGain(current=>Math.max(.25,Math.min(64,current*(event.deltaY<0?1.25:.8))))
      else zoom(event.deltaY<0?.8:1.25,ratio)
    }
    element.addEventListener('wheel',wheel,{passive:false});return()=>element.removeEventListener('wheel',wheel)
  },[])
  useEffect(()=>{
    const element=canvas.current,context=element?.getContext('2d');if(!element||!context||!active)return
    const box=element.getBoundingClientRect();if(!box.width||!box.height)return
    const scale=devicePixelRatio;element.width=Math.round(box.width*scale);element.height=Math.round(box.height*scale);context.setTransform(scale,0,0,scale,0,0)
    const w=box.width,h=box.height,axis=19,centre=axis+(h-axis)/2,amplitude=Math.max(1,(h-axis)/2-4)
    const style=getComputedStyle(element),accent=style.getPropertyValue('--accent').trim(),muted=style.getPropertyValue('--muted').trim(),border=style.getPropertyValue('--border').trim()
    context.clearRect(0,0,w,h)
    const x=(ms:number)=>(ms-view.startMs)/view.durationMs*w
    if(cue){const left=Math.max(0,x(cue.startMs)),right=Math.min(w,x(cue.endMs));if(right>left){context.fillStyle=accent;context.globalAlpha=.12;context.fillRect(left,axis,right-left,h-axis);context.globalAlpha=1;context.strokeStyle=accent;for(const edge of [cue.startMs,cue.endMs]){const position=x(edge);if(position>=0&&position<=w){context.beginPath();context.moveTo(position,axis);context.lineTo(position,h);context.stroke()}}}}
    const tick=[20,50,100,200,500,1000,2000,5000,10000,30000,60000].find(value=>value/view.durationMs*w>=75)??60000
    context.font='11px Segoe UI';context.fillStyle=muted;context.strokeStyle=border;context.lineWidth=1
    for(let ms=Math.ceil(view.startMs/tick)*tick;ms<view.startMs+view.durationMs;ms+=tick){const position=x(ms);context.beginPath();context.moveTo(position,axis);context.lineTo(position,h);context.stroke();const label=formatTime(ms).replace(/^00:/,'');context.fillText(label,Math.min(w-context.measureText(label).width-2,Math.max(2,position+3)),13)}
    context.beginPath();context.moveTo(0,centre);context.lineTo(w,centre);context.stroke()
    if(wave&&wave.startMs===view.startMs&&wave.durationMs===view.durationMs&&wave.minimum.length){
      context.fillStyle=accent;context.globalAlpha=.75
      for(let i=0;i<wave.width;i++){const left=i/wave.width*w,top=centre-Math.max(-1,Math.min(1,wave.maximum[i]*gain))*amplitude,bottom=centre-Math.max(-1,Math.min(1,wave.minimum[i]*gain))*amplitude;context.fillRect(left,top,Math.max(.5,w/wave.width),Math.max(1,bottom-top))}
      context.globalAlpha=1
      for(let i=0;i<wave.width;i++){const rms=Math.min(1,wave.rms[i]*gain)*amplitude;context.fillRect(i/wave.width*w,centre-rms,Math.max(.5,w/wave.width),Math.max(0,2*rms))}
    }
    if(hover!==undefined){context.strokeStyle=muted;context.setLineDash([3,3]);context.beginPath();context.moveTo(x(hover),axis);context.lineTo(x(hover),h);context.stroke();context.setLineDash([])}
  },[wave,view,width,cue,active,hover,drawRevision,gain])
  const pan=(direction:number)=>setView(current=>({...current,startMs:Math.max(0,Math.min(Math.max(0,durationMs-current.durationMs),current.startMs+direction*current.durationMs))}))
  return <div ref={container} className={`audio-timeline${wave&&!wave.hasAudio?' no-audio':''}`} data-start-ms={view.startMs} data-duration-ms={view.durationMs} data-sample-rate={wave?.sampleRate} data-gain={gain} aria-busy={loading}>
    <div className="waveform-toolbar"><span>{tr("音频波形")}</span><small>{wave&&!wave.hasAudio?tr("无音轨"):tr("{0} 秒",view.durationMs/1000)}</small><div className="waveform-actions" hidden={!!wave&&!wave.hasAudio}><Button size="icon" variant="ghost" aria-label={tr("上一段波形")} title={tr("上一段波形")} disabled={!view.startMs} onClick={()=>pan(-1)}><ChevronLeft size={14}/></Button><Button size="icon" variant="ghost" aria-label={tr("下一段波形")} title={tr("下一段波形")} disabled={view.startMs+view.durationMs>=durationMs} onClick={()=>pan(1)}><ChevronRight size={14}/></Button><Button size="icon" variant="ghost" aria-label={tr("放大波形")} title={tr("放大 · Ctrl + 滚轮")} disabled={view.durationMs<=minimumSpan} onClick={()=>zoom(.8)}><Plus size={14}/></Button><Button size="icon" variant="ghost" aria-label={tr("缩小波形")} title={tr("缩小 · Ctrl + 滚轮")} disabled={view.durationMs>=maximumSpan} onClick={()=>zoom(1.25)}><Minus size={14}/></Button><span className="waveform-axis-label" title={tr("仅缩放显示，不改变音量")}>{tr("纵轴 ×")}{Number(gain.toFixed(2))}</span><Button size="icon" variant="ghost" aria-label={tr("放大波形纵轴")} title={tr("纵向放大 · Ctrl + Shift + 滚轮")} disabled={gain>=64} onClick={()=>setGain(current=>Math.min(64,current*2))}><Plus size={14}/></Button><Button size="icon" variant="ghost" aria-label={tr("缩小波形纵轴")} title={tr("纵向缩小 · Ctrl + Shift + 滚轮")} disabled={gain<=.25} onClick={()=>setGain(current=>Math.max(.25,current/2))}><Minus size={14}/></Button><Button size="icon" variant="ghost" aria-label={tr("重置波形")} title={tr("恢复 15 秒视窗和原始振幅")} onClick={()=>{setGain(1);setView({startMs:Math.floor(Math.max(0,Math.min(timeMs,durationMs-1))/defaultSpan)*defaultSpan,durationMs:defaultSpan})}}><RotateCcw size={13}/></Button></div></div>
    <div className="waveform-chart"><canvas ref={canvas} aria-label={tr("音频波形，Ctrl 加滚轮横向缩放，Ctrl 加 Shift 加滚轮纵向缩放，点击定位")} title={hover!==undefined?formatTime(hover):tr("Ctrl + 滚轮横向缩放；Ctrl + Shift + 滚轮纵向缩放；点击定位视频")} onMouseMove={event=>{const rect=event.currentTarget.getBoundingClientRect();setHover(Math.max(0,Math.min(durationMs,Math.round(viewRef.current.startMs+(event.clientX-rect.left)/rect.width*viewRef.current.durationMs))))}} onMouseLeave={()=>setHover(undefined)} onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();onSeek(Math.max(0,Math.min(durationMs,Math.round(view.startMs+(event.clientX-rect.left)/rect.width*view.durationMs))))}}/><svg className="waveform-playhead" aria-hidden="true"><line ref={playhead} y1="19" y2="100%"/></svg>{loading?<div className="waveform-message"><Busy text={tr("读取波形…")}/></div>:error?<div className="waveform-message error-inline" title={error}>{tr("波形不可用")}<Button size="sm" variant="ghost" onClick={()=>setView(current=>({...current}))}>{tr("重试")}</Button></div>:wave&&!wave.hasAudio?<span className="waveform-message hint">{tr("媒体没有音轨")}</span>:null}</div>
  </div>
}
