import { z } from 'zod'
export interface MediaProject {
  id:string; name:string; folder:string; directory:string; mediaPath:string; subtitlePath:string
  subtitles:{id:string;name:string;path:string}[]; activeSubtitleId:string
  sourceName:string; mediaBytes:number; createdAt:string; updatedAt:string; archived?:boolean
}
export interface ProjectImportProgress { active:boolean; name:string; phase:string; percent:number; transferred:number; total:number }
export interface ProjectsState { root:string; activeId?:string; items:MediaProject[]; import:ProjectImportProgress; error?:string }
export interface ProjectImportResult { project:MediaProject; document:import('./subtitles').SubtitleDocument; warning?:string }
export const projectImportSchema=z.object({
  path:z.string().min(1).max(32760),deleteOriginal:z.boolean().default(false),
  name:z.string().trim().min(1).max(150).optional(),subtitlePath:z.string().min(1).max(32760).optional(),
  resolutionMode:z.enum(['auto','subtitle','custom']).default('auto'),
  resolution:z.object({width:z.number().int().min(1).max(16384),height:z.number().int().min(1).max(16384)}).optional(),
  exportFormat:z.enum(['ass','ssa','srt']).default('ass')
}).strict().refine(value=>value.resolutionMode!=='custom'||!!value.resolution,'请填写字幕画面宽度和高度').refine(value=>value.resolutionMode!=='subtitle'||!!value.subtitlePath,'请先选择初始字幕')
export type ProjectImportRequest=z.input<typeof projectImportSchema>
export const projectVideoExportSchema=z.object({mode:z.enum(['burn','embed']),container:z.enum(['mp4','mkv']),video:z.string().min(1).max(80).default('libx264'),audio:z.enum(['copy','aac']).default('copy'),quality:z.number().int().min(0).max(63).default(22),speed:z.enum(['fast','medium','slow']).default('medium')}).strict()
export type ProjectVideoExport=z.infer<typeof projectVideoExportSchema>
