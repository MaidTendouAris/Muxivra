import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { AppUpdates, type UpdateDriver } from '../../src/main/app-updater'

const deferred = () => {
  let resolve!: (value?: unknown) => void
  let reject!: (error: Error) => void
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

class Driver extends EventEmitter implements UpdateDriver {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = true
  allowDowngrade = true
  checks = 0
  downloads = 0
  installations: Array<{ silent?: boolean; runAfter?: boolean }> = []
  checkResult = deferred()
  downloadResult = deferred()
  async checkForUpdates() { this.checks++; return this.checkResult.promise }
  async downloadUpdate() { this.downloads++; return this.downloadResult.promise }
  quitAndInstall(silent?: boolean, runAfter?: boolean) { this.installations.push({ silent, runAfter }) }
  available(version = '0.14.0') {
    this.emit('update-available', { version, releaseDate: '2026-10-13T10:00:00.000Z', releaseNotes: '修复播放问题。' })
    this.checkResult.resolve()
  }
  current() { this.emit('update-not-available', { version: '0.13.0' }); this.checkResult.resolve() }
  downloaded() { this.emit('update-downloaded', { version: '0.14.0' }); this.downloadResult.resolve() }
}

describe('应用更新控制器', () => {
  it('禁用自动检查后仍可手动检查',async()=>{
    const driver=new Driver(),updates=new AppUpdates(driver,'0.17.0')
    await updates.startup(false);expect(driver.checks).toBe(0);expect(updates.state.message).toContain('自动检查已关闭');await updates.startup(true);expect(driver.checks).toBe(0)
    const manual=updates.check();await Promise.resolve();expect(driver.checks).toBe(1);driver.current();await manual;expect(updates.state.phase).toBe('current')
  })
  it('开发环境禁用更新，检查启动不会访问更新源', async () => {
    const updates = new AppUpdates(undefined, '0.13.0', '开发环境不检查更新')
    expect(updates.state.phase).toBe('disabled')
    expect((await updates.startup()).phase).toBe('disabled')
    expect((await updates.check()).phase).toBe('disabled')
    expect(updates.state.currentVersion).toBe('0.13.0')
    expect(updates.state.message).toBe('开发环境不检查更新')
    expect(() => updates.assertReady()).toThrow()
    expect(() => updates.install()).toThrow()
  })

  it('关闭隐式下载、退出安装、预发布和版本降级', () => {
    const driver = new Driver()
    new AppUpdates(driver, '0.13.0')
    expect(driver.autoDownload).toBe(false)
    expect(driver.autoInstallOnAppQuit).toBe(false)
    expect(driver.allowPrerelease).toBe(false)
    expect(driver.allowDowngrade).toBe(false)
  })

  it('每次进程启动只检查一次，同时手动检查合并重复请求', async () => {
    const driver = new Driver(), updates = new AppUpdates(driver, '0.13.0')
    const automatic = updates.startup(), secondStartup = updates.startup(), manual = updates.check()
    expect(updates.state.phase).toBe('checking')
    await Promise.resolve()
    expect(driver.checks).toBe(1)
    driver.current()
    const states = await Promise.all([automatic, secondStartup, manual])
    expect(states.every(state => state.phase === 'current')).toBe(true)
    expect(updates.state.checkedAt).toBeTruthy()
    await updates.startup()
    expect(driver.checks).toBe(1)
    driver.checkResult = deferred()
    const next = updates.check()
    await Promise.resolve()
    expect(driver.checks).toBe(2)
    driver.available()
    await next
    expect(updates.state.phase).toBe('available')
    expect(driver.downloads).toBe(0)
  })

  it('收到新版后保存版本说明，允许下载且合并重复下载', async () => {
    const driver = new Driver(), updates = new AppUpdates(driver, '0.13.0')
    const check = updates.check(); driver.available(); await check
    expect(updates.state).toMatchObject({ phase: 'available', currentVersion: '0.13.0', version: '0.14.0', releaseNotes: '修复播放问题。' })
    const first = updates.download(), second = updates.download()
    await Promise.resolve()
    expect(driver.downloads).toBe(1)
    expect(updates.state.phase).toBe('downloading')
    driver.emit('download-progress', { percent: 37.5, transferred: 3750, total: 10000, bytesPerSecond: 1200 })
    expect(updates.state).toMatchObject({ phase: 'downloading', percent: 37.5, transferred: 3750, total: 10000, bytesPerSecond: 1200 })
    driver.downloaded()
    expect((await first).phase).toBe('downloaded')
    expect((await second).phase).toBe('downloaded')
    expect(updates.state.percent).toBe(100)
    expect(driver.installations).toEqual([])
    await updates.download()
    expect(driver.downloads).toBe(1)
    await updates.check()
    expect(updates.state.phase).toBe('downloaded')
    expect(driver.checks).toBe(1)
  })

  it('更新源或下载失败变为可重试状态，不造成未处理异常', async () => {
    const driver = new Driver(), updates = new AppUpdates(driver, '0.13.0')
    const failedCheck = updates.check()
    driver.checkResult.reject(new Error('GitHub 暂时不可用'))
    await expect(failedCheck).resolves.toMatchObject({ phase: 'error', error: 'GitHub 暂时不可用' })
    driver.checkResult = deferred()
    const retryCheck = updates.check(); driver.available(); await retryCheck
    const failedDownload = updates.download()
    driver.downloadResult.reject(new Error('下载连接已断开'))
    await expect(failedDownload).resolves.toMatchObject({ phase: 'error', error: '下载连接已断开', version: '0.14.0' })
    expect(driver.installations).toEqual([])
    driver.downloadResult = deferred()
    const retryDownload = updates.download(); driver.downloaded(); await retryDownload
    expect(updates.state.phase).toBe('downloaded')
    expect(driver.downloads).toBe(2)
    expect(updates.state.error).toBeUndefined()
  })

  it('驱动 error 事件无需外部监听，不会因 EventEmitter error 导致崩溃', () => {
    const driver = new Driver(), updates = new AppUpdates(driver, '0.13.0')
    expect(() => driver.emit('error', new Error('更新元数据校验失败'))).not.toThrow()
    expect(updates.state).toMatchObject({ phase: 'error', error: '更新元数据校验失败' })
    expect(() => updates.install()).toThrow()
    expect(driver.installations).toEqual([])
  })

  it('异常下载统计值不会污染界面进度或传输信息', async () => {
    const driver = new Driver(), updates = new AppUpdates(driver, '0.13.0')
    const check = updates.check(); driver.available(); await check
    const download = updates.download()
    for (const value of [NaN, Infinity, -Infinity, -10, 'invalid']) {
      driver.emit('download-progress', { percent: value, transferred: value, total: value, bytesPerSecond: value })
      const state = updates.state
      for (const number of [state.percent, state.transferred, state.total, state.bytesPerSecond]) {
        expect(Number.isFinite(number)).toBe(true)
        expect(number).toBeGreaterThanOrEqual(0)
      }
      expect(state.percent).toBeLessThanOrEqual(100)
    }
    driver.downloaded(); await download
  })

  it('只允许在完整下载后安装，安装交由明确操作触发', async () => {
    const driver = new Driver(), updates = new AppUpdates(driver, '0.13.0')
    expect(() => updates.assertReady()).toThrow()
    expect(() => updates.install()).toThrow()
    expect(() => updates.download()).toThrow()
    const check = updates.check(); driver.available(); await check
    expect(() => updates.assertReady()).toThrow()
    expect(() => updates.install()).toThrow()
    const download = updates.download()
    expect(() => updates.install()).toThrow()
    driver.downloaded(); await download
    expect(() => updates.assertReady()).not.toThrow()
    updates.install()
    expect(updates.state.phase).toBe('installing')
    expect(driver.installations).toEqual([{ silent: true, runAfter: true }])
    expect(() => updates.install()).toThrow()
    expect(driver.installations).toHaveLength(1)
  })

  it('关闭处理任务失败时保留已下载更新并允许重试安装', async () => {
    const driver = new Driver(), updates = new AppUpdates(driver, '0.13.0')
    const check = updates.check(); driver.available(); await check
    const download = updates.download(); driver.downloaded(); await download
    updates.markInstallError(new Error('未能关闭处理任务'))
    expect(updates.state).toMatchObject({ phase: 'downloaded', error: '未能关闭处理任务' })
    expect(driver.installations).toEqual([])
    expect(() => updates.assertReady()).not.toThrow()
    updates.install()
    expect(updates.state.phase).toBe('installing')
    expect(driver.installations).toEqual([{ silent: true, runAfter: true }])
    expect(updates.state.error).toBeUndefined()
  })

  it('等待安装程序启动确认，异步失败保留下载并允许重试', async () => {
    class AsyncDriver extends Driver {
      launch = deferred()
      attempts = 0
      async installAndRestart(): Promise<void> { this.attempts++; await this.launch.promise }
    }
    const driver = new AsyncDriver(), updates = new AppUpdates(driver, '0.13.0')
    const check = updates.check(); driver.available(); await check
    const download = updates.download(); driver.downloaded(); await download
    const failed = updates.install()
    expect(updates.state.phase).toBe('installing')
    expect(driver.installations).toEqual([])
    driver.launch.reject(new Error('无法启动安装程序'))
    await expect(failed).rejects.toThrow('无法启动安装程序')
    expect(updates.state).toMatchObject({ phase: 'downloaded', error: '无法启动安装程序' })
    expect(() => updates.assertReady()).not.toThrow()
    driver.launch = deferred()
    const retry = updates.install()
    driver.launch.resolve()
    await expect(retry).resolves.toBeUndefined()
    expect(driver.attempts).toBe(2)
    expect(updates.state).toMatchObject({ phase: 'installing', error: undefined })
    expect(driver.installations).toEqual([])
  })

  it.each(['0.13.0', '0.12.0', '0.14.0-beta.1', 'not-a-version'])('拒绝非稳定新版 %s，不能下载或安装', async version => {
    const driver = new Driver(), updates = new AppUpdates(driver, '0.13.0')
    const check = updates.check(); driver.available(version); await check
    expect(['available', 'downloading', 'downloaded', 'installing']).not.toContain(updates.state.phase)
    expect(() => updates.download()).toThrow()
    expect(() => updates.assertReady()).toThrow()
    expect(() => updates.install()).toThrow()
    expect(driver.downloads).toBe(0)
    expect(driver.installations).toEqual([])
  })
})
