import { beforeEach,describe,it,expect } from 'vitest'
import { setUiLanguage } from '../../src/renderer/lib/i18n'
import { formatSubtitleText,subtitlePlainText } from '../../src/renderer/lib/subtitle-format'
describe('ASS quick editing',()=>{
  beforeEach(()=>setUiLanguage('zh-CN',[]))
  it('wraps the selected range without changing adjacent text and unwraps a selected formatted run',()=>{
    const next=formatSubtitleText('A hello Z',{start:2,end:7},'bold');expect(next.text).toBe('A {\\b1}hello{\\b0} Z')
    expect(formatSubtitleText(next.text,next,'bold').text).toBe('A hello Z')
  })
  it('uses UTF-16 ranges, inserts line breaks at the caret, and leaves literal braces alone',()=>{
    expect(formatSubtitleText('🎵日本語',{start:2,end:5},'italic').text).toBe('🎵{\\i1}日本語{\\i0}')
    expect(formatSubtitleText('hello',{start:2,end:2},'newline').text).toBe('he\nllo')
    expect(formatSubtitleText('{literal} {\\b1}hello{\\b0}',{start:0,end:0},'clear').text).toBe('{literal} hello')
  })
  it('converts RGB to ASS BGR, applies cue alignment, and rejects invalid boundaries and values',()=>{
    expect(formatSubtitleText('x',{start:0,end:0},'color','#123456').text).toBe('{\\c&H563412&}x{\\c}')
    expect(formatSubtitleText('{\\an2}x',{start:0,end:0},'align',8).text).toBe('{\\an8}x')
    expect(()=>formatSubtitleText('{\\b1}text',{start:2,end:2},'bold')).not.toThrow()
    expect(()=>formatSubtitleText('{\\b1}text',{start:2,end:3},'bold')).toThrow('标签')
    expect(()=>formatSubtitleText('x',{start:0,end:0},'size',NaN)).toThrow()
    expect(subtitlePlainText('{\\i1}Hello\\N世界\\h!{\\i0}')).toBe('Hello\n世界\u00a0!')
  })
})
