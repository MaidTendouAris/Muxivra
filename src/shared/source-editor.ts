import { z } from 'zod'
import type { UiLocale } from './locale'

export const sourceSaveSchema=z.object({path:z.string().min(1).max(32760),text:z.string().max(10*1024*1024),revision:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
export type SourceSave=z.infer<typeof sourceSaveSchema>
export const sourcePreferencesSchema=z.object({autoSave:z.boolean().default(true),sidebarOpen:z.boolean().default(true)}).strict()
export type SourcePreferences=z.infer<typeof sourcePreferencesSchema>
export interface SourceProjectFile {name:string;path:string;type:'file'|'directory';text:boolean;subtitle:boolean}
export interface SourceWorkspace {
  preferences:SourcePreferences;project?:{id:string;name:string;path:string;active:boolean};directory:string;entries:SourceProjectFile[];truncated:boolean
}
export interface SourceFileState {
  path:string;name:string;text:string;revision:string;language:string;encoding:string;
  managed:boolean;readOnly?:string;savedAt?:string;locale:UiLocale;theme:'dark'|'light';
  draftText?:string;draftRevision?:string;
}
/** This bridge is exposed only in the isolated source-editor window. */
export interface SourceEditorApi {
  workspace(directory?:string):Promise<SourceWorkspace>
  setPreferences(patch:Partial<SourcePreferences>):Promise<SourcePreferences>
  switchFile(path:string,projectId:string):Promise<SourceFileState>
  onPreferences(callback:(preferences:SourcePreferences)=>void):()=>void
  read():Promise<SourceFileState|undefined>
  save(request:SourceSave):Promise<SourceFileState>
  open():Promise<void>
  saveCopy(text:string):Promise<string|undefined>
  finishClose(discard?:boolean):Promise<void>
  cancelClose():Promise<void>
  discardDraft(path:string):Promise<void>
  onUpdate(callback:(state:SourceFileState)=>void):()=>void
  onCloseRequest(callback:()=>void):()=>void
}
