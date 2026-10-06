import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export function run(executable: string, args: string[], options: { timeout?: number; maxBytes?: number; signal?: AbortSignal } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: 'pipe' })
    let stdout = '', stderr = '', failure: Error | undefined
    const fail = (message: string) => { failure ??= new Error(message); child.kill() }
    const timer = setTimeout(() => fail('媒体引擎响应超时'), options.timeout ?? 30000)
    const abort = () => fail('操作已取消')
    if (options.signal?.aborted) abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); if (Buffer.byteLength(stdout) > (options.maxBytes ?? 16 * 1024 * 1024)) fail('引擎返回数据过大') })
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-16000) })
    child.on('error', error => { failure = error })
    child.on('close', code => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); if (failure) reject(failure); else if (code !== 0) reject(new Error(stderr || `媒体引擎退出码 ${code}`)); else resolve(stdout) })
  })
}
export function stopProcess(child: ChildProcessWithoutNullStreams): () => void {
  if (child.exitCode !== null) return () => {}
  child.stdin.on('error', () => {})
  child.stdin.write('q\n')
  const timer = setTimeout(() => child.kill(), 2000)
  return () => clearTimeout(timer)
}
