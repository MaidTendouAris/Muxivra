import { z } from 'zod'
import type { Engine, MediaInfo } from './types'
import type { Cue } from './subtitles'
import { asrEnvironmentSchema,type AsrEnvironment } from './asr-environments'
import { pythonAsrBackends } from './asr-parameters'
import type { ManagedAsrAsset } from './asr-catalog'
import type { PythonDiscovery } from './asr-environments'
import type { AsrDeployment,NvidiaDetection } from './asr-deployment'

export const asrBackends = ['whisper.cpp', 'custom',...pythonAsrBackends] as const
const recognitionFields={
  language:z.string().regex(/^(auto|[a-z]{2,3}(?:-[A-Za-z]{2,8})?)$/).default('auto'),device:z.enum(['auto','cpu','gpu']).default('auto'),threads:z.number().int().min(1).max(64).default(4),
  chunkingEnabled:z.boolean().default(false),chunkSeconds:z.number().int().min(1).max(359999).default(120),beamSize:z.number().int().min(1).max(20).default(5),initialPrompt:z.string().max(4000).default(''),estimateUntimed:z.boolean().default(false),
  parameters:z.record(z.string(),z.union([z.string().max(1000),z.number().finite(),z.boolean()])).refine(value=>Object.keys(value).length<=80).optional()
}
export const asrRecognitionSchema=z.object(recognitionFields).strict()
export type AsrRecognition=z.infer<typeof asrRecognitionSchema>
export const asrModelSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(200), backend: z.enum(asrBackends),
  modelPath: z.string().min(1).max(4096), executable: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(100).default([]), sampleRate: z.number().int().min(8000).max(192000).default(16000),
  channels: z.union([z.literal(1),z.literal(2)]).default(1), importedAt: z.string(),
  size: z.number().nonnegative().optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  availability: z.enum(['ready','missing']).default('ready'), issue: z.string().optional(),environmentId:z.string().uuid().optional(),environment:asrEnvironmentSchema.optional(),recognition:asrRecognitionSchema.optional()
  ,storageRoot:z.string().optional(),nvidiaDeviceUuid:z.string().optional()
}).strict()
export type AsrModel = z.infer<typeof asrModelSchema>
export const customAsrManifestSchema = z.object({
  format: z.literal('muxivra-asr-backend'), version: z.literal(1), name: z.string().trim().min(1).max(200),
  executable: z.string().min(1).max(4096), args: z.array(z.string().max(4096)).max(100).default([]),
  modelPath: z.string().min(1).max(4096), sampleRate: z.number().int().min(8000).max(192000).default(16000),
  channels: z.union([z.literal(1),z.literal(2)]).default(1)
}).strict()
export const asrOptionsSchema = z.object({
  ...recognitionFields,
  modelId: z.string().uuid(), inputPath: z.string().min(1).max(4096), audioStream: z.number().int().min(0),
  language: z.string().regex(/^(auto|[a-z]{2,3}(?:-[A-Za-z]{2,8})?)$/).default('auto'),
  device: z.enum(['auto','cpu','gpu']).default('auto'), threads: z.number().int().min(1).max(64).default(4),
  chunkingEnabled: z.boolean().default(false), chunkSeconds: z.number().int().min(1).max(359999).default(120), beamSize: z.number().int().min(1).max(20).default(5),
  initialPrompt: z.string().max(4000).default(''), startMs: z.number().int().min(0).max(359999999).default(0),
  endMs: z.number().int().min(1).max(359999999).optional(), estimateUntimed: z.boolean().default(false)
}).strict()
export type AsrOptions = z.infer<typeof asrOptionsSchema>
// Persisted pre-0.14.2 plans used mandatory chunks. Keep their submitted plan;
// new submissions (including retries) receive the schema's whole-audio default.
export function asrUsesChunks(options:Pick<AsrOptions,'chunkingEnabled'>):boolean{return options.chunkingEnabled??true}
export function asrModeLabel(options:Pick<AsrOptions,'chunkingEnabled'|'chunkSeconds'>):string{return asrUsesChunks(options)?`兼容分片 · ${options.chunkSeconds} 秒`:'整段识别'}
const timedText = z.object({text:z.string().max(10000),startMs:z.number().finite().min(0).max(359999999).optional(),endMs:z.number().finite().min(0).max(359999999).optional(),score:z.number().finite().optional(),speaker:z.string().max(200).optional()})
const validTimes=(s:{startMs?:number;endMs?:number},ctx:z.RefinementCtx)=>{
  if((s.startMs===undefined)!==(s.endMs===undefined)||s.startMs!==undefined&&s.endMs!<=s.startMs)ctx.addIssue({code:'custom',message:'时间必须成对提供，且结束时间晚于开始时间'})
}
export const asrSegmentSchema = timedText.extend({words:z.array(timedText.superRefine(validTimes)).max(10000).optional(),estimated:z.boolean().optional()}).superRefine(validTimes)
export const asrOutputSchema = z.object({language:z.string().max(100).optional(),segments:z.array(asrSegmentSchema).max(100000)}).passthrough()
export type AsrSegment = z.infer<typeof asrSegmentSchema>
export function asrSubtitleCues(segments:AsrSegment[],createId:()=>string):Cue[]{
  return segments.map(s=>s.startMs===undefined
    ?{id:createId(),text:s.text,startMs:0,endMs:0,comment:true,name:[s.speaker,'ASR 未打轴'].filter(Boolean).join(' · ')}
    :{id:createId(),text:s.text,startMs:s.startMs,endMs:s.endMs!,...(s.estimated||s.speaker?{name:[s.speaker,s.estimated?'ASR 估算':undefined].filter(Boolean).join(' · ')}:{})})
}
export interface AsrResult {
  format:'muxivra-asr-result';version:1;jobId:string;inputPath:string;model:AsrModel;options:AsrOptions;
  language?:string;segments:AsrSegment[];createdAt:string;rawFiles:string[]
}
export interface AsrPlan {
  projectId?:string
  kind:'asr';input:MediaInfo;outputPath:string;engine:Engine;args:string[];warnings:string[];durationMs:number;
  options?:never;asr:{model:AsrModel;options:AsrOptions}
}
export interface AsrDownload {
  active:boolean;phase:'idle'|'preparing'|'copying'|'downloading'|'verifying'|'extracting'|'completed'|'failed'|'cancelled';
  label:string;percent:number;received:number;total:number;message:string
}
export interface AsrState { models:AsrModel[];runtimes:{id:string;name:string;executable:string}[];download:AsrDownload;environments?:AsrEnvironment[];storageRoot?:string;adapterPath?:string;assets?:ManagedAsrAsset[];discovery?:PythonDiscovery;deployment?:AsrDeployment;nvidia?:NvidiaDetection }
export interface AsrImportRequest {name:string;backend:typeof asrBackends[number];modelPath:string;executable?:string;environmentId?:string}

// Backend timestamps refer to decoded chunk audio. Only the adapter maps them
// back to the original media; consumers never infer offsets from displayed text.
export function mapAsrSegments(output:unknown,offsetMs:number,durationMs:number,estimateUntimed=false):AsrSegment[] {
  const parsed=asrOutputSchema.parse(output)
  return parsed.segments.flatMap(segment=>{
    const text=segment.text.trim();if(!text)return []
    const words=segment.words?.flatMap(word=>{
      if(word.startMs===undefined)return [word]
      const startMs=Math.round(Math.min(durationMs,word.startMs)),endMs=Math.round(Math.min(durationMs,word.endMs!))
      return endMs>startMs?[{...word,startMs:offsetMs+startMs,endMs:offsetMs+endMs}]:[]
    })
    if(segment.startMs===undefined)return [{...segment,text,...(words?{words}:{}),...(estimateUntimed?{startMs:offsetMs,endMs:offsetMs+durationMs,estimated:true}:{})}]
    const startMs=Math.round(Math.min(durationMs,segment.startMs)),endMs=Math.round(Math.min(durationMs,segment.endMs!))
    if(endMs<=startMs)return []
    return [{...segment,text,startMs:offsetMs+startMs,endMs:offsetMs+endMs,words}]
  })
}

export function whisperOutput(raw:unknown):{language?:string;segments:AsrSegment[]} {
  const offsets=z.object({from:z.number().finite(),to:z.number().finite()})
  const token=z.object({text:z.string(),id:z.number().int().optional(),offsets:offsets.optional(),p:z.number().finite().optional()})
  const data=z.object({
    model:z.object({multilingual:z.boolean().optional()}).optional(),
    result:z.object({language:z.string()}).optional(),
    transcription:z.array(z.object({text:z.string(),offsets:offsets,tokens:z.array(token).max(10000).optional()})).max(100000)
  }).parse(raw)
  const endOfText=data.model?.multilingual===false?50256:50257
  const segments:AsrSegment[]=data.transcription.flatMap(segment=>{
    const {from,to}=segment.offsets
    if(from<0||to<=from)return []
    // Plain segment timestamps may be whole seconds even when the backend can
    // align speech tokens more finely. Full JSON enables that alignment. Never
    // invent fractional timestamps or use timestamp/control tokens as speech.
    const speech=segment.tokens?.filter(t=>t.text.trim()&&!/^\[_[^\]]+\]$/.test(t.text)&&(t.id===undefined||t.id<endOfText))??[]
    const times=speech.map(t=>{
      const value=t.offsets
      if(!value||value.from<0||value.to<value.from||value.to<from||value.from>to)return undefined
      return {startMs:Math.max(from,value.from),endMs:Math.min(to,value.to)}
    })
    const startMs=times[0]?.startMs??from,endMs=times.at(-1)?.endMs??to
    // Missing/invalid boundary token times keep the original boundary; a
    // collapsed alignment keeps the whole original segment, including text.
    const words=speech.flatMap((t,i)=>{
      const value=times[i]
      return value&&value.endMs>value.startMs?[{text:t.text,...value,...(t.p!==undefined?{score:t.p}:{})}]:[]
    })
    return [{text:segment.text,startMs:endMs>startMs?startMs:from,endMs:endMs>startMs?endMs:to,...(words.length?{words}:{})}]
  })
  return {language:data.result?.language,segments}
}
