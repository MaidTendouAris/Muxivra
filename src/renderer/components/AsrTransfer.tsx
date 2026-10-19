import { tr } from '../lib/i18n'
import { X,Copy } from 'lucide-react'
import type { AsrState } from '../../shared/asr'
import type { RunAction } from './Jobs'
import { Button,Busy,Progress } from './ui'
import { formatBytes } from '../lib/utils'
export function AsrTransfer({state,run}:{state?:AsrState;run:RunAction}){
  const value=state?.download,deployment=state?.deployment,showDeployment=deployment&&deployment.phase!=='idle',showDownload=value&&value.phase!=='idle'&&(!showDeployment||value.active)
  if(!showDeployment&&!showDownload)return null
  return <div className="asr-transfer-stack">{showDeployment&&<div className="inner-card asr-deployment-state" role="status" aria-label={tr("NVIDIA 部署状态")} aria-busy={deployment.active}><div className="toolbar">{deployment.active?<Busy text={deployment.message}/>:<strong className={deployment.phase==='failed'?'error-inline':''}>{deployment.message}</strong>}{deployment.active&&<Button variant="ghost" size="sm" onClick={()=>run(()=>window.muxivra.asrCancelDeployment())}><X size={15}/>{tr("取消部署")}</Button>}</div>{deployment.logTail&&<details><summary>{tr("部署日志")}</summary><pre className="code-box asr-deployment-log">{deployment.logTail}</pre></details>}{!deployment.active&&<Button variant="ghost" size="sm" onClick={()=>run(async()=>window.muxivra.copyText(await window.muxivra.asrDeploymentLog()),tr("部署日志已复制"))}><Copy size={15}/>{tr("复制完整部署日志")}</Button>}</div>}{showDownload&&<div className="inner-card asr-download-state" role="status">{value.active?<Busy text={tr(value.label)}/>:<strong className={value.phase==='failed'?'error-inline':''}>{value.message}</strong>}{value.active&&<><Progress value={value.percent}/><div className="toolbar"><span>{value.total?formatBytes(value.received)+' / '+formatBytes(value.total)+' · '+value.percent.toFixed(1)+'%':value.message}</span>{!deployment?.active&&<Button variant="ghost" size="sm" onClick={()=>run(()=>window.muxivra.asrCancelDownload())}><X size={15}/>{tr("取消操作")}</Button>}</div><small className="hint path-text">{value.message}</small></>}</div>}</div>
}
