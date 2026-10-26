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
  { id:'subtitles.setStart', label:'将播放位置设为字幕起点', scope:'subtitles', defaultKey:'KeyQ', nativeAction:'set-start' },
  { id:'subtitles.setEnd', label:'将播放位置设为字幕终点', scope:'subtitles', defaultKey:'KeyE', nativeAction:'set-end' },
  { id:'subtitles.undo', label:'撤销字幕修改', scope:'subtitles', defaultKey:'Ctrl+KeyZ', nativeAction:'undo' },
  { id:'subtitles.redo', label:'重做字幕修改', scope:'subtitles', defaultKey:'Ctrl+Shift+KeyZ', nativeAction:'redo' },
  { id:'waveform.panLeft',label:'向左滚动波形',scope:'waveform',defaultKey:'WheelUp' },
  { id:'waveform.panRight',label:'向右滚动波形',scope:'waveform',defaultKey:'WheelDown' },
  { id:'waveform.zoomIn',label:'放大波形横轴',scope:'waveform',defaultKey:'Ctrl+WheelUp' },
  { id:'waveform.zoomOut',label:'缩小波形横轴',scope:'waveform',defaultKey:'Ctrl+WheelDown' },
  { id:'waveform.gainUp',label:'放大波形纵轴',scope:'waveform',defaultKey:'Ctrl+Shift+WheelUp' },
  { id:'waveform.gainDown',label:'缩小波形纵轴',scope:'waveform',defaultKey:'Ctrl+Shift+WheelDown' },
  { id:'waveform.reset',label:'重置波形视窗',scope:'waveform',defaultKey:'Alt+KeyR' },
  { id:'waveform.clearSelection',label:'清除波形选区',scope:'waveform',defaultKey:'Alt+KeyX' }
] as const

export type ShortcutId = typeof shortcutDefinitions[number]['id']
export type ShortcutScope = typeof shortcutDefinitions[number]['scope']
export type WaveformShortcutId = Extract<ShortcutId,`waveform.${string}`>
export const waveformShortcutIds:readonly WaveformShortcutId[]=shortcutDefinitions.filter(item=>item.scope==='waveform').map(item=>item.id)
export type ShortcutBindings = Record<ShortcutId,string>
export const defaultShortcuts = Object.fromEntries(shortcutDefinitions.map(item=>[item.id,item.defaultKey])) as ShortcutBindings

const modifiers = ['Ctrl','Alt','Shift','Meta'] as const
const namedKeys:Record<string,string> = { Space:'空格',ArrowLeft:'←',ArrowRight:'→',ArrowUp:'↑',ArrowDown:'↓',Home:'Home',End:'End',PageUp:'Page Up',PageDown:'Page Down',Insert:'Insert',Delete:'Delete' }
const punctuation:Record<string,[string,string]> = { Comma:[',','<'],Period:['.','>'],BracketLeft:['[','{'],BracketRight:[']','}'],Minus:['-','_'],Equal:['=','+'],Backquote:['`','~'],Semicolon:[';',':'],Quote:["'",'"'],Backslash:['\\','|'],Slash:['/','?'] }
const nativeNamedKeys:Record<string,string> = { Space:'SPACE',ArrowLeft:'LEFT',ArrowRight:'RIGHT',ArrowUp:'UP',ArrowDown:'DOWN',Home:'HOME',End:'END',PageUp:'PGUP',PageDown:'PGDN',Insert:'INS',Delete:'DEL' }
const wheelCodes=new Set(['WheelUp','WheelDown'])
const codes = new Set([...wheelCodes,...Object.keys(namedKeys),...Object.keys(punctuation),...Array.from({length:26},(_,index)=>`Key${String.fromCharCode(65+index)}`),...Array.from({length:10},(_,index)=>`Digit${index}`),...Array.from({length:12},(_,index)=>`F${index+1}`)])

function parseShortcut(binding:string):{code:string;mods:string[]}|undefined {
  const parts=binding.split('+'),code=parts.pop()!
  if(!codes.has(code)||parts.some(part=>!(modifiers as readonly string[]).includes(part))||new Set(parts).size!==parts.length)return
  if(parts.join('+')!==modifiers.filter(modifier=>parts.includes(modifier)).join('+'))return
  return {code,mods:parts}
}

export function resolveShortcuts(bindings?:Partial<ShortcutBindings>):ShortcutBindings {
  // New actions must never steal a custom key from an older saved configuration.
  const claimed=new Set(Object.values(bindings??{}).filter(Boolean))
  return Object.fromEntries(shortcutDefinitions.map(item=>[item.id,bindings?.[item.id]??(claimed.has(item.defaultKey)?'':item.defaultKey)])) as ShortcutBindings
}

/** Apply new defaults once, without replacing custom bindings or introducing conflicts. */
export function migrateLegacyShortcuts(bindings?:Partial<ShortcutBindings>):ShortcutBindings {
  const resolved=resolveShortcuts(bindings)
  if(resolved['subtitles.setStart']!=='BracketLeft'||resolved['subtitles.setEnd']!=='BracketRight')return resolved
  const next={...resolved,'subtitles.setStart':'KeyQ','subtitles.setEnd':'KeyE'}
  return validateShortcuts(next).length?resolved:next
}

export function validateShortcuts(bindings:ShortcutBindings):{id:ShortcutId;message:string}[] {
  const issues:{id:ShortcutId;message:string}[]=[],used=new Map<string,typeof shortcutDefinitions[number]>()
  for(const item of shortcutDefinitions){
    const key=bindings[item.id]
    if(typeof key!=='string'||(key!==''&&(!parseShortcut(key)||item.scope!=='waveform'&&wheelCodes.has(parseShortcut(key)!.code)))){issues.push({id:item.id,message:'不支持的按键组合'});continue}
    if(!key)continue
    const other=used.get(key)
    if(other){issues.push({id:item.id,message:`与“${other.label}”冲突`});issues.push({id:other.id,message:`与“${item.label}”冲突`})}
    else used.set(key,item)
  }
  return issues
}

const shortcutShape=Object.fromEntries(shortcutDefinitions.map(item=>[item.id,z.string().max(80)])) as Record<ShortcutId,z.ZodString>
export const shortcutBindingsSchema = z.object(shortcutShape).partial().strict().transform(value=>resolveShortcuts(value)).superRefine((value,context)=>{
  for(const issue of validateShortcuts(value))context.addIssue({code:'custom',path:[issue.id],message:issue.message})
}).default(defaultShortcuts)

type KeyEvent = Pick<KeyboardEvent,'code'|'ctrlKey'|'altKey'|'shiftKey'|'metaKey'|'isComposing'>
export function shortcutFromEvent(event:KeyEvent):string|undefined {
  if(event.isComposing||!codes.has(event.code)||wheelCodes.has(event.code))return
  return [...modifiers.filter(modifier=>event[({Ctrl:'ctrlKey',Alt:'altKey',Shift:'shiftKey',Meta:'metaKey'} as const)[modifier]]),event.code].join('+')
}

type WheelKeyEvent=Pick<WheelEvent,'deltaX'|'deltaY'|'ctrlKey'|'altKey'|'shiftKey'|'metaKey'>
/** Trackpads and ordinary mouse wheels use the same configurable directions. */
export function shortcutFromWheel(event:WheelKeyEvent):string|undefined {
  const delta=Math.abs(event.deltaX)>Math.abs(event.deltaY)?event.deltaX:event.deltaY
  if(!Number.isFinite(delta)||delta===0)return
  return [...modifiers.filter(modifier=>event[({Ctrl:'ctrlKey',Alt:'altKey',Shift:'shiftKey',Meta:'metaKey'} as const)[modifier]]),delta<0?'WheelUp':'WheelDown'].join('+')
}
export function matchWheelShortcut(event:WheelKeyEvent,id:ShortcutId,bindings:ShortcutBindings):boolean {
  const binding=bindings[id];return !!binding&&shortcutFromWheel(event)===binding
}
export function isWheelShortcut(binding:string):boolean {return wheelCodes.has(parseShortcut(binding)?.code??'')}

export function matchShortcut(event:KeyEvent,id:ShortcutId,bindings:ShortcutBindings):boolean {
  const binding=bindings[id]
  return !!binding&&shortcutFromEvent(event)===binding
}

export function formatShortcut(binding:string):string {
  if(binding==='')return '未设置'
  const parsed=parseShortcut(binding);if(!parsed)return binding
  const key=({WheelUp:'滚轮上 / 左',WheelDown:'滚轮下 / 右'} as Record<string,string>)[parsed.code]??namedKeys[parsed.code]??punctuation[parsed.code]?.[0]??parsed.code.replace(/^Key|^Digit/,'')
  return [...parsed.mods.map(modifier=>modifier==='Meta'?'Win':modifier),key].join(' + ')
}

/** mpv matches printable characters (Shift is folded into them), unlike DOM code. */
export function toMpvKey(binding:string):string|undefined {
  const parsed=parseShortcut(binding);if(!parsed||wheelCodes.has(parsed.code))return
  const shifted=parsed.mods.includes('Shift'),printable=/^Key[A-Z]$|^Digit[0-9]$/.test(parsed.code)||!!punctuation[parsed.code]
  let key=nativeNamedKeys[parsed.code]??parsed.code
  if(parsed.code.startsWith('Key'))key=shifted?parsed.code.slice(3):parsed.code.slice(3).toLowerCase()
  if(parsed.code.startsWith('Digit'))key=shifted?')!@#$%^&*('[Number(parsed.code.slice(5))]:parsed.code.slice(5)
  if(punctuation[parsed.code])key=punctuation[parsed.code][shifted?1:0]
  if(key==='#')key='SHARP'
  return [...parsed.mods.filter(modifier=>modifier!=='Shift'||!printable),key].join('+')
}

export function mpvShortcutBindings(bindings:ShortcutBindings,owner:'single'|'audio'|'subtitles'):Map<string,string> {
  const result=new Map<string,string>()
  for(const item of shortcutDefinitions){
    if(item.scope!=='player'&&owner!=='subtitles')continue
    const key=toMpvKey(bindings[item.id]);if(key)result.set(key,`script-message muxivra-${item.scope==='waveform'?item.id.replace('.','-'):item.nativeAction}`)
  }
  return result
}

export function isShortcutInput(target:EventTarget|null):boolean {
  if(!target||typeof (target as HTMLElement).closest!=='function')return false
  const element=target as HTMLElement
  if(element.isContentEditable)return true
  const editor=element.closest('input,textarea,[role="textbox"]')
  if(!editor)return false
  if(editor.tagName!=='INPUT')return true
  // Buttons and non-text controls retain the active page's shortcuts when focused.
  return !['button','checkbox','color','file','hidden','image','radio','range','reset','submit'].includes((editor as HTMLInputElement).type)
}
