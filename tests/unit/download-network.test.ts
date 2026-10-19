import { afterEach,describe,it,expect,vi } from 'vitest'
import { configureDownloadTransport,fetchDownload,explainDownloadError,downloadProcessNetwork,checkDownloadNetwork } from '../../src/core/download-network'

afterEach(()=>{configureDownloadTransport();vi.restoreAllMocks();vi.useRealTimers()})
const signal=()=>new AbortController().signal
describe('download network',()=>{
  it('preserves nested connection failures and endpoint but redacts URL credentials and signed queries',()=>{
    const error=new TypeError('fetch failed',{cause:new AggregateError([Object.assign(new Error('connect failed https://user:secret@example.org/file?token=private'),{code:'ECONNREFUSED'})])})
    const explained=explainDownloadError(error,'https://u:password@github.com/uv.zip?signature=secret','部署组件下载').message
    expect(explained).toContain('ECONNREFUSED');expect(explained).toContain('https://github.com/uv.zip');expect(explained).not.toMatch(/password|private|secret|signature/)
    expect(explainDownloadError(Object.assign(new Error('disk denied'),{code:'EACCES'}),'https://example.org','model').message).toBe('disk denied')
  })
  it('uses the injected native stack, retries transient connection failures and reports retries',async()=>{
    vi.useFakeTimers();const request=vi.fn().mockRejectedValueOnce(new TypeError('fetch failed',{cause:{code:'ECONNRESET'}})).mockResolvedValueOnce(new Response('verified')),retries:string[]=[]
    configureDownloadTransport({name:'native fixture',request})
    const task=fetchDownload('https://example.org/model',{signal:signal(),label:'model',onRetry:message=>retries.push(message)})
    await vi.advanceTimersByTimeAsync(500);expect(await(await task).text()).toBe('verified');expect(request).toHaveBeenCalledTimes(2);expect(retries).toHaveLength(1);expect(request.mock.calls[0][1]).toMatchObject({credentials:'omit'})
  })
  it('does not retry certificate failures or HTTP 403 and provides actionable causes',async()=>{
    const request=vi.fn().mockRejectedValue(new TypeError('fetch failed',{cause:{code:'CERT_HAS_EXPIRED'}}));configureDownloadTransport({name:'native fixture',request})
    await expect(fetchDownload('https://example.org',{signal:signal(),label:'model'})).rejects.toThrow('证书');expect(request).toHaveBeenCalledTimes(1)
    request.mockReset().mockResolvedValue(new Response('denied',{status:403}));await expect(fetchDownload('https://example.org',{signal:signal(),label:'model'})).rejects.toThrow('HTTP 403');expect(request).toHaveBeenCalledTimes(1)
  })
  it('cancels a pending connection and does not convert cancellation into a retry',async()=>{
    const controller=new AbortController(),request=vi.fn((_url,init:RequestInit)=>new Promise<Response>((_done,reject)=>init.signal!.addEventListener('abort',()=>reject(init.signal!.reason),{once:true})));configureDownloadTransport({name:'native fixture',request})
    const task=fetchDownload('https://example.org',{signal:controller.signal,label:'model'});controller.abort(new Error('user cancelled'))
    await expect(task).rejects.toThrow('user cancelled');expect(request).toHaveBeenCalledTimes(1)
  })
  it('passes the system proxy only to the deployment worker and preserves explicit proxy variables',async()=>{
    const resolveProxy=vi.fn().mockResolvedValue('PROXY 127.0.0.1:7890; DIRECT');configureDownloadTransport({name:'native fixture',request:vi.fn(),resolveProxy})
    const result=await downloadProcessNetwork('https://github.com',{});expect(result.env).toMatchObject({HTTPS_PROXY:'http://127.0.0.1:7890',HTTP_PROXY:'http://127.0.0.1:7890'})
    expect((await downloadProcessNetwork('https://github.com',{HTTPS_PROXY:'http://explicit:8000'})).env).toEqual({});expect(resolveProxy).toHaveBeenCalledTimes(1)
    resolveProxy.mockResolvedValue('DIRECT; PROXY 127.0.0.1:7890');expect((await downloadProcessNetwork('https://github.com',{})).env).toEqual({})
    resolveProxy.mockResolvedValue('SOCKS5 127.0.0.1:7891');expect((await downloadProcessNetwork('https://github.com',{})).env.HTTPS_PROXY).toBe('socks5h://127.0.0.1:7891')
  })
  it('diagnoses fixed official endpoints with HEAD without downloading large model bodies',async()=>{
    const request=vi.fn().mockResolvedValue(new Response(null,{status:200}));configureDownloadTransport({name:'Windows test stack',request})
    const report=await checkDownloadNetwork();expect(report.transport).toBe('Windows test stack');expect(report.checks).toHaveLength(8);expect(report.checks.every(check=>check.ok)).toBe(true);expect(request.mock.calls.every(call=>call[1].method==='HEAD')).toBe(true)
  })
  it('reports the failed redirect hop instead of blaming the original GitHub endpoint',async()=>{
    configureDownloadTransport({name:'native trace fixture',request:vi.fn(),trace:async url=>({hops:[{url,status:302,proxy:'DIRECT',addresses:['192.0.2.10']},{url:'https://release-assets.githubusercontent.com/asset',proxy:'PROXY 127.0.0.1:7890'}],error:'net::ERR_CONNECTION_REFUSED'})})
    const report=await checkDownloadNetwork();expect(report.checks[0].message).toContain('https://release-assets.githubusercontent.com/asset');expect(report.checks[0].route?.hops).toHaveLength(2);expect(report.checks[0].ok).toBe(false)
  })
})
