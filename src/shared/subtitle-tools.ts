import { z } from 'zod'
import { subtitleStyleSchema } from './schema'
export const qualitySchema=z.object({cps:z.number().min(1).max(200).default(25),lineLength:z.number().int().min(1).max(500).default(42),lines:z.number().int().min(1).max(20).default(2),minDurationMs:z.number().int().min(0).max(60000).default(500),maxDurationMs:z.number().int().min(0).max(600000).default(10000),ignoreWhitespace:z.boolean().default(true),checkOverlaps:z.boolean().default(true)}).strict().refine(value=>value.maxDurationMs>=value.minDurationMs,'Maximum duration must not be less than minimum duration')
export type QualityOptions=z.infer<typeof qualitySchema>
export const subtitleToolsSchema=z.object({version:z.literal(1).default(1),columns:z.array(z.enum(['style','name','layer','margins','effect','duration'])).max(6).refine(values=>new Set(values).size===values.length).default(['style','duration']),leftPercent:z.number().min(40).max(75).default(58),previewPercent:z.number().min(25).max(75).default(55),quality:qualitySchema.default(()=>qualitySchema.parse({})),library:z.array(subtitleStyleSchema).max(1000).default([])}).strict()
export type SubtitleToolsState=z.infer<typeof subtitleToolsSchema>
