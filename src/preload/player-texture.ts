import { ipcRenderer,sharedTexture } from 'electron'

const surfaces=new Map<string,WeakRef<HTMLCanvasElement>>()
ipcRenderer.on('muxivra:player-surface-clear',(_event,owner:string)=>{
  const canvas=surfaces.get(owner)?.deref()
  if(canvas){canvas.width=2;canvas.height=2;delete canvas.dataset.presentedFrames}
  surfaces.delete(owner)
})

// Keep native handles and VideoFrames out of the renderer's contextBridge API.
// Only this isolated preload paints to the application's ordinary DOM canvas.
sharedTexture.setSharedTextureReceiver(async({importedSharedTexture},metadata:{owner:string;width:number;height:number})=>{
  let frame:VideoFrame|undefined
  try {
    if(!['single','audio','subtitles'].includes(metadata.owner))return
    const canvas=document.querySelector<HTMLCanvasElement>(`canvas[data-mpv-surface="${metadata.owner}"]`)
    if(!canvas)return
    surfaces.set(metadata.owner,new WeakRef(canvas))
    frame=importedSharedTexture.getVideoFrame()
    if(canvas.width!==metadata.width||canvas.height!==metadata.height){canvas.width=metadata.width;canvas.height=metadata.height}
    canvas.getContext('2d',{alpha:false})?.drawImage(frame,0,0)
    canvas.dataset.presentedFrames=String((Number(canvas.dataset.presentedFrames)||0)+1)
  }finally{frame?.close();importedSharedTexture.release()}
})
