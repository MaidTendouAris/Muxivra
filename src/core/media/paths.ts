import { realpath, stat, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, relative, resolve, dirname, basename, extname, sep } from 'node:path'
import { pathSchema } from '../../shared/schema'

export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}
export function localPath(value: string): string {
  pathSchema.parse(value)
  if (!isAbsolute(value) || value.startsWith('\\\\') || value.startsWith('//') || (process.platform === 'win32' && /:/.test(value.slice(2)))) throw new Error('请选择本机绝对路径，不支持网络地址或设备路径')
  if (process.platform === 'win32' && value.startsWith('\\?')) throw new Error('不支持设备路径')
  return resolve(value)
}
export async function canonicalInput(value: string): Promise<string> {
  const path = await realpath(localPath(value))
  if (!(await stat(path)).isFile()) throw new Error('输入必须是普通文件')
  return path
}
export async function canonicalOutput(value: string): Promise<string> {
  const path = localPath(value)
  const name = basename(path)
  if (!name || /^[. ]|[. ]$/.test(name) || /[<>:"|?*]/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) throw new Error('输出文件名无效')
  const parent = await realpath(dirname(path))
  if (!(await stat(parent)).isDirectory()) throw new Error('输出目录不存在')
  await access(parent, constants.W_OK)
  return resolve(parent, name)
}
export async function exists(path: string): Promise<boolean> { try { await stat(path); return true } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e } }
export async function availableOutput(path: string, reserved: Set<string>, number: boolean): Promise<string> {
  for (let i = 0; i < 10000; i++) {
    const candidate = i === 0 ? path : `${path.slice(0, -extname(path).length)} (${i})${extname(path)}`
    if (!reserved.has(candidate.toLowerCase()) && !await exists(candidate)) return candidate
    if (!number) throw new Error(`输出已存在或已被队列使用：${candidate}`)
  }
  throw new Error('输出编号过多，请使用其他文件名')
}
export class PathPolicy {
  readonly files = new Set<string>()
  readonly directories = new Set<string>()
  async grantFile(path: string): Promise<string> { const canonical = await canonicalInput(path); this.files.add(canonical); return canonical }
  async grantDirectory(path: string): Promise<string> { const canonical = await realpath(localPath(path)); if (!(await stat(canonical)).isDirectory()) throw new Error('请选择目录'); this.directories.add(canonical); return canonical }
  async input(path: string, roots?: string[]): Promise<string> {
    const canonical = await canonicalInput(path)
    const allowed = roots ? await this.underRoots(canonical, roots) : this.files.has(canonical) || [...this.directories].some(root => isWithin(root, canonical))
    if (!allowed) throw new Error('输入路径未获授权，请在应用中选择文件或配置 MCP 媒体目录')
    return canonical
  }
  async output(path: string, roots?: string[]): Promise<string> {
    const canonical = await canonicalOutput(path)
    const allowed = roots ? await this.underRoots(canonical, roots) : [...this.directories].some(root => isWithin(root, canonical))
    if (!allowed) throw new Error('输出路径未获授权，请选择输出目录或配置 MCP 输出目录')
    return canonical
  }
  private async underRoots(path: string, roots: string[]): Promise<boolean> {
    for (const root of roots) { try { if (isWithin(await realpath(localPath(root)), path)) return true } catch {} }
    return false
  }
}
