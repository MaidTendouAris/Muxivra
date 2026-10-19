import { tr } from '../lib/i18n'
import { useCallback,useEffect, useRef, useState, type CSSProperties } from 'react'
import { Play, Pause, Square, SkipBack, SkipForward, Volume2, VolumeX, Camera, Maximize, Minimize, Music2, ChevronLeft, ChevronRight, Plus, X } from 'lucide-react'
import type { MediaInfo } from '../../shared/types'
import { emptyPlayerState, type PlayerOwner, type PlayerState, type PlayerAction, type PlayerRect } from '../../shared/player'
import { PlayerSettingsPanel } from './PlayerSettingsPanel'
import { Settings2 } from 'lucide-react'
import { Button, Input, Select, Busy } from './ui'
import type { RunAction } from './Jobs'
import { formatTime, parseTime, nameOf } from '../lib/utils'
import { formatShortcut, isShortcutInput, matchShortcut, type ShortcutId } from '../../shared/shortcuts'
import { useShortcuts } from './ShortcutProvider'

export function MpvPlayer({owner,path,active,run,onState,onMediaChange,loadId=0}:{owner:PlayerOwner;path:string;active:boolean;run:RunAction;onState?:(state:PlayerState)=>void;onMediaChange?:(media:MediaInfo)=>void;loadId?:number}){
  const [settingsOpen,setSettingsOpen]=useState(false),settingsButton=useRef<HTMLSpanElement>(null)
  const closeSettings=useCallback(()=>setSettingsOpen(false),[])
  useEffect(()=>{if(!active)setSettingsOpen(false)},[active])
  const shortcuts=useShortcuts()
  const [state,setState]=useState(()=>emptyPlayerState(owner)),[error,setError]=useState(''),[scrub,setScrub]=useState<number>(),[jump,setJump]=useState('00:00:00,000'),[volumeDraft,setVolumeDraft]=useState<number>()
  const volumeControl=useRef<{value?:number;pending?:number;sending:boolean;editing:boolean}>({sending:false,editing:false})
  const surfaceControl=useRef<{pending?:PlayerRect;sending:boolean}>({sending:false})
  const viewport=useRef<HTMLDivElement>(null),callbacks=useRef({onState,onMediaChange});callbacks.current={onState,onMediaChange}
  const hasVideo=state.tracks.some(track=>track.type==='video'&&!track.external)
  const usable=state.ready&&!!state.path&&!state.loading&&!state.error
  function synchronizeSurface(rect:PlayerRect){
    // Only the most recent geometry is useful after a slow IPC round trip.
    // Drain in order and never accumulate stale positions during scrolling.
    const control=surfaceControl.current;control.pending=rect;if(control.sending)return
    control.sending=true
    void(async()=>{try{while(control.pending){const latest=control.pending;control.pending=undefined;await window.muxivra.playerRect(owner,latest)}}catch(error){setError((error as Error).message)}finally{control.sending=false;if(control.pending)synchronizeSurface(control.pending)}})()
  }
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
    let frame=0,last='',scrolling=false,settle:ReturnType<typeof setTimeout>|undefined
    const update=()=>{
      const element=viewport.current;if(!element)return
      if(owner==='subtitles'&&!state.fullscreen){
        const card=element.closest('.subtitle-preview-card'),player=element.closest('.mpv-player'),controls=player?.querySelector('.player-controls'),heading=card?.querySelector('.card-heading'),waveform=card?.querySelector('.audio-timeline')
        if(card&&controls&&player){
          const style=getComputedStyle(card)
          // Floating settings never contribute to the preview layout.
          const controlHeight=controls.getBoundingClientRect().height
          const occupied=(parseFloat(style.paddingTop)||0)+(parseFloat(style.paddingBottom)||0)+(heading?heading.getBoundingClientRect().height+(parseFloat(getComputedStyle(heading).marginBottom)||0):0)+controlHeight+(waveform?waveform.getBoundingClientRect().height+(parseFloat(getComputedStyle(waveform).marginTop)||0):0)+2
          const value=`${Math.max(80,Math.floor(card.clientHeight-occupied))}px`
          if(element.style.getPropertyValue('--preview-video-height')!==value)element.style.setProperty('--preview-video-height',value)
        }
      }
      const bounds=element.getBoundingClientRect()
      const shown=active&&document.visibilityState==='visible'
      let left=Math.max(0,bounds.left),top=Math.max(0,bounds.top),right=Math.min(window.innerWidth,bounds.right),bottom=Math.min(window.innerHeight,bounds.bottom)
      // A native HWND does not inherit CSS overflow clipping. Include every
      // scrolling/clipping ancestor, as subtitle panes can scroll separately.
      // Fullscreen is fixed to the window; the ordinary preview card is no
      // longer its clipping ancestor. Window/overlay clipping still applies.
      for(let parent=state.fullscreen?null:viewport.current?.parentElement;parent;parent=parent.parentElement){
        const style=getComputedStyle(parent),box=parent.getBoundingClientRect()
        if(/^(auto|scroll|hidden|clip|overlay)$/.test(style.overflowX)){left=Math.max(left,box.left+parent.clientLeft);right=Math.min(right,box.left+parent.clientLeft+parent.clientWidth)}
        if(/^(auto|scroll|hidden|clip|overlay)$/.test(style.overflowY)){top=Math.max(top,box.top+parent.clientTop);bottom=Math.min(bottom,box.top+parent.clientTop+parent.clientHeight)}
      }
      const clipping=[
        {x:0,y:0,width:Math.max(0,left-bounds.left),height:bounds.height},
        {x:Math.max(0,right-bounds.left),y:0,width:Math.max(0,bounds.right-right),height:bounds.height},
        {x:0,y:0,width:bounds.width,height:Math.max(0,top-bounds.top)},
        {x:0,y:Math.max(0,bottom-bounds.top),width:bounds.width,height:Math.max(0,bounds.bottom-bottom)}
      ].filter(cut=>cut.width>0&&cut.height>0)
      // Keep the full overlay bounds and corner radius: clipping them to the
      // viewport first would move rounded corners when a popup crosses its edge.
      const exitOpen=!!document.querySelector('.exit-dialog')
      const occlusions=[...clipping,...Array.from(document.querySelectorAll(`[role="dialog"],[role="listbox"],.player-settings-popover,.toast,.player-loading,.operation-status${state.fullscreen?'':',.subtitle-project-card'}`)).slice(0,32-clipping.length).flatMap(element=>{const overlay=element.getBoundingClientRect(),style=getComputedStyle(element),radius=Math.min(...[style.borderTopLeftRadius,style.borderTopRightRadius,style.borderBottomLeftRadius,style.borderBottomRightRadius].map(value=>parseFloat(value)||0),overlay.width/2,overlay.height/2);return overlay.right>bounds.left&&overlay.left<bounds.right&&overlay.bottom>bounds.top&&overlay.top<bounds.bottom?[{x:overlay.x-bounds.x,y:overlay.y-bounds.y,width:overlay.width,height:overlay.height,radius}]:[]})]
      const rect={x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height,scale:window.devicePixelRatio,visible:shown&&hasVideo&&!exitOpen&&right>left&&bottom>top,active,occlusions}
      const key=JSON.stringify(rect);if(key===last)return;last=key
      synchronizeSurface(rect)
    }
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(()=>{frame=0;update();if(scrolling)schedule()})}
    const beginScroll=()=>{
      // Keep rendering while geometry moves. Update clipping immediately on
      // scroll events and track compositor frames through the settling period.
      scrolling=true;update();schedule();if(settle)clearTimeout(settle)
      settle=setTimeout(()=>{settle=undefined;scrolling=false;schedule()},120)
    }
    const scroll=(event:Event)=>{if(!state.fullscreen&&(event.target===document||event.target===window||(event.target instanceof Element&&event.target.contains(viewport.current))))beginScroll()}
    const wheel=(event:WheelEvent)=>{
      if(state.fullscreen||event.ctrlKey||(!event.deltaX&&!event.deltaY)||!(event.target instanceof Element))return
      if(event.target.closest('[role="listbox"],[role="dialog"],.player-settings-popover,.select-scroll-track'))return
      // Ignore dropdown/table scrolling that does not move the preview.
      for(let element:Element|null=event.target;element;element=element.parentElement){
        const style=getComputedStyle(element)
        const movesY=event.deltaY&&/^(auto|scroll|overlay)$/.test(style.overflowY)&&element.scrollHeight>element.clientHeight&&(event.deltaY>0?element.scrollTop+element.clientHeight<element.scrollHeight:element.scrollTop>0)
        const movesX=event.deltaX&&/^(auto|scroll|overlay)$/.test(style.overflowX)&&element.scrollWidth>element.clientWidth&&(event.deltaX>0?element.scrollLeft+element.clientWidth<element.scrollWidth:element.scrollLeft>0)
        if(movesY||movesX){if(element.contains(viewport.current))beginScroll();return}
      }
      const element=document.scrollingElement;if(element&&((event.deltaY>0&&element.scrollTop+element.clientHeight<element.scrollHeight)||(event.deltaY<0&&element.scrollTop>0)||(event.deltaX>0&&element.scrollLeft+element.clientWidth<element.scrollWidth)||(event.deltaX<0&&element.scrollLeft>0)))beginScroll()
    }
    const resize=new ResizeObserver(schedule);const element=viewport.current;if(element)resize.observe(element)
    const card=element?.closest('.subtitle-preview-card');if(card){resize.observe(card);for(const child of card.querySelectorAll('.card-heading,.player-controls,.audio-timeline'))resize.observe(child)}
    const mutation=new MutationObserver(schedule);mutation.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden','style']})
    window.addEventListener('resize',schedule);window.addEventListener('scroll',scroll,true);window.addEventListener('wheel',wheel,{capture:true,passive:true});document.addEventListener('visibilitychange',schedule);schedule()
    return()=>{resize.disconnect();mutation.disconnect();cancelAnimationFrame(frame);if(settle)clearTimeout(settle);window.removeEventListener('resize',schedule);window.removeEventListener('scroll',scroll,true);window.removeEventListener('wheel',wheel,true);document.removeEventListener('visibilitychange',schedule)}
  },[active,hasVideo,state.ready,state.error,state.fullscreen,owner])
  useEffect(()=>()=>{synchronizeSurface({x:0,y:0,width:0,height:0,scale:1,visible:false,active:false})},[owner])
  useEffect(()=>{
    if(!active||!usable)return
    const listener=(event:KeyboardEvent)=>{
      if(event.defaultPrevented||isShortcutInput(event.target)||document.querySelector('[role="dialog"], [role="listbox"]'))return
      if(event.code==='Escape'&&document.querySelector('.player-settings-popover'))return
      // Range controls already implement their own directional adjustments.
      if((event.target as Element)?.closest('input[type="range"]')&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.code))return
      const currentVolume=volumeControl.current.value??state.volume
      const actions:Partial<Record<ShortcutId,PlayerAction>>={'player.toggle':{type:'toggle'},'player.seekBackward':{type:'seek-relative',offsetMs:owner==='subtitles'?-100:-5000},'player.seekForward':{type:'seek-relative',offsetMs:owner==='subtitles'?100:5000},'player.volumeUp':{type:'volume',value:Math.min(100,currentVolume+5)},'player.volumeDown':{type:'volume',value:Math.max(0,currentVolume-5)},'player.mute':{type:'mute',value:!state.muted},'player.fullscreen':{type:'fullscreen'},'player.frameNext':{type:'frame-next'},'player.framePrevious':{type:'frame-previous'}}
      const shortcut=(Object.keys(actions) as ShortcutId[]).find(id=>matchShortcut(event,id,shortcuts))
      if(event.code==='Escape'&&state.fullscreen){event.preventDefault();act({type:'fullscreen'})}
      else if(shortcut){event.preventDefault();act(actions[shortcut]!)}
      else if(matchShortcut(event,'player.screenshot',shortcuts)){event.preventDefault();void run(()=>window.muxivra.playerScreenshot(owner),tr("截图已保存"))}
    }
    window.addEventListener('keydown',listener,true);return()=>window.removeEventListener('keydown',listener,true)
  },[active,usable,state.volume,state.muted,state.fullscreen,owner,shortcuts])
  const title=(label:string,id:ShortcutId)=>shortcuts[id]?`${label} · ${formatShortcut(shortcuts[id]).replace('空格',tr('空格'))}`:label
  const actionShortcut:Partial<Record<PlayerAction['type'],ShortcutId>>={toggle:'player.toggle',mute:'player.mute',fullscreen:'player.fullscreen','frame-next':'player.frameNext','frame-previous':'player.framePrevious'}
  const icon=(label:string,Icon:typeof Play,action:PlayerAction,disabled=false)=><Button title={actionShortcut[action.type]?title(label,actionShortcut[action.type]!):label} aria-label={tr(label)} variant="ghost" size="icon" disabled={!usable||disabled} onClick={()=>act(action)}><Icon size={17}/></Button>
  const tracks=(kind:'audio'|'sub')=>state.tracks.filter(track=>track.type===kind)
  const trackLabel=(track:PlayerState['tracks'][0])=>`${track.id} · ${track.title||track.lang||track.codec||tr("未命名")}${track.external?tr(" · 外部"):''}`
  return <div className={`mpv-player ${state.fullscreen?'player-fullscreen':''}`} data-player-owner={owner} tabIndex={0}>
    <div ref={viewport} className={`mpv-viewport ${hasVideo?'':'audio-viewport'}`} style={{'--video-aspect':state.videoAspect??(state.videoWidth&&state.videoHeight?state.videoWidth/state.videoHeight:16/9)} as CSSProperties}>
      {!hasVideo&&<div className="audio-summary"><Music2 size={28}/><div><strong>{state.title||nameOf(path)}</strong><span>{tracks('audio').map(track=>[track.codec,track['demux-channel-count']?tr("{0} 声道",track['demux-channel-count']):undefined,track['demux-samplerate']?`${track['demux-samplerate']} Hz`:undefined].filter(Boolean).join(' · ')).join(' / ')}</span></div></div>}
      {state.loading&&<span className="player-loading" role="status"><Busy text={tr("正在载入…")}/></span>}
    </div>
    <div className="player-controls"><div className="player-seek"><code>{formatTime(scrub??state.positionMs)}</code><input type="range" aria-label={tr("播放进度")} min={0} max={Math.max(1,state.durationMs)} step={1} disabled={!usable} value={Math.min(scrub??state.positionMs,Math.max(1,state.durationMs))} onChange={event=>setScrub(+event.target.value)} onPointerUp={event=>{act({type:'seek',positionMs:+event.currentTarget.value});setScrub(undefined)}} onKeyUp={event=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.code)){act({type:'seek',positionMs:+event.currentTarget.value});setScrub(undefined)}}}/><code>{formatTime(state.durationMs)}</code></div>
      <div className="player-toolbar">
        {icon(tr("上一项"),SkipBack,{type:'playlist-play',index:Math.max(0,state.playlistIndex-1)},state.playlistIndex<=0)}
        {icon(state.paused?tr("播放"):tr("暂停"),state.paused?Play:Pause,{type:'toggle'})}
        {icon(tr("停止"),Square,{type:'stop'})}{icon(tr("下一项"),SkipForward,{type:'playlist-play',index:state.playlistIndex+1},state.playlistIndex>=state.playlist.length-1)}
        <span className="player-separator"/>{icon(state.muted?tr("取消静音"):tr("静音"),state.muted?VolumeX:Volume2,{type:'mute',value:!state.muted})}
        <input className="player-volume" type="range" aria-label={tr("音量")} min={0} max={100} step={1} disabled={!usable} value={volumeDraft??state.volume} onPointerDown={()=>{volumeControl.current.editing=true}} onChange={event=>changeVolume(+event.target.value)} onPointerUp={releaseVolume} onPointerCancel={releaseVolume} onBlur={releaseVolume} onKeyDown={event=>{const direction=['ArrowRight','ArrowUp'].includes(event.key)?1:['ArrowLeft','ArrowDown'].includes(event.key)?-1:0;if(direction){event.preventDefault();changeVolume((volumeControl.current.value??state.volume)+direction*5)}}}/>
        <Input className="player-volume-number" aria-label={tr("音量百分比")} type="number" min={0} max={100} step={1} onKeyDown={event=>{if(['ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();changeVolume((volumeControl.current.value??state.volume)+(event.key==='ArrowUp'?5:-5))}}} disabled={!usable} value={Math.round(volumeDraft??state.volume)} onChange={event=>{if(event.target.value!=='')changeVolume(+event.target.value)}}/><span className="player-volume-value">%</span>
        <Select notifyOnReselect aria-label={tr("播放速度")} value={state.speed} onChange={event=>act({type:'speed',value:+event.target.value})}>{[.25,.5,.75,1,1.25,1.5,2,3,4].map(speed=><option value={speed} key={speed}>{speed}×</option>)}</Select>
        <Button title={title(tr("截图"),'player.screenshot')} aria-label={tr("截图")} variant="ghost" size="icon" disabled={!usable||!hasVideo} onClick={()=> run(()=>window.muxivra.playerScreenshot(owner),tr("截图已保存"))}><Camera size={17}/></Button>
        {icon(state.fullscreen?tr("退出全屏"):tr("全屏"),state.fullscreen?Minimize:Maximize,{type:'fullscreen'})}
        <span ref={settingsButton} className="player-settings-trigger"><Button aria-label={tr("播放设置与列表")} aria-expanded={settingsOpen} variant="ghost" size="icon" title={tr("播放设置与列表")} onClick={()=>setSettingsOpen(value=>!value)}><Settings2 size={17}/></Button></span>
      </div>
      {settingsOpen&&active&&<PlayerSettingsPanel anchor={settingsButton} onClose={closeSettings}>
        <div className="player-settings-row"><label>{tr("跳转时间")}<Input aria-label={tr("跳转时间")} value={jump} onChange={event=>setJump(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')void run(async()=>{await window.muxivra.playerAction(owner,{type:'seek',positionMs:parseTime(jump)})})}}/></label><Button variant="secondary" size="sm" disabled={!usable} onClick={()=> run(async()=>window.muxivra.playerAction(owner,{type:'seek',positionMs:parseTime(jump)}))}>{tr("跳转")}</Button>{icon(tr("上一帧"),ChevronLeft,{type:'frame-previous'},!hasVideo)}{icon(tr("下一帧"),ChevronRight,{type:'frame-next'},!hasVideo)}
          <Select notifyOnReselect aria-label={tr("循环模式")} value={state.loop} onChange={event=>act({type:'loop',value:event.target.value as 'none'|'file'|'playlist'})}><option value="none">{tr("不循环")}</option><option value="file">{tr("单文件循环")}</option><option value="playlist">{tr("列表循环")}</option></Select>
        </div>
        <div className="player-settings-row"><Button variant="secondary" size="sm" disabled={!usable} onClick={()=>act({type:'loop-a'})}>{tr("设置 A")}</Button><code>{state.loopA===undefined?'—':formatTime(state.loopA)}</code><Button variant="secondary" size="sm" disabled={!usable} onClick={()=>act({type:'loop-b'})}>{tr("设置 B")}</Button><code>{state.loopB===undefined?'—':formatTime(state.loopB)}</code><Button variant="ghost" size="sm" onClick={()=>act({type:'loop-clear'})}>{tr("清除 A–B")}</Button></div>
        <div className="player-track-settings"><label>{tr("音轨")}<Select notifyOnReselect aria-label={tr("播放音轨")} value={state.audioTrack} onChange={event=>act({type:'audio-track',value:event.target.value==='no'||event.target.value==='auto'?event.target.value:+event.target.value})}><option value="auto">{tr("自动")}</option><option value="no">{tr("关闭")}</option>{tracks('audio').map(track=><option value={track.id} key={track.id}>{trackLabel(track)}</option>)}</Select></label><label>{tr("字幕")}<Select notifyOnReselect aria-label={tr("播放字幕")} value={state.subtitleTrack} onChange={event=>act({type:'subtitle-track',value:event.target.value==='no'||event.target.value==='auto'?event.target.value:+event.target.value})}><option value="auto">{tr("自动")}</option><option value="no">{tr("关闭")}</option>{tracks('sub').map(track=><option value={track.id} key={track.id}>{trackLabel(track)}</option>)}</Select></label>
          <label>{tr("音轨延迟（秒）")}<Input aria-label={tr("音轨延迟（秒）")} type="number" step={.1} min={-60} max={60} value={state.audioDelay} onChange={event=>act({type:'audio-delay',value:+event.target.value})}/></label><label>{tr("字幕延迟（秒）")}<Input aria-label={tr("字幕延迟（秒）")} type="number" step={.1} min={-3600} max={3600} value={state.subtitleDelay} onChange={event=>act({type:'subtitle-delay',value:+event.target.value})}/></label>
        </div><div className="player-settings-row"><Button variant="secondary" size="sm" disabled={!usable} onClick={()=> run(()=>window.muxivra.playerAddTrack(owner,'audio'))}>{tr("载入音轨")}</Button><Button variant="secondary" size="sm" disabled={!usable} onClick={()=> run(()=>window.muxivra.playerAddTrack(owner,'subtitle'))}>{tr("载入字幕")}</Button><Button variant="secondary" size="sm" onClick={()=> run(async()=>{const files=await window.muxivra.selectFiles('media',true);if(files.length)await window.muxivra.playerOpen(owner,files,true)})}><Plus size={14}/>{tr("添加到列表")}</Button></div>
        <div className="player-playlist">{state.playlist.map((entry,index)=><div className={index===state.playlistIndex?'current':''} key={`${entry.filename}-${index}`}><button title={entry.filename} onClick={()=>act({type:'playlist-play',index})}>{index+1}. {entry.title||nameOf(entry.filename)}</button><Button variant="ghost" size="icon" aria-label={tr("移除播放项 {0}",index+1)} onClick={()=>act({type:'playlist-remove',index})}><X size={13}/></Button></div>)}</div>
      </PlayerSettingsPanel>}
    </div>{(state.error||error)&&<p className="player-error" role="alert">{state.error||error}</p>}
  </div>
}
