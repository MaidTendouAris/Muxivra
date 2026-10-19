import { tr } from './i18n'
import type { Cue, SubtitleDocument } from '../../shared/types'

export type SubtitleIssue = { id:string; row:number; message:string; kind:'error'|'warning' }
export function subtitleIssues(document:SubtitleDocument):SubtitleIssue[] {
  const styles=new Set(document.styles?.map(style=>style.name)??['Default'])
  const issues:SubtitleIssue[]=[]
  let previous:Cue|undefined
  for(const [index,cue] of document.cues.entries()) {
    const row=index+1
    if(!Number.isSafeInteger(cue.startMs)||!Number.isSafeInteger(cue.endMs)||cue.startMs<0||cue.endMs<=cue.startMs||cue.endMs>359999999)issues.push({id:cue.id,row,message:tr("开始和结束时间不合法"),kind:'error'})
    if(!cue.comment&&!cue.text.trim())issues.push({id:cue.id,row,message:tr("字幕文本为空"),kind:'warning'})
    if(!styles.has(cue.style??'Default'))issues.push({id:cue.id,row,message:tr("样式 {0} 不存在",cue.style),kind:'error'})
    if(!cue.comment&&previous&&cue.startMs<previous.endMs)issues.push({id:cue.id,row,message:tr("与上一条对白的时间重叠"),kind:'warning'})
    if(!cue.comment)previous=cue
  }
  return issues
}
export function shiftCues(cues:Cue[],ids:ReadonlySet<string>,offset:number,edge:'both'|'start'|'end'='both'):Cue[] {
  if(!Number.isSafeInteger(offset))throw new Error(tr("偏移必须为整数毫秒"))
  return cues.map(cue=>{
    if(!ids.has(cue.id))return cue
    const next={...cue,startMs:cue.startMs+(edge==='end'?0:offset),endMs:cue.endMs+(edge==='start'?0:offset)}
    if(next.startMs<0||next.endMs>359999999||next.endMs<=next.startMs)throw new Error(tr("偏移后时间不合法，请调整偏移值或范围"))
    return next
  })
}
export function copyCues(cues:Cue[],ids:ReadonlySet<string>):Cue[] { return structuredClone(cues.filter(cue=>ids.has(cue.id))) }
export function pasteCues(cues:Cue[],copied:Cue[],afterId?:string):{cues:Cue[];ids:string[]} {
  const inserted=copied.map(cue=>({...structuredClone(cue),id:crypto.randomUUID()}))
  const position=afterId?cues.findIndex(cue=>cue.id===afterId)+1:cues.length
  return {cues:[...cues.slice(0,position),...inserted,...cues.slice(position)],ids:inserted.map(cue=>cue.id)}
}
export function splitCue(cue:Cue[],id:string,atMs:number,cursor:number):{cues:Cue[];ids:string[]} {
  const index=cue.findIndex(item=>item.id===id),source=cue[index]
  if(!source||source.endMs-source.startMs<20)throw new Error(tr("字幕时长至少为 20 毫秒才能拆分"))
  if(/\{[^}]*\\/.test(source.text))throw new Error(tr("带 ASS 覆盖标签的条目请手动拆分，以保留排版和标签范围"))
  const middle=Math.round((source.startMs+source.endMs)/20)*10
  const time=atMs>source.startMs&&atMs<source.endMs?Math.round(atMs/10)*10:middle
  if(time<=source.startMs||time>=source.endMs)throw new Error(tr("拆分位置过于接近字幕边缘"))
  const cut=cursor>0&&cursor<source.text.length?cursor:Math.ceil(source.text.length/2)
  const first={...source,endMs:time,text:source.text.slice(0,cut).trimEnd()},second={...source,id:crypto.randomUUID(),startMs:time,text:source.text.slice(cut).trimStart()}
  return {cues:[...cue.slice(0,index),first,second,...cue.slice(index+1)],ids:[first.id,second.id]}
}
export function mergeCues(cues:Cue[],ids:ReadonlySet<string>):{cues:Cue[];id:string} {
  const selected=cues.filter(cue=>ids.has(cue.id))
  if(selected.length<2)throw new Error(tr("请选择至少两条字幕"))
  const first=selected[0],merged={...first,startMs:Math.min(...selected.map(c=>c.startMs)),endMs:Math.max(...selected.map(c=>c.endMs)),text:selected.map(c=>c.text).join('\n')}
  return {cues:cues.flatMap(cue=>cue.id===first.id?[merged]:ids.has(cue.id)?[]:[cue]),id:first.id}
}
export function replaceSubtitleText(cues:Cue[],search:string,replacement:string,ids?:ReadonlySet<string>,caseSensitive=true):{cues:Cue[];count:number} {
  if(!search)return {cues,count:0}
  let count=0
  const escaped=search.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),pattern=new RegExp(escaped,caseSensitive?'g':'gi')
  return {cues:cues.map(cue=>{
    if(ids&&!ids.has(cue.id))return cue
    const text=cue.text.replace(pattern,()=>{count++;return replacement})
    return text===cue.text?cue:{...cue,text}
  }),get count(){return count}}
}
