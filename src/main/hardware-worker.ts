import { parentPort } from 'node:worker_threads'
import { WindowsGpuCounters } from '../core/hardware/windows'

let counters:WindowsGpuCounters|undefined
parentPort?.on('message',message=>{
  if(message==='stop'){counters?.shutdown();counters=undefined;parentPort!.close();return}
  if(message!=='sample')return
  try {counters??=new WindowsGpuCounters();parentPort!.postMessage({data:counters.sample()})}
  catch(error){parentPort!.postMessage({error:(error as Error).message})}
})
