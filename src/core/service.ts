import { EventEmitter } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { join,basename } from 'node:path'
import { readFile, writeFile, stat, realpath, mkdir, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import type { Engine, Job, JobRequest, Settings, Snapshot, Source, Preset, SubtitleDocument, DownloadState } from '../shared/types'
import { settingsSchema, requestSchema, presetSchema, subtitleSchema, presetFileSchema } from '../shared/schema'
import { validateComponentOptions, componentCapabilities } from './engine/options'
import type { ComponentCapabilities } from '../shared/parameters'
import { JsonStore } from './storage/json'
import { PathPolicy, availableOutput, localPath, canonicalInput } from './media/paths'
import { buildPlan } from './media/plan'
import { inspectMedia } from './media/probe'
import { detectEngine, verifyEngine, installEngine, managedEngines } from './engine'
import { JobQueue } from './jobs/queue'
import { HardwareStore } from './hardware'
import { UsageMonitor } from './hardware/usage'
import { builtInPresets } from './presets'
import { parseSrt, serializeSrt } from './subtitles/srt'
import { makeWaveform } from './media/waveform'

interface Configuration { settings: Settings; engine?: Engine; engines: Engine[]; presets: Preset[] }
export class MediaService extends EventEmitter {
  readonly paths = new PathPolicy()
  readonly queue: JobQueue
  readonly hardware: HardwareStore
  readonly usage:UsageMonitor
  private configStore: JsonStore<Configuration>
  private sessionStore: JsonStore<SubtitleDocument | undefined>
  private configuration!: Configuration
  private configOperations: Promise<unknown> = Promise.resolve()
  private download: DownloadState = { state: 'idle', percent: 0, message: '' }
  private downloadActive = false
  private downloadController?: AbortController
  private background = new AbortController()
  private backgroundTasks = new Set<Promise<unknown>>()
  private notice?: string
  mcpState: Snapshot['mcp'] = { running: false }
  beforeSaveSettings?: (settings: Settings) => Promise<void>
  constructor(readonly dataPath: string, readonly enginePath: string, readonly defaultOutputPath?: string,hardwareWorkerPath?:string) {
    super(); this.queue = new JobQueue(dataPath); this.hardware=new HardwareStore(dataPath,()=>this.emit('update')); this.configStore = new JsonStore(join(dataPath,'config.json')); this.sessionStore = new JsonStore(join(dataPath,'subtitle-session.json'))
    this.usage=new UsageMonitor(()=>this.hardware.info,hardwareWorkerPath)
    this.queue.on('update',() => this.emit('update'))
    this.queue.on('storage-error',message => { this.notice = message; this.emit('update') })
  }
  async initialize(): Promise<void> {
    const defaults: Configuration = { settings: { theme: 'dark', concurrency: 1, mcp: { enabled: false, port: 19480, token: randomBytes(32).toString('hex'), inputRoots: [], outputRoots: [], allowInspect: true, allowSubmit: true, allowCancel: true } }, engines: [], presets: [] }
    this.configuration = await this.configStore.read(defaults)
    settingsSchema.parse(this.configuration.settings)
    this.configuration.presets.forEach(preset => presetSchema.parse(preset))
    try {
      const engine = this.configuration.engine ? await verifyEngine(this.configuration.engine.ffmpegPath,this.configuration.engine.source) : await detectEngine()
      this.configuration.engine = engine
      const managed = await managedEngines(this.enginePath)
      this.configuration.engines = [...new Map([...this.configuration.engines,...managed,...(engine ? [engine] : [])].map(e => [e.id,e])).values()]
    } catch (e) { this.configuration.engine = undefined; this.notice = `引擎不可用：${(e as Error).message}` }
    await this.configStore.write(this.configuration)
    await this.queue.initialize()
    await this.hardware.initialize()
    this.queue.concurrency = this.configuration.settings.concurrency
    if(this.defaultOutputPath) {
      try { await mkdir(this.defaultOutputPath,{recursive:true});await access(this.defaultOutputPath,constants.W_OK);await this.paths.grantDirectory(this.defaultOutputPath) }
      catch(error) { this.notice = `默认输出目录不可写：${this.defaultOutputPath}。请选择其他输出目录。${(error as Error).message}` }
    }
    this.queue.start()
  }
  get settings(): Settings { return structuredClone(this.configuration.settings) }
  get engine(): Engine { if (!this.configuration.engine) throw new Error('未配置 FFmpeg，请前往设置选择或下载引擎'); return structuredClone(this.configuration.engine) }
  snapshot(): Snapshot { return structuredClone({ engine: this.configuration.engine, engines: this.configuration.engines, jobs: this.queue.list(), presets: [...builtInPresets,...this.configuration.presets], settings: this.configuration.settings, download: this.download, mcp: this.mcpState, notice: this.notice, dataPath: this.dataPath, enginePath: this.enginePath, defaultOutputPath:this.defaultOutputPath,hardware:this.hardware.info,hardwareRefreshing:this.hardware.refreshing }) }
  private roots(source: Source, output = false): string[] | undefined { return source === 'mcp' ? (output ? this.settings.mcp.outputRoots : this.settings.mcp.inputRoots) : undefined }
  private permission(source: Source, action: 'allowInspect' | 'allowSubmit' | 'allowCancel'): void { if (source === 'mcp' && (!this.settings.mcp.enabled || !this.settings.mcp[action])) throw new Error('此 MCP 操作未获授权，请检查设置') }
  async inspect(input: string, source: Source = 'gui') { this.permission(source,'allowInspect'); return inspectMedia(this.engine,await this.paths.input(input,this.roots(source))) }
  async inspectPlayback(input:string) {if(this.configuration.engine)return this.inspect(input);const path=await this.paths.input(input);return {path,name:basename(path),durationMs:0,size:(await stat(path)).size,format:'',streams:[]} as import('../shared/types').MediaInfo}
  async plan(request: JobRequest, source: Source = 'gui', reserved = this.queue.reserved()) {
    this.permission(source,'allowInspect')
    return this.makePlan(request,source,reserved)
  }
  private async makePlan(request: JobRequest, source: Source, reserved: Set<string>) {
    const parsed = requestSchema.parse(request)
    const input = await this.paths.input(parsed.inputPath,this.roots(source)), output = await this.paths.output(parsed.outputPath,this.roots(source,true))
    if (input.toLowerCase() === output.toLowerCase()) throw new Error('输出不能是原文件')
    const target = await availableOutput(output,reserved,parsed.options.conflict === 'number')
    if(parsed.options.subtitleFile){const path=await this.paths.input(parsed.options.subtitleFile,this.roots(source));if(!/\.(srt|ass|ssa)$/i.test(path)||(await stat(path)).size>10*1024*1024)throw new Error('烧录字幕需要不超过 10 MB 的 SRT/ASS/SSA 文件');parsed.options.subtitleFile=path}
    await validateComponentOptions(this.engine,parsed.options)
    return buildPlan(this.engine,await inspectMedia(this.engine,input),target,parsed.options)
  }
  async submit(requests: JobRequest[], source: Source = 'gui', key?: string): Promise<Job[]> {
    this.permission(source,'allowSubmit')
    if (!Array.isArray(requests) || !requests.length || requests.length > 500) throw new Error('一次提交应包含 1 至 500 个任务')
    if (key && (key.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(key))) throw new Error('去重标识格式无效')
    const normalized: JobRequest[] = []
    for (const request of requests) {
      const parsed = requestSchema.parse(request)
      normalized.push({ ...parsed, inputPath: await this.paths.input(parsed.inputPath,this.roots(source)), outputPath: await this.paths.output(parsed.outputPath,this.roots(source,true)) })
    }
    return this.queue.submit(normalized,source,key,(request,reserved) => this.makePlan(request,source,reserved))
  }
  async planBatch(requests: JobRequest[], source: Source = 'gui') {
    if (!Array.isArray(requests) || !requests.length || requests.length > 500) throw new Error('一次检查应包含 1 至 500 个任务')
    const reserved = this.queue.reserved(), plans = []
    for (const request of requests) { const plan = await this.plan(request,source,reserved); reserved.add(plan.outputPath.toLowerCase()); plans.push(plan) }
    return plans
  }
  async job(id: string, source: Source = 'gui'): Promise<Job> {
    this.permission(source,'allowInspect')
    return this.authorizedJob(id,source)
  }
  private async authorizedJob(id: string, source: Source): Promise<Job> {
    const job = this.queue.get(id)
    if (source === 'mcp') { await this.paths.input(job.plan.input.path,this.roots(source)); await this.paths.output(job.plan.outputPath,this.roots(source,true)) }
    return job
  }
  async jobs(source: Source = 'gui'): Promise<Job[]> {
    this.permission(source,'allowInspect')
    const jobs: Job[] = []
    for (const job of this.queue.jobs) { try { jobs.push(await this.job(job.id,source)) } catch {} }
    return jobs
  }
  async cancel(id: string, source: Source = 'gui'): Promise<Job> { this.permission(source,'allowCancel'); await this.authorizedJob(id,source); return this.queue.cancel(id) }
  async pause(id:string,source:Source='gui'):Promise<Job>{this.permission(source,'allowCancel');await this.authorizedJob(id,source);return this.queue.pause(id)}
  async resume(id:string,source:Source='gui'):Promise<Job>{this.permission(source,'allowCancel');await this.authorizedJob(id,source);return this.queue.resume(id)}
  async moveJob(id:string,direction:'up'|'down'|'first'|'last',source:Source='gui'):Promise<void>{this.permission(source,'allowSubmit');await this.authorizedJob(id,source);const allowed=source==='mcp'?new Set((await this.jobs(source)).map(j=>j.id)):undefined;await this.queue.move(id,direction,allowed)}
  systemHardware(source:Source='gui') {this.permission(source,'allowInspect');return {hardware:structuredClone(this.hardware.info),engine:this.configuration.engine?{version:this.configuration.engine.version,encoders:this.configuration.engine.encoders,decoders:this.configuration.engine.decoders,filters:this.configuration.engine.filters}:undefined,accelerationValidation:'not-tested',note:'引擎列出的编解码器不代表当前设备可用；硬件加速需实际试编码确认。显存优先采用 NVIDIA 驱动物理容量，其余采用 DXGI 系统可用容量；来源与缺失信息逐项标记。'}}
  async refreshHardware():Promise<void>{await this.track(this.hardware.refresh())}
  async retry(id: string): Promise<Job> { const job = await this.job(id); if (!['failed','cancelled','interrupted'].includes(job.status)) throw new Error('仅失败、取消或中断的任务可重试'); await this.paths.grantFile(job.plan.input.path); if(job.plan.options.subtitleFile)await this.paths.grantFile(job.plan.options.subtitleFile); await this.paths.grantDirectory(join(job.plan.outputPath,'..')); return (await this.submit([{ inputPath: job.plan.input.path, outputPath: job.plan.outputPath, options: job.plan.options }]))[0] }
  async detect(): Promise<Engine | undefined> { const engine = await detectEngine(); if (engine) await this.activate(engine); return engine }
  async selectEngine(pathOrId: string): Promise<Engine> {
    const known = this.configuration.engines.find(e => e.id === pathOrId)
    const engine = known ? await verifyEngine(known.ffmpegPath,known.source) : await verifyEngine(join(localPath(pathOrId),process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),'local')
    await this.activate(engine); return engine
  }
  private exclusiveConfig<T>(operation: () => Promise<T>): Promise<T> { const result = this.configOperations.catch(() => {}).then(operation); this.configOperations = result; return result }
  private async activate(engine: Engine): Promise<void> {
    await this.exclusiveConfig(async () => { const next = structuredClone(this.configuration); next.engine = engine; next.engines = [...next.engines.filter(e => e.id !== engine.id),engine]; await this.configStore.write(next); this.configuration = next; this.notice = undefined; this.emit('update') })
  }
  async downloadEngine(): Promise<void> {
    if (this.downloadActive) throw new Error('引擎正在下载，请稍候')
    this.downloadActive = true; this.downloadController = new AbortController()
    const operation = (async () => {
      try { const engine = await installEngine(this.enginePath,state => { this.download = state; this.emit('update') },this.downloadController?.signal); await this.activate(engine); this.download = { state: 'completed', percent: 100, message: '引擎已启用' } }
      catch (e) { this.download = { state: 'failed', percent: 0, message: (e as Error).message }; throw e }
      finally { this.downloadActive = false; this.emit('update') }
    })()
    await this.track(operation)
  }
  async saveSettings(settings: Settings): Promise<Snapshot> {
    return this.exclusiveConfig(async () => {
      const parsed = settingsSchema.parse(settings)
      for (const root of [...parsed.mcp.inputRoots,...parsed.mcp.outputRoots]) if (!(await stat(await realpath(localPath(root)))).isDirectory()) throw new Error('MCP 授权路径必须是现有目录')
      if (parsed.mcp.enabled && (!parsed.mcp.inputRoots.length || !parsed.mcp.outputRoots.length)) throw new Error('开启 MCP 前请选择媒体与输出目录')
      const next = { ...this.configuration, settings: parsed }
      try { await this.beforeSaveSettings?.(parsed); await this.configStore.write(next) }
      catch (error) {
        try { await this.beforeSaveSettings?.(this.configuration.settings) }
        catch (rollbackError) { this.notice = `设置保存失败，原 MCP 服务未能恢复：${(rollbackError as Error).message}`; this.emit('update') }
        throw error
      }
      this.configuration = next; this.queue.concurrency = parsed.concurrency; this.queue.start(); this.emit('update'); return this.snapshot()
    })
  }
  async savePreset(preset: Preset): Promise<Snapshot> { return this.exclusiveConfig(async () => { const parsed = presetSchema.parse(preset); if (builtInPresets.some(p => p.id === parsed.id)) throw new Error('内置预设不能覆盖'); if(this.configuration.presets.length>=500&&!this.configuration.presets.some(p=>p.id===parsed.id))throw new Error('个人预设数量不能超过 500'); const next = { ...this.configuration, presets: [...this.configuration.presets.filter(p => p.id !== parsed.id),parsed] }; await this.configStore.write(next); this.configuration = next; this.emit('update'); return this.snapshot() }) }
  async deletePreset(id: string): Promise<Snapshot> { return this.exclusiveConfig(async () => { const next = { ...this.configuration, presets: this.configuration.presets.filter(p => p.id !== id) }; await this.configStore.write(next); this.configuration = next; this.emit('update'); return this.snapshot() }) }
  async componentCapabilities(kind:ComponentCapabilities['kind'],name:string) {return componentCapabilities(this.engine,kind,name)}
  async importPresetFile(input:string):Promise<{count:number;names:string[]}> {
    const path=await this.paths.input(input)
    if((await stat(path)).size>2*1024*1024)throw new Error('预设文件不能超过 2 MB')
    let data:unknown
    try {data=JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''))}catch{throw new Error('预设文件不是有效 JSON')}
    const parsed=presetFileSchema.safeParse(data)
    if(!parsed.success)throw new Error('预设格式、版本或参数无效，未导入任何预设')
    return this.exclusiveConfig(async()=>{
      const imported=parsed.data.presets.map(p=>({...p,id:`custom-${randomUUID()}`,options:{...p.options,presetId:undefined,streamIndices:undefined}}))
      if(this.configuration.presets.length+imported.length>500)throw new Error('个人预设数量不能超过 500')
      const next={...this.configuration,presets:[...this.configuration.presets,...imported]}
      await this.configStore.write(next);this.configuration=next;this.emit('update');return {count:imported.length,names:imported.map(p=>p.name)}
    })
  }
  async exportPresetFile(ids:string[],output:string):Promise<void> {
    const all=this.snapshot().presets,presets=ids.map(id=>{const p=all.find(p=>p.id===id);if(!p)throw new Error('预设不存在');return {...p,options:{...p.options,presetId:undefined,streamIndices:undefined}}})
    const data=presetFileSchema.parse({format:'muxivra-presets',version:1,presets})
    await writeFile(await this.paths.output(output),JSON.stringify(data,null,2)+'\n',{flag:'wx'})
  }
  async readSubtitles(input: string): Promise<SubtitleDocument> {
    const path = await this.paths.input(input)
    if ((await stat(path)).size > 10*1024*1024) throw new Error('字幕文件超过 10 MB')
    const buffer = await readFile(path)
    const text = buffer[0] === 0xff && buffer[1] === 0xfe ? buffer.subarray(2).toString('utf16le') : new TextDecoder('utf-8',{ fatal: true }).decode(buffer)
    return { id: randomUUID(), sourcePath: path, cues: parseSrt(text) }
  }
  async saveSession(document: SubtitleDocument): Promise<void> { await this.sessionStore.write(subtitleSchema.parse(document)) }
  async getSession(): Promise<SubtitleDocument | undefined> { const doc = await this.sessionStore.read(undefined); return doc ? subtitleSchema.parse(doc) : undefined }
  async exportSubtitles(document: SubtitleDocument, output: string): Promise<void> { const doc = subtitleSchema.parse(document); if (doc.sourcePath && (await canonicalInput(doc.sourcePath)).toLowerCase() === output.toLowerCase()) throw new Error('请导出到新文件，避免覆盖原字幕'); await writeFile(await this.paths.output(output),serializeSrt(doc.cues),{ flag: 'wx' }) }
  private track<T>(task: Promise<T>): Promise<T> { this.backgroundTasks.add(task); void task.finally(() => this.backgroundTasks.delete(task)).catch(() => {}); return task }
  async waveform(input: string): Promise<number[]> { const media = await this.inspect(input); return this.track(makeWaveform(this.engine,media,this.background.signal)) }
  async shutdown(): Promise<void> { this.background.abort(); this.downloadController?.abort(); await this.queue.shutdown(); await Promise.allSettled([...this.backgroundTasks]); await this.usage.shutdown(); await this.hardware.shutdown(); await this.configOperations.catch(() => {}); await this.configStore.flush(); await this.sessionStore.flush() }
}
