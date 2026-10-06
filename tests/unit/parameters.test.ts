import { describe,it,expect } from 'vitest'
import { optionsSchema,presetFileSchema } from '../../src/shared/schema'
import { parseComponentHelp,validateAvValue } from '../../src/core/engine/options'
import { buildPlan } from '../../src/core/media/plan'
import { defaultOptions } from '../../src/core/presets'
import type { Engine,MediaInfo,TranscodeOptions } from '../../src/shared/types'
const engine:Engine={id:'test',ffmpegPath:'C:/engine/ffmpeg.exe',ffprobePath:'C:/engine/ffprobe.exe',version:'test',source:'local',encoders:['libx264','aac','png'],decoders:[],filters:['scale','crop','eq','volume'],detectedAt:''}
const media:MediaInfo={path:'C:/media/source.mp4',name:'source.mp4',durationMs:10000,size:100,format:'mp4',streams:[{index:0,type:'video',codec:'h264',width:320,height:180},{index:1,type:'audio',codec:'aac'}]}
describe('高级参数与引擎选项',()=>{
  it('旧参数仍可读取，拒绝未知项、越界数值与命令文本',()=>{
    expect(optionsSchema.parse(defaultOptions)).toEqual(defaultOptions)
    expect(()=>optionsSchema.parse({...defaultOptions,advanced:{unknown:1}})).toThrow()
    expect(()=>optionsSchema.parse({...defaultOptions,advanced:{brightness:12}})).toThrow()
    expect(()=>optionsSchema.parse({...defaultOptions,filters:[{id:'a',name:'movie',enabled:true,options:{}}]})).toThrow()
    expect(()=>optionsSchema.parse({...defaultOptions,encoderOptions:[{scope:'video',name:'x264-params',value:'stats=C:\\outside'}]})).toThrow()
  })
  it('解码选项位于输入前，剪辑、码率和输出参数位于输入后',()=>{
    const plan=buildPlan(engine,media,'C:/out/target.mp4',{...defaultOptions,advanced:{start:2,end:5,decodeThreads:3,encodeThreads:2,rateControl:'bitrate',videoBitrate:1200,maxrate:1600,bufsize:3200,metadata:'remove'}})
    expect(plan.args.indexOf('-threads')).toBeLessThan(plan.args.indexOf('-i'))
    expect(plan.args.indexOf('-threads:v')).toBeGreaterThan(plan.args.indexOf('-i'))
    expect(plan.args.slice(plan.args.indexOf('-t'),plan.args.indexOf('-t')+2)).toEqual(['-t','3'])
    expect(plan.args).toContain('1200k');expect(plan.args).not.toContain('-crf');expect(plan.durationMs).toBe(3000)
  })
  it('滤镜按用户顺序串联，复制轨道和无输出不能静默丢弃设置',()=>{
    const options:TranscodeOptions={...defaultOptions,filters:[{id:'a',name:'crop',enabled:true,options:{w:'200',h:'100'}},{id:'b',name:'eq',enabled:true,options:{brightness:'0.1'}}]}
    const plan=buildPlan(engine,media,'C:/out/target.mp4',options);const vf=plan.args[plan.args.indexOf('-vf')+1]
    expect(vf.indexOf('crop=')).toBeLessThan(vf.indexOf('eq='))
    expect(()=>buildPlan(engine,media,'C:/out/target.mp4',{...options,video:'copy'})).toThrow('复制视频')
    expect(()=>buildPlan(engine,media,'C:/out/target.mp4',{...options,video:'none'})).toThrow('没有视频')
    expect(()=>buildPlan(engine,media,'C:/out/target.mp4',{...defaultOptions,advanced:{start:5,end:2}})).toThrow('结束时间')
  })
  it('提取单张图像与指定尺寸不会混入音轨',()=>{
    const plan=buildPlan(engine,media,'C:/out/frame.png',{...defaultOptions,container:'png',video:'png',audio:'none',advanced:{width:160,height:90}})
    expect(plan.args).toContain('-frames:v');expect(plan.args).toContain('-an');expect(plan.args).toContain('image2')
  })
  it('从真实帮助格式解析枚举、范围、默认值，并排除文件访问参数',()=>{
    const caps=parseComponentHelp('test','videoEncoder',`Encoder test\n Supported pixel formats: yuv420p nv12\n  -rc <int> E..V....... Rate control (from 0 to 2) (default 1)\n     cbr 0 E..V....... Constant\n     vbr 1 E..V....... Variable\n  -strength <float> E..V....... Strength (from 0 to 1) (default 0.5)\n  -stats <string> E..V....... Filename for stats\n  -params <dictionary> E..V....... Private options\n`)
    expect(caps.pixelFormats).toEqual(['yuv420p','nv12']);expect(caps.options.map(p=>p.name)).toEqual(['rc','strength'])
    expect(caps.options[0].choices.map(p=>p.value)).toEqual(['cbr','vbr']);expect(caps.options[1]).toMatchObject({min:0,max:1,defaultValue:'0.5'})
    expect(()=>validateAvValue(caps.options[1],'2')).toThrow('范围');expect(()=>validateAvValue(caps.options[0],'vbr')).not.toThrow()
  })
  it('预设文件带格式与版本号且逐项严格验证',()=>{
    const file={format:'muxivra-presets',version:1,presets:[{id:'test',name:'test',description:'',options:{...defaultOptions,advanced:{gop:48}}}]}
    expect(presetFileSchema.parse(file).presets[0].options.advanced?.gop).toBe(48)
    expect(()=>presetFileSchema.parse({...file,version:2})).toThrow()
  })
})
