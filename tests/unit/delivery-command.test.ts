import { describe,it,expect } from 'vitest'
import { formatCommand,parseCommand } from '../../src/shared/delivery-command'
import { editedDeliveryArgs } from '../../src/core/media/delivery'
import { buildPlan } from '../../src/core/media/plan'
import { defaultOptions } from '../../src/core/presets'
import { optionsSchema } from '../../src/shared/schema'
import type { Engine,MediaInfo } from '../../src/shared/types'
const engine:Engine={id:'test',ffmpegPath:'D:\\tools\\ffmpeg.exe',ffprobePath:'D:\\tools\\ffprobe.exe',version:'test',source:'local',encoders:['libx264','aac'],decoders:[],filters:['scale','volume'],detectedAt:''}
const input:MediaInfo={path:'D:\\视频\\input file.mp4',name:'input file.mp4',durationMs:3000,size:100,format:'mp4',streams:[{index:0,type:'video',codec:'h264',width:320,height:180},{index:1,type:'audio',codec:'aac'}]}
const plan=()=>buildPlan(engine,input,'D:\\outputs\\out.mp4',defaultOptions)
describe('delivery command editing',()=>{
  it('round trips Unicode, Windows slashes, quotes, newlines and filter escapes without a shell',()=>{
    const args=['-i',input.path,'-metadata','lyrics=[00:00.5]hello\nsecond "line"','-vf','scale=w=-2:h=min(ih\\,1080)']
    expect(parseCommand(formatCommand(engine.ffmpegPath,args))).toEqual([engine.ffmpegPath,...args])
    expect(parseCommand('ffmpeg -c:v libx264')).toEqual(['ffmpeg','-c:v','libx264'])
  })
  it('executes changes to encoding and gain rather than silently regenerating them',()=>{
    const p=plan(),args=p.args.map((a,i)=>p.args[i-1]==='-crf'?'31':a)
    args.splice(-1,0,'-af','volume=2')
    expect(editedDeliveryArgs(p,formatCommand(engine.ffmpegPath,args))).toEqual(args)
  })
  it.each(['-y','-report','-filter_script','-attach','-filter_complex'])('rejects extra unmanaged file operations %s',flag=>{
    const p=plan(),args=[...p.args.slice(0,-1),flag,'elsewhere',p.outputPath]
    expect(()=>editedDeliveryArgs(p,formatCommand(engine.ffmpegPath,args))).toThrow()
  })
  it('pins granted inputs, managed protocols, progress and the single output',()=>{
    const p=plan(),command=formatCommand(engine.ffmpegPath,p.args)
    expect(editedDeliveryArgs(p,command)).toEqual(p.args)
    for(const args of [p.args.map(a=>a===input.path?'https://bad.invalid/in.mp4':a),p.args.slice(0,-1).concat('D:\\other.mp4'),p.args.filter(a=>!['-progress','pipe:1'].includes(a)),p.args.filter(a=>a!=='-n'),['-i',input.path,...p.args.slice(0,-1),p.outputPath]])expect(()=>editedDeliveryArgs(p,formatCommand(engine.ffmpegPath,args))).toThrow()
    expect(()=>editedDeliveryArgs(p,formatCommand('cmd.exe',p.args))).toThrow()
    expect(()=>editedDeliveryArgs(p,formatCommand(engine.ffmpegPath,p.args.map((arg,i)=>p.args[i-1]==='-f'?'hls':arg)))).toThrow()
  })
  it('blocks file-reading filters and accepts safe inline filters',()=>{
    const p=plan()
    for(const filter of ['movie=D:/secret.mp4','volume=2;amovie=x','libplacebo=custom_shader_path=x','scale=2:2,subtitles=secret.ass'])expect(()=>editedDeliveryArgs(p,formatCommand(engine.ffmpegPath,[...p.args.slice(0,-1),'-af',filter,p.outputPath]))).toThrow()
  })
  it('supports multiline lyrics without weakening ordinary metadata validation',()=>{
    const options={...defaultOptions,metadata:[{key:'lyrics',value:'[00:01.00]first\n[00:02.00]second'}]}
    expect(optionsSchema.parse(options).metadata).toEqual(options.metadata)
    const p=buildPlan(engine,input,'D:\\outputs\\out.mp4',options)
    expect(editedDeliveryArgs(p,formatCommand(engine.ffmpegPath,p.args))).toEqual(p.args)
    expect(()=>optionsSchema.parse({...options,metadata:[{key:'title',value:'bad\nvalue'}]})).toThrow()
  })
  it.each(['"unclosed','ffmpeg | other','"x"bad','"bad\\q"'])('rejects malformed command %s',command=>expect(()=>parseCommand(command)).toThrow())
})
