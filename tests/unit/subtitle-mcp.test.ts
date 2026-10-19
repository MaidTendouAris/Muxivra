import { describe,it,expect,vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { McpSubtitleEditor } from '../../src/core/mcp/subtitles'
import { applySubtitleEdits,subtitleMcpEditSchema,subtitleEditorKey,type SubtitleEditorState } from '../../src/shared/subtitle-mcp'
import { createSubtitleDocument,defaultSubtitleStyle } from '../../src/shared/subtitles'
function fixture(){
  const projectId=randomUUID(),settings={enabled:true,allowInspect:true,allowSubtitleEdit:true,allowSubmit:false,allowCancel:false,port:19480,token:'0'.repeat(64),inputRoots:[],outputRoots:[]}
  let state:SubtitleEditorState={projectId,version:randomUUID(),document:createSubtitleDocument({projectPath:'D:\\app\\projects\\example\\subtitles.ass',mediaPath:'D:\\app\\projects\\example\\media.mp4',cues:[{id:'cue-1',startMs:123,endMs:1987,text:'Original'},{id:'cue-2',startMs:2100,endMs:3000,text:'Second'}]}),selection:['cue-1'],dirty:true}
  const editor=new McpSubtitleEditor(()=>settings,()=>({projectId,documentId:state.document.id})),apply=vi.fn(async(value:{document:SubtitleEditorState['document'];baseline:string})=>{if(value.baseline!==subtitleEditorKey(state.document))throw new Error('renderer conflict');state={...state,document:value.document,dirty:false,lastSavedAt:'2026-10-16T00:00:00Z'};return structuredClone(state)})
  editor.access={read:async()=>structuredClone(state),apply}
  return {editor,apply,settings,get:()=>state,set:(value:SubtitleEditorState)=>{state=value}}
}
describe('current subtitle MCP editing',()=>{
  it('reads current unsaved content, paginates consistently and reports selected cues',async()=>{
    const {editor,get,set}=fixture(),overview=await editor.overview();expect(overview).toMatchObject({totalCues:2,dirty:true,selectedCueIds:['cue-1']})
    expect((await editor.cues({offset:0,limit:1,revision:overview.revision})).cues[0].text).toBe('Original')
    set({...get(),document:{...get().document,cues:get().document.cues.map(cue=>({...cue,text:'Latest unsaved'}))}})
    await expect(editor.cues({offset:1,limit:1,revision:overview.revision})).rejects.toThrow('已更改');expect((await editor.cues({offset:0,limit:5,ids:['cue-2']})).cues[0].text).toBe('Latest unsaved')
  })
  it('applies text, timing, ASS style and insertion atomically, saves once and retries idempotently',async()=>{
    const {editor,apply,get}=fixture(),overview=await editor.overview(),request=subtitleMcpEditSchema.parse({projectId:overview.projectId,documentId:overview.documentId,revision:overview.revision,requestKey:'translate-1',summary:'Translation and style',operations:[{type:'update',id:'cue-1',changes:{text:'{\\fad(200,200)}译文',style:'Translated'}},{type:'upsert_style',style:defaultSubtitleStyle({name:'Translated',fontSize:42})},{type:'insert',afterId:'cue-1',cue:{startMs:1987,endMs:2100,text:'Inserted'}},{type:'script_info',values:{Title:'Translated project'}}]})
    const [first,again]=await Promise.all([editor.edit(request),editor.edit(request)]);expect(first).toEqual(again);expect(apply).toHaveBeenCalledTimes(1)
    expect(get().document.cues[0]).toMatchObject({startMs:123,endMs:1987,text:'{\\fad(200,200)}译文',style:'Translated'});expect(get().document.cues[1].text).toBe('Inserted');expect(get().document.cues[2].id).toBe('cue-2');expect(get().dirty).toBe(false)
    expect(()=>editor.edit({...request,summary:'Different'})).toThrow('requestKey');expect(get().document.mediaPath).toBe('D:\\app\\projects\\example\\media.mp4')
  })
  it('does not overwrite human changes or accept stale project IDs',async()=>{
    const {editor,apply,get,set}=fixture(),overview=await editor.overview(),base={projectId:overview.projectId,documentId:overview.documentId,revision:overview.revision,requestKey:'stale',summary:'Correction',operations:[{type:'update' as const,id:'cue-1',changes:{text:'AI'}}]}
    set({...get(),document:{...get().document,cues:[{...get().document.cues[0],text:'Human'},get().document.cues[1]]}})
    await expect(editor.edit(base)).rejects.toThrow('已更改');expect(apply).not.toHaveBeenCalled();expect(get().document.cues[0].text).toBe('Human')
    await expect(editor.edit({...base,projectId:randomUUID(),requestKey:'other-project'})).rejects.toThrow('已更改')
  })
  it('invalidates a revision after undo or an editor restart even when text returns to identical content',async()=>{
    const {editor,get,set,apply}=fixture(),overview=await editor.overview();set({...get(),version:randomUUID()});await expect(editor.edit({projectId:overview.projectId,documentId:overview.documentId,revision:overview.revision,requestKey:'before-undo',summary:'Old edit',operations:[{type:'update',id:'cue-1',changes:{text:'Old AI edit'}}]})).rejects.toThrow('已更改');expect(apply).not.toHaveBeenCalled()
  })
  it('validates the whole batch before applying, forbids path changes, and rejects bad timing/styles',async()=>{
    const {editor,apply}=fixture(),overview=await editor.overview(),base={projectId:overview.projectId,documentId:overview.documentId,revision:overview.revision,summary:'Invalid batch'}
    await expect(editor.edit({...base,requestKey:'invalid-id',operations:[{type:'update',id:'cue-1',changes:{text:'Must not apply'}},{type:'delete',id:'missing'}]})).rejects.toThrow('不存在');expect(apply).not.toHaveBeenCalled()
    for(const changes of [{startMs:5000},{style:'missing'}])await expect(editor.edit({...base,requestKey:randomUUID(),operations:[{type:'update',id:'cue-1',changes}]})).rejects.toThrow('时间倒置或引用')
    expect(()=>subtitleMcpEditSchema.parse({...base,requestKey:'path',operations:[{type:'update',id:'cue-1',changes:{mediaPath:'C:\\secret'}}]})).toThrow()
  })
  it('requires query/edit permission, an active editor, and rejects renderer-side races',async()=>{
    const {editor,settings,apply}=fixture(),overview=await editor.overview(),request={projectId:overview.projectId,documentId:overview.documentId,revision:overview.revision,requestKey:'race',summary:'Race',operations:[{type:'delete' as const,id:'cue-1'}]}
    settings.allowSubtitleEdit=false;expect(()=>editor.edit(request)).toThrow('权限');settings.allowSubtitleEdit=true
    apply.mockRejectedValueOnce(new Error('renderer conflict'));await expect(editor.edit(request)).rejects.toThrow('renderer conflict');expect(apply).toHaveBeenCalledTimes(1);await expect(editor.edit(request)).rejects.toThrow('renderer conflict');expect(apply).toHaveBeenCalledTimes(1)
    settings.allowInspect=false;await expect(editor.overview()).rejects.toThrow('查询');settings.allowInspect=true;editor.access=undefined;await expect(editor.overview()).rejects.toThrow('未就绪')
  })
})
