/** The editable document is always ASS. Export formats do not change this model. */
export type SubtitleFormat = 'ass' | 'ssa' | 'srt'
export type SubtitleExportFormat = SubtitleFormat
export interface Cue {
  id: string; startMs: number; endMs: number; text: string
  layer?: number; style?: string; name?: string
  marginL?: number; marginR?: number; marginV?: number
  effect?: string; comment?: boolean; extra?: Record<string, string>
}
export interface SubtitleStyle {
  name: string; fontName: string; fontSize: number
  primaryColour: string; secondaryColour: string; outlineColour: string; backColour: string
  bold: boolean; italic: boolean; underline: boolean; strikeOut: boolean
  scaleX: number; scaleY: number; spacing: number; angle: number
  borderStyle: number; outline: number; shadow: number; alignment: number
  marginL: number; marginR: number; marginV: number; encoding: number
  extra?: Record<string, string>
}
export interface SubtitleSection { name: string; lines: string[] }
export interface SubtitleDocument {
  id: string; sourcePath?: string; cues: Cue[]
  version?: 2; format?: 'ass'; mediaPath?: string; projectPath?: string
  exportFormat?: SubtitleFormat; scriptInfo?: Record<string, string>; styles?: SubtitleStyle[]
  eventFormat?: string[]; styleFormat?: string[]; sections?: SubtitleSection[]
  /** Non-record lines in known sections, e.g. comments, retained on save. */
  sectionLines?: Record<string, string[]>
}
export interface NormalizedSubtitleDocument extends SubtitleDocument {
  version: 2; format: 'ass'; exportFormat: SubtitleFormat
  scriptInfo: Record<string, string>; styles: SubtitleStyle[]
  eventFormat: string[]; styleFormat: string[]; sections: SubtitleSection[]
  sectionLines: Record<string, string[]>
}
export const assEventFormat = ['Layer','Start','End','Style','Name','MarginL','MarginR','MarginV','Effect','Text']
export const assStyleFormat = ['Name','Fontname','Fontsize','PrimaryColour','SecondaryColour','OutlineColour','BackColour','Bold','Italic','Underline','StrikeOut','ScaleX','ScaleY','Spacing','Angle','BorderStyle','Outline','Shadow','Alignment','MarginL','MarginR','MarginV','Encoding']
export const defaultScriptInfo: Record<string,string> = {
  ScriptType:'v4.00+', PlayResX:'1920', PlayResY:'1080', WrapStyle:'0', ScaledBorderAndShadow:'yes', 'YCbCr Matrix':'TV.709'
}
export function defaultSubtitleStyle(overrides: Partial<SubtitleStyle> = {}): SubtitleStyle {
  return {
    name:'Default',fontName:'Arial',fontSize:48,primaryColour:'&H00FFFFFF',secondaryColour:'&H000000FF',
    outlineColour:'&H00000000',backColour:'&H80000000',bold:false,italic:false,underline:false,strikeOut:false,
    scaleX:100,scaleY:100,spacing:0,angle:0,borderStyle:1,outline:2,shadow:0,alignment:2,
    marginL:20,marginR:20,marginV:30,encoding:1,...overrides,extra:{...overrides.extra}
  }
}
function safeLine(value: string, label: string, comma = false) {
  if (typeof value !== 'string' || value.length>10000 || /[\x00-\x1f]/.test(value) || (comma && value.includes(','))) throw new Error(`${label}过长或含不支持的控制字符或分隔符`)
}
function completeFormat(format: string[] | undefined, required: string[]) {
  const result = [...(format ?? required)]
  const seen = new Set<string>()
  for (const field of result) {
    if (!/^[a-zA-Z][a-zA-Z0-9 _-]{0,79}$/.test(field) || seen.has(field.toLowerCase())) throw new Error('字幕字段格式无效或重复')
    seen.add(field.toLowerCase())
  }
  // Text stays last so commas in subtitle text are unambiguous.
  for (const field of required) if (!seen.has(field.toLowerCase())) result.push(field)
  if(result.length>64)throw new Error('字幕扩展字段数量超过 64 项')
  if (required === assEventFormat) return [...result.filter(field=>field.toLowerCase()!=='text'),result.find(field=>field.toLowerCase()==='text')!]
  return result
}
/** Upgrades the former SRT session shape without dropping IDs or millisecond timing. */
export function normalizeSubtitleDocument(input: SubtitleDocument): NormalizedSubtitleDocument {
  if (!input || typeof input.id !== 'string' || !input.id || !Array.isArray(input.cues)) throw new Error('字幕文档无效')
  if(input.cues.length>100000||(input.styles?.length??0)>1000||(input.sections?.length??0)>100)throw new Error('字幕条目、样式或章节数量超出范围')
  if(input.exportFormat!==undefined&&!['ass','ssa','srt'].includes(input.exportFormat))throw new Error('字幕导出格式无效')
  const cues = input.cues.map(cue => {
    if (!cue.id || ![cue.startMs,cue.endMs].every(value=>Number.isInteger(value)&&value>=0&&value<=359999999)) throw new Error('字幕时间超出范围')
    if (typeof cue.text!=='string' || /\x00/.test(cue.text)) throw new Error('字幕文本无效')
    if(cue.text.length>10000)throw new Error('单条字幕文本过长')
    for(const field of ['layer','marginL','marginR','marginV'] as const)if(cue[field]!==undefined&&(!Number.isInteger(cue[field])||cue[field]!<0||cue[field]!>(field==='layer'?2147483647:999999)))throw new Error('字幕图层或边距超出范围')
    if(cue.comment!==undefined&&typeof cue.comment!=='boolean')throw new Error('字幕注释状态无效')
    for (const [key,value] of Object.entries(cue.extra??{})) { safeLine(key,'事件字段',true); safeLine(value,'事件字段值',true) }
    for (const key of ['style','name','effect'] as const) safeLine(cue[key]??'','字幕属性',true)
    return {layer:0,style:'Default',name:'',marginL:0,marginR:0,marginV:0,effect:'',comment:false,...cue,text:cue.text.replace(/\r\n?/g,'\n'),extra:{...cue.extra}}
  })
  if (new Set(cues.map(cue=>cue.id)).size!==cues.length) throw new Error('字幕标识重复')
  const styles = (input.styles??[]).map(style=>defaultSubtitleStyle(style))
  for (const style of styles) {
    safeLine(style.name,'样式名称',true); safeLine(style.fontName,'字体名称',true)
    if (!style.name) throw new Error('样式名称为空')
    for(const field of ['primaryColour','secondaryColour','outlineColour','backColour'] as const)style[field]=`&H${parseAssColour(style[field])}`
    for(const field of ['bold','italic','underline','strikeOut'] as const)if(typeof style[field]!=='boolean')throw new Error('样式文字属性无效')
    for(const field of ['fontSize','scaleX','scaleY'] as const)if(!Number.isFinite(style[field])||style[field]<=0||style[field]>10000)throw new Error('样式尺寸超出范围')
    for(const field of ['outline','shadow','spacing','angle'] as const)if(!Number.isFinite(style[field])||Math.abs(style[field])>(field==='angle'?36000:10000)||(field!=='spacing'&&field!=='angle'&&style[field]<0))throw new Error('样式参数超出范围')
    if(![1,3].includes(style.borderStyle)||!Number.isInteger(style.alignment)||style.alignment<1||style.alignment>9)throw new Error('样式边框或对齐方式无效')
    for(const field of ['marginL','marginR','marginV','encoding'] as const)if(!Number.isInteger(style[field])||style[field]<0||style[field]>(field==='encoding'?255:999999))throw new Error('样式边距或编码超出范围')
    for (const [key,value] of Object.entries(style.extra??{})) { safeLine(key,'样式字段',true); safeLine(value,'样式字段值',true) }
  }
  if (!styles.some(style=>style.name==='Default')) styles.unshift(defaultSubtitleStyle())
  if(styles.length>1000)throw new Error('字幕样式数量超出范围')
  if (new Set(styles.map(style=>style.name)).size!==styles.length) throw new Error('样式名称重复')
  const scriptKeys=new Map([...Object.keys(defaultScriptInfo),'Title','Original Script','Original Translation','Original Editing','Original Timing','Synch Point','Script Updated By','Update Details','Collisions','Timer'].map(key=>[key.toLowerCase(),key]))
  const importedInfo=Object.fromEntries(Object.entries(input.scriptInfo??{}).map(([key,value])=>[scriptKeys.get(key.trim().toLowerCase())??key.trim(),value]))
  const scriptInfo = {...defaultScriptInfo,...importedInfo,ScriptType:'v4.00+'}
  if(Object.keys(scriptInfo).length>1000)throw new Error('脚本信息数量超出范围')
  for (const [key,value] of Object.entries(scriptInfo)) { safeLine(key,'脚本信息键'); safeLine(value,'脚本信息值'); if (!key||key.includes(':')) throw new Error('脚本信息键为空或含分隔符') }
  const sections = (input.sections??[]).map(section=>({name:section.name.trim(),lines:[...section.lines]}))
  for (const section of sections) {
    safeLine(section.name,'章节名称'); if(/[\[\]]/.test(section.name)||!section.name) throw new Error('章节名称无效')
    if (/^(script info|v4\+? styles|events)$/i.test(section.name)) throw new Error('原始章节不能重复字幕主章节')
    for (const line of section.lines) { safeLine(line,'章节内容'); if(/^\s*\[[^\[\]]+\]\s*$/.test(line)) throw new Error('章节内容含嵌套章节') }
  }
  const sectionLines = Object.fromEntries(Object.entries(input.sectionLines??{}).map(([name,lines])=>{
    if(!['Script Info','V4+ Styles','Events'].includes(name)) throw new Error('未知的字幕主章节')
    for (const line of lines) {safeLine(line,'章节内容');if(/^\s*\[[^\[\]]+\]\s*$/.test(line)||/^\s*(?:Format|Style|Dialogue|Comment)\s*:/i.test(line))throw new Error('主章节原始内容含结构记录')}
    return [name,[...lines]]
  }))
  const eventFormat=completeFormat(input.eventFormat,assEventFormat),styleFormat=completeFormat(input.styleFormat,assStyleFormat)
  for(const cue of cues)for(const field of Object.keys(cue.extra))if(!eventFormat.some(value=>value.toLowerCase()===field.toLowerCase()))eventFormat.splice(eventFormat.length-1,0,field)
  for(const style of styles)for(const field of Object.keys(style.extra??{}))if(!styleFormat.some(value=>value.toLowerCase()===field.toLowerCase()))styleFormat.push(field)
  return {...input,version:2,format:'ass',exportFormat:input.exportFormat??'ass',cues,scriptInfo,styles,eventFormat:completeFormat(eventFormat,assEventFormat),styleFormat:completeFormat(styleFormat,assStyleFormat),sections,sectionLines}
}
export function createSubtitleDocument(overrides: Partial<SubtitleDocument> = {}): NormalizedSubtitleDocument {
  return normalizeSubtitleDocument({id:crypto.randomUUID(),cues:[],...overrides})
}
export function assColourToHex(value: string): string {
  const colour = parseAssColour(value)
  return `#${colour.slice(6,8)}${colour.slice(4,6)}${colour.slice(2,4)}`
}
export function parseAssColour(value: string): string {
  const cleaned = value.trim()
  if (/^&H[a-f0-9]{1,8}&?$/i.test(cleaned)) return cleaned.replace(/^&H/i,'').replace(/&$/,'').padStart(8,'0').toUpperCase()
  if (/^-?\d+$/.test(cleaned)) { const number=Number(cleaned); if(Number.isSafeInteger(number)&&number>=-2147483648&&number<=4294967295)return (number>>>0).toString(16).padStart(8,'0').toUpperCase() }
  throw new Error(`ASS 颜色无效：${value}`)
}
export function hexToAssColour(value: string, alpha = 0): string {
  if(!/^#[a-f0-9]{6}$/i.test(value)||!Number.isInteger(alpha)||alpha<0||alpha>255)throw new Error('颜色无效')
  return `&H${alpha.toString(16).padStart(2,'0')}${value.slice(5,7)}${value.slice(3,5)}${value.slice(1,3)}`.toUpperCase()
}
