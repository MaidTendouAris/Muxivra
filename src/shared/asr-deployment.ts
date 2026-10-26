import { z } from 'zod'
export const deployableAsrIds=['whisper-large-v3','qwen-0.6b','qwen-1.7b','moss-0.9b'] as const
export const asrDeploymentRequestSchema=z.object({assetId:z.enum(deployableAsrIds),gpuIndex:z.number().int().min(0).max(63).default(0),includeAligner:z.boolean().default(true)}).strict()
export type AsrDeploymentRequest=z.infer<typeof asrDeploymentRequestSchema>
export interface AsrDeploymentPlan {checkedAt:string;assetId:string;gpuIndex:number;profile:CudaProfile;items:{name:string;status:'reuse'|'download';path?:string}[]}
export const asrResourceKinds=['python','dependencies','whisper-runtime'] as const
export const asrResourceRequestSchema=z.object({kind:z.enum(asrResourceKinds),assetId:z.enum(deployableAsrIds).optional(),gpuIndex:z.number().int().min(0).max(63).default(0)}).strict().superRefine((value,context)=>{if(value.kind==='dependencies'&&(!value.assetId||value.assetId==='whisper-large-v3'))context.addIssue({code:'custom',message:'请选择 Qwen 或 MOSS 目标模型'})})
export type AsrResourceRequest=z.infer<typeof asrResourceRequestSchema>
export const asrConfigureModelSchema=z.object({assetId:z.string().min(1).max(100),gpuIndex:z.number().int().min(0).max(63).default(0),includeAligner:z.boolean().default(true)}).strict()
export type AsrConfigureModelRequest=z.infer<typeof asrConfigureModelSchema>
export const asrResourceSchema=z.object({id:z.string().uuid(),kind:z.enum(asrResourceKinds),name:z.string(),path:z.string(),backend:z.enum(['qwen3-asr','moss-transcribe-diarize','whisper.cpp']).optional(),profile:z.enum(['cu126','cu128']).optional(),versions:z.record(z.string(),z.string()),bytes:z.number().nonnegative(),createdAt:z.string(),source:z.enum(['download','import']),ready:z.boolean(),issue:z.string().optional(),runtimeId:z.string().optional()}).strict()
export type AsrResource=z.infer<typeof asrResourceSchema>
export interface NvidiaDevice {index:number;uuid:string;name:string;driver:string;computeMajor:number;computeMinor:number;totalBytes:number;freeBytes:number}
export interface NvidiaDetection {devices:NvidiaDevice[];checkedAt:string;issue?:string}
export interface AsrDeployment {active:boolean;phase:'idle'|'detecting'|'runtime'|'dependencies'|'model'|'verifying'|'completed'|'failed'|'cancelled';assetId?:string;gpuIndex?:number;message:string;logTail:string;modelId?:string;startedAt?:string;finishedAt?:string;logPath?:string}
export type CudaProfile='cu126'|'cu128'
export function nvidiaProfile(device:NvidiaDevice):CudaProfile {
  if(device.computeMajor<7||device.computeMajor===7&&device.computeMinor<5)throw new Error('此型号已停止完整驱动更新，请使用手动兼容配置')
  const profile=device.computeMajor>=10?'cu128':'cu126',required=profile==='cu128'?[572,61]:[560,76],version=device.driver.split('.').map(Number)
  if(!version.length||!version.every(Number.isFinite)||version[0]<required[0]||version[0]===required[0]&&(version[1]??0)<required[1])throw new Error(`请先更新 NVIDIA 官方驱动至 ${required.join('.')} 或更新版本`)
  return profile
}
