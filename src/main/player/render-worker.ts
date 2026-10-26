import { parentPort,workerData } from 'node:worker_threads'
import koffi from 'koffi'
import { D3D11Device,type GpuTexture } from './d3d11'
import type { PlayerTextureSize } from '../../shared/player-texture'

const port=parentPort!
const data=workerData as {library:string;owner:string;options:Record<string,string>;adapter?:{vendorId:number;deviceId:number}}
let device:D3D11Device|undefined,library:ReturnType<typeof koffi.load>|undefined,handle:bigint|undefined,renderContext:bigint|undefined
let timer:ReturnType<typeof setInterval>|undefined,closing=false,disposed=false,dirty=true,nextId=1,pending:GpuTexture|undefined,pendingSince=0
let size:PlayerTextureSize={width:640,height:360,visible:false}
const textures=new Map<number,GpuTexture>(),Param=koffi.struct({type:'int',data:'void *'})
const parameters=(values:{type:number;data:Buffer|null}[])=>koffi.as([...values,{type:0,data:null}],koffi.pointer(Param))
const pointerBytes=(value:bigint)=>{const bytes=Buffer.alloc(8);bytes.writeBigUInt64LE(value);return bytes}
function check(code:number,label:string):void {if(code<0)throw new Error(`${label}：${library!.func('const char *mpv_error_string(int)')(code)}`)}
function collect():void {for(const [id,texture]of textures)if(texture.retired&&!texture.busy&&texture!==pending){device!.destroyTexture(texture);textures.delete(id)}}
function dispose():void {
  if(disposed||pending||[...textures.values()].some(texture=>texture.busy))return
  disposed=true;if(timer)clearInterval(timer)
  if(renderContext)library!.func('void mpv_render_context_free(void *)')(renderContext)
  if(handle)library!.func('void mpv_terminate_destroy(void *)')(handle)
  for(const texture of textures.values())device!.destroyTexture(texture)
  textures.clear();device?.destroy();port.postMessage({type:'stopped'});port.close()
}
function fail(error:unknown):void {if(!closing)port.postMessage({type:'error',message:(error as Error).message});closing=true;dispose()}
try {
  library=koffi.load(data.library);handle=library.func('void *mpv_create()')()
  if(!handle)throw new Error('无法创建 libmpv 会话')
  const set=library.func('int mpv_set_option_string(void *, const char *, const char *)')
  for(const [key,value]of Object.entries(data.options))check(set(handle,key,value),`mpv ${key}`)
  check(library.func('int mpv_initialize(void *)')(handle),'初始化 mpv')
  device=new D3D11Device(data.adapter)
  const context=[null]
  check(library.func('int mpv_render_context_create(_Out_ void **, void *, void *)')(context,handle,parameters([{type:1,data:Buffer.from('d3d11\0')},{type:21,data:pointerBytes(device.device)}])),'初始化 mpv GPU 渲染')
  renderContext=context[0] as unknown as bigint
  const update=library.func('uint64_t mpv_render_context_update(void *)'),render=library.func('int mpv_render_context_render(void *, void *)'),swap=library.func('void mpv_render_context_report_swap(void *)')
  timer=setInterval(()=>{
    try {
      if(pending){
        if(!device!.completed(pending)){if(Date.now()-pendingSince>5000)throw new Error('播放 GPU 无响应，请检查显卡驱动');return}
        const completed=pending;pending=undefined
        if(closing){completed.busy=false;dispose();return}
        port.postMessage({type:'frame',owner:data.owner,id:completed.id,width:completed.width,height:completed.height,handle:completed.handle,textures:textures.size});swap(renderContext!)
      }
      if(closing){dispose();return}
      dirty=!!(Number(update(renderContext!))&1)||dirty
      if(!dirty)return
      if(!size.visible){
        // Hidden surfaces still drain mpv requests; otherwise control commands
        // can wait on a renderer that stopped responding.
        check(render(renderContext!,parameters([{type:13,data:Buffer.from([1,0,0,0])}])),'跳过隐藏画面');dirty=false;return
      }
      collect()
      let texture=[...textures.values()].find(item=>!item.retired&&!item.busy)
      if(!texture&&textures.size<3){texture=device!.createTexture(nextId++,size.width,size.height);textures.set(texture.id,texture)}
      // Backpressure: Chromium must release all VideoFrames before reuse. The
      // three-slot limit also includes retired textures during rapid resizes.
      if(!texture)return
      texture.busy=true;dirty=false
      check(render(renderContext!,parameters([{type:22,data:pointerBytes(texture.texture)}])),'渲染视频')
      device!.submit(texture);pending=texture;pendingSince=Date.now()
    }catch(error){if(pending){pending.busy=false;pending=undefined}fail(error)}
  },4)
  port.on('message',(message:{type:string;id?:number;size?:PlayerTextureSize})=>{
    if(message.type==='release'){const texture=textures.get(message.id!);if(texture)texture.busy=false;collect();if(closing)dispose()}
    if(message.type==='size'&&!closing&&message.size){
      const next=message.size
      if(next.width!==size.width||next.height!==size.height){for(const texture of textures.values())texture.retired=true;collect()}
      if(next.visible||size.visible)dirty=true
      size=next
    }
    if(message.type==='stop'){closing=true;dispose()}
  })
  port.postMessage({type:'ready'})
}catch(error){fail(error)}
