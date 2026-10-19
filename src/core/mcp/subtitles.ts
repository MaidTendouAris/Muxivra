import { createHash,randomUUID } from 'node:crypto'
import { subtitleMcpEditSchema,subtitleEditorKey,applySubtitleEdits,type SubtitleEditorAccess,type SubtitleEditorState,type SubtitleMcpEdit } from '../../shared/subtitle-mcp'
import type { McpSettings } from '../../shared/types'
export class McpSubtitleEditor {
  access?:SubtitleEditorAccess
  private operations:Promise<unknown>=Promise.resolve()
  private requests=new Map<string,{fingerprint:string;result:Promise<unknown>}>()
  constructor(private settings:()=>McpSettings,private active:()=>{projectId?:string;documentId?:string}){}
  private permitted(write=false){const settings=this.settings();if(!settings.enabled||!settings.allowInspect)throw new Error('MCP 分析与查询权限未开启');if(write&&!settings.allowSubtitleEdit)throw new Error('请在 MCP 设置中开启“编辑当前字幕工程”权限');if(!this.access)throw new Error('字幕编辑器未就绪')}
  async read(){this.permitted();const state=await this.access!.read();this.permitted();const active=this.active();if(active.projectId!==state.projectId||active.documentId!==state.document.id)throw new Error('字幕工程已切换，请重新读取');return state}
  private revision(state:SubtitleEditorState){return createHash('sha256').update(state.version+':'+subtitleEditorKey(state.document)).digest('hex')}
  async overview(){const state=await this.read();return {projectId:state.projectId,documentId:state.document.id,revision:this.revision(state),projectPath:state.document.projectPath,format:'ass',exportFormat:state.document.exportFormat,totalCues:state.document.cues.length,selectedCueIds:state.selection,styles:state.document.styles,scriptInfo:state.document.scriptInfo,dirty:state.dirty,lastSavedAt:state.lastSavedAt,canEdit:!!this.settings().allowSubtitleEdit}}
  async cues(input:{offset:number;limit:number;ids?:string[];revision?:string}){const state=await this.read(),revision=this.revision(state);if(input.revision&&revision!==input.revision)throw new Error('字幕内容已更改，请重新读取工程版本');const ids=input.ids?new Set(input.ids):undefined,cues=ids?state.document.cues.filter(cue=>ids.has(cue.id)):state.document.cues;return {projectId:state.projectId,documentId:state.document.id,revision,total:cues.length,offset:input.offset,cues:cues.slice(input.offset,input.offset+input.limit)}}
  edit(value:SubtitleMcpEdit):Promise<unknown>{
    this.permitted(true);const request=subtitleMcpEditSchema.parse(value),fingerprint=createHash('sha256').update(JSON.stringify(request)).digest('hex'),previous=this.requests.get(request.requestKey)
    if(previous){if(previous.fingerprint!==fingerprint)throw new Error('requestKey 已用于另一组字幕修改');return previous.result}
    const result=this.operations.catch(()=>{}).then(async()=>{this.permitted(true);const state=await this.read();if(state.projectId!==request.projectId||state.document.id!==request.documentId||this.revision(state)!==request.revision)throw new Error('字幕工程或内容已更改，本次修改未应用，请重新读取后再提交');const edit=applySubtitleEdits(state.document,request.operations,randomUUID);if(Buffer.byteLength(JSON.stringify(edit.document))>10*1024**2)throw new Error('字幕工程超过 10 MB，修改未应用');this.permitted(true);const updated=await this.access!.apply({baseline:subtitleEditorKey(state.document),version:state.version,document:edit.document,summary:request.summary});return {projectId:updated.projectId,documentId:updated.document.id,revision:this.revision(updated),affectedIds:edit.affectedIds,totalCues:updated.document.cues.length,saved:!updated.dirty,lastSavedAt:updated.lastSavedAt,summary:request.summary,message:'修改已在字幕编辑器应用，可通过撤销还原；ASS 工程已保存'}})
    this.operations=result;this.requests.set(request.requestKey,{fingerprint,result});if(this.requests.size>500)this.requests.delete(this.requests.keys().next().value!);return result
  }
}
