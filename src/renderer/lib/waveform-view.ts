export interface WaveformView { startMs:number;durationMs:number }
export interface WaveformSelection { startMs:number;endMs:number }
export const waveformMinimumSpan=250,waveformMaximumSpan=120000,waveformDefaultSpan=15000

export function clampWaveformView(view:WaveformView,totalMs:number):WaveformView {
  const durationMs=Math.max(waveformMinimumSpan,Math.min(waveformMaximumSpan,view.durationMs))
  return {startMs:Math.max(0,Math.min(Math.max(0,totalMs-durationMs),view.startMs)),durationMs}
}

/** Overlapping three-screen buffers keep playback away from an IPC/loading edge. */
export function bufferedWaveformRequest(view:WaveformView,width:number,totalMs:number) {
  const durationMs=Math.max(waveformMinimumSpan,Math.min(360000,Math.max(0,totalMs),view.durationMs*3))
  const startMs=Math.round(Math.max(0,Math.min(Math.max(0,totalMs-durationMs),Math.floor(view.startMs/view.durationMs)*view.durationMs-view.durationMs*.5)))
  return {startMs,durationMs:Math.round(durationMs),width:Math.max(32,Math.min(4096,Math.ceil(width*durationMs/view.durationMs)))}
}

export function waveformPoint(view:WaveformView,x:number,width:number,totalMs:number) {
  return Math.round(Math.max(0,Math.min(totalMs,view.startMs+Math.max(0,Math.min(1,x/Math.max(1,width)))*view.durationMs)))
}

export function waveformSelection(first:number,last:number,totalMs:number):WaveformSelection {
  const limit=Math.max(1,Math.round(totalMs)),startMs=Math.max(0,Math.min(limit-1,Math.round(Math.min(first,last))))
  return {startMs,endMs:Math.max(startMs+1,Math.min(limit,Math.round(Math.max(first,last))))}
}
