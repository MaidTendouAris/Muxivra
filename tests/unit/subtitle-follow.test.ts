import { describe,it,expect } from 'vitest'
import { playingCues } from '../../src/renderer/lib/subtitle-follow'
import { waveformRequestSchema } from '../../src/shared/waveform'
import type { Cue } from '../../src/shared/types'
const cues:Cue[]=[{id:'a',startMs:1000,endMs:2000,text:'a'},{id:'b',startMs:1500,endMs:3000,text:'b'},{id:'c',startMs:0,endMs:5000,text:'comment',comment:true}]
describe('Subtitle playback following',()=>{
  it('uses half-open intervals and excludes comments',()=>{
    expect(playingCues(cues,999)).toEqual([])
    expect(playingCues(cues,1000).map(c=>c.id)).toEqual(['a'])
    expect(playingCues(cues,2000).map(c=>c.id)).toEqual(['b'])
    expect(playingCues(cues,3000)).toEqual([])
  })
  it('selects simultaneous dialogue without reordering the document',()=>{
    expect(playingCues(cues,1750).map(c=>c.id)).toEqual(['a','b'])
    expect(cues.map(c=>c.id)).toEqual(['a','b','c'])
  })
  it('bounds decoded waveform viewports and rejects invalid requests',()=>{
    expect(waveformRequestSchema.parse({})).toEqual({startMs:0,durationMs:15000,width:1000})
    for(const request of [{durationMs:Infinity},{durationMs:360001},{durationMs:249},{startMs:-1},{width:4097},{width:0}])expect(waveformRequestSchema.safeParse(request).success).toBe(false)
  })
})
