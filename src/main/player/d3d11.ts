import koffi,{type TypeObject} from 'koffi'

// Only the render worker owns these COM objects. There is no HWND/swap chain.
const pointer=koffi.pointer('void'),output=koffi.out(koffi.pointer(pointer)),prototypes=new Map<string,TypeObject>()
function call(object:bigint,index:number,result:string,args:(string|TypeObject|ReturnType<typeof koffi.out>)[],...values:unknown[]):any {
  const key=[index,result,...args.map(arg=>typeof arg==='string'?arg:'out')].join('|')
  let prototype=prototypes.get(key)
  if(!prototype){prototype=koffi.proto('__stdcall',null,result,['void *',...args]);prototypes.set(key,prototype)}
  return koffi.call(koffi.decode(koffi.decode(object,pointer),index*8,pointer),prototype,object,...values)
}
function check(code:number,label:string):void {if(code<0)throw new Error(`${label}：D3D11 0x${(code>>>0).toString(16)}`)}
function guid(value:string):Buffer {
  const text=value.replaceAll('-',''),bytes=Buffer.alloc(16)
  bytes.writeUInt32LE(parseInt(text.slice(0,8),16));bytes.writeUInt16LE(parseInt(text.slice(8,12),16),4);bytes.writeUInt16LE(parseInt(text.slice(12,16),16),6)
  Buffer.from(text.slice(16),'hex').copy(bytes,8);return bytes
}
const release=(object:bigint|undefined)=>{if(object)call(object,2,'uint32_t',[])}
const closeHandle=koffi.load('kernel32.dll').func('bool __stdcall CloseHandle(void *)')
export interface GpuTexture {id:number;width:number;height:number;texture:bigint;query:bigint;handle:Buffer;busy:boolean;retired:boolean}
export class D3D11Device {
  readonly device:bigint
  private readonly context:bigint
  constructor(adapter?:{vendorId:number;deviceId:number}) {
    let selected:bigint|undefined,factory:bigint|undefined
    try {
      const value=[null];check(koffi.load('dxgi.dll').func('int __stdcall CreateDXGIFactory1(void *, _Out_ void **)')(guid('770aae78-f26f-4dba-a829-253c83d1b387'),value),'创建 DXGI 工厂');factory=value[0] as unknown as bigint
      // Match Chromium's adapter on hybrid GPU systems; cross-adapter handles
      // cannot be imported reliably by Chromium's D3D11 device.
      if(adapter)for(let index=0;index<32;index++){
        const candidate=[null];if(call(factory,12,'int',['uint32_t',output],index,candidate)<0)break
        const item=candidate[0] as unknown as bigint,description=Buffer.alloc(320)
        try {check(call(item,10,'int',['void *'],description),'读取 GPU');if(description.readUInt32LE(256)===adapter.vendorId&&description.readUInt32LE(260)===adapter.deviceId){selected=item;break}}finally{if(selected!==item)release(item)}
      }
      if(adapter&&!selected)throw new Error('无法找到 Electron 正在使用的 GPU，请重启应用或更新显卡驱动')
      const device=[null],context=[null]
      check(koffi.load('d3d11.dll').func('int __stdcall D3D11CreateDevice(void *, uint32_t, void *, uint32_t, void *, uint32_t, uint32_t, _Out_ void **, void *, _Out_ void **)')(selected??null,selected?0:1,null,0x20,null,0,7,device,null,context),'创建播放设备')
      this.device=device[0] as unknown as bigint;this.context=context[0] as unknown as bigint
    }finally{release(selected);release(factory)}
  }
  createTexture(id:number,width:number,height:number):GpuTexture {
    let texture:bigint|undefined,resource:bigint|undefined,query:bigint|undefined,shared:bigint|undefined
    try {
      const description=Buffer.alloc(44)
      // BGRA8, GPU render target + shader resource, shared NT handle without a
      // keyed mutex. A completion query and Chromium release fence order reuse.
      ;[width,height,1,1,87,1,0,0,0x28,0,0x802].forEach((value,index)=>description.writeUInt32LE(value,index*4))
      const textureOut=[null];check(call(this.device,5,'int',['void *','void *',output],description,null,textureOut),'创建播放纹理');texture=textureOut[0] as unknown as bigint
      const resourceOut=[null];check(call(texture,0,'int',['void *',output],guid('30961379-4609-4a41-998e-54fe567ee0c1'),resourceOut),'共享播放纹理');resource=resourceOut[0] as unknown as bigint
      const handleOut=[null];check(call(resource,13,'int',['void *','uint32_t','void *',output],null,0x80000000,null,handleOut),'创建只读纹理句柄');shared=handleOut[0] as unknown as bigint
      const queryOut=[null];check(call(this.device,24,'int',['void *',output],Buffer.alloc(8),queryOut),'创建 GPU 完成查询');query=queryOut[0] as unknown as bigint
      const handle=Buffer.alloc(8);handle.writeBigUInt64LE(shared)
      return {id,width,height,texture,query,handle,busy:false,retired:false}
    }catch(error){if(shared)closeHandle(shared);release(query);release(texture);throw error}finally{release(resource)}
  }
  submit(texture:GpuTexture):void {call(this.context,28,'void',['void *'],texture.query);call(this.context,111,'void',[])}
  completed(texture:GpuTexture):boolean {const result=call(this.context,29,'int',['void *','void *','uint32_t','uint32_t'],texture.query,null,0,0);check(result,'等待 GPU 渲染');return result===0}
  destroyTexture(texture:GpuTexture):void {closeHandle(texture.handle.readBigUInt64LE());release(texture.query);release(texture.texture)}
  destroy():void {release(this.context);release(this.device)}
}
