import { it,expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdir,mkdtemp,writeFile,readFile,rm } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { suspendChild,trackChildTree,terminateChild } from '../../src/core/jobs/process-control'
import { isWithin } from '../../src/core/media/paths'

it.skipIf(process.platform!=='win32').each([false,true])('Windows 推理启动器与子进程一起暂停、继续和取消（启动器私有进程组=%s）',async(privateJob)=>{
  await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data','process-tree-')),ticker=join(root,'ticker.txt'),worker=join(root,'worker.cjs'),launcher=join(root,'launcher.cjs')
  await writeFile(worker,`const fs=require('node:fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(ticker)},'x'),40)`)
  const own=privateJob?`const ffi=require('koffi'),dll=ffi.load('kernel32.dll'),create=dll.func('uintptr_t __stdcall CreateJobObjectW(void *a,void *b)'),set=dll.func('bool __stdcall SetInformationJobObject(uintptr_t j,uint32_t k,void *p,uint32_t s)'),open=dll.func('uintptr_t __stdcall OpenProcess(uint32_t a,bool b,uint32_t p)'),assign=dll.func('bool __stdcall AssignProcessToJobObject(uintptr_t j,uintptr_t p)'),close=dll.func('bool __stdcall CloseHandle(uintptr_t h)'),job=create(null,null),info=Buffer.alloc(144);info.writeUInt32LE(0x2000,16);if(!set(job,9,info,144))throw Error('set');const handle=open(0x101,false,child.pid);if(!assign(job,handle))throw Error('assign');close(handle);child.on('exit',()=>close(job));`:''
  await writeFile(launcher,`const {spawn}=require('node:child_process');const child=spawn(process.execPath,[${JSON.stringify(worker)}],{stdio:'inherit'});${own}setInterval(()=>{},1000)`)
  const child=spawn(process.execPath,[launcher],{stdio:'pipe',windowsHide:true}),closed=new Promise<void>(done=>child.once('close',()=>done()))
  try{
    // Exercise the launcher race: the descendant exists before registration.
    await expect.poll(()=>readFile(ticker,'utf8').catch(()=>''),{timeout:15000}).toMatch(/x{3}/);trackChildTree(child)
    suspendChild(child,true);await new Promise(done=>setTimeout(done,100));const paused=await readFile(ticker,'utf8');await new Promise(done=>setTimeout(done,300));expect(await readFile(ticker,'utf8')).toBe(paused)
    suspendChild(child,false);await expect.poll(()=>readFile(ticker,'utf8')).not.toBe(paused)
    terminateChild(child);await closed;const stopped=await readFile(ticker,'utf8');await new Promise(done=>setTimeout(done,300));expect(await readFile(ticker,'utf8')).toBe(stopped)
  }finally{if(child.exitCode===null){terminateChild(child);await closed}if(!isWithin(resolve('.test-data'),root))throw new Error('Unsafe cleanup');await rm(root,{recursive:true,force:true})}
})
