import { z } from 'zod'

export const shortcutDefinitions = [
  { id:'player.toggle', label:'播放 / 暂停', scope:'player', defaultKey:'Space', nativeAction:'toggle' },
  { id:'player.seekBackward', label:'向后定位', description:'单文件 5 秒；字幕编辑 100 毫秒', scope:'player', defaultKey:'ArrowLeft', nativeAction:'seek-left' },
  { id:'player.seekForward', label:'向前定位', description:'单文件 5 秒；字幕编辑 100 毫秒', scope:'player', defaultKey:'ArrowRight', nativeAction:'seek-right' },
  { id:'player.volumeUp', label:'提高音量', description:'每次增加 5%', scope:'player', defaultKey:'ArrowUp', nativeAction:'volume-up' },
  { id:'player.volumeDown', label:'降低音量', description:'每次减少 5%', scope:'player', defaultKey:'ArrowDown', nativeAction:'volume-down' },
  { id:'player.mute', label:'静音 / 取消静音', scope:'player', defaultKey:'KeyM', nativeAction:'mute' },
  { id:'player.fullscreen', label:'进入 / 退出全屏', scope:'player', defaultKey:'KeyF', nativeAction:'fullscreen' },
  { id:'player.screenshot', label:'保存截图', scope:'player', defaultKey:'KeyS', nativeAction:'screenshot' },
  { id:'player.framePrevious', label:'上一帧', scope:'player', defaultKey:'Comma', nativeAction:'frame-previous' },
  { id:'player.frameNext', label:'下一帧', scope:'player', defaultKey:'Period', nativeAction:'frame-next' },
  { id:'subtitles.setStart', label:'将播放位置设为字幕起点', scope:'subtitles', defaultKey:'BracketLeft', nativeAction:'set-start' },
  { id:'subtitles.setEnd', label:'将播放位置设为字幕终点', scope:'subtitles', defaultKey:'BracketRight', nativeAction:'set-end' },
  { id:'subtitles.undo', label:'撤销字幕修改', scope:'subtitles', defaultKey:'Ctrl+KeyZ', nativeAction:'undo' },
  { id:'subtitles.redo', label:'重做字幕修改', scope:'subtitles', defaultKey:'Ctrl+Shift+KeyZ', nativeAction:'redo' }
] as const

export type ShortcutId = typeof shortcutDefinitions[number]['id']
export type ShortcutScope = typeof shortcutDefinitions[number]['scope']
export type ShortcutBindings = Record<ShortcutId,string>
export const defaultShortcuts = Object.fromEntries(shortcutDefinitions.map(item=>[item.id,item.defaultKey])) as ShortcutBindings

const modifiers = ['Ctrl','Alt','Shift','Meta'] as const
const namedKeys:Record<string,string> = { Space:'空格',ArrowLeft:'←',ArrowRight:'→',ArrowUp:'↑',ArrowDown:'↓',Home:'Home',End:'End',PageUp:'Page Up',PageDown:'Page Down',Insert:'Insert',Delete:'Delete' }
const punctuation:Record<string,[string,string]> = { Comma:[',','<'],Period:['.','>'],BracketLeft:['[','{'],BracketRight:[']','}'],Minus:['-','_'],Equal:['=','+'],Backquote:['`','~'],Semicolon:[';',':'],Quote:["'",'"'],Backslash:['\\','|'],Slash:['/','?'] }
const nativeNamedKeys:Record<string,string> = { Space:'SPACE',ArrowLeft:'LEFT',ArrowRight:'RIGHT',ArrowUp:'UP',ArrowDown:'DOWN',Home:'HOME',End:'END',PageUp:'PGUP',PageDown:'PGDN',Insert:'INS',Delete:'DEL' }
const codes = new Set([...Object.keys(namedKeys),...Object.keys(punctuation),...Array.from({length:26},(_,index)=>`Key${String.fromCharCode(65+index)}`),...Array.from({length:10},(_,index)=>`Digit${index}`),...Array.from({length:12},(_,index)=>`F${index+1}`)])

function parseShortcut(binding:string):{code:string;mods:string[]}|undefined {
  const parts=binding.split('+'),code=parts.pop()!
  if(!codes.has(code)||parts.some(part=>!(modifiers as readonly string[]).includes(part))||new Set(parts).size!==parts.length)return
  if(parts.join('+')!==modifiers.filter(modifier=>parts.includes(modifier)).join('+'))return
  return {code,mods:parts}
}

export function resolveShortcuts(bindings?:Partial<ShortcutBindings>):ShortcutBindings {
  return Object.fromEntries(shortcutDefinitions.map(item=>[item.id,bindings?.[item.id]??item.defaultKey])) as ShortcutBindings
}

export function validateShortcuts(bindings:ShortcutBindings):{id:ShortcutId;message:string}[] {
  const issues:{id:ShortcutId;message:string}[]=[],used=new Map<string,typeof shortcutDefinitions[number]>()
  for(const item of shortcutDefinitions){
    const key=bindings[item.id]
    if(typeof key!=='string'||(key!==''&&!parseShortcut(key))){issues.push({id:item.id,message:'不支持的按键组合'});continue}
    if(!key)continue
    const other=used.get(key)
    if(other){issues.push({id:item.id,message:`与“${other.label}”冲突`});issues.push({id:other.id,message:`与“${item.label}”冲突`})}
    else used.set(key,item)
  }
  return issues
}

const shortcutShape=Object.fromEntries(shortcutDefinitions.map(item=>[item.id,z.string().max(80)])) as Record<ShortcutId,z.ZodString>
export const shortcutBindingsSchema = z.object(shortcutShape).strict().superRefine((value,context)=>{
  for(const issue of validateShortcuts(value))context.addIssue({code:'custom',path:[issue.id],message:issue.message})
}).default(defaultShortcuts)

type KeyEvent = Pick<KeyboardEvent,'code'|'ctrlKey'|'altKey'|'shiftKey'|'metaKey'|'isComposing'>
export function shortcutFromEvent(event:KeyEvent):string|undefined {
  if(event.isComposing||!codes.has(event.code))return
  return [...modifiers.filter(modifier=>event[({Ctrl:'ctrlKey',Alt:'altKey',Shift:'shiftKey',Meta:'metaKey'} as const)[modifier]]),event.code].join('+')
}

export function matchShortcut(event:KeyEvent,id:ShortcutId,bindings:ShortcutBindings):boolean {
  const binding=bindings[id]
  return !!binding&&shortcutFromEvent(event)===binding
}

export function formatShortcut(binding:string):string {
  if(binding==='')return '未设置'
  const parsed=parseShortcut(binding);if(!parsed)return binding
  const key=namedKeys[parsed.code]??punctuation[parsed.code]?.[0]??parsed.code.replace(/^Key|^Digit/,'')
  return [...parsed.mods.map(modifier=>modifier==='Meta'?'Win':modifier),key].join(' + ')
}

/** mpv matches printable characters (Shift is folded into them), unlike DOM code. */
export function toMpvKey(binding:string):string|undefined {
  const parsed=parseShortcut(binding);if(!parsed)return
  const shifted=parsed.mods.includes('Shift'),printable=/^Key[A-Z]$|^Digit[0-9]$/.test(parsed.code)||!!punctuation[parsed.code]
  let key=nativeNamedKeys[parsed.code]??parsed.code
  if(parsed.code.startsWith('Key'))key=shifted?parsed.code.slice(3):parsed.code.slice(3).toLowerCase()
  if(parsed.code.startsWith('Digit'))key=shifted?')!@#$%^&*('[Number(parsed.code.slice(5))]:parsed.code.slice(5)
  if(punctuation[parsed.code])key=punctuation[parsed.code][shifted?1:0]
  if(key==='#')key='SHARP'
  return [...parsed.mods.filter(modifier=>modifier!=='Shift'||!printable),key].join('+')
}

export function mpvShortcutBindings(bindings:ShortcutBindings,owner:'single'|'subtitles'):Map<string,string> {
  const result=new Map<string,string>()
  for(const item of shortcutDefinitions){
    if(item.scope==='subtitles'&&owner!=='subtitles')continue
    const key=toMpvKey(bindings[item.id]);if(key)result.set(key,`script-message muxivra-${item.nativeAction}`)
  }
  return result
}

export function isShortcutInput(target:EventTarget|null):boolean {
  if(!target||typeof (target as HTMLElement).closest!=='function')return false
  const element=target as HTMLElement
  return element.isContentEditable||!!element.closest('input,textarea,select,button,[contenteditable="true"],[role="textbox"],[role="dialog"],[role="listbox"]')
}
