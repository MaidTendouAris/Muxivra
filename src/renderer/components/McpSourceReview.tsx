import { useEffect,useState } from 'react'
import type { DownloadSourceState,DownloadSources } from '../../shared/download-sources'
import { officialSources,sourceKinds } from '../../shared/download-sources'
import { tr } from '../lib/i18n'
const chosen=(configuration:DownloadSources,kind:typeof sourceKinds[number])=>configuration.sources.find(item=>item.id===configuration.active[kind])?.url??officialSources[kind]
export function McpSourceReview({configuration,revision}:{configuration:DownloadSources;revision:string}) {
  const [current,setCurrent]=useState<DownloadSourceState>(),[error,setError]=useState('')
  useEffect(()=>{void window.muxivra.downloadSources().then(setCurrent).catch(error=>setError(error.message))},[revision])
  return <div className="request-inner-card"><strong>{tr('下载源变更需要本次人工确认')}</strong><p className="hint">{tr('批准后，部署和资源下载将访问下列域名。请核对镜像来源；此批准不授予 AI 自动更改下载源的权限。')}</p>{error&&<p className="error-inline">{error}</p>}{current&&current.revision!==revision&&<p className="error-inline">{tr('下载源已更改，此申请已过期，请拒绝并重新申请。')}</p>}<table className="file-table"><thead><tr><th>{tr('类型')}</th><th>{tr('当前地址')}</th><th>{tr('申请地址')}</th></tr></thead><tbody>{sourceKinds.map(kind=><tr key={kind}><td>{kind}</td><td className="path-text">{current?chosen(current.configuration,kind):'…'}</td><td className="path-text">{chosen(configuration,kind)}</td></tr>)}</tbody></table><details><summary>{tr('完整配置')}</summary><pre className="code-box">{JSON.stringify(configuration,null,2)}</pre></details></div>
}
