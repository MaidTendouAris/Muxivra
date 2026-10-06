import { spawn } from 'node:child_process'
import type { Engine, MediaInfo } from '../../shared/types'
import { inputFormatWhitelist } from '../../shared/media-policy'

export async function makeWaveform(engine: Engine, media: MediaInfo, signal?: AbortSignal): Promise<number[]> {
  if (!media.streams.some(s => s.type === 'audio')) return []
  return new Promise((resolve,reject) => {
    const bins = new Array<number>(2000).fill(0)
    const durationSamples = Math.max(1,Math.ceil(media.durationMs/1000*2000))
    const child = spawn(engine.ffmpegPath,['-v','error','-nostdin','-protocol_whitelist','file,pipe','-format_whitelist',inputFormatWhitelist,'-i',media.path,'-map','0:a:0','-vn','-ac','1','-ar','2000','-f','s16le','pipe:1'],{ shell: false, windowsHide: true, stdio: ['ignore','pipe','pipe'] })
    let samples = 0, leftover = Buffer.alloc(0), errorText = '', failure: Error | undefined
    const fail = () => { failure = new Error('波形生成已取消或超时'); child.kill() }
    const timeout = setTimeout(fail,300000)
    if (signal?.aborted) fail()
    signal?.addEventListener('abort',fail,{ once: true })
    child.stdout.on('data',(chunk: Buffer) => {
      const data = Buffer.concat([leftover,chunk])
      for (let i = 0; i+1 < data.length; i += 2) { const bin = Math.min(1999,Math.floor(samples++/durationSamples*2000)); bins[bin] = Math.max(bins[bin],Math.abs(data.readInt16LE(i))/32768) }
      leftover = data.subarray(data.length-data.length%2)
    })
    child.stderr.on('data',(chunk: Buffer) => { errorText = (errorText+chunk.toString()).slice(-4000) })
    child.on('error',error => { failure = error })
    child.on('close',code => { clearTimeout(timeout); signal?.removeEventListener('abort',fail); if (failure || code !== 0) reject(failure ?? new Error(errorText)); else resolve(bins) })
  })
}
