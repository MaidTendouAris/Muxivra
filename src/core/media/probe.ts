import { basename } from 'node:path'
import { stat } from 'node:fs/promises'
import type { Engine, MediaInfo } from '../../shared/types'
import { run } from '../engine/process'
import { canonicalInput } from './paths'
import { inputFormatWhitelist } from '../../shared/media-policy'
export async function inspectMedia(engine: Engine, input: string): Promise<MediaInfo> {
  const path = await canonicalInput(input)
  const text = await run(engine.ffprobePath, ['-v','error','-protocol_whitelist','file,pipe','-format_whitelist',inputFormatWhitelist,'-show_format','-show_streams','-of','json',path])
  const data = JSON.parse(text)
  const durationMs = Math.round(Number(data.format?.duration ?? 0) * 1000)
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error('媒体时长无效')
  return { path, name: basename(path), durationMs, size: (await stat(path)).size, format: String(data.format?.format_name ?? ''),
    streams: (data.streams ?? []).map((stream: Record<string, any>) => ({ index: stream.index, type: stream.codec_type ?? 'unknown', codec: stream.codec_name ?? 'unknown',
      language: stream.tags?.language, title: stream.tags?.title, width: stream.width, height: stream.height, frameRate: stream.avg_frame_rate,
      sampleRate: stream.sample_rate ? Number(stream.sample_rate) : undefined, channels: stream.channels })) }
}
