import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { subtitleEditorStateSchema,type SubtitleEditorAccess,type SubtitleEditorRequest,type SubtitleEditorState,type SubtitleEditorReply } from '../shared/subtitle-mcp'
export class SubtitleEditorBridge implements SubtitleEditorAccess {
  private pending=new Map<string,{resolve:(value:SubtitleEditorState)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>()
  constructor(private window:()=>BrowserWindow|undefined){}
  private call(value:Omit<Extract<SubtitleEditorRequest,{type:'read'}>,'id'>|Omit<Extract<SubtitleEditorRequest,{type:'apply'}>,'id'>|Omit<Extract<SubtitleEditorRequest,{type:'select'}>,'id'>){
    const window=this.window();if(!window||window.isDestroyed()||window.webContents.isDestroyed())throw new Error('字幕编辑窗口不可用');if(this.pending.size>=16)throw new Error('字幕编辑请求过多，请稍后重试')
    const id=randomUUID();return new Promise<SubtitleEditorState>((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('字幕编辑器响应超时，请重新读取当前内容确认结果，不要盲目重复修改'))},value.type==='read'?15000:120000);this.pending.set(id,{resolve,reject,timer});window.webContents.send('muxivra:subtitle-editor-request',{...value,id})})
  }
  read(){return this.call({type:'read'})}
  readSource(){return this.call({type:'read',origin:'source'})}
  selectSource(projectId:string,subtitleId:string){return this.call({type:'select',origin:'source',projectId,subtitleId})}
  applySource(value:Parameters<SubtitleEditorAccess['apply']>[0]&{source:{text:string;hash:string}}){return this.call({type:'apply',origin:'source',...value})}
  apply(value:Parameters<SubtitleEditorAccess['apply']>[0]){return this.call({type:'apply',...value})}
  reply(reply:SubtitleEditorReply){const pending=this.pending.get(reply.id);if(!pending)return;this.pending.delete(reply.id);clearTimeout(pending.timer);if(reply.error!==undefined)pending.reject(new Error(String(reply.error).slice(0,4000)));else{try{pending.resolve(subtitleEditorStateSchema.parse(reply.value))}catch{pending.reject(new Error('字幕编辑器返回无效数据'))}}}
  close(){for(const value of this.pending.values()){clearTimeout(value.timer);value.reject(new Error('字幕编辑窗口已关闭'))}this.pending.clear()}
}
