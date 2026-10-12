import { randomUUID } from 'node:crypto'
import type { Cue } from '../../shared/types'
import {
  assEventFormat,assStyleFormat,createSubtitleDocument,defaultSubtitleStyle,normalizeSubtitleDocument,parseAssColour,
  type NormalizedSubtitleDocument,type SubtitleDocument,type SubtitleFormat,type SubtitleStyle
} from '../../shared/subtitles'
import { formatTime,parseSrt } from './srt'

const ssaStyleFormat=['Name','Fontname','Fontsize','PrimaryColour','SecondaryColour','TertiaryColour','BackColour','Bold','Italic','BorderStyle','Outline','Shadow','Alignment','MarginL','MarginR','MarginV','AlphaLevel','Encoding']
const ssaEventFormat=['Marked','Start','End','Style','Name','MarginL','MarginR','MarginV','Effect','Text']
const knownStyleFields=new Set([...assStyleFormat,'TertiaryColour','AlphaLevel'].map(field=>field.toLowerCase()))
const knownEventFields=new Set([...assEventFormat,'Marked'].map(field=>field.toLowerCase()))
const ssaToAssAlignment:Record<number,number>={1:1,2:2,3:3,5:7,6:8,7:9,9:4,10:5,11:6}
const assToSsaAlignment:Record<number,number>={1:1,2:2,3:3,4:9,5:10,6:11,7:5,8:6,9:7}
const scalarFields:Record<string,keyof SubtitleStyle>={
  name:'name',fontname:'fontName',fontsize:'fontSize',primarycolour:'primaryColour',secondarycolour:'secondaryColour',outlinecolour:'outlineColour',backcolour:'backColour',
  bold:'bold',italic:'italic',underline:'underline',strikeout:'strikeOut',scalex:'scaleX',scaley:'scaleY',spacing:'spacing',angle:'angle',borderstyle:'borderStyle',outline:'outline',shadow:'shadow',alignment:'alignment',marginl:'marginL',marginr:'marginR',marginv:'marginV',encoding:'encoding'
}
function parseFields(text:string):string[] {
  const fields=text.split(',').map(field=>field.trim())
  if (!fields.length||fields.length>64||fields.some(field=>!/^[a-zA-Z][a-zA-Z0-9 _-]{0,79}$/.test(field))||new Set(fields.map(field=>field.toLowerCase())).size!==fields.length) throw new Error('ASS 字段格式无效或重复')
  return fields
}
function recordValues(text:string,format:string[],textField=false):Record<string,string> {
  const textIndex=textField?format.findIndex(field=>field.toLowerCase()==='text'):-1
  const parts=text.split(',')
  if(parts.length<format.length)throw new Error('ASS 记录字段数量不足')
  let values:string[]
  if(textIndex>=0)values=[...parts.slice(0,textIndex),parts.slice(textIndex,parts.length-(format.length-textIndex-1)).join(','),...(format.length-textIndex-1?parts.slice(-(format.length-textIndex-1)):[])]
  else {if(parts.length!==format.length)throw new Error('ASS 记录字段数量不正确');values=parts}
  return Object.fromEntries(format.map((field,index)=>[field.toLowerCase(),field.toLowerCase()==='text'?values[index]:values[index].trim()]))
}
function numberValue(value:string|undefined,fallback:number,label:string):number {
  if(value===undefined||value==='')return fallback
  if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)||!Number.isFinite(Number(value)))throw new Error(`ASS ${label}无效`)
  return Number(value)
}
export function parseAssTime(value:string):number {
  const match=/^(\d{1,3}):(\d{2}):(\d{2})\.(\d{1,3})$/.exec(value.trim())
  if(!match||Number(match[2])>59||Number(match[3])>59)throw new Error(`ASS 时间无效：${value}`)
  const result=((Number(match[1])*60+Number(match[2]))*60+Number(match[3]))*1000+Number(match[4].padEnd(3,'0'))
  if(!Number.isSafeInteger(result)||result>359999999)throw new Error('字幕时间超出范围')
  return result
}
export function formatAssTime(ms:number):string {
  if(!Number.isInteger(ms)||ms<0||ms>359999999)throw new Error('字幕时间超出范围')
  const centiseconds=Math.min(35999999,Math.round(ms/10))
  return `${Math.floor(centiseconds/360000)}:${String(Math.floor(centiseconds/6000)%60).padStart(2,'0')}:${String(Math.floor(centiseconds/100)%60).padStart(2,'0')}.${String(centiseconds%100).padStart(2,'0')}`
}
function parseStyle(record:Record<string,string>,format:string[],ssa:boolean):SubtitleStyle {
  const style=defaultSubtitleStyle()
  style.extra={}
  for(const field of format){
    const key=field.toLowerCase(),value=record[key],target=scalarFields[key]
    if(!knownStyleFields.has(key)){style.extra[field]=value;continue}
    if(!target){if(!ssa)style.extra[field]=value;continue}
    if(['bold','italic','underline','strikeout'].includes(key))(style as unknown as Record<string,unknown>)[target]=numberValue(value,0,field)!==0
    else if(key.endsWith('colour'))(style as unknown as Record<string,unknown>)[target]=`&H${parseAssColour(value)}`
    else if(target==='name'||target==='fontName')(style as unknown as Record<string,unknown>)[target]=value
    else (style as unknown as Record<string,unknown>)[target]=numberValue(value,style[target] as number,field)
  }
  if(ssa){
    if(record.tertiarycolour!==undefined)style.outlineColour=`&H${parseAssColour(record.tertiarycolour)}`
    style.alignment=ssaToAssAlignment[style.alignment]??style.alignment
    if(record.alphalevel!==undefined){
      const alpha=numberValue(record.alphalevel,0,'AlphaLevel')
      if(!Number.isInteger(alpha)||alpha<0||alpha>255)throw new Error('SSA AlphaLevel 超出范围')
      style.extra.AlphaLevel=String(alpha)
      if(alpha)for(const field of ['primaryColour','secondaryColour','outlineColour','backColour'] as const)style[field]=`&H${alpha.toString(16).padStart(2,'0').toUpperCase()}${parseAssColour(style[field]).slice(2)}`
    }
  }
  return style
}
/** Parses ASS/SSA into an ASS document; hard line breaks are actual editable newlines. */
export function parseAss(text:string,format?:'ass'|'ssa'):NormalizedSubtitleDocument {
  const document=createSubtitleDocument({styles:[],scriptInfo:{}})
  document.styles=[];document.scriptInfo={}
  let section='',styleFields:string[]|undefined,eventFields:string[]|undefined,ssa=format==='ssa',hasEvents=false
  const keep=(name:string,line:string)=>{(document.sectionLines[name]??=[]).push(line)}
  for(const [index,line] of text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').split('\n').entries()){
    const header=/^\s*\[([^\[\]]+)\]\s*$/.exec(line)
    if(header){section=header[1].trim();if(/^events$/i.test(section))hasEvents=true;if(/^v4 styles$/i.test(section))ssa=true;if(!/^(script info|v4\+? styles|events)$/i.test(section))document.sections.push({name:section,lines:[]});continue}
    try{
      if(/^script info$/i.test(section)){
        const entry=/^([^;!:][^:]*):\s?(.*)$/.exec(line)
        if(entry)document.scriptInfo[entry[1].trim()]=entry[2]
        else keep('Script Info',line)
      } else if(/^v4\+? styles$/i.test(section)){
        const entry=/^\s*(Format|Style)\s*:\s?(.*)$/i.exec(line)
        if(!entry){keep('V4+ Styles',line);continue}
        if(entry[1].toLowerCase()==='format'){styleFields=parseFields(entry[2]);document.styleFormat=ssa?[...assStyleFormat,...styleFields.filter(field=>!knownStyleFields.has(field.toLowerCase()))]:styleFields;continue}
        const fields=styleFields??(ssa?ssaStyleFormat:assStyleFormat)
        document.styles.push(parseStyle(recordValues(entry[2],fields),fields,ssa))
      } else if(/^events$/i.test(section)){
        const entry=/^\s*(Format|Dialogue|Comment)\s*:\s?(.*)$/i.exec(line)
        if(!entry){keep('Events',line);continue}
        if(entry[1].toLowerCase()==='format'){eventFields=parseFields(entry[2]);document.eventFormat=ssa?[...assEventFormat,...eventFields.filter(field=>!knownEventFields.has(field.toLowerCase()))]:eventFields;continue}
        const fields=eventFields??(ssa?ssaEventFormat:assEventFormat),record=recordValues(entry[2],fields,true)
        if(record.start===undefined||record.end===undefined||record.text===undefined)throw new Error('事件缺少 Start、End 或 Text 字段')
        const extra=Object.fromEntries(fields.filter(field=>!knownEventFields.has(field.toLowerCase())).map(field=>[field,record[field.toLowerCase()]]))
        if(record.marked!==undefined)extra.Marked=record.marked.replace(/^Marked=/i,'')
        document.cues.push({id:randomUUID(),startMs:parseAssTime(record.start),endMs:parseAssTime(record.end),text:record.text.replace(/\\N/g,'\n'),
          layer:numberValue(record.layer,0,'Layer'),style:record.style||'Default',name:record.name??'',marginL:numberValue(record.marginl,0,'MarginL'),marginR:numberValue(record.marginr,0,'MarginR'),marginV:numberValue(record.marginv,0,'MarginV'),effect:record.effect??'',comment:entry[1].toLowerCase()==='comment',extra})
      } else if(section)document.sections.at(-1)!.lines.push(line)
      else if(line.trim())keep('Script Info',line)
    }catch(error){throw new Error(`第 ${index+1} 行：${error instanceof Error?error.message:String(error)}`)}
  }
  if(!hasEvents)throw new Error('ASS/SSA 文件缺少 [Events] 章节，无法作为字幕工程打开。')
  // Serializer adds separators and a final newline; do not accumulate them on reopen.
  const trimBlankEdges=(lines:string[])=>{while(lines.length&&!lines[0].trim())lines.shift();while(lines.length&&!lines.at(-1)!.trim())lines.pop()}
  for(const section of document.sections)trimBlankEdges(section.lines)
  for(const lines of Object.values(document.sectionLines))trimBlankEdges(lines)
  document.exportFormat=format??(ssa?'ssa':'ass')
  return normalizeSubtitleDocument(document)
}
function decodeHtml(value:string):string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_,entity:string)=>{
    const named:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\\h'}
    if(entity.startsWith('#')){const code=Number.parseInt(entity.slice(entity[1].toLowerCase()==='x'?2:1),entity[1].toLowerCase()==='x'?16:10);return code>0&&code<=0x10ffff&&!(code>=0xd800&&code<=0xdfff)?String.fromCodePoint(code):''}
    return named[entity.toLowerCase()]
  })
}
export function srtTextToAss(value:string):string {
  const colours:string[]=[]
  const emphasis:Record<string,number>={i:0,b:0,u:0,s:0}
  const colourTag=(hex:string)=>`{\\c&H${hex.slice(5,7)}${hex.slice(3,5)}${hex.slice(1,3)}&}`
  const tagged=value.replace(/<\s*(\/?)\s*(i|b|u|s|font|br)\b([^>]*)>/gi,(original,close:string,tag:string,attributes:string)=>{
    tag=tag.toLowerCase()
    if(tag==='br')return '\n'
    if(tag!=='font'){emphasis[tag]=Math.max(0,emphasis[tag]+(close?-1:1));return `{\\${tag}${emphasis[tag]>0?'1':'0'}}`}
    if(close){if(!colours.length)return '';colours.pop();return colours.at(-1)?colourTag(colours.at(-1)!):'{\\c}'}
    const colour=/\bcolor\s*=\s*["']?(#[a-f0-9]{6}|#[a-f0-9]{3}|[a-z]+)["']?/i.exec(attributes)?.[1]
    const named:Record<string,string>={white:'#FFFFFF',black:'#000000',red:'#FF0000',green:'#008000',blue:'#0000FF',yellow:'#FFFF00',cyan:'#00FFFF',aqua:'#00FFFF',magenta:'#FF00FF',fuchsia:'#FF00FF',orange:'#FFA500',lime:'#00FF00',gray:'#808080',grey:'#808080',silver:'#C0C0C0',maroon:'#800000',purple:'#800080',olive:'#808000',teal:'#008080',navy:'#000080'}
    const hex=colour?.startsWith('#')?(colour.length===4?`#${colour.slice(1).split('').map(value=>value+value).join('')}`:colour):named[colour?.toLowerCase()??'']
    colours.push(hex??colours.at(-1)??'')
    return hex?colourTag(hex):''
  })
  return decodeHtml(tagged)
}
export function parseSubtitleText(text:string,format:SubtitleFormat):NormalizedSubtitleDocument {
  if(format!=='srt')return parseAss(text,format)
  return createSubtitleDocument({exportFormat:'srt',cues:parseSrt(text).map(cue=>({...cue,text:srtTextToAss(cue.text)}))})
}
function extraValue(extra:Record<string,string>|undefined,field:string):string {
  return Object.entries(extra??{}).find(([key])=>key.toLowerCase()===field.toLowerCase())?.[1]??''
}
function styleValues(style:SubtitleStyle,fields:string[],ssa:boolean):string[] {
  return fields.map(field=>{
    const key=field.toLowerCase(),target=scalarFields[key]
    if(ssa&&key==='tertiarycolour')return String(Number.parseInt(parseAssColour(style.outlineColour).slice(2),16))
    if(ssa&&key==='alphalevel')return String(Number.parseInt(parseAssColour(style.primaryColour).slice(0,2),16))
    if(!target)return extraValue(style.extra,field)
    const value=style[target]
    if(typeof value==='boolean')return value?'-1':'0'
    if(key.endsWith('colour'))return ssa?String(Number.parseInt(parseAssColour(String(value)).slice(2),16)):`&H${parseAssColour(String(value))}`
    if(ssa&&key==='alignment')return String(assToSsaAlignment[style.alignment]??style.alignment)
    return String(value)
  })
}
function cueValues(cue:Cue,fields:string[],ssa:boolean):string[] {
  const record:Record<string,string>={layer:String(cue.layer??0),marked:`Marked=${extraValue(cue.extra,'Marked')||'0'}`,start:formatAssTime(cue.startMs),end:formatAssTime(cue.endMs),style:cue.style??'Default',name:cue.name??'',marginl:String(cue.marginL??0).padStart(4,'0'),marginr:String(cue.marginR??0).padStart(4,'0'),marginv:String(cue.marginV??0).padStart(4,'0'),effect:cue.effect??'',text:cue.text.replace(/\r\n?/g,'\n').replace(/\n/g,'\\N')}
  return fields.map(field=>record[field.toLowerCase()]??extraValue(cue.extra,field))
}
function serialize(document:SubtitleDocument,ssa:boolean):string {
  const normalized=normalizeSubtitleDocument(document)
  const styleFields=ssa?[...ssaStyleFormat,...normalized.styleFormat.filter(field=>!knownStyleFields.has(field.toLowerCase()))]:normalized.styleFormat
  const eventFields=ssa?[...ssaEventFormat,...normalized.eventFormat.filter(field=>!knownEventFields.has(field.toLowerCase()))]:normalized.eventFormat
  const info={...normalized.scriptInfo,ScriptType:ssa?'v4.00':'v4.00+'}
  const lines=['[Script Info]',...Object.entries(info).map(([key,value])=>`${key}: ${value}`),...(normalized.sectionLines['Script Info']??[]),'',ssa?'[V4 Styles]':'[V4+ Styles]',`Format: ${styleFields.join(', ')}`,
    ...normalized.styles.map(style=>`Style: ${styleValues(style,styleFields,ssa).join(',')}`),...(normalized.sectionLines['V4+ Styles']??[]),'','[Events]',`Format: ${eventFields.join(', ')}`,
    ...normalized.cues.map(cue=>`${cue.comment?'Comment':'Dialogue'}: ${cueValues(cue,eventFields,ssa).join(',')}`),...(normalized.sectionLines.Events??[])]
  for(const section of normalized.sections)lines.push('',`[${section.name}]`,...section.lines)
  return lines.join('\r\n')+'\r\n'
}
export function serializeAss(document:SubtitleDocument):string{return serialize(document,false)}
export function serializeSsa(document:SubtitleDocument):string{return serialize(document,true)}
/** Strips ASS overrides while omitting drawing text, including mixed drawing/text events. */
export function assTextToPlain(text:string):string {
  let drawing=false,result='',cursor=0
  const regex=/\{[^}]*\}/g
  for(const match of text.matchAll(regex)){
    if(!drawing)result+=text.slice(cursor,match.index)
    for(const tag of match[0].matchAll(/\\p(-?\d+)(?![\dA-Za-z])/g))drawing=Number(tag[1])>0
    cursor=match.index!+match[0].length
  }
  if(!drawing)result+=text.slice(cursor)
  return result.replace(/\\[Nn]/g,'\n').replace(/\\h/g,'\u00a0').replace(/\r\n?/g,'\n')
}
function srtCues(document:NormalizedSubtitleDocument):Cue[] {
  return document.cues.filter(cue=>!cue.comment).map(cue=>({...cue,text:assTextToPlain(cue.text).replace(/\n\s*\n/g,'\n').trim()})).filter(cue=>cue.text.length>0)
}
export function subtitleExportLosses(document:SubtitleDocument,format:SubtitleFormat):string[] {
  const doc=normalizeSubtitleDocument(document),losses:string[]=[]
  if(format!=='srt'){
    if(doc.cues.some(cue=>cue.startMs%10||cue.endMs%10))losses.push('ASS/SSA 时间以 10 毫秒保存，毫秒尾数会舍入；工程缓存保留原精度。')
    if(format==='ssa'){
      if(doc.cues.some(cue=>cue.layer))losses.push('SSA 不支持 ASS 的图层，导出后图层顺序可能改变。')
      if(doc.styles.some(style=>style.underline||style.strikeOut||style.scaleX!==100||style.scaleY!==100||style.spacing||style.angle))losses.push('SSA 不支持部分 ASS 样式属性：下划线、删除线、缩放、字间距和旋转。')
      if(doc.styles.some(style=>new Set([style.primaryColour,style.secondaryColour,style.outlineColour,style.backColour].map(colour=>parseAssColour(colour).slice(0,2))).size>1))losses.push('SSA 仅有统一的 AlphaLevel，各颜色的独立透明度会统一为主色透明度。')
      if(doc.cues.some(cue=>/\{[^}]*\\(?:t|clip|iclip|move|pos|org|fad|fade|p\d|an\d|[1-4]?[ac]|fsc[xy]|fr[xyz]|bord|shad)\b[^}]*\}/i.test(cue.text)))losses.push('ASS 专有覆盖标签会原样保留，但 SSA 播放器可能不支持其排版或特效。')
    }
    return losses
  }
  if(doc.cues.some(cue=>cue.comment))losses.push('SRT 不保存注释条目。')
  if(doc.cues.some(cue=>/\{[^}]*\}/.test(cue.text)))losses.push('SRT 将移除 ASS 覆盖标签；局部字体、颜色、定位、动画和特效会丢失。')
  if(doc.cues.some(cue=>/\{[^}]*\\p[1-9]\d*/.test(cue.text)))losses.push('SRT 将移除矢量绘图，仅保留可显示的文字。')
  if(doc.styles.length>1||doc.cues.some(cue=>(cue.style??'Default')!=='Default')||doc.styles.some(style=>JSON.stringify({...style,extra:{}})!==JSON.stringify(defaultSubtitleStyle({name:style.name}))))losses.push('SRT 不保存样式表、字体、颜色、边框或对齐方式。')
  if(doc.cues.some(cue=>cue.layer||cue.name||cue.marginL||cue.marginR||cue.marginV||cue.effect||Object.keys(cue.extra??{}).length))losses.push('SRT 不保存图层、角色、边距、效果或事件扩展字段。')
  if(doc.sections.length||Object.keys(doc.scriptInfo).some(key=>!['ScriptType','PlayResX','PlayResY','WrapStyle','ScaledBorderAndShadow','YCbCr Matrix'].includes(key)))losses.push('SRT 不保存脚本信息或附加章节。')
  if(doc.cues.some(cue=>!cue.comment&&!assTextToPlain(cue.text).trim()))losses.push('SRT 将跳过空文本或仅含绘图的条目。')
  if(doc.cues.some(cue=>/\n\s*\n/.test(assTextToPlain(cue.text))))losses.push('SRT 条目内的空行会合并，避免被识别为新的条目。')
  return losses
}
export function exportSubtitleText(document:SubtitleDocument,format:SubtitleFormat):string {
  if(format==='ass')return serializeAss(document)
  if(format==='ssa')return serializeSsa(document)
  const cues=srtCues(normalizeSubtitleDocument(document))
  if(cues.some(cue=>cue.endMs<=cue.startMs))throw new Error('导出 SRT 前，请修正结束时间不晚于开始时间的条目。')
  return cues.map((cue,index)=>`${index+1}\r\n${formatTime(cue.startMs)} --> ${formatTime(cue.endMs)}\r\n${cue.text.replace(/\n/g,'\r\n')}`).join('\r\n\r\n')+(cues.length?'\r\n':'')
}
