import { describe,expect,it } from 'vitest'
import { bufferedWaveformRequest,clampWaveformView,waveformPoint,waveformSelection } from '../../src/renderer/lib/waveform-view'

describe('waveform viewport and mouse time mapping',()=>{
  it('keeps continuous submillisecond scrolling instead of rounding to pages',()=>{
    expect(clampWaveformView({startMs:1234.56,durationMs:15000},60000)).toEqual({startMs:1234.56,durationMs:15000})
    expect(clampWaveformView({startMs:-1,durationMs:15000},60000).startMs).toBe(0)
    expect(clampWaveformView({startMs:59999,durationMs:15000},60000).startMs).toBe(45000)
  })
  it('uses overlapping buffers while preserving visible waveform resolution',()=>{
    const first=bufferedWaveformRequest({startMs:0,durationMs:15000},1000,120000)
    const next=bufferedWaveformRequest({startMs:15001,durationMs:15000},1000,120000)
    const later=bufferedWaveformRequest({startMs:30001,durationMs:15000},1000,120000)
    expect(first).toEqual({startMs:0,durationMs:45000,width:3000})
    expect(next).toEqual({startMs:7500,durationMs:45000,width:3000})
    expect(later).toEqual({startMs:22500,durationMs:45000,width:3000})
    // The old buffer still covers the entire screen while the next one loads.
    expect(first.startMs+first.durationMs).toBeGreaterThan(15001+15000)
    expect(next.startMs+next.durationMs).toBeGreaterThan(30001+15000)
    expect(bufferedWaveformRequest({startMs:500000,durationMs:120000},2000,900000).durationMs).toBe(360000)
  })
  it('maps click/drag positions through a panned, zoomed viewport',()=>{
    expect(waveformPoint({startMs:1234,durationMs:8000},250,1000,20000)).toBe(3234)
    expect(waveformPoint({startMs:1234,durationMs:8000},-40,1000,20000)).toBe(1234)
    expect(waveformPoint({startMs:16000,durationMs:8000},1000,1000,20000)).toBe(20000)
  })
  it('normalizes reverse selections and keeps a valid nonempty interval at media edges',()=>{
    expect(waveformSelection(5000,2000,20000)).toEqual({startMs:2000,endMs:5000})
    expect(waveformSelection(20000,20000,20000)).toEqual({startMs:19999,endMs:20000})
    expect(waveformSelection(-30,-20,20000)).toEqual({startMs:0,endMs:1})
    expect(waveformSelection(1000.4,2000.6,20000)).toEqual({startMs:1000,endMs:2001})
  })
})
