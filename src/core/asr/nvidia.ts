import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import type { NvidiaDetection,NvidiaDevice } from '../../shared/asr-deployment'
const execute=promisify(execFile)
export function parseNvidiaDevices(text:string):NvidiaDevice[]{
  const devices=text.trim().split(/\r?\n/).filter(Boolean).map(line=>{
    const [index,uuid,name,driver,compute,total,free]=line.split(',').map(v=>v.trim()),[major,minor]=compute?.split('.').map(Number)??[]
    if(!/^GPU-[a-zA-Z0-9-]+$/.test(uuid??'')||!/^\d+(?:\.\d+)+$/.test(driver??'')||![index,major,minor,total,free].every(v=>Number.isFinite(Number(v))))throw new Error('NVIDIA 驱动返回了无法识别的设备信息')
    return {index:Number(index),uuid,name,driver,computeMajor:major,computeMinor:minor,totalBytes:Number(total)*1024**2,freeBytes:Number(free)*1024**2}
  });if(!devices.length)throw new Error('没有检测到可用 NVIDIA GPU');return devices
}
export async function detectNvidia():Promise<NvidiaDetection>{
  if(process.platform!=='win32'||process.arch!=='x64')return {devices:[],checkedAt:new Date().toISOString(),issue:'一键部署目前需要 Windows x64 与 NVIDIA 官方驱动'}
  const candidates=[join(process.env.SystemRoot??'C:\\Windows','System32','nvidia-smi.exe'),join(process.env.ProgramFiles??'C:\\Program Files','NVIDIA Corporation','NVSMI','nvidia-smi.exe'),'nvidia-smi.exe']
  let issue='请安装可用的 NVIDIA 官方驱动'
  for(const executable of candidates){try{const result=await execute(executable,['--query-gpu=index,uuid,name,driver_version,compute_cap,memory.total,memory.free','--format=csv,noheader,nounits'],{windowsHide:true,timeout:15000,maxBuffer:256*1024});return {devices:parseNvidiaDevices(result.stdout),checkedAt:new Date().toISOString()}}catch(error){issue=(error as Error).message.slice(-800)}}
  return {devices:[],checkedAt:new Date().toISOString(),issue:'无法读取 NVIDIA CUDA 设备。请检查官方驱动，或使用手动兼容配置。'+issue}
}
