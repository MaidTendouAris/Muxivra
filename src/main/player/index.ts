import { app, type BrowserWindow } from 'electron'
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, stat, unlink, link, copyFile } from 'node:fs/promises'
import { createReadStream, constants } from 'node:fs'
import { join, basename } from 'node:path'
import { MpvIpc } from '../../core/player/ipc'
import { NativePlayerSurface } from './surface'
import { inputFormatWhitelist } from '../../shared/media-policy'
import { emptyPlayerState, type PlayerOwner, type PlayerState, type PlayerRect, type PlayerAction, type PlayerEvent, type PlayerTrack } from '../../shared/player'
import type { MediaService } from '../../core/service'
import type { MediaInfo, SubtitleDocument } from '../../shared/types'
import { serializeSrt } from '../../core/subtitles/srt'

const properties=['pause','time-pos','duration','volume','mute','speed','track-list','playlist','playlist-pos','path','media-title','video-params','video-out-params','aid','sid','audio-delay','sub-delay','loop-file','loop-playlist','ab-loop-a','ab-loop-b','eof-reached']
let verifiedBinary:Promise<string>|undefined
async function bundledExecutable():Promise<string> {
  if(!verifiedBinary)verifiedBinary=(async()=>{
    const directory=app.isPackaged?join(process.resourcesPath,'mpv'):join(app.getAppPath(),'resources/mpv')
    const manifestPath=app.isPackaged?join(process.resourcesPath,'mpv-manifest.json'):join(app.getAppPath(),'resources/mpv-manifest.json')
    const manifest=JSON.parse(await readFile(manifestPath,'utf8')),executable=join(directory,'mpv.exe')
    const digest=createHash('sha256');for await(const chunk of createReadStream(executable))digest.update(chunk)
    if(digest.digest('hex')!==manifest.executableSha256)throw new Error('内置 mpv 校验失败，请重新安装应用')
    return executable
  })().catch(error=>{verifiedBinary=undefined;throw error})
  return verifiedBinary
}

class PlayerSession extends EventEmitter {
  readonly state:PlayerState
  readonly surface:NativePlayerSurface
  readonly ipc=new MpvIpc()
  private process?:ChildProcessWithoutNullStreams
  private initialized:Promise<void>
  private abort=new AbortController()
  private closing=false
  private timer?:ReturnType<typeof setTimeout>
  private stderr=''
  private fileLoop=false
  private playlistLoop=false
  private operations:Promise<unknown>=Promise.resolve()
  private rect?:PlayerRect
  editorDocument?:SubtitleDocument
  editorTrack?:number
  constructor(readonly owner:PlayerOwner,readonly window:BrowserWindow,readonly dataPath:string){
    super();this.state=emptyPlayerState(owner);this.surface=new NativePlayerSurface(window)
    this.ipc.on('event',event=>this.event(event));this.ipc.on('connection-error',error=>this.fail(error));this.ipc.on('disconnected',()=>{if(!this.closing)this.fail(new Error('mpv 进程已断开'))})
    this.initialized=this.initialize()
    void this.initialized.catch(error=>this.fail(error))
  }
  private async initialize():Promise<void> {
    const executable=await bundledExecutable();this.abort.signal.throwIfAborted()
    const pipe=`\\\\.\\pipe\\muxivra-${process.pid}-${this.owner}-${randomUUID()}`
    const input=app.isPackaged?join(process.resourcesPath,'mpv-input.conf'):join(app.getAppPath(),'resources/mpv-input.conf')
    // Force local container demuxing; mpv's playlist parsers and network protocols are excluded.
    const options=`protocol_whitelist=[file,pipe],format_whitelist=[${inputFormatWhitelist}]`
    const args=['--no-config','--load-scripts=no','--ytdl=no','--osc=no','--osd-level=0','--idle=yes','--force-window=immediate','--keep-open=yes','--pause=yes','--volume=50','--hwdec=auto-safe','--vo=gpu-next','--gpu-api=d3d11','--sub-auto=no','--audio-file-auto=no','--autoload-files=no','--demuxer=lavf',`--demuxer-lavf-o=${options}`,'--input-default-bindings=no','--input-terminal=no',`--input-conf=${input}`,`--input-ipc-server=${pipe}`,`--wid=${this.surface.handle}`]
    args.push('--msg-level=all=warn','--term-status-msg=')
    this.process=spawn(executable,args,{windowsHide:true,stdio:['pipe','pipe','pipe'],shell:false})
    const record=(chunk:Buffer)=>{this.stderr=(this.stderr+chunk.toString()).slice(-5000)}
    this.process.stdout.on('data',record);this.process.stderr.on('data',record)
    this.process.on('error',error=>{this.abort.abort();this.fail(error)})
    this.process.on('exit',code=>{this.abort.abort();if(!this.closing)this.fail(new Error(`mpv 已退出 (${code})${this.stderr?'：'+this.stderr:''}`))})
    await this.ipc.connect(pipe,this.abort.signal)
    for(let index=0;index<properties.length;index++)await this.ipc.command(['observe_property',index+1,properties[index]])
    this.state.version=await this.ipc.command(['get_property','mpv-version']);this.state.ready=true;this.changed()
  }
  async execute<T>(operation:()=>Promise<T>):Promise<T>{const next=this.operations.catch(()=>{}).then(async()=>{await this.initialized;return operation()});this.operations=next;return next}
  async command(command:unknown[]):Promise<any>{try{return await this.ipc.command(command)}catch(error){throw new Error(`${command[0]}：${(error as Error).message}${this.stderr?'\n'+this.stderr:''}`)}}
  private fail(error:Error):void {this.state.ready=false;this.state.loading=false;this.state.error=error.message;this.surface.hide();this.changed()}
  changed():void {if(!this.timer)this.timer=setTimeout(()=>{this.timer=undefined;this.emit('state',structuredClone(this.state))},80)}
  private event(event:any):void {
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
  async shutdown():Promise<void> {
    this.closing=true;this.abort.abort();if(this.timer)clearTimeout(this.timer)
    try {if(this.state.ready)await this.command(['quit'])}catch{}
    if(this.process?.exitCode===null){await Promise.race([new Promise(resolve=>this.process!.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,1500))]);if(this.process.exitCode===null)this.process.kill()}
    this.ipc.close();this.surface.destroy()
  }
}

export class MpvPlayers extends EventEmitter {
  private sessions=new Map<PlayerOwner,PlayerSession>()
  constructor(readonly window:BrowserWindow,readonly service:MediaService){super()}
  private session(owner:PlayerOwner):PlayerSession {
    let session=this.sessions.get(owner)
    if(!session){
      session=new PlayerSession(owner,this.window,this.service.dataPath);this.sessions.set(owner,session)
      session.on('state',state=>this.emit('state',state))
      session.on('input',type=>{void this.input(session!,type).catch(error=>this.emit('action-error',String(error.message)))})
      session.on('file-loaded',()=>{if(session!.editorDocument)void this.subtitles(owner,session!.editorDocument).catch(error=>this.emit('action-error',String(error.message)))})
    }
    return session
  }
  state(owner:PlayerOwner):PlayerState {return structuredClone(this.sessions.get(owner)?.state??emptyPlayerState(owner))}
  async open(owner:PlayerOwner,paths:string[],append=false):Promise<void> {
    if(!paths.length||paths.length>500)throw new Error('播放列表需要 1 至 500 个文件')
    const authorized:string[]=[]
    for(const input of paths){const path=await this.service.paths.input(input);if(!/\.(mp4|mkv|mov|avi|webm|m4v|m4a|mp3|wav|flac|ogg|aac|ts|aiff?|ac3|eac3|dts|ape|wv|amr|au)$/i.test(path))throw new Error('不支持该媒体文件类型');authorized.push(path)}
    const previous=this.sessions.get(owner)
    if(previous?.state.error&&!previous.state.ready){await previous.shutdown();this.sessions.delete(owner)}
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
    const session=this.session(owner)
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
    const authorized=await this.service.paths.input(path),session=this.session(owner)
    await session.execute(async()=>{await session.command([kind==='audio'?'audio-add':'sub-add',authorized,'select'])})
  }
  async subtitles(owner:PlayerOwner,document:SubtitleDocument):Promise<void> {
    const session=this.session(owner);session.editorDocument=structuredClone(document)
    if(!session.state.path||session.state.loading)return
    await session.execute(async()=>{
      const cues=document.cues.filter(cue=>cue.text.trim()&&cue.endMs>cue.startMs)
      if(!cues.length){if(session.editorTrack)await session.command(['sub-remove',session.editorTrack]);session.editorTrack=undefined;return}
      const directory=join(this.service.dataPath,'player-subtitles');await mkdir(directory,{recursive:true})
      const path=join(directory,`${owner}.srt`);await writeFile(path,serializeSrt(cues))
      if(session.editorTrack)await session.command(['sub-reload',session.editorTrack])
      else {await session.command(['sub-add',path,'select','编辑字幕']);const tracks:PlayerTrack[]=await session.command(['get_property','track-list']);session.editorTrack=tracks.find(track=>track['external-filename']===path)?.id}
    })
  }
  async screenshot(owner:PlayerOwner,target:string):Promise<string> {
    const session=this.session(owner),output=await this.service.paths.output(target)
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
