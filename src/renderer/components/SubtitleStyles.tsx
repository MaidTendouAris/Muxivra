import { useEffect, useState } from 'react'
import { ArrowLeft, Plus, Copy, Trash2 } from 'lucide-react'
import type { SubtitleDocument, SubtitleStyle } from '../../shared/subtitles'
import { assColourToHex, hexToAssColour, parseAssColour, defaultSubtitleStyle } from '../../shared/subtitles'
import { Button, Card, Field, Input, Select } from './ui'
import type { RunAction } from './Jobs'

const alignments=['左下','下方居中','右下','左侧居中','居中','右侧居中','左上','上方居中','右上']
export function SubtitleStyles({document,onChange,onBack,run}:{document:SubtitleDocument;onChange:(document:SubtitleDocument)=>void;onBack:()=>void;run:RunAction}) {
  const [index,setIndex]=useState(0),styles=document.styles??[defaultSubtitleStyle()],style=styles[Math.min(index,styles.length-1)]
  const [name,setName]=useState(style.name)
  useEffect(()=>setName(style.name),[style.name,index])
  function update(patch:Partial<SubtitleStyle>) { onChange({...document,styles:styles.map((s,i)=>i===index?{...s,...patch}:s)}) }
  function rename() {
    const next=name.trim()
    if(next===style.name)return
    if(!next||/[,\r\n]/.test(next))throw new Error('样式名称不能为空或包含逗号、换行')
    if(style.name==='Default')throw new Error('Default 样式不能改名')
    if(styles.some((s,i)=>i!==index&&s.name.toLowerCase()===next.toLowerCase()))throw new Error('样式名称已存在')
    onChange({...document,styles:styles.map((s,i)=>i===index?{...s,name:next}:s),cues:document.cues.map(cue=>cue.style===style.name?{...cue,style:next}:cue)})
  }
  function add(copy:boolean) {
    let n=1;while(styles.some(s=>s.name===`样式 ${n}`))n++
    onChange({...document,styles:[...styles,copy?{...structuredClone(style),name:`样式 ${n}`} : defaultSubtitleStyle({name:`样式 ${n}`})]});setIndex(styles.length)
  }
  const number=(label:string,key:keyof SubtitleStyle,min=0,max=10000,step=1)=><Field label={label}><Input type="number" min={min} max={max} step={step} value={String(style[key])} onChange={event=>{if(!event.target.value)return;const value=Number(event.target.value);if(Number.isFinite(value)&&value>=min&&value<=max)update({[key]:value})}}/></Field>
  const colour=(label:string,key:'primaryColour'|'secondaryColour'|'outlineColour'|'backColour')=>{
    const hex=assColourToHex(style[key]),alpha=parseInt(parseAssColour(style[key]).slice(0,2),16)
    return <div className="subtitle-colour-field"><Field label={label}><Input type="color" value={hex} onChange={event=>update({[key]:hexToAssColour(event.target.value,alpha)})}/></Field><Field label="透明度（0–255）"><Input type="number" min={0} max={255} value={alpha} onChange={event=>{const value=Number(event.target.value);if(Number.isInteger(value)&&value>=0&&value<=255)update({[key]:hexToAssColour(hex,value)})}}/></Field></div>
  }
  const info=(key:string,value:string)=>onChange({...document,scriptInfo:{...document.scriptInfo,[key]:value}})
  return <div className="subtitle-style-page"><div className="subtitle-secondary-heading"><Button variant="ghost" onClick={onBack}><ArrowLeft size={16}/>返回字幕编辑</Button><h2>样式与脚本设置</h2></div>
    <div className="subtitle-style-layout"><Card title="样式"><div className="subtitle-style-list">{styles.map((s,i)=><button key={i} className={index===i?'active':''} onClick={()=>setIndex(i)}>{s.name}<small>{s.fontName} · {s.fontSize}</small></button>)}</div><div className="toolbar"><Button variant="secondary" size="sm" onClick={()=>add(false)}><Plus size={14}/>新增</Button><Button variant="secondary" size="sm" onClick={()=>add(true)}><Copy size={14}/>复制</Button><Button variant="ghost" size="sm" disabled={style.name==='Default'} onClick={()=>{onChange({...document,styles:styles.filter((_,i)=>i!==index),cues:document.cues.map(cue=>cue.style===style.name?{...cue,style:'Default'}:cue)});setIndex(0)}}><Trash2 size={14}/>删除</Button></div><p className="hint">删除样式后，使用该样式的字幕改用 Default。</p></Card>
    <Card title="样式属性"><div className="subtitle-inner-card"><div className="form-grid"><Field label="样式名称"><Input value={name} disabled={style.name==='Default'} onChange={e=>setName(e.target.value)} onBlur={()=>void run(async()=>rename())}/></Field><Field label="字体名称"><Input value={style.fontName} onChange={e=>update({fontName:e.target.value.replace(/[,\r\n]/g,'')})}/></Field>{number('字号','fontSize',1,1000,.1)}<Field label="对齐位置"><Select value={style.alignment} onChange={e=>update({alignment:+e.target.value})}>{alignments.map((label,i)=><option key={i} value={i+1}>{i+1} · {label}</option>)}</Select></Field></div><div className="subtitle-style-flags">{(['bold','italic','underline','strikeOut'] as const).map((key,i)=><label key={key}><input type="checkbox" checked={style[key]} onChange={e=>update({[key]:e.target.checked})}/>{['粗体','斜体','下划线','删除线'][i]}</label>)}</div></div>
      <div className="subtitle-inner-card subtitle-colours">{colour('文字颜色','primaryColour')}{colour('次要颜色','secondaryColour')}{colour('描边颜色','outlineColour')}{colour('阴影颜色','backColour')}</div>
      <div className="subtitle-inner-card"><div className="form-grid"><Field label="边框方式"><Select value={style.borderStyle} onChange={e=>update({borderStyle:+e.target.value})}><option value="1">描边与阴影</option><option value="3">不透明背景框</option></Select></Field>{number('描边宽度','outline',0,100,.1)}{number('阴影距离','shadow',0,100,.1)}{number('水平缩放（%）','scaleX',1,1000,.1)}{number('垂直缩放（%）','scaleY',1,1000,.1)}{number('字间距','spacing',-100,1000,.1)}{number('旋转角度','angle',-360,360,.1)}{number('左边距','marginL',0,99999)}{number('右边距','marginR',0,99999)}{number('垂直边距','marginV',0,99999)}{number('字体编码标识','encoding',0,255)}</div></div>
    </Card></div>
    <Card title="脚本设置"><div className="form-grid subtitle-script-grid"><Field label="脚本标题"><Input value={document.scriptInfo?.Title??''} onChange={e=>info('Title',e.target.value)}/></Field><Field label="作者"><Input value={document.scriptInfo?.['Original Script']??''} onChange={e=>info('Original Script',e.target.value)}/></Field><Field label="脚本宽度"><Input type="number" min={1} max={100000} value={document.scriptInfo?.PlayResX??1920} onChange={e=>{if(+e.target.value>0)info('PlayResX',e.target.value)}}/></Field><Field label="脚本高度"><Input type="number" min={1} max={100000} value={document.scriptInfo?.PlayResY??1080} onChange={e=>{if(+e.target.value>0)info('PlayResY',e.target.value)}}/></Field><Field label="换行方式"><Select value={document.scriptInfo?.WrapStyle??'0'} onChange={e=>info('WrapStyle',e.target.value)}><option value="0">0 · 智能换行，上行优先</option><option value="1">1 · 从行尾换行</option><option value="2">2 · 仅手动换行</option><option value="3">3 · 智能换行，下行优先</option></Select></Field><Field label="描边与阴影随分辨率缩放"><Select value={document.scriptInfo?.ScaledBorderAndShadow??'yes'} onChange={e=>info('ScaledBorderAndShadow',e.target.value)}><option value="yes">是</option><option value="no">否</option></Select></Field><Field label="色彩矩阵"><Select value={document.scriptInfo?.['YCbCr Matrix']??'TV.709'} onChange={e=>info('YCbCr Matrix',e.target.value)}>{['None','TV.601','PC.601','TV.709','PC.709','TV.2020','PC.2020'].map(v=><option value={v} key={v}>{v}</option>)}</Select></Field></div></Card>
  </div>
}
