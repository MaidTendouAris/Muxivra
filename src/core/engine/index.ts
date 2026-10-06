import { realpath, readdir, mkdir, rm, rename, open } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { join, dirname, isAbsolute, delimiter, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import yauzl from 'yauzl'
import type { Engine, DownloadState } from '../../shared/types'
import { run } from './process'
import { exists, isWithin, localPath } from '../media/paths'

export const engineManifest = {
  id: 'gyan-9.0.2-essentials-win-x64', version: '9.0.2', platform: 'win32', arch: 'x64', license: 'GPL-3.0-or-later',
  url: 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip',
  sha256: '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba',
  sourceUrl: 'https://github.com/FFmpeg/FFmpeg/commit/946fcce07b', noticeUrl: 'https://www.gyan.dev/ffmpeg/builds/'
}
function capabilities(text: string, flags: number): string[] { return text.split(/\r?\n/).flatMap(line => { const match = new RegExp(`^\\s*[A-Z.]{${flags === 3 ? '2,3' : flags}}\\s+(\\w+)\\s`).exec(line); return match && match[1] !== '=' ? [match[1]] : [] }) }
export async function verifyEngine(ffmpegPath: string, source: Engine['source']): Promise<Engine> {
  const executable = await realpath(localPath(ffmpegPath))
  const probe = await realpath(join(dirname(executable), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'))
  const [versionText, probeText, encoders, decoders, filters] = await Promise.all([
    run(executable, ['-version']), run(probe, ['-version']), run(executable, ['-hide_banner','-encoders']),
    run(executable, ['-hide_banner','-decoders']), run(executable, ['-hide_banner','-filters'])
  ])
  if (/--enable-nonfree\b/.test(versionText)) throw new Error('不支持使用 --enable-nonfree 的构建，请选择可再分发的 FFmpeg')
  const version = /^ffmpeg version (\S+)/m.exec(versionText)?.[1]
  if (!version || /^ffprobe version (\S+)/m.exec(probeText)?.[1] !== version) throw new Error('FFmpeg 与 ffprobe 版本不匹配，请选择同一构建目录')
  return { id: createHash('sha256').update(executable + version).digest('hex').slice(0, 16), ffmpegPath: executable, ffprobePath: probe, version, source,
    encoders: capabilities(encoders, 6), decoders: capabilities(decoders, 6), filters: capabilities(filters, 3), encoderKinds:Object.fromEntries(encoders.split(/\r?\n/).flatMap(line=>{const m=/^\s*([VAS])[A-Z.]{5}\s+(\w+)\s/.exec(line);return m?[[m[2],m[1]==='V'?'video':m[1]==='A'?'audio':'subtitle']]:[]})), detectedAt: new Date().toISOString() }
}
export async function detectEngine(): Promise<Engine | undefined> {
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const directory = entry.replace(/^"|"$/g, '')
    if (!isAbsolute(directory)) continue
    try { const path = join(directory, name); if (await exists(path)) return await verifyEngine(path, 'path') } catch {}
  }
  return undefined
}
async function extractZip(zipPath: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  return new Promise((resolvePromise, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) { reject(error ?? new Error('无法打开引擎压缩包')); return }
      let expanded = 0
      zip.on('error', reject)
      zip.on('end', resolvePromise)
      zip.on('entry', async entry => {
        try {
          const target = resolve(destination, entry.fileName)
          expanded += entry.uncompressedSize
          if (!isWithin(destination, target) || isAbsolute(entry.fileName) || expanded > 1024 * 1024 * 1024 || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error('压缩包路径或大小不合法')
          if (entry.fileName.endsWith('/')) { await mkdir(target, { recursive: true }); zip.readEntry(); return }
          await mkdir(dirname(target), { recursive: true })
          zip.openReadStream(entry, async (streamError, stream) => {
            try { if (streamError || !stream) throw streamError ?? new Error('无法解压引擎'); await pipeline(stream, createWriteStream(target, { flags: 'wx' })); zip.readEntry() }
            catch (e) { zip.close(); reject(e) }
          })
        } catch (e) { zip.close(); reject(e) }
      })
      zip.readEntry()
    })
  })
}
export async function installEngine(root: string, update: (state: DownloadState) => void, signal?: AbortSignal): Promise<Engine> {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('内置下载目前仅支持 Windows x64，请选择已有引擎')
  const target = join(root, engineManifest.id)
  if (await exists(target)) return verifyEngine(join(target, 'ffmpeg-9.0.2-essentials_build', 'bin', 'ffmpeg.exe'), 'managed')
  const staging = join(root, `.download-${randomUUID()}`)
  await mkdir(staging, { recursive: true })
  try {
    update({ state: 'downloading', percent: 0, message: '正在下载 Gyan 9.0.2' })
    const response = await fetch(engineManifest.url, { signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(600000)]) : AbortSignal.timeout(600000) })
    if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`)
    const total = Number(response.headers.get('content-length') ?? 0)
    let bytes = 0
    const hash = createHash('sha256')
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length; if (bytes > 400 * 1024 * 1024) { callback(new Error('下载包超出大小限制')); return }
      hash.update(chunk); update({ state: 'downloading', percent: total ? Math.min(99, bytes / total * 100) : 0, message: `已下载 ${(bytes / 1024 / 1024).toFixed(1)} MB` }); callback(null, chunk)
    } })
    const archive = join(staging, 'engine.zip')
    await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(archive, { flags: 'wx' }))
    update({ state: 'verifying', percent: 100, message: '正在校验 SHA-256' })
    if (hash.digest('hex') !== engineManifest.sha256) throw new Error('SHA-256 不匹配，下载已丢弃，原引擎保持可用')
    update({ state: 'extracting', percent: 100, message: '校验成功，正在解压并验证引擎' })
    const extracted = join(staging, 'extracted')
    await extractZip(archive, extracted)
    await verifyEngine(join(extracted, 'ffmpeg-9.0.2-essentials_build', 'bin', 'ffmpeg.exe'), 'managed')
    const manifestFile = await open(join(extracted, 'muxivra-manifest.json'), 'wx')
    await manifestFile.writeFile(JSON.stringify(engineManifest, null, 2)); await manifestFile.close()
    // Windows may briefly retain executable handles after version verification or antivirus scanning.
    for (let attempt = 0; ; attempt++) {
      try { await rename(extracted,target); break }
      catch (error) {
        if (attempt >= 9 || !['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        await new Promise(resolve => setTimeout(resolve,Math.min(2000,200*(attempt+1))))
      }
    }
    return await verifyEngine(join(target, 'ffmpeg-9.0.2-essentials_build', 'bin', 'ffmpeg.exe'), 'managed')
  } finally {
    if (!isWithin(root, staging) || !staging.startsWith(join(root, '.download-'))) throw new Error('拒绝清理目录边界外的路径')
    await rm(staging, { recursive: true, force: true })
  }
}
export async function managedEngines(root: string): Promise<Engine[]> {
  if (!await exists(root)) return []
  const engines: Engine[] = []
  for (const directory of await readdir(root)) {
    if (directory !== engineManifest.id) continue
    try { engines.push(await verifyEngine(join(root, directory, 'ffmpeg-9.0.2-essentials_build', 'bin', 'ffmpeg.exe'), 'managed')) } catch {}
  }
  return engines
}
