import { describe,it,expect } from 'vitest'
import { mkdtemp,mkdir,readFile,writeFile,rm } from 'node:fs/promises'
import { resolve,join } from 'node:path'
import { JsonStore } from '../../src/core/storage/json'
import { isWithin } from '../../src/core/media/paths'
describe('本地存储恢复',()=>{
  it('按调用顺序完成原子写入，保留损坏文件',async()=>{
    await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data','storage-')),path=join(root,'state.json'),store=new JsonStore<{value:number}>(path)
    try {
      await expect(store.read({value:0})).resolves.toEqual({value:0});await Promise.all([store.write({value:1}),store.write({value:2}),store.write({value:3})]);expect(await store.read({value:0})).toEqual({value:3})
      await writeFile(path,'broken json');await expect(store.read({value:0})).rejects.toThrow('配置文件无法读取');expect(await readFile(path,'utf8')).toBe('broken json')
    } finally {if(isWithin(resolve('.test-data'),root))await rm(root,{recursive:true,force:true})}
  })
})
