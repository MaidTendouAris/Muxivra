import { EventEmitter } from 'node:events'
import type { AppUpdateState } from '../shared/app-update'

// Keep Electron outside this controller so the complete lifecycle can be tested
// without fetching a release or executing an installer.
export interface UpdateDriver {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  on(event: string, listener: (...args: any[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(silent?: boolean, runAfter?: boolean): void
  installAndRestart?(): Promise<void>
}

interface ReleaseInfo {
  version: string
  releaseDate?: string
  releaseNotes?: string | {version: string; note: string | null}[] | null
}

function newerStable(version: string, current: string): boolean {
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
  if (!stable.test(version) || !stable.test(current)) return false
  const left = version.split('.').map(BigInt), right = current.split('.').map(BigInt)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i]
  return false
}

function releaseFields(info: ReleaseInfo): Pick<AppUpdateState,'version'|'releaseDate'|'releaseNotes'> {
  const notes = typeof info.releaseNotes === 'string' ? info.releaseNotes : Array.isArray(info.releaseNotes) ? info.releaseNotes.map(item => `${item.version}\n${item.note ?? ''}`).join('\n\n') : ''
  // GitHub may supply HTML. Display only text, never inject a remote document.
  return { version: info.version, releaseDate: info.releaseDate, releaseNotes: notes.replace(/<[^>]*>/g,'').slice(0,20000) }
}

function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = typeof error==='object'&&error!==null&&'code' in error ? String(error.code) : ''
  if (/ERR_UPDATER_LATEST_VERSION_NOT_FOUND|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|No published versions|Cannot find channel .*update info/i.test(`${code} ${message}`)) return '未找到可用的正式版更新，请确认 GitHub Release 已发布并包含 latest.yml。'
  if (/404/.test(message)) return '更新文件不存在，请确认正式 Release 的发行文件完整。'
  if (/sha512|checksum|signature|ERR_UPDATER_INVALID_SIGNATURE/i.test(message)) return '更新文件校验失败，请重新下载。'
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return '连接 GitHub 超时，请稍后重试。'
  if (/ENOTFOUND|ECONN|net::|network|ERR_INTERNET_DISCONNECTED/i.test(message)) return '无法连接 GitHub，请检查网络后重试。'
  return message.slice(0,600)
}

const nonNegative = (value: unknown): number => Number.isFinite(Number(value)) ? Math.max(0,Number(value)) : 0

export class AppUpdates extends EventEmitter {
  private value: AppUpdateState
  private startupStarted = false
  private checking?: Promise<AppUpdateState>
  private downloading?: Promise<AppUpdateState>
  private ready = false

  constructor(private readonly updater: UpdateDriver | undefined, currentVersion: string, disabledMessage = '开发模式不检查应用更新，请使用 Windows 安装版。') {
    super()
    this.value = { phase: updater ? 'idle' : 'disabled', currentVersion, percent: 0, transferred: 0, total: 0, bytesPerSecond: 0, message: updater ? '每次启动自动检查更新' : disabledMessage }
    if (!updater) return
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.allowPrerelease = false
    updater.allowDowngrade = false
    updater.on('checking-for-update',() => this.set({phase:'checking',message:'正在检查 GitHub Releases…',error:undefined}))
    updater.on('update-available',(info: ReleaseInfo) => {
      if (!newerStable(info.version,this.value.currentVersion)) {
        this.set({phase:'current',message:'当前已是最新正式版'})
        return
      }
      this.set({...releaseFields(info),phase:'available',checkedAt:new Date().toISOString(),message:`发现新版本 ${info.version}`,error:undefined})
    })
    updater.on('update-not-available',() => this.set({phase:'current',checkedAt:new Date().toISOString(),message:'当前已是最新正式版',error:undefined}))
    updater.on('download-progress',progress => this.set({phase:'downloading',percent:Math.min(100,nonNegative(progress.percent)),transferred:nonNegative(progress.transferred),total:nonNegative(progress.total),bytesPerSecond:nonNegative(progress.bytesPerSecond),message:'正在下载更新…'}))
    updater.on('update-downloaded',(info: ReleaseInfo) => {
      if (!newerStable(info.version,this.value.currentVersion)) { this.fail(new Error('拒绝安装非正式版或较旧版本')); return }
      this.ready = true
      this.set({...releaseFields(info),phase:'downloaded',percent:100,bytesPerSecond:0,message:'更新已下载，重启后安装',error:undefined})
    })
    updater.on('error',error => this.fail(error))
    updater.on('update-cancelled',() => this.set({phase:'available',percent:0,bytesPerSecond:0,message:'下载已取消，可以重新下载'}))
  }

  get state(): AppUpdateState { return {...this.value} }
  private set(patch: Partial<AppUpdateState>): void {
    this.value = {...this.value,...patch}
    this.emit('state',this.state)
  }
  private fail(error: unknown): void {
    const message = failureMessage(error)
    this.set({phase:'error',error:message,message,bytesPerSecond:0})
  }

  startup(enabled=true): Promise<AppUpdateState> {
    if (this.startupStarted) return this.checking ?? Promise.resolve(this.state)
    this.startupStarted = true
    if(!enabled){this.set({message:'自动检查已关闭，可手动检查更新'});return Promise.resolve(this.state)}
    return this.check()
  }

  check(): Promise<AppUpdateState> {
    if (this.checking) return this.checking
    if (!this.updater || this.downloading || this.ready || this.value.phase === 'installing') return Promise.resolve(this.state)
    this.ready = false
    this.set({phase:'checking',version:undefined,releaseDate:undefined,releaseNotes:undefined,percent:0,transferred:0,total:0,error:undefined,message:'正在检查 GitHub Releases…'})
    this.checking = Promise.resolve().then(async () => {
      try {
        await this.updater!.checkForUpdates()
        if (this.value.phase === 'checking') this.fail(new Error('更新服务未返回版本信息，请重试。'))
      } catch (error) { this.fail(error) }
      this.set({checkedAt:new Date().toISOString()})
      return this.state
    }).finally(() => {this.checking = undefined})
    return this.checking
  }

  download(): Promise<AppUpdateState> {
    if (this.downloading) return this.downloading
    if (this.ready) return Promise.resolve(this.state)
    if (!this.updater || this.checking || !this.value.version || !['available','error'].includes(this.value.phase)) throw new Error('请先检查并确认有可用的新版本')
    this.set({phase:'downloading',percent:0,transferred:0,total:0,bytesPerSecond:0,error:undefined,message:'正在下载更新…'})
    this.downloading = Promise.resolve().then(async () => {
      try {
        await this.updater!.downloadUpdate()
        if (!this.ready && this.value.phase === 'downloading') this.fail(new Error('更新下载未完成，请重试。'))
      } catch (error) { this.fail(error) }
      return this.state
    }).finally(() => {this.downloading = undefined})
    return this.downloading
  }

  assertReady(): void {
    if (!this.updater || !this.ready || this.value.phase !== 'downloaded') throw new Error('更新尚未下载完成')
  }

  install(): void | Promise<void> {
    this.assertReady()
    this.set({phase:'installing',message:'正在重启并安装更新…',error:undefined})
    try {
      if(this.updater!.installAndRestart)return this.updater!.installAndRestart!().catch(error=>{this.markInstallError(error);throw error})
      this.updater!.quitAndInstall(true,true)
      if (this.value.phase === 'error') throw new Error(this.value.error)
    } catch (error) { this.markInstallError(error); throw error }
  }

  markInstallError(error: unknown): void {
    const message = failureMessage(error)
    this.set({phase:this.ready?'downloaded':'error',error:message,message})
  }
}
