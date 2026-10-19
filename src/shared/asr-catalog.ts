import { z } from 'zod'
export const officialAsrCatalog = [
  {id:'qwen-0.6b',name:'Qwen3-ASR-0.6B',backend:'qwen3-asr',role:'model',repo:'Qwen/Qwen3-ASR-0.6B',revision:'5eb144179a02acc5e5ba31e748d22b0cf3e303b0',bytes:1880560703},
  {id:'qwen-1.7b',name:'Qwen3-ASR-1.7B',backend:'qwen3-asr',role:'model',repo:'Qwen/Qwen3-ASR-1.7B',revision:'7278e1e70fe206f11671096ffdd38061171dd6e5',bytes:4703055333},
  {id:'qwen-aligner',name:'Qwen3-ForcedAligner-0.6B',backend:'qwen3-asr',role:'aligner',repo:'Qwen/Qwen3-ForcedAligner-0.6B',revision:'c7cbfc2048c462b0d63a45797104fc9db3ad62b7',bytes:1840013484},
  {id:'moss-0.9b',name:'MOSS-Transcribe-Diarize 0.9B',backend:'moss-transcribe-diarize',role:'model',repo:'OpenMOSS-Team/MOSS-Transcribe-Diarize',revision:'704aa4a9c304e8520be88901e0d1960158ef5b15',bytes:1833060519}
] as const
export const asrAssetIdSchema=z.enum(officialAsrCatalog.map(asset=>asset.id) as [string,...string[]])
export const managedAsrAssetSchema=z.object({id:z.string(),name:z.string(),backend:z.string(),role:z.enum(['model','aligner','tokenizer']),path:z.string(),bytes:z.number().nonnegative(),repo:z.string().optional(),revision:z.string().optional(),createdAt:z.string()}).strict()
export type ManagedAsrAsset=z.infer<typeof managedAsrAssetSchema>
export type OfficialAsrAsset=typeof officialAsrCatalog[number]
export const asrAssetDownloadSchema=z.object({id:asrAssetIdSchema}).strict()
