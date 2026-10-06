import { useState, useEffect } from 'react'
import { FolderOpen, Download, Search, Check, Plus, X, RotateCcw } from 'lucide-react'
import type { Snapshot, Settings as SettingsType } from '../../shared/types'
import { APP_VERSION } from '../../shared/version'
import mpv from '../../../resources/mpv-manifest.json'
import { Button, Card, Field, Input, Select, Progress } from '../components/ui'
import type { RunAction } from '../components/Jobs'
import { SystemHardware, HardwareDetails } from '../components/SystemHardware'
import { McpSetup } from '../components/McpSetup'

export function Settings({snapshot,run,busy}:{snapshot:Snapshot;run:RunAction;busy:boolean}){
  const [draft,setDraft]=useState<SettingsType>(snapshot.settings),saved=JSON.stringify(snapshot.settings)
  const [hardwareDetails,setHardwareDetails]=useState(false)
  useEffect(()=>setDraft(snapshot.settings),[saved])
  const patchMcp=(patch:Partial<SettingsType['mcp']>)=>setDraft({...draft,mcp:{...draft.mcp,...patch}})
  const addRoot=(kind:'inputRoots'|'outputRoots')=>run(async()=>{const path=await window.muxivra.selectDirectory(kind==='inputRoots'?'mcp-input':'mcp-output');if(path&&!draft.mcp[kind].includes(path))patchMcp({[kind]:[...draft.mcp[kind],path]})})
  const dirty=JSON.stringify(draft)!==saved
  if(hardwareDetails)return <HardwareDetails snapshot={snapshot} run={run} busy={busy} onBack={()=>setHardwareDetails(false)}/>
  return <div className="settings-layout">
    <SystemHardware snapshot={snapshot} run={run} busy={busy} onDetails={()=>setHardwareDetails(true)}/>
    <Card title="转码引擎 · FFmpeg" aside={<span className={snapshot.engine?'status status-completed':'status status-failed'}>{snapshot.engine?'已就绪':'未配置'}</span>}>
      {snapshot.engine&&<div className="engine-current"><strong>{snapshot.engine.version}</strong><p className="path-text">{snapshot.engine.ffmpegPath}</p></div>}
      <div className="toolbar wrap"><Button variant="secondary" disabled={busy} onClick={()=> run(async()=>{if(!await window.muxivra.detectEngine())throw new Error('PATH 中未找到 FFmpeg 与 ffprobe')},'引擎已启用')}><Search size={16}/>检测 PATH</Button><Button variant="secondary" disabled={busy} onClick={()=> run(async()=>{const path=await window.muxivra.selectDirectory('engine');if(path)await window.muxivra.useEngine(path)},'引擎已启用')}><FolderOpen size={16}/>选择本地引擎</Button><Button disabled={busy||['downloading','verifying','extracting'].includes(snapshot.download.state)} onClick={()=> run(()=>window.muxivra.downloadEngine(),'引擎已启用')}><Download size={16}/>下载引擎</Button><span className="hint">Gyan 9.0.2 Essentials · 109 MB</span></div>
      {snapshot.download.state!=='idle'&&<div className="download-state"><Progress value={snapshot.download.percent}/><p className={snapshot.download.state==='failed'?'error-text':'hint'}>{snapshot.download.message}</p></div>}
      {snapshot.engines.length>1&&<details><summary>已添加的引擎 · {snapshot.engines.length}</summary><div className="engine-list">{snapshot.engines.map(engine=><div key={engine.id}><div><strong>{engine.version}</strong><p className="path-text">{engine.ffmpegPath}</p></div><Button variant="ghost" size="sm" disabled={busy||engine.id===snapshot.engine?.id} onClick={()=> run(()=>window.muxivra.useEngine(engine.id),'引擎已切换')}>{engine.id===snapshot.engine?.id?'当前':<><RotateCcw size={14}/>切换</>}</Button></div>)}</div></details>}
    </Card>
    <div className="settings-columns"><Card title="播放器"><div className="setting-value"><span>mpv</span><strong>{mpv.version}</strong></div><div className="setting-value"><span>来源</span><span>内置 · Windows x64</span></div></Card><Card title="外观与任务">
      <div className="form-grid"><Field label="界面主题"><Select value={draft.theme} onChange={event=>setDraft({...draft,theme:event.target.value as SettingsType['theme']})}><option value="dark">深色</option><option value="light">浅色</option><option value="system">跟随系统</option></Select></Field><Field label="并发任务数"><Select value={draft.concurrency} onChange={event=>setDraft({...draft,concurrency:+event.target.value})}>{[1,2,3,4].map(value=><option key={value} value={value}>{value}</option>)}</Select></Field></div>
      <Button variant="ghost" size="sm" onClick={()=> run(()=>window.muxivra.reveal(snapshot.dataPath))}><FolderOpen size={15}/>打开配置目录</Button>
    </Card></div>
    <Card title="MCP" aside={<label className="switch-label"><input type="checkbox" checked={draft.mcp.enabled} onChange={event=>patchMcp({enabled:event.target.checked})}/>启用 MCP</label>}>
      <div className="mcp-status"><span className={snapshot.mcp.running?'status status-completed':'tag'}>{snapshot.mcp.running?'运行中':'未开启'}</span>{snapshot.mcp.running&&<code>{snapshot.mcp.url}</code>}{snapshot.mcp.error&&<p className="error-inline">{snapshot.mcp.error}</p>}</div>
      <div className="mcp-settings-grid"><div className="mcp-access-card"><strong>目录与权限</strong><Field label="端口"><Input type="number" min={1024} max={65535} value={draft.mcp.port} onChange={event=>patchMcp({port:+event.target.value})}/></Field>
        {(['inputRoots','outputRoots'] as const).map(kind=><div className="root-section" key={kind}><div className="card-heading"><span>{kind==='inputRoots'?'媒体目录':'输出目录'}</span><Button variant="ghost" size="sm" onClick={()=> addRoot(kind)}><Plus size={14}/>添加</Button></div>{draft.mcp[kind].map(root=><div className="root-row" key={root}><span title={root}>{root}</span><Button variant="ghost" size="icon" aria-label={`移除目录 ${root}`} onClick={()=>patchMcp({[kind]:draft.mcp[kind].filter(path=>path!==root)})}><X size={14}/></Button></div>)}{!draft.mcp[kind].length&&<p className="hint">未授权</p>}</div>)}
        <div className="permission-list">{([['allowInspect','分析与查询'],['allowSubmit','提交任务'],['allowCancel','暂停 / 继续 / 取消任务']] as const).map(([key,label])=><label key={key}><input type="checkbox" checked={draft.mcp[key]} onChange={event=>patchMcp({[key]:event.target.checked})}/>{label}</label>)}</div>
      </div><McpSetup snapshot={snapshot} draft={draft} dirty={dirty} run={run} busy={busy} onResetCredentials={()=>{const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);patchMcp({token:Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('')})}}/></div>
    </Card>
    <div className="settings-save"><span className="hint">{dirty?'未保存':'已保存'} · {APP_VERSION}</span><Button disabled={!dirty||busy} onClick={()=> run(()=>window.muxivra.saveSettings(draft),'设置已保存')}><Check size={16}/>保存设置</Button></div>
  </div>
}
