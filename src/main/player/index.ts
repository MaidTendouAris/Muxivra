import { app, type BrowserWindow } from 'electron'
import { EventEmitter } from 'node:events'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, mkdir, stat, unlink, link, copyFile } from 'node:fs/promises'
import { createReadStream, constants } from 'node:fs'
import { join, basename,resolve } from 'node:path'
import { MpvIpc } from '../../core/player/ipc'
import { CompositedPlayerSurface } from './surface'
import { inputFormatWhitelist } from '../../shared/media-policy'
import { emptyPlayerState, type PlayerOwner, type PlayerState, type PlayerRect, type PlayerAction, type PlayerEvent } from '../../shared/player'
import type { MediaService } from '../../core/service'
import type { MediaInfo, SubtitleDocument } from '../../shared/types'
import { updateEditorSubtitles } from './subtitles'
import { defaultShortcuts, mpvShortcutBindings, shortcutBindingsSchema,waveformShortcutIds, type ShortcutBindings } from '../../shared/shortcuts'

const properties=['pause','time-pos','duration','volume','mute','speed','track-list','playlist','playlist-pos','path','media-title','video-params','video-out-params','aid','sid','audio-delay','sub-delay','loop-file','loop-playlist','ab-loop-a','ab-loop-b','eof-reached']
let verifiedBinary:Promise<string>|undefined
async function bundledLibrary():Promise<string> {
  if(!verifiedBinary)verifiedBinary=(async()=>{
    const directory=app.isPackaged?join(process.resourcesPath,'mpv'):join(app.getAppPath(),'resources/mpv')
    const manifestPath=app.isPackaged?join(process.resourcesPath,'mpv-manifest.json'):join(app.getAppPath(),'resources/mpv-manifest.json')
    const manifest=JSON.parse(await readFile(manifestPath,'utf8')),executable=join(directory,'libmpv-2.dll')
    const digest=createHash('sha256');for await(const chunk of createReadStream(executable))digest.update(chunk)
    if(digest.digest('hex')!==manifest.librarySha256)throw new Error('内置 libmpv 校验失败，请重新安装应用')
    return executable
  })().catch(error=>{verifiedBinary=undefined;throw error})
  return verifiedBinary
}

class PlayerSession extends EventEmitter {
  readonly state:PlayerState
  readonly surface:CompositedPlayerSurface
  readonly ipc=new MpvIpc()
  private initialized:Promise<void>
  private abort=new AbortController()
  private closing=false
  private shutdownPromise?:Promise<void>
  get isClosing():boolean {return this.closing}
  private timer?:ReturnType<typeof setTimeout>
  private stderr=''
  private fileLoop=false
  private playlistLoop=false
  private operations:Promise<unknown>=Promise.resolve()
  private rect?:PlayerRect
  private nativeKeys=new Set<string>()
  editorDocument?:SubtitleDocument
  editorTrack?:number
  constructor(readonly owner:PlayerOwner,readonly window:BrowserWindow,readonly dataPath:string,private shortcuts:ShortcutBindings){
    super();this.state=emptyPlayerState(owner);this.surface=new CompositedPlayerSurface(window,owner)
    this.surface.on('error',error=>this.fail(error))
    this.ipc.on('event',event=>this.event(event));this.ipc.on('connection-error',error=>this.fail(error));this.ipc.on('disconnected',()=>{if(!this.closing)this.fail(new Error('mpv 进程已断开'))})
    this.initialized=this.initialize()
    void this.initialized.catch(error=>this.fail(error))
  }
  private async initialize():Promise<void> {
    const library=await bundledLibrary();this.abort.signal.throwIfAborted()
    const pipe=`\\\\.\\pipe\\muxivra-${process.pid}-${this.owner}-${randomUUID()}`
    const input=app.isPackaged?join(process.resourcesPath,'mpv-input.conf'):join(app.getAppPath(),'resources/mpv-input.conf')
    // Force local container demuxing; mpv's playlist parsers and network protocols are excluded.
    const options=`protocol_whitelist=[file,pipe],format_whitelist=[${inputFormatWhitelist}]`
    // External editor ASS shares the loaded container's font attachments.
    // Keep script styles, positioning, effects and video layout data intact.
    await this.surface.start(library,{'config':'no','load-scripts':'no','ytdl':'no','osc':'no','osd-level':'0','idle':'yes','force-window':'no','keep-open':'yes','pause':'yes','volume':'50','hwdec':'auto-safe','vo':'libmpv','sub-auto':'no','embeddedfonts':'yes','sub-ass-override':'no','sub-ass-use-video-data':'all','audio-file-auto':'no','autoload-files':'no','demuxer':'lavf','demuxer-lavf-o':options,'input-default-bindings':'no','input-terminal':'no','input-conf':input,'input-ipc-server':pipe,'terminal':'no','msg-level':'all=warn'})
    this.abort.signal.throwIfAborted()
    await this.ipc.connect(pipe,this.abort.signal)
    await this.ipc.command(['request_log_messages','warn'])
    await this.applyShortcuts(this.shortcuts)
    for(let index=0;index<properties.length;index++)await this.ipc.command(['observe_property',index+1,properties[index]])
    this.state.version=await this.ipc.command(['get_property','mpv-version']);this.state.ready=true;this.changed()
  }
  async execute<T>(operation:()=>Promise<T>):Promise<T>{const next=this.operations.catch(()=>{}).then(async()=>{await this.initialized;return operation()});this.operations=next;return next}
  async applyShortcuts(bindings:ShortcutBindings):Promise<void>{
    const next=mpvShortcutBindings(bindings,this.owner)
    // mpv keybind replaces a key; clearing old assignments prevents shortcuts
    // from continuing to run after the user changes or disables them.
    for(const key of [...this.nativeKeys])if(!next.has(key)){await this.command(['keybind',key,'ignore']);this.nativeKeys.delete(key)}
    for(const [key,command] of next){await this.command(['keybind',key,command]);this.nativeKeys.add(key)}
    this.shortcuts={...bindings}
  }
  async command(command:unknown[]):Promise<any>{try{return await this.ipc.command(command)}catch(error){throw new Error(`${command[0]}：${(error as Error).message}${this.stderr?'\n'+this.stderr:''}`)}}
  private fail(error:Error):void {if(this.closing)return;this.state.ready=false;this.state.loading=false;this.state.error=error.message;this.surface.hide();this.changed()}
  changed():void {if(!this.timer)this.timer=setTimeout(()=>{this.timer=undefined;this.emit('state',structuredClone(this.state))},80)}
  private event(event:any):void {
    if(event.event==='log-message')this.stderr=(this.stderr+String(event.text??'')).slice(-5000)
    if(event.event==='start-file'){this.state.loading=true;this.state.error=undefined;this.state.eof=false;this.editorTrack=undefined}
    if(event.event==='file-loaded'){this.state.loading=false;this.emit('file-loaded')}
    if(event.event==='end-file'&&event.reason==='error'){this.state.loading=false;this.state.error=`播放失败：${event.error??'无法读取媒体'}${this.stderr?'\n'+this.stderr:''}`}
    if(event.event==='client-message'&&event.args?.[0]?.startsWith('muxivra-'))this.emit('input',String(event.args[0]).slice(8))
    if(event.event==='property-change'){
      const value=event.data
      switch(event.name){
        case 'pause':this.state.paused=value!==false;break
        case 'time-pos':this.state.positionMs=Math.max(0,Math.round((Number(value)||0)*1000));break
        case 'duration':this.state.durationMs=Math.max(0,Math.round((Number(value)||0)*1000));break
        case 'volume':this.state.volume=Number(value)||0;break
        case 'mute':this.state.muted=value===true;break
        case 'speed':this.state.speed=Number(value)||1;break
        case 'path':this.state.path=typeof value==='string'?value:undefined;break
        case 'media-title':this.state.title=typeof value==='string'?value:'';break
        case 'track-list':this.state.tracks=Array.isArray(value)?value:[];this.updateSurface();break
        case 'playlist':this.state.playlist=Array.isArray(value)?value:[];break
        case 'playlist-pos':this.state.playlistIndex=Number.isInteger(value)?value:-1;break
        case 'video-params':this.state.videoWidth=Number(value?.w)||0;this.state.videoHeight=Number(value?.h)||0;break
        case 'video-out-params':{
          const width=Number(value?.dw)||Number(value?.w),height=Number(value?.dh)||Number(value?.h)
          let aspect=width/height
          if(Math.abs(Number(value?.rotate)||0)%180===90)aspect=1/aspect
          this.state.videoAspect=Number.isFinite(aspect)&&aspect>0?aspect:undefined;break
        }
        case 'aid':this.state.audioTrack=value===false?'no':value??'auto';break
        case 'sid':this.state.subtitleTrack=value===false?'no':value??'auto';break
        case 'audio-delay':this.state.audioDelay=Number(value)||0;break
        case 'sub-delay':this.state.subtitleDelay=Number(value)||0;break
        case 'loop-file':this.fileLoop=value!==undefined&&value!==false&&value!=='no'&&value!==0;break
        case 'loop-playlist':this.playlistLoop=value!==undefined&&value!==false&&value!=='no'&&value!==0;break
        case 'ab-loop-a':this.state.loopA=typeof value==='number'?Math.round(value*1000):undefined;break
        case 'ab-loop-b':this.state.loopB=typeof value==='number'?Math.round(value*1000):undefined;break
        case 'eof-reached':this.state.eof=value===true;break
      }
      this.state.loop=this.playlistLoop?'playlist':this.fileLoop?'file':'none'
    }
    this.changed()
  }
  setRect(rect:PlayerRect):void {this.rect=rect;this.updateSurface()}
  show():void {this.updateSurface()}
  private updateSurface():void {if(this.rect)this.surface.update({...this.rect,visible:this.rect.visible&&this.window.isVisible()&&this.state.tracks.some(track=>track.type==='video'&&!track.external)&&!this.state.error})}
  hide():void {this.surface.hide();if(this.state.ready)void this.command(['set_property','pause',true]).catch(()=>{})}
  shutdown():Promise<void> {return this.shutdownPromise??=this.close()}
  private async close():Promise<void> {
    this.closing=true;this.abort.abort();if(this.timer)clearTimeout(this.timer)
    await this.initialized.catch(()=>{})
    await this.operations.catch(()=>{})
    this.ipc.close();await this.surface.destroy()
  }
}

export class MpvPlayers extends EventEmitter {
  private sessions=new Map<PlayerOwner,PlayerSession>()
  private shortcuts:ShortcutBindings
  private shortcutChanges:Promise<void>=Promise.resolve()
  constructor(readonly window:BrowserWindow,readonly service:MediaService,bindings:ShortcutBindings=defaultShortcuts){super();this.shortcuts=shortcutBindingsSchema.parse(bindings)}
  async setShortcuts(bindings:ShortcutBindings):Promise<void>{
    const next=shortcutBindingsSchema.parse(bindings)
    const update=this.shortcutChanges.catch(()=>{}).then(async()=>{
      const previous=this.shortcuts;if(JSON.stringify(next)===JSON.stringify(previous))return
      this.shortcuts=next
      const active=()=>[...this.sessions.values()].filter(session=>!session.isClosing&&(session.state.ready||!session.state.error))
      try{await Promise.all(active().map(session=>session.execute(()=>session.applyShortcuts(next))))}
      catch(error){this.shortcuts=previous;await Promise.allSettled(active().map(session=>session.execute(()=>session.applyShortcuts(previous))));throw error}
    })
    this.shortcutChanges=update;return update
  }
  private session(owner:PlayerOwner):PlayerSession {
    let session=this.sessions.get(owner)
    if(!session){
      session=new PlayerSession(owner,this.window,this.service.dataPath,this.shortcuts);this.sessions.set(owner,session)
      session.on('state',state=>this.emit('state',state))
      session.on('input',type=>{void this.input(session!,type).catch(error=>this.emit('action-error',String(error.message)))})
      session.on('file-loaded',()=>{if(session!.editorDocument)void this.subtitles(owner,session!.editorDocument).catch(error=>this.emit('action-error',String(error.message)))})
    }
    return session
  }
  state(owner:PlayerOwner):PlayerState {return structuredClone(this.sessions.get(owner)?.state??emptyPlayerState(owner))}
  diagnostics(){return [...this.sessions.values()].map(session=>({owner:session.owner,...session.surface.diagnostics}))}
  async releaseProject(directory:string):Promise<void>{
    const root=resolve(directory).toLowerCase()
    for(const [owner,session] of this.sessions){
      const path=session.state.path?resolve(session.state.path).toLowerCase():''
      if(path===root||path.startsWith(root+'\\')||path.startsWith(root+'/')){
        if(session.state.fullscreen)this.setFullscreen(session,false)
        await session.shutdown();if(this.sessions.get(owner)===session)this.sessions.delete(owner);this.emit('state',emptyPlayerState(owner))
      }
    }
  }
  async open(owner:PlayerOwner,paths:string[],append=false):Promise<void> {
    if(!paths.length||paths.length>500)throw new Error('播放列表需要 1 至 500 个文件')
    const authorized:string[]=[]
    for(const input of paths){const path=await this.service.paths.input(input);if(!/\.(mp4|mkv|mov|avi|webm|m4v|m4a|mp3|wav|flac|ogg|aac|ts|aiff?|ac3|eac3|dts|ape|wv|amr|au)$/i.test(path))throw new Error('不支持该媒体文件类型');authorized.push(path)}
    const previous=this.sessions.get(owner)
    if(previous&&(previous.isClosing||(previous.state.error&&!previous.state.ready))){await previous.shutdown();if(this.sessions.get(owner)===previous)this.sessions.delete(owner)}
    const session=this.session(owner)
    await session.execute(async()=>{
      if(append&&session.state.playlist.length+authorized.length>500)throw new Error('播放列表最多 500 个文件')
      if(!append){session.state.loading=true;session.state.error=undefined;session.state.tracks=[];session.state.durationMs=0;session.state.positionMs=0;session.changed();await session.command(['set_property','pause',true])}
      for(let index=0;index<authorized.length;index++)await session.command(['loadfile',authorized[index],index>0||(append&&session.state.playlist.length>0)?'append':'replace'])
    })
  }
  rect(owner:PlayerOwner,rect:PlayerRect):void {const session=this.sessions.get(owner);session?.setRect(rect);if(!rect.active&&session?.state.ready)void session.command(['set_property','pause',true]).catch(()=>{});if(!rect.active&&session?.state.fullscreen)this.setFullscreen(session,false)}
  private setFullscreen(session:PlayerSession,value:boolean):void {session.state.fullscreen=value;this.window.setFullScreen(value);session.changed()}
  syncFullscreen():void {if(!this.window.isFullScreen())for(const session of this.sessions.values()){if(session.state.fullscreen){session.state.fullscreen=false;session.changed()}}}
  async action(owner:PlayerOwner,action:PlayerAction):Promise<void> {
    const session=this.sessions.get(owner);if(!session||session.isClosing)return
    return session.execute(async()=>{
      const set=(property:string,value:unknown)=>session.command(['set_property',property,value])
      const seek=(position:number)=>session.command(['seek',Math.max(0,Math.min(position,session.state.durationMs||359999999))/1000,'absolute+exact'])
      switch(action.type){
        case 'play':if(session.state.eof)await seek(0);await set('pause',false);break
        case 'pause':await set('pause',true);break
        case 'toggle':if(session.state.eof)await seek(0);await set('pause',!session.state.paused);break
        case 'stop':await set('pause',true);await seek(0);break
        case 'seek':await seek(action.positionMs);break
        case 'seek-relative':await seek(session.state.positionMs+action.offsetMs);break
        case 'volume':await set('volume',action.value);break
        case 'mute':await set('mute',action.value);break
        case 'speed':await set('speed',action.value);break
        case 'frame-next':case 'frame-previous':if(!session.state.tracks.some(track=>track.type==='video'))throw new Error('当前文件没有视频轨道');await set('pause',true);await session.command([action.type==='frame-next'?'frame-step':'frame-back-step']);break
        case 'loop-a':await set('ab-loop-b','no');await set('ab-loop-a',session.state.positionMs/1000);break
        case 'loop-b':if(session.state.positionMs<=(session.state.loopA??0))throw new Error('B 点必须晚于 A 点');await set('ab-loop-a',(session.state.loopA??0)/1000);await set('ab-loop-b',session.state.positionMs/1000);break
        case 'loop-clear':await set('ab-loop-a','no');await set('ab-loop-b','no');break
        case 'loop':await set('loop-file',action.value==='file'?'inf':'no');await set('loop-playlist',action.value==='playlist'?'inf':'no');break
        case 'audio-track':case 'subtitle-track':{
          const type=action.type==='audio-track'?'audio':'sub'
          if(action.value!=='no'&&action.value!=='auto'&&!session.state.tracks.some(track=>track.type===type&&track.id===action.value))throw new Error('轨道不存在')
          await set(type==='audio'?'aid':'sid',action.value);break
        }
        case 'audio-delay':await set('audio-delay',action.value);break
        case 'subtitle-delay':await set('sub-delay',action.value);break
        case 'playlist-play':case 'playlist-remove':if(action.index>=session.state.playlist.length)throw new Error('播放列表条目不存在');await session.command([action.type==='playlist-play'?'playlist-play-index':'playlist-remove',action.index]);break
        case 'fullscreen':this.setFullscreen(session,!session.state.fullscreen);break
      }
    })
  }
  async addTrack(owner:PlayerOwner,path:string,kind:'audio'|'subtitle'):Promise<void> {
    const session=this.sessions.get(owner);if(!session||session.isClosing)return
    const authorized=await this.service.paths.input(path)
    if(session.isClosing)return
    await session.execute(async()=>{await session.command([kind==='audio'?'audio-add':'sub-add',authorized,'select'])})
  }
  async subtitles(owner:PlayerOwner,document:SubtitleDocument):Promise<void> {
    // Editor effects can arrive while a project is being closed. They must not
    // recreate a renderer or reopen a file after releaseProject has started.
    const session=this.sessions.get(owner);if(!session||session.isClosing)return
    session.editorDocument=structuredClone(document)
    if(!session.state.path||session.state.loading)return
    await session.execute(async()=>{
      const project=this.service.projects.forMedia(document.mediaPath??'')
      await updateEditorSubtitles(session,join(project?.directory??this.service.dataPath,'player-subtitles',`${owner}.ass`),document)
    })
  }
  async screenshot(owner:PlayerOwner,target:string):Promise<string> {
    const session=this.sessions.get(owner)
    if(!session||session.isClosing)throw new Error('当前没有可截图的视频')
    const output=await this.service.paths.output(target)
    if(!session.state.tracks.some(track=>track.type==='video'))throw new Error('纯音频无法截图')
    const directory=join(this.service.dataPath,'screenshots');await mkdir(directory,{recursive:true});const temporary=join(directory,`${randomUUID()}.png`)
    try {
      await session.execute(()=>session.command(['screenshot-to-file',temporary,'subtitles']))
      try {await link(temporary,output)}catch(error){if(!['EXDEV','EPERM','ENOTSUP'].includes((error as NodeJS.ErrnoException).code??''))throw error;await copyFile(temporary,output,constants.COPYFILE_EXCL)}
      return output
    } finally {await unlink(temporary).catch(()=>{})}
  }
  async media(owner:PlayerOwner):Promise<MediaInfo|undefined>{
    const state=this.state(owner);if(!state.path)return
    const path=await this.service.paths.input(state.path)
    return {path,name:basename(path),durationMs:state.durationMs,size:(await stat(path)).size,format:'',streams:state.tracks.filter(track=>!track.external).map((track,index)=>({index:track['ff-index']??index,type:track.type==='sub'?'subtitle':track.type,codec:track.codec??'',language:track.lang,title:track.title,width:track['demux-w'],height:track['demux-h'],frameRate:track['demux-fps']?String(track['demux-fps']):undefined,sampleRate:track['demux-samplerate'],channels:track['demux-channel-count']}))}
  }
  private async input(session:PlayerSession,type:string):Promise<void>{
    const owner=session.owner
    const waveformAction=owner==='subtitles'?waveformShortcutIds.find(action=>action.replace('.','-')===type):undefined
    if(waveformAction){this.emit('editor-event',{owner,type:'waveform',action:waveformAction,positionMs:session.state.positionMs} satisfies PlayerEvent);return}
    if(['set-start','set-end','undo','redo'].includes(type)){this.emit('editor-event',{owner,type:type as PlayerEvent['type'],positionMs:session.state.positionMs});return}
    if(type==='screenshot'){this.emit('screenshot-request',owner);return}
    if(type==='exit-fullscreen'){if(session.state.fullscreen)this.setFullscreen(session,false);return}
    if(type==='seek-left'||type==='seek-right'){await this.action(owner,{type:'seek-relative',offsetMs:(type==='seek-left'?-1:1)*(owner==='subtitles'?100:5000)});return}
    if(type==='volume-up'||type==='volume-down'){await this.action(owner,{type:'volume',value:Math.min(100,Math.max(0,session.state.volume+(type==='volume-up'?5:-5)))});return}
    if(type==='mute'){await this.action(owner,{type:'mute',value:!session.state.muted});return}
    if(['toggle','fullscreen','frame-next','frame-previous'].includes(type))await this.action(owner,{type} as PlayerAction)
  }
  hide():void {for(const session of this.sessions.values())session.hide()}
  show():void {for(const session of this.sessions.values())session.show()}
  async shutdown():Promise<void>{await Promise.allSettled([...this.sessions.values()].map(session=>session.shutdown()));this.sessions.clear()}
}
