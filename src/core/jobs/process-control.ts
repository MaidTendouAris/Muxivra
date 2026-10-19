import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import koffi from 'koffi'

// Only the queue's live child is accepted; no caller-supplied PID is exposed.
let windows: { open: Function; close: Function; suspend: Function; resume: Function;createJob:Function;setJob:Function;assignJob:Function;queryJob:Function;terminateJob:Function;snapshot:Function;first:Function;next:Function;inJob:Function;times:Function } | undefined
const trees=new WeakMap<ChildProcessWithoutNullStreams,number[]>()
function win() {
  if(!windows){
    const kernel=koffi.load('kernel32.dll'),nt=koffi.load('ntdll.dll')
    windows={
      open:kernel.func('uintptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),close:kernel.func('bool __stdcall CloseHandle(uintptr_t handle)'),
      suspend:nt.func('int32_t __stdcall NtSuspendProcess(uintptr_t handle)'),resume:nt.func('int32_t __stdcall NtResumeProcess(uintptr_t handle)'),
      createJob:kernel.func('uintptr_t __stdcall CreateJobObjectW(void *attributes, void *name)'),setJob:kernel.func('bool __stdcall SetInformationJobObject(uintptr_t job, uint32_t kind, void *info, uint32_t size)'),
      assignJob:kernel.func('bool __stdcall AssignProcessToJobObject(uintptr_t job, uintptr_t process)'),queryJob:kernel.func('bool __stdcall QueryInformationJobObject(uintptr_t job, uint32_t kind, void *info, uint32_t size, void *length)'),terminateJob:kernel.func('bool __stdcall TerminateJobObject(uintptr_t job, uint32_t exitCode)'),
      snapshot:kernel.func('uintptr_t __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)'),first:kernel.func('bool __stdcall Process32FirstW(uintptr_t snapshot, void *entry)'),next:kernel.func('bool __stdcall Process32NextW(uintptr_t snapshot, void *entry)'),inJob:kernel.func('bool __stdcall IsProcessInJob(uintptr_t process, uintptr_t job, void *result)'),times:kernel.func('bool __stdcall GetProcessTimes(uintptr_t process, void *created, void *exited, void *kernel, void *user)')
    }
  }
  return windows
}
// venv python.exe is a launcher on Windows. Bind its descendants to an owned
// job object so pause/cancel also reaches actual Python, including a descendant
// launched during the small interval between spawn and assigning the job.
export function trackChildTree(child:ChildProcessWithoutNullStreams):void {
  if(process.platform!=='win32'||!child.pid)return
  const api=win(),job=api.createJob(null,null),jobs=[job],handle=api.open(0x0501,false,child.pid),kept:number[]=[]
  const lifetime=(process:number)=>{const created=Buffer.alloc(8),exited=Buffer.alloc(8);if(!api.times(process,created,exited,Buffer.alloc(8),Buffer.alloc(8)))throw new Error('无法验证 ASR 进程创建时间');return {created:created.readBigUInt64LE(),exited:exited.readBigUInt64LE()}}
  try{
    const info=Buffer.alloc(process.arch==='x64'?144:112);info.writeUInt32LE(0x2000,16) // KILL_ON_JOB_CLOSE
    if(!job||!handle||!api.setJob(job,9,info,info.length))throw new Error('无法创建 ASR 推理进程组')
    const root=lifetime(handle);if(!root.exited&&!api.assignJob(job,handle))throw new Error('无法创建 ASR 推理进程组')
    const snapshot=api.snapshot(2,0)
    if(!snapshot||snapshot===-1||BigInt(snapshot)===(process.arch==='x64'?0xffffffffffffffffn:0xffffffffn))throw new Error('无法读取 ASR 子进程')
    try{
      const entry=Buffer.alloc(process.arch==='x64'?568:556);entry.writeUInt32LE(entry.length,0)
      const processes:{pid:number;parent:number}[]=[]
      if(api.first(snapshot,entry))do{processes.push({pid:entry.readUInt32LE(8),parent:entry.readUInt32LE(process.arch==='x64'?32:24)})}while(api.next(snapshot,entry))
      // Parent PIDs outlive their original parent and can refer to a reused PID.
      // Validate every generation, not just its numeric ancestry. Keep accepted
      // handles open during the walk so those PIDs cannot be recycled mid-scan.
      const parents=new Map([[child.pid,root.created]]),checked=new Set([child.pid]);let changed=true
      while(changed){changed=false;for(const process of processes){
        const parent=parents.get(process.parent);if(parent===undefined||checked.has(process.pid))continue
        checked.add(process.pid);const descendant=api.open(0x0501,false,process.pid);if(!descendant)continue;let retain=false
        try{
          const born=lifetime(descendant);if(born.created<parent)continue
          if(!born.exited&&!jobs.some(group=>{const member=Buffer.alloc(4);return api.inJob(descendant,group,member)&&member.readUInt32LE(0)})){
            if(!api.assignJob(job,descendant)&&!lifetime(descendant).exited){
              // CPython's Windows venv launcher can put its real Python in a
              // private job before we attach the launcher. Windows cannot merge
              // that existing hierarchy with the nonempty launcher job. An empty
              // owned job can nest beneath it without removing its protections.
              const nested=api.createJob(null,null)
              if(!nested||!api.setJob(nested,9,info,info.length)||!api.assignJob(nested,descendant)){
                if(nested)api.close(nested);if(!lifetime(descendant).exited)throw new Error('无法绑定 ASR 子进程')
              }else jobs.push(nested)
            }
          }
          parents.set(process.pid,born.created);kept.push(descendant);retain=true;changed=true
        }finally{if(!retain)api.close(descendant)}
      }}
    }finally{api.close(snapshot)}
    trees.set(child,jobs);child.once('close',()=>{if(trees.get(child)===jobs){trees.delete(child);for(const group of jobs)api.close(group)}})
  }catch(error){for(const group of jobs)if(group)api.close(group);child.kill();throw error}finally{for(const descendant of kept)api.close(descendant);if(handle)api.close(handle)}
}
export function terminateChild(child:ChildProcessWithoutNullStreams):void {
  const jobs=trees.get(child);if(jobs&&process.platform==='win32'){let failed=false;for(const job of jobs)if(!win().terminateJob(job,1))failed=true;if(failed){trees.delete(child);for(const job of jobs)win().close(job);child.kill()}}
  else child.kill()
}
function members(child:ChildProcessWithoutNullStreams):number[] {
  const jobs=trees.get(child);if(!jobs)return [child.pid!]
  const size=process.arch==='x64'?8:4,pids=new Set<number>()
  for(const job of jobs){let found=false;for(let capacity=64;capacity<=65536;capacity*=2){const info=Buffer.alloc(8+capacity*size);if(win().queryJob(job,3,info,info.length,null)){const count=info.readUInt32LE(4);for(let i=0;i<count;i++)pids.add(size===8?Number(info.readBigUInt64LE(8+i*size)):info.readUInt32LE(8+i*size));found=true;break}}if(!found)throw new Error('无法读取 ASR 推理进程组')}
  return [...pids]
}
export function suspendChild(child: ChildProcessWithoutNullStreams, paused: boolean): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null || child.killed) throw new Error('任务正在启动或收尾，请稍后再试')
  if (process.platform !== 'win32') {
    if (!child.kill(paused ? 'SIGSTOP' : 'SIGCONT')) throw new Error('无法暂停或继续处理进程')
    return
  }
  const api=win(),handles:number[]=[]
  try{
    for(const pid of members(child)){
      const handle=api.open(0x0c00,false,pid);if(!handle){if(pid===child.pid)throw new Error('无法打开本次任务的处理进程');continue}
      const groups=trees.get(child);if(groups&&!groups.some(job=>{const member=Buffer.alloc(4);return api.inJob(handle,job,member)&&member.readUInt32LE(0)})){api.close(handle);continue}
      const status=(paused?api.suspend:api.resume)(handle)
      if(status<0){api.close(handle);throw new Error(`无法${paused?'暂停':'继续'}处理进程（NTSTATUS ${Number(status>>>0).toString(16)}）`)}
      handles.push(handle)
    }
  }catch(error){for(const handle of handles)(paused?api.resume:api.suspend)(handle);throw error}
  finally{for(const handle of handles)api.close(handle)}
}
