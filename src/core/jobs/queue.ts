import { EventEmitter } from 'node:events'
import { randomUUID, createHash } from 'node:crypto'
import { join, dirname, basename, extname } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createWriteStream, constants } from 'node:fs'
import { stat, unlink, link, copyFile, readFile, mkdir } from 'node:fs/promises'
import type { Job, JobRequest, Plan, Source } from '../../shared/types'
import { JsonStore } from '../storage/json'
import { exists, canonicalInput, canonicalOutput } from '../media/paths'
import { stopProcess } from '../engine/process'
import { suspendChild } from './process-control'

export class JobQueue extends EventEmitter {
  jobs: Job[] = []
  concurrency = 1
  paused = false
  private children = new Map<string, ChildProcessWithoutNullStreams>()
  private cancelled = new Set<string>()
  private activeSince = new Map<string, number>()
  private operations: Promise<unknown> = Promise.resolve()
  private executions = new Set<Promise<void>>()
  private store: JsonStore<Job[]>
  private requests = new Map<string, { fingerprint: string; ids: string[] }>()
  private persistenceError?: string
  constructor(readonly dataPath: string) { super(); this.store = new JsonStore(join(dataPath,'jobs.json')) }
  async initialize(): Promise<void> {
    this.jobs = await this.store.read([])
    for (const job of this.jobs) {
      if (job.status === 'running' || job.status === 'paused' && job.pausedFrom === 'running') {
        job.status = 'interrupted'; job.error = '应用上次运行意外中断，请检查后重试'; job.finishedAt = new Date().toISOString()
        delete job.pausedFrom
        const expected = this.temporaryPath(job.plan, job.id)
        if (job.temporaryPath === expected) await unlink(expected).catch(() => {})
      }
      if (job.requestKey) {
        const key = `${job.source}:${job.requestKey}`
        const entry = this.requests.get(key) ?? { fingerprint: '', ids: [] }
        entry.ids.push(job.id); this.requests.set(key, entry)
      }
    }
    for (const entry of this.requests.values()) entry.fingerprint = this.get(entry.ids[0]).requestFingerprint ?? this.fingerprint(entry.ids.map(id => this.get(id)).map(j => ({ inputPath: j.plan.input.path, outputPath: j.plan.outputPath, options: j.plan.options })))
    await this.store.write(this.jobs)
    await mkdir(join(this.dataPath,'logs'), { recursive: true })
  }
  get(id: string): Job { const job = this.jobs.find(j => j.id === id); if (!job) throw new Error('任务不存在'); return this.describe(job) }
  list(): Job[] { return this.jobs.map(job => this.describe(job)) }
  private describe(job: Job): Job {
    const result = structuredClone(job), since = this.activeSince.get(job.id)
    result.cancelling = this.cancelled.has(job.id) || undefined
    result.elapsedMs = (job.elapsedMs ?? 0) + (since === undefined ? 0 : Math.max(0,Date.now()-since))
    result.estimateBasis = 'unknown'; delete result.estimatedRemainingMs
    const duration = job.plan.durationMs ?? job.plan.input.durationMs
    if (['running','paused'].includes(job.status) && job.processedMs > 0 && result.elapsedMs >= 1000 && duration > 0) {
      result.estimatedRemainingMs = Math.max(0,(duration-job.processedMs)*result.elapsedMs/job.processedMs); result.estimateBasis = 'progress'
    } else if (['queued','paused'].includes(job.status) && !job.startedAt && duration > 0) {
      const examples = this.jobs.filter(j => j.status === 'completed' && (j.elapsedMs ?? 0) > 0 && JSON.stringify(j.plan.options) === JSON.stringify(job.plan.options) && j.plan.input.streams.some(s=>s.type==='video')===job.plan.input.streams.some(s=>s.type==='video') && j.plan.input.streams.find(s=>s.type==='video')?.width===job.plan.input.streams.find(s=>s.type==='video')?.width && j.plan.input.streams.find(s=>s.type==='video')?.height===job.plan.input.streams.find(s=>s.type==='video')?.height && j.plan.engine.id===job.plan.engine.id).slice(-5)
      const rates = examples.flatMap(j => { const d=j.plan.durationMs??j.plan.input.durationMs; return d>0?[(j.elapsedMs??0)/d]:[] })
      if (rates.length) { result.estimatedRemainingMs = duration*rates.reduce((a,b)=>a+b,0)/rates.length; result.estimateBasis = 'history' }
    }
    return result
  }
  private stopClock(job: Job): void { const since=this.activeSince.get(job.id); if(since!==undefined)job.elapsedMs=(job.elapsedMs??0)+Math.max(0,Date.now()-since); this.activeSince.delete(job.id) }
  reserved(): Set<string> { return new Set(this.jobs.filter(j => ['queued','running','paused'].includes(j.status)).map(j => j.plan.outputPath.toLowerCase())) }
  async submit(requests: JobRequest[], source: Source, requestKey: string | undefined, makePlan: (request: JobRequest, reserved: Set<string>) => Promise<Plan>): Promise<Job[]> {
    return this.exclusive(async () => {
      if (this.paused) throw new Error('应用正在退出，无法提交任务')
      if (this.persistenceError) throw new Error(this.persistenceError)
      const key = requestKey ? `${source}:${requestKey}` : undefined
      const fingerprint = this.fingerprint(requests)
      const previous = key ? this.requests.get(key) : undefined
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error('去重标识已用于另一组参数，请使用新的标识')
        return previous.ids.map(id => this.get(id))
      }
      const reserved = this.reserved()
      const plans: Plan[] = []
      for (const request of requests) { const plan = await makePlan(request, reserved); reserved.add(plan.outputPath.toLowerCase()); plans.push(plan) }
      const batchId = plans.length > 1 ? randomUUID() : undefined
      const jobs: Job[] = plans.map(plan => {
        const id = randomUUID()
        return { id, batchId, requestKey, requestFingerprint: fingerprint, source, plan, createdAt: new Date().toISOString(), status: 'queued', progress: 0, processedMs: 0, speed: '',
          logTail: '', logPath: join(this.dataPath,'logs',`${id}.log`), temporaryPath: this.temporaryPath(plan,id) }
      })
      const next = [...this.jobs, ...jobs]
      await this.store.write(next)
      this.jobs = next
      if (key) this.requests.set(key, { fingerprint, ids: jobs.map(j => j.id) })
      const response = structuredClone(jobs)
      this.emit('update')
      setImmediate(() => this.pump())
      return response
    })
  }
  private fingerprint(requests: JobRequest[]): string { return createHash('sha256').update(JSON.stringify(requests)).digest('hex') }
  private temporaryPath(plan: Plan, id: string): string { return join(dirname(plan.outputPath),`.${basename(plan.outputPath)}.${id}.muxivra-part${extname(plan.outputPath)}`) }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> { const result = this.operations.catch(() => {}).then(operation); this.operations = result; return result }
  async cancel(id: string): Promise<Job> {
    return this.exclusive(async () => {
      const job = this.jobs.find(j => j.id === id)
      if (!job) throw new Error('任务不存在')
      if (job.status === 'queued' || job.status === 'paused' && job.pausedFrom === 'queued') { job.status = 'cancelled'; delete job.pausedFrom; job.finishedAt = new Date().toISOString(); await this.persist(); this.emit('update') }
      else if (job.status === 'running' || job.status === 'paused' && job.pausedFrom === 'running') {
        this.cancelled.add(id)
        this.emit('update')
        const child = this.children.get(id)
        if (child) {
          if (job.status === 'paused') { try { suspendChild(child,false) } catch { child.kill() } }
          const clear = stopProcess(child); child.once('close',clear)
        }
      }
      return this.get(id)
    })
  }
  async pause(id: string): Promise<Job> {
    return this.exclusive(async () => {
      if(this.paused)throw new Error('应用正在退出')
      const job=this.jobs.find(j=>j.id===id);if(!job)throw new Error('任务不存在')
      if(job.status==='paused')return this.get(id)
      if(!['queued','running'].includes(job.status)||this.cancelled.has(id))throw new Error('当前任务不能暂停')
      const previous=job.status as 'queued'|'running'
      if(previous==='running'){const child=this.children.get(id);if(!child)throw new Error('任务正在启动或收尾，请稍后再试');suspendChild(child,true);this.stopClock(job)}
      job.status='paused';job.pausedFrom=previous
      try {await this.persist()} catch(error) {
        if(previous==='running'){const child=this.children.get(id);if(child){try{suspendChild(child,false)}catch{child.kill()}}this.activeSince.set(id,Date.now())}
        job.status=previous;delete job.pausedFrom;throw error
      }
      this.emit('update');return this.get(id)
    })
  }
  async resume(id: string): Promise<Job> {
    return this.exclusive(async () => {
      if(this.paused)throw new Error('应用正在退出')
      const job=this.jobs.find(j=>j.id===id);if(!job)throw new Error('任务不存在')
      if(job.status!=='paused')return this.get(id)
      if(this.cancelled.has(id))throw new Error('任务正在取消')
      const previous=job.pausedFrom??'queued'
      if(previous==='running'){const child=this.children.get(id);if(!child)throw new Error('处理进程已结束');suspendChild(child,false);this.activeSince.set(id,Date.now())}
      job.status=previous;delete job.pausedFrom
      await this.persist();this.emit('update');setImmediate(()=>this.pump());return this.get(id)
    })
  }
  async move(id: string, direction: 'up'|'down'|'first'|'last', allowed?: Set<string>): Promise<void> {
    return this.exclusive(async()=>{
      const movable=this.jobs.filter(j=>j.status==='queued'||j.status==='paused'&&j.pausedFrom==='queued').filter(j=>!allowed||allowed.has(j.id))
      const index=movable.findIndex(j=>j.id===id);if(index<0)throw new Error('只能调整尚未开始的任务顺序')
      const target=direction==='first'?0:direction==='last'?movable.length-1:Math.max(0,Math.min(movable.length-1,index+(direction==='up'?-1:1)))
      movable.splice(target,0,...movable.splice(index,1));let cursor=0
      const ids=new Set(movable.map(j=>j.id)),next=this.jobs.map(j=>ids.has(j.id)?movable[cursor++]:j)
      await this.store.write(next);this.jobs=next;this.emit('update')
    })
  }
  start(): void { this.pump() }
  private pump(): void {
    if (this.paused || this.persistenceError) return
    while (this.executions.size < this.concurrency) {
      const job = this.jobs.find(j => j.status === 'queued')
      if (!job) break
      job.status = 'running'
      const execution = this.execute(job)
      this.executions.add(execution)
      void execution.finally(() => { this.executions.delete(execution); this.pump() })
    }
  }
  private async execute(job: Job): Promise<void> {
    let log: ReturnType<typeof createWriteStream> | undefined
    let started = false
    try {
      job.startedAt = new Date().toISOString()
      job.elapsedMs=0;this.activeSince.set(job.id,Date.now())
      await this.persist(); this.emit('update')
      if (this.cancelled.has(job.id)) throw new Error('操作已取消')
      if (await canonicalInput(job.plan.input.path) !== job.plan.input.path || await canonicalOutput(job.plan.outputPath) !== job.plan.outputPath) throw new Error('文件路径在提交后发生变化，请重新提交')
      if(job.plan.options.subtitleFile&&await canonicalInput(job.plan.options.subtitleFile)!==job.plan.options.subtitleFile)throw new Error('字幕路径在提交后发生变化，请重新提交')
      if (await exists(job.plan.outputPath)) throw new Error('输出文件已存在，拒绝覆盖')
      if (await exists(job.temporaryPath)) throw new Error('临时文件已存在，请检查日志')
      const args = [...job.plan.args.slice(0,-1),job.temporaryPath]
      log = createWriteStream(job.logPath, { flags: 'a' })
      let logFailure: Error | undefined
      log.on('error',error => { logFailure = error; this.children.get(job.id)?.kill() })
      log.write(JSON.stringify({ engine: job.plan.engine.ffmpegPath, args }) + '\n')
      const child = spawn(job.plan.engine.ffmpegPath,args,{ shell: false, windowsHide: true, stdio: 'pipe' })
      started = true
      this.children.set(job.id,child)
      if (this.cancelled.has(job.id)) { const clear = stopProcess(child); child.once('close',clear) }
      let buffer = '', lastEvent = 0, childError: Error | undefined
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? ''
        for (const line of lines) {
          const [key,value] = line.split('=')
          if (key === 'out_time_us') { job.processedMs = Math.max(0,Number(value) / 1000 || 0); const duration=job.plan.durationMs??job.plan.input.durationMs;job.progress = duration ? Math.min(99.9,job.processedMs / duration * 100) : 0 }
          if (key === 'speed') job.speed = value?.trim() ?? ''
        }
        if (Date.now()-lastEvent > 200) { this.emit('update'); lastEvent = Date.now() }
      })
      child.stderr.on('data', (chunk: Buffer) => { job.logTail = (job.logTail+chunk.toString()).slice(-16000); log?.write(chunk) })
      child.on('error',error => { childError = error })
      const code = await new Promise<number | null>(resolve => child.on('close',resolve))
      if (this.cancelled.has(job.id)) throw new Error('操作已取消')
      if (childError || logFailure) throw childError ?? logFailure
      if (code !== 0) throw new Error(job.logTail.trim().split(/\r?\n/).slice(-5).join('\n') || `FFmpeg 退出码 ${code}`)
      const output = await stat(job.temporaryPath)
      if (this.cancelled.has(job.id)) throw new Error('操作已取消')
      if (!output.isFile() || !output.size) throw new Error('没有生成有效输出文件')
      // Hard-link publication is atomic and refuses existing destinations. Copy fallback is also exclusive.
      try { await link(job.temporaryPath,job.plan.outputPath) }
      catch (e) { if (!['EPERM','ENOTSUP','EXDEV','EOPNOTSUPP'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; await copyFile(job.temporaryPath,job.plan.outputPath,constants.COPYFILE_EXCL) }
      await unlink(job.temporaryPath)
      job.status = 'completed'; job.progress = 100; job.outputSize = output.size
    } catch (e) {
      if (started) await unlink(job.temporaryPath).catch(() => {})
      job.status = this.cancelled.has(job.id) ? 'cancelled' : 'failed'; job.error = (e as Error).message
    } finally {
      this.stopClock(job);delete job.pausedFrom
      this.children.delete(job.id); this.cancelled.delete(job.id)
      if (log && !log.closed) await new Promise<void>(resolve => { log!.end(resolve); if (log!.destroyed) resolve() })
      job.finishedAt = new Date().toISOString()
      await this.persist().catch(e => { this.persistenceError = `任务历史无法保存：${(e as Error).message}`; this.emit('storage-error',this.persistenceError) })
      this.emit('update')
    }
  }
  private async persist(): Promise<void> { await this.store.write(this.jobs) }
  async log(id: string): Promise<string> { const job = this.get(id); const data = await readFile(job.logPath).catch(() => Buffer.from(job.logTail)); return data.subarray(Math.max(0,data.length-128*1024)).toString() }
  async shutdown(): Promise<void> { this.paused = true; await this.operations.catch(() => {}); for (const job of this.jobs.filter(j => j.status === 'running'||j.status==='paused'&&j.pausedFrom==='running')) await this.cancel(job.id); await Promise.allSettled([...this.executions]); await this.store.flush() }
}
