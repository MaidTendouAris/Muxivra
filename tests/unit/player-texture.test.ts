import { describe,expect,it } from 'vitest'
import { playerTextureSize } from '../../src/shared/player-texture'
import { playerRectSchema } from '../../src/shared/player-schema'

describe('composited playback resource limits',()=>{
  it('preserves physical resolution for ordinary previews and caps huge DPI surfaces at 4K',()=>{
    expect(playerTextureSize(640,360,1.5)).toEqual({width:960,height:540})
    for(const [width,height,scale]of [[32768,32768,8],[7680,4320,2],[1080,1920,3],[3840,2160,1]]){
      const size=playerTextureSize(width,height,scale)
      expect(size.width).toBeLessThanOrEqual(3840);expect(size.height).toBeLessThanOrEqual(2160)
      expect(size.width*size.height).toBeLessThanOrEqual(3840*2160)
      expect(Math.abs(size.width/size.height-width/height)).toBeLessThan(.002)
    }
  })
  it('keeps minimized surfaces nonzero and rejects nonfinite or oversized IPC allocations',()=>{
    expect(playerTextureSize(0,0,1)).toEqual({width:2,height:2})
    const rect={x:0,y:0,width:640,height:360,scale:1,active:true,visible:true}
    for(const changes of [{width:Infinity},{height:NaN},{scale:9},{width:65536},{occlusions:[]}])expect(playerRectSchema.safeParse({...rect,...changes}).success).toBe(false)
  })
})
