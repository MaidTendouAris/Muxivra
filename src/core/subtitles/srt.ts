import { randomUUID } from 'node:crypto'
import type { Cue } from '../../shared/types'

export function parseTime(value: string): number {
  const match = /^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(value.trim())
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) throw new Error(`时间格式无效：${value}，请使用 HH:MM:SS,mmm`)
  const result = ((Number(match[1])*60+Number(match[2]))*60+Number(match[3]))*1000+Number(match[4])
  if (!Number.isSafeInteger(result) || result > 359999999) throw new Error('字幕时间超出范围')
  return result
}
export function formatTime(ms: number): string {
  const value = Math.max(0,Math.round(ms))
  return `${String(Math.floor(value/3600000)).padStart(2,'0')}:${String(Math.floor(value/60000)%60).padStart(2,'0')}:${String(Math.floor(value/1000)%60).padStart(2,'0')},${String(value%1000).padStart(3,'0')}`
}
export function validateCues(cues: Cue[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [], ids = new Set<string>()
  cues.forEach((cue,index) => {
    if (ids.has(cue.id)) errors.push(`第 ${index+1} 条标识重复`); ids.add(cue.id)
    if (![cue.startMs,cue.endMs].every(v => Number.isInteger(v) && v >= 0 && v <= 359999999) || cue.endMs <= cue.startMs) errors.push(`第 ${index+1} 条结束时间必须晚于开始时间`)
    if (!cue.text.trim()) warnings.push(`第 ${index+1} 条文本为空`)
    if (/\n\s*\n/.test(cue.text)) errors.push(`第 ${index+1} 条文本含空行，SRT 条目内不能有空白分隔行`)
    if (index && cue.startMs < cues[index-1].endMs) warnings.push(`第 ${index+1} 条与上一条重叠或顺序不正确`)
  })
  return { errors, warnings }
}
export function parseSrt(text: string): Cue[] {
  const normalized = text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trim()
  if (!normalized) return []
  const cues = normalized.split(/\n\s*\n/).map((block,index) => {
    const lines = block.split('\n')
    if (/^\d+$/.test(lines[0])) lines.shift()
    const match = /^(\d{2,}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2,}:\d{2}:\d{2}[,.]\d{3})\s*$/.exec(lines.shift() ?? '')
    if (!match) throw new Error(`第 ${index+1} 条字幕格式无效`)
    return { id: randomUUID(), startMs: parseTime(match[1]), endMs: parseTime(match[2]), text: lines.join('\n') }
  })
  const result = validateCues(cues)
  if (result.errors.length) throw new Error(result.errors.join('\n'))
  return cues
}
export function serializeSrt(cues: Cue[]): string {
  const result = validateCues(cues)
  if (result.errors.length) throw new Error(result.errors.join('\n'))
  return cues.map((cue,index) => `${index+1}\r\n${formatTime(cue.startMs)} --> ${formatTime(cue.endMs)}\r\n${cue.text.replace(/\r\n?/g,'\n').replace(/\n/g,'\r\n')}`).join('\r\n\r\n')+'\r\n'
}
export function offsetCues(cues: Cue[], offset: number): Cue[] {
  if (!Number.isSafeInteger(offset)) throw new Error('偏移量必须为整数毫秒')
  const changed = cues.map(cue => ({ ...cue, startMs: cue.startMs+offset, endMs: cue.endMs+offset }))
  const result = validateCues(changed)
  if (result.errors.length) throw new Error('偏移后时间超出范围或不合法')
  return changed
}
