import { createHash, randomUUID } from 'node:crypto'
import { readFile, lstat, mkdir, open, link, unlink, readdir, realpath, stat, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import type { SubtitleDocument } from '../../shared/types'
import type { SubtitleProjectState } from '../../shared/subtitle-project'
import { subtitleSchema } from '../../shared/schema'
import { createSubtitleDocument, normalizeSubtitleDocument } from '../../shared/subtitles'
import { parseSubtitleText, serializeAss, srtTextToAss } from './ass'
import { JsonStore } from '../storage/json'
import { atomicRename } from '../storage/atomic'
import { canonicalOutput, localPath, PathPolicy } from '../media/paths'

export const SUBTITLE_AUTOSAVE_MS = 60_000
const MAX_FILE_BYTES = 10 * 1024 * 1024
interface RecoveryFile {
  version: 2
  document: SubtitleDocument
  baseHash?: string
  savedDigest?: string
  lastSavedAt?: string
  backupPath?: string
  lastRecoveryAt: string
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const digest = (document: SubtitleDocument) => hash(JSON.stringify(normalizeSubtitleDocument(document)))
export function subtitleSidecar(path: string): string { const extension = extname(path); return (extension ? path.slice(0, -extension.length) : path) + '.ass' }
export function decodeSubtitle(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le')
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
}
export class SubtitleProjectLocationError extends Error {
  constructor(readonly suggestedPath: string, cause: unknown) {
    super('无法在源文件旁保存 ASS 工程，请选择其他保存位置', { cause }); this.name = 'SubtitleProjectLocationError'
  }
}

/** Owns the writable ASS target. Renderer metadata never grants a write path. */
export class SubtitleProjectStore {
  private document?: SubtitleDocument
  private baseHash?: string
  private savedDigest?: string
  private lastSavedAt?: string
  private lastRecoveryAt?: string
  private backupPath?: string
  private error?: string
  private recoveryPending = false
  private saving = false
  private operations: Promise<unknown> = Promise.resolve()
  private timer?: ReturnType<typeof setInterval>
  private readonly store: JsonStore<unknown>
  constructor(readonly dataPath: string, private readonly paths: PathPolicy, private readonly onUpdate: () => void = () => {}) {
    this.store = new JsonStore(join(dataPath, 'subtitle-session.json'))
  }
  state(): SubtitleProjectState {
    return { documentId: this.document?.id, projectPath: this.document?.projectPath, lastSavedAt: this.lastSavedAt,
      lastRecoveryAt: this.lastRecoveryAt, backupPath: this.backupPath, dirty: !!this.document && digest(this.document) !== this.savedDigest,
      saving: this.saving, recoveryPending: this.recoveryPending || undefined, error: this.error }
  }
  get(): SubtitleDocument | undefined { return this.document ? structuredClone(this.document) : undefined }
  async initialize(): Promise<void> {
    const raw = await this.store.read(undefined)
    if (raw) {
      const saved = raw as Partial<RecoveryFile>
      const envelope = saved.version === 2 && !!saved.document
      const restored = subtitleSchema.parse(envelope ? saved.document : raw)
      // Before version 2, recovery sessions contained SRT text rather than ASS.
      this.document = normalizeSubtitleDocument(!envelope && !restored.version
        ? { ...restored, exportFormat: 'srt', cues: restored.cues.map(cue => ({ ...cue, text: srtTextToAss(cue.text) })) }
        : restored)
      if (envelope) {
        if (saved.baseHash !== undefined && !/^[a-f0-9]{64}$/.test(saved.baseHash)) throw new Error('字幕恢复文件的校验值无效，请保留原文件')
        this.baseHash = saved.baseHash; this.savedDigest = saved.savedDigest; this.lastSavedAt = saved.lastSavedAt
        this.backupPath = saved.backupPath; this.lastRecoveryAt = saved.lastRecoveryAt
      }
      if (this.document.mediaPath) {
        try { await this.paths.grantFile(this.document.mediaPath) } catch { this.error = '关联媒体无法读取；字幕恢复内容已保留，请重新选择媒体' }
      }
      if (this.document.projectPath) {
        try {
          const path = await this.safeExisting(this.document.projectPath)
          const current = hash(await this.readFile(path))
          if (this.baseHash !== current && current === hash(this.text(this.document))) { this.baseHash = current; this.savedDigest = digest(this.document) }
          else if (!this.baseHash || this.baseHash !== current) { this.recoveryPending = true; this.error = 'ASS 工程在应用外发生变化。恢复草稿已保留，请先另存为工程，再重新导入文件；不会自动覆盖。' }
          this.paths.files.add(path)
        } catch { this.recoveryPending = true; this.error = 'ASS 工程无法读取。恢复草稿已保留，请另存为工程。' }
      }
    }
    this.timer = setInterval(() => { void this.save().catch(() => {}) }, SUBTITLE_AUTOSAVE_MS)
    this.timer.unref()
  }
  private async readFile(path: string): Promise<Buffer> {
    if ((await stat(path)).size > MAX_FILE_BYTES) throw new Error('字幕文件超过 10 MB')
    const buffer = await readFile(path); if (buffer.length > MAX_FILE_BYTES) throw new Error('字幕文件超过 10 MB'); return buffer
  }
  private async safeExisting(target: string): Promise<string> {
    const path = localPath(target), info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('字幕工程必须是普通本地文件，不能使用符号链接')
    const canonical = await realpath(path)
    if (canonical.toLowerCase() !== path.toLowerCase()) throw new Error('字幕工程路径已变化，请重新选择')
    return canonical
  }
  private async present(path: string): Promise<boolean> {
    try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }
  private text(document: SubtitleDocument): string {
    const text = serializeAss(document)
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('ASS 工程超过 10 MB，请减少内容或拆分工程')
    return text
  }
  private async publishNew(path: string, text: string): Promise<void> {
    const temporary = join(dirname(path), `.muxivra-${randomUUID()}.tmp`)
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }
      // Publish the completed file atomically, while refusing any existing name.
      await link(temporary, path)
    } finally { await unlink(temporary).catch(() => {}) }
  }
  async openMedia(input: string, chosenPath?: string): Promise<SubtitleDocument> {
    const mediaPath = await this.paths.input(input)
    const sidecar = subtitleSidecar(mediaPath)
    let seed: SubtitleDocument = createSubtitleDocument({ mediaPath })
    if (chosenPath && await this.present(sidecar)) { const sourcePath = await this.safeExisting(sidecar); seed = normalizeSubtitleDocument({ ...parseSubtitleText(decodeSubtitle(await this.readFile(sourcePath)), 'ass'), sourcePath, mediaPath }) }
    return this.openTarget(chosenPath ?? sidecar, seed, !chosenPath)
  }
  async import(input: string, chosenPath?: string): Promise<SubtitleDocument> {
    const sourcePath = await this.paths.input(input), extension = extname(sourcePath).toLowerCase().slice(1)
    if (!['ass', 'ssa', 'srt'].includes(extension)) throw new Error('请选择 SRT、ASS 或 SSA 字幕')
    const parsed = parseSubtitleText(decodeSubtitle(await this.readFile(sourcePath)), extension as 'ass' | 'ssa' | 'srt')
    let document = normalizeSubtitleDocument({ ...parsed, sourcePath, mediaPath: this.document?.mediaPath })
    if (chosenPath && await this.present(subtitleSidecar(sourcePath))) { const path = await this.safeExisting(subtitleSidecar(sourcePath)); document = normalizeSubtitleDocument({ ...parseSubtitleText(decodeSubtitle(await this.readFile(path)), 'ass'), sourcePath, mediaPath: this.document?.mediaPath }) }
    return this.openTarget(chosenPath ?? subtitleSidecar(sourcePath), document, !chosenPath)
  }
  private openTarget(target: string, seed: SubtitleDocument, allowExisting: boolean): Promise<SubtitleDocument> {
    return this.exclusive(async () => {
      if (this.document && (this.document.projectPath || this.document.cues.length) && this.state().dirty) throw new Error('当前字幕工程有未保存的更改，请先保存工程')
      if (extname(target).toLowerCase() !== '.ass') throw new Error('字幕工程必须保存为 ASS 文件')
      const path = localPath(target)
      let next: SubtitleDocument, file: Buffer
      if (await this.present(path)) {
        if (!allowExisting) throw new Error('新工程保存位置已有文件，请选择新文件名')
        const canonical = await this.safeExisting(path); file = await this.readFile(canonical)
        next = normalizeSubtitleDocument({ ...parseSubtitleText(decodeSubtitle(file), 'ass'), sourcePath: seed.sourcePath ?? canonical, projectPath: canonical, mediaPath: seed.mediaPath })
        const probe = join(dirname(canonical), `.muxivra-${randomUUID()}.tmp`)
        try { await access(canonical, constants.W_OK); const handle = await open(probe, 'wx', 0o600); await handle.close() }
        catch (error) { throw new SubtitleProjectLocationError(path, error) }
        finally { await unlink(probe).catch(() => {}) }
      } else {
        next = normalizeSubtitleDocument({ ...seed, projectPath: path })
        const text = this.text(next)
        try { const canonical = await canonicalOutput(path); next.projectPath = canonical; await this.publishNew(canonical, text) }
        catch (error) { if (!allowExisting) throw error; throw new SubtitleProjectLocationError(path, error) }
        file = Buffer.from(text, 'utf8')
      }
      const envelope = { ...this.envelope(next, hash(file), digest(next), new Date().toISOString()), backupPath: undefined }
      await this.store.write(envelope)
      this.adopt(envelope); this.paths.files.add(next.projectPath!); this.onUpdate(); return structuredClone(next)
    })
  }
  private envelope(document: SubtitleDocument, baseHash = this.baseHash, savedDigest = this.savedDigest, lastSavedAt = this.lastSavedAt): RecoveryFile {
    const value: RecoveryFile = { version: 2, document: structuredClone(document), baseHash, savedDigest, lastSavedAt, backupPath: this.backupPath, lastRecoveryAt: new Date().toISOString() }
    if (Buffer.byteLength(JSON.stringify(value)) > 32 * 1024 * 1024) throw new Error('字幕恢复数据超过 32 MB，请拆分工程')
    return value
  }
  private adopt(value: RecoveryFile): void {
    this.document = value.document; this.baseHash = value.baseHash; this.savedDigest = value.savedDigest
    this.lastSavedAt = value.lastSavedAt; this.lastRecoveryAt = value.lastRecoveryAt; this.backupPath = value.backupPath
    this.error = undefined; this.recoveryPending = false
  }
  private checked(document: SubtitleDocument): SubtitleDocument {
    const parsed = normalizeSubtitleDocument(subtitleSchema.parse(document))
    if (this.document) {
      if (parsed.id !== this.document.id) throw new Error('字幕工程已切换，旧编辑请求已停止')
      for (const field of ['projectPath', 'mediaPath', 'sourcePath'] as const) if (parsed[field] !== this.document[field]) throw new Error('字幕工程关联路径不可直接修改，请选择媒体或另存为工程')
    } else if (parsed.projectPath || parsed.mediaPath || parsed.sourcePath) throw new Error('请先导入媒体或字幕工程')
    return parsed
  }
  cache(document: SubtitleDocument): Promise<void> {
    return this.exclusive(async () => {
      const parsed = this.checked(document), next = this.envelope(parsed)
      if (this.document && digest(parsed) === digest(this.document)) return
      await this.store.write(next); this.document = parsed; this.lastRecoveryAt = next.lastRecoveryAt; this.onUpdate()
    })
  }
  save(document?: SubtitleDocument): Promise<SubtitleDocument | undefined> {
    return this.exclusive(async () => {
      if (document) {
        const parsed = this.checked(document), next = this.envelope(parsed)
        await this.store.write(next); this.document = parsed; this.lastRecoveryAt = next.lastRecoveryAt
      }
      if (!this.document) return
      if (!this.document.projectPath) return structuredClone(this.document)
      this.saving = true; this.onUpdate()
      try {
        const path = await this.safeExisting(this.document.projectPath), old = await this.readFile(path)
        if (this.recoveryPending || !this.baseHash || hash(old) !== this.baseHash) {
          this.recoveryPending = true; throw new Error('ASS 工程已被其他程序修改，已停止覆盖；请先另存为工程，再重新导入文件')
        }
        const text = this.text(this.document), nextHash = hash(text)
        if (nextHash !== this.baseHash) {
          const backupDirectory = join(this.dataPath, 'subtitle-backups', hash(this.document.id).slice(0, 32))
          await mkdir(backupDirectory, { recursive: true })
          const backup = join(backupDirectory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.ass`)
          const backupHandle = await open(backup, 'wx', 0o600)
          try { await backupHandle.writeFile(old); await backupHandle.sync() } finally { await backupHandle.close() }
          this.backupPath = backup
          const temporary = join(dirname(path), `.muxivra-${randomUUID()}.tmp`)
          try {
            const handle = await open(temporary, 'wx', 0o600)
            try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }
            await this.safeExisting(path)
            if (hash(await this.readFile(path)) !== this.baseHash) { this.recoveryPending = true; throw new Error('保存期间 ASS 工程被外部修改，原文件已保留') }
            await atomicRename(temporary, path, async()=>{
              await this.safeExisting(path)
              if(hash(await this.readFile(path))!==this.baseHash){this.recoveryPending=true;throw new Error('保存期间 ASS 工程被外部修改，原文件已保留')}
            })
          } finally { await unlink(temporary).catch(() => {}) }
          this.baseHash = nextHash
          const backups = (await readdir(backupDirectory)).filter(name => /^\d{4}-.*\.ass$/.test(name)).sort()
          for (const oldName of backups.slice(0, -20)) await unlink(join(backupDirectory, oldName)).catch(() => {})
        }
        const now = new Date().toISOString(), next = this.envelope(this.document, this.baseHash, digest(this.document), now)
        await this.store.write(next); this.adopt(next); return this.get()
      } catch (error) { this.error = (error as Error).message; throw error }
      finally { this.saving = false; this.onUpdate() }
    })
  }
  saveAs(document: SubtitleDocument, target: string): Promise<SubtitleDocument> {
    return this.exclusive(async () => {
      const parsed = this.checked(document)
      if (extname(target).toLowerCase() !== '.ass') throw new Error('字幕工程必须保存为 ASS 文件')
      const path = await this.paths.output(target), next = normalizeSubtitleDocument({ ...parsed, projectPath: path })
      const text = this.text(next); await this.publishNew(path, text)
      const envelope = this.envelope(next, hash(text), digest(next), new Date().toISOString())
      await this.store.write(envelope); this.adopt(envelope); this.paths.files.add(path); this.onUpdate(); return structuredClone(next)
    })
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> { const result = this.operations.catch(() => {}).then(operation); this.operations = result; return result }
  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    await this.operations.catch(() => {})
    // Draft recovery has already been persisted. A conflict must not prevent
    // quitting or cause the external file to be overwritten on shutdown.
    await this.save().catch(() => {}); await this.store.flush()
  }
}
