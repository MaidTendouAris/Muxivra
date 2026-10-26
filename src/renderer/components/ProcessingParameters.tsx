import { tr } from '../lib/i18n'
import { Plus,Trash2 } from 'lucide-react'
import type { Engine,TranscodeOptions } from '../../shared/types'
import { parameters } from '../../shared/parameters'
import { ParameterControl,ComponentFields } from './AdvancedOptions'
import { videoNames,audioNames } from './OptionsForm'
import { Button,Field,Input,Select } from './ui'

export function ParameterFields({keys,groups,exclude=[],value,onChange,engine}:{keys?:string[];groups?:string[];exclude?:string[];value:TranscodeOptions;onChange:(v:TranscodeOptions)=>void;engine?:Engine}){
  return <div className="parameter-grid">{parameters.filter(p=>(keys?.includes(p.key)||groups?.includes(p.group))&&!exclude.includes(p.key)).map(p=><ParameterControl key={p.key} definition={p} engine={engine} value={value.advanced?.[p.key]} onChange={next=>{const a={...value.advanced};if(next===undefined)delete a[p.key];else a[p.key]=next;onChange({...value,presetId:undefined,advanced:a,...(['width','height'].includes(p.key)&&next!==undefined?{maxHeight:undefined}:{})})}}/>)}</div>
}
export function CodecFields({scope,value,onChange,engine}:{scope:'video'|'audio';value:TranscodeOptions;onChange:(v:TranscodeOptions)=>void;engine?:Engine}){
  const names=scope==='video'?videoNames:audioNames,codec=value[scope],a=value.advanced??{}
  const update=(patch:Partial<TranscodeOptions>)=>onChange({...value,...patch,presetId:undefined})
  const choices=[...new Set([...Object.keys(names),...(engine?.encoders.filter(name=>engine.encoderKinds?.[name]===scope)??[]),codec])].filter(n=>!['copy','none'].includes(n))
  const values=Object.fromEntries((value.encoderOptions??[]).filter(p=>p.scope===scope).map(p=>[p.name,p.value]))
  return <>
    <Field label={scope==='video'?tr("视频编码"):tr("音频编码")}><Select value={codec} onChange={e=>update({[scope]:e.target.value,encoderOptions:value.encoderOptions?.filter(p=>p.scope!==scope),...(scope==='video'?{codecParameters:undefined}:{})})}><option value="copy">{tr("复制轨道")}</option><option value="none">{tr("不输出")}</option>{choices.map(name=><option key={name} value={name} disabled={!!engine&&!engine.encoders.includes(name)}>{tr(names[name]??name)}</option>)}</Select></Field>
    {!['copy','none'].includes(codec)&&<>
      {scope==='video'?<><div className="form-grid"><Field label={tr("质量控制")}><Select value={String(a.rateControl??'auto')} onChange={e=>update({advanced:{...a,rateControl:e.target.value}})}>{['auto','crf','cq','qp','bitrate','manual'].map(key=><option key={key} value={key}>{key==='auto'?tr("自动"):key==='bitrate'?tr("目标码率"):key==='manual'?tr("专用参数"):key.toUpperCase()}</option>)}</Select></Field><Field label={tr("质量值")}><Input type="number" min={0} max={63} value={value.quality} onChange={e=>update({quality:Number(e.target.value)})}/></Field></div><Field label={tr("编码速度预设")}><Input value={value.speed} onChange={e=>update({speed:e.target.value})}/></Field><ParameterFields groups={['encoder','quality','decode']} exclude={['rateControl']} value={value} onChange={onChange} engine={engine}/></>:<><Field label={tr("音频码率（kbps）")}><Input type="number" min={8} max={1536} value={value.audioBitrate} onChange={e=>update({audioBitrate:Number(e.target.value)})}/></Field><ParameterFields groups={['audio']} keys={['audioDelay']} value={value} onChange={onChange} engine={engine}/></>}
      <details className="processing-private"><summary>{tr("编码器专用参数")}</summary><ComponentFields kind={scope==='video'?'videoEncoder':'audioEncoder'} name={codec} engine={engine} values={values} onChange={(key,next)=>update({encoderOptions:[...(value.encoderOptions??[]).filter(p=>p.scope!==scope||p.name!==key),...(next?[{scope,name:key,value:next}]:[])]})}/></details>
    </>}
  </>
}
export function MetadataFields({value,onChange}:{value:TranscodeOptions;onChange:(v:TranscodeOptions)=>void}){
  return <><ParameterFields keys={['metadata']} value={value} onChange={onChange}/><div className="card-heading"><h3>{tr("写入元数据")}</h3><Button variant="secondary" size="sm" onClick={()=>onChange({...value,metadata:[...(value.metadata??[]),{key:'title',value:''}]})}><Plus size={15}/>{tr("添加")}</Button></div>{(value.metadata??[]).map((item,index)=><div className="metadata-row" key={index}><Input aria-label={tr("元数据键 {0}",index+1)} value={item.key} onChange={e=>onChange({...value,metadata:value.metadata!.map((m,i)=>i===index?{...m,key:e.target.value}:m)})}/><Input aria-label={tr("元数据值 {0}",index+1)} value={item.value} onChange={e=>onChange({...value,metadata:value.metadata!.map((m,i)=>i===index?{...m,value:e.target.value}:m)})}/><Button variant="ghost" size="icon" aria-label={tr("删除元数据 {0}",index+1)} onClick={()=>onChange({...value,metadata:value.metadata!.filter((_,i)=>i!==index)})}><Trash2 size={16}/></Button></div>)}</>
}
