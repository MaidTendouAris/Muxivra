import { z } from 'zod'
import { cueSchema,subtitleSchema,subtitleStyleSchema } from './schema'
import { normalizeSubtitleDocument,type SubtitleDocument } from './subtitles'

export const subtitleEditOperationSchema=z.discriminatedUnion('type',[
  z.object({type:z.literal('update'),id:z.string().min(1).max(128),changes:cueSchema.omit({id:true}).partial().refine(value=>Object.keys(value).length>0)}).strict(),
  z.object({type:z.literal('insert'),afterId:z.string().min(1).max(128).optional(),cue:cueSchema.omit({id:true})}).strict(),
  z.object({type:z.literal('delete'),id:z.string().min(1).max(128)}).strict(),
  z.object({type:z.literal('upsert_style'),style:subtitleStyleSchema}).strict(),
  z.object({type:z.literal('script_info'),values:z.record(z.string().min(1).max(100),z.string().max(10000)).refine(value=>Object.keys(value).length>0&&Object.keys(value).length<=50)}).strict()
])
export const subtitleMcpEditSchema=z.object({projectId:z.string().uuid(),documentId:z.string().min(1).max(128),revision:z.string().regex(/^[a-f0-9]{64}$/),requestKey:z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),summary:z.string().trim().min(1).max(500),operations:z.array(subtitleEditOperationSchema).min(1).max(500)}).strict()
export type SubtitleMcpEdit=z.infer<typeof subtitleMcpEditSchema>
export interface SubtitleEditorState {projectId:string;version:string;document:SubtitleDocument;selection:string[];lastSavedAt?:string;dirty:boolean}
export type SubtitleEditorRequest={id:string;type:'read'}|{id:string;type:'apply';baseline:string;version:string;document:SubtitleDocument;summary:string}
export type SubtitleEditorReply={id:string;value:SubtitleEditorState;error?:never}|{id:string;error:string;value?:never}
export const subtitleEditorStateSchema=z.object({projectId:z.string().uuid(),version:z.string().uuid(),document:subtitleSchema,selection:z.array(z.string().max(128)).max(100000),lastSavedAt:z.string().optional(),dirty:z.boolean()}).strict()
export interface SubtitleEditorAccess {read():Promise<SubtitleEditorState>;apply(value:{baseline:string;version:string;document:SubtitleDocument;summary:string}):Promise<SubtitleEditorState>}
function ordered(value:unknown):unknown {if(Array.isArray(value))return value.map(ordered);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,item])=>item!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,ordered(item)]));return value}
/** Shared canonical content, including IDs and project association, for optimistic concurrency. */
export function subtitleEditorKey(document:SubtitleDocument){return JSON.stringify(ordered(normalizeSubtitleDocument(document)))}
export function applySubtitleEdits(document:SubtitleDocument,operations:SubtitleMcpEdit['operations'],id:()=>string){
  const next=structuredClone(normalizeSubtitleDocument(document)),affected=new Set<string>()
  for(const operation of operations){
    if(operation.type==='upsert_style'){const index=next.styles.findIndex(style=>style.name===operation.style.name);if(index<0)next.styles.push(operation.style);else next.styles[index]=operation.style}
    else if(operation.type==='script_info')Object.assign(next.scriptInfo,operation.values)
    else if(operation.type==='insert'){const index=operation.afterId===undefined?next.cues.length:next.cues.findIndex(cue=>cue.id===operation.afterId)+1;if(operation.afterId!==undefined&&index===0)throw new Error('插入位置不存在，请重新读取字幕');const cue={...operation.cue,id:id()};next.cues.splice(index,0,cue);affected.add(cue.id)}
    else{const index=next.cues.findIndex(cue=>cue.id===operation.id);if(index<0)throw new Error('字幕条目不存在，请重新读取字幕');affected.add(operation.id);if(operation.type==='delete')next.cues.splice(index,1);else next.cues[index]={...next.cues[index],...operation.changes}}
  }
  const normalized=normalizeSubtitleDocument(subtitleSchema.parse(next))
  for(const cue of normalized.cues)if(affected.has(cue.id)&&(cue.endMs<cue.startMs||!normalized.styles.some(style=>style.name===cue.style)))throw new Error('修改后的字幕时间倒置或引用了不存在的样式')
  return {document:normalized,affectedIds:[...affected]}
}
