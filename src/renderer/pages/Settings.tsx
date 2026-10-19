import { tr } from '../lib/i18n'
import { useState } from 'react'
import { FolderOpen, Download, Search, Check, Plus, X, RotateCcw } from 'lucide-react'
import type { Snapshot, Settings as SettingsType } from '../../shared/types'
import { APP_VERSION } from '../../shared/version'
import mpv from '../../../resources/mpv-manifest.json'
import { Button, Card, Field, Input, Select, Progress } from '../components/ui'
import type { RunAction } from '../components/Jobs'
import { SystemHardware, HardwareDetails } from '../components/SystemHardware'
import { McpSetup } from '../components/McpSetup'
import { Shortcuts } from './Shortcuts'
import { defaultShortcuts } from '../../shared/shortcuts'
import { SoftwareInfoCard, type AppUpdateControls } from '../components/AppUpdate'

export function Settings({snapshot,draft,onChange:setDraft,run,busy,appUpdate}:{snapshot:Snapshot;draft:SettingsType;onChange:(value:SettingsType)=>void;run:RunAction;busy:boolean;appUpdate:AppUpdateControls}){
  const saved=JSON.stringify(snapshot.settings)
  const [hardwareDetails,setHardwareDetails]=useState(false)
  const [shortcutDetails,setShortcutDetails]=useState(false)
  const changed=(key:keyof SettingsType['mcp'])=>JSON.stringify(draft.mcp[key])!==JSON.stringify(snapshot.settings.mcp[key])
  const patchMcp=(patch:Partial<SettingsType['mcp']>)=>setDraft({...draft,mcp:{...draft.mcp,...patch}})
  const addRoot=(kind:'inputRoots'|'outputRoots')=>run(async()=>{const path=await window.muxivra.selectDirectory(kind==='inputRoots'?'mcp-input':'mcp-output');if(path&&!draft.mcp[kind].includes(path))patchMcp({[kind]:[...draft.mcp[kind],path]})})
  const dirty=JSON.stringify(draft)!==saved
  const saveBar=<div className={`settings-save ${dirty?'settings-dirty':''}`}><span className="hint">{dirty?tr("有未保存的更改"):tr("已保存")} · {APP_VERSION}</span><Button disabled={!dirty||busy} onClick={()=> run(()=>window.muxivra.saveSettings(draft),tr("设置已保存"))}><Check size={16}/>{tr("保存设置")}</Button></div>
  if(shortcutDetails)return <div className="settings-layout"><Shortcuts bindings={draft.shortcuts??defaultShortcuts} saved={snapshot.settings.shortcuts??defaultShortcuts} onChange={shortcuts=>setDraft({...draft,shortcuts})} onBack={()=>setShortcutDetails(false)} busy={busy}/>{saveBar}</div>
  if(hardwareDetails)return <HardwareDetails snapshot={snapshot} run={run} busy={busy} onBack={()=>setHardwareDetails(false)}/>
  return <div className="settings-layout"><fieldset className="settings-layout settings-form" disabled={busy}>
    <SystemHardware snapshot={snapshot} run={run} busy={busy} onDetails={()=>setHardwareDetails(true)}/>
    <Card title={tr("转码引擎 · FFmpeg")} aside={<span className={snapshot.engine?'status status-completed':'status status-failed'}>{snapshot.engine?tr("已就绪"):tr("未配置")}</span>}>
      {snapshot.engine&&<div className="engine-current"><strong>{snapshot.engine.version}</strong><p className="path-text">{snapshot.engine.ffmpegPath}</p></div>}
      <div className="toolbar wrap"><Button variant="secondary" disabled={busy} onClick={()=> run(async()=>{if(!await window.muxivra.detectEngine())throw new Error(tr("PATH 中未找到 FFmpeg 与 ffprobe"))},tr("引擎已启用"))}><Search size={16}/>{tr("检测 PATH")}</Button><Button variant="secondary" disabled={busy} onClick={()=> run(async()=>{const path=await window.muxivra.selectDirectory('engine');if(path)await window.muxivra.useEngine(path)},tr("引擎已启用"))}><FolderOpen size={16}/>{tr("选择本地引擎")}</Button><Button disabled={busy||['downloading','verifying','extracting'].includes(snapshot.download.state)} onClick={()=> run(()=>window.muxivra.downloadEngine(),tr("引擎已启用"))}><Download size={16}/>{tr("下载引擎")}</Button><span className="hint">Gyan 9.0.2 Essentials · 109 MB</span></div>
      {snapshot.download.state!=='idle'&&<div className="download-state"><Progress value={snapshot.download.percent}/><p className={snapshot.download.state==='failed'?'error-text':'hint'}>{tr(snapshot.download.message)}</p></div>}
      {snapshot.engines.length>1&&<details><summary>{tr("已添加的引擎 ·")}{snapshot.engines.length}</summary><div className="engine-list">{snapshot.engines.map(engine=><div key={engine.id}><div><strong>{engine.version}</strong><p className="path-text">{engine.ffmpegPath}</p></div><Button variant="ghost" size="sm" disabled={busy||engine.id===snapshot.engine?.id} onClick={()=> run(()=>window.muxivra.useEngine(engine.id),tr("引擎已切换"))}>{engine.id===snapshot.engine?.id?tr("当前"):<><RotateCcw size={14}/>{tr("切换")}</>}</Button></div>)}</div></details>}
    </Card>
    <div className="settings-columns"><Card title={tr("播放器")}><div className="setting-value"><span>mpv</span><strong>{mpv.version}</strong></div><div className="setting-value"><span>{tr("来源")}</span><span>{tr("内置 · Windows x64")}</span></div></Card><Card title={tr("外观与任务")}>
      <div className="form-grid"><Field label={tr("界面语言")} changed={(draft.language??'system')!==(snapshot.settings.language??'system')}><Select aria-label={tr("界面语言")} disabled={busy} value={draft.language??'system'} onChange={event=>setDraft({...draft,language:event.target.value as SettingsType['language']})}><option value="system">{tr("跟随系统")}</option><option value="zh-CN">{tr("简体中文")}</option><option value="en">English</option></Select></Field><Field label={tr("界面主题")} changed={draft.theme!==snapshot.settings.theme}><Select disabled={busy} value={draft.theme} onChange={event=>setDraft({...draft,theme:event.target.value as SettingsType['theme']})}><option value="dark">{tr("深色")}</option><option value="light">{tr("浅色")}</option><option value="system">{tr("跟随系统")}</option></Select></Field><Field label={tr("并发任务数")} changed={draft.concurrency!==snapshot.settings.concurrency}><Select disabled={busy} value={draft.concurrency} onChange={event=>setDraft({...draft,concurrency:+event.target.value})}>{[1,2,3,4].map(value=><option key={value} value={value}>{value}</option>)}</Select></Field></div>
      <Button variant="ghost" size="sm" onClick={()=> run(()=>window.muxivra.reveal(snapshot.dataPath))}><FolderOpen size={15}/>{tr("打开配置目录")}</Button>
      <Button variant="secondary" size="sm" disabled={busy} onClick={()=>setShortcutDetails(true)}>{tr("编辑快捷键")}{JSON.stringify(draft.shortcuts)!==JSON.stringify(snapshot.settings.shortcuts)&&<small className="setting-marker">{tr("未保存")}</small>}</Button>
    </Card></div>
    <Card title="MCP" aside={<label className={`switch-label ${changed('enabled')?'setting-changed':''}`}><input type="checkbox" aria-label={tr("启用 MCP")} checked={draft.mcp.enabled} onChange={event=>patchMcp({enabled:event.target.checked})}/>{tr("启用 MCP")}{changed('enabled')&&<small className="setting-marker">{tr("未保存")}</small>}</label>}>
      <div className="mcp-status"><span className={snapshot.mcp.running?'status status-completed':'tag'}>{snapshot.mcp.running?tr("运行中"):tr("未开启")}</span>{snapshot.mcp.running&&<code>{snapshot.mcp.url}</code>}{snapshot.mcp.error&&<p className="error-inline">{snapshot.mcp.error}</p>}</div>
      <div className="mcp-settings-grid"><div className="mcp-access-card"><strong>{tr("目录与权限")}</strong><Field label={tr("端口")} changed={changed('port')}><Input type="number" min={1024} max={65535} value={draft.mcp.port} onChange={event=>patchMcp({port:+event.target.value})}/></Field>
        {(['inputRoots','outputRoots'] as const).map(kind=><div className={`root-section ${changed(kind)?'setting-changed':''}`} key={kind}><div className="card-heading"><span>{kind==='inputRoots'?tr("媒体目录"):tr("输出目录")}{changed(kind)&&<small className="setting-marker">{tr("未保存")}</small>}</span><Button variant="ghost" size="sm" onClick={()=> addRoot(kind)}><Plus size={14}/>{tr("添加")}</Button></div>{draft.mcp[kind].map(root=><div className="root-row" key={root}><span title={root}>{root}</span>{kind==='outputRoots'&&root===snapshot.defaultMcpOutputPath?<span className="tag">{tr("默认")}</span>:<Button variant="ghost" size="icon" aria-label={tr("移除目录 {0}",root)} onClick={()=>patchMcp({[kind]:draft.mcp[kind].filter(path=>path!==root)})}><X size={14}/></Button>}</div>)}{!draft.mcp[kind].length&&<p className="hint">{kind==='inputRoots'?tr("请手动添加媒体目录"):tr("默认 outputs 不可用，请添加输出目录")}</p>}</div>)}
        <div className="permission-list">{([['allowInspect',tr("分析与查询")],['allowSubmit',tr("提交任务")],['allowCancel',tr("暂停 / 继续 / 取消任务")],['allowSubtitleEdit',tr("编辑当前字幕工程")]] as const).map(([key,label])=><label key={key} className={changed(key)?'setting-changed':''}><input type="checkbox" aria-label={tr(label)} checked={!!draft.mcp[key]} onChange={event=>patchMcp({[key]:event.target.checked})}/>{tr(label)}{changed(key)&&<small className="setting-marker">{tr("未保存")}</small>}</label>)}</div>
      </div><McpSetup snapshot={snapshot} draft={draft} dirty={dirty} run={run} busy={busy} onResetCredentials={()=>{const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);patchMcp({token:Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('')})}}/></div>
    </Card>
    <SoftwareInfoCard {...appUpdate} snapshot={snapshot} autoUpdate={draft.autoUpdate!==false} changed={(draft.autoUpdate??true)!==(snapshot.settings.autoUpdate??true)} onAutoUpdate={value=>setDraft({...draft,autoUpdate:value})} run={run} busy={busy}/>
    {saveBar}
  </fieldset></div>
}
