import { it,expect,afterEach,vi } from 'vitest'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadSourcesSchema,sourceUrl,officialSources,sourceKinds } from '../../src/shared/download-sources'
import { DownloadSourceStore,setDownloadSources } from '../../src/core/download-sources'
import { configureDownloadTransport,fetchDownload,checkDownloadNetwork } from '../../src/core/download-network'
const configuration=downloadSourcesSchema.parse({sources:[{id:'hf',name:'User HF',kind:'huggingface',url:'https://mirror.example/hf/'}],active:{huggingface:'hf'}})
afterEach(()=>{setDownloadSources(downloadSourcesSchema.parse({}));configureDownloadTransport()})
it('defaults to official sources and preserves the pinned path and query on a mirror',()=>{
  for(const kind of sourceKinds)expect(sourceUrl(officialSources[kind]+'/test',downloadSourcesSchema.parse({}))).toBe(officialSources[kind]+'/test')
  expect(sourceUrl('https://huggingface.co/api/models/Qwen/model/revision/abc?blobs=true',configuration)).toBe('https://mirror.example/hf/api/models/Qwen/model/revision/abc?blobs=true')
  expect(sourceUrl('https://huggingface.co.evil.test/file',configuration)).toBe('https://huggingface.co.evil.test/file')
  for(const url of ['http://mirror.example','https://user:pass@mirror.example','https://mirror.example?secret=1'])expect(()=>downloadSourcesSchema.parse({...configuration,sources:[{...configuration.sources[0],url}]})).toThrow()
})
it('persists source configuration with revision checks and rejects stale concurrent updates',async()=>{
  const root=await mkdtemp(join(tmpdir(),'muxivra-sources-'));try{const store=new DownloadSourceStore(join(root,'sources.json'),()=>{});await store.initialize();const revision=store.state().revision;const saved=await store.save(configuration,revision);expect(saved.revision).not.toBe(revision);await expect(store.save(downloadSourcesSchema.parse({}),revision)).rejects.toThrow('重新读取');const reopened=new DownloadSourceStore(join(root,'sources.json'),()=>{});await reopened.initialize();expect(reopened.state()).toEqual(saved)}finally{await rm(root,{recursive:true,force:true})}
})
it('routes downloads and native diagnostics to the same selected source',async()=>{
  setDownloadSources(configuration);const request=vi.fn(async(_url:string,_init:RequestInit)=>new Response(null,{status:200})),trace=vi.fn(async(url:string)=>({hops:[{url,status:200,proxy:'DIRECT'}],status:200}));configureDownloadTransport({name:'fixture',request,trace})
  await fetchDownload('https://huggingface.co/repo/resolve/abc/file',{signal:new AbortController().signal,label:'test'});expect(request.mock.calls[0][0]).toBe('https://mirror.example/hf/repo/resolve/abc/file')
  const report=await checkDownloadNetwork();expect(report.checks.find(item=>item.url.startsWith('https://mirror.example/hf/'))?.ok).toBe(true)
})
