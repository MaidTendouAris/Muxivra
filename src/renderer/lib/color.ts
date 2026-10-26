export interface HsvColor { h:number;s:number;v:number }
export const colorClamp=(value:number,min=0,max=1)=>Math.max(min,Math.min(max,value))
export function normalizeHex(value:string){const match=/^#?([\da-f]{6})$/i.exec(value.trim());return match?'#'+match[1].toUpperCase():undefined}
export function hexToRgb(value:string):[number,number,number]{const hex=normalizeHex(value);if(!hex)throw new Error('Invalid RGB color');return [1,3,5].map(index=>parseInt(hex.slice(index,index+2),16)) as [number,number,number]}
export function rgbToHex(r:number,g:number,b:number){return '#'+[r,g,b].map(value=>Math.round(colorClamp(value,0,255)).toString(16).padStart(2,'0')).join('').toUpperCase()}
export function hexToHsv(value:string):HsvColor{
  const [r,g,b]=hexToRgb(value).map(value=>value/255),maximum=Math.max(r,g,b),minimum=Math.min(r,g,b),delta=maximum-minimum
  const hue=delta===0?0:maximum===r?((g-b)/delta+6)%6:maximum===g?(b-r)/delta+2:(r-g)/delta+4
  return {h:hue*60,s:maximum?delta/maximum:0,v:maximum}
}
export function hsvToHex({h,s,v}:HsvColor){
  const hue=((h%360)+360)%360/60,saturation=colorClamp(s),value=colorClamp(v),chroma=value*saturation,x=chroma*(1-Math.abs(hue%2-1)),m=value-chroma
  const channels=hue<1?[chroma,x,0]:hue<2?[x,chroma,0]:hue<3?[0,chroma,x]:hue<4?[0,x,chroma]:hue<5?[x,0,chroma]:[chroma,0,x]
  return rgbToHex(...channels.map(channel=>(channel+m)*255) as [number,number,number])
}
