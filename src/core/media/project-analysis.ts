import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat,mkdir,open,readFile,realpath,rm,stat,writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename,join } from 'node:path'
import { z } from 'zod'
import type { Engine,MediaInfo } from '../../shared/types'
import { waveformRequestSchema,type WaveformRequest,type WaveformWindow } from '../../shared/waveform'
import { videoTimingSchema,type VideoTiming } from '../../shared/video-timing'
import { inputFormatWhitelist } from '../../shared/media-policy'
import { indexVideo } from './video-timing'
import { atomicRename } from '../storage/atomic'

const sampleRate=48000,baseFrames=48,recordBytes=12,pyramidFactor=8
const levelSchema=z.object({file:z.string().regex(/^audio-\d+-level-\d+\.bin$/),framesPerBin:z.number().int().positive(),bins:z.number().int().nonnegative()}).strict()
const trackSchema=z.object({streamIndex:z.number().int().nonnegative(),channels:z.number().int().min(1).max(8),sampleFrames:z.number().int().nonnegative(),levels:z.array(levelSchema).min(1).max(12)}).strict()
const manifestSchema=z.object({format:z.literal('muxivra-media-analysis'),version:z.literal(1),mediaFile:z.string(),size:z.number().int().nonnegative(),mtimeMs:z.number().finite(),durationMs:z.number().finite().min(0).max(359999999),sampleRate:z.literal(sampleRate),audio:z.array(trackSchema).max(1024),video:z.boolean()}).strict().refine(value=>new Set(value.audio.map(track=>track.streamIndex)).size===value.audio.length&&value.audio.every(track=>track.sampleFrames<=Math.ceil(value.durationMs/1000*sampleRate)+sampleRate&&track.levels.every((level,index)=>level.file===`audio-${track.streamIndex}-level-${index}.bin`&&level.framesPerBin===baseFrames*pyramidFactor**index&&level.bins===Math.ceil(track.sampleFrames/level.framesPerBin))),'项目波形索引结构无效')
type Track=z.infer<typeof trackSchema>
type Manifest=z.infer<typeof manifestSchema>
type AnalysisProgress=(phase:string,percent:number)=>void
export interface ProjectAnalysisOptions { replace?:boolean;beforePublish?:()=>Promise<void> }
const cancelled=(signal?:AbortSignal)=>{if(signal?.aborted)throw new Error('项目预处理已取消')}
async function writeBytes(handle:FileHandle,buffer:Buffer,length=buffer.length){let offset=0;while(offset<length){const {bytesWritten}=await handle.write(buffer,offset,length-offset);if(!bytesWritten)throw new Error('项目波形缓存写入不完整');offset+=bytesWritten}}
async function readBytes(handle:FileHandle,buffer:Buffer,position:number){let offset=0;while(offset<buffer.length){const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,position+offset);if(!bytesRead)throw new Error('项目波形缓存读取不完整');offset+=bytesRead}}

/** Every imported track is decoded once. Signed extrema preserve short transients
 * and antiphase channels; RMS preserves energy. A 1 ms base layer plus 8x layers
 * lets later viewport reads remain bounded by the screen width, not movie length. */
async function buildAudio(engine:Engine,media:MediaInfo,index:number,channels:number,directory:string,signal:AbortSignal,progress:(value:number)=>void):Promise<Track>{
  cancelled(signal)
  const file=`audio-${index}-level-0.bin`,handle=await open(join(directory,file),'wx')
  const child=spawn(engine.ffmpegPath,['-v','error','-nostdin','-protocol_whitelist','file,pipe','-format_whitelist',inputFormatWhitelist,
    '-copyts','-start_at_zero','-i',media.path,'-map',`0:${index}`,'-vn','-sn','-dn','-t',String(media.durationMs/1000),'-ac',String(channels),
    '-af','aresample=48000:async=1:first_pts=0','-ar',String(sampleRate),'-f','f32le','pipe:1'],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']})
  let stderr='',failure:Error|undefined,sampleFrames=0,bins=0,lastProgress=0
  const closed=new Promise<number|null>(resolve=>{child.on('error',error=>{failure=error});child.on('close',resolve)})
  const abort=()=>{failure=new Error('项目预处理已取消');child.kill()}
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
  const timeout=setTimeout(()=>{failure=new Error('音频波形预处理超时');child.kill()},60*60000)
  child.stderr.on('data',(chunk:Buffer)=>{stderr=(stderr+chunk.toString()).slice(-4000)})
  let leftover=Buffer.alloc(0),minimum=0,maximum=0,squares=0,count=0,frames=0,block=Buffer.alloc(recordBytes*8192),used=0
  const emit=()=>{block.writeFloatLE(minimum,used);block.writeFloatLE(maximum,used+4);block.writeFloatLE(count?Math.sqrt(squares/count):0,used+8);used+=recordBytes;bins++;minimum=0;maximum=0;squares=0;count=0;frames=0}
  try{
    for await(const raw of child.stdout){
      cancelled(signal);const chunk=raw as Buffer,data=leftover.length?Buffer.concat([leftover,chunk]):chunk,frameBytes=channels*4,complete=data.length-data.length%frameBytes
      for(let i=0;i<complete;i+=frameBytes){
        for(let channel=0;channel<channels;channel++){const raw=data.readFloatLE(i+channel*4),value=Number.isFinite(raw)?Math.max(-1,Math.min(1,raw)):0;minimum=Math.min(minimum,value);maximum=Math.max(maximum,value);squares+=value*value;count++}
        frames++;sampleFrames++
        if(frames===baseFrames){emit();if(used===block.length){await writeBytes(handle,block,used);used=0}}
      }
      leftover=Buffer.from(data.subarray(complete))
      if(Date.now()-lastProgress>150){lastProgress=Date.now();progress(Math.min(99,sampleFrames/sampleRate*1000/Math.max(1,media.durationMs)*100))}
    }
    const code=await closed;if(failure||code!==0)throw failure??new Error(stderr||'音频波形预处理失败')
    if(leftover.length)throw new Error('音频波形预处理返回了不完整的采样帧')
    if(frames)emit();if(used)await writeBytes(handle,block,used);await handle.sync()
  }catch(error){child.kill();await closed;throw error}
  finally{clearTimeout(timeout);signal.removeEventListener('abort',abort);await handle.close()}
  const track:Track={streamIndex:index,channels,sampleFrames,levels:[{file,framesPerBin:baseFrames,bins}]}
  // Generate coarse levels with bounded buffers. Exact final-bin sample counts
  // weight RMS, so a padded tail does not dilute the last audible transient.
  while(track.levels.at(-1)!.bins>1024){
    cancelled(signal);const previous=track.levels.at(-1)!,next={file:`audio-${index}-level-${track.levels.length}.bin`,framesPerBin:previous.framesPerBin*pyramidFactor,bins:Math.ceil(previous.bins/pyramidFactor)}
    const input=await open(join(directory,previous.file),'r'),output=await open(join(directory,next.file),'wx'),buffer=Buffer.alloc(recordBytes*pyramidFactor*8192)
    let inputIndex=0
    try{
      while(inputIndex<previous.bins){
        cancelled(signal);const wanted=Math.min(buffer.length,(previous.bins-inputIndex)*recordBytes);await readBytes(input,buffer.subarray(0,wanted),inputIndex*recordBytes);const bytesRead=wanted
        const groupBins=bytesRead/recordBytes,dest=Buffer.alloc(Math.ceil(groupBins/pyramidFactor)*recordBytes);let offset=0
        for(let i=0;i<groupBins;i+=pyramidFactor){let min=0,max=0,sum=0,weight=0;for(let j=i;j<Math.min(groupBins,i+pyramidFactor);j++){const start=(inputIndex+j)*previous.framesPerBin,frames=Math.max(0,Math.min(previous.framesPerBin,sampleFrames-start)),rms=buffer.readFloatLE(j*recordBytes+8);min=Math.min(min,buffer.readFloatLE(j*recordBytes));max=Math.max(max,buffer.readFloatLE(j*recordBytes+4));sum+=rms*rms*frames;weight+=frames}dest.writeFloatLE(min,offset);dest.writeFloatLE(max,offset+4);dest.writeFloatLE(weight?Math.sqrt(sum/weight):0,offset+8);offset+=recordBytes}
        await writeBytes(output,dest);inputIndex+=groupBins
      }
      await output.sync()
    }finally{await input.close();await output.close()}
    track.levels.push(next)
  }
  progress(100);return track
}

/** Called before a new project's manifest is published or its original deleted. */
export async function prepareProjectAnalysis(engine:Engine,media:MediaInfo,directory:string,signal:AbortSignal,progress:AnalysisProgress,options:ProjectAnalysisOptions={}):Promise<void>{
  cancelled(signal)
  if(!Number.isFinite(media.durationMs)||media.durationMs<=0||media.durationMs>359999999)throw new Error('项目预处理需要时长有效且不超过 100 小时的媒体')
  const identity=await stat(media.path),staging=join(directory,`.analysis-${randomUUID()}`),target=join(directory,'analysis'),audio=media.streams.filter(stream=>stream.type==='audio'),video=media.streams.some(stream=>stream.type==='video'),steps=audio.length+(video?1:0)
  await mkdir(staging)
  let completed=0
  try{
    const tracks:Track[]=[]
    for(const stream of audio){const phase=`预处理音频波形 · 音轨 #${stream.index}`;progress(phase,completed/Math.max(1,steps)*100);tracks.push(await buildAudio(engine,media,stream.index,Math.max(1,Math.min(8,stream.channels??1)),staging,signal,value=>progress(phase,(completed+value/100)/Math.max(1,steps)*100)));completed++}
    if(video){const phase='建立视频帧索引';progress(phase,completed/steps*100);const timing=await indexVideo(engine,media,signal,value=>progress(phase,(completed+value/100)/steps*100));cancelled(signal);await writeFile(join(staging,'video-timing.json'),JSON.stringify(timing),{flag:'wx'});completed++}
    cancelled(signal)
    const current=await stat(media.path);if(current.size!==identity.size||current.mtimeMs!==identity.mtimeMs)throw new Error('项目媒体在预处理期间发生变化')
    const manifest=manifestSchema.parse({format:'muxivra-media-analysis',version:1,mediaFile:basename(media.path),size:identity.size,mtimeMs:identity.mtimeMs,durationMs:media.durationMs,sampleRate,audio:tracks,video})
    await writeFile(join(staging,'media.json'),JSON.stringify(manifest),{flag:'wx'});cancelled(signal)
    const validateParent=async()=>{await options.beforePublish?.();const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||(await realpath(directory)).toLowerCase()!==directory.toLowerCase())throw new Error('项目目录已变化，已停止发布预处理数据')}
    const validateChild=async(path:string)=>{await validateParent();const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||(await realpath(path)).toLowerCase()!==path.toLowerCase())throw new Error('项目预处理目录已变化，已停止操作')}
    const absent=async()=>{try{await lstat(target)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}throw new Error('预处理目标目录已变化，已停止覆盖')}
    let backup:string|undefined
    if(options.replace){
      const previous=await lstat(target).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error})
      if(previous){backup=join(directory,`.analysis-backup-${randomUUID()}`);await atomicRename(target,backup,()=>validateChild(target))}
    }
    try{
      await atomicRename(staging,target,async()=>{cancelled(signal);await validateChild(staging);await absent();cancelled(signal)})
    }catch(error){
      if(backup){try{await atomicRename(backup,target,async()=>{await validateChild(backup!);await absent()})}catch(restore){throw new Error(`预处理发布失败，旧数据保留在 ${backup}，请勿删除该目录`,{cause:new AggregateError([error,restore])})}}
      throw error
    }
    manifests.delete(join(target,'media.json'))
    if(backup){await (async()=>{await validateChild(backup);await rm(backup,{recursive:true,force:true})})().catch(()=>{})}
    progress('预处理完成',100)
  }catch(error){const info=await lstat(staging).catch(()=>undefined);if(info?.isDirectory()&&!info.isSymbolicLink())await rm(staging,{recursive:true,force:true});throw error}
}

const manifests=new Map<string,{identity:string;value:Manifest}>()
async function readManifest(directory:string,mediaPath:string):Promise<Manifest>{
  const analysis=join(directory,'analysis'),info=await lstat(analysis).catch(()=>undefined)
  if(!info?.isDirectory()||info.isSymbolicLink()||(await realpath(analysis)).toLowerCase()!==analysis.toLowerCase())throw new Error('项目缺少预处理数据，请前往项目管理的项目文件页重新预处理')
  const source=await stat(mediaPath),manifestPath=join(analysis,'media.json'),meta=await lstat(manifestPath).catch(()=>undefined)
  if(!meta?.isFile()||meta.isSymbolicLink()||meta.size>1024*1024)throw new Error('项目预处理清单不可用，请前往项目管理重新预处理')
  const identity=[source.size,source.mtimeMs,meta.size,meta.mtimeMs].join(':'),cached=manifests.get(manifestPath)
  if(cached?.identity===identity)return cached.value
  let manifest:Manifest
  try{manifest=manifestSchema.parse(JSON.parse(await readFile(manifestPath,'utf8')))}catch(error){throw new Error('项目预处理清单已损坏，请前往项目管理重新预处理',{cause:error})}
  if(manifest.mediaFile!==basename(mediaPath)||manifest.size!==source.size||manifest.mtimeMs!==source.mtimeMs)throw new Error('媒体与项目预处理数据不一致，请前往项目管理重新预处理')
  manifests.set(manifestPath,{identity,value:manifest});while(manifests.size>16)manifests.delete(manifests.keys().next().value!)
  return manifest
}

export async function readProjectWaveform(directory:string,mediaPath:string,input:Partial<WaveformRequest>={},signal?:AbortSignal):Promise<WaveformWindow>{
  cancelled(signal);const request=waveformRequestSchema.parse(input),manifest=await readManifest(directory,mediaPath),track=request.streamIndex==='no'?undefined:manifest.audio.find(track=>request.streamIndex===undefined||track.streamIndex===request.streamIndex)
  if(typeof request.streamIndex==='number'&&!track)throw new Error('Audio track does not exist')
  const result:WaveformWindow={...request,sampleRate,channels:track?.channels??1,hasAudio:!!track,minimum:[],maximum:[],rms:[]}
  if(!track||request.startMs>=manifest.durationMs)return result
  const minimum=new Array<number>(request.width).fill(0),maximum=minimum.slice(),rms=minimum.slice(),pixelFrames=request.durationMs/1000*sampleRate/request.width
  const level=[...track.levels].reverse().find(level=>level.framesPerBin<=pixelFrames)??track.levels[0],first=Math.max(0,Math.floor(request.startMs/1000*sampleRate/level.framesPerBin)),last=Math.min(level.bins,Math.ceil((request.startMs+request.durationMs)/1000*sampleRate/level.framesPerBin)),path=join(directory,'analysis',level.file),info=await lstat(path).catch(()=>undefined)
  if(!info?.isFile()||info.isSymbolicLink()||info.size!==level.bins*recordBytes)throw new Error('项目波形缓存不完整，请前往项目管理重新预处理')
  const buffer=Buffer.alloc(Math.max(0,last-first)*recordBytes),handle=await open(path,'r')
  try{await readBytes(handle,buffer,first*recordBytes)}finally{await handle.close()}
  cancelled(signal)
  for(let pixel=0;pixel<request.width;pixel++){
    const start=(request.startMs/1000*sampleRate+pixel*pixelFrames)/level.framesPerBin,end=start+pixelFrames/level.framesPerBin;let sum=0,weight=0
    for(let bin=Math.max(first,Math.floor(start));bin<Math.min(last,Math.ceil(end));bin++){
      const offset=(bin-first)*recordBytes,min=buffer.readFloatLE(offset),max=buffer.readFloatLE(offset+4),energy=buffer.readFloatLE(offset+8),overlap=Math.max(0,Math.min(end,bin+1,track.sampleFrames/level.framesPerBin)-Math.max(start,bin))
      if(![min,max,energy].every(Number.isFinite)||min< -1||min>0||max<0||max>1||energy<0||energy>1||min>max)throw new Error('项目波形缓存已损坏，请前往项目管理重新预处理')
      if(!overlap)continue
      minimum[pixel]=Math.min(minimum[pixel],min);maximum[pixel]=Math.max(maximum[pixel],max);sum+=energy*energy*overlap;weight+=overlap
    }
    rms[pixel]=weight?Math.sqrt(sum/weight):0
  }
  return {...result,minimum,maximum,rms}
}

export async function readProjectVideoTiming(directory:string,mediaPath:string,signal?:AbortSignal):Promise<VideoTiming>{
  cancelled(signal);const manifest=await readManifest(directory,mediaPath);if(!manifest.video)throw new Error('Media has no video stream')
  const path=join(directory,'analysis','video-timing.json'),info=await lstat(path).catch(()=>undefined)
  if(!info?.isFile()||info.isSymbolicLink()||info.size>80*1024*1024)throw new Error('项目视频帧索引不可用，请前往项目管理重新预处理')
  let timing:VideoTiming
  try{timing=videoTimingSchema.parse(JSON.parse(await readFile(path,'utf8')))}catch(error){throw new Error('项目视频帧索引已损坏，请前往项目管理重新预处理',{cause:error})}
  cancelled(signal);return timing
}
