import { describe,it,expect } from 'vitest'
import { subtitleTransferOptions,changeSubtitleMode } from '../../src/shared/subtitle-media'
describe('subtitle handoff options',()=>{
  it('keeps the ASS snapshot and copies audio/video into MKV by default',()=>{
    expect(subtitleTransferOptions('snapshot.ass')).toMatchObject({subtitleFile:'snapshot.ass',subtitleMode:'embed',container:'mkv',video:'copy',audio:'copy',subtitles:'none',conflict:'number'})
  })
  it('enables video encoding for burn-in and removes incompatible burn-only options for muxing',()=>{
    const source={...subtitleTransferOptions('snapshot.ass'),container:'webm' as const,advanced:{burnSubtitle:0,subtitleSize:20,subtitleFont:'Arial',start:2},presetId:'test'}
    const embed=changeSubtitleMode(source,'embed')
    expect(embed.container).toBe('mkv');expect(embed.advanced).toEqual({start:2});expect(embed.subtitleFile).toBe('snapshot.ass');expect(embed.presetId).toBeUndefined()
    const burn=changeSubtitleMode({...source,container:'m4a'},'burn')
    expect(burn).toMatchObject({container:'mp4',video:'libx264',audio:'copy',subtitleMode:'burn',advanced:{subtitleSize:20,start:2}})
    expect(burn.advanced?.burnSubtitle).toBeUndefined();expect(source.advanced.burnSubtitle).toBe(0)
  })
})
