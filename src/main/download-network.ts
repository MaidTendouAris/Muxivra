import { session,net,type Session } from 'electron'
import { configureDownloadTransport,safeDownloadUrl } from '../core/download-network'
import type { DownloadNetworkRoute } from '../shared/download-network'

// HEAD only: record each redirect without reading multi-GB response bodies.
// Chromium fetch's Response.url does not reliably expose the final URL.
export async function traceDownloadRoute(downloads:Session,url:string,signal:AbortSignal):Promise<DownloadNetworkRoute>{
  const route:DownloadNetworkRoute={hops:[{url:safeDownloadUrl(url)}]}
  await new Promise<void>(done=>{
    const request=net.request({url,method:'HEAD',session:downloads,redirect:'manual',credentials:'omit'});let finished=false
    const finish=(error?:string)=>{if(finished)return;finished=true;route.error=error;signal.removeEventListener('abort',abort);request.abort();done()}
    const abort=()=>finish('下载连接超时')
    request.on('redirect',(status,_method,target)=>{
      route.hops.at(-1)!.status=status
      if(route.hops.length>=10||!target.startsWith('https://')){finish('下载重定向次数过多或目标不是 HTTPS');return}
      route.hops.push({url:safeDownloadUrl(target)});request.followRedirect()
    })
    request.on('response',response=>{route.status=response.statusCode;route.hops.at(-1)!.status=response.statusCode;finish()})
    request.on('error',error=>finish(error.message))
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();else request.end()
  })
  await Promise.all(route.hops.map(async hop=>{
    // PAC/DNS diagnostics are bounded separately, and do not select a different
    // route or overwrite the user's Windows proxy settings.
    const bound=async<T>(work:Promise<T>)=>{let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('查询超时')),3000)})])}finally{clearTimeout(timer!)}}
    const [proxy,host]=await Promise.allSettled([bound(downloads.resolveProxy(hop.url)),bound(downloads.resolveHost(new URL(hop.url).hostname))])
    if(proxy.status==='fulfilled')hop.proxy=proxy.value.replace(/https?:\/\/[^\s;]+/g,safeDownloadUrl).replace(/[^\s;]+@/g,'[已隐藏凭据]@');else hop.proxy='无法读取系统代理'
    if(host.status==='fulfilled')hop.addresses=host.value.endpoints.map(endpoint=>endpoint.address);else hop.lookupError=String(host.reason?.message??host.reason).slice(0,200)
  }))
  return route
}

export function initializeDownloadNetworking(){
  // Non-persistent session: no multi-GB model bodies cached in userData on C:.
  const downloads=session.fromPartition('muxivra-downloads',{cache:false})
  configureDownloadTransport({name:'Windows 系统网络（Chromium，无磁盘下载缓存）',request:(url,init)=>downloads.fetch(url,init),resolveProxy:url=>downloads.resolveProxy(url),trace:(url,signal)=>traceDownloadRoute(downloads,url,signal)})
}
