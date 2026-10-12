import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { MpvIpc } from '../../src/core/player/ipc'
import { defaultShortcuts, mpvShortcutBindings, toMpvKey } from '../../src/shared/shortcuts'

describe.runIf(process.platform==='win32')('实际内置 mpv 的可编辑按键',()=>{
  it('更新原生绑定后旧键失效，组合键和 Shift 字符分派正确的动作',async()=>{
    const pipe=`\\\\.\\pipe\\muxivra-shortcuts-${randomUUID()}`
    const child=spawn(resolve('resources/mpv/mpv.exe'),['--no-config','--idle=yes','--vo=null','--ao=null','--load-scripts=no','--osc=no','--input-default-bindings=no','--input-terminal=no',`--input-ipc-server=${pipe}`],{windowsHide:true,stdio:'ignore'})
    const ipc=new MpvIpc(),messages:string[]=[]
    let processError:Error|undefined;child.on('error',error=>{processError=error})
    ipc.on('event',event=>{if(event.event==='client-message')messages.push(event.args[0])})
    async function waitCount(count:number){const start=Date.now();while(messages.length<count&&Date.now()-start<3000)await new Promise(resolve=>setTimeout(resolve,10));expect(messages).toHaveLength(count)}
    try{
      await ipc.connect(pipe);if(processError)throw processError
      const initial=mpvShortcutBindings(defaultShortcuts,'subtitles')
      for(const [key,command] of initial)await ipc.command(['keybind',key,command])
      await ipc.command(['keypress','SPACE']);await waitCount(1);expect(messages[0]).toBe('muxivra-toggle')
      await ipc.command(['keypress','q']);await waitCount(2);expect(messages[1]).toBe('muxivra-set-start')
      await ipc.command(['keypress','e']);await waitCount(3);expect(messages[2]).toBe('muxivra-set-end')
      const next=mpvShortcutBindings({...defaultShortcuts,'player.toggle':'Ctrl+KeyP','player.screenshot':''},'subtitles')
      for(const key of initial.keys())if(!next.has(key))await ipc.command(['keybind',key,'ignore'])
      for(const [key,command] of next)await ipc.command(['keybind',key,command])
      await ipc.command(['keypress','SPACE']);await ipc.command(['keypress','s']);await new Promise(resolve=>setTimeout(resolve,100));expect(messages).toHaveLength(3)
      await ipc.command(['keypress','Ctrl+p']);await waitCount(4);expect(messages[3]).toBe('muxivra-toggle')
      await ipc.command(['keypress','Ctrl+Z']);await waitCount(5);expect(messages[4]).toBe('muxivra-redo')
      for(const combination of ['Shift+Digit3','Ctrl+Shift+Equal','Alt+Shift+Period']){
        const key=toMpvKey(combination)!,count=messages.length
        await ipc.command(['keybind',key,'script-message muxivra-check'])
        await ipc.command(['keypress',key]);await waitCount(count+1);expect(messages.at(-1)).toBe('muxivra-check')
      }
    }finally{
      await ipc.command(['quit'],1000).catch(()=>{});ipc.close()
      if(child.exitCode===null){await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,1000))]);if(child.exitCode===null)child.kill()}
    }
  })
})
