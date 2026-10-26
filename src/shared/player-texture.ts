export interface PlayerTextureFrame {type:'frame';id:number;owner:string;width:number;height:number;handle:Uint8Array}
export interface PlayerTextureSize {width:number;height:number;visible:boolean}
// Bound allocations from viewport/DPI IPC to 4K, preserving the aspect ratio.
export function playerTextureSize(width:number,height:number,scale:number):{width:number;height:number} {
  const w=Math.max(2,width*scale),h=Math.max(2,height*scale),factor=Math.min(1,3840/w,2160/h,Math.sqrt(3840*2160/(w*h)))
  return {width:Math.max(2,Math.round(w*factor)),height:Math.max(2,Math.round(h*factor))}
}
