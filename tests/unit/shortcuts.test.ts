import { describe, expect, it } from 'vitest'
import { defaultShortcuts, formatShortcut, matchShortcut, mpvShortcutBindings, resolveShortcuts, shortcutBindingsSchema, shortcutFromEvent, toMpvKey, validateShortcuts } from '../../src/shared/shortcuts'

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
    expect(single.get('SPACE')).toBe('script-message muxivra-toggle');expect(single.has('[')).toBe(false)
    expect(subtitles.get('Ctrl+Z')).toBe('script-message muxivra-redo')
    const replaced=mpvShortcutBindings({...defaultShortcuts,'player.toggle':'Ctrl+KeyP','player.screenshot':''},'single')
    expect(replaced.has('SPACE')).toBe(false);expect(replaced.has('s')).toBe(false);expect(replaced.get('Ctrl+p')).toBe('script-message muxivra-toggle')
    expect(formatShortcut('Ctrl+Shift+KeyZ')).toBe('Ctrl + Shift + Z');expect(formatShortcut('Space')).toBe('空格');expect(formatShortcut('')).toBe('未设置')
  })
})
