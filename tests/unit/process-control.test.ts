import { describe,it,expect,vi,beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
const state=vi.hoisted(()=>({records:[] as {pid:number;parent:number;created:bigint;exited?:bigint}[],assigned:[] as number[],cursor:0,closed:[] as number[]}))
vi.mock('koffi',()=>({default:{load:()=>({func:(declaration:string)=>{
  const name=declaration.match(/__stdcall (\w+)\(/)![1]
  const entry=(buffer:Buffer)=>{const value=state.records[state.cursor];if(!value)return false;buffer.writeUInt32LE(value.pid,8);buffer.writeUInt32LE(value.parent,process.arch==='x64'?32:24);return true}
  const functions:Record<string,Function>={CreateJobObjectW:()=>999,OpenProcess:(_access:number,_inherit:boolean,pid:number)=>pid,CloseHandle:(handle:number)=>{state.closed.push(handle);return true},SetInformationJobObject:()=>true,AssignProcessToJobObject:(_job:number,pid:number)=>{state.assigned.push(pid);return true},CreateToolhelp32Snapshot:()=>888,Process32FirstW:(_snapshot:number,buffer:Buffer)=>{state.cursor=0;return entry(buffer)},Process32NextW:(_snapshot:number,buffer:Buffer)=>{state.cursor++;return entry(buffer)},IsProcessInJob:(_pid:number,_job:number,result:Buffer)=>{result.writeUInt32LE(0);return true},GetProcessTimes:(pid:number,created:Buffer,exited:Buffer)=>{const value=pid===100?{created:1000n,exited:0n}:state.records.find(value=>value.pid===pid)!;created.writeBigUInt64LE(value.created);exited.writeBigUInt64LE(value.exited??0n);return true}}
  return functions[name]??(()=>true)
}})}}))
import { trackChildTree } from '../../src/core/jobs/process-control'
beforeEach(()=>{state.records=[];state.assigned=[];state.closed=[]})
describe.skipIf(process.platform!=='win32')('Windows process ownership',()=>{
  const child=()=>Object.assign(new EventEmitter(),{pid:100,kill:vi.fn()}) as unknown as ChildProcessWithoutNullStreams
  it('never assigns older processes or their descendants when a parent PID was recycled',()=>{
    state.records=[{pid:200,parent:100,created:500n},{pid:201,parent:200,created:1800n},{pid:301,parent:300,created:1200n},{pid:300,parent:100,created:1100n}]
    const task=child();trackChildTree(task);expect(state.assigned).toEqual([100,300,301]);expect(state.closed).toContain(200);expect(state.closed).not.toContain(999);task.emit('close',0);expect(state.closed).toContain(999);expect(task.kill).not.toHaveBeenCalled()
  })
  it('can still bind a live grandchild whose verified launcher has already exited',()=>{
    state.records=[{pid:200,parent:100,created:1100n,exited:1500n},{pid:201,parent:200,created:1200n}]
    const task=child();trackChildTree(task);expect(state.assigned).toEqual([100,201]);expect(state.closed).toContain(200);task.emit('close',0)
  })
})
