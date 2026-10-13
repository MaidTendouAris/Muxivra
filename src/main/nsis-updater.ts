import electronUpdater from 'electron-updater'
import type { StdioOptions } from 'node:child_process'

const { NsisUpdater } = electronUpdater

export class GuardedNsisUpdater extends NsisUpdater {
  private launches: Promise<boolean>[] = []

  protected launchInstaller(cmd: string, args: string[] = [], env?: any, stdio?: StdioOptions): Promise<boolean> {
    return super.spawnLog(cmd,args,env,stdio)
  }

  protected override spawnLog(cmd: string, args: string[] = [], env?: any, stdio?: StdioOptions): Promise<boolean> {
    const launch = this.launchInstaller(cmd,args,env,stdio)
    this.launches.push(launch)
    return launch
  }

  // Upstream quitAndInstall schedules quit before the asynchronous spawn error
  // arrives. Use the same NSIS install path, including its elevation fallback,
  // but wait until an installer process was actually created before quitting.
  async installAndRestart(): Promise<void> {
    this.launches = []
    try {
      if (!this.install(true,true)) throw new Error('无法启动更新安装程序')
      let index = 0
      const results: PromiseSettledResult<boolean>[] = []
      while (index < this.launches.length) {
        const pending = this.launches.slice(index)
        index = this.launches.length
        results.push(...await Promise.allSettled(pending))
      }
      if (!results.some(result => result.status === 'fulfilled' && result.value)) {
        const failure = [...results].reverse().find(result => result.status === 'rejected')
        throw failure?.status === 'rejected' ? failure.reason : new Error('无法启动更新安装程序')
      }
      this.app.quit()
    } catch (error) {
      this.quitAndInstallCalled = false
      throw error
    }
  }
}
