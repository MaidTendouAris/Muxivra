import { parentPort,workerData } from 'node:worker_threads'
import { open } from 'node:fs/promises'
import { mediaInfoFactory } from 'mediainfo.js'

async function analyze(){
  const instance=await mediaInfoFactory({format:'object',full:true})
  const file=await open(workerData.path,'r').catch(error=>{instance.close();throw error})
  try{
    const info=await file.stat()
    const result=await instance.analyzeData(info.size,async(size,offset)=>{
      const buffer=Buffer.alloc(Math.min(size,Math.max(0,info.size-offset)))
      const {bytesRead}=await file.read(buffer,0,buffer.length,offset)
      return buffer.subarray(0,bytesRead)
    })
    parentPort?.postMessage({value:{path:workerData.path,library:result.creatingLibrary,tracks:result.media?.track.map(track=>{const {'@type':type,...fields}=track;return {type,fields}})??[]}})
  }finally{instance.close();await file.close()}
}
void analyze().catch(error=>parentPort?.postMessage({error:error.message}))
