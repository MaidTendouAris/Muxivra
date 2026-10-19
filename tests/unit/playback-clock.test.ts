import { describe,it,expect } from 'vitest'
import { PlaybackClock } from '../../src/renderer/lib/playback-clock'
describe('Display playback clock',()=>{
  it('moves between actual reports and eases small corrections without a jump',()=>{
    const clock=new PlaybackClock();clock.sample(1000,0,true,1)
    expect(clock.position(50)).toBe(1050);clock.sample(1080,100,true,1)
    expect(clock.position(100)).toBe(1100);expect(clock.position(150)).toBe(1140);expect(clock.position(200)).toBe(1180)
  })
  it('freezes exactly at pause and snaps to seek/loop/frame changes',()=>{
    const clock=new PlaybackClock();clock.sample(1000,0,true,1);clock.sample(1100,100,false,1)
    expect(clock.position(500)).toBe(1100);clock.sample(1050,600,false,1);expect(clock.position(600)).toBe(1050)
    clock.sample(20000,700,true,1);expect(clock.position(700)).toBe(20000)
    clock.sample(20100,750,true,1,true);expect(clock.position(750)).toBe(20100)
  })
  it('honors speed and bounds extrapolation when reporting stops',()=>{
    const clock=new PlaybackClock();clock.sample(0,0,true,2);expect(clock.position(100)).toBe(200);expect(clock.position(2000)).toBe(500)
    clock.sample(0,50,true,2);expect(clock.position(100)).toBe(200)
    clock.sample(600,300,true,.5);expect(clock.position(400)).toBe(650)
  })
})
