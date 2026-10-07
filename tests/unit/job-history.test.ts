import { describe,it,expect,vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp,mkdir,writeFile,readFile,readdir,rm } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import type { Job,JobRequest,Plan } from '../../src/shared/types'
import { JobQueue } from '../../src/core/jobs/queue'
import { JobHistoryStore } from '../../src/core/jobs/history'
import { isWithin } from '../../src/core/media/paths'

const plan=(root:string,name='out.m4a'):Plan=>({input:{path:join(root,'input.wav'),name:'input.wav',durationMs:2000,size:100,format:'wav',streams:[{index:0,type:'audio',codec:'pcm_s16le'}]},outputPath:join(root,name),options:{container:'m4a',video:'none',audio:'aac',quality:22,speed:'medium',audioBitrate:192,subtitles:'none',conflict:'reject'},engine:{id:'engine',ffmpegPath:'ffmpeg',ffprobePath:'ffprobe',version:'test',source:'path',encoders:['aac'],decoders:['pcm_s16le'],filters:['volume'],detectedAt:'2026-10-07T00:00:00Z'},args:[],warnings:[]})
const fixture=(root:string,index:number):Job=>({id:randomUUID(),plan:plan(root,`out-${index}.m4a`),source:'gui',status:'completed',createdAt:new Date(index*1000).toISOString(),startedAt:new Date(index*1000).toISOString(),finishedAt:new Date(index*1000+900).toISOString(),elapsedMs:900,progress:100,processedMs:2000,speed:'2x',logPath:'',logTail:'',temporaryPath:''})
async function local(task:(root:string)=>Promise<void>){await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data','history-'));try{await task(root)}finally{if(isWithin(resolve('.test-data'),root))await rm(root,{recursive:true,force:true})}}

describe('分页任务历史',()=>{
  it('迁移旧记录，每页最多 50 条，保留最近 1000 条结束记录和所有未完成任务',async()=>local(async root=>{
    const records=Array.from({length:1006},(_,i)=>fixture(root,i)),queued={...fixture(root,1007),status:'queued' as const,finishedAt:undefined},paused={...fixture(root,1008),status:'paused' as const,pausedFrom:'queued' as const,finishedAt:undefined}
    await mkdir(join(root,'logs'));await writeFile(join(root,'logs',`${records[0].id}.log`),'old');await writeFile(join(root,'input.wav'),'input');await writeFile(records[0].plan.outputPath,'output')
    await writeFile(join(root,'jobs.json'),JSON.stringify([...records,queued,paused]))
    const queue=new JobQueue(root);queue.concurrency=0;await queue.initialize()
    expect(queue.jobs).toHaveLength(1002);expect(queue.jobs[0].id).toBe(records[6].id);expect(queue.get(queued.id).status).toBe('queued');expect(queue.get(paused.id).status).toBe('paused')
    const index=JSON.parse(await readFile(join(root,'job-history','index.json'),'utf8'));expect(index.pageSize).toBe(50);expect(index.pages).toHaveLength(21)
    for(const name of index.pages)expect(JSON.parse(await readFile(join(root,'job-history',name),'utf8')).jobs.length).toBeLessThanOrEqual(50)
    expect(await new JobHistoryStore(root).read()).toHaveLength(1002)
    await expect(readFile(join(root,'jobs.json'))).rejects.toThrow();await expect(readFile(join(root,'logs',`${records[0].id}.log`))).rejects.toThrow()
    expect(await readFile(records[0].plan.outputPath,'utf8')).toBe('output');expect(await readFile(join(root,'input.wav'),'utf8')).toBe('input')
    expect(queue.list(true)[0].plan.engine.encoders).toEqual([]);expect(queue.get(records[6].id).plan.engine.encoders).toEqual(['aac'])
  }))
  it('批量删除先验证所有状态，删除记录和自己的日志而保留媒体及其他路径',async()=>local(async root=>{
    const done=fixture(root,0),active={...fixture(root,1),status:'queued' as const},outside=join(root,'keep.log')
    done.logPath=outside;await writeFile(outside,'private');await writeFile(done.plan.outputPath,'output');await writeFile(done.plan.input.path,'input')
    await writeFile(join(root,'jobs.json'),JSON.stringify([done,active]));const queue=new JobQueue(root);queue.concurrency=0;await queue.initialize();await writeFile(join(root,'logs',`${done.id}.log`),'owned')
    await expect(queue.deleteRecords([done.id,active.id])).rejects.toThrow('只能删除');expect(queue.jobs).toHaveLength(2)
    expect(await queue.deleteRecords([done.id,done.id])).toBe(1);expect(await new JobHistoryStore(root).read()).toHaveLength(1)
    await expect(readFile(join(root,'logs',`${done.id}.log`))).rejects.toThrow();expect(await readFile(outside,'utf8')).toBe('private');expect(await readFile(done.plan.outputPath,'utf8')).toBe('output');expect(await readFile(done.plan.input.path,'utf8')).toBe('input')
  }))
  it('部分批次删除后拒绝不完整的重试去重，重启后仍保持此行为',async()=>local(async root=>{
    const queue=new JobQueue(root);queue.concurrency=0;await queue.initialize();const requests:JobRequest[]=['a','b'].map(name=>({inputPath:join(root,'input.wav'),outputPath:join(root,`${name}.m4a`),options:plan(root).options}))
    const jobs=await queue.submit(requests,'mcp','batch',async r=>({...plan(root),outputPath:r.outputPath}));for(const job of jobs)await queue.cancel(job.id)
    await queue.deleteRecords([jobs[0].id]);await expect(queue.submit(requests,'mcp','batch',async()=>plan(root))).rejects.toThrow('部分历史')
    const restarted=new JobQueue(root);restarted.concurrency=0;await restarted.initialize();await expect(restarted.submit(requests,'mcp','batch',async()=>plan(root))).rejects.toThrow('部分历史')
    expect(await restarted.submit(requests,'mcp','new-batch',async r=>({...plan(root),outputPath:r.outputPath}))).toHaveLength(2)
  }))
  it('完整日志按段读取，不截断开头和 Unicode 字符',async()=>local(async root=>{
    const job=fixture(root,0);await writeFile(join(root,'jobs.json'),JSON.stringify([job]));const queue=new JobQueue(root);await queue.initialize()
    const text='日志开始\n'+('你好🙂处理记录\n'.repeat(18000))+'日志结束';await writeFile(join(root,'logs',`${job.id}.log`),text)
    let offset=0,result='',pages=0;while(true){const page=await queue.logPage(job.id,offset);result+=page.text;pages++;if(!page.hasMore)break;expect(page.nextOffset).toBeGreaterThan(offset);offset=page.nextOffset}
    expect(pages).toBeGreaterThan(3);expect(result).toBe(text);expect(await queue.log(job.id)).toBe(text);await expect(queue.logPage(job.id,-1)).rejects.toThrow('日志位置')
  }))
  it('索引提交失败时旧分页仍可读取，成功重试后清理旧分页',async()=>local(async root=>{
    const store=new JobHistoryStore(root),first=fixture(root,0),second=fixture(root,1);await store.write([first])
    const index=(store as unknown as {index:{write:()=>Promise<void>}}).index;vi.spyOn(index,'write').mockRejectedValueOnce(new Error('disk failure'))
    await expect(store.write([second])).rejects.toThrow('disk failure');expect((await store.read())[0].id).toBe(first.id)
    await store.write([second]);expect((await store.read())[0].id).toBe(second.id);expect((await readdir(join(root,'job-history'))).filter(name=>name.startsWith('page-'))).toHaveLength(1)
  }))
  it('删除保存失败时恢复记录和批次去重状态，日志仍保留',async()=>local(async root=>{
    const queue=new JobQueue(root);queue.concurrency=0;await queue.initialize()
    const requests:JobRequest[]=['a','b'].map(name=>({inputPath:join(root,'input.wav'),outputPath:join(root,`${name}.m4a`),options:plan(root).options}))
    const jobs=await queue.submit(requests,'mcp','batch',async r=>({...plan(root),outputPath:r.outputPath}));for(const job of jobs)await queue.cancel(job.id)
    await writeFile(join(root,'logs',`${jobs[0].id}.log`),'retained')
    const store=(queue as unknown as {store:JobHistoryStore}).store;vi.spyOn(store,'write').mockRejectedValueOnce(new Error('disk failure'))
    await expect(queue.deleteRecords([jobs[0].id])).rejects.toThrow('disk failure')
    expect(queue.jobs).toHaveLength(2);expect(await new JobHistoryStore(root).read()).toHaveLength(2)
    expect((await queue.submit(requests,'mcp','batch',async()=>plan(root))).map(j=>j.id)).toEqual(jobs.map(j=>j.id))
    expect(await readFile(join(root,'logs',`${jobs[0].id}.log`),'utf8')).toBe('retained')
  }))
  it('旧记录缺失处理时长时保留未知，不能显示为零耗时',async()=>local(async root=>{
    const old={...fixture(root,0),elapsedMs:undefined};await writeFile(join(root,'jobs.json'),JSON.stringify([old]))
    const queue=new JobQueue(root);await queue.initialize();expect(queue.get(old.id).elapsedMs).toBeUndefined();expect(queue.list(true)[0].elapsedMs).toBeUndefined()
  }))
  it('提交尚未持久保存时，其他任务触发调度也不能提前启动新任务',async()=>local(async root=>{
    const queue=new JobQueue(root);queue.concurrency=1;await queue.initialize()
    const store=(queue as unknown as {store:JobHistoryStore}).store,original=store.write.bind(store)
    let release!:()=>void,entered!:()=>void
    const gate=new Promise<void>(resolve=>{release=resolve}),ready=new Promise<void>(resolve=>{entered=resolve})
    vi.spyOn(store,'write').mockImplementationOnce(async jobs=>{entered();await gate;await original(jobs)})
    const submission=queue.submit([{inputPath:join(root,'input.wav'),outputPath:join(root,'out.m4a'),options:plan(root).options}],'gui',undefined,async()=>plan(root))
    try{await ready;queue.start();expect(queue.jobs[0].status).toBe('queued');expect(queue.jobs[0].startedAt).toBeUndefined();release();expect((await submission)[0].status).toBe('queued')}
    finally{release();await submission.catch(()=>{});await queue.shutdown()}
  }))
})
