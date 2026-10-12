import { useState } from 'react'
import { ArrowLeft, Keyboard, RotateCcw, X } from 'lucide-react'
import { shortcutDefinitions, defaultShortcuts, formatShortcut, shortcutFromEvent, validateShortcuts, type ShortcutBindings, type ShortcutId } from '../../shared/shortcuts'
import { Button, Card } from '../components/ui'

export function Shortcuts({bindings,saved,onChange,onBack,busy}:{bindings:ShortcutBindings;saved:ShortcutBindings;onChange:(bindings:ShortcutBindings)=>void;onBack:()=>void;busy:boolean}){
  const [recording,setRecording]=useState<ShortcutId>(),[message,setMessage]=useState('')
  const issues=validateShortcuts(bindings)
  function patch(id:ShortcutId,value:string){onChange({...bindings,[id]:value})}
  return <div className="shortcuts-page">
    <div className="toolbar shortcut-page-toolbar"><Button variant="ghost" disabled={busy} onClick={onBack}><ArrowLeft size={16}/>返回设置</Button><Button variant="secondary" disabled={busy} onClick={()=>{onChange({...defaultShortcuts});setRecording(undefined);setMessage('')}}><RotateCcw size={15}/>恢复全部默认值</Button></div>
    <Card title="快捷键" aside={<span className="hint">保存设置后生效</span>}>
      <p className="hint">点击按键区域后按下组合键。Esc 取消录入并固定用于退出全屏。输入框保留文字编辑快捷键；Win 组合键可能被系统占用。</p>
      {message&&<p className="validation-note" role="alert">{message}</p>}
      {(['player','subtitles'] as const).map(scope=><section className="shortcut-group" key={scope}><h4>{scope==='player'?'播放器':'字幕编辑'}</h4><div className="shortcut-list">{shortcutDefinitions.filter(item=>item.scope===scope).map(item=>{
        const changed=bindings[item.id]!==saved[item.id],error=issues.find(issue=>issue.id===item.id)?.message
        return <div className={`shortcut-row ${changed?'setting-changed':''} ${error?'shortcut-conflict':''}`} data-shortcut={item.id} key={item.id}>
          <div className="shortcut-description"><strong>{item.label}{changed&&<small className="setting-marker">未保存</small>}</strong>{'description' in item&&<small className="hint">{item.description}</small>}{error&&<small className="shortcut-error" role="alert">{error}</small>}</div>
          <button className={`input shortcut-binding ${recording===item.id?'recording':''}`} disabled={busy} aria-label={`${item.label}快捷键`} aria-pressed={recording===item.id} onClick={()=>{setRecording(item.id);setMessage('')}} onBlur={()=>setRecording(undefined)} onKeyDown={event=>{
            if(recording!==item.id)return
            event.preventDefault();event.stopPropagation()
            if(event.code==='Escape'){setRecording(undefined);setMessage('');return}
            if(event.repeat)return
            const key=shortcutFromEvent(event.nativeEvent)
            if(!key){if(!['Control','Shift','Alt','Meta'].includes(event.key))setMessage('请选择字母、数字、方向键、功能键或常用标点组合');return}
            patch(item.id,key);setRecording(undefined);setMessage('')
          }}>{recording===item.id?<><Keyboard size={15}/>请按下快捷键…</>:formatShortcut(bindings[item.id])}</button>
          <Button variant="ghost" size="icon" aria-label={`清除${item.label}快捷键`} title="清除快捷键" disabled={busy||!bindings[item.id]} onClick={()=>{patch(item.id,'');setRecording(undefined)}}><X size={15}/></Button>
          <Button variant="ghost" size="icon" aria-label={`重置${item.label}快捷键`} title="恢复默认值" disabled={busy||bindings[item.id]===defaultShortcuts[item.id]} onClick={()=>{patch(item.id,defaultShortcuts[item.id]);setRecording(undefined)}}><RotateCcw size={15}/></Button>
        </div>
      })}</div></section>)}
      {issues.length>0&&<p className="validation-note" role="alert">请先解决快捷键冲突，再保存设置。播放器快捷键也用于字幕页。</p>}
    </Card>
  </div>
}
