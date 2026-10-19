import { z } from 'zod'
import { pythonAsrBackends } from './asr-parameters'
export const asrEnvironmentRequestSchema=z.object({id:z.string().uuid().optional(),name:z.string().trim().min(1).max(100),backend:z.enum(pythonAsrBackends),pythonPath:z.string().min(1).max(4096),sourcePath:z.string().max(4096).optional(),alignerPath:z.string().max(4096).optional(),tokenizerPath:z.string().max(4096).optional()}).strict()
export const asrProbeSchema=z.object({ready:z.boolean(),python:z.string(),platform:z.string(),versions:z.record(z.string(),z.string()),cudaAvailable:z.boolean(),devices:z.array(z.object({name:z.string(),totalBytes:z.number().nonnegative(),freeBytes:z.number().nonnegative()})),issues:z.array(z.string()),warnings:z.array(z.string()),checkedAt:z.string(),vllm:z.boolean().default(false)}).strict()
export const asrEnvironmentSchema=asrEnvironmentRequestSchema.extend({id:z.string().uuid(),probe:asrProbeSchema.optional(),createdAt:z.string(),managed:z.object({version:z.string(),profile:z.enum(['cu126','cu128']),gpuUuid:z.string(),directory:z.string()}).strict().optional()}).strict()
export type AsrEnvironmentRequest=z.infer<typeof asrEnvironmentRequestSchema>
export type AsrEnvironment=z.infer<typeof asrEnvironmentSchema>
export type AsrProbe=z.infer<typeof asrProbeSchema>
export interface PythonCandidate {pythonPath:string;name:string;version:string;prefix:string;isVenv:boolean;sources:string[];packages:Record<string,string>;backends:string[];issue?:string}
export interface PythonDiscovery {active:boolean;candidates:PythonCandidate[];issues:string[];checkedAt?:string}
