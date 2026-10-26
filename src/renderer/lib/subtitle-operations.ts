import { tr } from './i18n'
import type { Cue } from '../../shared/subtitles'

export const editableCueFields=['text','startMs','endMs','style','name','layer','marginL','marginR','marginV','effect','comment'] as const
export type CueField=typeof editableCueFields[number]
export function patchSelection(cues:Cue[],ids:ReadonlySet<string>,patch:Partial<Cue>|((cue:Cue)=>Partial<Cue>)):Cue[]{
  return cues.map(cue=>ids.has(cue.id)?{...cue,...(typeof patch==='function'?patch(cue):patch),id:cue.id}:cue)
}
export function moveSelection(cues:Cue[],ids:ReadonlySet<string>,direction:'up'|'down'|'first'|'last'):Cue[]{
  if(direction==='first'||direction==='last'){const selected=cues.filter(c=>ids.has(c.id)),other=cues.filter(c=>!ids.has(c.id));return direction==='first'?[...selected,...other]:[...other,...selected]}
  const result=[...cues],step=direction==='up'?1:-1
  for(let i=direction==='up'?1:result.length-2;i>=0&&i<result.length;i+=step){const neighbor=i-step;if(ids.has(result[i].id)&&!ids.has(result[neighbor].id))[result[i],result[neighbor]]=[result[neighbor],result[i]]}
  return result
}
export function sortSelection(cues:Cue[],field:'startMs'|'endMs'|'style'|'name'|'layer'|'text',descending=false,ids?:ReadonlySet<string>):Cue[]{
  const sorted=cues.filter(c=>!ids||ids.has(c.id)).map((cue,index)=>({cue,index})).sort((a,b)=>{const x=a.cue[field]??(field==='layer'?0:''),y=b.cue[field]??(field==='layer'?0:'');return (typeof x==='number'&&typeof y==='number'?x-y:String(x).localeCompare(String(y)))*(descending?-1:1)||a.index-b.index}).map(x=>x.cue)
  let i=0;return cues.map(c=>!ids||ids.has(c.id)?sorted[i++]:c)
}
export function swapSelection(cues:Cue[],ids:ReadonlySet<string>):Cue[]{const positions=cues.flatMap((c,i)=>ids.has(c.id)?[i]:[]);if(positions.length!==2)throw new Error(tr('请选择恰好两条字幕'));const next=[...cues];[next[positions[0]],next[positions[1]]]=[next[positions[1]],next[positions[0]]];return next}
export function pasteOver(cues:Cue[],ids:ReadonlySet<string>,copied:Cue[],fields:CueField[]):Cue[]{
  let targets=cues.filter(c=>ids.has(c.id));if(!fields.length||!copied.length||!targets.length)throw new Error(tr('请选择目标条目、已复制条目和覆盖字段'))
  if(targets.length===1&&copied.length>1){const index=cues.findIndex(c=>c.id===targets[0].id);targets=cues.slice(index,index+copied.length);if(targets.length!==copied.length)throw new Error(tr('目标之后没有足够条目用于覆盖粘贴'))}
  if(copied.length!==1&&copied.length!==targets.length)throw new Error(tr('剪贴板条目数必须为一条或与所选条目数相同'))
  const targetIds=new Set(targets.map(c=>c.id));let index=0;return cues.map(c=>{if(!targetIds.has(c.id))return c;const source=copied[copied.length===1?0:index++],next={...c};for(const field of fields){if(source[field]===undefined)delete next[field];else Object.assign(next,{[field]:source[field]})}return next})
}
// Split only at visible-text boundaries. Replay the complete preceding static
// override stream on the second line so resets and nested style changes survive.
export function splitAssText(text:string,cursor:number):[string,string]{
  if(/\\(?:t|move|fad|fade|k[fo]?|K)\s*(?:\(|\d)/.test(text)||/\\p\s*[1-9]/.test(text))throw new Error(tr('动态效果、卡拉 OK 与绘图条目需要手动拆分'))
  const blocks=[...text.matchAll(/\{[^}]*\}/g)]
  if(blocks.some(m=>cursor>m.index!&&cursor<m.index!+m[0].length))throw new Error(tr('请将光标移到 ASS 覆盖标签之外'))
  if(cursor<=0||cursor>=text.length)throw new Error(tr('请将光标放在字幕文本内部'))
  if(text[cursor-1]==='\\'||(/[\uDC00-\uDFFF]/.test(text[cursor])&&/[\uD800-\uDBFF]/.test(text[cursor-1])))throw new Error(tr('请将光标移到转义序列或完整字符之间'))
  const state=blocks.filter(m=>m.index!+m[0].length<=cursor).map(m=>m[0]).join('')
  return [text.slice(0,cursor).trimEnd(),state+text.slice(cursor).trimStart()]
}
export type SplitMode='cursor'|'preserve'|'proportional'|'lines'
export function splitLine(cues:Cue[],id:string,cursor:number,atMs:number,mode:SplitMode):{cues:Cue[];ids:string[]}{
  const index=cues.findIndex(c=>c.id===id),cue=cues[index];if(!cue)throw new Error(tr('请选择一条字幕'))
  let pieces:string[]
  if(mode==='lines'){
    const breaks=[...cue.text.matchAll(/\n|\\N/g)];if(!breaks.length)throw new Error(tr('字幕中没有可拆分的换行'))
    // Validate the whole line once, then replay static state at each boundary.
    splitAssText(cue.text,breaks[0].index!)
    const starts=[0,...breaks.map(m=>m.index!+m[0].length)],ends=[...breaks.map(m=>m.index!),cue.text.length],blocks=[...cue.text.matchAll(/\{[^}]*\}/g)]
    pieces=starts.map((start,i)=>(i?blocks.filter(m=>m.index!+m[0].length<=start).map(m=>m[0]).join(''):'')+cue.text.slice(start,ends[i]).trim())
  }else pieces=splitAssText(cue.text,cursor)
  const weights=pieces.map(p=>Math.max(1,[...p.replace(/\{[^}]*\}/g,'')].length)),total=weights.reduce((a,b)=>a+b,0),span=cue.endMs-cue.startMs
  if(mode!=='preserve'&&span<pieces.length*10)throw new Error(tr('字幕时长不足以拆分'))
  let elapsed=0
  const created=pieces.map((text,i)=>{const start=mode==='preserve'?cue.startMs:i===0?cue.startMs:mode==='cursor'?Math.round(atMs/10)*10:Math.round((cue.startMs+span*elapsed/total)/10)*10;elapsed+=weights[i];const end=mode==='preserve'?cue.endMs:i===pieces.length-1?cue.endMs:mode==='cursor'?Math.round(atMs/10)*10:Math.round((cue.startMs+span*elapsed/total)/10)*10;if(end<=start||start<cue.startMs||end>cue.endMs)throw new Error(tr('拆分时间必须位于字幕起止时间之间'));return {...cue,id:i===0?cue.id:crypto.randomUUID(),startMs:start,endMs:end,text}})
  return {cues:[...cues.slice(0,index),...created,...cues.slice(index+1)],ids:created.map(c=>c.id)}
}
export function splitAtTime(cues:Cue[],ids:ReadonlySet<string>,time:number):Cue[]{
  return cues.flatMap(cue=>{if(!ids.has(cue.id))return [cue];if(time<=cue.startMs||time>=cue.endMs)throw new Error(tr('拆分时间必须位于字幕起止时间之间'));if(/\\(?:t|move|fad|fade|k[fo]?|K)\s*(?:\(|\d)/.test(cue.text))throw new Error(tr('动态效果、卡拉 OK 与绘图条目需要手动拆分'));return [{...cue,endMs:time},{...cue,id:crypto.randomUUID(),startMs:time}]})
}
export function joinSelection(cues:Cue[],ids:ReadonlySet<string>,mode:'concat'|'first'|'identical'|'recombine'|'intervals'):Cue[]{
  const selected=cues.filter(c=>ids.has(c.id));if(selected.length<2)throw new Error(tr('请选择至少两条字幕'))
  if(mode==='recombine'){
    if(selected.some(c=>/\{[^}]*\\/.test(c.text)||(['style','name','layer','marginL','marginR','marginV','effect','comment'] as const).some(key=>c[key]!==selected[0][key])))throw new Error(tr('片段重组需要纯文本和相同事件属性；带标签的条目请先分别整理'))
    const clean=(text:string)=>text.replace(/^(?:\s|\\[Nnh])+|(?:\s|\\[Nnh])+$/g,''),work=selected.map(c=>({...c,text:clean(c.text)})).sort((a,b)=>a.startMs-b.startMs)
    const expand=(a:Cue,b:Cue)=>{b.startMs=Math.min(a.startMs,b.startMs);b.endMs=Math.max(a.endMs,b.endMs)}
    // Collapse identical records first, then peel repeated prefix/suffix
    // fragments from successive records (DVD rolling subtitle cleanup).
    const lines:Cue[]=[]
    for(const cue of work){const previous=lines.at(-1);if(previous?.text===cue.text)expand(cue,previous);else lines.push(cue)}
    let comparisons=0
    for(let i=0;i<lines.length;i++){
      const a=lines[i];if(!a.text)continue
      for(let j=i+1;j<lines.length;j++){
        if(++comparisons>1000000)throw new Error(tr('重组结果超过字幕大小上限，请缩小选择范围'))
        const b=lines[j];if(!b.text)continue
        if(a.text===b.text){expand(a,b);a.text='';break}
        if(b.text.startsWith(a.text)){b.text=clean(b.text.slice(a.text.length));expand(b,a)}
        else if(b.text.endsWith(a.text)){b.text=clean(b.text.slice(0,-a.text.length));expand(b,a)}
        else if(a.text.endsWith(b.text)){a.text=clean(a.text.slice(0,-b.text.length));expand(a,b)}
        else if(a.text.startsWith(b.text)){a.text=clean(a.text.slice(b.text.length));expand(a,b)}
        else break
        if(!a.text)break
      }
    }
    const replacements=new Map(lines.filter(c=>c.text).map(c=>[c.id,c]));return cues.flatMap(c=>!ids.has(c.id)?[c]:replacements.has(c.id)?[replacements.get(c.id)!]:[])
  }
  const joinedText=(items:Cue[])=>items.map((cue,i)=>{
    if(!i||!(/\{[^}]*\\/.test(items[i-1].text)||(cue.style??'Default')!==(items[i-1].style??'Default')))return cue.text
    const style=cue.style??'Default';if(/[{}\\]/.test(style))throw new Error(tr('样式名称不能用于安全的局部重置，请先重命名样式'))
    return '{\\r'+style+'}'+cue.text
  }).join('\n')
  if(mode==='intervals'){
    if(selected.some(c=>['style','name','layer','marginL','marginR','marginV','effect','comment'].some(key=>(c as any)[key]!== (selected[0] as any)[key])||/\\(?:t|move|fad|fade|k[fo]?|K|p)\s*(?:\(|\d)/.test(c.text)))throw new Error(tr('重组要求所选条目的事件属性一致且不含动态效果或绘图'))
    // Losslessly segment overlapping dialogue into non-overlapping intervals.
    // Every active line keeps its own style/tags; duplicate visible text is removed.
    const events=new Map<number,{add:Cue[];remove:Cue[]}>(),order=new Map<string,number>(),active=new Map<string,{cue:Cue;count:number}>(),out:Cue[]=[]
    for(const [index,cue]of selected.entries()){
      if(cue.endMs<=cue.startMs)throw new Error(tr('开始和结束时间不合法'))
      if(!order.has(cue.text))order.set(cue.text,index)
      for(const time of [cue.startMs,cue.endMs])if(!events.has(time))events.set(time,{add:[],remove:[]})
      events.get(cue.startMs)!.add.push(cue);events.get(cue.endMs)!.remove.push(cue)
    }
    const times=[...events.keys()].sort((a,b)=>a-b)
    for(let i=0;i<times.length-1;i++){
      const event=events.get(times[i])!
      for(const cue of event.remove){const item=active.get(cue.text);if(item&&--item.count===0)active.delete(cue.text)}
      for(const cue of event.add){const item=active.get(cue.text);if(item)item.count++;else active.set(cue.text,{cue,count:1})}
      if(!active.size)continue
      const items=[...active.values()].map(item=>item.cue).sort((a,b)=>order.get(a.text)!-order.get(b.text)!),text=joinedText(items),last=out.at(-1)
      if(text.length>10000||out.length>=100000)throw new Error(tr('重组结果超过字幕大小上限，请缩小选择范围'))
      if(last&&last.text===text&&last.endMs===times[i])last.endMs=times[i+1]
      else out.push({...items[0],id:out.length?crypto.randomUUID():selected[0].id,startMs:times[i],endMs:times[i+1],text})
    }
    let inserted=false;return cues.flatMap(c=>{if(!ids.has(c.id))return[c];if(inserted)return[];inserted=true;return out})
  }
  if(mode==='identical'&&selected.some(c=>(['text','style','name','layer','marginL','marginR','marginV','effect','comment'] as const).some(key=>c[key]!==selected[0][key])))throw new Error(tr('文本与事件属性必须相同'))
  const first=selected[0],joined={...first,startMs:Math.min(...selected.map(c=>c.startMs)),endMs:Math.max(...selected.map(c=>c.endMs)),text:mode==='concat'?joinedText(selected):first.text}
  return cues.flatMap(c=>c.id===first.id?[joined]:ids.has(c.id)?[]:[c])
}

export type SearchField='text'|'style'|'name'|'effect'
export interface SearchOptions{query:string;replacement:string;regex:boolean;caseSensitive:boolean;skipTags:boolean;fields:SearchField[];kind:'all'|'dialogue'|'comment';invert:boolean;ids?:string[];minStart?:number;maxStart?:number;action:'find'|'replace';one?:{id:string;field:SearchField;start:number;end:number}}
export interface SearchHit{id:string;field:SearchField;start:number;end:number;value:string}
export function searchCues(cues:Cue[],options:SearchOptions):{cues:Cue[];hits:SearchHit[];ids:string[];count:number}{
  const o=options,ids=o.ids?new Set(o.ids):undefined,hits:SearchHit[]=[],matched:string[]=[]
  if(!o.query)return {cues,hits,ids:[],count:0}
  const pattern=new RegExp(o.regex?o.query:o.query.replace(/[.*+?^$\{\}()|[\]\\]/g,'\\$&'),o.caseSensitive?'gu':'giu')
  let count=0
  const next=cues.map(cue=>{
    if(ids&&!ids.has(cue.id)||o.kind==='comment'&&!cue.comment||o.kind==='dialogue'&&cue.comment||o.minStart!==undefined&&cue.startMs<o.minStart||o.maxStart!==undefined&&cue.startMs>o.maxStart)return cue
    let result=cue,found=false
    for(const field of o.fields){
      const original=cue[field]??''
      const chunks=o.skipTags&&field==='text'?[...original.matchAll(/\{[^}]*\}|([^{}]+|[{}])/g)].filter(m=>m[1]!==undefined).map(m=>({text:m[0],offset:m.index!})):[{text:original,offset:0}]
      let output=original,delta=0
      for(const chunk of chunks){
        pattern.lastIndex=0
        const changed=chunk.text.replace(pattern,(...args:any[])=>{
          const named=typeof args.at(-1)==='object',offset=named?args.at(-3):args.at(-2),start=chunk.offset+offset,end=start+args[0].length
          found=true
          if(hits.length<10000)hits.push({id:cue.id,field,start,end,value:args[0]})
          if(o.action!=='replace'||o.one&&(o.one.id!==cue.id||o.one.field!==field||o.one.start!==start||o.one.end!==end))return args[0]
          count++
          if(!o.regex)return o.replacement
          const groups=named?args.at(-1):undefined,captures=args.slice(1,named?-3:-2)
          return o.replacement.replace(/\$(\$|&|\d{1,2}|<[^>]+>)/g,(_m,key:string)=>{
            if(key==='$')return '$'
            if(key==='&')return args[0]
            if(key.startsWith('<'))return groups?groups[key.slice(1,-1)]??'':'$'+key
            const index=Number(key)
            if(index>0&&index<=captures.length)return captures[index-1]??''
            if(key.length===2&&Number(key[0])>0&&Number(key[0])<=captures.length)return (captures[Number(key[0])-1]??'')+key[1]
            return '$'+key
          })
        })
        if(changed!==chunk.text){output=output.slice(0,chunk.offset+delta)+changed+output.slice(chunk.offset+delta+chunk.text.length);delta+=changed.length-chunk.text.length}
      }
      if(output!==original){
        if(field!=='text'&&/[,\r\n\x00-\x1f]/.test(output))throw new Error(tr('事件字段不能包含逗号或控制字符'))
        if(output.length>(field==='text'?10000:field==='effect'?2000:200))throw new Error(tr('替换结果超过字段长度上限'))
        result={...result,[field]:output}
      }
    }
    if(o.invert?!found:found)matched.push(cue.id)
    return result
  })
  return {cues:next,hits,ids:matched,count}
}
