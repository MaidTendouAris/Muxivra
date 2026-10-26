import { describe,it,expect } from 'vitest'
import { hexToHsv,hexToRgb,hsvToHex,normalizeHex,rgbToHex } from '../../src/renderer/lib/color'
describe('custom color conversion',()=>{
  it('normalizes only complete RGB colors and rejects malformed input',()=>{expect(normalizeHex(' 12aBcD ')).toBe('#12ABCD');for(const value of ['#123','rgb(1,2,3)','#1234567','invalid'])expect(normalizeHex(value)).toBeUndefined();expect(()=>hexToRgb('bad')).toThrow()})
  it('preserves exact 8-bit colors through HSV including grey and hue edges',()=>{for(const value of ['#000000','#FFFFFF','#FF0000','#00FF00','#0000FF','#808080','#123456','#AB02ED','#FE01FE'])expect(hsvToHex(hexToHsv(value))).toBe(value);expect(hsvToHex({h:360,s:1,v:1})).toBe('#FF0000');expect(hsvToHex({h:-120,s:1,v:1})).toBe('#0000FF')})
  it('bounds channel values and produces canonical HEX',()=>{expect(rgbToHex(-1,999,127.8)).toBe('#00FF80');expect(hexToRgb('#127AFF')).toEqual([18,122,255]);expect(hsvToHex({h:60,s:2,v:2})).toBe('#FFFF00')})
})
