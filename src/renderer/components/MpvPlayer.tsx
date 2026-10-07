import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Play, Pause, Square, SkipBack, SkipForward, Volume2, VolumeX, Camera, Maximize, Minimize, Music2, ChevronLeft, ChevronRight, Plus, X } from 'lucide-react'
import type { MediaInfo } from '../../shared/types'
import { emptyPlayerState, type PlayerOwner, type PlayerState, type PlayerAction } from '../../shared/player'
import { Button, Input, Select, Busy } from './ui'
import type { RunAction } from './Jobs'
import { formatTime, parseTime, nameOf } from '../lib/utils'

export function MpvPlayer({owner,path,active,run,onState,onMediaChange,loadId=0}:{owner:PlayerOwner;path:string;active:boolean;run:RunAction;onState?:(state:PlayerState)=>void;onMediaChange?:(media:MediaInfo)=>void;loadId?:number}){
  const [state,setState]=useState(()=>emptyPlayerState(owner)),[error,setError]=useState(''),[scrub,setScrub]=useState<number>(),[jump,setJump]=useState('00:00:00,000'),[volumeDraft,setVolumeDraft]=useState<number>()
  const volumeControl=useRef<{value?:number;pending?:number;sending:boolean;editing:boolean}>({sending:false,editing:false})
  const viewport=useRef<HTMLDivElement>(null),callbacks=useRef({onState,onMediaChange});callbacks.current={onState,onMediaChange}
  const hasVideo=state.tracks.some(track=>track.type==='video'&&!track.external)
  const usable=state.ready&&!!state.path&&!state.loading&&!state.error
  async function flushVolume(){
    const control=volumeControl.current;if(control.sending)return
    control.sending=true
    try {
      while(control.pending!==undefined){const value=control.pending;control.pending=undefined;await window.muxivra.playerAction(owner,{type:'volume',value})}
      if(!control.editing){const current=await window.muxivra.playerState(owner);if(control.pending===undefined&&current.volume===control.value){control.value=undefined;setState(current);setVolumeDraft(undefined)}}
    }catch(error){control.pending=undefined;control.value=undefined;setVolumeDraft(undefined);setError((error as Error).message)}
    finally{control.sending=false;if(control.pending!==undefined)void flushVolume()}
  }
  function changeVolume(value:number){const next=Math.max(0,Math.min(100,Math.round(value)));volumeControl.current.value=next;volumeControl.current.pending=next;setVolumeDraft(next);setError('');void flushVolume()}
  function releaseVolume(){volumeControl.current.editing=false;void flushVolume()}
  const act=(action:PlayerAction)=>{
    if(action.type==='volume'){changeVolume(action.value);return}
    setError('')
    // Reflect menu choices immediately; mpv property notifications arrive asynchronously.
    if(action.type==='speed')setState(s=>({...s,speed:action.value}))
    if(action.type==='loop')setState(s=>({...s,loop:action.value}))
    if(action.type==='audio-track')setState(s=>({...s,audioTrack:action.value}))
    if(action.type==='subtitle-track')setState(s=>({...s,subtitleTrack:action.value}))
    return window.muxivra.playerAction(owner,action).catch(error=>{setError(error.message);void window.muxivra.playerState(owner).then(setState).catch(()=>{})})
  }
  useEffect(()=>{
    let live=true
    const off=window.muxivra.onPlayerState(next=>{if(next.owner===owner&&live){const control=volumeControl.current;if(!control.editing&&!control.sending&&control.pending===undefined&&next.volume===control.value){control.value=undefined;setVolumeDraft(undefined)}setState(next);callbacks.current.onState?.(next)}})
    void window.muxivra.playerState(owner).then(next=>{if(live)setState(next)})
    return()=>{live=false;off()}
  },[owner])
  useEffect(()=>{if(path){setError('');void window.muxivra.playerOpen(owner,[path]).catch(error=>setError(error.message))}},[owner,path,loadId])
  const mediaKey=JSON.stringify([state.path,state.durationMs,state.tracks])
  useEffect(()=>{let live=true;if(state.path&&!state.loading)void window.muxivra.playerMedia(owner).then(info=>{if(live&&info)callbacks.current.onMediaChange?.(info)}).catch(error=>setError(error.message));return()=>{live=false}},[mediaKey,state.loading,owner])
  useEffect(()=>{
    let frame=0,last=''
    const update=()=>{
      frame=0;const bounds=viewport.current?.getBoundingClientRect();if(!bounds)return
      const shown=active&&document.visibilityState==='visible'
      // Keep the full overlay bounds and corner radius: clipping them to the
      // viewport first would move rounded corners when a popup crosses its edge.
      const exitOpen=!!document.querySelector('.exit-dialog')
      const occlusions=Array.from(document.querySelectorAll('[role="dialog"],[role="listbox"],.toast,.player-loading,.operation-status')).slice(0,32).flatMap(element=>{const overlay=element.getBoundingClientRect(),style=getComputedStyle(element),radius=Math.min(...[style.borderTopLeftRadius,style.borderTopRightRadius,style.borderBottomLeftRadius,style.borderBottomRightRadius].map(value=>parseFloat(value)||0),overlay.width/2,overlay.height/2);return overlay.right>bounds.left&&overlay.left<bounds.right&&overlay.bottom>bounds.top&&overlay.top<bounds.bottom?[{x:overlay.x-bounds.x,y:overlay.y-bounds.y,width:overlay.width,height:overlay.height,radius}]:[]})
      const rect={x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height,scale:window.devicePixelRatio,visible:shown&&hasVideo&&!exitOpen&&bounds.bottom>0&&bounds.top<window.innerHeight,active,occlusions}
      const key=JSON.stringify(rect);if(key===last)return;last=key
      void window.muxivra.playerRect(owner,rect).catch(error=>setError(error.message))
    }
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(update)}
    const resize=new ResizeObserver(schedule);if(viewport.current)resize.observe(viewport.current)
    const mutation=new MutationObserver(schedule);mutation.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden','style']})
    window.addEventListener('resize',schedule);window.addEventListener('scroll',schedule,true);document.addEventListener('visibilitychange',schedule);schedule()
    return()=>{resize.disconnect();mutation.disconnect();cancelAnimationFrame(frame);window.removeEventListener('resize',schedule);window.removeEventListener('scroll',schedule,true);document.removeEventListener('visibilitychange',schedule)}
  },[active,hasVideo,state.ready,state.error,state.fullscreen,owner])
  useEffect(()=>()=>{void window.muxivra.playerRect(owner,{x:0,y:0,width:0,height:0,scale:1,visible:false,active:false}).catch(()=>{})},[owner])
  useEffect(()=>{
    if(!active||!usable)return
    const listener=(event:KeyboardEvent)=>{
      const target=event.target as HTMLElement
      if(target.isContentEditable||['INPUT','TEXTAREA','SELECT','BUTTON'].includes(target.tagName)||event.ctrlKey||event.metaKey||event.altKey||document.querySelector('[role="dialog"], [role="listbox"]'))return
      const currentVolume=volumeControl.current.value??state.volume
      const actions:Record<string,PlayerAction>={Space:{type:'toggle'},ArrowLeft:{type:'seek-relative',offsetMs:owner==='subtitles'?-100:-5000},ArrowRight:{type:'seek-relative',offsetMs:owner==='subtitles'?100:5000},ArrowUp:{type:'volume',value:Math.min(100,currentVolume+5)},ArrowDown:{type:'volume',value:Math.max(0,currentVolume-5)},KeyM:{type:'mute',value:!state.muted},KeyF:{type:'fullscreen'},Period:{type:'frame-next'},Comma:{type:'frame-previous'}}
      if(event.code==='Escape'&&state.fullscreen){event.preventDefault();act({type:'fullscreen'})}
      else if(actions[event.code]){event.preventDefault();act(actions[event.code])}
      else if(event.code==='KeyS'){event.preventDefault();void run(()=>window.muxivra.playerScreenshot(owner),'截图已保存')}
    }
    window.addEventListener('keydown',listener);return()=>window.removeEventListener('keydown',listener)
  },[active,usable,state.volume,state.muted,state.fullscreen,owner])
  const icon=(label:string,Icon:typeof Play,action:PlayerAction,disabled=false)=><Button title={label} aria-label={label} variant="ghost" size="icon" disabled={!usable||disabled} onClick={()=>act(action)}><Icon size={17}/></Button>
  const tracks=(kind:'audio'|'sub')=>state.tracks.filter(track=>track.type===kind)
  const trackLabel=(track:PlayerState['tracks'][0])=>`${track.id} · ${track.title||track.lang||track.codec||'未命名'}${track.external?' · 外部':''}`
  return <div className={`mpv-player ${state.fullscreen?'player-fullscreen':''}`} data-player-owner={owner} tabIndex={0}>
    <div ref={viewport} className={`mpv-viewport ${hasVideo?'':'audio-viewport'}`} style={{'--video-aspect':state.videoAspect??(state.videoWidth&&state.videoHeight?state.videoWidth/state.videoHeight:16/9)} as CSSProperties}>
      {!hasVideo&&<div className="audio-summary"><Music2 size={28}/><div><strong>{state.title||nameOf(path)}</strong><span>{tracks('audio').map(track=>[track.codec,track['demux-channel-count']?`${track['demux-channel-count']} 声道`:undefined,track['demux-samplerate']?`${track['demux-samplerate']} Hz`:undefined].filter(Boolean).join(' · ')).join(' / ')}</span></div></div>}
      {state.loading&&<span className="player-loading" role="status"><Busy text="正在载入…"/></span>}
    </div>
    <div className="player-controls"><div className="player-seek"><code>{formatTime(scrub??state.positionMs)}</code><input type="range" aria-label="播放进度" min={0} max={Math.max(1,state.durationMs)} step={1} disabled={!usable} value={Math.min(scrub??state.positionMs,Math.max(1,state.durationMs))} onChange={event=>setScrub(+event.target.value)} onPointerUp={event=>{act({type:'seek',positionMs:+event.currentTarget.value});setScrub(undefined)}} onKeyUp={event=>{act({type:'seek',positionMs:+event.currentTarget.value});setScrub(undefined)}}/><code>{formatTime(state.durationMs)}</code></div>
      <div className="player-toolbar">
        {icon('上一项',SkipBack,{type:'playlist-play',index:Math.max(0,state.playlistIndex-1)},state.playlistIndex<=0)}
        {icon(state.paused?'播放':'暂停',state.paused?Play:Pause,{type:'toggle'})}
        {icon('停止',Square,{type:'stop'})}{icon('下一项',SkipForward,{type:'playlist-play',index:state.playlistIndex+1},state.playlistIndex>=state.playlist.length-1)}
        <span className="player-separator"/>{icon(state.muted?'取消静音':'静音',state.muted?VolumeX:Volume2,{type:'mute',value:!state.muted})}
        <input className="player-volume" type="range" aria-label="音量" min={0} max={100} step={1} disabled={!usable} value={volumeDraft??state.volume} onPointerDown={()=>{volumeControl.current.editing=true}} onChange={event=>changeVolume(+event.target.value)} onPointerUp={releaseVolume} onPointerCancel={releaseVolume} onBlur={releaseVolume} onKeyDown={event=>{const direction=['ArrowRight','ArrowUp'].includes(event.key)?1:['ArrowLeft','ArrowDown'].includes(event.key)?-1:0;if(direction){event.preventDefault();changeVolume((volumeControl.current.value??state.volume)+direction*5)}}}/>
        <Input className="player-volume-number" aria-label="音量百分比" type="number" min={0} max={100} step={1} onKeyDown={event=>{if(['ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();changeVolume((volumeControl.current.value??state.volume)+(event.key==='ArrowUp'?5:-5))}}} disabled={!usable} value={Math.round(volumeDraft??state.volume)} onChange={event=>{if(event.target.value!=='')changeVolume(+event.target.value)}}/><span className="player-volume-value">%</span>
        <Select notifyOnReselect aria-label="播放速度" value={state.speed} onChange={event=>act({type:'speed',value:+event.target.value})}>{[.25,.5,.75,1,1.25,1.5,2,3,4].map(speed=><option value={speed} key={speed}>{speed}×</option>)}</Select>
        <Button title="截图" aria-label="截图" variant="ghost" size="icon" disabled={!usable||!hasVideo} onClick={()=> run(()=>window.muxivra.playerScreenshot(owner),'截图已保存')}><Camera size={17}/></Button>
        {icon(state.fullscreen?'退出全屏':'全屏',state.fullscreen?Minimize:Maximize,{type:'fullscreen'})}
      </div>
      <details className="player-options"><summary>播放设置与列表{state.playlist.length>1?` · ${state.playlist.length} 项`:''}</summary>
        <div className="player-settings-row"><label>跳转时间<Input aria-label="跳转时间" value={jump} onChange={event=>setJump(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')void run(async()=>{await window.muxivra.playerAction(owner,{type:'seek',positionMs:parseTime(jump)})})}}/></label><Button variant="secondary" size="sm" disabled={!usable} onClick={()=> run(async()=>window.muxivra.playerAction(owner,{type:'seek',positionMs:parseTime(jump)}))}>跳转</Button>{icon('上一帧',ChevronLeft,{type:'frame-previous'},!hasVideo)}{icon('下一帧',ChevronRight,{type:'frame-next'},!hasVideo)}
          <Select notifyOnReselect aria-label="循环模式" value={state.loop} onChange={event=>act({type:'loop',value:event.target.value as 'none'|'file'|'playlist'})}><option value="none">不循环</option><option value="file">单文件循环</option><option value="playlist">列表循环</option></Select>
        </div>
        <div className="player-settings-row"><Button variant="secondary" size="sm" disabled={!usable} onClick={()=>act({type:'loop-a'})}>设置 A</Button><code>{state.loopA===undefined?'—':formatTime(state.loopA)}</code><Button variant="secondary" size="sm" disabled={!usable} onClick={()=>act({type:'loop-b'})}>设置 B</Button><code>{state.loopB===undefined?'—':formatTime(state.loopB)}</code><Button variant="ghost" size="sm" onClick={()=>act({type:'loop-clear'})}>清除 A–B</Button></div>
        <div className="player-track-settings"><label>音轨<Select notifyOnReselect aria-label="播放音轨" value={state.audioTrack} onChange={event=>act({type:'audio-track',value:event.target.value==='no'||event.target.value==='auto'?event.target.value:+event.target.value})}><option value="auto">自动</option><option value="no">关闭</option>{tracks('audio').map(track=><option value={track.id} key={track.id}>{trackLabel(track)}</option>)}</Select></label><label>字幕<Select notifyOnReselect aria-label="播放字幕" value={state.subtitleTrack} onChange={event=>act({type:'subtitle-track',value:event.target.value==='no'||event.target.value==='auto'?event.target.value:+event.target.value})}><option value="auto">自动</option><option value="no">关闭</option>{tracks('sub').map(track=><option value={track.id} key={track.id}>{trackLabel(track)}</option>)}</Select></label>
          <label>音轨延迟（秒）<Input aria-label="音轨延迟（秒）" type="number" step={.1} min={-60} max={60} value={state.audioDelay} onChange={event=>act({type:'audio-delay',value:+event.target.value})}/></label><label>字幕延迟（秒）<Input aria-label="字幕延迟（秒）" type="number" step={.1} min={-3600} max={3600} value={state.subtitleDelay} onChange={event=>act({type:'subtitle-delay',value:+event.target.value})}/></label>
        </div><div className="player-settings-row"><Button variant="secondary" size="sm" disabled={!usable} onClick={()=> run(()=>window.muxivra.playerAddTrack(owner,'audio'))}>载入音轨</Button><Button variant="secondary" size="sm" disabled={!usable} onClick={()=> run(()=>window.muxivra.playerAddTrack(owner,'subtitle'))}>载入字幕</Button><Button variant="secondary" size="sm" onClick={()=> run(async()=>{const files=await window.muxivra.selectFiles('media',true);if(files.length)await window.muxivra.playerOpen(owner,files,true)})}><Plus size={14}/>添加到列表</Button></div>
        <div className="player-playlist">{state.playlist.map((entry,index)=><div className={index===state.playlistIndex?'current':''} key={`${entry.filename}-${index}`}><button title={entry.filename} onClick={()=>act({type:'playlist-play',index})}>{index+1}. {entry.title||nameOf(entry.filename)}</button><Button variant="ghost" size="icon" aria-label={`移除播放项 ${index+1}`} onClick={()=>act({type:'playlist-remove',index})}><X size={13}/></Button></div>)}</div>
      </details>
    </div>{(state.error||error)&&<p className="player-error" role="alert">{state.error||error}</p>}
  </div>
}
