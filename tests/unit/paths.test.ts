import { describe,it,expect,beforeEach,afterEach } from 'vitest'
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { PathPolicy,isWithin,availableOutput,localPath } from '../../src/core/media/paths'
let root:string
beforeEach(async()=>{await mkdir('.test-data',{recursive:true});root=await mkdtemp(resolve('.test-data','paths-'));await mkdir(join(root,'allowed'));await mkdir(join(root,'allowed-sibling'));await writeFile(join(root,'allowed','a.mp4'),'media')})
afterEach(async()=>{if(isWithin(resolve('.test-data'),root))await rm(root,{recursive:true,force:true})})
describe('路径授权边界',()=>{
  it('使用路径层级而非字符串前缀',()=>{expect(isWithin(join(root,'allowed'),join(root,'allowed','a.mp4'))).toBe(true);expect(isWithin(join(root,'allowed'),join(root,'allowed-sibling','b.mp4'))).toBe(false)})
  it('未经授权的读取与输出被拒绝',async()=>{const policy=new PathPolicy();await expect(policy.input(join(root,'allowed','a.mp4'))).rejects.toThrow('未获授权');await policy.grantFile(join(root,'allowed','a.mp4'));await expect(policy.input(join(root,'allowed','a.mp4'))).resolves.toBeDefined();await expect(policy.output(join(root,'allowed','b.mp4'))).rejects.toThrow();await policy.grantDirectory(join(root,'allowed'));await expect(policy.output(join(root,'allowed','b.mp4'))).resolves.toBeDefined()})
  it('拒绝协议、网络与相对路径',()=>{for(const path of ['http://example.com/a.mp4','../media.mp4','\\\\server\\a.mp4'])expect(()=>localPath(path)).toThrow()})
  it('重名输出被拒绝或自动编号',async()=>{const path=join(root,'allowed','a.mp4');await expect(availableOutput(path,new Set(),false)).rejects.toThrow();expect(await availableOutput(path,new Set(),true)).toBe(join(root,'allowed','a (1).mp4'))})
})
