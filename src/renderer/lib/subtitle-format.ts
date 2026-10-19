import { tr } from './i18n'
export interface TextRange { start:number;end:number }
export type SubtitleTextCommand='bold'|'italic'|'underline'|'strike'|'newline'|'clear'|'reset'|'color'|'size'|'align'
/** Selection offsets use UTF-16, matching the browser textarea API. */
export function formatSubtitleText(text:string,range:TextRange,command:SubtitleTextCommand,value?:string|number){
  let start=Math.max(0,Math.min(text.length,range.start)),end=Math.max(start,Math.min(text.length,range.end))
  if(command==='newline'||command==='reset'){
    const insert=command==='newline'?'\n':'{\\r}',next=text.slice(0,start)+insert+text.slice(end)
    return {text:next,start:start+insert.length,end:start+insert.length}
  }
  if(start===end){start=0;end=text.length}
  // Never insert a formatting boundary into an existing ASS override block.
  const inTag=(offset:number)=>{const before=text.slice(0,offset),open=before.lastIndexOf('{');return open>before.lastIndexOf('}')&&/^\{[^}]*\\/.test(text.slice(open))}
  if(inTag(start)||inTag(end))throw new Error(tr("请将光标或选区移到 ASS 标签之外"))
  const selected=text.slice(start,end)
  if(command==='clear'){const clean=selected.replace(/\{[^}]*\\[^}]*\}/g,'');return {text:text.slice(0,start)+clean+text.slice(end),start,end:start+clean.length}}
  let open='',close=''
  const tag={bold:'b',italic:'i',underline:'u',strike:'s'}[command as 'bold'|'italic'|'underline'|'strike']
  if(tag){open=`{\\${tag}1}`;close=`{\\${tag}0}`}
  else if(command==='color'){
    if(typeof value!=='string'||!/^#[\da-f]{6}$/i.test(value))throw new Error(tr("颜色值无效"))
    open=`{\\c&H${value.slice(5,7)}${value.slice(3,5)}${value.slice(1,3)}&}`;close='{\\c}'
  }else if(command==='size'){
    if(typeof value!=='number'||!Number.isFinite(value)||value<1||value>10000)throw new Error(tr("字体大小无效"))
    open=`{\\fs${value}}`;close='{\\fs}'
  }else if(command==='align'){
    if(![1,2,3,4,5,6,7,8,9].includes(Number(value)))throw new Error(tr("对齐方式无效"))
    // Alignment is a line property; one tag at the start applies to the cue.
    const clean=text.replace(/\{\\an[1-9]\}/g,'');return {text:`{\\an${value}}`+clean,start:0,end:0}
  }
  if(selected.startsWith(open)&&selected.endsWith(close)&&open&&close){const inner=selected.slice(open.length,-close.length);return {text:text.slice(0,start)+inner+text.slice(end),start,end:start+inner.length}}
  return {text:text.slice(0,start)+open+selected+close+text.slice(end),start,end:start+open.length+selected.length+close.length}
}
export function subtitlePlainText(text:string){return text.replace(/\{[^}]*\\[^}]*\}/g,'').replace(/\\[Nn]/g,'\n').replace(/\\h/g,'\u00a0')}
