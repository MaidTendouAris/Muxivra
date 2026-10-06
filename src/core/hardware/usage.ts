import { cpus, freemem, totalmem, type CpuInfo } from 'node:os'
import { Worker } from 'node:worker_threads'
import type { HardwareInfo, HardwareValue, GpuUsage, SystemUsage } from '../../shared/hardware'
import type { GpuCounters } from './windows'

const available=<T>(value:T):HardwareValue<T>=>({status:'available',value})
const missing=<T>(detail:string):HardwareValue<T>=>({status:'missing',detail})
const clamp=(value:number)=>Math.min(100,Math.max(0,value))
export function cpuDelta(previous:CpuInfo[]|undefined,current:CpuInfo[]):HardwareValue<number[]> {
  if(!previous||!current.length||previous.length!==current.length)return missing('正在采集首个样本')
  const values=current.map((cpu,index)=>{
    const old=previous[index].times,delta=Object.entries(cpu.times).map(([key,value])=>value-old[key as keyof CpuInfo['times']])
    const total=delta.reduce((sum,v)=>sum+v,0),idle=cpu.times.idle-old.idle
    return total>0&&delta.every(v=>v>=0)?clamp((1-idle/total)*100):undefined
  })
  return values.every(v=>v!==undefined)?available(values as number[]):missing('CPU 时间计数正在重置，等待下一次采样')
}
const luid=(name:string)=>{const m=/luid_0x([a-f0-9]+)_0x([a-f0-9]+)/i.exec(name);return m?`${m[1].toLowerCase().padStart(8,'0')}_${m[2].toLowerCase().padStart(8,'0')}`:undefined}
export function gpuUsage(hardware:HardwareInfo,counters:GpuCounters):GpuUsage[] {
  return (hardware.gpus.value??[]).filter(g=>g.kind==='physical'&&g.id).map(gpu=>{
    const ids=gpu.adapterIds??[gpu.id!],belongs=(name:string)=>ids.includes(luid(name)??'')
    // Sum process instances of the SAME hardware engine; overall is the busiest engine.
    const engineTotals=new Map<string,{name:string;value:number}>()
    for(const sample of counters.engines??[]) {
      const match=/phys_(\d+)_eng_(\d+)_engtype_(.+?)(?:#\d+)?$/i.exec(sample.name)
      if(!match||!belongs(sample.name))continue
      const key=`${luid(sample.name)}:${match[1]}:${match[2]}`,old=engineTotals.get(key)
      engineTotals.set(key,{name:`${match[3]} · ${match[1]}:${match[2]}`,value:(old?.value??0)+sample.value})
    }
    const engines=[...engineTotals.values()].map(e=>({name:e.name,utilization:clamp(e.value)}))
    const metric=(pattern?:RegExp):HardwareValue<number>=>{
      const values=engines.filter(e=>!pattern||pattern.test(e.name)).map(e=>e.utilization)
      return values.length?available(Math.max(...values)):missing(counters.errors.engines??(pattern?'驱动未提供此引擎的计数器':'未读取到此设备的 GPU 引擎计数器'))
    }
    const memory=(key:'dedicated'|'shared'):HardwareValue<number>=>{
      const samples=counters[key]?.filter(s=>belongs(s.name))
      return samples?.length?available(samples.reduce((total,s)=>total+s.value,0)):missing(counters.errors[key]??'驱动未提供此设备的内存计数器')
    }
    return {id:gpu.id!,name:gpu.name.value??'未命名显卡',utilization:metric(),encoder:metric(/VideoEncode/i),decoder:metric(/VideoDecode/i),dedicatedBytes:memory('dedicated'),sharedBytes:memory('shared'),dedicatedTotal:gpu.memoryBytes.value,sharedTotal:gpu.sharedMemoryBytes.value,engines}
  })
}

export class UsageMonitor {
  private worker?:Worker
  private idle?:ReturnType<typeof setTimeout>
  private previous?:CpuInfo[]
  private lastTime?:number
  private pending?:Promise<SystemUsage>
  private closed=false
  private workerError?:string
  private request?:{resolve:(value:GpuCounters)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}
  constructor(private hardware:()=>HardwareInfo,private workerPath?:string){}
  private readGpu():Promise<GpuCounters> {
    if(process.platform!=='win32'||!this.workerPath)return Promise.resolve({errors:{engines:'GPU 监控需要 Windows 性能计数器',dedicated:'GPU 内存计数器不可用',shared:'GPU 内存计数器不可用'}})
    if(this.workerError)return Promise.resolve({errors:{engines:this.workerError,dedicated:this.workerError,shared:this.workerError}})
    if(!this.worker) {
      const worker=this.worker=new Worker(this.workerPath)
      worker.on('message',(message:{data?:GpuCounters;error?:string})=>{
        if(this.worker!==worker||!this.request)return
        const request=this.request;this.request=undefined;clearTimeout(request.timer)
        if(message.data)request.resolve(message.data);else request.reject(new Error(message.error??'GPU 采样失败'))
      })
      const fail=(error:Error)=>{if(this.worker!==worker)return;this.workerError=error.message;if(this.request){clearTimeout(this.request.timer);this.request.reject(error);this.request=undefined}this.worker=undefined}
      worker.on('error',fail);worker.on('exit',code=>{if(this.worker===worker)fail(new Error(`GPU 采样线程已退出 (${code})`))})
    }
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.request=undefined;reject(new Error('GPU 采样超时'));void this.stopWorker()},7000)
      this.request={resolve,reject,timer};this.worker!.postMessage('sample')
    })
  }
  read():Promise<SystemUsage> {
    if(this.closed)return Promise.reject(new Error('硬件监控已关闭'))
    if(this.pending)return this.pending
    clearTimeout(this.idle)
    this.pending=(async()=>{
      let counters:GpuCounters
      try{counters=await this.readGpu()}catch(error){const detail=(error as Error).message;counters={errors:{engines:detail,dedicated:detail,shared:detail}}}
      const now=performance.now(),current=cpus(),threads=cpuDelta(this.previous,current),total=totalmem(),used=Math.max(0,total-freemem()),gpus=gpuUsage(this.hardware(),counters)
      const valid=gpus.map(g=>g.utilization.value).filter((v):v is number=>v!==undefined),cpu=threads.value?available(threads.value.reduce((sum,v)=>sum+v,0)/threads.value.length):missing<number>(threads.detail??'正在采样')
      const result:SystemUsage={sampledAt:new Date().toISOString(),intervalMs:this.lastTime?Math.round(now-this.lastTime):undefined,cpu,threads,memory:{totalBytes:total,usedBytes:used,percent:total?used/total*100:0},gpu:valid.length?{...available(Math.max(...valid)),...(valid.length!==gpus.length?{detail:'部分设备的计数器缺失'}:{})}:missing(counters.errors.engines??'未读取到实体 GPU 占用'),gpus}
      this.previous=current;this.lastTime=now;return result
    })().finally(()=>{this.pending=undefined;if(!this.closed)this.idle=setTimeout(()=>void this.stopWorker(),6000)})
    return this.pending
  }
  private async stopWorker(){
    const worker=this.worker;this.worker=undefined;this.previous=undefined;this.lastTime=undefined;this.workerError=undefined
    if(worker)await new Promise<void>(resolve=>{
      const timer=setTimeout(()=>void worker.terminate().finally(resolve),2000)
      worker.once('exit',()=>{clearTimeout(timer);resolve()});worker.postMessage('stop')
    })
  }
  async shutdown(){this.closed=true;clearTimeout(this.idle);await this.pending;await this.stopWorker()}
}
