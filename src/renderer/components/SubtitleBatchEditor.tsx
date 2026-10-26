import { useState } from 'react'
import type { Cue, SubtitleDocument } from '../../shared/types'
import { Button, Field, Input, Select } from './ui'
import { tr } from '../lib/i18n'
import { patchSelection } from '../lib/subtitle-operations'
import { shiftCues } from '../lib/subtitle-editor'
import { subtitleSchema } from '../../shared/schema'
import type { RunAction } from './Jobs'

/** Batch operations are explicit and never replace subtitle text or absolute times. */
export function SubtitleBatchEditor({document,selection,onChange,disabled,run}:{document:SubtitleDocument;selection:string[];onChange:(cues:Cue[])=>void;disabled:boolean;run:RunAction}) {
  const [style,setStyle]=useState(''),[field,setField]=useState('name'),[value,setValue]=useState(''),[offset,setOffset]=useState(0)
  const ids=new Set(selection),srtMode=document.exportFormat==='srt'
  const commit=(build:()=>Cue[])=>run(async()=>onChange(subtitleSchema.parse({...document,cues:build()}).cues))
  const apply=(patch:Partial<Cue>)=>commit(()=>patchSelection(document.cues,ids,patch))
  return <div className="subtitle-edit-scroll subtitle-batch-editor" data-testid="subtitle-batch-editor">
    <div className="inner-card"><strong>{tr('已选择 {0} 条字幕',selection.length)}</strong><p className="hint">{tr('仅应用指定属性，保留各条字幕的文本和时间。')}</p></div>
    <div className="inner-card"><Field label={tr('批量应用样式')}><Select disabled={disabled||srtMode} value={style} onChange={event=>setStyle(event.target.value)}><option value="">{tr('选择样式')}</option>{(document.styles??[]).map(item=><option key={item.name} value={item.name}>{item.name}</option>)}</Select></Field><Button disabled={disabled||srtMode||!style} onClick={()=>apply({style})}>{tr('应用样式')}</Button></div>
    <div className="inner-card"><Field label={tr('批量修改属性')}><Select disabled={disabled||srtMode} value={field} onChange={event=>setField(event.target.value)}>{(['name','layer','marginL','marginR','marginV','effect'] as const).map((key,index)=><option key={key} value={key}>{tr(['角色','图层','左边距','右边距','垂直边距','效果'][index])}</option>)}</Select></Field><Input disabled={disabled||srtMode} aria-label={tr('批量属性值')} value={value} type={['name','effect'].includes(field)?'text':'number'} min={0} onChange={event=>setValue(event.target.value)}/><Button disabled={disabled||srtMode||(!['name','effect'].includes(field)&&(!Number.isInteger(Number(value))||Number(value)<0))} onClick={()=>apply({[field]:['name','effect'].includes(field)?value:Number(value)})}>{tr('应用属性')}</Button></div>
    <div className="inner-card"><Field label={tr('时间偏移（毫秒）')}><Input type="number" value={offset} onChange={event=>setOffset(Number(event.target.value))}/></Field><Button disabled={disabled||!Number.isFinite(offset)||!offset} onClick={()=>commit(()=>shiftCues(document.cues,ids,Math.round(offset),'both'))}>{tr('应用时间偏移')}</Button></div>
    <div className="inner-card flex gap"><Button disabled={disabled||srtMode} onClick={()=>apply({comment:false})}>{tr('设为对白')}</Button><Button disabled={disabled||srtMode} onClick={()=>apply({comment:true})}>{tr('设为注释')}</Button></div>
  </div>
}
