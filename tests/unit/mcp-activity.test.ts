import { it,expect } from 'vitest'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpActivityStore,redactActivity } from '../../src/core/mcp/activity'
it('retains every operation in fifty-record pages, persists failures and marks unfinished work interrupted',async()=>{
  const root=await mkdtemp(join(tmpdir(),'muxivra-activity-'))
  try{const store=new McpActivityStore(root,()=>{});await store.initialize();const records=await Promise.all(Array.from({length:103},(_,index)=>store.begin({id:index,method:index%2?'tools/call':'tools/list',params:{name:'test',token:'secret'}})))
    await Promise.all(records.slice(0,102).map((record,index)=>store.finish(record,index===2?'failed':'succeeded',{result:index})))
    const first=await store.page(1),last=await store.page(3);expect(first).toMatchObject({page:1,pages:3,total:103});expect(first.records).toHaveLength(50);expect(last.records.map(item=>item.sequence)).toEqual([2,1,0]);expect(last.records[0].status).toBe('failed');expect(JSON.stringify(first)).not.toContain('secret')
    const reopened=new McpActivityStore(root,()=>{});await reopened.initialize();expect((await reopened.page()).records[0].status).toBe('interrupted');expect((await reopened.page(3)).total).toBe(103)
  }finally{await rm(root,{recursive:true,force:true})}
})
it('redacts credential fields and signed URLs and bounds long content',()=>{
  const result=JSON.stringify(redactActivity({authorization:'Bearer secret',nested:{apiKey:'private',url:'https://user:pass@example.org/file?token=secret'},text:'x'.repeat(20000)}));expect(result).not.toMatch(/private|user:pass|token=secret|Bearer secret/);expect(result.length).toBeLessThan(8500)
})
