import { describe,it,expect } from 'vitest'
import { mkdir,mkdtemp,rm,writeFile,readFile } from 'node:fs/promises'
import { resolve,join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mapAsrSegments,whisperOutput,asrSubtitleCues,asrOptionsSchema,asrUsesChunks,type AsrPlan } from '../../src/shared/asr'
import { JobQueue } from '../../src/core/jobs/queue'
import { JobHistoryStore } from '../../src/core/jobs/history'
import { AsrModels } from '../../src/core/asr/models'
import type { Job } from '../../src/shared/types'
import { isWithin } from '../../src/core/media/paths'
import { parseAss,serializeAss } from '../../src/core/subtitles/ass'
import { serializeSrt } from '../../src/core/subtitles/srt'
import { createSubtitleDocument } from '../../src/shared/subtitles'

describe('ASR 结果标准化',()=>{
  it('新提交默认整段，只有明确启用时分片；可自定义超过旧 600 秒限制的时长',()=>{
    const input={modelId:randomUUID(),inputPath:'input.wav',audioStream:0}
    expect(asrOptionsSchema.parse(input)).toMatchObject({chunkingEnabled:false,chunkSeconds:120})
    expect(asrOptionsSchema.parse({...input,chunkingEnabled:true,chunkSeconds:900})).toMatchObject({chunkingEnabled:true,chunkSeconds:900})
    for(const chunkSeconds of [0,-1,1.5,Infinity])expect(()=>asrOptionsSchema.parse({...input,chunkingEnabled:true,chunkSeconds})).toThrow()
    const legacy={chunkSeconds:120} as ReturnType<typeof asrOptionsSchema.parse>
    expect(asrUsesChunks(legacy)).toBe(true);expect(asrUsesChunks(asrOptionsSchema.parse({...input,...legacy}))).toBe(false)
  })
  it('按分块原点映射到原媒体时间并裁剪边界，保留文本与评分',()=>{
    const result=mapAsrSegments({segments:[{text:'  你好  ',startMs:100,endMs:1500,score:-0.8,words:[{text:'你好',startMs:100,endMs:800}]}]},30000,1000)
    expect(result[0]).toMatchObject({text:'你好',startMs:30100,endMs:31000,score:-0.8,words:[{text:'你好',startMs:30100,endMs:30800}]})
  })
  it('不为无时间戳结果或缺失评分伪造值，估算仅在明确启用后生成',()=>{
    expect(mapAsrSegments({segments:[{text:'未打轴'}]},10000,800)[0]).toEqual({text:'未打轴'})
    expect(mapAsrSegments({segments:[{text:'未打轴'}]},10000,800,true)[0]).toEqual({text:'未打轴',startMs:10000,endMs:10800,estimated:true})
  })
  it('拒绝非法时间并保留模型返回的时间重叠',()=>{
    expect(()=>mapAsrSegments({segments:[{text:'x',startMs:100,endMs:1}]},0,1000)).toThrow()
    expect(()=>mapAsrSegments({segments:[{text:'x',startMs:100}]},0,1000)).toThrow()
    expect(mapAsrSegments({segments:[{text:'x',startMs:0,endMs:500},{text:'y',startMs:200,endMs:600}]},0,1000)).toHaveLength(2)
  })
  it('whisper.cpp offsets 已是毫秒，不重复乘以 10',()=>{
    expect(whisperOutput({result:{language:'zh'},transcription:[{text:'台词',offsets:{from:1230,to:2450}}]})).toEqual({language:'zh',segments:[{text:'台词',startMs:1230,endMs:2450}]})
  })
  it('完整 JSON 的语音 token 细化整秒段边界，两片映射和 ASS/SRT 导出均保留小数',()=>{
    const output=whisperOutput({model:{multilingual:true},transcription:[{
      text:'测试字幕',offsets:{from:2000,to:4000},tokens:[
        {id:50365,text:'[_BEG_]',offsets:{from:2000,to:2000}},
        {id:123,text:'测试',offsets:{from:2080,to:2810},p:0.9},
        {id:456,text:'字幕',offsets:{from:2810,to:3920}},
        {id:50565,text:'[_TT_200]',offsets:{from:4000,to:4000}}
      ]
    }]})
    expect(output.segments[0]).toEqual({text:'测试字幕',startMs:2080,endMs:3920,words:[{text:'测试',startMs:2080,endMs:2810,score:0.9},{text:'字幕',startMs:2810,endMs:3920}]})
    const first=mapAsrSegments(output,0,120000),second=mapAsrSegments(output,120000,67371)
    expect(first[0]).toMatchObject({startMs:2080,endMs:3920});expect(second[0]).toMatchObject({startMs:122080,endMs:123920,words:[{startMs:122080,endMs:122810},{startMs:122810,endMs:123920}]})
    const cues=asrSubtitleCues([...first,...second],()=>randomUUID())
    expect(serializeSrt(cues)).toContain('00:00:02,080 --> 00:00:03,920')
    expect(serializeSrt(cues)).toContain('00:02:02,080 --> 00:02:03,920')
    const saved=parseAss(serializeAss(createSubtitleDocument({cues})))
    expect(saved.cues.map(c=>[c.startMs,c.endMs])).toEqual([[2080,3920],[122080,123920]])
  })
  it('不把控制 token、空白或无效 token 时间当作精细打轴，不截掉缺失边界的文字',()=>{
    const output=whisperOutput({transcription:[
      {text:'缺少首尾时间',offsets:{from:1230,to:3450},tokens:[{text:'首字'},{text:'中间',offsets:{from:1600,to:2200}},{text:'末字',offsets:{from:3400,to:3200}}]},
      {text:'保持原边界',offsets:{from:4000,to:6000},tokens:[{id:50365,text:'not speech',offsets:{from:4100,to:4200}},{text:' ',offsets:{from:4300,to:4400}},{text:'[_TT_600]',offsets:{from:5000,to:5900}},{text:'越界',offsets:{from:7000,to:7500}}]},
      {text:'零长度对齐',offsets:{from:8000,to:9000},tokens:[{text:'字',offsets:{from:8500,to:8500}}]}
    ]})
    expect(output.segments).toEqual([
      {text:'缺少首尾时间',startMs:1230,endMs:3450,words:[{text:'中间',startMs:1600,endMs:2200}]},
      {text:'保持原边界',startMs:4000,endMs:6000},
      {text:'零长度对齐',startMs:8000,endMs:9000}
    ])
  })
  it('没有时间的文本仍可进入 ASS 工程，作为未打轴注释而不伪造台词时间',()=>{
    const cues=asrSubtitleCues([{text:'仅文本'},{text:'台词',startMs:300,endMs:600,estimated:true}],()=>randomUUID())
    expect(cues[0]).toMatchObject({text:'仅文本',startMs:0,endMs:0,comment:true,name:'ASR 未打轴'})
    expect(cues[1]).toMatchObject({startMs:300,endMs:600,name:'ASR 估算'});expect(cues[1].comment).toBeUndefined()
  })
  it('词级时间也必须有效；没有段级时间的词仍按媒体偏移映射',()=>{
    expect(()=>mapAsrSegments({segments:[{text:'词',words:[{text:'词',startMs:2}]}]},0,1000)).toThrow()
    const result=mapAsrSegments({segments:[{text:'词',words:[{text:'词',startMs:100,endMs:1100},{text:'越界',startMs:1200,endMs:1300}]}]},5000,1000)
    expect(result[0].words).toEqual([{text:'词',startMs:5100,endMs:6000}]);expect(result[0].startMs).toBeUndefined()
  })
})
function plan(root:string):AsrPlan{return {kind:'asr',input:{path:join(root,'input.wav'),name:'input.wav',durationMs:2000,size:100,format:'wav',streams:[{index:0,type:'audio',codec:'pcm_s16le'}]},outputPath:join(root,randomUUID()+'.json'),engine:{id:'test',version:'test',source:'local',ffmpegPath:'unused',ffprobePath:'unused',encoders:[],decoders:[],filters:[],detectedAt:''},args:[],warnings:[],durationMs:2000,asr:{model:{id:randomUUID(),name:'Test',backend:'custom',executable:process.execPath,modelPath:root,args:[],sampleRate:16000,channels:1,importedAt:'',availability:'ready'},options:{inputPath:join(root,'input.wav'),modelId:randomUUID(),audioStream:0,language:'auto',device:'cpu',threads:1,chunkingEnabled:true,chunkSeconds:10,beamSize:1,initialPrompt:'',startMs:0,estimateUntimed:false}}}}
async function wait(queue:JobQueue,id:string,state:string){await expect.poll(()=>queue.get(id).status,{timeout:10000}).toBe(state)}
async function local(fn:(root:string)=>Promise<void>){await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data','asr-unit-'));try{await fn(root)}finally{if(!isWithin(resolve('.test-data'),root))throw new Error('测试清理路径无效');await rm(root,{recursive:true,force:true})}}
describe('ASR 任务队列',()=>{
  it('分块边界暂停，继续后完成；持久化保存独立任务类型',()=>local(async root=>{
    const queue=new JobQueue(root);await queue.initialize();let continueChunk!:()=>void
    queue.asrExecutor=async(job,ctx)=>{await new Promise<void>(resolve=>continueChunk=resolve);ctx.progress('首段完成',50,1000);await ctx.checkpoint();ctx.log('识别日志\n');job.outputSize=123}
    const job=await queue.submitAsr(plan(root));await expect.poll(()=>!!continueChunk).toBe(true)
    await queue.pause(job.id);expect(queue.get(job.id)).toMatchObject({status:'running',pausing:true})
    continueChunk();await wait(queue,job.id,'paused');expect(queue.get(job.id).events?.some(e=>e.type==='paused')).toBe(true)
    await queue.resume(job.id);await wait(queue,job.id,'completed');await queue.shutdown()
    const saved=await new JobHistoryStore(root).read();expect(saved[0].plan.kind).toBe('asr');expect(saved[0].finishedAt).toBeTruthy();expect(await queue.log(job.id)).toContain('识别日志')
  }))
  it('取消正在等待继续的识别任务，不会挂起退出',()=>local(async root=>{
    const queue=new JobQueue(root);await queue.initialize();let continueChunk!:()=>void
    queue.asrExecutor=async(_job,ctx)=>{await new Promise<void>(resolve=>continueChunk=resolve);await ctx.checkpoint()}
    const job=await queue.submitAsr(plan(root));await expect.poll(()=>!!continueChunk).toBe(true);await queue.pause(job.id);continueChunk();await wait(queue,job.id,'paused')
    await queue.cancel(job.id);await wait(queue,job.id,'cancelled');await queue.shutdown()
  }))
  it('即使转码并行数为 4，也只运行一个 ASR 任务；等待任务仍可排序与取消',()=>local(async root=>{
    const queue=new JobQueue(root);queue.concurrency=4;await queue.initialize();let finish!:()=>void,starts=0
    queue.asrExecutor=async()=>{starts++;await new Promise<void>(resolve=>finish=resolve)}
    const first=await queue.submitAsr(plan(root));await expect.poll(()=>starts).toBe(1)
    const second=await queue.submitAsr(plan(root));await queue.move(second.id,'first');expect(queue.get(second.id).status).toBe('queued');expect(starts).toBe(1)
    await queue.cancel(second.id);finish();await wait(queue,first.id,'completed');await queue.shutdown()
  }))
  it('运行中记录重启后标记中断，不把已有转码记录解释为 ASR',()=>local(async root=>{
    const p=plan(root),id=randomUUID(),job:Job={id,plan:p,source:'gui',createdAt:new Date().toISOString(),status:'running',progress:20,processedMs:400,speed:'',logPath:join(root,'logs',id+'.log'),logTail:'',temporaryPath:join(root,'other-file')}
    await writeFile(join(root,'jobs.json'),JSON.stringify([job]));const queue=new JobQueue(root);await queue.initialize();expect(queue.get(id).status).toBe('interrupted');expect(queue.get(id).plan.kind).toBe('asr');await queue.shutdown()
  }))
})
describe('自定义 ASR 后端',()=>{
  it('导入相对路径清单并持久化，移除配置不删除用户文件',()=>local(async root=>{
    const manifest=join(root,'backend.json'),worker=join(root,'worker.cjs');await writeFile(worker,'// user owned')
    await writeFile(manifest,JSON.stringify({format:'muxivra-asr-backend',version:1,name:'My ASR',executable:process.execPath,args:['{manifestDir}/worker.cjs'],modelPath:'.'}))
    const models=new AsrModels(root,()=>{});await models.initialize();const model=await models.import({backend:'custom',name:'ignored',modelPath:manifest})
    expect(model.args[0]).toContain(root);const next=new AsrModels(root,()=>{});await next.initialize();expect(next.state().models[0].name).toBe('My ASR')
    await next.remove(model.id);expect(await readFile(worker,'utf8')).toContain('user owned');await next.shutdown();await models.shutdown()
  }))
})
