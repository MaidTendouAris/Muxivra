import { describe, expect, it } from 'vitest'
import { defaultShortcuts, formatShortcut, isShortcutInput, matchShortcut, migrateLegacyShortcuts, mpvShortcutBindings, resolveShortcuts, shortcutBindingsSchema, shortcutFromEvent, toMpvKey, validateShortcuts } from '../../src/shared/shortcuts'

const event=(code:string,patch:Partial<KeyboardEvent>={})=>({code,ctrlKey:false,altKey:false,shiftKey:false,metaKey:false,isComposing:false,...patch}) as KeyboardEvent
describe('可编辑快捷键',()=>{
  it('旧设置缺失时使用默认项，明确清空的键保持禁用',()=>{
    expect(shortcutBindingsSchema.parse(undefined)).toEqual(defaultShortcuts)
    const resolved=resolveShortcuts({'player.toggle':''});expect(resolved['player.toggle']).toBe('');expect(resolved['subtitles.undo']).toBe('Ctrl+KeyZ')
    expect(matchShortcut(event('Space'),'player.toggle',resolved)).toBe(false)
  })
  it('精确匹配修饰键，不匹配输入法组合事件',()=>{
    expect(matchShortcut(event('KeyZ',{ctrlKey:true}),'subtitles.undo',defaultShortcuts)).toBe(true)
    expect(matchShortcut(event('KeyZ',{ctrlKey:true,shiftKey:true}),'subtitles.undo',defaultShortcuts)).toBe(false)
    expect(matchShortcut(event('KeyZ',{ctrlKey:true,shiftKey:true}),'subtitles.redo',defaultShortcuts)).toBe(true)
    expect(shortcutFromEvent(event('KeyZ',{ctrlKey:true,isComposing:true}))).toBeUndefined()
    expect(shortcutFromEvent(event('Escape'))).toBeUndefined()
    expect(shortcutFromEvent(event('ControlLeft'))).toBeUndefined()
    expect(shortcutFromEvent(event('F8',{altKey:true,ctrlKey:true}))).toBe('Ctrl+Alt+F8')
  })
  it('字幕起止点使用 Q/E，迁移旧默认但保留自定义和冲突配置',()=>{
    expect(defaultShortcuts['subtitles.setStart']).toBe('KeyQ');expect(defaultShortcuts['subtitles.setEnd']).toBe('KeyE')
    const legacy={...defaultShortcuts,'subtitles.setStart':'BracketLeft','subtitles.setEnd':'BracketRight','player.screenshot':'Ctrl+KeyP'}
    expect(migrateLegacyShortcuts(legacy)).toEqual({...legacy,'subtitles.setStart':'KeyQ','subtitles.setEnd':'KeyE'})
    const custom={...legacy,'subtitles.setStart':'Ctrl+KeyQ'};expect(migrateLegacyShortcuts(custom)).toEqual(custom)
    const conflict={...legacy,'player.screenshot':'KeyQ'};expect(migrateLegacyShortcuts(conflict)).toEqual(conflict)
    expect(migrateLegacyShortcuts({...legacy,'subtitles.setStart':''})['subtitles.setStart']).toBe('')
  })
  it('聚焦按钮、范围条和勾选框时保留快捷键，只抑制文字编辑',()=>{
    const target=(editor:object|null=null,isContentEditable=false)=>({isContentEditable,closest:()=>editor}) as unknown as EventTarget
    expect(isShortcutInput(null)).toBe(false);expect(isShortcutInput({} as EventTarget)).toBe(false)
    expect(isShortcutInput(target())).toBe(false)
    expect(isShortcutInput(target(null,true))).toBe(true)
    for(const type of ['text','search','number','email','password','time'])expect(isShortcutInput(target({tagName:'INPUT',type}))).toBe(true)
    for(const type of ['range','checkbox','radio','button','submit','color','file'])expect(isShortcutInput(target({tagName:'INPUT',type}))).toBe(false)
    expect(isShortcutInput(target({tagName:'TEXTAREA'}))).toBe(true)
    expect(isShortcutInput(target({tagName:'DIV'}))).toBe(true)
  })
  it('字幕页同时启用播放器，因此跨分组重复按键也会阻止保存',()=>{
    const bindings={...defaultShortcuts,'subtitles.setStart':'Space'}
    expect(validateShortcuts(bindings).map(issue=>issue.id)).toEqual(['subtitles.setStart','player.toggle'])
    expect(shortcutBindingsSchema.safeParse(bindings).success).toBe(false)
    expect(shortcutBindingsSchema.safeParse({...defaultShortcuts,'player.toggle':'Shift+Ctrl+KeyA'}).success).toBe(false)
    expect(shortcutBindingsSchema.safeParse({...defaultShortcuts,'player.toggle':'Ctrl+Ctrl+KeyA'}).success).toBe(false)
    expect(shortcutBindingsSchema.safeParse({...defaultShortcuts,'player.toggle':'Escape'}).success).toBe(false)
    expect(shortcutBindingsSchema.safeParse({...defaultShortcuts,'player.toggle':'KeyA\nrun cmd'}).success).toBe(false)
    expect(shortcutBindingsSchema.safeParse({...defaultShortcuts,unknown:'KeyQ'}).success).toBe(false)
  })
  it('mpv 字符键匹配转换 Shift，按播放场景过滤字幕操作',()=>{
    expect(toMpvKey('Ctrl+KeyZ')).toBe('Ctrl+z');expect(toMpvKey('Ctrl+Shift+KeyZ')).toBe('Ctrl+Z')
    expect(toMpvKey('Shift+ArrowLeft')).toBe('Shift+LEFT');expect(toMpvKey('Shift+Digit3')).toBe('SHARP')
    expect(toMpvKey('Ctrl+Shift+Period')).toBe('Ctrl+>');expect(toMpvKey('Alt+F9')).toBe('Alt+F9')
    const single=mpvShortcutBindings(defaultShortcuts,'single'),subtitles=mpvShortcutBindings(defaultShortcuts,'subtitles')
    expect(single.get('SPACE')).toBe('script-message muxivra-toggle');expect(single.has('q')).toBe(false)
    expect(subtitles.get('q')).toBe('script-message muxivra-set-start');expect(subtitles.get('e')).toBe('script-message muxivra-set-end')
    expect(subtitles.get('Ctrl+Z')).toBe('script-message muxivra-redo')
    const replaced=mpvShortcutBindings({...defaultShortcuts,'player.toggle':'Ctrl+KeyP','player.screenshot':''},'single')
    expect(replaced.has('SPACE')).toBe(false);expect(replaced.has('s')).toBe(false);expect(replaced.get('Ctrl+p')).toBe('script-message muxivra-toggle')
    expect(formatShortcut('Ctrl+Shift+KeyZ')).toBe('Ctrl + Shift + Z');expect(formatShortcut('Space')).toBe('空格');expect(formatShortcut('')).toBe('未设置')
  })
})
