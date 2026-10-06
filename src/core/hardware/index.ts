import { cpus, totalmem, type, release, arch, uptime } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { HardwareInfo, HardwareValue, GpuInfo } from '../../shared/hardware'
import { run } from '../engine/process'
import { JsonStore } from '../storage/json'
import { readDxgiAdapters, readNvidiaMemory, type DxgiAdapter } from './windows'

const field=<T>(value:T|undefined,detail?:string):HardwareValue<T>=>value===undefined?{status:'missing',detail:detail??'系统未提供此信息'}:{status:'available',value,...(detail?{detail}:{})}
const errorField=<T>(detail:string):HardwareValue<T>=>({status:'error',detail})
export function baseHardware():HardwareInfo {
  const processors=cpus(),models=[...new Set(processors.map(cpu=>cpu.model.trim()).filter(Boolean))]
  return {version:2,collector:'Node.js / Windows CIM / DXGI / NVIDIA NVML（如可用）',bootTimeMs:Date.now()-uptime()*1000,cpu:field(models.length?{models,logicalCores:processors.length}:undefined),memory:field(totalmem()||undefined),system:field(`${type()} ${release()}`),architecture:field(arch()),gpus:{status:'missing',detail:'尚未读取显卡信息'},warnings:[]}
}
const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>0?v:undefined
const string=(v:unknown)=>typeof v==='string'&&v.trim()?v.trim():undefined
const cpuSchema=z.object({Name:z.unknown().optional(),NumberOfCores:z.unknown().optional(),NumberOfLogicalProcessors:z.unknown().optional()})
const gpuSchema=z.object({Name:z.unknown().optional(),AdapterCompatibility:z.unknown().optional(),DriverVersion:z.unknown().optional(),PNPDeviceID:z.unknown().optional()})
const rawSchema=z.object({cpu:z.array(cpuSchema).optional(),cpuError:z.string().optional(),gpu:z.array(gpuSchema).optional(),gpuError:z.string().optional()})
export function parseWindowsHardware(raw:unknown,base=baseHardware()):HardwareInfo {
  const data=rawSchema.parse(raw),result=structuredClone(base)
  result.detectedAt=new Date().toISOString()
  if(data.cpuError) {result.cpu={...errorField(data.cpuError),value:base.cpu.value};result.warnings.push('CPU 的 CIM 查询失败；保留操作系统提供的基础信息')}
  else {
    const cpu=data.cpu??[],models=cpu.map(p=>string(p.Name)).filter((s):s is string=>!!s)
    const physical=cpu.map(p=>number(p.NumberOfCores)),logical=cpu.map(p=>number(p.NumberOfLogicalProcessors))
    result.cpu=field(models.length?{models,physicalCores:physical.length&&physical.every(v=>v!==undefined)?physical.reduce((a,b)=>a!+b!,0):undefined,logicalCores:logical.length&&logical.every(v=>v!==undefined)?logical.reduce((a,b)=>a!+b!,0)!:base.cpu.value?.logicalCores??0}:undefined)
    if(models.length&&!result.cpu.value?.physicalCores)result.warnings.push('CPU 物理核心数未提供')
  }
  if(data.gpuError)result.gpus=errorField(data.gpuError)
  else {
    const gpus:GpuInfo[]=(data.gpu??[]).map(gpu=>({name:field(string(gpu.Name)),vendor:field(string(gpu.AdapterCompatibility)),driver:field(string(gpu.DriverVersion)),memoryBytes:field<number>(undefined,'未读取到 DXGI 专用显存容量'),sharedMemoryBytes:field<number>(undefined),memorySource:'unavailable',kind:/virtual|iddDriver/i.test(string(gpu.Name)??'')||/^(ROOT|SWD)\\/i.test(string(gpu.PNPDeviceID)??'')?'virtual':'unknown'}))
    result.gpus=field(gpus.length?gpus:undefined,'未检测到显卡设备')
    if(gpus.length)delete result.gpus.detail
  }
  return result
}
export function mergeDxgiHardware(info:HardwareInfo,adapters:DxgiAdapter[],raw:unknown,nvidia:{pciAddress:string;deviceId:number;totalBytes:number}[]=[]):HardwareInfo {
  const data=rawSchema.parse(raw),remaining=[...(info.gpus.value??[])],normalize=(name:string)=>name.toLowerCase().replace(/[^a-z0-9]/g,'')
  const groups=new Map<string,DxgiAdapter[]>()
  for(const adapter of adapters){const key=adapter.pciAddress&&!adapter.software?`${adapter.vendorId}:${adapter.deviceId}:${adapter.subSysId}:${adapter.pciAddress}`:adapter.id;groups.set(key,[...(groups.get(key)??[]),adapter])}
  const merged:GpuInfo[]=[...groups.values()].map(group=>{
    const adapter=group[0]
    const matches=(data.gpu??[]).map((gpu,index)=>({gpu,index})).filter(({gpu})=>{
      const pnp=string(gpu.PNPDeviceID)??''
      return pnp.toLowerCase().includes(`ven_${adapter.vendorId.toString(16).padStart(4,'0')}&dev_${adapter.deviceId.toString(16).padStart(4,'0')}`)||normalize(string(gpu.Name)??'')===normalize(adapter.name)
    })
    // Never attach an ambiguous driver/device record to the wrong physical adapter.
    const source=matches.length===1?info.gpus.value?.[matches[0].index]:undefined
    if(source&&remaining.includes(source)&&!adapter.virtual)remaining.splice(remaining.indexOf(source),1)
    const driverMemory=adapter.vendorId===0x10de?nvidia.find(gpu=>gpu.pciAddress===adapter.pciAddress&&gpu.deviceId===adapter.deviceId):undefined
    return {name:field(adapter.name),vendor:source?.vendor??field(({0x10de:'NVIDIA',0x8086:'Intel',0x1002:'AMD'} as Record<number,string>)[adapter.vendorId]),driver:source?.driver??field<string>(undefined),memoryBytes:field(driverMemory?.totalBytes??adapter.dedicatedBytes,driverMemory?'NVIDIA 驱动 · 物理显存总容量':'DXGI · 系统可用专用显存'),sharedMemoryBytes:field(adapter.sharedBytes,'DXGI · 可用共享内存上限'),memorySource:driverMemory?'NVML':'DXGI',usableMemoryBytes:adapter.dedicatedBytes,id:adapter.id,adapterIds:group.map(g=>g.id),pciAddress:adapter.pciAddress,kind:adapter.software?'software':adapter.virtual?'virtual':'physical'}
  })
  info.gpus=field([...merged,...remaining]);return info
}
export async function collectHardware():Promise<HardwareInfo> {
  const base=baseHardware()
  if(process.platform!=='win32')return {...base,detectedAt:new Date().toISOString(),gpus:{status:'missing',detail:'此平台尚无显卡信息读取器'}}
  const script=`[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$result = @{}
try { $result.cpu = @(Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors) } catch { $result.cpuError = $_.Exception.Message }
try { $result.gpu = @(Get-CimInstance Win32_VideoController -ErrorAction Stop | Select-Object Name,AdapterCompatibility,DriverVersion,PNPDeviceID) } catch { $result.gpuError = $_.Exception.Message }
ConvertTo-Json -InputObject $result -Depth 5 -Compress`
  let raw:unknown={},info:HardwareInfo
  try {
    const executable=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe')
    raw=JSON.parse((await run(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:15000})).replace(/^\uFEFF/,''));info=parseWindowsHardware(raw,base)
  } catch(error) {
    const message=(error as Error).message
    info={...base,detectedAt:new Date().toISOString(),cpu:{...errorField(message),value:base.cpu.value},gpus:errorField(message),warnings:['Windows CIM 读取失败；基础信息来自操作系统']}
  }
  try{
    const adapters=readDxgiAdapters();let nvidia:ReturnType<typeof readNvidiaMemory>=[]
    if(adapters.some(a=>a.vendorId===0x10de))try{nvidia=readNvidiaMemory()}catch(error){info.warnings.push(`NVIDIA 驱动物理显存读取不可用；采用 DXGI 系统可用容量。${(error as Error).message}`)}
    return mergeDxgiHardware(info,adapters,raw,nvidia)
  }catch(error){info.warnings.push(`DXGI 读取失败：${(error as Error).message}`);return info}
}
const valueSchema=z.object({status:z.enum(['available','missing','error']),value:z.unknown().optional(),detail:z.string().optional()})
const cacheSchema=z.object({version:z.literal(2),bootTimeMs:z.number().optional(),detectedAt:z.string().optional(),collector:z.string(),cpu:valueSchema.extend({value:z.object({models:z.array(z.string()),physicalCores:z.number().optional(),logicalCores:z.number()}).optional()}),memory:valueSchema.extend({value:z.number().optional()}),system:valueSchema.extend({value:z.string().optional()}),architecture:valueSchema.extend({value:z.string().optional()}),gpus:valueSchema.extend({value:z.array(z.object({name:valueSchema.extend({value:z.string().optional()}),vendor:valueSchema.extend({value:z.string().optional()}),driver:valueSchema.extend({value:z.string().optional()}),memoryBytes:valueSchema.extend({value:z.number().optional()}),sharedMemoryBytes:valueSchema.extend({value:z.number().optional()}),memorySource:z.enum(['NVML','DXGI','unavailable']),kind:z.enum(['physical','virtual','software','unknown']),id:z.string().optional(),adapterIds:z.array(z.string()).optional(),pciAddress:z.string().optional(),usableMemoryBytes:z.number().optional()})).optional()}),warnings:z.array(z.string())})
export class HardwareStore {
  info=baseHardware()
  refreshing=false
  private pending?:Promise<void>
  private store:JsonStore<HardwareInfo|undefined>
  constructor(dataPath:string,private update:()=>void,private collect=collectHardware){this.store=new JsonStore(join(dataPath,'hardware.json'))}
  async initialize():Promise<void> {
    try {
      const cached=await this.store.read(undefined)
      if(cached){const parsed=cacheSchema.parse(cached),boot=Date.now()-uptime()*1000;if(parsed.bootTimeMs!==undefined&&Math.abs(parsed.bootTimeMs-boot)<60000){this.info=parsed;return}}
    }
    catch { /* Recollect old or invalid caches; v1 contains truncated CIM VRAM values. */ }
    await this.refresh()
  }
  refresh():Promise<void> {
    if(this.pending)return this.pending
    this.refreshing=true;this.update()
    this.pending=(async()=>{
      try {this.info=await this.collect();await this.store.write(this.info)}
      finally {this.refreshing=false;this.pending=undefined;this.update()}
    })()
    return this.pending
  }
  async shutdown():Promise<void>{await this.pending?.catch(()=>{});await this.store.flush()}
}
