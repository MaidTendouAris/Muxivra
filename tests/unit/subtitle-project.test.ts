import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { SubtitleProjectStore, SUBTITLE_AUTOSAVE_MS, subtitleSidecar } from '../../src/core/subtitles/project'
import { PathPolicy, isWithin } from '../../src/core/media/paths'
import { createSubtitleDocument, normalizeSubtitleDocument } from '../../src/shared/subtitles'
import { serializeAss, parseAss } from '../../src/core/subtitles/ass'
import { JsonStore } from '../../src/core/storage/json'
import type { SubtitleDocument } from '../../src/shared/types'

const stores: SubtitleProjectStore[] = [], directories: string[] = []
async function setup() {
  await mkdir(resolve('.test-data'), { recursive: true })
  const root = await mkdtemp(resolve('.test-data/subtitle-project-')); directories.push(root)
  const profile = join(root, 'profile'), media = join(root, 'clip.mp4'), paths = new PathPolicy()
  await writeFile(media, 'source media, never overwrite'); await paths.grantFile(media)
  const store = new SubtitleProjectStore(profile, paths); stores.push(store); await store.initialize()
  return { root, profile, media, paths, store }
}
function addText(document: SubtitleDocument, text = '编辑字幕') {
  return { ...document, cues: [{ id: 'cue-1', startMs: 100, endMs: 2100, text, style: 'Default' }] }
}
afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers()
  for (const store of stores.splice(0)) await store.shutdown()
  for (const directory of directories.splice(0)) if (isWithin(resolve('.test-data'), directory)) await rm(directory, { recursive: true, force: true })
})
describe('ASS 工程安全与恢复', () => {
  it('旧SRT会话迁移为ASS覆盖标签，不把HTML样式作为字幕文字显示', async () => {
    const { store, profile, media } = await setup(); await store.shutdown(); await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'subtitle-session.json'), JSON.stringify({ id: 'legacy', cues: [{ id: 'old', startMs: 0, endMs: 1000, text: '<i>旧字幕</i>' }] }))
    const restored = new SubtitleProjectStore(profile, new PathPolicy()); stores.push(restored); await restored.initialize()
    expect(restored.get()?.cues[0].text).toBe('{\\i1}旧字幕{\\i0}')
    expect(restored.get()?.exportFormat).toBe('srt'); expect(restored.get()?.format).toBe('ass')
    expect(await readFile(media, 'utf8')).toBe('source media, never overwrite')
  })
  it('载入媒体立即独占创建同名ASS，媒体不变，保留真实媒体关联', async () => {
    const { store, media } = await setup(), document = await store.openMedia(media)
    expect(document.projectPath).toBe(subtitleSidecar(media)); expect(document.mediaPath).toBe(media); expect(document.format).toBe('ass')
    expect(parseAss(await readFile(document.projectPath!, 'utf8')).cues).toEqual([])
    expect(await readFile(media, 'utf8')).toBe('source media, never overwrite')
    expect(store.state()).toMatchObject({ dirty: false, saving: false })
  })
  it('已有同名ASS直接载入，读取不改动原文；首次修改保存前完整备份', async () => {
    const { store, media } = await setup(), path = subtitleSidecar(media)
    const original = serializeAss(addText(createSubtitleDocument(), '已有字幕'))
    await writeFile(path, original)
    const document = await store.openMedia(media); expect(document.cues[0].text).toBe('已有字幕')
    expect(await readFile(path, 'utf8')).toBe(original)
    document.cues[0].text = '更改字幕'; await store.cache(document); expect(store.state().dirty).toBe(true)
    await store.save(); expect(parseAss(await readFile(path, 'utf8')).cues[0].text).toBe('更改字幕')
    expect(await readFile(store.state().backupPath!, 'utf8')).toBe(original)
  })
  it.skipIf(process.platform !== 'win32')('已有ASS只读时要求新保存位置；取消不改变当前工程，选择位置保留已有内容', async () => {
    const { store, media, root } = await setup(), path = subtitleSidecar(media), original = serializeAss(addText(createSubtitleDocument(), '只读文件中的字幕'))
    await writeFile(path, original); await chmod(path, 0o444)
    try {
      await expect(store.openMedia(media)).rejects.toThrow('选择其他保存位置')
      expect(store.get()).toBeUndefined(); expect(await readFile(path, 'utf8')).toBe(original)
      const copied = await store.openMedia(media, join(root, 'editable.ass'))
      expect(copied.cues[0].text).toBe('只读文件中的字幕'); expect(copied.projectPath).toBe(join(root, 'editable.ass'))
      expect(await readFile(path, 'utf8')).toBe(original)
    } finally { await chmod(path, 0o666) }
  })
  it('周期为60秒：到时保存最新缓存草稿，59秒前ASS保持旧内容', async () => {
    const { store, media } = await setup()
    // Start an independent timer after fake timers are installed.
    await store.shutdown(); vi.useFakeTimers()
    const paths = new PathPolicy(), timed = new SubtitleProjectStore(join(dirnameForTest(media), 'timed'), paths); stores.push(timed)
    await paths.grantFile(media); await timed.initialize()
    const document = await timed.openMedia(media); await timed.cache(addText(document, '周期保存'))
    await vi.advanceTimersByTimeAsync(SUBTITLE_AUTOSAVE_MS - 1000)
    expect(parseAss(await readFile(document.projectPath!, 'utf8')).cues).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1000)
    // Cache is a serialized barrier after the timer; it performs no ASS write.
    await timed.cache(addText(document, '周期保存'))
    expect(parseAss(await readFile(document.projectPath!, 'utf8')).cues[0].text).toBe('周期保存')
  })
  it('外部修改停止自动/手动覆盖，草稿和外部原文都保留，另存为解除冲突', async () => {
    const { store, media, paths, root } = await setup(), document = await store.openMedia(media)
    const edited = addText(document, '缓存草稿'); await store.cache(edited)
    const external = serializeAss(addText(createSubtitleDocument(), '外部修改')); await writeFile(document.projectPath!, external)
    await expect(store.save()).rejects.toThrow('其他程序修改')
    expect(await readFile(document.projectPath!, 'utf8')).toBe(external)
    expect(store.get()?.cues[0].text).toBe('缓存草稿'); expect(store.state().recoveryPending).toBe(true)
    await paths.grantDirectory(root); const saved = await store.saveAs(edited, join(root, 'recovered.ass'))
    expect(parseAss(await readFile(saved.projectPath!, 'utf8')).cues[0].text).toBe('缓存草稿'); expect(store.state().recoveryPending).toBeUndefined()
    expect(await readFile(document.projectPath!, 'utf8')).toBe(external)
  })
  it('重启恢复尚未写入ASS的草稿和毫秒精度，恢复媒体授权', async () => {
    const { store, media, profile } = await setup(), document = await store.openMedia(media), edited = addText(document, '恢复未保存草稿')
    edited.cues[0].startMs = 123; await store.cache(edited)
    // Simulate another process loading durable recovery before graceful shutdown.
    const paths = new PathPolicy(), restored = new SubtitleProjectStore(profile, paths); stores.push(restored); await restored.initialize()
    expect(restored.get()?.cues[0].startMs).toBe(123); expect(restored.get()?.cues[0].text).toBe('恢复未保存草稿')
    expect(restored.state().dirty).toBe(true); expect(await paths.input(media)).toBe(media)
  })
  it('重启发现外部变更保留两份内容，关闭应用也不覆盖', async () => {
    const { store, media, profile } = await setup(), document = await store.openMedia(media)
    await store.cache(addText(document, '恢复草稿'))
    const external = serializeAss(addText(createSubtitleDocument(), '另一个编辑器')); await writeFile(document.projectPath!, external)
    const restored = new SubtitleProjectStore(profile, new PathPolicy()); stores.push(restored); await restored.initialize()
    expect(restored.state().recoveryPending).toBe(true); await restored.shutdown()
    expect(await readFile(document.projectPath!, 'utf8')).toBe(external)
  })
  it('拒绝篡改关联路径、旧工程更新、另存为覆盖现有文件', async () => {
    const { store, media, root, paths } = await setup(), document = await store.openMedia(media)
    await expect(store.cache({ ...document, projectPath: join(root, 'other.ass') })).rejects.toThrow('关联路径')
    await expect(store.cache({ ...document, id: 'old-project' })).rejects.toThrow('旧编辑请求')
    await paths.grantDirectory(root)
    await expect(store.saveAs(document, document.projectPath!)).rejects.toThrow()
    expect(parseAss(await readFile(document.projectPath!, 'utf8')).cues).toHaveLength(0)
  })
  it('切换工程前必须完成保存，拒绝丢弃仍未落盘的草稿', async () => {
    const { store, media, root, paths } = await setup(), document = await store.openMedia(media), next = join(root, 'next.wav')
    await writeFile(next, 'other media'); await paths.grantFile(next); await store.cache(addText(document))
    await expect(store.openMedia(next)).rejects.toThrow('未保存')
    expect(store.get()?.id).toBe(document.id); await store.save(); expect((await store.openMedia(next)).mediaPath).toBe(next)
  })
  it('SRT/SSA转换为ASS工程，原始输入不变；读不懂的同名ASS不被覆盖', async () => {
    const { store, paths, root, media } = await setup(), input = join(root, 'subtitles.srt'), original = '1\n00:00:00,123 --> 00:00:01,234\n<i>你好</i>\n'
    await writeFile(input, original); await paths.grantFile(input)
    const document = await store.import(input); expect(document.projectPath).toBe(join(root, 'subtitles.ass')); expect(document.cues[0].startMs).toBe(123)
    expect(document.cues[0].text).toContain('你好'); expect(await readFile(input, 'utf8')).toBe(original)
    await writeFile(subtitleSidecar(media), 'not an ASS subtitle')
    await expect(store.openMedia(media)).rejects.toThrow()
    expect(await readFile(subtitleSidecar(media), 'utf8')).toBe('not an ASS subtitle')
  })
  it('ASS发布后恢复索引写入失败，重启核对内容恢复而不误判外部冲突', async () => {
    const { store, media, profile } = await setup(), document = await store.openMedia(media), edited = addText(document, '已发布但索引失败')
    await store.cache(edited)
    const original = JsonStore.prototype.write; let calls = 0
    const spy = vi.spyOn(JsonStore.prototype, 'write').mockImplementation(function (this: JsonStore<unknown>, value) {
      if (++calls === 1) return Promise.reject(new Error('模拟保存索引失败'))
      return original.call(this, value)
    })
    await expect(store.save()).rejects.toThrow('模拟保存索引失败'); spy.mockRestore()
    // The failure above occurs at final save-state persistence, after ASS publish.
    const restored = new SubtitleProjectStore(profile, new PathPolicy()); stores.push(restored); await restored.initialize()
    expect(restored.get()?.cues[0].text).toBe('已发布但索引失败'); expect(restored.state().recoveryPending).toBeUndefined()
    expect(restored.state().canDeleteProject).toBe(true)
    expect(parseAss(await readFile(document.projectPath!, 'utf8')).cues[0].text).toBe('已发布但索引失败')
  })
  it('多次保存只保留20份之前版本的ASS备份', async () => {
    const { store, media } = await setup(), document = await store.openMedia(media)
    for (let index = 0; index < 23; index++) await store.save(addText(document, `第${index}版`))
    const backup = store.state().backupPath!, backups = await readdir(dirnameForTest(backup))
    expect(backups.filter(name => name.endsWith('.ass'))).toHaveLength(20)
    expect(await readFile(backup, 'utf8')).toContain('第21版')
  })
  it('删除应用创建的ASS后清空恢复状态，旧缓存和退出保存不会复活工程，源媒体不变', async () => {
    const { store, media, profile } = await setup(), document = await store.openMedia(media)
    await store.cache(addText(document, '尚未保存的临时字幕'))
    expect(store.state().canDeleteProject).toBe(true)
    const blank = await store.deleteProject(document.id)
    expect(blank.id).not.toBe(document.id); expect(blank.projectPath).toBeUndefined(); expect(blank.cues).toHaveLength(0)
    await expect(readFile(document.projectPath!)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(store.cache(document)).rejects.toThrow('旧编辑请求')
    await store.shutdown()
    const restored = new SubtitleProjectStore(profile, new PathPolicy()); stores.push(restored); await restored.initialize()
    expect(restored.get()?.id).toBe(blank.id); expect(restored.get()?.projectPath).toBeUndefined(); expect(restored.state().canDeleteProject).toBe(false)
    await expect(readFile(document.projectPath!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(media, 'utf8')).toBe('source media, never overwrite')
  })
  it('已有和直接导入ASS不能作为临时工程删除', async () => {
    const { store, media, paths } = await setup(), path = subtitleSidecar(media), original = serializeAss(addText(createSubtitleDocument(), '用户原有字幕'))
    await writeFile(path, original); const document = await store.openMedia(media)
    expect(store.state().canDeleteProject).toBe(false); await expect(store.deleteProject(document.id)).rejects.toThrow('原有或导入')
    await paths.grantFile(path); const imported = await store.import(path)
    await expect(store.deleteProject(imported.id)).rejects.toThrow('原有或导入'); expect(await readFile(path, 'utf8')).toBe(original)
  })
  it('SRT转换得到的临时ASS可删除，输入字幕和备份保留', async () => {
    const { store, root, paths } = await setup(), path = join(root, 'source.srt'), original = '1\n00:00:00,123 --> 00:00:01,234\n原字幕\n'
    await writeFile(path, original); await paths.grantFile(path); const document = await store.import(path)
    await store.save(addText(document)); const backup = store.state().backupPath!
    expect(store.state().canDeleteProject).toBe(true); await store.deleteProject(document.id)
    expect(await readFile(path, 'utf8')).toBe(original); expect(await readFile(backup, 'utf8')).toContain('原字幕')
  })
  it('创建记录跨重启和重新载入保留，不把生成的ASS误判为原始输入', async () => {
    const { store, media, profile } = await setup(), document = await store.openMedia(media); await store.shutdown()
    const restored = new SubtitleProjectStore(profile, new PathPolicy()); stores.push(restored); await restored.initialize()
    expect(restored.state()).toMatchObject({ canDeleteProject: true, dirty: false })
    const reopened = await restored.openMedia(media); expect(reopened.sourcePath).toBeUndefined(); expect(restored.state().canDeleteProject).toBe(true)
    await restored.deleteProject(reopened.id); await expect(readFile(document.projectPath!)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('旧0.11创建的媒体工程安全迁移，原有ASS仍受保护', async () => {
    const { store, profile, media } = await setup(), document = await store.openMedia(media); await store.shutdown()
    const path = join(profile, 'subtitle-session.json'), recovery = JSON.parse(await readFile(path, 'utf8')); delete recovery.createdProjects
    // v0.11 hashed normalized JSON in insertion order, before schema parsing.
    recovery.document = Object.fromEntries(Object.entries(recovery.document).reverse())
    recovery.savedDigest = createHash('sha256').update(JSON.stringify(normalizeSubtitleDocument(recovery.document))).digest('hex')
    await writeFile(path, JSON.stringify(recovery))
    const migrated = new SubtitleProjectStore(profile, new PathPolicy()); stores.push(migrated); await migrated.initialize()
    expect(migrated.state()).toMatchObject({ canDeleteProject: true, dirty: false }); expect(migrated.state().recoveryPending).toBeUndefined()
    await migrated.deleteProject(document.id)
  })
  it('旧0.11纯hash会话中的真实未保存草稿保持dirty，不被排序迁移吞掉', async () => {
    const { store, profile, media } = await setup(), document = await store.openMedia(media)
    await store.save(addText(document, '磁盘上已保存的字幕')); await store.shutdown()
    const path = join(profile, 'subtitle-session.json'), recovery = JSON.parse(await readFile(path, 'utf8')); delete recovery.createdProjects
    recovery.savedDigest = createHash('sha256').update(JSON.stringify(normalizeSubtitleDocument(recovery.document))).digest('hex')
    recovery.document = normalizeSubtitleDocument(addText(recovery.document, '尚未保存的恢复草稿'))
    await writeFile(path, JSON.stringify(recovery))
    const migrated = new SubtitleProjectStore(profile, new PathPolicy()); stores.push(migrated); await migrated.initialize()
    expect(migrated.state()).toMatchObject({ canDeleteProject: true, dirty: true }); expect(migrated.state().recoveryPending).toBeUndefined()
    expect(migrated.get()?.cues[0].text).toBe('尚未保存的恢复草稿')
    expect(parseAss(await readFile(document.projectPath!, 'utf8')).cues[0].text).toBe('磁盘上已保存的字幕')
  })
  it('拒绝删除外部修改的工程和旧工程身份', async () => {
    const { store, media } = await setup(), document = await store.openMedia(media), external = serializeAss(addText(createSubtitleDocument(), '其他程序修改'))
    await expect(store.deleteProject('old-project')).rejects.toThrow('旧删除请求')
    await writeFile(document.projectPath!, external); await expect(store.deleteProject(document.id)).rejects.toThrow('停止删除')
    expect(await readFile(document.projectPath!, 'utf8')).toBe(external); expect(store.get()?.id).toBe(document.id)
  })
  it('离开后同路径ASS被外部替换，再载入不能沿用旧删除权限', async () => {
    const { store, media, root, paths } = await setup(), document = await store.openMedia(media), other = join(root, 'other.wav')
    await writeFile(other, 'other media'); await paths.grantFile(other); await store.openMedia(other)
    const replacement = serializeAss(addText(createSubtitleDocument(), '用户替换的字幕'))
    await writeFile(document.projectPath!, replacement); const reopened = await store.openMedia(media)
    expect(reopened.sourcePath).toBe(document.projectPath); expect(store.state().canDeleteProject).toBe(false)
    await expect(store.deleteProject(reopened.id)).rejects.toThrow('原有或导入'); expect(await readFile(document.projectPath!, 'utf8')).toBe(replacement)
  })
  it('删除前恢复索引写入失败时，临时ASS和活动工程保持可恢复', async () => {
    const { store, media } = await setup(), document = await store.openMedia(media), contents = await readFile(document.projectPath!, 'utf8')
    const spy = vi.spyOn(JsonStore.prototype, 'write').mockRejectedValueOnce(new Error('模拟索引失败'))
    await expect(store.deleteProject(document.id)).rejects.toThrow('模拟索引失败'); spy.mockRestore()
    expect(store.get()?.id).toBe(document.id); expect(await readFile(document.projectPath!, 'utf8')).toBe(contents)
  })
})
function dirnameForTest(path: string) { return join(path, '..') }
