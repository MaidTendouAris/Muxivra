import { describe,it,expect } from 'vitest'
import { buildPlan } from '../../src/core/media/plan'
import { defaultOptions } from '../../src/core/presets'
import type { Engine,MediaInfo } from '../../src/shared/types'
const engine:Engine={id:'test',ffmpegPath:'C:\\engine\\ffmpeg.exe',ffprobePath:'C:\\engine\\ffprobe.exe',version:'test',source:'local',encoders:['libx264','libx265','aac','srt'],decoders:[],filters:['scale'],detectedAt:''}
const media:MediaInfo={path:'C:\\media\\a.mp4',name:'a.mp4',durationMs:10000,size:100,format:'mp4',streams:[{index:0,type:'video',codec:'h264',width:1920,height:1080},{index:1,type:'audio',codec:'aac'},{index:2,type:'subtitle',codec:'subrip'}]}
describe('共享参数生成',()=>{
  it('保持绝对路径为独立参数，限制分辨率且不放大',()=>{const plan=buildPlan(engine,media,'C:\\out\\a ; $().mp4',{...defaultOptions,maxHeight:720});expect(plan.args[plan.args.indexOf('-i')+1]).toBe(media.path);expect(plan.args.at(-1)).toBe('C:\\out\\a ; $().mp4');expect(plan.args).toContain('scale=w=-2:h=trunc(min(ih\\,720)/2)*2');expect(plan.args).toContain('-n')})
  it('拒绝覆盖原文件、不存在的轨道和不支持的编码器',()=>{expect(()=>buildPlan(engine,media,media.path,defaultOptions)).toThrow('原文件');expect(()=>buildPlan(engine,media,'C:\\out\\a.mp4',{...defaultOptions,streamIndices:[999]})).toThrow('轨道');expect(()=>buildPlan(engine,media,'C:\\out\\a.mp4',{...defaultOptions,video:'h264_nvenc'})).toThrow('编码器')})
  it('复制轨道时不生成编码与滤镜参数',()=>{const plan=buildPlan(engine,media,'C:\\out\\a.mkv',{...defaultOptions,container:'mkv',video:'copy',audio:'copy',subtitles:'copy'});expect(plan.args).not.toContain('-vf');expect(plan.args).not.toContain('-crf');expect(plan.args).toContain('-c:s')})
  it('拒绝音频容器的视频与音频编码不兼容组合',()=>{expect(()=>buildPlan(engine,media,'C:\\out\\a.mp3',{...defaultOptions,container:'mp3',video:'none'})).toThrow('MP3');expect(()=>buildPlan(engine,media,'C:\\out\\a.m4a',{...defaultOptions,container:'m4a'})).toThrow('关闭视频')})
  it('字幕提取选择恰好一条文本轨',()=>{const plan=buildPlan(engine,media,'C:\\out\\a.srt',{...defaultOptions,container:'srt',video:'none',audio:'none',subtitles:'copy',streamIndices:[2]});expect(plan.args).toContain('0:2');expect(plan.args).toContain('srt');expect(()=>buildPlan(engine,{...media,streams:[]},'C:\\out\\a.srt',{...defaultOptions,container:'srt'})).toThrow('一条')})
})
