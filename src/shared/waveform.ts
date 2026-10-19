import { z } from 'zod'

export const waveformRequestSchema = z.object({
  startMs: z.number().finite().min(0).max(359999999).default(0),
  durationMs: z.number().finite().min(250).max(120000).default(15000),
  width: z.number().int().min(32).max(4096).default(1000)
})
export type WaveformRequest = z.infer<typeof waveformRequestSchema>
export interface WaveformWindow extends WaveformRequest {
  sampleRate: number
  channels: number
  hasAudio: boolean
  minimum: number[]
  maximum: number[]
  rms: number[]
}
