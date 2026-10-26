import { describe,it,expect } from 'vitest'
import { initialSourceScanState,scanSourceLine,sourceLanguage } from '../../src/renderer/source-editor/language'
const at=(tokens:{startIndex:number;scopes:string}[],index:number)=>tokens.filter(token=>token.startIndex<=index).at(-1)?.scopes
describe('source editor subtitle highlighting',()=>{
  it('uses file extension to recognize ASS/SSA and SubRip without changing content',()=>{expect(sourceLanguage('plaintext','test.SSA')).toBe('muxivra-ass');expect(sourceLanguage('subrip','test.txt')).toBe('muxivra-srt');expect(sourceLanguage('plaintext','readme.txt')).toBe('plaintext')})
  it('tracks custom ASS event format and keeps commas in subtitle text',()=>{
    const section=scanSourceLine('[Events]','ass').state
    const format=scanSourceLine('Format: Start, End, Style, Text','ass',section).state
    const line='Dialogue: 0:01:02.34,0:01:04.56,Default,{\\i1}hello, world\\N第二行'
    const {tokens,state}=scanSourceLine(line,'ass',format)
    expect(state.eventFields).toEqual(['start','end','style','text']);expect(at(tokens,line.indexOf('0:01:02'))).toBe('number');expect(at(tokens,line.indexOf('Default'))).toBe('string');expect(at(tokens,line.indexOf('\\i1'))).toBe('tag');expect(at(tokens,line.indexOf('world'))).toBe('');expect(at(tokens,line.indexOf('\\N'))).toBe('tag');expect(format.eventFields).toEqual(['start','end','style','text'])
  })
  it('recognizes headers, comments, style values and both SubRip time separator variants',()=>{
    expect(at(scanSourceLine('[V4+ Styles]','ass').tokens,2)).toBe('type');expect(at(scanSourceLine('; metadata','ass').tokens,3)).toBe('comment')
    const style='Style: Default,Arial,40,&HFFFFFF&';expect(at(scanSourceLine(style,'ass').tokens,style.indexOf('40'))).toBe('number')
    const line='00:00:01,234 --> 00:00:02.567';const {tokens}=scanSourceLine(line,'srt');expect(at(tokens,3)).toBe('number');expect(at(tokens,line.indexOf('-->'))).toBe('keyword');expect(at(tokens,line.indexOf('02.'))).toBe('number');expect(at(scanSourceLine('12','srt').tokens,0)).toBe('number')
  })
  it('highlights local tags, line breaks and markup without mutating prior scan state',()=>{
    const state=initialSourceScanState(),line='Text <i>hello</i> \\N world';const {tokens}=scanSourceLine(line,'srt',state)
    expect(at(tokens,line.indexOf('<i>'))).toBe('tag');expect(at(tokens,line.indexOf('hello'))).toBe('');expect(at(tokens,line.indexOf('\\N'))).toBe('tag');expect(state).toEqual(initialSourceScanState());expect(tokens.every((token,index)=>!index||tokens[index-1].startIndex<token.startIndex)).toBe(true)
  })
})
