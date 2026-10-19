import { spawn } from 'node:child_process'
import type { Engine, MediaInfo } from '../../shared/types'
import { inputFormatWhitelist } from '../../shared/media-policy'
import { waveformRequestSchema,type WaveformRequest,type WaveformWindow } from '../../shared/waveform'

/** Decode a bounded viewport rather than downsampling the entire movie. */
export async function makeWaveform(engine:Engine,media:MediaInfo,input:Partial<WaveformRequest>={},signal?:AbortSignal):Promise<WaveformWindow> {
  const request=waveformRequestSchema.parse(input),audio=media.streams.find(s=>s.type==='audio')
  const sampleRate=48000,channels=Math.max(1,Math.min(8,audio?.channels??1))
  const result:WaveformWindow={...request,sampleRate,channels,hasAudio:!!audio,minimum:[],maximum:[],rms:[]}
  if(signal?.aborted)throw new Error('波形读取已取消')
  if(!audio||request.startMs>=media.durationMs)return result
  return new Promise((resolve,reject)=>{
    const minimum=new Array<number>(request.width).fill(0),maximum=minimum.slice(),squares=minimum.slice(),counts=minimum.slice()
    const durationSamples=Math.ceil(request.durationMs/1000*sampleRate),frameBytes=channels*4
    // first_pts preserves silence before delayed audio; async fills timestamp gaps.
    const child=spawn(engine.ffmpegPath,['-v','error','-nostdin','-protocol_whitelist','file,pipe','-format_whitelist',inputFormatWhitelist,
      '-ss',String(request.startMs/1000),'-i',media.path,'-map',`0:${audio.index}`,'-vn','-sn','-dn',
      '-t',String(request.durationMs/1000),'-ac',String(channels),'-af','aresample=48000:async=1:first_pts=0','-ar',String(sampleRate),'-f','f32le','pipe:1'],
      {shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']})
    let samples=0,leftover=Buffer.alloc(0),errorText='',failure:Error|undefined
    const abort=()=>{failure=new Error('波形读取已取消');child.kill()}
    const timeout=setTimeout(()=>{failure=new Error('波形读取超时');child.kill()},60000)
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort()
    child.stdout.on('data',(chunk:Buffer)=>{
      const data=leftover.length?Buffer.concat([leftover,chunk]):chunk,complete=data.length-data.length%frameBytes
      for(let i=0;i<complete;i+=frameBytes){
        const bin=Math.floor(samples++/durationSamples*request.width);if(bin>=request.width)continue
        // Keep extrema across channels, including anti-phase stereo signals.
        for(let channel=0;channel<channels;channel++){
          const raw=data.readFloatLE(i+channel*4),value=Number.isFinite(raw)?Math.max(-1,Math.min(1,raw)):0
          minimum[bin]=Math.min(minimum[bin],value);maximum[bin]=Math.max(maximum[bin],value)
          squares[bin]+=value*value;counts[bin]++
        }
      }
      leftover=Buffer.from(data.subarray(complete))
    })
    child.stderr.on('data',(chunk:Buffer)=>{errorText=(errorText+chunk.toString()).slice(-4000)})
    child.on('error',error=>{failure=error})
    child.on('close',code=>{
      clearTimeout(timeout);signal?.removeEventListener('abort',abort)
      if(failure||code!==0)reject(failure??new Error(errorText||'音频波形解码失败'))
      else resolve({...result,minimum,maximum,rms:squares.map((sum,index)=>counts[index]?Math.sqrt(sum/counts[index]):0)})
    })
  })
}
