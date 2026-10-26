import type { SubtitleDocument } from '../../shared/subtitles'
import { qualitySchema,type QualityOptions } from '../../shared/subtitle-tools'
import { tr } from './i18n'
export function readingText(text:string):string{
  let drawing=false,result='',offset=0
  for(const block of text.matchAll(/\{[^}]*\}/g)){if(!drawing)result+=text.slice(offset,block.index);const p=[...block[0].matchAll(/\\p(\d+)/g)].at(-1);if(p)drawing=Number(p[1])>0;if(/\\r(?:[^\\}]*)/.test(block[0]))drawing=false;offset=block.index!+block[0].length}
  if(!drawing)result+=text.slice(offset)
  return result.replace(/\\[Nn]/g,'\n').replace(/\\h/g,' ')
}
export function qualityIssues(document:SubtitleDocument,options:QualityOptions=qualitySchema.parse({})):{id:string;row:number;message:string;kind:'error'|'warning'}[]{
  const issues:{id:string;row:number;message:string;kind:'error'|'warning'}[]=[],styles=new Set(document.styles?.map(s=>s.name)??['Default'])
  document.cues.forEach((cue,index)=>{
    const warn=(message:string,kind:'error'|'warning'='warning')=>issues.push({id:cue.id,row:index+1,message,kind}),duration=cue.endMs-cue.startMs
    if(!Number.isSafeInteger(cue.startMs)||!Number.isSafeInteger(cue.endMs)||cue.startMs<0||cue.endMs>359999999||duration<=0)warn(tr('开始和结束时间不合法'),'error')
    if(!styles.has(cue.style??'Default'))warn(tr('样式 {0} 不存在',cue.style),'error')
    if(cue.comment)return
    const plain=readingText(cue.text),lines=plain.split('\n'),count=[...(options.ignoreWhitespace?plain.replace(/\s/g,''):plain.replace(/\n/g,''))].length
    if(!plain.trim())warn(tr('字幕文本为空'))
    if(duration>0&&count/(duration/1000)>options.cps)warn(tr('阅读速度 {0} CPS 超过 {1}',(count/(duration/1000)).toFixed(1),options.cps))
    const longest=Math.max(...lines.map(line=>[...line].length))
    if(longest>options.lineLength)warn(tr('最长行 {0} 字超过 {1}',longest,options.lineLength))
    if(lines.length>options.lines)warn(tr('行数 {0} 超过 {1}',lines.length,options.lines))
    if(duration>0&&duration<options.minDurationMs)warn(tr('显示时长低于 {0} 毫秒',options.minDurationMs))
    if(duration>options.maxDurationMs)warn(tr('显示时长超过 {0} 毫秒',options.maxDurationMs))
  })
  if(options.checkOverlaps){let end=-1;for(const {cue,index}of document.cues.map((cue,index)=>({cue,index})).filter(({cue})=>!cue.comment&&cue.endMs>cue.startMs).sort((a,b)=>a.cue.startMs-b.cue.startMs)){if(cue.startMs<end)issues.push({id:cue.id,row:index+1,message:tr('与其他对白的时间重叠'),kind:'warning'});end=Math.max(end,cue.endMs)}}
  return issues
}
