import { tr } from '../lib/i18n'
import { Copy } from 'lucide-react'
import type { DownloadNetworkReport } from '../../shared/download-network'
import type { RunAction } from './Jobs'
import { Button,Card } from './ui'

export function DownloadNetworkStatus({report,run}:{report:DownloadNetworkReport;run:RunAction}){
  return <Card title={tr("下载网络检查")} aside={<Button variant="ghost" size="sm" onClick={()=>run(()=>window.muxivra.copyText(JSON.stringify(report,null,2)),tr("网络诊断已复制"))}><Copy size={15}/>{tr("复制诊断")}</Button>}><p className="hint">{report.transport} {tr("· HEAD 检查下载入口与重定向，不下载模型权重。GitHub 工具失败时可自动使用官方 PyPI；Qwen 模型可使用官方 ModelScope。")}</p><div className="asr-network-checks">{report.checks.map(check=><article key={check.url} className="inner-card"><div className="card-heading"><strong>{check.name}</strong><span className={check.ok?'tag':'error-inline'}>{check.ok?tr("可连接"):tr("连接失败")} · {(check.elapsedMs/1000).toFixed(1)}s</span></div><p className="path-text">{check.url}</p>{!check.ok&&<p className="error-inline">{check.message.split('\n')[0].replace(check.name+'：','')}</p>}<details><summary>{check.route?tr("连接路径与详情"):tr("错误详情")}</summary>{!check.ok&&<p className="error-inline asr-network-error">{check.message}</p>}{check.route?.hops.map((hop,index)=><div key={index} className="asr-network-route"><strong>{index+1}. {hop.status?`HTTP ${hop.status}`:tr("未收到响应")}</strong><p className="path-text">{hop.url}</p><p className="hint">{tr("代理：")}{hop.proxy??tr("未读取")}</p><p className="hint">{tr("本机 DNS：")}{hop.addresses?.join('，')||hop.lookupError||tr("未读取")}</p></div>)}</details></article>)}</div><p className="hint">{tr("同一网络下，各设备的代理、DNS 与防火墙仍可能不同。本机 DNS 结果不代表代理服务器使用的地址。入口可连接不代表所有权重 CDN 均可访问；MOSS 仍需连接 Hugging Face。")}</p></Card>
}
