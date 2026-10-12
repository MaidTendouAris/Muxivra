import { afterEach, expect, it, vi } from 'vitest'
import { rename } from 'node:fs/promises'
import { atomicRename } from '../../src/core/storage/atomic'

vi.mock('node:fs/promises',()=>({rename:vi.fn()}))
afterEach(()=>vi.resetAllMocks())
it.skipIf(process.platform!=='win32')('短暂Windows文件锁只重试原子替换，不清除旧文件',async()=>{
  vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('locked'),{code:'EPERM'})).mockResolvedValueOnce(undefined)
  await atomicRename('draft.tmp','project.ass')
  expect(rename).toHaveBeenCalledTimes(2);expect(rename).toHaveBeenLastCalledWith('draft.tmp','project.ass')
})
it.skipIf(process.platform!=='win32')('重试前再次核对外部修改，检查失败停止替换',async()=>{
  vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('locked'),{code:'EACCES'}))
  const guard=vi.fn<()=>Promise<void>>().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('external edit'))
  await expect(atomicRename('draft.tmp','project.ass',guard)).rejects.toThrow('external edit')
  expect(rename).toHaveBeenCalledTimes(1)
})
it('永久错误直接报告，不尝试删除原文件',async()=>{
  vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('bad path'),{code:'ENOENT'}))
  await expect(atomicRename('draft.tmp','project.ass')).rejects.toThrow('bad path')
  expect(rename).toHaveBeenCalledTimes(1)
})
