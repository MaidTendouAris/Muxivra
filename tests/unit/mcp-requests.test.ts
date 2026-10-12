import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { McpRequestStore, MCP_PENDING_LIMIT } from '../../src/core/mcp/requests'
import type { McpRequest, McpRequestAction } from '../../src/shared/mcp-requests'
import { MediaService } from '../../src/core/service'
import { defaultOptions } from '../../src/core/presets'
import { isWithin } from '../../src/core/media/paths'
import type { Engine, JobRequest, Settings } from '../../src/shared/types'

vi.mock('../../src/core/engine/options', () => ({ validateComponentOptions: vi.fn(async () => {}), componentCapabilities: vi.fn() }))
vi.mock('../../src/core/media/probe', () => ({ inspectMedia: vi.fn(async (_engine, path) => ({ path, name: 'test.wav', durationMs: 2000, size: 1024, format: 'wav', streams: [{ index: 0, type: 'audio', codec: 'pcm_s16le' }] })) }))
vi.mock('../../src/core/media/plan', () => ({ buildPlan: vi.fn((engine, input, outputPath, options) => ({ engine, input, outputPath, options, args: ['-i', input.path, outputPath], warnings: [] })) }))

class MemoryStorage {
  state: { version: 1; records: McpRequest[] } = { version: 1, records: [] }
  calls = 0
  failAt?: number
  async read() { return structuredClone(this.state) }
  async write(value: { version: 1; records: McpRequest[] }) { if (++this.calls === this.failAt) throw new Error('磁盘不可写'); this.state = structuredClone(value) }
  async flush() {}
}
function action(key = 'directory-once'): McpRequestAction { return { kind: 'directory', requestKey: key, reason: '读取用户指定音乐', payload: { path: resolve('.test-data'), permission: 'input' } } }
const validate = async (value: McpRequestAction) => value

describe('MCP 申请持久化与审批', () => {
  it('并发重复申请只存一条，不阻塞等待审核；不同参数不能复用标识', async () => {
    const storage = new MemoryStorage(), store = new McpRequestStore('unused', () => {}, storage)
    await store.initialize(async () => undefined)
    const requests = await Promise.all(Array.from({ length: 12 }, () => store.create(action(), validate)))
    expect(new Set(requests.map(request => request.id)).size).toBe(1)
    expect(store.counts()).toMatchObject({ pending: 1, total: 1 })
    expect(requests[0].status).toBe('pending')
    await expect(store.create({ ...action(), reason: '另一理由' }, validate)).rejects.toThrow('去重标识')
    requests[0].reason = '不能修改存储'
    expect(store.get(requests[0].id).reason).toBe('读取用户指定音乐')
  })

  it('拒绝不会执行副作用，重复审核不会改写结果', async () => {
    const storage = new MemoryStorage(), store = new McpRequestStore('unused', () => {}, storage), execute = vi.fn(async () => ({}))
    await store.initialize(async () => undefined)
    const request = await store.create(action(), validate)
    const rejected = await store.review(request.id, false, '暂不开放', execute)
    expect(rejected).toMatchObject({ status: 'rejected', reviewerNote: '暂不开放' })
    expect(rejected.resolvedAt).toBeDefined()
    expect(await store.review(request.id, true, undefined, execute)).toEqual(rejected)
    expect(execute).not.toHaveBeenCalled()
  })

  it('审批先持久化 approving；并发批准仅执行一次，重启保留结果', async () => {
    const storage = new MemoryStorage(), store = new McpRequestStore('unused', () => {}, storage)
    await store.initialize(async () => undefined)
    const request = await store.create(action(), validate)
    const execute = vi.fn(async () => { expect(storage.state.records[0].status).toBe('approving'); return {} })
    const results = await Promise.all(Array.from({ length: 4 }, () => store.review(request.id, true, undefined, execute)))
    expect(results.every(result => result.status === 'approved')).toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)
    const restored = new McpRequestStore('unused', () => {}, storage), recover = vi.fn(async () => undefined)
    await restored.initialize(recover)
    expect(restored.get(request.id).status).toBe('approved')
    expect(recover).not.toHaveBeenCalled()
  })

  it('批准标记写失败时不执行操作，执行失败有完整失败记录', async () => {
    const storage = new MemoryStorage(), store = new McpRequestStore('unused', () => {}, storage), execute = vi.fn(async () => ({}))
    await store.initialize(async () => undefined)
    const request = await store.create(action(), validate)
    storage.failAt = storage.calls + 1
    await expect(store.review(request.id, true, undefined, execute)).rejects.toThrow('磁盘不可写')
    expect(store.get(request.id).status).toBe('pending')
    expect(execute).not.toHaveBeenCalled()
    const failed = await store.review(request.id, true, undefined, async () => { throw new Error('目录被移走') })
    expect(failed).toMatchObject({ status: 'failed', error: '目录被移走' })
    expect(failed.resolvedAt).toBeDefined()
  })

  it('操作后记录保存失败不重新执行，重启仅按已经提交结果恢复', async () => {
    const storage = new MemoryStorage(), store = new McpRequestStore('unused', () => {}, storage)
    await store.initialize(async () => undefined)
    const request = await store.create(action(), validate)
    storage.failAt = storage.calls + 2
    const execute = vi.fn(async () => ({}))
    const result = await store.review(request.id, true, undefined, execute)
    expect(result.status).toBe('approving')
    expect(result.error).toContain('请勿重复执行')
    expect(storage.state.records[0].status).toBe('approving')
    await expect(store.review(request.id, true, undefined, execute)).rejects.toThrow('不能重复执行')
    expect(execute).toHaveBeenCalledTimes(1)
    const restored = new McpRequestStore('unused', () => {}, storage)
    await restored.initialize(async () => ({}))
    expect(restored.get(request.id).status).toBe('approved')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('重启无法确认正在审批的操作时标记失败，永不自动重试', async () => {
    const storage = new MemoryStorage(), store = new McpRequestStore('unused', () => {}, storage)
    await store.initialize(async () => undefined)
    const request = await store.create(action(), validate)
    storage.failAt = storage.calls + 2
    await store.review(request.id, true, undefined, async () => ({}))
    const restored = new McpRequestStore('unused', () => {}, storage)
    await restored.initialize(async () => undefined)
    expect(restored.get(request.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('不会自动重试') })
  })

  it('待审与内容大小有上限，已结束申请腾出待审额度', async () => {
    const storage = new MemoryStorage(), store = new McpRequestStore('unused', () => {}, storage)
    await store.initialize(async () => undefined)
    for (let index = 0; index < MCP_PENDING_LIMIT; index++) await store.create(action(`bounded-${index}`), validate)
    await expect(store.create(action('one-too-many'), validate)).rejects.toThrow('100 条')
    await store.review(store.list()[0].id, false, undefined, async () => ({}))
    expect((await store.create(action('new-slot'), validate)).status).toBe('pending')
    await expect(store.create({ ...action('invalid-key'), requestKey: 'has spaces' }, validate)).rejects.toThrow()
    await expect(store.create({ ...action('invalid-reason'), reason: '' }, validate)).rejects.toThrow()
    const oversized: McpRequestAction = { kind: 'transcode', requestKey: 'oversized', reason: '批量处理', payload: { requests: Array.from({ length: 200 }, () => ({ inputPath: resolve('.test-data', 'input.wav'), outputPath: resolve('.test-data', 'output.m4a'), options: { ...defaultOptions, metadata: [{ key: 'title', value: 'x'.repeat(1500) }] } })) } }
    await expect(store.create(oversized, validate)).rejects.toThrow('256 KB')
  })

  it('保留最多 1000 条历史，待审申请不被历史清理移除', async () => {
    const storage = new MemoryStorage(), store = new McpRequestStore('unused', () => {}, storage)
    await store.initialize(async () => undefined)
    const original = await store.create(action('original'), validate)
    const resolvedAt = new Date().toISOString()
    storage.state.records = Array.from({ length: 1000 }, (_, index) => ({ ...original, id: randomUUID(), requestKey: `history-${index}`, status: 'rejected', resolvedAt }))
    const restored = new McpRequestStore('unused', () => {}, storage)
    await restored.initialize(async () => undefined)
    const pending = await restored.create(action('stay-pending'), validate), finished = await restored.create(action('new-finished'), validate)
    await restored.review(finished.id, false, undefined, async () => ({}))
    expect(restored.list().filter(record => record.status !== 'pending')).toHaveLength(1000)
    expect(restored.get(pending.id).status).toBe('pending')
    expect(restored.list().some(record => record.requestKey === 'history-0')).toBe(false)
  })

  it.each([true, false])('较旧待审申请在满额历史中审核后仍可查询（批准：%s）', async approve => {
    const storage = new MemoryStorage(), store = new McpRequestStore('unused', () => {}, storage)
    await store.initialize(async () => undefined)
    const old = await store.create(action('old-pending'), validate)
    storage.state.records = [
      { ...old, createdAt: '2000-01-01T00:00:00.000Z' },
      ...Array.from({ length: 1000 }, (_, index): McpRequest => ({ ...old, id: randomUUID(), requestKey: `newer-history-${index}`, createdAt: '2001-01-01T00:00:00.000Z', status: 'rejected', resolvedAt: '2001-01-02T00:00:00.000Z' }))
    ]
    const restored = new McpRequestStore('unused', () => {}, storage)
    await restored.initialize(async () => undefined)
    const execute = vi.fn(async () => ({}))
    const reviewed = await restored.review(old.id, approve, '本次审核', execute)
    expect(reviewed.status).toBe(approve ? 'approved' : 'rejected')
    expect(restored.get(old.id)).toEqual(reviewed)
    expect(restored.list()).toHaveLength(1000)
    expect(restored.list().some(record => record.requestKey === 'newer-history-0')).toBe(false)
    expect(execute).toHaveBeenCalledTimes(approve ? 1 : 0)
    const afterRestart = new McpRequestStore('unused', () => {}, storage)
    await afterRestart.initialize(async () => undefined)
    expect(afterRestart.get(old.id)).toEqual(reviewed)
  })

  it('实际原子 JSON 存储经新实例重新读取保留申请与审核备注', async () => {
    const path = join(root, 'actual-request-store.json'), store = new McpRequestStore(path)
    await store.initialize(async () => undefined)
    const pending = await store.create(action('durable-pending'), validate), declined = await store.create(action('durable-rejected'), validate)
    await store.review(declined.id, false, '由用户拒绝', async () => ({}))
    await store.shutdown()
    const restored = new McpRequestStore(path)
    await restored.initialize(async () => undefined)
    expect(restored.get(pending.id).status).toBe('pending')
    expect(restored.get(declined.id)).toMatchObject({ status: 'rejected', reviewerNote: '由用户拒绝' })
    await restored.shutdown()
  })
})

let root: string, inputDirectory: string, outputDirectory: string, input: string
const engine: Engine = { id: 'test-engine', ffmpegPath: 'unused-ffmpeg', ffprobePath: 'unused-ffprobe', source: 'local', version: 'test', encoders: ['aac'], decoders: ['pcm_s16le'], filters: [], detectedAt: new Date().toISOString() }
beforeAll(async () => {
  await mkdir('.test-data', { recursive: true })
  root = await mkdtemp(resolve('.test-data', 'mcp-requests-'))
  inputDirectory = join(root, 'input'); outputDirectory = join(root, 'output')
  await mkdir(inputDirectory); await mkdir(outputDirectory)
  input = join(inputDirectory, 'test.wav'); await writeFile(input, 'test media')
})
afterAll(async () => { if (root && isWithin(resolve('.test-data'), root)) await rm(root, { recursive: true, force: true }) })

async function isolatedService(name: string, roots = [inputDirectory]): Promise<MediaService> {
  const service = new MediaService(join(root, name), join(root, 'engines'))
  const settings: Settings = { theme: 'dark', concurrency: 1, mcp: { enabled: true, port: 19480, token: '0'.repeat(64), inputRoots: roots, outputRoots: [outputDirectory], allowInspect: false, allowSubmit: false, allowCancel: false } }
  const internals = service as unknown as { configuration: unknown; requestStore: McpRequestStore }
  internals.configuration = { settings, engine, engines: [engine], presets: [] }
  service.queue.concurrency = 0
  await service.queue.initialize()
  await internals.requestStore.initialize(async () => undefined)
  return service
}
function transcode(name: string): JobRequest { return { inputPath: input, outputPath: join(outputDirectory, name), options: { ...defaultOptions, video: 'none', audio: 'aac', container: 'm4a' } } }

describe('MCP 人工批准的目录边界', () => {
  it('空输入范围允许先申请目录，批准前不授权，拒绝不改变设置', async () => {
    const service = await isolatedService('folder-refused', [])
    try {
      await service.saveSettings(service.settings)
      const request = await service.requestDirectoryAccess({ requestKey: 'first-folder', path: inputDirectory, permission: 'input', reason: '用户选择此音乐目录' })
      expect(request.status).toBe('pending')
      expect(service.settings.mcp.inputRoots).toEqual([])
      await expect(service.paths.input(input, service.settings.mcp.inputRoots)).rejects.toThrow('未获授权')
      await service.reviewMcpRequest(request.id, false, '范围太大')
      expect(service.settings.mcp.inputRoots).toEqual([])
      await expect(service.requestTranscode({ requestKey: 'unauthorized', requests: [transcode('denied.m4a')], reason: '转码测试' })).rejects.toThrow('未获授权')
      expect(service.queue.jobs).toHaveLength(0)
    } finally { await service.shutdown() }
  })

  it('批准目录持久合并当前设置，MCP 重配失败保持原范围', async () => {
    const service = await isolatedService('folder-granted', [])
    try {
      const request = await service.requestDirectoryAccess({ requestKey: 'grant-folder', path: inputDirectory, permission: 'input', reason: '读取音频' })
      await service.saveSettings({ ...service.settings, theme: 'light' })
      service.beforeSaveSettings = async () => { throw new Error('MCP 端口被占用') }
      const failed = await service.reviewMcpRequest(request.id, true)
      expect(failed).toMatchObject({ status: 'failed', error: 'MCP 端口被占用' })
      expect(service.settings.mcp.inputRoots).toEqual([])
      service.beforeSaveSettings = undefined
      const second = await service.requestDirectoryAccess({ requestKey: 'grant-folder-again', path: inputDirectory, permission: 'input', reason: '读取音频' })
      expect((await service.reviewMcpRequest(second.id, true)).status).toBe('approved')
      expect(service.settings.theme).toBe('light')
      expect(service.settings.mcp.inputRoots).toEqual([inputDirectory])
      expect(JSON.parse(await readFile(join(root, 'folder-granted', 'config.json'), 'utf8')).settings.mcp.inputRoots).toEqual([inputDirectory])
    } finally { await service.shutdown() }
  })

  it('人工批准只允许这个批次；不开启持续提交权限，不重复创建任务', async () => {
    const service = await isolatedService('single-batch')
    try {
      const request = await service.requestTranscode({ requestKey: 'single-batch', requests: [transcode('approved.m4a')], reason: '用户确认 AAC 音频转码' })
      expect(service.queue.jobs).toHaveLength(0)
      await expect(service.submit([transcode('direct.m4a')], 'mcp', 'direct')).rejects.toThrow('未获授权')
      const approved = await service.reviewMcpRequest(request.id, true)
      expect(approved.status).toBe('approved')
      expect(approved.jobIds).toHaveLength(1)
      expect(service.queue.jobs[0].source).toBe('mcp')
      expect(service.queue.jobs[0].requestKey).toBe(`approval-${request.id}`)
      expect(service.settings.mcp.allowSubmit).toBe(false)
      const repeated = await service.requestTranscode({ requestKey: 'single-batch', requests: [transcode('approved.m4a')], reason: '用户确认 AAC 音频转码' })
      expect(repeated.id).toBe(request.id)
      expect((await service.reviewMcpRequest(request.id, true)).jobIds).toEqual(approved.jobIds)
      expect(service.queue.jobs).toHaveLength(1)
    } finally { await service.shutdown() }
  })

  it('审批时再次检查撤销的输入权限与停用的 MCP，失败申请不会入队', async () => {
    const service = await isolatedService('revalidate-batch')
    try {
      const request = await service.requestTranscode({ requestKey: 'revoke-input', requests: [transcode('revoked.m4a')], reason: '待批准音频' })
      const internals = service as unknown as { configuration: { settings: Settings } }
      internals.configuration.settings.mcp.inputRoots = []
      expect(await service.reviewMcpRequest(request.id, true)).toMatchObject({ status: 'failed', error: expect.stringContaining('未获授权') })
      expect(service.queue.jobs).toHaveLength(0)
      internals.configuration.settings.mcp.inputRoots = [inputDirectory]
      const stopped = await service.requestTranscode({ requestKey: 'disable-server', requests: [transcode('stopped.m4a')], reason: '待批准音频' })
      internals.configuration.settings.mcp.enabled = false
      expect(await service.reviewMcpRequest(stopped.id, true)).toMatchObject({ status: 'failed', error: expect.stringContaining('未启用') })
      expect(service.queue.jobs).toHaveLength(0)
    } finally { await service.shutdown() }
  })
})
