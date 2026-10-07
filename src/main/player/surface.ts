import koffi from 'koffi'
import type { BrowserWindow } from 'electron'
import type { PlayerRect } from '../../shared/player'

const user=koffi.load('user32.dll')
const create=user.func('__stdcall','CreateWindowExW','uintptr_t',['uint32_t','str16','str16','uint32_t','int','int','int','int','uintptr_t','uintptr_t','uintptr_t','void *'])
const position=user.func('bool __stdcall SetWindowPos(uintptr_t window, uintptr_t after, int x, int y, int width, int height, uint32_t flags)')
const show=user.func('bool __stdcall ShowWindow(uintptr_t window, int command)')
const destroy=user.func('bool __stdcall DestroyWindow(uintptr_t window)')
const setRegion=user.func('int __stdcall SetWindowRgn(uintptr_t window, uintptr_t region, bool redraw)')
const gdi=koffi.load('gdi32.dll')
const createRegion=gdi.func('uintptr_t __stdcall CreateRectRgn(int left, int top, int right, int bottom)')
const createRoundRegion=gdi.func('uintptr_t __stdcall CreateRoundRectRgn(int left, int top, int right, int bottom, int ellipseWidth, int ellipseHeight)')
const combineRegion=gdi.func('int __stdcall CombineRgn(uintptr_t destination, uintptr_t first, uintptr_t second, int mode)')
const deleteObject=gdi.func('bool __stdcall DeleteObject(uintptr_t object)')
export class NativePlayerSurface {
  readonly handle:number
  private regionKey=''
  constructor(window:BrowserWindow){
    const parent=Number(window.getNativeWindowHandle().readBigUInt64LE())
    this.handle=Number(create(0,'STATIC','',0x46000000,0,0,1,1,parent,0,0,null))
    if(!this.handle)throw new Error('无法创建 mpv 播放区域')
  }
  update(rect:PlayerRect):void {
    if(!rect.visible||rect.width<2||rect.height<2){this.hide();return}
    const {scale}=rect
    if(!position(this.handle,0,Math.round(rect.x*scale),Math.round(rect.y*scale),Math.round(rect.width*scale),Math.round(rect.height*scale),0x10|0x40))throw new Error('无法调整 mpv 播放区域')
    const width=Math.round(rect.width*scale),height=Math.round(rect.height*scale)
    const originX=Math.round(rect.x*scale),originY=Math.round(rect.y*scale)
    const cuts=(rect.occlusions??[]).map(cut=>({left:Math.round((rect.x+cut.x)*scale)-originX,top:Math.round((rect.y+cut.y)*scale)-originY,right:Math.round((rect.x+cut.x+cut.width)*scale)-originX,bottom:Math.round((rect.y+cut.y+cut.height)*scale)-originY,radius:Math.round((cut.radius??0)*scale)})).filter(cut=>cut.right>0&&cut.left<width&&cut.bottom>0&&cut.top<height&&cut.right>cut.left&&cut.bottom>cut.top)
    const key=JSON.stringify([width,height,cuts]);if(key===this.regionKey)return
    // Keep the native video visible; clip only actual DOM overlays. Windows
    // owns the final region after SetWindowRgn succeeds.
    if(!cuts.length){if(!setRegion(this.handle,0,true))throw new Error('无法恢复 mpv 播放区域');this.regionKey=key;return}
    const region=createRegion(0,0,width,height);if(!region)throw new Error('无法创建播放窗口区域')
    let transferred=false
    try {
      for(const cut of cuts){const exclusion=cut.radius?createRoundRegion(cut.left,cut.top,cut.right+1,cut.bottom+1,cut.radius*2,cut.radius*2):createRegion(cut.left,cut.top,cut.right,cut.bottom);if(!exclusion)throw new Error('无法创建遮挡区域');try {if(!combineRegion(region,region,exclusion,4))throw new Error('无法裁剪播放窗口区域')}finally{deleteObject(exclusion)}}
      if(!setRegion(this.handle,region,true))throw new Error('无法应用播放窗口区域')
      transferred=true;this.regionKey=key
    }finally{if(!transferred)deleteObject(region)}
  }
  hide():void {show(this.handle,0)}
  destroy():void {destroy(this.handle)}
}
