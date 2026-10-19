import { tr } from '../lib/i18n'
import { useMemo,useState } from 'react'
import { ArrowLeft,Search } from 'lucide-react'
import type { SubtitleDocument } from '../../shared/types'
import { Button,Input,Empty } from './ui'
import { formatTime } from '../lib/utils'
import { subtitlePlainText } from '../lib/subtitle-format'
export function SubtitleReview({document,name,onBack}:{document:SubtitleDocument;name:string;onBack:()=>void}){
  const [search,setSearch]=useState(''),[raw,setRaw]=useState(false),[comments,setComments]=useState(true)
  const rows=useMemo(()=>document.cues.map((cue,index)=>({cue,index,text:raw?cue.text:subtitlePlainText(cue.text)})).filter(row=>(comments||!row.cue.comment)&&(!search||row.text.toLocaleLowerCase().includes(search.toLocaleLowerCase()))),[document.cues,raw,comments,search])
  return <section className="subtitle-review-page"><div className="subtitle-secondary-heading"><Button variant="ghost" onClick={onBack}><ArrowLeft size={16}/>{tr("返回字幕编辑")}</Button><h2>{tr("字幕预览")}</h2></div><div className="card subtitle-review-summary"><strong title={name}>{name}</strong><span className="hint">{rows.length} / {document.cues.length} {tr("条")}</span><label><input type="checkbox" checked={raw} onChange={event=>setRaw(event.target.checked)}/>{tr("显示 ASS 标签")}</label><label><input type="checkbox" checked={comments} onChange={event=>setComments(event.target.checked)}/>{tr("包含注释")}</label><div className="subtitle-review-search"><Search size={16}/><Input aria-label={tr("搜索预览文本")} placeholder={tr("搜索全部字幕")} value={search} onChange={event=>setSearch(event.target.value)}/></div></div><div className="card subtitle-review-scroll">{rows.length?<ol className="subtitle-review-lines">{rows.map(({cue,index,text})=><li key={cue.id} className={cue.comment?'is-comment':''}><div className="subtitle-review-line-meta"><span>#{index+1}</span><code>{formatTime(cue.startMs)} → {formatTime(cue.endMs)}</code><span>{cue.style??'Default'}</span>{cue.comment&&<span className="tag">{tr("注释")}</span>}</div><p>{text||'—'}</p></li>)}</ol>:<Empty title={search?tr("没有匹配条目"):tr("无字幕")}/>}</div></section>
}
