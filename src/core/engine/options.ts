import type { Engine, TranscodeOptions } from '../../shared/types'
import type { AvOption, ComponentCapabilities } from '../../shared/parameters'
import { filterLibrary,internalEncoderParameters,x264InternalKeys } from '../../shared/parameters'
import { run } from './process'

const cache = new Map<string,Promise<ComponentCapabilities>>()
// File access, arbitrary encoder dictionaries and external execution are not component value controls.
const unsafe = /file|path|url|stats|log|params|opts|dictionary|shader|model|command|script|filename/i
export function parseComponentHelp(name:string,kind:ComponentCapabilities['kind'],text:string):ComponentCapabilities {
  const result:ComponentCapabilities={name,kind,description:text.split(/\r?\n/).slice(0,2).join(' ').trim(),options:[],pixelFormats:/Supported pixel formats:\s*([^\r\n]+)/.exec(text)?.[1].trim().split(/\s+/)??[]}
  let current:AvOption|undefined
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s{2,}-?([a-zA-Z0-9_-]+)\s+<([^>]+)>\s+[A-Z.]+\s*(.*)$/.exec(line)
    if (m) {
      const [,key,type,description]=m
      current=undefined
      if (unsafe.test(key)||unsafe.test(description)||!['int','int64','float','double','boolean','string','rational','flags','duration','pixel_fmt','sample_fmt','image_size','video_rate','color','channel_layout'].includes(type)) continue
      const range=/\(from ([\w.+-]+) to ([\w.+-]+)\)/.exec(description)
      const bound=(v?:string)=>v&&Number.isFinite(+v)?+v:undefined
      const existing=result.options.find(p=>p.type===type&&p.description===description)
      if(existing){existing.aliases=[...(existing.aliases??[]),key];continue}
      current={name:key,type,description,defaultValue:/\(default (.+)\)\s*$/.exec(description)?.[1].replace(/^"|"$/g,''),min:bound(range?.[1]),max:bound(range?.[2]),choices:[]}
      result.options.push(current)
    } else if (current) {
      const choice=/^\s{4,}([a-zA-Z0-9_.-]+)\s+(-?\d+)\s+[A-Z.]+\s*(.*)$/.exec(line)
      if(choice)current.choices.push({value:choice[1],label:choice[1]+(choice[3]?` · ${choice[3]}`:'')})
    }
  }
  return result
}
export async function componentCapabilities(engine:Engine,kind:ComponentCapabilities['kind'],name:string):Promise<ComponentCapabilities> {
  if(!/^[a-zA-Z0-9_]{1,80}$/.test(name))throw new Error('组件名称无效')
  const supported=kind==='filter'?engine.filters:engine.encoders
  if(!supported.includes(name)||(kind==='filter'&&!filterLibrary.some(f=>f.name===name)))throw new Error(`当前引擎不支持 ${name}`)
  if(kind!=='filter'&&engine.encoderKinds?.[name]&&(engine.encoderKinds[name]!== (kind==='videoEncoder'?'video':'audio')))throw new Error('编码器类型不匹配')
  const key=`${engine.id}:${kind}:${name}`
  if(!cache.has(key))cache.set(key,run(engine.ffmpegPath,['-hide_banner','-h',`${kind==='filter'?'filter':'encoder'}=${name}`]).then(text=>parseComponentHelp(name,kind,text)).catch(error=>{cache.delete(key);throw error}))
  return cache.get(key)!
}
export function validateAvValue(def:AvOption,value:string):void {
  if(['int','int64','float','double'].includes(def.type)) {
    if(def.choices.some(c=>c.value===value))return
    const n=Number(value)
    if(!Number.isFinite(n)||(['int','int64'].includes(def.type)&&!Number.isInteger(n))||(def.min!==undefined&&n<def.min)||(def.max!==undefined&&n>def.max))throw new Error(`${def.name} 的数值超出引擎支持范围`)
  } else if(def.type==='boolean'&&!['0','1','true','false','auto','-1'].includes(value))throw new Error(`${def.name} 需要布尔值`)
  else if(['rational','video_rate'].includes(def.type)&&!/^\d+(?:\.\d+|\/\d+)?$/.test(value))throw new Error(`${def.name} 需要帧率 / 比率`)
}
export async function validateComponentOptions(engine:Engine,options:TranscodeOptions):Promise<void> {
  const internal=Object.entries(options.codecParameters??{})
  if(internal.length&&!['libx264','libx265'].includes(options.video))throw new Error('内部参数仅适用于 x264 / x265')
  for(const [key,value] of internal) {
    const p=internalEncoderParameters.find(p=>p.key===key)
    if(!p||(options.video==='libx264'&&!x264InternalKeys.has(key)))throw new Error(`${options.video} 不支持内部参数 ${key}`)
    if(p.type==='number')validateAvValue({name:key,type:p.integer?'int':'float',description:'',min:p.min,max:p.max,choices:[]},value)
    else if(!p.choices?.includes(value))throw new Error(`内部参数 ${key} 值无效`)
    if(options.video==='libx264'&&key==='aq-mode'&&Number(value)>3)throw new Error('x264 aq-mode 最大为 3')
    if(options.video==='libx265'&&key==='subme'&&Number(value)>7)throw new Error('x265 subme 最大为 7')
  }
  if(!['copy','none'].includes(options.video)) {
    const caps=await componentCapabilities(engine,'videoEncoder',options.video),a=options.advanced??{}
    for(const key of ['profile','tune','gpu'])if(a[key]!==undefined&&!caps.options.some(p=>p.name===key))throw new Error(`${options.video} 不支持 ${key}`)
    const rc=String(a.rateControl??'auto'),flag=rc==='crf'?'crf':rc==='cq'?'cq':rc==='qp'?(options.video.endsWith('amf')?'qp_i':'qp'):undefined
    if(flag&&!caps.options.some(p=>p.name===flag))throw new Error(`${options.video} 不支持 ${rc}，请更换质量控制方式`)
  }
  for(const filter of options.filters??[]) {
    if(!filter.enabled)continue
    const caps=await componentCapabilities(engine,'filter',filter.name)
    const seenNames=new Set<string>()
    for(const [key,value] of Object.entries(filter.options)) {
      const def=caps.options.find(p=>p.name===key||p.aliases?.includes(key))
      if(!def)throw new Error(`${filter.name} 不支持参数 ${key}`)
      if(seenNames.has(def.name))throw new Error(`${filter.name} 参数 ${def.name} 与别名重复`)
      seenNames.add(def.name)
      validateAvValue(def,value)
    }
  }
  const seen=new Set<string>()
  for(const setting of options.encoderOptions??[]) {
    const key=`${setting.scope}:${setting.name}`
    if(seen.has(key))throw new Error(`编码器参数重复：${setting.name}`)
    seen.add(key)
    const encoder=setting.scope==='video'?options.video:options.audio
    const caps=await componentCapabilities(engine,setting.scope==='video'?'videoEncoder':'audioEncoder',encoder)
    const def=caps.options.find(p=>p.name===setting.name||p.aliases?.includes(setting.name))
    if(!def)throw new Error(`${encoder} 不支持参数 ${setting.name}`)
    validateAvValue(def,setting.value)
  }
  if(options.advanced?.pixelFormat&&options.video!=='copy'&&options.video!=='none') {
    const caps=await componentCapabilities(engine,'videoEncoder',options.video)
    if(caps.pixelFormats.length&&!caps.pixelFormats.includes(String(options.advanced.pixelFormat)))throw new Error(`${options.video} 不支持像素格式 ${options.advanced.pixelFormat}`)
  }
}
