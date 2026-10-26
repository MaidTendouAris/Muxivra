import { resolveDownloadSource } from './download-sources'
import { setTimeout as delay } from 'node:timers/promises'
import type { DownloadNetworkReport,DownloadNetworkRoute } from '../shared/download-network'

interface DownloadTransport {request:(url:string,init:RequestInit)=>Promise<Response>;resolveProxy?:(url:string)=>Promise<string>;trace?:(url:string,signal:AbortSignal)=>Promise<DownloadNetworkRoute>;name:string}
let transport:DownloadTransport|undefined
export function configureDownloadTransport(value?:DownloadTransport){const previous=transport;transport=value;return ()=>{transport=previous}}
export function safeDownloadUrl(value:string){try{const url=new URL(value);return url.origin+url.pathname}catch{return '[无效下载地址]'}}
function errorDetails(error:unknown):string {
  const seen=new Set<unknown>(),parts:string[]=[]
  const visit=(value:unknown,depth=0)=>{if(!value||seen.has(value)||depth>5)return;seen.add(value);if(typeof value==='object'){const e=value as {name?:string;code?:string;message?:string;cause?:unknown;errors?:unknown[]};if(e.name&&e.name!=='Error')parts.push(e.name);if(e.code)parts.push(e.code);if(e.message)parts.push(e.message);visit(e.cause,depth+1);for(const child of e.errors??[])visit(child,depth+1)}else parts.push(String(value))}
  visit(error)
  return [...new Set(parts)].join(' · ').replace(/https?:\/\/[^\s)"']+/gi,url=>safeDownloadUrl(url)).replace(/[\r\n\x00-\x1f]+/g,' ').slice(0,1400)
}
class DownloadFailure extends Error {constructor(message:string,readonly retryable:boolean){super(message)}}
// Alternate publisher channels are for connectivity failures, never integrity,
// certificate, filesystem, schema, or explicit cancellation errors.
export function canUseDownloadFallback(error:unknown){return error instanceof DownloadFailure&&error.retryable}
export function explainDownloadError(error:unknown,url:string,label:string):Error {
  if(error instanceof DownloadFailure)return error
  const details=errorDetails(error)
  if(!/fetch failed|net::|ERR_(?:NAME|CONNECTION|PROXY|TUNNEL|CERT|TIMED|NETWORK|INTERNET|HTTP|SSL)|ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|UND_ERR_|CERT_|TLS|certificate|terminated|TimeoutError|下载连接超时/i.test(details))return error instanceof Error?error:new Error(details)
  const certificate=/CERT|TLS|certificate|SSL/i.test(details),dns=/ENOTFOUND|EAI_AGAIN|ERR_NAME/i.test(details),proxy=/PROXY|TUNNEL/i.test(details),timeout=/TIMEOUT|TIMEDOUT|TIMED_OUT|超时/i.test(details)
  const hint=certificate?'TLS 证书验证失败，请检查系统时间、Windows 根证书及代理证书。':dns?'域名解析失败，请检查该设备的 DNS。':proxy?'代理连接失败，请检查此设备的 Windows 系统代理。':timeout?'连接超时，请检查此设备到下载源的网络和代理。':'连接下载源失败，请检查此设备的网络、系统代理或防火墙。'
  return new DownloadFailure(`${label}：${hint}\n地址：${safeDownloadUrl(url)}\n原因：${details}`,!certificate)
}
export async function fetchDownload(url:string,options:{signal:AbortSignal;label:string;timeoutMs?:number;method?:'GET'|'HEAD';attempts?:number;onRetry?:(message:string)=>void}):Promise<Response>{
  url=resolveDownloadSource(url)
  const {signal,label}=options,deadline=AbortSignal.any([signal,AbortSignal.timeout(options.timeoutMs??7200000)]),attempts=options.attempts??3
  for(let attempt=1;;attempt++){
    deadline.throwIfAborted()
    const connect=new AbortController(),timer=setTimeout(()=>connect.abort(new DOMException('下载连接超时','TimeoutError')),Math.min(30000,options.timeoutMs??30000))
    try{
      const response=await (transport?.request??((address,init)=>fetch(address,init)))(url,{method:options.method??'GET',signal:AbortSignal.any([deadline,connect.signal]),credentials:'omit'})
      if(!response.ok){await response.body?.cancel().catch(()=>{});const hint=response.status===407?'代理需要身份验证。':response.status===403?'下载源拒绝访问，请检查代理或网络访问策略。':response.status===404?'官方资源不存在。':'下载源返回错误。';throw new DownloadFailure(`${label}：${hint} HTTP ${response.status}\n地址：${safeDownloadUrl(url)}`,[408,429,500,502,503,504].includes(response.status))}
      return response
    }catch(error){
      if(signal.aborted)throw signal.reason
      const failure=explainDownloadError(deadline.aborted?deadline.reason:connect.signal.aborted?connect.signal.reason:error,url,label)
      if(attempt>=attempts||deadline.aborted||!(failure instanceof DownloadFailure)||!failure.retryable)throw failure
      options.onRetry?.(`${label}连接失败，正在重试（${attempt+1}/${attempts}）…`)
      await delay(attempt*500,undefined,{signal:deadline})
    }finally{clearTimeout(timer)}
  }
}
/** Translate the system proxy for a deployment step into uv's process-local env.
 * Explicit proxy variables keep precedence. Never modify Windows or user env.
 */
export async function downloadProcessNetwork(url:string,environment:NodeJS.ProcessEnv):Promise<{env:NodeJS.ProcessEnv;summary:string}>{
  if(['HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy'].some(key=>environment[key]))return {env:{},summary:'使用进程环境中的代理设置'}
  if(!transport?.resolveProxy)return {env:{},summary:'使用当前进程网络设置'}
  const rules=await transport.resolveProxy(url),first=rules.split(';').map(value=>value.trim()).find(Boolean)
  if(!first||first==='DIRECT')return {env:{},summary:'Windows 系统代理：此下载源直连'}
  const match=/^(PROXY|HTTPS|SOCKS5|SOCKS)\s+([^\s;]+)$/i.exec(first)
  if(!match)throw new Error('无法将此系统代理规则用于依赖安装，请使用固定 HTTP/HTTPS 代理或设置 HTTPS_PROXY。')
  const scheme=match[1]==='HTTPS'?'https':/^SOCKS/i.test(match[1])?'socks5h':'http',proxy=`${scheme}://${match[2]}`
  new URL(proxy)
  return {env:{HTTPS_PROXY:proxy,HTTP_PROXY:proxy,ALL_PROXY:proxy},summary:'依赖安装使用 Windows 系统代理'}
}
const diagnosticSources=[
  ['GitHub 部署工具','https://github.com/astral-sh/uv/releases/download/0.13.1/uv-x86_64-pc-windows-msvc.zip'],
  ['Astral 官方 PyPI 部署工具（备用）','https://files.pythonhosted.org/packages/2a/8e/d23278bb327d2a75dc1d033c81b7fe23bbb28e363e02e7f306abd047924a/uv-0.13.1-py3-none-win_amd64.whl'],
  ['Astral Python 运行时','https://releases.astral.sh/github/python-build-standalone/releases/download/20260807/cpython-3.12.13%2B20260807-x86_64-pc-windows-msvc-install_only_stripped.tar.gz'],
  ['GitHub 源码','https://codeload.github.com/OpenMOSS/MOSS-Transcribe-Diarize/zip/e3bdd93f8ad58418e04659818efd5fd87a0bc486'],
  ['PyPI 依赖','https://pypi.org/simple/qwen-asr/'],
  ['PyTorch CUDA 依赖','https://download.pytorch.org/whl/torch/'],
  ['Hugging Face 模型清单','https://huggingface.co/api/models/Qwen/Qwen3-ASR-0.6B'],
  ['Qwen 官方 ModelScope 模型（备用）','https://modelscope.cn/models/Qwen/Qwen3-ASR-0.6B/resolve/3b885f72b1733a6a50dc17a597fb4135c3d656a0/config.json'],
] as const
let checking:Promise<DownloadNetworkReport>|undefined
export function checkDownloadNetwork():Promise<DownloadNetworkReport>{
  if(checking)return checking
  checking=(async()=>({checkedAt:new Date().toISOString(),transport:transport?.name??'Node.js HTTP',checks:await Promise.all(diagnosticSources.map(async([name,originalUrl])=>{
    const url=resolveDownloadSource(originalUrl)
    const start=Date.now();let route:DownloadNetworkRoute|undefined
    try{
      if(transport?.trace){route=await transport.trace(url,AbortSignal.timeout(15000));if(route.error)throw explainDownloadError(new Error(route.error),route.hops.at(-1)?.url??url,name);if(!route.status||route.status<200||route.status>=300)throw new Error(`${name}：HTTP ${route.status??'无响应'}`);return {name,url,ok:true,elapsedMs:Date.now()-start,message:`HTTP ${route.status}`,route}}
      const response=await fetchDownload(url,{signal:new AbortController().signal,label:name,method:'HEAD',timeoutMs:15000,attempts:1});await response.body?.cancel();return {name,url,ok:true,elapsedMs:Date.now()-start,message:`HTTP ${response.status}`}
    }catch(error){return {name,url,ok:false,elapsedMs:Date.now()-start,message:(error as Error).message,route}}
  }))}))().finally(()=>{checking=undefined})
  return checking
}
