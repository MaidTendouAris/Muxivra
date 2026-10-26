import { spawn } from 'node:child_process'
import { run } from '../engine/process'
import { inputFormatWhitelist } from '../../shared/media-policy'
import { videoTimingSchema,type VideoTiming } from '../../shared/video-timing'
import type { Engine,MediaInfo } from '../../shared/types'
export async function indexVideo(engine:Engine,media:MediaInfo,signal:AbortSignal,progress:(percent:number)=>void):Promise<VideoTiming>{
  const video=media.streams.find(s=>s.type==='video');if(!video)throw new Error('Media has no video stream')
  const info=JSON.parse(await run(engine.ffprobePath,['-v','error','-protocol_whitelist','file,pipe','-format_whitelist',inputFormatWhitelist,'-show_entries','format=start_time','-of','json',media.path])),origin=Number(info.format?.start_time??0)*1000
  if(signal.aborted)throw new Error('Frame indexing cancelled')
  return new Promise((resolve,reject)=>{
    const child=spawn(engine.ffprobePath,['-v','error','-protocol_whitelist','file,pipe','-format_whitelist',inputFormatWhitelist,'-select_streams',String(video.index),'-show_frames','-show_entries','frame=best_effort_timestamp_time,pkt_duration_time,duration_time,key_frame','-of','compact=p=0:nk=0',media.path],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']})
    let pending='',error='',failure:Error|undefined,lastDuration=0,lastNotify=0;const timestampsMs:number[]=[],keyframes:number[]=[]
    const consume=(line:string)=>{const fields=Object.fromEntries(line.split('|').map(value=>value.split('='))),time=Number(fields.best_effort_timestamp_time)*1000-origin;if(!Number.isFinite(time)||time<-.1)return;const ms=Math.max(0,time);if(timestampsMs.length&&ms<=timestampsMs.at(-1)!)return;if(timestampsMs.length>=2000000){failure=new Error('Video exceeds the 2,000,000-frame analysis limit');child.kill();return}if(fields.key_frame==='1')keyframes.push(timestampsMs.length);timestampsMs.push(ms);lastDuration=Number(fields.duration_time??fields.pkt_duration_time??0)*1000;if(Date.now()-lastNotify>250){progress(Math.min(99,ms/Math.max(1,media.durationMs)*100));lastNotify=Date.now()}}
    const abort=()=>{failure=new Error('Frame indexing cancelled');child.kill()};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
    const timeout=setTimeout(()=>{failure=new Error('Frame indexing timed out');child.kill()},30*60000)
    child.stdout.on('data',(buffer:Buffer)=>{pending+=buffer.toString();const lines=pending.split(/\r?\n/);pending=lines.pop()!;for(const line of lines)consume(line)})
    child.stderr.on('data',(buffer:Buffer)=>{error=(error+buffer.toString()).slice(-4000)})
    child.on('error',reason=>{failure=reason});child.on('close',code=>{clearTimeout(timeout);signal.removeEventListener('abort',abort);if(pending)consume(pending);if(failure||code!==0){reject(failure??new Error(error||'Video indexing failed'));return}try{const intervals=timestampsMs.slice(1).map((v,i)=>v-timestampsMs[i]),first=intervals[0]??0;const endMs=lastDuration>0?timestampsMs.at(-1)!+lastDuration:media.durationMs;const result=videoTimingSchema.parse({timestampsMs,keyframes,endMs,streamIndex:video.index,variable:intervals.some(value=>Math.abs(value-first)>.2)});progress(100);resolve(result)}catch(reason){reject(reason)}})
  })
}
