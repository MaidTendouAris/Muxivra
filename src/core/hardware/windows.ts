import koffi from 'koffi'
import { join } from 'node:path'

export interface DxgiAdapter { id: string; name: string; vendorId: number; deviceId: number; subSysId: number; dedicatedBytes: number; sharedBytes: number; software: boolean; pciAddress?:string; virtual?:boolean }
const systemDll=(name:string)=>join(process.env.SystemRoot??'C:\\Windows','System32',name)
const hex=(value:number)=>value.toString(16).padStart(8,'0')
const release=koffi.proto('uint32_t __stdcall MuxivraDxgiRelease(void *self)')
const enumerate=koffi.proto('int32_t __stdcall MuxivraDxgiEnumerate(void *self, uint32_t index, _Out_ void **adapter)')
const describe=koffi.proto('int32_t __stdcall MuxivraDxgiDescribe(void *self, void *description)')
const queryInfo=koffi.struct({handle:'uint32_t',type:'int32_t',data:'void *',size:'uint32_t'})
function pciAddress(luid:Buffer):string|undefined {
  const library=koffi.load(systemDll('gdi32.dll'))
  const open=library.func('int32_t __stdcall D3DKMTOpenAdapterFromLuid(void *data)'),query=library.func('D3DKMTQueryAdapterInfo','int32_t',[koffi.pointer(queryInfo)]),close=library.func('int32_t __stdcall D3DKMTCloseAdapter(void *data)')
  const input=Buffer.alloc(12);luid.copy(input,0)
  if(open(input)<0)return
  const handle=input.readUInt32LE(8),address=Buffer.alloc(12),closing=Buffer.alloc(4);closing.writeUInt32LE(handle)
  try {if(query({handle,type:6,data:address,size:12})<0)return;return `${address.readUInt32LE(0).toString(16).padStart(2,'0')}:${address.readUInt32LE(4).toString(16).padStart(2,'0')}.${address.readUInt32LE(8)}`}
  finally{close(closing)}
}

/** DXGI_ADAPTER_DESC1 uses SIZE_T (64 bits on our x64 target), unlike CIM AdapterRAM. */
export function readDxgiAdapters():DxgiAdapter[] {
  if(process.platform!=='win32'||process.arch!=='x64')throw new Error('DXGI 读取器需要 Windows x64')
  const library=koffi.load(systemDll('dxgi.dll'))
  const create=library.func('int32_t __stdcall CreateDXGIFactory1(const void *iid, _Out_ void **factory)')
  const method=(object:unknown,index:number)=>koffi.decode(koffi.decode(object,'void *'),index*8,'void *')
  const iid=Buffer.from('78ae0a776ff2ba4da829253c83d1b387','hex'),factory:unknown[]=[null]
  const status=create(iid,factory)
  if(status<0)throw new Error(`CreateDXGIFactory1: 0x${hex(status>>>0)}`)
  const adapters:DxgiAdapter[]=[]
  try {
    for(let index=0;index<64;index++) {
      const adapter:unknown[]=[null],hr=koffi.call(method(factory[0],12),enumerate,factory[0],index,adapter)
      if((hr>>>0)===0x887a0002)break // DXGI_ERROR_NOT_FOUND
      if(hr<0)throw new Error(`EnumAdapters1: 0x${hex(hr>>>0)}`)
      try {
        const buffer=Buffer.alloc(312),result=koffi.call(method(adapter[0],10),describe,adapter[0],buffer)
        if(result<0)throw new Error(`GetDesc1: 0x${hex(result>>>0)}`)
        let address:string|undefined;try{address=pciAddress(buffer.subarray(296,304))}catch{/* PCI identity is optional. */}
        const virtual=address?.startsWith('ffffffff:')??false
        adapters.push({name:buffer.subarray(0,256).toString('utf16le').split('\0')[0],vendorId:buffer.readUInt32LE(256),deviceId:buffer.readUInt32LE(260),subSysId:buffer.readUInt32LE(264),dedicatedBytes:Number(buffer.readBigUInt64LE(272)),sharedBytes:Number(buffer.readBigUInt64LE(288)),id:`${hex(buffer.readUInt32LE(300))}_${hex(buffer.readUInt32LE(296))}`,software:!!(buffer.readUInt32LE(304)&2),pciAddress:virtual?undefined:address,virtual})
      } finally {koffi.call(method(adapter[0],2),release,adapter[0])}
    }
  } finally {koffi.call(method(factory[0],2),release,factory[0])}
  return adapters
}

/** Optional driver-supplied NVML. No vendor library is shipped with the application. */
export function readNvidiaMemory():{pciAddress:string;deviceId:number;totalBytes:number}[] {
  const library=koffi.load(systemDll('nvml.dll')),init=library.func('int nvmlInit_v2()'),shutdown=library.func('int nvmlShutdown()'),count=library.func('int nvmlDeviceGetCount_v2(_Out_ uint32_t *count)'),handle=library.func('int nvmlDeviceGetHandleByIndex_v2(uint32_t index, _Out_ void **device)'),pci=library.func('int nvmlDeviceGetPciInfo_v3(void *device, void *info)'),memory=library.func('int nvmlDeviceGetMemoryInfo(void *device, void *info)')
  const status=init();if(status)throw new Error(`NVML 初始化失败 (${status})`)
  try {
    const devices=[0];if(count(devices))throw new Error('NVML 无法列出设备')
    const result:{pciAddress:string;deviceId:number;totalBytes:number}[]=[]
    for(let index=0;index<Math.min(devices[0],64);index++) {
      const device:unknown[]=[null],p=Buffer.alloc(68),m=Buffer.alloc(24)
      if(handle(index,device)||pci(device[0],p)||memory(device[0],m))continue
      const busId=p.subarray(36,68).toString('utf8').split('\0')[0]
      result.push({pciAddress:busId.slice(busId.indexOf(':')+1).toLowerCase(),deviceId:p.readUInt32LE(28)>>>16,totalBytes:Number(m.readBigUInt64LE(0))})
    }
    return result
  }finally{shutdown()}
}

export interface CounterSample { name: string; value: number }
export interface GpuCounters { engines?:CounterSample[]; dedicated?:CounterSample[]; shared?:CounterSample[]; errors:Partial<Record<'engines'|'dedicated'|'shared',string>> }
/** One PDH query per visible monitor, owned by a dedicated Node worker. */
export class WindowsGpuCounters {
  private library=koffi.load(systemDll('pdh.dll'))
  private open=this.library.func('uint32_t __stdcall PdhOpenQueryW(void *source, uintptr_t data, _Out_ void **query)')
  private add=this.library.func('uint32_t __stdcall PdhAddEnglishCounterW(void *query, str16 path, uintptr_t data, _Out_ void **counter)')
  private collect=this.library.func('uint32_t __stdcall PdhCollectQueryData(void *query)')
  private close=this.library.func('uint32_t __stdcall PdhCloseQuery(void *query)')
  private array=this.library.func('uint32_t __stdcall PdhGetFormattedCounterArrayW(void *counter, uint32_t format, _Inout_ uint32_t *size, _Out_ uint32_t *count, void *buffer)')
  private query:unknown
  private handles=new Map<keyof GpuCounters,unknown>()
  private errors:GpuCounters['errors']={}
  constructor() {
    const query:unknown[]=[null],status=this.open(null,0,query)
    if(status)throw new Error(`PDH 初始化失败：0x${hex(status)}`)
    this.query=query[0]
    try {
      for(const [key,path] of Object.entries({engines:'\\GPU Engine(*)\\Utilization Percentage',dedicated:'\\GPU Adapter Memory(*)\\Dedicated Usage',shared:'\\GPU Adapter Memory(*)\\Shared Usage'})) {
        const handle:unknown[]=[null],hr=this.add(this.query,path,0,handle)
        if(hr)this.errors[key as keyof GpuCounters['errors']]=`计数器不可用：0x${hex(hr)}`
        else this.handles.set(key as keyof GpuCounters,handle[0])
      }
    }catch(error){this.shutdown();throw error}
  }
  sample():GpuCounters {
    const status=this.collect(this.query)
    const result:GpuCounters={errors:{...this.errors}}
    for(const key of ['engines','dedicated','shared'] as const) {
      const handle=this.handles.get(key)
      if(!handle)continue
      if(status){result.errors[key]=`计数器采样失败：0x${hex(status)}`;continue}
      // PDH_FMT_DOUBLE | PDH_FMT_NOCAP100: do not cap byte counters at 100.
      const size=[0],count=[0],format=0x200|0x8000
      let hr=this.array(handle,format,size,count,null)
      if(hr!==0x800007d2||!size[0]||size[0]>16*1024*1024){result.errors[key]=`暂无有效样本：0x${hex(hr)}`;continue}
      // Instances may appear/disappear between queries; re-query the size on the next tick.
      const buffer=Buffer.alloc(size[0]);hr=this.array(handle,format,size,count,buffer)
      if(hr){result.errors[key]=`采样数据不可用：0x${hex(hr)}`;continue}
      const samples:CounterSample[]=[]
      for(let index=0;index<count[0]&&index*24+24<=buffer.length;index++) {
        const offset=index*24,cstatus=buffer.readUInt32LE(offset+8),value=buffer.readDoubleLE(offset+16)
        if((cstatus===0||cstatus===1)&&Number.isFinite(value))samples.push({name:koffi.decode(buffer,offset,'str16'),value:Math.max(0,value)})
      }
      result[key]=samples
    }
    return result
  }
  shutdown(){if(this.query){this.close(this.query);this.query=undefined}}
}
