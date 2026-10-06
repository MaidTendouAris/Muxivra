import { useEffect, useState } from 'react'
import { BookOpen, Copy, Eye, KeyRound } from 'lucide-react'
import type { McpSetupInfo, McpSkillDocument, Settings as SettingsType, Snapshot } from '../../shared/types'
import { buildMcpConnectionPrompt, mcpConfig } from '../../shared/mcp-connection'
import { Button, Modal } from './ui'
import type { RunAction } from './Jobs'

export function McpSetup({snapshot,draft,dirty,run,busy,onResetCredentials}:{snapshot:Snapshot;draft:SettingsType;dirty:boolean;run:RunAction;busy:boolean;onResetCredentials:()=>void}) {
  const [info,setInfo]=useState<McpSetupInfo>(),[error,setError]=useState(''),[preview,setPreview]=useState(false),[guide,setGuide]=useState<McpSkillDocument>(),[reveal,setReveal]=useState(false)
  useEffect(()=>{let live=true;window.muxivra.mcpSetupInfo().then(value=>{if(live)setInfo(value)}).catch(e=>{if(live)setError(String(e.message))});return()=>{live=false}},[])
  const config=mcpConfig(draft.mcp.port)
  const copy=()=>run(async()=>{
    if(!Number.isInteger(draft.mcp.port)||draft.mcp.port<1024||draft.mcp.port>65535)throw new Error('MCP 端口必须为 1024–65535 的整数')
    if(dirty)await window.muxivra.saveSettings(draft)
    await window.muxivra.copyMcpConnectionPrompt()
    return true
  },'完整连接提示词已复制')
  const copyText=(text:string,message:string)=>run(async()=>{await window.muxivra.copyText(text);return true},message)
  return <div className="mcp-connect-panel">
    <section className="mcp-connect-card">
      <div className="mcp-section-title"><Copy size={18}/><strong>连接 AI</strong></div>
      <p>复制完整提示词，发送给本机 AI 客户端完成配置和连接验证。</p>
      <Button disabled={busy||!draft.mcp.enabled||!info} loadingText="正在生成提示词…" onClick={copy}><Copy size={16}/>{dirty?'保存并复制完整连接提示词':'复制完整连接提示词'}</Button>
      <div className="mcp-copy-meta"><span>包含地址、凭据、目录、权限和内置指南入口</span>{info&&<Button variant="ghost" size="sm" onClick={()=>setPreview(true)}><Eye size={14}/>预览</Button>}</div>
      <p className="hint">提示词含连接凭据，仅发送给可信的 AI。客户端需要具备本机操作能力。</p>
      {!draft.mcp.enabled&&<p className="hint">添加授权目录并启用 MCP 后即可复制。</p>}
      {error&&<p className="error-inline">{error}</p>}
    </section>
    <section className="mcp-guides-card">
      <div className="mcp-section-title"><BookOpen size={18}/><strong>内置指南</strong><span className="tag">{info?.skills.length??6} 份 · 离线</span></div>
      <div className="mcp-guide-grid">{info?.skills.map(skill=><button key={skill.id} className="mcp-guide-button" disabled={busy} onClick={()=>run(async()=>setGuide(await window.muxivra.mcpReadSkill(skill.id)))}><strong>{skill.name}</strong><span>{skill.description}</span></button>)}</div>
      <p className="hint">AI 通过 list_skills / read_skill 按需读取；参数参考随应用定义生成。</p>
    </section>
    <details className="mcp-manual"><summary>手动配置与凭据</summary>
      <pre className="code-box">{config}</pre><div className="toolbar wrap"><Button variant="secondary" size="sm" onClick={()=>copyText(config,'已复制配置')}><Copy size={14}/>复制配置</Button><Button variant="ghost" size="sm" onClick={()=>setReveal(!reveal)}><KeyRound size={14}/>{reveal?'隐藏凭据':'显示凭据'}</Button></div>
      <pre className="code-box token-box">{reveal?draft.mcp.token:'••••••••••••••••••••••••••••••••'}</pre>
      <Button variant="secondary" size="sm" onClick={()=>copyText(`[Environment]::SetEnvironmentVariable('MUXIVRA_MCP_TOKEN', '${draft.mcp.token}', 'User')`,'凭据设置命令已复制')}><Copy size={14}/>复制凭据设置命令</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={onResetCredentials}>重置凭据</Button>
    </details>
    {preview&&info&&<Modal title="连接提示词预览" onClose={()=>setPreview(false)} className="mcp-document-modal"><p className="hint">凭据已隐藏。复制时使用保存成功的实际设置。</p><pre className="mcp-document">{buildMcpConnectionPrompt(draft.mcp,{...info,running:snapshot.mcp.running},true)}</pre></Modal>}
    {guide&&<Modal title={guide.name} onClose={()=>setGuide(undefined)} className="mcp-document-modal"><div className="toolbar"><span className="hint">内置指南 · {guide.version}</span><Button variant="secondary" size="sm" onClick={()=>copyText(guide.markdown,'指南已复制')}><Copy size={14}/>复制指南</Button></div><pre className="mcp-document">{guide.markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'')}</pre></Modal>}
  </div>
}
