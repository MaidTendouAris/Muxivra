import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NsisUpdater } from 'electron-updater'
import type { AppAdapter } from 'electron-updater/out/AppAdapter'
import { NodeHttpExecutor } from 'builder-util/out/nodeHttpExecutor'
import { configureRequestOptions, configureRequestUrl, type DownloadOptions } from 'builder-util-runtime'
import { AppUpdates } from '../../src/main/app-updater'
import { GuardedNsisUpdater } from '../../src/main/nsis-updater'

// Only the HTTP transport is adapted for Node. File streaming, progress,
// SHA-512 verification, NSIS metadata parsing and cache handling are supplied by
// the installed electron-updater / builder-util-runtime implementations.
class LocalExecutor extends NodeHttpExecutor {
  override createRequest(options: RequestOptions, callback: (response: IncomingMessage) => void) {
    if (options.hostname !== '127.0.0.1') throw new Error('Updater integration tests may only access loopback')
    return httpRequest(options, callback)
  }
  download(url: URL, destination: string, options: DownloadOptions): Promise<string> {
    return options.cancellationToken.createPromise((resolve, reject, onCancel) => {
      const requestOptions: RequestOptions = { headers: options.headers || undefined }
      configureRequestUrl(url, requestOptions)
      configureRequestOptions(requestOptions)
      this.doDownload(requestOptions, {
        destination, options, onCancel, responseHandler: null,
        callback: error => error ? reject(error) : resolve(destination)
      }, 0)
    })
  }
}

class SafeUpdater extends NsisUpdater {
  installAttempts = 0
  get downloadedPath() { return this.installerPath }
  override quitAndInstall(): void { this.installAttempts++; throw new Error('Executing an installer is forbidden in tests') }
  protected override doInstall(): boolean { this.installAttempts++; throw new Error('Executing an installer is forbidden in tests') }
}

class LaunchTestUpdater extends GuardedNsisUpdater {
  installAttempts = 0
  launchMode: 'failure' | 'elevation' | 'success' = 'failure'
  calls: Array<{ cmd: string; args: string[] }> = []
  get downloadedPath() { return this.installerPath }
  protected override launchInstaller(cmd: string, args: string[] = []): Promise<boolean> {
    this.installAttempts++
    this.calls.push({ cmd, args })
    if(this.launchMode==='failure')return Promise.reject(Object.assign(new Error('模拟安装启动失败'),{code:'EIO'}))
    if(this.launchMode==='elevation'&&!cmd.endsWith('elevate.exe'))return Promise.reject(Object.assign(new Error('模拟权限不足'),{code:'EACCES'}))
    return Promise.resolve(true)
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function fixture() {
  await mkdir('.test-data', { recursive: true })
  const root = await mkdtemp(resolve('.test-data', 'update-download-'))
  const payload = Buffer.from('Muxivra updater test fixture. Harmless text, never an executable.\n'.repeat(8192))
  const name = 'Muxivra-0.14.0-win-x64-setup.exe'
  const sha512 = createHash('sha512').update(payload).digest('base64')
  const requests = { metadata: 0, installer: 0 }
  let mode: 'good' | 'checksum-error' | 'metadata-missing' | 'installer-missing' = 'good'
  const server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://127.0.0.1').pathname
    if (path.endsWith('.yml')) {
      requests.metadata++
      if (mode === 'metadata-missing') { response.writeHead(404); response.end('No published release'); return }
      response.writeHead(200, { 'Content-Type': 'text/yaml' })
      response.end(`version: 0.14.0\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${payload.length}\npath: ${name}\nsha512: ${sha512}\nreleaseDate: '2026-10-13T00:00:00.000Z'\nreleaseNotes: '本地集成测试'\n`)
    } else if (path === `/${name}`) {
      requests.installer++
      if (mode === 'installer-missing') { response.writeHead(404); response.end('Missing asset'); return }
      const bytes = mode === 'checksum-error' ? Buffer.alloc(payload.length, 65) : payload
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length })
      response.end(bytes)
    } else { response.writeHead(404); response.end() }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
  const profile = join(root, 'profile'), cache = join(root, 'cache'), config = join(root, 'app-update.yml')
  await mkdir(profile)
  await writeFile(config, `provider: generic\nurl: ${url}\nupdaterCacheDirName: muxivra-update-test\n`)
  cleanups.push(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    const local = relative(resolve('.test-data'), root)
    if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error('Refusing cleanup outside .test-data')
    await rm(root, { recursive: true, force: true })
  })
  function updater(guarded = false) {
    const onQuit: Array<(code: number) => void> = []
    const adapterState = { quits: 0 }
    const adapter: AppAdapter = {
      version: '0.13.0', name: 'Muxivra-update-test', isPackaged: true,
      appUpdateConfigPath: config, userDataPath: profile, baseCachePath: cache,
      whenReady: async () => {}, relaunch: () => { throw new Error('App relaunch is forbidden in tests') },
      quit: () => { if(!guarded)throw new Error('App quit is forbidden in tests');adapterState.quits++ }, onQuit: handler => { onQuit.push(handler) }
    }
    const driver = guarded ? new LaunchTestUpdater(null, adapter) : new SafeUpdater(null, adapter)
    // With an AppAdapter the upstream constructor deliberately omits Electron's
    // executor. Configure the transport before setFeedURL captures it.
    ;(driver as unknown as { httpExecutor: LocalExecutor }).httpExecutor = new LocalExecutor()
    driver.logger = null
    driver.disableDifferentialDownload = true
    driver.disableWebInstaller = true
    driver.setFeedURL({ provider: 'generic', url })
    const updates = new AppUpdates(driver, adapter.version)
    return { driver, updates, onQuit, adapterState }
  }
  return { root, cache, payload, name, sha512, requests, updater, setMode: (value: typeof mode) => { mode = value } }
}

describe('实际 electron-updater 下载与校验', () => {
  it('读取 metadata、校验下载并跨进程复用缓存，缓存被修改后重新下载', async () => {
    const test = await fixture(), first = test.updater()
    expect((await first.updates.startup()).phase).toBe('available')
    expect(test.requests).toEqual({ metadata: 1, installer: 0 })
    const progress: number[] = []
    first.driver.on('download-progress', value => progress.push(value.percent))
    expect((await first.updates.download()).phase).toBe('downloaded')
    expect(first.driver.downloadedPath).toBeTruthy()
    const destination = first.driver.downloadedPath!
    expect(relative(test.root, destination)).not.toMatch(/^\.\./)
    expect(createHash('sha512').update(await readFile(destination)).digest('base64')).toBe(test.sha512)
    expect(progress.some(value => value > 0 && value <= 100)).toBe(true)
    expect(test.requests.installer).toBe(1)
    expect(first.driver.installAttempts).toBe(0)
    expect(first.onQuit).toEqual([])

    const cached = test.updater()
    expect((await cached.updates.startup()).phase).toBe('available')
    expect((await cached.updates.download()).phase).toBe('downloaded')
    expect(test.requests.installer).toBe(1)
    expect(cached.driver.downloadedPath).toBe(destination)
    expect(cached.driver.installAttempts).toBe(0)
    expect(cached.onQuit).toEqual([])

    await writeFile(destination, 'tampered cache fixture')
    const repaired = test.updater()
    await repaired.updates.startup()
    expect((await repaired.updates.download()).phase).toBe('downloaded')
    expect(test.requests.installer).toBe(2)
    expect(await readFile(repaired.driver.downloadedPath!)).toEqual(test.payload)
    expect(repaired.driver.installAttempts).toBe(0)
  })

  it('拒绝不匹配的 SHA-512，并可在连接恢复后重新下载', async () => {
    const test = await fixture(), { driver, updates, onQuit } = test.updater()
    test.setMode('checksum-error')
    await updates.startup()
    expect((await updates.download()).phase).toBe('error')
    expect(updates.state.error).toContain('校验失败')
    expect(driver.downloadedPath).toBeNull()
    expect(() => updates.assertReady()).toThrow()
    expect(driver.installAttempts).toBe(0)
    expect(onQuit).toEqual([])
    const pending = join(test.cache, 'muxivra-update-test', 'pending')
    expect(await readdir(pending)).not.toContain(test.name)
    test.setMode('good')
    expect((await updates.download()).phase).toBe('downloaded')
    expect(await readFile(driver.downloadedPath!)).toEqual(test.payload)
    expect(test.requests.installer).toBe(2)
    expect(driver.installAttempts).toBe(0)
  })

  it('GitHub channel 元数据缺失不会阻止启动，也不会下载资产', async () => {
    const test = await fixture(), { driver, updates } = test.updater()
    test.setMode('metadata-missing')
    expect((await updates.startup()).phase).toBe('error')
    expect(updates.state.error).toContain('latest.yml')
    expect(test.requests).toEqual({ metadata: 1, installer: 0 })
    expect(() => updates.download()).toThrow()
    expect(() => updates.assertReady()).toThrow()
    expect(driver.installAttempts).toBe(0)
    test.setMode('good')
    expect((await updates.check()).phase).toBe('available')
    expect(updates.state.error).toBeUndefined()
  })

  it('下载资产返回 404 时不会标记为可安装', async () => {
    const test = await fixture(), { driver, updates } = test.updater()
    await updates.startup()
    test.setMode('installer-missing')
    expect((await updates.download()).phase).toBe('error')
    expect(() => updates.assertReady()).toThrow()
    expect(() => updates.install()).toThrow()
    expect(driver.installAttempts).toBe(0)
    expect(driver.downloadedPath).toBeNull()
  })

  it('安装程序启动失败时不退出，权限提升回退启动成功后才退出', async () => {
    const test = await fixture(), instance = test.updater(true)
    const { driver, updates, adapterState } = instance
    if(!(driver instanceof LaunchTestUpdater))throw new Error('Expected guarded test updater')
    const resourceDescriptor = Object.getOwnPropertyDescriptor(process,'resourcesPath')
    Object.defineProperty(process,'resourcesPath',{value:join(test.root,'resources'),configurable:true,writable:true})
    cleanups.push(async()=>{if(resourceDescriptor)Object.defineProperty(process,'resourcesPath',resourceDescriptor);else delete (process as unknown as {resourcesPath?:string}).resourcesPath})
    await updates.startup()
    await updates.download()
    await expect(updates.install()).rejects.toThrow('模拟安装启动失败')
    expect(adapterState.quits).toBe(0)
    expect(updates.state).toMatchObject({phase:'downloaded',error:'模拟安装启动失败'})
    expect(() => updates.assertReady()).not.toThrow()
    expect(driver.calls).toHaveLength(1)
    expect(driver.calls[0].args).toContain('/S')
    expect(driver.calls[0].args).toContain('--force-run')
    driver.launchMode='elevation'
    await expect(updates.install()).resolves.toBeUndefined()
    expect(adapterState.quits).toBe(1)
    expect(driver.calls).toHaveLength(3)
    expect(driver.calls[2].cmd).toBe(join(test.root,'resources','elevate.exe'))
    expect(driver.calls[2].args[0]).toBe(driver.downloadedPath)
    expect(updates.state.phase).toBe('installing')
  })
})
