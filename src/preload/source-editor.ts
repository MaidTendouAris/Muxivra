import {contextBridge,ipcRenderer} from 'electron'
import type {SourceEditorApi,SourceFileState,SourcePreferences} from '../shared/source-editor'
const invoke=(method:string,...args:unknown[])=>ipcRenderer.invoke(`source-editor:${method}`,...args)
const api:SourceEditorApi={read:()=>invoke('read'),save:request=>invoke('save',request),open:()=>invoke('open'),saveCopy:text=>invoke('saveCopy',text),finishClose:discard=>invoke('finishClose',discard),discardDraft:path=>invoke('discardDraft',path),
  workspace:directory=>invoke('workspace',directory),setPreferences:patch=>invoke('setPreferences',patch),switchFile:(path,projectId)=>invoke('switchFile',path,projectId),cancelClose:()=>invoke('cancelClose'),
  onPreferences:callback=>{const listener=(_event:unknown,value:SourcePreferences)=>callback(value);ipcRenderer.on('source-editor:preferences',listener);return()=>ipcRenderer.removeListener('source-editor:preferences',listener)},
  onUpdate:callback=>{const listener=(_event:unknown,state:SourceFileState)=>callback(state);ipcRenderer.on('source-editor:update',listener);return()=>ipcRenderer.removeListener('source-editor:update',listener)},
  onCloseRequest:callback=>{const listener=()=>callback();ipcRenderer.on('source-editor:close-request',listener);return()=>ipcRenderer.removeListener('source-editor:close-request',listener)}
}
contextBridge.exposeInMainWorld('sourceEditor',api)
