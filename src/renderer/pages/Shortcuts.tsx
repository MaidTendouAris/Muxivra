import { tr } from '../lib/i18n'
import { useEffect,useRef,useState } from 'react'
import { ArrowLeft, Keyboard, RotateCcw, X } from 'lucide-react'
import { shortcutDefinitions, defaultShortcuts, formatShortcut, shortcutFromEvent, shortcutFromWheel, validateShortcuts, type ShortcutBindings, type ShortcutId } from '../../shared/shortcuts'
import { Button, Card } from '../components/ui'

export function Shortcuts({bindings,saved,onChange,onBack,busy}:{bindings:ShortcutBindings;saved:ShortcutBindings;onChange:(bindings:ShortcutBindings)=>void;onBack:()=>void;busy:boolean}){
  const [recording,setRecording]=useState<ShortcutId>(),[message,setMessage]=useState('')
  const recorder=useRef<HTMLDivElement>(null)
  const issues=validateShortcuts(bindings)
  useEffect(()=>{
    const element=recorder.current;if(!element||!recording)return
    const wheel=(event:WheelEvent)=>{
      if(!event.target||!(event.target as Element).closest(`[data-shortcut="${recording}"] .shortcut-binding`))return
      event.preventDefault();event.stopPropagation()
      if(!recording.startsWith('waveform.')){setMessage(tr('仅波形操作支持滚轮绑定'));return}
      const value=shortcutFromWheel(event);if(!value)return
      onChange({...bindings,[recording]:value});setRecording(undefined);setMessage('')
    }
    element.addEventListener('wheel',wheel,{passive:false});return()=>element.removeEventListener('wheel',wheel)
  },[recording,bindings,onChange])
  function patch(id:ShortcutId,value:string){onChange({...bindings,[id]:value})}
  return <div className="shortcuts-page" ref={recorder}>
    <div className="toolbar shortcut-page-toolbar"><Button variant="ghost" disabled={busy} onClick={onBack}><ArrowLeft size={16}/>{tr("返回设置")}</Button><Button variant="secondary" disabled={busy} onClick={()=>{onChange({...defaultShortcuts});setRecording(undefined);setMessage('')}}><RotateCcw size={15}/>{tr("恢复全部默认值")}</Button></div>
    <Card title={tr("快捷键")} aside={<span className="hint">{tr("保存设置后生效")}</span>}>
      <p className="hint">{tr("点击按键区域后输入按键组合；波形操作也可录入修饰键加滚轮。右键清除，Esc 取消。输入框保留文字编辑快捷键，空格默认播放或暂停。")}</p>
      {message&&<p className="validation-note" role="alert">{message}</p>}
      {(['player','subtitles','waveform'] as const).map(scope=><section className="shortcut-group" key={scope}><h4>{scope==='player'?tr("播放器"):scope==='subtitles'?tr("字幕编辑"):tr("音频波形")}</h4><div className="shortcut-list">{shortcutDefinitions.filter(item=>item.scope===scope).map(item=>{
        const changed=bindings[item.id]!==saved[item.id],error=issues.find(issue=>issue.id===item.id)?.message
        return <div className={`shortcut-row ${changed?'setting-changed':''} ${error?'shortcut-conflict':''}`} data-shortcut={item.id} key={item.id}>
          <div className="shortcut-description"><strong>{tr(item.label)}{changed&&<small className="setting-marker">{tr("未保存")}</small>}</strong>{'description' in item&&<small className="hint">{tr(item.description)}</small>}{error&&<small className="shortcut-error" role="alert">{error}</small>}</div>
          <button className={`input shortcut-binding ${recording===item.id?'recording':''}`} disabled={busy} aria-label={tr("{0}快捷键",item.label)} aria-pressed={recording===item.id} title={tr("点击录入，右键清除快捷键")} onClick={()=>{setRecording(item.id);setMessage('')}} onContextMenu={event=>{event.preventDefault();event.stopPropagation();if(busy)return;patch(item.id,'');setRecording(undefined);setMessage('')}} onBlur={()=>setRecording(undefined)} onKeyDown={event=>{
            if(recording!==item.id)return
            event.preventDefault();event.stopPropagation()
            if(event.code==='Escape'){setRecording(undefined);setMessage('');return}
            if(event.repeat)return
            const key=shortcutFromEvent(event.nativeEvent)
            if(!key){if(!['Control','Shift','Alt','Meta'].includes(event.key))setMessage(tr("请选择字母、数字、方向键、功能键或常用标点组合"));return}
            patch(item.id,key);setRecording(undefined);setMessage('')
          }}>{recording===item.id?<><Keyboard size={15}/>{tr("请按下快捷键…")}</>:formatShortcut(bindings[item.id]).replace('空格',tr('空格')).replace('未设置',tr('未设置')).replace('滚轮上 / 左',tr('滚轮上 / 左')).replace('滚轮下 / 右',tr('滚轮下 / 右'))}</button>
          <Button variant="ghost" size="icon" aria-label={tr("清除{0}快捷键",item.label)} title={tr("清除快捷键")} disabled={busy||!bindings[item.id]} onClick={()=>{patch(item.id,'');setRecording(undefined)}}><X size={15}/></Button>
          <Button variant="ghost" size="icon" aria-label={tr("重置{0}快捷键",item.label)} title={tr("恢复默认值")} disabled={busy||bindings[item.id]===defaultShortcuts[item.id]} onClick={()=>{patch(item.id,defaultShortcuts[item.id]);setRecording(undefined)}}><RotateCcw size={15}/></Button>
        </div>
      })}</div></section>)}
      {issues.length>0&&<p className="validation-note" role="alert">{tr("请先解决快捷键冲突，再保存设置。播放器快捷键也用于字幕页。")}</p>}
    </Card>
  </div>
}
