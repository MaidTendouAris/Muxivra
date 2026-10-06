import { z } from 'zod'
import { parameters, filterLibrary, internalEncoderParameters, type ParameterValue } from './parameters'

const advancedShape:Record<string,z.ZodType> = {}
for (const p of parameters) {
  advancedShape[p.key] = (p.type === 'number' ? (p.integer ? z.number().int() : z.number()).min(p.min!).max(p.max!) : p.type === 'select' ? z.enum(p.choices as [string,...string[]]) : z.string().max(200).regex(/^[a-zA-Z0-9_ .+\-\/]*$/)).optional()
}
advancedShape.subtitleFont=z.string().min(1).max(100).regex(/^[^\x00-\x1f,:;=\[\]'\\/]+$/).optional()
for(const key of ['subtitleColor','subtitleOutlineColor','subtitleBackColor'])advancedShape[key]=z.string().regex(/^#[a-fA-F0-9]{6}$/).optional()
export const advancedSchema = z.object(advancedShape).strict() as z.ZodType<Record<string,ParameterValue>>
export const safeOptionValue = z.string().min(1).max(500).regex(/^[a-zA-Z0-9_ .+*/()=<>!,|:\-]+$/,'参数值包含不支持的字符')
export const encoderSettingSchema = z.object({scope:z.enum(['video','audio']),name:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),value:safeOptionValue}).strict()
export const filterSettingSchema = z.object({id:z.string().min(1).max(128),name:z.enum(filterLibrary.map(f=>f.name) as [string,...string[]]),enabled:z.boolean(),options:z.record(z.string().regex(/^[a-zA-Z0-9_]{1,80}$/),safeOptionValue).refine(v=>Object.keys(v).length<=120)}).strict()

export const optionsSchema = z.object({
  container: z.enum(['mp4','mkv','mov','m4a','mp3','wav','flac','srt','webm','avi','ts','ogg','opus','gif','png','jpg','webp']),
  video: z.string().regex(/^[a-zA-Z0-9_]{1,80}$/),
  audio: z.string().regex(/^[a-zA-Z0-9_]{1,80}$/),
  quality: z.number().min(0).max(63), speed: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  audioBitrate: z.number().int().min(8).max(1536), maxHeight: z.number().int().min(144).max(16384).optional(),
  streamIndices: z.array(z.number().int().min(0).max(1024)).max(64).optional(),
  subtitles: z.enum(['copy','none']), conflict: z.enum(['reject','number']), presetId: z.string().max(128).optional(),
  advanced:advancedSchema.optional(),filters:z.array(filterSettingSchema).max(64).optional(),encoderOptions:z.array(encoderSettingSchema).max(120).optional(),
  metadata:z.array(z.object({key:z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/),value:z.string().max(2000).refine(v=>!/[\x00-\x1f]/.test(v))}).strict()).max(64).optional(),
  subtitleFile:z.string().min(1).max(32760).refine(v=>!/[\x00-\x1f]/.test(v)).optional(),
  codecParameters:z.record(z.string().refine(k=>internalEncoderParameters.some(p=>p.key===k),'未知编码器内部参数'),safeOptionValue).optional()
}).strict()
export const pathSchema = z.string().min(1).max(32760).refine(v => !/[\x00-\x1f]/.test(v), '路径包含控制字符')
export const requestSchema = z.object({ inputPath: pathSchema, outputPath: pathSchema, options: optionsSchema }).strict()
export const cueSchema = z.object({ id: z.string().min(1).max(128), startMs: z.number().int().min(0).max(359999999), endMs: z.number().int().min(0).max(359999999), text: z.string().max(10000) }).strict()
export const subtitleSchema = z.object({ id: z.string().min(1).max(128), sourcePath: pathSchema.optional(), cues: z.array(cueSchema).max(100000) }).strict()
export const presetSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), name: z.string().min(1).max(80), description: z.string().max(500), options: optionsSchema }).strict()
export const presetFileSchema = z.object({format:z.literal('muxivra-presets'),version:z.literal(1),presets:z.array(presetSchema).min(1).max(200)}).strict()
export const settingsSchema = z.object({
  theme: z.enum(['dark','light','system']), concurrency: z.number().int().min(1).max(4),
  mcp: z.object({ enabled: z.boolean(), port: z.number().int().min(1024).max(65535), token: z.string().regex(/^[a-f0-9]{64}$/),
    inputRoots: z.array(pathSchema).max(32), outputRoots: z.array(pathSchema).max(32),
    allowInspect: z.boolean(), allowSubmit: z.boolean(), allowCancel: z.boolean()
  }).strict()
}).strict()
