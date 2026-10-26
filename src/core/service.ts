import { DownloadSourceStore } from './download-sources'
import { McpActivityStore } from './mcp/activity'
import { downloadSourcesSchema,type DownloadSources } from '../shared/download-sources'
import { AnalysisCache } from './media/analysis-cache'
import { indexVideo } from './media/video-timing'
import { prepareProjectAnalysis,readProjectVideoTiming,readProjectWaveform } from './media/project-analysis'
import { ensureProjectFonts } from './media/project-fonts'
import { videoTimingSchema,type VideoTiming } from '../shared/video-timing'
import { subtitleToolsSchema,type SubtitleToolsState } from '../shared/subtitle-tools'
import { parseAsrParameters,asrPrecisionIssue } from '../shared/asr-parameters'
import { EventEmitter } from 'node:events'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { join,basename,dirname,extname } from 'node:path'
import { readFile, writeFile, stat, realpath, mkdir, access,copyFile,unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import type { Engine, Job, JobRequest, Settings, Snapshot, Source, Preset, SubtitleDocument, DownloadState } from '../shared/types'
import { settingsSchema, requestSchema, presetSchema, subtitleSchema, presetFileSchema } from '../shared/schema'
import { validateComponentOptions, componentCapabilities } from './engine/options'
import type { ComponentCapabilities } from '../shared/parameters'
import { JsonStore } from './storage/json'
import { PathPolicy, availableOutput, localPath } from './media/paths'
import { buildPlan } from './media/plan'
import { editedDeliveryArgs,deliveryDuration } from './media/delivery'
import { formatCommand } from '../shared/delivery-command'
import { inspectMedia } from './media/probe'
import { run as runEngine } from './engine/process'
import { inputFormatWhitelist } from '../shared/media-policy'
import { detectEngine, verifyEngine, installEngine, managedEngines } from './engine'
import { JobQueue } from './jobs/queue'
import { HardwareStore } from './hardware'
import { UsageMonitor } from './hardware/usage'
import { builtInPresets } from './presets'
import { exportSubtitleText, subtitleExportLosses,parseSubtitleText,serializeAss } from './subtitles/ass'
import { SubtitleProjectStore } from './subtitles/project'
import { McpSubtitleEditor } from './mcp/subtitles'
import { decodeSubtitle } from './subtitles/project'
import { ProjectManager } from './projects'
import { projectImportSchema,projectVideoExportSchema,type ProjectVideoExport,type ProjectImportRequest } from '../shared/projects'
import type { SubtitleExportFormat } from '../shared/subtitles'
import { makeWaveform } from './media/waveform'
import { waveformRequestSchema,waveformWindowSchema,type WaveformRequest,type WaveformWindow } from '../shared/waveform'
import { migrateLegacyShortcuts } from '../shared/shortcuts'
import { McpRequestStore } from './mcp/requests'
import type { DirectoryAccessRequest, TranscodeApprovalRequest, McpRequest } from '../shared/mcp-requests'
import { AsrModels } from './asr/models'
import { executeAsr,readAsrResult,readAsrRaw,asrResultPath } from './asr/runner'
import { asrOptionsSchema,type AsrOptions,type AsrImportRequest } from '../shared/asr'
import type { SubtitleMediaTransfer } from '../shared/subtitle-media'

interface Configuration { settings: Settings; engine?: Engine; engines: Engine[]; presets: Preset[]; defaultOutputRoot?:string; shortcutsVersion?: number }
export class MediaService extends EventEmitter {
  systemLanguages:string[]=[]
  readonly paths = new PathPolicy()
  readonly queue: JobQueue
  readonly hardware: HardwareStore
  readonly usage:UsageMonitor
  readonly asrModels:AsrModels
  readonly mcpSubtitles:McpSubtitleEditor
  private configStore: JsonStore<Configuration>
  readonly projects: ProjectManager
  get subtitleProjects():SubtitleProjectStore{return this.projects.subtitles}
  readonly downloadSources:DownloadSourceStore
  readonly mcpActivity:McpActivityStore
  private requestStore: McpRequestStore
  private configuration!: Configuration
  private configOperations: Promise<unknown> = Promise.resolve()
  private download: DownloadState = { state: 'idle', percent: 0, message: '' }
  private downloadActive = false
  private downloadController?: AbortController
  private background = new AbortController()
  private frameController?:AbortController
  private frameProgress=0
  private frameTask?:Promise<VideoTiming>
  private waveformController?:AbortController
  private waveformTask?:Promise<WaveformWindow>
  private waveformCache=new Map<string,WaveformWindow>()
  private backgroundTasks = new Set<Promise<unknown>>()
  private notice?: string
  private defaultMcpOutputRoot?: string
  mcpState: Snapshot['mcp'] = { running: false }
  beforeSaveSettings?: (settings: Settings) => Promise<void>
  constructor(readonly dataPath: string, readonly enginePath: string, readonly defaultOutputPath?: string,hardwareWorkerPath?:string,projectsRoot?:string,asrAdapterPath?:string,asrInstallationDirectory?:string) {
    super(); this.queue = new JobQueue(dataPath); this.hardware=new HardwareStore(dataPath,()=>this.emit('update')); this.configStore = new JsonStore(join(dataPath,'config.json'))
    this.projects = new ProjectManager(projectsRoot??join(defaultOutputPath?dirname(defaultOutputPath):dataPath,'projects'),dataPath,this.paths,()=>this.emit('update'))
    this.projects.prepareMedia=async(path,directory,signal,progress,options)=>{const media=await this.inspect(path);if(!media.streams.some(stream=>stream.type==='audio'||stream.type==='video'))throw new Error('请选择视频或音频文件');progress('读取项目字体',0);await ensureProjectFonts(this.engine,path,directory,signal);await prepareProjectAnalysis(this.engine,media,directory,signal,(phase,percent)=>progress(phase,5+percent*.95),options)}
    this.mcpSubtitles=new McpSubtitleEditor(()=>this.settings.mcp,()=>({projectId:this.projects.active()?.id,documentId:this.subtitleProjects.get()?.id}))
    this.downloadSources=new DownloadSourceStore(join(dataPath,'download-sources.json'),()=>this.emit('update'))
    this.mcpActivity=new McpActivityStore(join(dataPath,'mcp-activity'),()=>this.emit('update'))
    this.requestStore = new McpRequestStore(join(dataPath,'mcp-requests.json'), () => this.emit('update'))
    this.usage=new UsageMonitor(()=>this.hardware.info,hardwareWorkerPath)
    this.asrModels=new AsrModels(dataPath,()=>this.emit('update'),asrAdapterPath,asrInstallationDirectory??(defaultOutputPath?dirname(defaultOutputPath):dataPath))
    this.queue.artifactRoot=plan=>plan.projectId?this.projects.artifactRoot(plan.projectId):this.dataPath
    this.queue.validateArtifacts=async plan=>{if(plan.projectId)await this.projects.validate(plan.projectId)}
    this.queue.asrExecutor=async(job,context)=>{if(job.plan.projectId)await this.projects.validate(job.plan.projectId);return executeAsr(this.queue.artifactRoot!(job.plan),job,context)}
    this.queue.persistArtifacts=jobs=>this.projects.persistJobRecords(jobs)
    this.queue.on('update',() => this.emit('update'))
    this.queue.on('storage-error',message => { this.notice = message; this.emit('update') })
  }
  async initialize(): Promise<void> {
    const defaults: Configuration = { settings: { theme: 'dark', concurrency: 1, mcp: { enabled: false, port: 19480, token: randomBytes(32).toString('hex'), inputRoots: [], outputRoots: [], allowInspect: true, allowSubmit: true, allowCancel: true } }, engines: [], presets: [] }
    this.configuration = await this.configStore.read(defaults)
    this.configuration.settings = settingsSchema.parse(this.configuration.settings)
    if ((this.configuration.shortcutsVersion ?? 0) < 2) this.configuration.settings.shortcuts = migrateLegacyShortcuts(this.configuration.settings.shortcuts)
    this.configuration.shortcutsVersion = 2
    this.configuration.presets.forEach(preset => presetSchema.parse(preset))
    // Replace the app-managed output grant if an installation is relocated;
    // manually configured output grants remain intact.
    const previousDefault=this.configuration.defaultOutputRoot
    if(previousDefault)this.configuration.settings.mcp.outputRoots=this.configuration.settings.mcp.outputRoots.filter(root=>localPath(root).toLowerCase()!==localPath(previousDefault).toLowerCase())
    this.configuration.defaultOutputRoot=undefined
    try {
      const engine = this.configuration.engine ? await verifyEngine(this.configuration.engine.ffmpegPath,this.configuration.engine.source) : await detectEngine()
      this.configuration.engine = engine
      const managed = await managedEngines(this.enginePath)
      this.configuration.engines = [...new Map([...this.configuration.engines,...managed,...(engine ? [engine] : [])].map(e => [e.id,e])).values()]
    } catch (e) { this.configuration.engine = undefined; this.notice = `引擎不可用：${(e as Error).message}` }
    if(this.defaultOutputPath) {
      try {
        await mkdir(this.defaultOutputPath,{recursive:true});await access(this.defaultOutputPath,constants.W_OK)
        const root=await realpath(this.defaultOutputPath)
        await this.paths.grantDirectory(root)
        this.defaultMcpOutputRoot=root
        this.configuration.defaultOutputRoot=root
        this.configuration.settings.mcp.outputRoots=this.outputRoots(this.configuration.settings.mcp.outputRoots)
      }
      catch(error) { this.notice = `默认输出目录不可写：${this.defaultOutputPath}。请选择其他输出目录。${(error as Error).message}` }
    }
    await this.configStore.write(this.configuration)
    await this.downloadSources.initialize()
    await this.mcpActivity.initialize()
    await this.asrModels.initialize()
    await this.projects.initialize()
    await this.queue.initialize()
    await this.requestStore.initialize(async request => {
      if (request.kind === 'directory') {
        const roots = request.payload.permission === 'input' ? this.settings.mcp.inputRoots : this.settings.mcp.outputRoots
        return roots.some(root => localPath(root).toLowerCase() === request.payload.path.toLowerCase()) ? {} : undefined
      }
      if(request.kind==='download-sources')return JSON.stringify(this.downloadSources.state().configuration)===JSON.stringify(request.payload.configuration)?{}:undefined
      const fingerprint = createHash('sha256').update(JSON.stringify(request.payload.requests)).digest('hex')
      const jobs = this.queue.jobs.filter(job => job.source === 'mcp' && job.requestKey === `approval-${request.id}`)
      return jobs.length === request.payload.requests.length && jobs.every(job => job.requestFingerprint === fingerprint && job.requestJobCount === request.payload.requests.length && !job.requestExpired) ? { jobIds: jobs.map(job => job.id) } : undefined
    })
    await this.hardware.initialize()
    this.queue.concurrency = this.configuration.settings.concurrency
    this.queue.start()
  }
  private outputRoots(roots:string[]):string[] {
    const values=this.defaultMcpOutputRoot?[this.defaultMcpOutputRoot,...roots]:roots
    const seen=new Set<string>()
    return values.filter(root=>{const key=localPath(root).toLowerCase();if(seen.has(key))return false;seen.add(key);return true})
  }
  get settings(): Settings { return structuredClone(this.configuration.settings) }
  get engine(): Engine { if (!this.configuration.engine) throw new Error('未配置 FFmpeg，请前往设置选择或下载引擎'); return structuredClone(this.configuration.engine) }
  snapshot(): Snapshot { return structuredClone({ systemLanguages:this.systemLanguages, engine: this.configuration.engine, engines: this.configuration.engines, jobs: this.queue.list(true), presets: [...builtInPresets,...this.configuration.presets], settings: this.configuration.settings, download: this.download, mcp: this.mcpState, mcpRequests: this.requestStore.counts(), subtitleProject: this.subtitleProjects.state(), notice: this.notice, dataPath: this.dataPath, enginePath: this.enginePath, defaultOutputPath:this.defaultOutputPath,defaultMcpOutputPath:this.defaultMcpOutputRoot,hardware:this.hardware.info,hardwareRefreshing:this.hardware.refreshing,asr:this.asrModels.state(),projects:this.projects.state() }) }
  private roots(source: Source, output = false): string[] | undefined { return source === 'mcp' ? (output ? this.settings.mcp.outputRoots : this.settings.mcp.inputRoots) : undefined }
  private permission(source: Source, action: 'allowInspect' | 'allowSubmit' | 'allowCancel'): void { if (source === 'mcp' && (!this.settings.mcp.enabled || !this.settings.mcp[action])) throw new Error('此 MCP 操作未获授权，请检查设置') }
  async inspect(input: string, source: Source = 'gui') { this.permission(source,'allowInspect'); return inspectMedia(this.engine,await this.paths.input(input,this.roots(source))) }
  async inspectPlayback(input:string) {if(this.configuration.engine)return this.inspect(input);const path=await this.paths.input(input);return {path,name:basename(path),durationMs:0,size:(await stat(path)).size,format:'',streams:[]} as import('../shared/types').MediaInfo}
  async plan(request: JobRequest, source: Source = 'gui', reserved = this.queue.reserved()) {
    this.permission(source,'allowInspect')
    return this.makePlan(request,source,reserved)
  }
  private commandReviews=new Map<string,{request:JobRequest;plan:import('../shared/types').Plan;at:number}>()
  async reviewCommand(request:JobRequest,command:string){
    const plan=await this.plan(request),args=editedDeliveryArgs(plan,command)
    plan.commandEdited=JSON.stringify(args)!==JSON.stringify(plan.args)||undefined
    plan.args=args
    plan.durationMs=deliveryDuration(args,plan.input.durationMs)
    const reviewId=randomUUID()
    for(const [id,value]of this.commandReviews)if(Date.now()-value.at>30*60*1000)this.commandReviews.delete(id)
    if(this.commandReviews.size>=20)this.commandReviews.delete(this.commandReviews.keys().next().value!)
    this.commandReviews.set(reviewId,{request:{inputPath:plan.input.path,outputPath:plan.outputPath,options:{...plan.options,conflict:'reject'}},plan,at:Date.now()})
    return {plan,reviewId}
  }
  async submitCommand(reviewId:string){
    const review=this.commandReviews.get(reviewId)
    if(!review||Date.now()-review.at>30*60*1000)throw new Error('命令检查已过期，请重新检查')
    const jobs=await this.queue.submit([review.request],'gui',reviewId,async(request,reserved)=>{
      const fresh=await this.makePlan(request,'gui',reserved)
      if(fresh.engine.id!==review.plan.engine.id||fresh.engine.ffmpegPath!==review.plan.engine.ffmpegPath||fresh.input.path!==review.plan.input.path||fresh.outputPath!==review.plan.outputPath)throw new Error('引擎或文件路径已变化，请重新检查命令')
      return {...fresh,args:review.plan.args,durationMs:deliveryDuration(review.plan.args,fresh.input.durationMs),commandEdited:review.plan.commandEdited}
    })
    this.commandReviews.delete(reviewId);return jobs
  }
  private async makePlan(request: JobRequest, source: Source, reserved: Set<string>) {
    const parsed = requestSchema.parse(request)
    const input = await this.paths.input(parsed.inputPath,this.roots(source)), output = await this.paths.output(parsed.outputPath,this.roots(source,true))
    if (input.toLowerCase() === output.toLowerCase()) throw new Error('输出不能是原文件')
    const target = await availableOutput(output,reserved,parsed.options.conflict === 'number')
    if(parsed.options.subtitleFile){const path=await this.paths.input(parsed.options.subtitleFile,this.roots(source));if(!/\.(srt|ass|ssa)$/i.test(path)||(await stat(path)).size>10*1024*1024)throw new Error('烧录字幕需要不超过 10 MB 的 SRT/ASS/SSA 文件');parsed.options.subtitleFile=path}
    await validateComponentOptions(this.engine,parsed.options)
    const media=await inspectMedia(this.engine,input),project=this.projects.forMedia(input)
    const subtitleFontsDirectory=project&&parsed.options.subtitleFile&&parsed.options.subtitleMode!=='embed'?await ensureProjectFonts(this.engine,input,project.directory,this.background.signal):undefined
    const plan=buildPlan(this.engine,media,target,parsed.options,{subtitleFontsDirectory})
    plan.projectId=project?.id
    return plan
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
  private requireMcpRequests(): void { if (!this.settings.mcp.enabled) throw new Error('MCP 服务未启用，无法创建申请') }
  mcpRequests(): McpRequest[] { return this.requestStore.list() }
  mcpRequest(id: string): McpRequest { return this.requestStore.get(id) }
  async requestDirectoryAccess(input: DirectoryAccessRequest): Promise<McpRequest> {
    this.requireMcpRequests()
    return this.requestStore.create({ kind: 'directory', requestKey: input.requestKey, reason: input.reason, payload: { path: input.path, permission: input.permission } }, async action => {
      if (action.kind !== 'directory') throw new Error('申请类型无效')
      const path = await realpath(localPath(action.payload.path))
      if (!(await stat(path)).isDirectory()) throw new Error('申请路径必须是现有本地目录')
      return { ...action, payload: { ...action.payload, path } }
    })
  }
  async requestTranscode(input: TranscodeApprovalRequest): Promise<McpRequest> {
    this.requireMcpRequests()
    return this.requestStore.create({ kind: 'transcode', requestKey: input.requestKey, reason: input.reason, payload: { requests: input.requests } }, async action => {
      if (action.kind !== 'transcode') throw new Error('申请类型无效')
      const reserved = this.queue.reserved(), requests: JobRequest[] = []
      for (const request of action.payload.requests) {
        const parsed = requestSchema.parse(request)
        const normalized = { ...parsed, inputPath: await this.paths.input(parsed.inputPath,this.roots('mcp')), outputPath: await this.paths.output(parsed.outputPath,this.roots('mcp',true)) }
        if (normalized.options.subtitleFile) normalized.options.subtitleFile = await this.paths.input(normalized.options.subtitleFile,this.roots('mcp'))
        const plan = await this.makePlan(normalized,'mcp',reserved)
        reserved.add(plan.outputPath.toLowerCase()); requests.push(normalized)
      }
      return { ...action, payload: { requests } }
    })
  }
  async saveDownloadSources(configuration:DownloadSources,revision:string){if(this.asrModels.state().deployment?.active||this.asrModels.state().download.active||this.downloadActive)throw new Error('Downloads are active; retry after completion');return this.downloadSources.save(configuration,revision)}
  async requestDownloadSources(input:{configuration:DownloadSources;expectedRevision:string;requestKey:string;reason:string}){this.requireMcpRequests();return this.requestStore.create({kind:'download-sources',requestKey:input.requestKey,reason:input.reason,payload:{configuration:downloadSourcesSchema.parse(input.configuration),expectedRevision:input.expectedRevision}},async action=>{if(action.kind!=='download-sources'||action.payload.expectedRevision!==this.downloadSources.state().revision)throw new Error('Download sources changed; read again');return action})}
  async reviewMcpRequest(id: string, approve: boolean, note?: string): Promise<McpRequest> {
    return this.requestStore.review(id,approve,note,async request => {
      this.requireMcpRequests()
      if (request.kind === 'directory') {
        await this.exclusiveConfig(async () => {
          const path = await realpath(localPath(request.payload.path))
          if (path.toLowerCase() !== request.payload.path.toLowerCase() || !(await stat(path)).isDirectory()) throw new Error('申请目录已发生变化，请重新申请')
          const settings = this.settings, key = request.payload.permission === 'input' ? 'inputRoots' : 'outputRoots'
          if (!settings.mcp[key].some(root => localPath(root).toLowerCase() === path.toLowerCase())) settings.mcp[key].push(path)
          await this.saveSettingsWithinLock(settings)
        })
        return {}
      }
      if(request.kind==='download-sources'){await this.saveDownloadSources(request.payload.configuration,request.payload.expectedRevision);return {}}
      // A GUI approval authorizes this exact batch once; it does not change the
      // persistent allowSubmit setting or expand any directory permission.
      const jobs = await this.queue.submit(request.payload.requests,'mcp',`approval-${request.id}`,(job,reserved) => { this.requireMcpRequests(); return this.makePlan(job,'mcp',reserved) })
      return { jobIds: jobs.map(job => job.id) }
    })
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
  async deleteJobRecords(ids:string[]):Promise<number>{return this.queue.deleteRecords(ids)}
  async cancel(id: string, source: Source = 'gui'): Promise<Job> { this.permission(source,'allowCancel'); await this.authorizedJob(id,source); return this.queue.cancel(id) }
  async pause(id:string,source:Source='gui'):Promise<Job>{this.permission(source,'allowCancel');await this.authorizedJob(id,source);return this.queue.pause(id)}
  async resume(id:string,source:Source='gui'):Promise<Job>{this.permission(source,'allowCancel');await this.authorizedJob(id,source);return this.queue.resume(id)}
  async moveJob(id:string,direction:'up'|'down'|'first'|'last',source:Source='gui'):Promise<void>{this.permission(source,'allowSubmit');await this.authorizedJob(id,source);const allowed=source==='mcp'?new Set((await this.jobs(source)).map(j=>j.id)):undefined;await this.queue.move(id,direction,allowed)}
  systemHardware(source:Source='gui') {this.permission(source,'allowInspect');return {hardware:structuredClone(this.hardware.info),engine:this.configuration.engine?{version:this.configuration.engine.version,encoders:this.configuration.engine.encoders,decoders:this.configuration.engine.decoders,filters:this.configuration.engine.filters}:undefined,accelerationValidation:'not-tested',note:'引擎列出的编解码器不代表当前设备可用；硬件加速需实际试编码确认。显存优先采用 NVIDIA 驱动物理容量，其余采用 DXGI 系统可用容量；来源与缺失信息逐项标记。'}}
  async refreshHardware():Promise<void>{await this.track(this.hardware.refresh())}
  async retry(id:string):Promise<Job>{
    const job=await this.job(id)
    if(!['failed','cancelled','interrupted'].includes(job.status))throw new Error('仅失败、取消或中断的任务可重试')
    await this.paths.grantFile(job.plan.input.path)
    if(job.plan.kind==='asr')return this.asrSubmit(job.plan.asr.options)
    if(job.plan.options.subtitleFile)await this.paths.grantFile(job.plan.options.subtitleFile)
    await this.paths.grantDirectory(dirname(job.plan.outputPath))
    const request={inputPath:job.plan.input.path,outputPath:job.plan.outputPath,options:job.plan.options}
    if(job.plan.commandEdited){
      const fresh=await this.plan(request),review=await this.reviewCommand({...request,outputPath:fresh.outputPath},formatCommand(fresh.engine.ffmpegPath,[...job.plan.args.slice(0,-1),fresh.outputPath]))
      return (await this.submitCommand(review.reviewId))[0]
    }
    return (await this.submit([request]))[0]
  }
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
    return this.exclusiveConfig(() => this.saveSettingsWithinLock(settings))
  }
  private async saveSettingsWithinLock(settings: Settings): Promise<Snapshot> {
      const parsed = settingsSchema.parse(settings)
      parsed.mcp.outputRoots=this.outputRoots(parsed.mcp.outputRoots)
      if(parsed.mcp.outputRoots.length>(this.defaultMcpOutputRoot?33:32))throw new Error('最多添加 32 个输出目录，另含可用的默认 outputs 目录')
      for (const root of [...parsed.mcp.inputRoots,...parsed.mcp.outputRoots]) if (!(await stat(await realpath(localPath(root)))).isDirectory()) throw new Error('MCP 授权路径必须是现有目录')
      if (parsed.mcp.enabled && !parsed.mcp.outputRoots.length) throw new Error('默认 outputs 不可用，请添加可用的输出目录')
      const next = { ...this.configuration, settings: parsed }
      try { await this.beforeSaveSettings?.(parsed); await this.configStore.write(next) }
      catch (error) {
        try { await this.beforeSaveSettings?.(this.configuration.settings) }
        catch (rollbackError) { this.notice = `设置保存失败，原 MCP 服务未能恢复：${(rollbackError as Error).message}`; this.emit('update') }
        throw error
      }
      this.configuration = next; this.queue.concurrency = parsed.concurrency; this.queue.start(); this.emit('update'); return this.snapshot()
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
  async importProject(request:ProjectImportRequest){
    const value=projectImportSchema.parse(request),path=await this.paths.input(value.path)
    const info=await this.inspect(path)
    if(info&&!info.streams.some(s=>s.type==='video'||s.type==='audio'))throw new Error('请选择视频或音频文件')
    let subtitle:{name:string;content:Buffer;document:SubtitleDocument}|undefined
    if(value.subtitlePath){
      const source=await this.paths.input(value.subtitlePath),format=extname(source).slice(1).toLowerCase()
      if(!['ass','ssa','srt'].includes(format)||(await stat(source)).size>10*1024*1024)throw new Error('初始字幕需要不超过 10 MB 的 ASS、SSA 或 SRT 文件')
      const content=await readFile(source);if(content.length>10*1024*1024)throw new Error('字幕文件超过 10 MB')
      subtitle={name:basename(source),content,document:parseSubtitleText(decodeSubtitle(content),format as SubtitleExportFormat)}
    }
    const video=info?.streams.find(s=>s.type==='video'),resolution=value.resolutionMode==='custom'?value.resolution:value.resolutionMode==='auto'&&video?.width&&video.height?{width:video.width,height:video.height}:undefined
    const result=await this.projects.importMedia(path,value.deleteOriginal,false,{name:value.name,subtitle,resolution,exportFormat:value.exportFormat})
    if(result.warning)this.notice=result.warning;return result
  }
  async openProject(id:string){return this.projects.open(id)}
  async importProjectSubtitle(id:string,input:string):Promise<SubtitleDocument>{
    const project=this.projects.active(),current=this.subtitleProjects.get()
    if(!project||project.id!==id||!current)throw new Error('请先打开目标项目，再导入字幕')
    const path=await this.paths.input(input),extension=extname(path).slice(1).toLowerCase()
    if(!['ass','ssa','srt'].includes(extension)||(await stat(path)).size>10*1024*1024)throw new Error('请选择不超过 10 MB 的 ASS、SSA 或 SRT 字幕')
    const content=await readFile(path);if(content.length>10*1024*1024)throw new Error('字幕文件超过 10 MB')
    let document=parseSubtitleText(decodeSubtitle(content),extension as SubtitleExportFormat)
    if(extension==='srt')document={...document,scriptInfo:{...document.scriptInfo,...Object.fromEntries(['PlayResX','PlayResY'].flatMap(key=>current.scriptInfo?.[key]!==undefined?[[key,current.scriptInfo[key]]]:[]))}}
    return this.projects.importSubtitle(id,{name:basename(path),content,document})
  }
  async projectEmbeddedSubtitles(id:string){
    const project=this.projects.get(id);await this.projects.validate(id)
    const media=await this.inspect(project.mediaPath)
    return media.streams.filter(stream=>stream.type==='subtitle'&&['ass','ssa','subrip','mov_text','webvtt','text'].includes(stream.codec)).map(({index,codec,language,title})=>({index,codec,language,title}))
  }
  async importEmbeddedProjectSubtitle(id:string,index:number):Promise<SubtitleDocument>{
    if(!Number.isInteger(index)||index<0)throw new Error('字幕轨道无效')
    return this.projects.importSubtitle(id,async project=>{
      const track=(await this.projectEmbeddedSubtitles(id)).find(track=>track.index===index)
      if(!track)throw new Error('请选择项目媒体中存在的文本字幕轨道')
      const temporary=join(project.directory,`.subtitle-extract-${randomUUID()}.ass`)
      try{
        await runEngine(this.engine.ffmpegPath,['-v','error','-nostdin','-protocol_whitelist','file,pipe','-format_whitelist',inputFormatWhitelist,'-i',project.mediaPath,'-map',`0:${index}`,'-c:s',track.codec==='ass'?'copy':'ass','-f','ass',temporary],{timeout:120000,signal:this.background.signal})
        if((await stat(temporary)).size>10*1024*1024)throw new Error('字幕轨道超过 10 MB')
        const content=await readFile(temporary),document=parseSubtitleText(decodeSubtitle(content),'ass')
        const label=[track.language,track.title].filter(Boolean).join('-').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,100)
        return {name:`track-${index}${label?'-'+label:''}.ass`,content,document}
      }finally{await unlink(temporary).catch(()=>{})}
    })
  }
  async rebuildProjectAnalysis(id:string){
    if(this.queue.jobs.some(job=>job.plan.projectId===id&&['queued','running','paused'].includes(job.status)))throw new Error('项目仍有未结束任务，请先取消或完成任务再重新预处理')
    this.frameController?.abort();await this.frameTask?.catch(()=>{});this.waveformController?.abort();await this.waveformTask?.catch(()=>{})
    await this.projects.rebuildAnalysis(id)
  }
  async closeProject(id:string){this.frameController?.abort();await this.frameTask?.catch(()=>{});this.waveformController?.abort();await this.waveformTask?.catch(()=>{});await this.projects.close(id)}
  async archiveProject(id:string){
    if(this.queue.jobs.some(j=>j.plan.projectId===id&&['queued','running','paused'].includes(j.status)))throw new Error('项目仍有未结束任务，请先取消或完成任务')
    this.waveformController?.abort();await this.waveformTask?.catch(()=>{})
    const result=await this.projects.archive(id);this.paths.files.forEach(path=>{if(path.toLowerCase().startsWith(this.projects.state().items.find(p=>p.id===id)!.directory.toLowerCase()))this.paths.files.delete(path)});return result
  }
  async duplicateProject(){const current=this.subtitleProjects.get(),project=this.projects.active();if(!project||!current)throw new Error('请先打开项目');await this.subtitleProjects.cache(current);const copy=await this.projects.importMedia(project.mediaPath,false,true);return this.saveSubtitleProject({...current,id:copy.document.id,mediaPath:copy.document.mediaPath,projectPath:copy.document.projectPath,sourcePath:undefined})}
  async openSubtitleMedia(input: string, _projectPath?: string): Promise<SubtitleDocument> {
    const path=await this.paths.input(input),project=this.projects.forMedia(path)
    if(project)return this.projects.open(project.id)
    throw new Error('请先在项目管理中创建项目，再打开已有工程')
  }
  async asrImport(request:AsrImportRequest){return this.track(this.asrModels.import(request))}
  async asrSubmit(input:AsrOptions):Promise<Job>{
    const options=asrOptionsSchema.parse(input),model=this.asrModels.get(options.modelId),media=await this.inspect(options.inputPath),project=this.projects.forMedia(media.path)
    if(!project)throw new Error('请先将媒体导入项目，再提交 ASR 识别')
    options.parameters=parseAsrParameters(model.backend,options.parameters)
    const precisionIssue=asrPrecisionIssue(model.backend,options.parameters,options.device);if(precisionIssue)throw new Error(precisionIssue)
    if(model.availability!=='ready')throw new Error(model.issue??'模型或环境不可用')
    if(model.backend==='qwen3-asr'&&options.parameters.timestamps&&!model.environment?.alignerPath)throw new Error('请在运行环境中指定 Qwen3-ForcedAligner，再启用时间戳')
    if(!media.streams.some(s=>s.type==='audio'&&s.index===options.audioStream))throw new Error('请选择媒体中存在的音轨')
    if(!media.durationMs||options.startMs>=media.durationMs||options.endMs!==undefined&&options.endMs<=options.startMs)throw new Error('识别区间无效')
    const id=randomUUID(),end=Math.min(options.endMs??media.durationMs,media.durationMs)
    return this.queue.submitAsr({kind:'asr',projectId:project.id,input:media,outputPath:asrResultPath(project.directory,id),engine:this.engine,args:[],warnings:[],durationMs:end-options.startMs,asr:{model,options:{...options,inputPath:media.path}}},id)
  }
  async asrResult(id:string){const job=await this.job(id);return readAsrResult(this.queue.artifactRoot!(job.plan),job)}
  async asrRaw(id:string,index:number){const job=await this.job(id);return readAsrRaw(this.queue.artifactRoot!(job.plan),job,index)}
  async readSubtitles(input: string, _projectPath?: string): Promise<SubtitleDocument> {
    const project=this.projects.active(),current=this.subtitleProjects.get();if(!project||!current)throw new Error('请先导入媒体或打开项目，再导入字幕')
    const source=await this.paths.input(input),extension=extname(source).slice(1).toLowerCase();if(!['ass','ssa','srt'].includes(extension))throw new Error('请选择 ASS、SSA 或 SRT 字幕')
    if((await stat(source)).size>10*1024*1024)throw new Error('字幕文件超过 10 MB')
    const parsed=parseSubtitleText(decodeSubtitle(await readFile(source)),extension as SubtitleExportFormat),directory=join(project.directory,'imports');await mkdir(directory,{recursive:true})
    const target=await availableOutput(join(directory,basename(source)),new Set(),true);await copyFile(source,target,constants.COPYFILE_EXCL)
    return this.saveSubtitleProject({...parsed,id:current.id,mediaPath:current.mediaPath,projectPath:current.projectPath,sourcePath:current.sourcePath})
  }
  async saveSession(document:SubtitleDocument):Promise<void>{await this.projects.cache(document)}
  async getSession():Promise<SubtitleDocument|undefined>{return this.projects.active()?this.subtitleProjects.get():undefined}
  async saveSubtitleProject(document:SubtitleDocument):Promise<SubtitleDocument>{const next=await this.projects.save(document);if(!next)throw new Error('字幕工程已切换，旧编辑请求已停止');return next}
  async prepareSubtitleMedia(input:SubtitleDocument):Promise<SubtitleMediaTransfer>{
    const document=subtitleSchema.parse(input),project=this.projects.active(),current=this.subtitleProjects.get()
    if(!project||!current||document.id!==current.id||document.projectPath!==project.subtitlePath)throw new Error('请打开当前字幕工程后再转到单文件处理')
    const saved=await this.saveSubtitleProject(document),outputDirectory=join(project.directory,'exports');await mkdir(outputDirectory,{recursive:true});await this.paths.grantDirectory(outputDirectory)
    const subtitlePath=join(outputDirectory,`subtitle-${randomUUID()}.ass`);await writeFile(subtitlePath,serializeAss(saved),{flag:'wx'});await this.paths.grantFile(subtitlePath)
    return {id:randomUUID(),projectId:project.id,projectName:project.name,media:await this.inspectPlayback(project.mediaPath),subtitlePath,outputDirectory}
  }
  async saveSubtitleProjectAs(document: SubtitleDocument, _path?: string): Promise<SubtitleDocument> {await this.subtitleProjects.cache(document);return this.duplicateProject()}
  async deleteSubtitleProject(documentId: string): Promise<SubtitleDocument> {if(this.subtitleProjects.get()?.id!==documentId)throw new Error('当前工程已切换');return this.archiveProject(this.projects.active()!.id)}
  async exportProjectVideo(input:ProjectVideoExport,output:string):Promise<Job>{
    const options=projectVideoExportSchema.parse(input),project=this.projects.active(),document=this.subtitleProjects.get();if(!project||!document)throw new Error('请先打开项目')
    if(!document.cues.some(c=>!c.comment&&c.text.trim()&&c.endMs>c.startMs))throw new Error('项目没有有效字幕')
    const saved=await this.saveSubtitleProject(document),directory=join(project.directory,'exports');await mkdir(directory,{recursive:true});await this.paths.grantDirectory(directory)
    const subtitle=join(directory,`subtitle-${randomUUID()}.ass`);await writeFile(subtitle,serializeAss(saved),{flag:'wx'});await this.paths.grantFile(subtitle)
    const video=options.mode==='embed'?'copy':options.video
    const jobs=await this.submit([{inputPath:project.mediaPath,outputPath:output,options:{container:options.container,video,audio:options.audio,quality:options.quality,speed:options.speed,audioBitrate:192,subtitles:'none',conflict:'number',subtitleFile:subtitle,subtitleMode:options.mode,...(options.mode==='embed'&&options.container==='mkv'?{advanced:{attachments:'copy'}}:{})}}])
    return jobs[0]
  }
  subtitleExportLosses(document: SubtitleDocument, format: SubtitleExportFormat): string[] { return subtitleExportLosses(subtitleSchema.parse(document), format) }
  async exportSubtitles(document: SubtitleDocument, output: string, format: SubtitleExportFormat = 'srt'): Promise<void> {
    const doc = subtitleSchema.parse(document)
    const target = await this.paths.output(output)
    if (doc.sourcePath && localPath(doc.sourcePath).toLowerCase() === target.toLowerCase()) throw new Error('请导出到新文件，避免覆盖原字幕')
    if (doc.projectPath?.toLowerCase() === target.toLowerCase()) throw new Error('导出不能覆盖 ASS 工程，请使用保存工程')
    await writeFile(target, exportSubtitleText(doc, format), { flag: 'wx' })
  }
  private track<T>(task: Promise<T>): Promise<T> { this.backgroundTasks.add(task); void task.finally(() => this.backgroundTasks.delete(task)).catch(() => {}); return task }
  async importSubtitleStyles(input:string){const path=await this.paths.input(input),extension=extname(path).slice(1).toLowerCase();if(!['ass','ssa'].includes(extension))throw new Error('Choose ASS or SSA');if((await stat(path)).size>10*1024*1024)throw new Error('Subtitle file exceeds 10 MiB');return parseSubtitleText(decodeSubtitle(await readFile(path)),extension as SubtitleExportFormat).styles??[]}
  async subtitleTools():Promise<SubtitleToolsState>{return subtitleToolsSchema.parse(await new JsonStore(join(this.dataPath,'subtitle-tools.json')).read({}))}
  private toolsStore?:JsonStore<SubtitleToolsState>
  async saveSubtitleTools(value:SubtitleToolsState){const parsed=subtitleToolsSchema.parse(value);this.toolsStore??=new JsonStore(join(this.dataPath,'subtitle-tools.json'));await this.toolsStore.write(parsed)}
  videoFrameProgress(){return this.frameProgress}
  cancelVideoFrames(){this.frameController?.abort()}
  async videoFrames(input:string):Promise<VideoTiming>{
    this.frameController?.abort();const controller=new AbortController();this.frameController=controller;this.frameProgress=0
    const signal=AbortSignal.any([controller.signal,this.background.signal])
    const task=this.track((async()=>{const path=await this.paths.input(input),project=this.projects.forMedia(path);if(project){await this.projects.validate(project.id);const timing=await readProjectVideoTiming(project.directory,path,signal);this.frameProgress=100;return timing}const media=await this.inspect(path),file=await stat(media.path),cache=new AnalysisCache(join(this.dataPath,'cache','video-timing')),key=cache.key(['video-timing-v1',this.engine.ffprobePath,media.path,file.size,file.mtimeMs]);if(signal.aborted)throw new Error('Frame indexing cancelled');const saved=await cache.read(key,value=>videoTimingSchema.parse(value));if(saved){this.frameProgress=100;return saved}const frames=await indexVideo(this.engine,media,signal,percent=>{this.frameProgress=percent});if(!signal.aborted)await cache.write(key,frames).catch(()=>{});return frames})());this.frameTask=task
    try{return await task}finally{if(this.frameTask===task)this.frameTask=undefined}
  }
  async waveform(input:string,options:Partial<WaveformRequest>={}):Promise<WaveformWindow> {
    const request=waveformRequestSchema.parse(options)
    this.waveformController?.abort();const controller=new AbortController();this.waveformController=controller
    const signal=AbortSignal.any([controller.signal,this.background.signal])
    const task=this.track((async()=>{
      const path=await this.paths.input(input),project=this.projects.forMedia(path)
      if(project){await this.projects.validate(project.id);return readProjectWaveform(project.directory,path,request,signal)}
      const media=await this.inspect(input);if(signal.aborted)throw new Error('波形读取已取消')
      const file=await stat(media.path),key=JSON.stringify([this.engine.ffmpegPath,media.path,file.size,file.mtimeMs,request])
      const cached=this.waveformCache.get(key);if(cached){this.waveformCache.delete(key);this.waveformCache.set(key,cached);return cached}
      const disk=new AnalysisCache(join(this.dataPath,'cache','waveform')),diskKey=disk.key(['waveform-v2',key])
      const saved=await disk.read(diskKey,value=>waveformWindowSchema.parse(value));if(saved){if(signal.aborted)throw new Error('波形读取已取消');return saved}
      const wave=await makeWaveform(this.engine,media,request,signal)
      if(signal.aborted)throw new Error('波形读取已取消')
      await disk.write(diskKey,wave).catch(()=>{})
      this.waveformCache.set(key,wave);while(this.waveformCache.size>32)this.waveformCache.delete(this.waveformCache.keys().next().value!)
      return wave
    })());this.waveformTask=task
    try{return await task}finally{if(this.waveformTask===task)this.waveformTask=undefined}
  }
  async shutdown(): Promise<void> { await this.mcpActivity.flush(); await this.toolsStore?.flush(); this.background.abort(); this.downloadController?.abort(); await this.asrModels.shutdown(); await this.projects.shutdown(); await this.requestStore.shutdown(); await this.queue.shutdown(); await Promise.allSettled([...this.backgroundTasks]); await this.usage.shutdown(); await this.hardware.shutdown(); await this.configOperations.catch(() => {}); await this.configStore.flush() }
}
