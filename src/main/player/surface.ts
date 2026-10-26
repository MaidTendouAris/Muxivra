import { app,sharedTexture,type BrowserWindow } from 'electron'
import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { playerTextureSize,type PlayerTextureFrame } from '../../shared/player-texture'
import type { PlayerOwner,PlayerRect } from '../../shared/player'

export class CompositedPlayerSurface extends EventEmitter {
  private worker?:Worker
  private rect?:PlayerRect
  private closing=false
  private stopped?:Promise<void>
  private resolveStopped?:()=>void
  private sentSize=''
  private shown=true
  readonly diagnostics={backend:'libmpv-d3d11-texture',frames:0,inFlight:0,maxInFlight:0,maxTextures:0}
  constructor(private window:BrowserWindow,private owner:PlayerOwner){super()}
  async start(library:string,options:Record<string,string>):Promise<void> {
    const info=await app.getGPUInfo('complete') as {gpuDevice?:{active:boolean;vendorId:number;deviceId:number}[]},adapter=info.gpuDevice?.find(device=>device.active)
    if(this.closing)throw new Error('播放会话已关闭')
    const worker=this.worker=new Worker(join(__dirname,'player-render-worker.js'),{workerData:{library,owner:this.owner,options,adapter:adapter?{vendorId:adapter.vendorId,deviceId:adapter.deviceId}:undefined}})
    this.stopped=new Promise(resolve=>{this.resolveStopped=resolve})
    await new Promise<void>((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('mpv GPU 渲染初始化超时')),15000)
      let ready=false
      worker.on('message',message=>{
        if(message.type==='ready'){ready=true;clearTimeout(timeout);this.sync();resolve()}
        if(message.type==='frame')void this.present(message)
        if(message.type==='stopped')this.resolveStopped?.()
        if(message.type==='error'){const error=new Error(message.message);if(!ready){clearTimeout(timeout);reject(error)}else if(!this.closing)this.emit('error',error)}
      })
      worker.on('error',error=>{clearTimeout(timeout);if(!ready)reject(error);else if(!this.closing)this.emit('error',error)})
      worker.on('exit',code=>{clearTimeout(timeout);this.resolveStopped?.();if(!ready)reject(new Error(`mpv 渲染线程已退出 (${code})`));else if(!this.closing&&code!==0)this.emit('error',new Error(`mpv 渲染线程已退出 (${code})`))})
    }).catch(async error=>{await this.destroy();throw error})
  }
  private async present(frame:PlayerTextureFrame&{textures?:number}):Promise<void> {
    this.diagnostics.maxTextures=Math.max(this.diagnostics.maxTextures,frame.textures??0)
    const worker=this.worker
    if(this.closing||this.window.isDestroyed()){worker?.postMessage({type:'release',id:frame.id});return}
    let imported:Electron.SharedTextureImported|undefined
    let released=false
    const release=()=>{if(released)return;released=true;this.diagnostics.inFlight--;worker?.postMessage({type:'release',id:frame.id})}
    try {
      this.diagnostics.inFlight++;this.diagnostics.maxInFlight=Math.max(this.diagnostics.inFlight,this.diagnostics.maxInFlight)
      imported=sharedTexture.importSharedTexture({textureInfo:{codedSize:{width:frame.width,height:frame.height},pixelFormat:'bgra',handle:{ntHandle:Buffer.from(frame.handle)}},allReferencesReleased:release})
      await sharedTexture.sendSharedTexture({frame:this.window.webContents.mainFrame,importedSharedTexture:imported},{owner:this.owner,width:frame.width,height:frame.height})
      this.diagnostics.frames++
    }catch(error){
      if(!imported)release()
      if(!this.closing&&!this.window.isDestroyed())this.emit('error',new Error(`视频纹理传输失败：${(error as Error).message}`))
    }finally{imported?.release()}
  }
  update(rect:PlayerRect):void {this.rect=rect;this.shown=true;this.sync()}
  private sync():void {
    if(!this.worker||!this.rect||this.closing)return
    const rect=this.rect,size={...playerTextureSize(rect.width,rect.height,rect.scale),visible:this.shown&&rect.visible&&rect.active&&this.window.isVisible()}
    const key=JSON.stringify(size);if(key===this.sentSize)return;this.sentSize=key;this.worker.postMessage({type:'size',size})
  }
  hide():void {this.shown=false;this.sync()}
  async destroy():Promise<void> {
    this.closing=true;if(!this.worker)return
    // Drop any image retained by the 2D canvas before waiting for Chromium's
    // release callbacks. Clearing works even if React detached the old canvas.
    if(!this.window.isDestroyed())this.window.webContents.send('muxivra:player-surface-clear',this.owner)
    this.worker.postMessage({type:'stop'})
    let timeout:ReturnType<typeof setTimeout>|undefined
    try{await Promise.race([this.stopped,new Promise(resolve=>{timeout=setTimeout(resolve,6000)})])}finally{if(timeout)clearTimeout(timeout)}
    await this.worker.terminate();this.worker=undefined
  }
}
