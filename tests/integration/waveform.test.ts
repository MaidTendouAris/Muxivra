import { describe,it,expect,beforeAll,afterAll } from 'vitest'
import { mkdir,mkdtemp,rm } from 'node:fs/promises'
import { join,resolve,relative,isAbsolute,sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { makeWaveform } from '../../src/core/media/waveform'
import { inspectMedia } from '../../src/core/media/probe'
import type { Engine } from '../../src/shared/types'
const run=promisify(execFile),engine={ffmpegPath:'ffmpeg',ffprobePath:'ffprobe'} as Engine
let root:string,stereo:string,delayed:string,silent:string
describe('High-resolution audio waveform',()=>{
  beforeAll(async()=>{
    await mkdir('.test-data',{recursive:true});root=await mkdtemp(resolve('.test-data','waveform-'));stereo=join(root,'stereo.wav');delayed=join(root,'delayed.mkv');silent=join(root,'no-audio.mp4')
    await run('ffmpeg',['-v','error','-f','lavfi','-i','aevalsrc=0.8*sin(2*PI*8000*t)|-0.8*sin(2*PI*8000*t):s=48000:d=2','-c:a','pcm_f32le',stereo],{windowsHide:true})
    await run('ffmpeg',['-v','error','-f','lavfi','-i','color=size=64x64:rate=10:duration=4','-itsoffset','1','-f','lavfi','-i','sine=frequency=8000:sample_rate=48000:duration=2','-map','0:v','-map','1:a','-c:v','mpeg4','-c:a','pcm_s16le',delayed],{windowsHide:true})
    await run('ffmpeg',['-v','error','-f','lavfi','-i','color=size=64x64:rate=10:duration=1','-c:v','mpeg4',silent],{windowsHide:true})
  })
  afterAll(async()=>{if(!root)return;const inside=relative(resolve('.test-data'),root);if(!inside||inside==='..'||inside.startsWith(`..${sep}`)||isAbsolute(inside))throw new Error('Unsafe cleanup path');await rm(root,{recursive:true,force:true})})
  it('retains 8 kHz detail and anti-phase stereo with signed extrema and RMS',async()=>{
    const media=await inspectMedia(engine,stereo),wave=await makeWaveform(engine,media,{startMs:250,durationMs:1000,width:500})
    expect(wave).toMatchObject({sampleRate:48000,channels:2,startMs:250,durationMs:1000,width:500})
    expect(wave.maximum.filter(value=>value>.6).length).toBe(500)
    expect(Math.min(...wave.minimum)).toBeLessThan(-.6)
    expect(wave.rms.every(value=>value>.5&&value<.6)).toBe(true)
  })
  it('preserves delayed audio at zero and after a nonzero viewport seek',async()=>{
    const media=await inspectMedia(engine,delayed),first=await makeWaveform(engine,media,{startMs:0,durationMs:2000,width:200}),seek=await makeWaveform(engine,media,{startMs:800,durationMs:1000,width:100})
    expect(first.maximum.slice(0,95).every(value=>value===0)).toBe(true)
    expect(first.maximum.slice(105).every(value=>value>.05)).toBe(true)
    expect(seek.maximum.slice(0,18).every(value=>value===0)).toBe(true)
    expect(seek.maximum.slice(23).every(value=>value>.05)).toBe(true)
  })
  it('pads the viewport tail and reports media without audio',async()=>{
    const wave=await makeWaveform(engine,await inspectMedia(engine,stereo),{startMs:1500,durationMs:1000,width:100})
    expect(wave.maximum.slice(0,48).every(value=>value>.6)).toBe(true)
    expect(wave.maximum.slice(52).every(value=>value===0)).toBe(true)
    expect(await makeWaveform(engine,await inspectMedia(engine,silent))).toMatchObject({hasAudio:false,maximum:[],minimum:[],rms:[]})
  })
  it('rejects cancellation before spawning a decoder',async()=>{
    const controller=new AbortController();controller.abort()
    await expect(makeWaveform(engine,await inspectMedia(engine,stereo),{},controller.signal)).rejects.toThrow('已取消')
  })
})
