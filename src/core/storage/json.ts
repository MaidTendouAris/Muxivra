import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export class JsonStore<T> {
  private writes: Promise<void> = Promise.resolve()
  constructor(readonly path: string) {}
  async read(fallback: T): Promise<T> {
    try { return JSON.parse(await readFile(this.path, 'utf8')) as T }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw new Error(`配置文件无法读取，请保留文件并检查：${this.path}`, { cause: error }) }
  }
  write(value: T): Promise<void> {
    const json = JSON.stringify(value, null, 2)
    const operation = this.writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${randomUUID()}.tmp`
      await writeFile(temporary, json, { mode: 0o600 })
      await rename(temporary, this.path)
    })
    this.writes = operation
    return operation
  }
  async flush(): Promise<void> { await this.writes }
}
