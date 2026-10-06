import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import koffi from 'koffi'

// Only the queue's live child is accepted; no caller-supplied PID is exposed.
let windows: { open: Function; close: Function; suspend: Function; resume: Function } | undefined
export function suspendChild(child: ChildProcessWithoutNullStreams, paused: boolean): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null || child.killed) throw new Error('任务正在启动或收尾，请稍后再试')
  if (process.platform !== 'win32') {
    if (!child.kill(paused ? 'SIGSTOP' : 'SIGCONT')) throw new Error('无法暂停或继续处理进程')
    return
  }
  if (!windows) {
    const kernel = koffi.load('kernel32.dll'), nt = koffi.load('ntdll.dll')
    windows = {
      open: kernel.func('uintptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
      close: kernel.func('bool __stdcall CloseHandle(uintptr_t handle)'),
      suspend: nt.func('int32_t __stdcall NtSuspendProcess(uintptr_t handle)'),
      resume: nt.func('int32_t __stdcall NtResumeProcess(uintptr_t handle)')
    }
  }
  const handle = windows.open(0x0800, false, child.pid) // PROCESS_SUSPEND_RESUME
  if (!handle) throw new Error('无法打开本次任务的处理进程')
  try {
    const status = (paused ? windows.suspend : windows.resume)(handle)
    if (status < 0) throw new Error(`无法${paused ? '暂停' : '继续'}处理进程（NTSTATUS ${Number(status >>> 0).toString(16)}）`)
  } finally { windows.close(handle) }
}
