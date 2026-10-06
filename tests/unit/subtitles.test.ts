import { describe, it, expect } from 'vitest'
import { parseSrt, serializeSrt, parseTime, formatTime, offsetCues, validateCues } from '../../src/core/subtitles/srt'
describe('SRT 时间精度与往返',() => {
  it('保留多行 Unicode 文本与整数毫秒',() => {
    const input='\uFEFF1\r\n00:00:00,001 --> 00:00:02,345\r\n你好，世界\r\nSecond line\r\n\r\n2\r\n01:02:03,456 --> 01:02:04,789\r\nAnother cue\r\n'
    const cues=parseSrt(input),roundtrip=parseSrt(serializeSrt(cues))
    expect(roundtrip.map(({id,...cue})=>cue)).toEqual(cues.map(({id,...cue})=>cue))
    expect(cues[0].startMs).toBe(1);expect(cues[1].startMs).toBe(3723456)
  })
  it('偏移可逆且不会累计浮点误差',() => { const cues=parseSrt('1\n00:00:01,001 --> 00:00:02,002\ntext'); expect(offsetCues(offsetCues(cues,137),-137)).toEqual(cues);expect(formatTime(parseTime('00:12:34,567'))).toBe('00:12:34,567') })
  it('拒绝非法时间、负时间偏移和损坏格式',() => { expect(()=>parseTime('00:60:00,000')).toThrow(); expect(()=>parseSrt('1\n00:00:02,000 --> 00:00:01,000\ntext')).toThrow();expect(()=>offsetCues(parseSrt('1\n00:00:00,000 --> 00:00:01,000\ntext'),-1)).toThrow() })
  it('重叠产生提示，不丢弃字幕',() => { const cues=parseSrt('1\n00:00:00,000 --> 00:00:02,000\nA\n\n2\n00:00:01,000 --> 00:00:03,000\nB');expect(validateCues(cues).warnings).toHaveLength(1);expect(parseSrt(serializeSrt(cues))).toHaveLength(2) })
})
