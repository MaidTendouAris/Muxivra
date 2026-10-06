import { describe,it,expect } from 'vitest'
import { resolve,join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { installEngine,engineManifest } from '../../src/core/engine'
import type { DownloadState } from '../../src/shared/types'
describe.skipIf(process.env.MUXIVRA_TEST_DOWNLOAD !== '1')('独立引擎实际下载',()=>{
  it('验证固定包 SHA-256、解压、能力和重新使用',async()=>{
    const root=resolve('.runtime/engine-validation'),states:DownloadState[]=[]
    const engine=await installEngine(root,state=>states.push(state))
    expect(engine.version).toContain(engineManifest.version);expect(engine.source).toBe('managed');expect(engine.encoders).toContain('libx264');expect(engine.filters).toContain('scale')
    const manifest=JSON.parse(await readFile(join(root,engineManifest.id,'muxivra-manifest.json'),'utf8'));expect(manifest.sha256).toBe(engineManifest.sha256)
    const existing=await installEngine(root,()=>{throw new Error('不应重复下载')});expect(existing.id).toBe(engine.id)
    console.log(JSON.stringify({version:engine.version,states:[...new Set(states.map(s=>s.state))],sha256:manifest.sha256}))
  },600000)
})
