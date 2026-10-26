import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import type { MediaMetadata } from '../shared/media-metadata'
const cache=new Map<string,Promise<MediaMetadata>>()
export async function readMediaMetadata(path:string):Promise<MediaMetadata>{
  const info=await stat(path),key=`${path}:${info.size}:${info.mtimeMs}`
  let pending=cache.get(key)
  if(!pending){
    pending=new Promise<MediaMetadata>((resolve,reject)=>{
      const worker=new Worker(join(__dirname,'metadata-worker.js'),{workerData:{path}})
      const timer=setTimeout(()=>{void worker.terminate();reject(new Error('读取媒体元数据超时，请重试'))},60000)
      const stop=()=>clearTimeout(timer)
      worker.once('message',data=>{stop();void worker.terminate();if(data.error)reject(new Error(data.error));else resolve(data.value)})
      worker.once('error',error=>{stop();reject(error)})
      worker.once('exit',code=>{stop();if(code!==0)reject(new Error('媒体元数据读取进程已停止'))})
    })
    cache.set(key,pending);void pending.catch(()=>cache.delete(key))
    if(cache.size>12)cache.delete(cache.keys().next().value!)
  }
  return pending
}
