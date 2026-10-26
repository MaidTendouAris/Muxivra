import { describe,it,expect,beforeAll,afterAll } from 'vitest'
import { mkdir,mkdtemp,readFile,writeFile,rm,stat } from 'node:fs/promises'
import { join,resolve,relative,isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { inspectMedia } from '../../src/core/media/probe'
import { makeWaveform } from '../../src/core/media/waveform'
import { indexVideo } from '../../src/core/media/video-timing'
import { AnalysisCache } from '../../src/core/media/analysis-cache'
import { videoTimingSchema,frameTime } from '../../src/shared/video-timing'
import type { Engine } from '../../src/shared/types'
const run=promisify(execFile),engine={ffmpegPath:'ffmpeg',ffprobePath:'ffprobe'} as Engine
let root:string,mediaPath:string
describe('subtitle analysis on real media',()=>{
  beforeAll(async()=>{await mkdir('.test-data',{recursive:true});root=await mkdtemp(resolve('.test-data','subtitle-analysis-'));mediaPath=join(root,'vfr-two-tracks.mkv');await run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=96x64:r=10:d=1','-f','lavfi','-i','aevalsrc=0:s=48000:d=2','-f','lavfi','-i','sine=frequency=4000:sample_rate=48000:duration=2','-filter:v',"setpts='round(if(lt(N,5),N/10,0.5+(N-5)/5)/TB)'",'-map','0:v','-map','1:a','-map','2:a','-c:v','libx264','-preset','ultrafast','-g','5','-sc_threshold','0','-fps_mode','vfr','-c:a','pcm_s16le',mediaPath],{windowsHide:true})})
  afterAll(async()=>{if(!root)return;const inside=relative(resolve('.test-data'),root);if(!inside||inside.startsWith('..')||isAbsolute(inside))throw new Error('Unsafe test cleanup');await rm(root,{recursive:true,force:true})})
  it('follows explicit audio stream indices, supports disabled audio, and rejects a nonexistent track',async()=>{const media=await inspectMedia(engine,mediaPath),silent=await makeWaveform(engine,media,{streamIndex:1,startMs:0,durationMs:1000,width:100}),tone=await makeWaveform(engine,media,{streamIndex:2,startMs:0,durationMs:1000,width:100});expect(silent.rms.every(v=>v===0)).toBe(true);expect(tone.rms.every(v=>v>.05)).toBe(true);expect(await makeWaveform(engine,media,{streamIndex:'no'})).toMatchObject({hasAudio:false,maximum:[]});await expect(makeWaveform(engine,media,{streamIndex:99})).rejects.toThrow('track')})
  it('indexes actual VFR PTS and keyframes with visible progress and an exclusive final boundary',async()=>{const media=await inspectMedia(engine,mediaPath),progress:number[]=[],timing=await indexVideo(engine,media,new AbortController().signal,value=>progress.push(value));expect(timing.timestampsMs).toEqual([0,100,200,300,400,500,700,900,1100,1300]);expect(timing.variable).toBe(true);expect(timing.keyframes).toEqual([0,5]);expect(frameTime(timing,7)).toBe(900);expect(timing.endMs).toBeGreaterThan(1300);expect(progress.at(-1)).toBe(100)})
  it('cancels frame indexing rather than returning a partial index',async()=>{const controller=new AbortController();controller.abort();await expect(indexVideo(engine,await inspectMedia(engine,mediaPath),controller.signal,()=>{})).rejects.toThrow('cancelled')})
  it('reuses durable validated analysis and invalidates changed media or request identities',async()=>{const cache=new AnalysisCache(join(root,'cache')),info=await stat(mediaPath),identity=[mediaPath,info.size,info.mtimeMs,2],key=cache.key(identity),timing=await indexVideo(engine,await inspectMedia(engine,mediaPath),new AbortController().signal,()=>{});await cache.write(key,timing);expect(await new AnalysisCache(cache.directory).read(key,value=>videoTimingSchema.parse(value))).toEqual(timing);expect(cache.key([...identity,1])).not.toBe(key);await writeFile(join(cache.directory,key+'.json'),'broken');expect(await cache.read(key,value=>videoTimingSchema.parse(value))).toBeUndefined();const reserved=join(cache.directory,'project.ass');await writeFile(reserved,'preserve');await cache.write(cache.key('new'),timing);expect(await readFile(reserved,'utf8')).toBe('preserve')})
})
