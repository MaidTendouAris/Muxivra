import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { request as httpRequest } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { MediaService } from '../../src/core/service'
import { McpHost } from '../../src/mcp/server'
import { detectEngine } from '../../src/core/engine'
import { run } from '../../src/core/engine/process'
import { defaultOptions } from '../../src/core/presets'
import { isWithin } from '../../src/core/media/paths'
import { parseSrt } from '../../src/core/subtitles/srt'
import { JsonStore } from '../../src/core/storage/json'
import { JobQueue } from '../../src/core/jobs/queue'
import type { Job, JobRequest } from '../../src/shared/types'

let root: string, input: string, output: string, service: MediaService, host: McpHost, port: number
const clients: Client[]=[]
async function waitJob(id: string, states = ['completed','failed','cancelled','interrupted']): Promise<Job> {
  const start=Date.now()
  while(Date.now()-start<90000) { const job=service.queue.get(id);if(states.includes(job.status))return job;await new Promise(resolve=>setTimeout(resolve,50)) }
  throw new Error('等待任务超时')
}
async function freePort(): Promise<number> {const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const number=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return number}
function request(name: string, patch = {}): JobRequest {return {inputPath:input,outputPath:join(output,name),options:{...defaultOptions,...patch}}}
beforeAll(async()=>{
  await mkdir('.test-data',{recursive:true});root=await mkdtemp(resolve('.test-data','integration-'));output=join(root,'output');await mkdir(output);input=join(root,'输入 & sample.mp4')
  const engine=await detectEngine();if(!engine)throw new Error('集成测试需要 PATH 中可用的 FFmpeg 与 ffprobe')
  await run(engine.ffmpegPath,['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',input])
  service=new MediaService(join(root,'profile'),join(root,'engines'));await service.initialize();await service.paths.grantFile(input);await service.paths.grantDirectory(output);host=new McpHost(service)
})
afterAll(async()=>{for(const client of clients)await client.close().catch(()=>{});await host?.stop();await service?.shutdown();if(root&&isWithin(resolve('.test-data'),root))await rm(root,{recursive:true,force:true})})
describe('真实 FFmpeg 与共享队列',()=>{
  it('自动创建默认输出目录并授权 GUI，MCP 仍需配置输出目录',async()=>{
    const directory=join(root,'temp-install','outputs'),local=new MediaService(join(root,'default-output-profile'),join(root,'default-output-engines'),directory)
    try {
      await local.initialize();await local.paths.grantFile(input)
      expect(local.snapshot().defaultOutputPath).toBe(directory)
      expect(await readdir(directory)).toEqual([])
      const request={inputPath:input,outputPath:join(directory,'default-output.mp4'),options:defaultOptions}
      expect((await local.plan(request)).outputPath).toBe(request.outputPath)
      await local.paths.grantDirectory(root);await local.paths.grantDirectory(output)
      await local.saveSettings({...local.settings,mcp:{...local.settings.mcp,enabled:true,inputRoots:[root],outputRoots:[output]}})
      await expect(local.plan(request,'mcp')).rejects.toThrow('输出路径未获授权')
    }finally{await local.shutdown()}
  })
  it('分析与 H.264 转码、进度、输出检查',async()=>{
    const media=await service.inspect(input);expect(media.streams.map(s=>s.type)).toContain('audio');expect(media.durationMs).toBeGreaterThan(1900)
    const progress:number[]=[];const listener=()=>{const job=service.queue.jobs.at(-1);if(job)progress.push(job.progress)};service.queue.on('update',listener)
    const [job]=await service.submit([request('encoded.mp4')],'gui','encode-once');expect(job.status).toBe('queued')
    const final=await waitJob(job.id);expect(final.error).toBeUndefined();expect(final.status).toBe('completed');expect(final.progress).toBe(100);expect(progress.some(p=>p>0)).toBe(true);service.queue.removeListener('update',listener)
    await service.paths.grantFile(final.plan.outputPath);const result=await service.inspect(final.plan.outputPath);expect(result.streams.find(s=>s.type==='video')?.codec).toBe('h264');expect(result.durationMs).toBeGreaterThan(1900)
    const [duplicate]=await service.submit([request('encoded.mp4')],'gui','encode-once');expect(duplicate.id).toBe(job.id);await expect(service.submit([request('different.mp4')],'gui','encode-once')).rejects.toThrow('去重标识')
  })
  it('保存原文件，拒绝现有输出，复制轨道并自动编号',async()=>{
    const original=await readFile(input);await expect(service.submit([request('encoded.mp4')])).rejects.toThrow('已存在')
    const jobs=await service.submit([request('remux.mkv',{container:'mkv',video:'copy',audio:'copy',conflict:'number'}),request('remux.mkv',{container:'mkv',video:'copy',audio:'copy',conflict:'number'})],'gui','remux-batch')
    expect(jobs[0].plan.outputPath).not.toBe(jobs[1].plan.outputPath);expect(jobs[0].batchId).toBe(jobs[1].batchId)
    for(const job of jobs)expect((await waitJob(job.id)).status).toBe('completed');expect(await readFile(input)).toEqual(original)
    const reviewed=await service.planBatch([request('remux.mkv',{container:'mkv',video:'copy',audio:'copy',conflict:'number'}),request('remux.mkv',{container:'mkv',video:'copy',audio:'copy',conflict:'number'})]);expect(new Set(reviewed.map(plan=>plan.outputPath)).size).toBe(2)
  })
  it('运行时取消清理临时文件，失败项不阻止后续任务',async()=>{
    const planned=await service.plan(request('cancelled.mp4'));planned.args.splice(planned.args.indexOf('-i'),0,'-re')
    const [job]=await service.queue.submit([request('cancelled.mp4')],'gui',undefined,async()=>planned);await waitJob(job.id,['running']);await new Promise(resolve=>setTimeout(resolve,250));const cancellation=await service.cancel(job.id);expect(cancellation.cancelling).toBe(true);const cancelled=await waitJob(job.id);expect(cancelled.status).toBe('cancelled');expect(cancelled.cancelling).toBeUndefined();expect((await readdir(output)).some(name=>name.includes(job.id))).toBe(false)
    const broken=await service.plan(request('broken.mp4'));broken.args.splice(0,0,'-this_option_does_not_exist')
    const jobs=await service.queue.submit([request('broken.mp4'),request('after-failure.mp4')],'gui',undefined,async r=>r.outputPath.endsWith('broken.mp4')?broken:service.plan(r))
    expect((await waitJob(jobs[0].id)).status).toBe('failed');expect((await waitJob(jobs[1].id)).status).toBe('completed')
  })
  it('真实进程暂停、继续与耗时冻结，等待项排序和暂停后取消',async()=>{
    const requests=['pause-running.mp4','hold.mp4','move-first.mp4','move-last.mp4'].map(name=>request(name))
    const plans=await Promise.all(requests.map(r=>service.plan(r)))
    plans[0].args.splice(plans[0].args.indexOf('-i'),0,'-re','-stream_loop','4');plans[0].durationMs=10000
    const jobs=await service.queue.submit(requests,'gui',undefined,async r=>plans[requests.findIndex(p=>p.outputPath===r.outputPath)])
    const [running,held,first,last]=jobs
    await waitJob(running.id,['running']);await new Promise(r=>setTimeout(r,1500))
    const paused=await service.pause(running.id);expect(paused.status).toBe('paused');expect(paused.pausedFrom).toBe('running')
    await new Promise(r=>setTimeout(r,150));const frozen=service.queue.get(running.id)
    expect(frozen.estimatedRemainingMs).toBeGreaterThan(0);expect(frozen.estimateBasis).toBe('progress')
    await new Promise(r=>setTimeout(r,700));const still=service.queue.get(running.id)
    expect(still.elapsedMs).toBe(frozen.elapsedMs);expect(still.processedMs).toBe(frozen.processedMs)
    expect(await service.pause(held.id)).toMatchObject({status:'paused',pausedFrom:'queued'})
    await expect(service.plan(request('hold.mp4'))).rejects.toThrow('已存在')
    await service.moveJob(last.id,'first');await service.moveJob(first.id,'up');await service.moveJob(first.id,'down')
    expect(service.queue.list().filter(j=>j.status==='queued'||j.pausedFrom==='queued').map(j=>j.id)).toEqual([last.id,held.id,first.id])
    await service.resume(running.id);await new Promise(r=>setTimeout(r,600));expect(service.queue.get(running.id).elapsedMs).toBeGreaterThan(frozen.elapsedMs!)
    await service.pause(running.id);await service.cancel(running.id);expect((await waitJob(running.id)).status).toBe('cancelled')
    expect((await waitJob(last.id)).status).toBe('completed');expect((await waitJob(first.id)).status).toBe('completed')
    expect(service.queue.get(held.id).status).toBe('paused');expect(service.queue.get(last.id).startedAt!<=service.queue.get(first.id).startedAt!).toBe(true)
    await service.resume(held.id);const final=await waitJob(held.id);expect(final.status).toBe('completed');expect(final.elapsedMs).toBeGreaterThan(0)
    expect((await readdir(output)).some(n=>n.includes(running.id))).toBe(false)
  })
  it('重启保留暂停等待项与排序，将暂停运行项标记为中断并清理临时输出',async()=>{
    const data=join(root,'paused-recovery'),queue=new JobQueue(data);queue.concurrency=0;await queue.initialize()
    const requests=['recovery-held.mp4','recovery-running.mp4','recovery-first.mp4'].map(name=>request(name))
    const jobs=await queue.submit(requests,'gui',undefined,async r=>service.plan(r))
    await queue.pause(jobs[0].id);await queue.move(jobs[2].id,'first');await queue.shutdown()
    const saved=queue.jobs.map(j=>j.id===jobs[1].id?{...j,status:'paused',pausedFrom:'running'}:j)
    await writeFile(jobs[1].temporaryPath,'unfinished');await writeFile(join(data,'jobs.json'),JSON.stringify(saved))
    const recovered=new JobQueue(data);recovered.concurrency=0;await recovered.initialize()
    expect(recovered.list().map(j=>j.id)).toEqual([jobs[2].id,jobs[0].id,jobs[1].id])
    expect(recovered.get(jobs[0].id)).toMatchObject({status:'paused',pausedFrom:'queued'})
    expect(recovered.get(jobs[1].id).status).toBe('interrupted');await expect(readFile(jobs[1].temporaryPath)).rejects.toThrow()
    expect((await recovered.resume(jobs[0].id)).status).toBe('queued');await recovered.shutdown()
  })
  it('生成真实波形，SRT 导出不覆盖原字幕',async()=>{
    const waveform=await service.waveform(input);expect(waveform).toHaveLength(2000);expect(Math.max(...waveform)).toBeGreaterThan(0)
    const srt=join(output,'原字幕.srt');await writeFile(srt,'1\n00:00:00,001 --> 00:00:01,501\n你好\n');await service.paths.grantFile(srt);const doc=await service.readSubtitles(srt);doc.cues[0].text='编辑后的字幕';const exported=join(output,'edited.srt');await service.exportSubtitles(doc,exported);expect(parseSrt(await readFile(exported,'utf8'))[0].text).toBe('编辑后的字幕');await expect(service.exportSubtitles(doc,srt)).rejects.toThrow('原字幕');await expect(service.exportSubtitles(doc,exported)).rejects.toThrow();await service.saveSession(doc);expect(await service.getSession()).toEqual(doc)
  })
  it('真实 H.265、AAC、MP3、FLAC 与 PCM 输出可重新分析',async()=>{
    const cases=[
      {name:'hevc.mp4',patch:{video:'libx265' as const,speed:'fast' as const},type:'video',codec:'hevc'},
      {name:'audio.m4a',patch:{container:'m4a' as const,video:'none' as const},type:'audio',codec:'aac'},
      {name:'audio.mp3',patch:{container:'mp3' as const,video:'none' as const,audio:'libmp3lame' as const},type:'audio',codec:'mp3'},
      {name:'audio.flac',patch:{container:'flac' as const,video:'none' as const,audio:'flac' as const},type:'audio',codec:'flac'},
      {name:'audio.wav',patch:{container:'wav' as const,video:'none' as const,audio:'pcm_s16le' as const},type:'audio',codec:'pcm_s16le'}
    ]
    for(const item of cases){
      const [job]=await service.submit([request(item.name,item.patch)]);const final=await waitJob(job.id);expect(final.error).toBeUndefined();expect(final.status).toBe('completed')
      await service.paths.grantFile(final.plan.outputPath);const media=await service.inspect(final.plan.outputPath);expect(media.streams.find(stream=>stream.type===item.type)?.codec).toBe(item.codec);expect(media.durationMs).toBeGreaterThan(1900)
      if(item.type==='audio')expect(media.streams.every(stream=>stream.type==='audio')).toBe(true)
    }
  })
  it('文本字幕轨道可以从 MKV 提取为真实 SRT',async()=>{
    const subtitle=join(output,'embedded.srt'),media=join(output,'with-subtitles.mkv'),target=join(output,'extracted.srt')
    await writeFile(subtitle,'1\n00:00:00,001 --> 00:00:01,501\n字幕轨验证\n');await run(service.engine.ffmpegPath,['-v','error','-i',input,'-i',subtitle,'-map','0','-map','1','-c','copy',media]);await service.paths.grantFile(media)
    const info=await service.inspect(media),track=info.streams.find(stream=>stream.type==='subtitle')!;expect(track.codec).toBe('subrip')
    const [job]=await service.submit([{inputPath:media,outputPath:target,options:{...defaultOptions,container:'srt',video:'none',audio:'none',subtitles:'copy',streamIndices:[track.index]}}]);const final=await waitJob(job.id);expect(final.error).toBeUndefined();expect(final.status).toBe('completed')
    const cues=parseSrt(await readFile(target,'utf8'));expect(cues).toHaveLength(1);expect(cues[0]).toMatchObject({startMs:1,endMs:1501,text:'字幕轨验证'})
  })
  it('组合剪辑、裁剪、帧率、画面滤镜、音频滤镜、编码器选项和元数据实际生效',async()=>{
    const options={...defaultOptions,advanced:{start:0.25,end:1.25,frameRate:'12',sampleRate:44100,channels:1,metadata:'remove',gop:12},
      filters:[{id:'crop',name:'crop',enabled:true,options:{w:'256',h:'144',x:'0',y:'0'}},{id:'eq',name:'eq',enabled:true,options:{brightness:'0.05',contrast:'1.1'}},{id:'volume',name:'volume',enabled:true,options:{volume:'0.5'}}],
      encoderOptions:[{scope:'video' as const,name:'aq-mode',value:'variance'},{scope:'video' as const,name:'rc-lookahead',value:'5'}],codecParameters:{'qcomp':'0.7'},metadata:[{key:'title',value:'参数验证'}]}
    const [job]=await service.submit([request('advanced.mp4',options)]),final=await waitJob(job.id)
    expect(final.error).toBeUndefined();expect(final.status).toBe('completed');expect(final.plan.durationMs).toBe(1000)
    await service.paths.grantFile(final.plan.outputPath);const info=await service.inspect(final.plan.outputPath)
    expect(info.streams.find(s=>s.type==='video')).toMatchObject({width:256,height:144,frameRate:'12/1'});expect(info.streams.find(s=>s.type==='audio')).toMatchObject({sampleRate:44100,channels:1});expect(info.durationMs).toBeLessThan(1150)
    const probe=JSON.parse(await run(service.engine.ffprobePath,['-v','error','-show_format','-of','json',final.plan.outputPath]));expect(probe.format.tags.title).toBe('参数验证')
    await expect(service.plan(request('unsupported.mp4',{advanced:{rateControl:'cq'}}))).rejects.toThrow('不支持')
    await expect(service.plan(request('bad-filter.mp4',{filters:[{id:'bad',name:'crop',enabled:true,options:{unknown:'1'}}]}))).rejects.toThrow('不支持参数')
    await expect(service.plan(request('bad-private.mp4',{encoderOptions:[{scope:'video',name:'passlogfile',value:'outside'}]}))).rejects.toThrow('不支持参数')
  })
  it('内嵌字幕烧录、PNG 提帧与 Opus 输出使用真实引擎',async()=>{
    const embedded=join(output,'with-subtitles.mkv')
    const external=join(output,"外部 字幕, '中文'.srt");await writeFile(external,'1\n00:00:00,000 --> 00:00:01,000\n外部字幕\n');await service.paths.grantFile(external)
    for(const r of [
      {inputPath:embedded,outputPath:join(output,'burned.mp4'),options:{...defaultOptions,advanced:{burnSubtitle:0,subtitleSize:22,subtitleOutline:1}}},
      request('external-burned.mp4',{subtitleFile:external,advanced:{subtitleFont:'微软雅黑',subtitleSize:22,subtitleColor:'#FFDD99',subtitleBold:'on'}}),
      request('frame.png',{container:'png',video:'png',audio:'none',advanced:{start:0.5,width:160,height:90}}),
      request('frame.jpg',{container:'jpg',video:'mjpeg',audio:'none',advanced:{start:0.5,imageQuality:4}}),
      request('frame.webp',{container:'webp',video:'libwebp',audio:'none',advanced:{start:0.5,imageQuality:80}}),
      request('animation.gif',{container:'gif',video:'gif',audio:'none',advanced:{duration:0.5,imageLoop:'once',frameRate:'12'}}),
      request('hevc-advanced.mp4',{video:'libx265',codecParameters:{'aq-mode':'2','rd':'3','sao':'1','qcomp':'0.7'}}),
      request('audio.opus',{container:'opus',video:'none',audio:'libopus',advanced:{channels:1}})
    ]) {const [job]=await service.submit([r]),final=await waitJob(job.id);expect(final.error).toBeUndefined();expect(final.status).toBe('completed')}
    const png=await readFile(join(output,'frame.png'));expect(png.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a')
  })
  it('完整预设往返、同名导入保留旧项、坏文件不部分导入和拒绝覆盖',async()=>{
    const options={...defaultOptions,advanced:{gop:48,videoBitrate:2000},filters:[{id:'a',name:'eq',enabled:true,options:{contrast:'1.2'}}],encoderOptions:[{scope:'video' as const,name:'aq-mode',value:'variance'}]}
    await service.savePreset({id:'custom-roundtrip',name:'往返预设',description:'参数集',options})
    const file=join(output,'presets.json');await service.exportPresetFile(['custom-roundtrip'],file);await service.paths.grantFile(file)
    const imported=await service.importPresetFile(file);expect(imported.count).toBe(1)
    const matches=service.snapshot().presets.filter(p=>p.name==='往返预设');expect(matches).toHaveLength(2);expect(matches[0].id).not.toBe(matches[1].id);expect(matches[1].options).toMatchObject(options)
    await expect(service.exportPresetFile(['custom-roundtrip'],file)).rejects.toThrow()
    const bad=join(output,'bad-presets.json'),data=JSON.parse(await readFile(file,'utf8'));data.presets.push({...data.presets[0],options:{...defaultOptions,advanced:{gop:-1}}});await writeFile(bad,JSON.stringify(data));await service.paths.grantFile(bad)
    const before=service.snapshot().presets.length;await expect(service.importPresetFile(bad)).rejects.toThrow('未导入');expect(service.snapshot().presets).toHaveLength(before)
  })
  it('重启恢复去重记录，运行中任务标记为中断',async()=>{
    await service.shutdown();const recovered=new MediaService(service.dataPath,service.enginePath);await recovered.initialize();await recovered.paths.grantFile(input);await recovered.paths.grantDirectory(output)
    const original=service.queue.jobs.find(job=>job.requestKey==='remux-batch')!;const duplicates=await recovered.submit([request('remux.mkv',{container:'mkv',video:'copy',audio:'copy',conflict:'number'}),request('remux.mkv',{container:'mkv',video:'copy',audio:'copy',conflict:'number'})],'gui','remux-batch');expect(duplicates[0].id).toBe(original.id);service=recovered;host=new McpHost(service)
    const persisted=service.queue.jobs.map(job=>job.id===original.id?{...job,status:'running'}:job);await writeFile(join(service.dataPath,'jobs.json'),JSON.stringify(persisted));await service.shutdown();const restarted=new MediaService(service.dataPath,service.enginePath);await restarted.initialize();expect(restarted.queue.get(original.id).status).toBe('interrupted');await restarted.paths.grantFile(input);await restarted.paths.grantDirectory(output);service=restarted;host=new McpHost(service)
  })
})
describe('MCP HTTP 实际客户端',()=>{
  it('官方 SDK 客户端发现工具、计划、提交、查询与重连',async()=>{
    port=await freePort();const settings=service.settings;settings.mcp={...settings.mcp,enabled:true,port,inputRoots:[root],outputRoots:[output]};await service.saveSettings(settings);await host.configure(settings.mcp)
    async function connect(){const client=new Client({name:'muxivra-integration',version:'1.0'});await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${settings.mcp.token}`}}}));clients.push(client);return client}
    const client=await connect();const tools=await client.listTools();expect(tools.tools.map(t=>t.name)).toContain('submit_jobs');expect(tools.tools).toHaveLength(16)
      const hardware=await client.callTool({name:'get_system_hardware',arguments:{}});expect(hardware.isError).not.toBe(true);expect(JSON.parse((hardware.content as {text:string}[])[0].text)).toMatchObject({hardware:{version:2},accelerationValidation:'not-tested'})
    const resources=await client.listResources();expect(resources.resources[0].uri).toBe('muxivra://system/hardware');expect((await client.readResource({uri:resources.resources[0].uri})).contents).toHaveLength(1)
    const inspect=await client.callTool({name:'inspect_media',arguments:{path:input}});expect(inspect.isError).not.toBe(true)
    const planned=await client.callTool({name:'plan_transcode',arguments:{request:request('from-ai.mp4')}});expect(planned.isError).not.toBe(true)
    const submitted=await client.callTool({name:'submit_jobs',arguments:{requests:[request('from-ai.mp4')],requestKey:'mcp-once'}});const data=JSON.parse((submitted.content as {text:string}[])[0].text);expect(data.jobs[0].source).toBe('mcp');expect(data.jobs[0].status).toBe('queued');const id=data.jobs[0].id;expect((await waitJob(id)).status).toBe('completed');await client.close()
    const reconnected=await connect();const fetched=await reconnected.callTool({name:'get_job',arguments:{id}});expect(JSON.parse((fetched.content as {text:string}[])[0].text).status).toBe('completed')
    const duplicate=await reconnected.callTool({name:'submit_jobs',arguments:{requests:[request('from-ai.mp4')],requestKey:'mcp-once'}});expect(JSON.parse((duplicate.content as {text:string}[])[0].text).jobs[0].id).toBe(id)
  })
  it('离线指南、资源和 MCP prompt 可实际读取，结构化参考与查询权限一致',async()=>{
    const client=clients.at(-1)!
    const call=async(name:string,args={})=>{const result=await client.callTool({name,arguments:args});expect(result.isError).not.toBe(true);return JSON.parse((result.content as {text:string}[])[0].text)}
    const catalog=await call('list_skills');expect(catalog).toHaveLength(6)
    for(const skill of catalog) {
      const document=await call('read_skill',{id:skill.id});expect(document.markdown).toContain('name: muxivra-');expect(document.version).toBe(skill.version)
      const resource=await client.readResource({uri:skill.uri});expect(resource.contents[0]).toMatchObject({mimeType:'text/markdown',text:document.markdown})
    }
    const reference=await call('read_skill',{id:'parameters'});expect(reference.parameterReference.parameters.find((p:{key:string})=>p.key==='sampleRate')).toMatchObject({scope:'audio'})
    const aac=await call('get_component_capabilities',{kind:'audioEncoder',name:'aac'});expect(aac.options.some((p:{name:string})=>p.name==='aac_coder')).toBe(true)
    const filter=await call('get_component_capabilities',{kind:'filter',name:'volume'});expect(filter.options.some((p:{name:string})=>p.name==='volume')).toBe(true)
    const resourceReference=await client.readResource({uri:'muxivra://reference/parameters'});expect(JSON.parse((resourceReference.contents[0] as {text:string}).text)).toEqual(reference.parameterReference)
    expect((await client.listPrompts()).prompts.map(p=>p.name)).toContain('muxivra_workflow')
    expect((await client.getPrompt({name:'muxivra_workflow'})).messages[0].content).toMatchObject({type:'text',text:expect.stringContaining('媒体处理流程')})
    const original=service.settings
    try {
      await service.saveSettings({...original,mcp:{...original.mcp,allowInspect:false}})
      expect((await client.callTool({name:'list_skills',arguments:{}})).isError).toBe(true)
      expect((await client.callTool({name:'read_skill',arguments:{id:'workflow'}})).isError).toBe(true)
      expect((await client.callTool({name:'get_component_capabilities',arguments:{kind:'audioEncoder',name:'aac'}})).isError).toBe(true)
      await expect(client.readResource({uri:'muxivra://skills/workflow'})).rejects.toThrow('权限')
      await expect(client.readResource({uri:'muxivra://reference/parameters'})).rejects.toThrow('权限')
      await expect(client.getPrompt({name:'muxivra_workflow'})).rejects.toThrow('权限')
    }finally{await service.saveSettings(original)}
  })
  it('提示词中的无依赖 JSON-RPC 连接步骤可以初始化、发现工具并读取指南',async()=>{
    const url=`http://127.0.0.1:${port}/mcp`,headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream',Authorization:`Bearer ${service.settings.mcp.token}`}
    const initialized=await fetch(url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'muxivra-offline-script',version:'1.0'}}})})
    expect(initialized.status).toBe(200);expect((await initialized.json()).result.protocolVersion).toBe('2025-03-26')
    const notification=await fetch(url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});expect(notification.status).toBe(202);expect(await notification.text()).toBe('')
    const listed=await fetch(url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})});expect((await listed.json()).result.tools).toHaveLength(16)
    const guide=await fetch(url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'read_skill',arguments:{id:'workflow'}}})});const data=await guide.json();expect(data.result.isError).not.toBe(true);expect(JSON.parse(data.result.content[0].text).id).toBe('workflow')
  })
  it('拒绝未授权凭据、Host、Origin、路径和关闭的操作权限',async()=>{
    const url=`http://127.0.0.1:${port}/mcp`,headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream',Authorization:`Bearer ${service.settings.mcp.token}`}
    expect((await fetch(url,{method:'POST',body:'{}',headers:{...headers,Authorization:'Bearer invalid'}})).status).toBe(401)
    const invalidHost=await new Promise<number|undefined>((resolve,reject)=>{const req=httpRequest(url,{method:'POST',headers:{...headers,Host:`evil.example:${port}`}},response=>{response.resume();resolve(response.statusCode)});req.on('error',reject);req.end('{}')});expect(invalidHost).toBe(403)
    expect((await fetch(url,{method:'POST',body:'{}',headers:{...headers,Origin:'https://evil.example'}})).status).toBe(403)
    const client=clients.at(-1)!;const denied=await client.callTool({name:'inspect_media',arguments:{path:resolve('package.json')}});expect(denied.isError).toBe(true)
    const deniedPause=await client.callTool({name:'pause_job',arguments:{id:service.queue.jobs[0].id}});expect(deniedPause.isError).toBe(true)
    const settings=service.settings;settings.mcp.allowSubmit=false;await service.saveSettings(settings);const submit=await client.callTool({name:'submit_jobs',arguments:{requests:[request('denied.mp4')]}});expect(submit.isError).toBe(true)
  })
  it('MCP 暂停/继续/排序共享任务，独立检查任务控制权限',async()=>{
    const settings=service.settings;settings.mcp.allowSubmit=true;await service.saveSettings(settings)
    const requests=['mcp-control-running.mp4','mcp-control-held.mp4','mcp-control-first.mp4'].map(name=>request(name)),plans=await Promise.all(requests.map(r=>service.plan(r,'mcp')))
    plans[0].args.splice(plans[0].args.indexOf('-i'),0,'-re','-stream_loop','4');plans[0].durationMs=10000
    const jobs=await service.queue.submit(requests,'mcp',undefined,async r=>plans[requests.findIndex(p=>p.outputPath===r.outputPath)]),client=clients.at(-1)!
    const call=async(name:string,args:unknown)=>{const result=await client.callTool({name,arguments:args as Record<string,unknown>});expect(result.isError).not.toBe(true);return JSON.parse((result.content as {text:string}[])[0].text)}
    try {
      await waitJob(jobs[0].id,['running']);await new Promise(r=>setTimeout(r,300))
      expect(await call('pause_job',{id:jobs[0].id})).toMatchObject({status:'paused',pausedFrom:'running'})
      expect(await call('pause_job',{id:jobs[1].id})).toMatchObject({status:'paused',pausedFrom:'queued'})
      await call('move_job',{id:jobs[2].id,direction:'first'});expect(service.queue.list().filter(j=>jobs.slice(1).some(k=>k.id===j.id)).map(j=>j.id)).toEqual([jobs[2].id,jobs[1].id])
      expect(await call('resume_job',{id:jobs[0].id})).toMatchObject({status:'running'})
      const denied=service.settings;denied.mcp.allowCancel=false;await service.saveSettings(denied)
      expect((await client.callTool({name:'pause_job',arguments:{id:jobs[0].id}})).isError).toBe(true)
      denied.mcp.allowCancel=true;await service.saveSettings(denied)
      expect(await call('resume_job',{id:jobs[1].id})).toMatchObject({status:'queued'})
    }finally{for(const job of jobs.slice(1))await service.cancel(job.id);await service.cancel(jobs[0].id);await waitJob(jobs[0].id)}
  })
  it('查询、提交和取消权限独立检查',async()=>{
    const settings=service.settings;settings.mcp.allowInspect=false;settings.mcp.allowSubmit=true;settings.mcp.allowCancel=true;await service.saveSettings(settings)
    await expect(service.inspect(input,'mcp')).rejects.toThrow('未获授权')
    expect(()=>service.systemHardware('mcp')).toThrow('未获授权')
    const [job]=await service.submit([request('without-inspect.mp4')],'mcp','separate-permission');await service.cancel(job.id,'mcp');expect((await waitJob(job.id)).status).toBe('cancelled')
  })
  it('设置存盘失败时恢复原 MCP 端口与配置',async()=>{
    const originalSettings=service.settings,originalWrite=JsonStore.prototype.write
    service.beforeSaveSettings=settings=>host.configure(settings.mcp)
    const changed={...originalSettings,mcp:{...originalSettings.mcp,port:await freePort()}}
    const write=vi.spyOn(JsonStore.prototype,'write').mockImplementation(function(this: JsonStore<unknown>,value){
      if(this.path===join(service.dataPath,'config.json'))return Promise.reject(new Error('模拟配置写入失败'))
      return originalWrite.call(this,value)
    })
    try {
      await expect(service.saveSettings(changed)).rejects.toThrow('模拟配置写入失败')
      expect(service.settings).toEqual(originalSettings);expect(service.mcpState).toMatchObject({running:true,url:`http://127.0.0.1:${originalSettings.mcp.port}/mcp`})
      // 旧监听器的 keep-alive 连接关闭事件需要传递到客户端连接池。
      await new Promise(resolve=>setTimeout(resolve,100))
      const client=new Client({name:'muxivra-rollback-verification',version:'1.0'});clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL(service.mcpState.url!),{requestInit:{headers:{Authorization:`Bearer ${originalSettings.mcp.token}`}}}))
      expect((await client.listTools()).tools).toHaveLength(16)
      const persisted=JSON.parse(await readFile(join(service.dataPath,'config.json'),'utf8'));expect(persisted.settings).toEqual(originalSettings)
    } finally {write.mockRestore();service.beforeSaveSettings=undefined}
  })
})
