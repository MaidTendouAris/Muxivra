import { describe,expect,it,vi } from 'vitest'
import { createReadStream,existsSync } from 'node:fs'
import { mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AsrModels,whisperRuntimeCatalog } from '../../src/core/asr/models'
import { discoverPython } from '../../src/core/asr/python-discovery'
import { isWithin } from '../../src/core/media/paths'
const cpuZip=resolve('.runtime','asr-validation','cpu.zip'),python=resolve('.runtime','asr-python','cpython-3.12-windows-x86_64-none','python.exe')
async function local(run:(root:string)=>Promise<void>){await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data','asr-assets-native-'));try{await run(root)}finally{if(!isWithin(resolve('.test-data'),root))throw new Error('Unsafe cleanup');await rm(root,{recursive:true,force:true})}}
describe('ASR asset native validation',()=>{
  it.skipIf(process.platform!=='win32'||!existsSync(cpuZip))('reinstalls a verified CPU runtime on the installation disk without duplicating its legacy record',()=>local(async root=>{
    const profile=join(root,'profile'),installation=join(root,'installation');await mkdir(join(profile,'asr'),{recursive:true});await writeFile(join(profile,'asr','models.json'),JSON.stringify({version:1,models:[],runtimes:[{id:'whisper-b5454-cpu',name:'Legacy record',executable:process.execPath}]}))
    const mock=vi.spyOn(globalThis,'fetch').mockImplementation(async url=>{expect(String(url)).toBe(whisperRuntimeCatalog.cpu.url);return new Response(Readable.toWeb(createReadStream(cpuZip)) as ReadableStream)})
    const models=new AsrModels(profile,()=>{},undefined,installation)
    try{await models.initialize();await models.install('runtime','cpu');expect(models.state().runtimes).toHaveLength(1);const path=models.runtime('whisper-b5454-cpu');expect(isWithin(join(installation,'asr','runtimes'),path)).toBe(true);expect(path).not.toBe(process.execPath);expect(models.state().download.phase).toBe('completed');const persisted=JSON.parse(await readFile(join(profile,'asr','models.json'),'utf8'));expect(persisted.runtimes).toHaveLength(1)}finally{mock.mockRestore();await models.shutdown()}
  }))
  it.skipIf(process.platform!=='win32'||!existsSync(python))('discovers a real application-managed Python environment without a manually supplied interpreter path',()=>local(async root=>{
    const storage=join(root,'installation','asr'),environment=join(storage,'environments','fixture');await mkdir(join(storage,'temp'),{recursive:true});await promisify(execFile)(python,['-m','venv','--without-pip',environment],{windowsHide:true,timeout:30000})
    const updates:boolean[]=[],result=await discoverPython(storage,[],new AbortController().signal,state=>updates.push(state.active)),candidate=result.candidates.find(value=>isWithin(environment,value.pythonPath))
    expect(candidate?.isVenv).toBe(true);expect(candidate?.prefix.toLowerCase()).toBe(environment.toLowerCase());expect(candidate?.version).toMatch(/^3\.12\./);expect(candidate?.sources).toContain('应用运行环境');expect(candidate?.issue).toBeUndefined();expect(result.active).toBe(false);expect(updates[0]).toBe(true);expect(updates.at(-1)).toBe(false)
  }))
})
