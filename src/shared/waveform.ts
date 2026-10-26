import { z } from 'zod'

export const waveformRequestSchema = z.object({
  streamIndex:z.union([z.number().int().min(0).max(1024),z.literal('no')]).optional(),
  startMs: z.number().finite().min(0).max(359999999).default(0),
  durationMs: z.number().finite().min(250).max(360000).default(15000),
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

export const waveformWindowSchema=waveformRequestSchema.extend({sampleRate:z.number().int().positive(),channels:z.number().int().min(1).max(8),hasAudio:z.boolean(),minimum:z.array(z.number().min(-1).max(1)).max(4096),maximum:z.array(z.number().min(-1).max(1)).max(4096),rms:z.array(z.number().min(0).max(1)).max(4096)}).refine(value=>value.minimum.length===value.maximum.length&&value.rms.length===value.maximum.length&&(!value.hasAudio||value.maximum.length===0||value.maximum.length===value.width))
