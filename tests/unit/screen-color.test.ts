import { afterEach,describe,expect,it,vi } from 'vitest'
import { pickScreenColor,supportsScreenColor } from '../../src/renderer/lib/screen-color'

afterEach(()=>vi.unstubAllGlobals())
describe('explicit screen color sampling',()=>{
  it('reports unavailable APIs and refuses to synthesize a color',async()=>{
    vi.stubGlobal('EyeDropper',undefined)
    expect(supportsScreenColor()).toBe(false)
    await expect(pickScreenColor()).rejects.toThrow('unavailable')
  })
  it('opens synchronously from the trusted button and returns only a normalized pixel',async()=>{
    const open=vi.fn().mockResolvedValue({sRGBHex:'#13a5cf'})
    vi.stubGlobal('EyeDropper',class {open=open})
    expect(supportsScreenColor()).toBe(true)
    const pending=pickScreenColor()
    expect(open).toHaveBeenCalledOnce()
    await expect(pending).resolves.toBe('#13A5CF')
  })
  it('keeps cancellation local and ignores a color resolved after closing the picker',async()=>{
    const before=new AbortController();before.abort();const open=vi.fn()
    vi.stubGlobal('EyeDropper',class {open=open})
    await expect(pickScreenColor(before.signal)).resolves.toBeUndefined()
    expect(open).not.toHaveBeenCalled()
    const controller=new AbortController();let resolve!:(result:{sRGBHex:string})=>void
    open.mockReturnValue(new Promise(done=>{resolve=done}))
    const pending=pickScreenColor(controller.signal)
    expect(open).toHaveBeenCalledWith({signal:controller.signal})
    controller.abort();resolve({sRGBHex:'#ffffff'})
    await expect(pending).resolves.toBeUndefined()
    open.mockRejectedValue(Object.assign(new Error('Cancelled'),{name:'AbortError'}))
    await expect(pickScreenColor()).resolves.toBeUndefined()
  })
  it('rejects invalid results and preserves actual permission errors',async()=>{
    const open=vi.fn().mockResolvedValue({sRGBHex:'transparent'})
    vi.stubGlobal('EyeDropper',class {open=open})
    await expect(pickScreenColor()).rejects.toThrow('invalid color')
    const error=Object.assign(new Error('User activation missing'),{name:'NotAllowedError'})
    open.mockRejectedValue(error)
    await expect(pickScreenColor()).rejects.toBe(error)
  })
})
