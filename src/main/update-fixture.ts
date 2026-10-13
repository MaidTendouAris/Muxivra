import { EventEmitter } from 'node:events'
import type { UpdateDriver } from './app-updater'

// Available only when both smoke-test flags are enabled. It never downloads or
// executes an installer and is not reachable from normal application IPC.
export class UpdateFixture extends EventEmitter implements UpdateDriver {
  autoDownload = false
  autoInstallOnAppQuit = false
  allowPrerelease = false
  allowDowngrade = false
  mode: 'available' | 'current' | 'error' | 'download-error' | 'downloaded' | 'install-error' = 'available'
  delayMs = 300
  checks = 0
  downloads = 0
  installs = 0
  readonly release: {version:string;releaseDate:string;releaseNotes:string}
  constructor(private readonly quit: () => void,currentVersion: string) {
    super()
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(currentVersion)
    if(!match)throw new Error('Updater fixture requires a stable application version')
    this.release={version:`${match[1]}.${BigInt(match[2])+1n}.0`,releaseDate:'2026-10-13T00:00:00Z',releaseNotes:'测试更新说明。此模式不执行安装程序。'}
  }
  private wait(): Promise<void> { return new Promise(resolve => setTimeout(resolve,this.delayMs)) }
  async checkForUpdates(): Promise<void> {
    this.checks++
    this.emit('checking-for-update')
    await this.wait()
    if (this.mode === 'error') { const error = new Error('net::ERR_INTERNET_DISCONNECTED'); this.emit('error',error); throw error }
    this.emit(this.mode === 'current' ? 'update-not-available' : 'update-available',this.release)
  }
  async downloadUpdate(): Promise<void> {
    this.downloads++
    for (const percent of [20,40,60,80,100]) {
      await this.wait()
      this.emit('download-progress',{percent,total:1024000,transferred:10240*percent,bytesPerSecond:102400})
      if (this.mode === 'download-error' && percent === 40) { const error = new Error('sha512 checksum mismatch'); this.emit('error',error); throw error }
    }
    this.emit('update-downloaded',this.release)
  }
  quitAndInstall(): void { this.installs++; this.quit() }
  async installAndRestart(): Promise<void> {
    this.installs++
    await this.wait()
    if(this.mode==='install-error')throw new Error('模拟更新安装启动失败')
    this.quit()
  }
}
