import { describe, expect, it } from 'vitest'
import { createSubtitleDocument } from '../../src/shared/subtitles'
import { copyCues, pasteCues, shiftCues, splitCue, mergeCues, replaceSubtitleText, subtitleIssues } from '../../src/renderer/lib/subtitle-editor'
import type { Cue } from '../../src/shared/types'

const cues = (): Cue[] => [
  { id: 'a', startMs: 100, endMs: 1100, text: 'Hello, world', style: 'Signs', layer: 3, name: 'Actor' },
  { id: 'b', startMs: 1500, endMs: 2500, text: 'hello, next', style: 'Default' }
]
describe('ASS 条目批量编辑', () => {
  it('时间偏移只改变选择的边界，无效偏移拒绝且不部分修改', () => {
    const source = cues(), ids = new Set(['b'])
    const shifted = shiftCues(source, ids, 200, 'end')
    expect(shifted[0]).toEqual(source[0]); expect(shifted[1]).toMatchObject({startMs:1500,endMs:2700})
    expect(()=>shiftCues(source,new Set(['a','b']),-200)).toThrow()
    expect(source).toEqual(cues())
  })
  it('复制粘贴保留样式和事件元数据，生成独立ID且不共享编辑对象', () => {
    const source=cues(), copied=copyCues(source,new Set(['a'])), pasted=pasteCues(source,copied,'b')
    expect(pasted.cues[2]).toMatchObject({style:'Signs',layer:3,name:'Actor',text:'Hello, world'})
    expect(new Set(pasted.cues.map(c=>c.id)).size).toBe(3)
    copied[0].text='changed'; expect(source[0].text).toBe('Hello, world'); expect(pasted.cues[2].text).toBe('Hello, world')
  })
  it('拆分保持属性，按播放位置和光标分割，合并保留第一条属性', () => {
    const split=splitCue(cues(),'a',600,6)
    expect(split.cues[0]).toMatchObject({endMs:600,text:'Hello,',layer:3})
    expect(split.cues[1]).toMatchObject({startMs:600,text:'world',style:'Signs'})
    const merged=mergeCues(split.cues,new Set(split.ids))
    expect(merged.cues[0]).toMatchObject({startMs:100,endMs:1100,text:'Hello,\nworld',name:'Actor'})
    expect(merged.cues).toHaveLength(2)
  })
  it('范围替换将搜索符号和替换字符串按文字处理', () => {
    const source=cues(); source[0].text='A [tag] [tag]'; source[1].text='A [tag]'
    const result=replaceSubtitleText(source,'[tag]','$&',new Set(['a']),false)
    expect(result.count).toBe(2);expect(result.cues[0].text).toBe('A $& $&');expect(result.cues[1]).toEqual(source[1])
  })
  it('带覆盖标签的条目不自动切断标签或改变标签范围', () => {
    const source=cues();source[0].text='{\\i1}字幕{\\i0}'
    expect(()=>splitCue(source,'a',600,3)).toThrow('覆盖标签')
    expect(source[0].text).toBe('{\\i1}字幕{\\i0}')
  })
  it('校验保留草稿，区分非法时间、未知样式和正常重叠提示', () => {
    const source=cues();source[1].startMs=500
    const issues=subtitleIssues(createSubtitleDocument({cues:source}))
    expect(issues.some(issue=>issue.row===1&&issue.kind==='error'&&issue.message.includes('样式'))).toBe(true)
    expect(issues.some(issue=>issue.row===2&&issue.kind==='warning'&&issue.message.includes('重叠'))).toBe(true)
    source[1].endMs=400
    expect(subtitleIssues(createSubtitleDocument({cues:source})).some(issue=>issue.message.includes('不合法'))).toBe(true)
    expect(source).toHaveLength(2)
  })
})
