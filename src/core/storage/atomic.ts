import { rename } from 'node:fs/promises'

/** Windows scanners can briefly hold an existing file during replacement.
 * Retry the same atomic rename; never delete the previous file to bypass it. */
export async function atomicRename(source:string,target:string,beforeAttempt?:()=>Promise<void>):Promise<void> {
  for(let attempt=0;;attempt++){
    await beforeAttempt?.()
    try { await rename(source,target);return }
    catch(error){
      const code=(error as NodeJS.ErrnoException).code
      if(process.platform!=='win32'||attempt>=5||!['EPERM','EACCES','EBUSY'].includes(code??''))throw error
      await new Promise(resolve=>setTimeout(resolve,20*2**attempt))
    }
  }
}
