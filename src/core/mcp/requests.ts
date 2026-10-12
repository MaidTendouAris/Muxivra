import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { pathSchema, requestSchema } from '../../shared/schema'
import type { McpRequest, McpRequestAction } from '../../shared/mcp-requests'
import { JsonStore } from '../storage/json'

export const MCP_PENDING_LIMIT = 100
export const MCP_HISTORY_LIMIT = 1000
export const MCP_REQUEST_BYTES = 256 * 1024
const STORE_BYTES = 32 * 1024 * 1024

const keySchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
const reasonSchema = z.string().trim().min(1).max(2000).refine(value => !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))
const payloads = [
  z.object({ kind: z.literal('directory'), payload: z.object({ path: pathSchema, permission: z.enum(['input', 'output']) }).strict() }),
  z.object({ kind: z.literal('transcode'), payload: z.object({ requests: z.array(requestSchema).min(1).max(500) }).strict() })
] as const
const actionFields = { requestKey: keySchema, reason: reasonSchema }
const actionSchema = z.discriminatedUnion('kind', [payloads[0].extend(actionFields).strict(), payloads[1].extend(actionFields).strict()])
const base = {
  id: z.uuid(), requestKey: keySchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['pending', 'approving', 'approved', 'rejected', 'failed']), createdAt: z.iso.datetime(), resolvedAt: z.iso.datetime().optional(),
  reason: reasonSchema, reviewerNote: z.string().max(2000).optional(), error: z.string().max(4000).optional(), jobIds: z.array(z.uuid()).max(500).optional()
}
const recordSchema = z.discriminatedUnion('kind', [payloads[0].extend(base).strict(), payloads[1].extend(base).strict()])
const storeSchema = z.object({ version: z.literal(1), records: z.array(recordSchema).max(MCP_PENDING_LIMIT + MCP_HISTORY_LIMIT) }).strict()

interface RequestStorage {
  read(fallback: { version: 1; records: McpRequest[] }): Promise<{ version: 1; records: McpRequest[] }>
  write(value: { version: 1; records: McpRequest[] }): Promise<void>
  flush(): Promise<void>
}
export interface McpApprovalResult { jobIds?: string[] }
export type McpRequestRecovery = (request: McpRequest) => Promise<McpApprovalResult | undefined>

// A durable "approving" marker must precede side effects. Recovery only examines
// committed effects and never repeats an operation whose outcome is uncertain.
export class McpRequestStore {
  private records: McpRequest[] = []
  private revision = 0
  private operations: Promise<unknown> = Promise.resolve()
  private readonly storage: RequestStorage
  constructor(path: string, private readonly onUpdate: () => void = () => {}, storage?: RequestStorage) {
    this.storage = storage ?? new JsonStore(path)
  }

  async initialize(recover: McpRequestRecovery): Promise<void> {
    const parsed = storeSchema.parse(await this.storage.read({ version: 1, records: [] }))
    if (Buffer.byteLength(JSON.stringify(parsed)) > STORE_BYTES) throw new Error('MCP 申请记录超过安全大小，请保留文件并检查')
    const keys = new Set<string>(), ids = new Set<string>()
    for (const record of parsed.records) {
      if (keys.has(record.requestKey) || ids.has(record.id)) throw new Error('MCP 申请记录存在重复标识，请保留文件并检查')
      if (Buffer.byteLength(JSON.stringify(record.payload)) > MCP_REQUEST_BYTES) throw new Error('MCP 申请内容超过安全大小')
      keys.add(record.requestKey); ids.add(record.id)
    }
    this.records = parsed.records as McpRequest[]
    if (this.records.filter(record => ['pending', 'approving'].includes(record.status)).length > MCP_PENDING_LIMIT) throw new Error('MCP 待审申请超过 100 条，请保留记录文件并检查')
    const next = structuredClone(this.records)
    for (const record of next.filter(record => record.status === 'approving')) {
      let result: McpApprovalResult | undefined
      try { result = await recover(record) } catch {}
      record.status = result ? 'approved' : 'failed'
      record.resolvedAt = new Date().toISOString()
      if (result) { record.jobIds = result.jobIds; delete record.error }
      else record.error = '应用在批准过程中退出，未能确认操作结果。不会自动重试；请检查任务和目录权限后重新申请。'
    }
    await this.persist(next)
  }

  list(): McpRequest[] { return structuredClone(this.records).reverse() }
  counts(): { pending: number; total: number; revision: number } { return { pending: this.records.filter(record => ['pending', 'approving'].includes(record.status)).length, total: this.records.length, revision: this.revision } }
  get(id: string): McpRequest {
    const record = this.records.find(record => record.id === id)
    if (!record) throw new Error('MCP 申请不存在或已过期')
    return structuredClone(record)
  }

  create(action: McpRequestAction, validate: (action: McpRequestAction) => Promise<McpRequestAction>): Promise<McpRequest> {
    return this.exclusive(async () => {
      const parsed = actionSchema.parse(action) as McpRequestAction
      if (Buffer.byteLength(JSON.stringify(parsed)) > MCP_REQUEST_BYTES) throw new Error('申请参数不能超过 256 KB，请分批申请')
      const fingerprint = createHash('sha256').update(JSON.stringify(parsed)).digest('hex')
      const previous = this.records.find(record => record.requestKey === parsed.requestKey)
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error('申请去重标识已用于其他内容，请使用新的 requestKey')
        return structuredClone(previous)
      }
      if (this.records.filter(record => ['pending', 'approving'].includes(record.status)).length >= MCP_PENDING_LIMIT) throw new Error('待审申请已达 100 条，请先在 MCP 交互页处理已有申请')
      const normalized = actionSchema.parse(await validate(parsed)) as McpRequestAction
      if (normalized.kind !== parsed.kind || normalized.requestKey !== parsed.requestKey || normalized.reason !== parsed.reason) throw new Error('申请规范化结果无效')
      if (Buffer.byteLength(JSON.stringify(normalized)) > MCP_REQUEST_BYTES) throw new Error('规范化后的申请参数不能超过 256 KB，请分批申请')
      const record = { ...normalized, id: randomUUID(), fingerprint, status: 'pending' as const, createdAt: new Date().toISOString() } as McpRequest
      await this.persist([...this.records, record])
      return structuredClone(record)
    })
  }

  review(id: string, approve: boolean, note: string | undefined, execute: (request: McpRequest) => Promise<McpApprovalResult>): Promise<McpRequest> {
    return this.exclusive(async () => {
      z.boolean().parse(approve)
      if (note !== undefined) z.string().max(2000).parse(note)
      const record = this.get(id)
      if (record.status === 'approving') throw new Error('申请正在批准或执行结果尚待恢复，不能重复执行')
      if (record.status !== 'pending') return record
      if (!approve) {
        const rejected = { ...record, status: 'rejected' as const, resolvedAt: new Date().toISOString(), reviewerNote: note }
        await this.replace(rejected)
        return rejected
      }
      const approving = { ...record, status: 'approving' as const, reviewerNote: note }
      await this.replace(approving)
      let result: McpApprovalResult
      try { result = await execute(approving) }
      catch (error) {
        const failed = { ...approving, status: 'failed' as const, resolvedAt: new Date().toISOString(), error: String((error as Error).message ?? error).slice(0, 4000) }
        try { await this.replace(failed) } catch (saveError) { this.uncertain(approving, `批准失败且结果无法保存：${(saveError as Error).message}`) }
        return this.get(id)
      }
      const approved = { ...approving, status: 'approved' as const, resolvedAt: new Date().toISOString(), ...result }
      try { await this.replace(approved) }
      catch (error) { this.uncertain({ ...approving, ...result }, `操作已提交，但审批结果无法保存；请勿重复执行：${(error as Error).message}`) }
      return this.get(id)
    })
  }

  private uncertain(record: McpRequest, error: string): void {
    this.records = this.records.map(item => item.id === record.id ? { ...record, error: error.slice(0, 4000) } : item)
    this.revision++
    this.onUpdate()
  }
  private replace(record: McpRequest): Promise<void> { return this.persist(this.records.map(item => item.id === record.id ? record : item)) }
  private async persist(records: McpRequest[]): Promise<void> {
    const active = records.filter(record => ['pending', 'approving'].includes(record.status))
    const history = records.filter(record => !['pending', 'approving'].includes(record.status)).sort((a, b) => (a.resolvedAt ?? a.createdAt).localeCompare(b.resolvedAt ?? b.createdAt)).slice(-MCP_HISTORY_LIMIT)
    let next = [...active, ...history].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    while (Buffer.byteLength(JSON.stringify({ version: 1, records: next })) > STORE_BYTES && history.length) {
      const removed = history.shift()!
      next = next.filter(record => record.id !== removed.id)
    }
    if (Buffer.byteLength(JSON.stringify({ version: 1, records: next })) > STORE_BYTES) throw new Error('MCP 待审记录存储空间已满，请先处理已有申请')
    await this.storage.write({ version: 1, records: next })
    this.records = next
    this.revision++
    this.onUpdate()
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> { const result = this.operations.catch(() => {}).then(operation); this.operations = result; return result }
  async shutdown(): Promise<void> { await this.operations.catch(() => {}); await this.storage.flush() }
}
