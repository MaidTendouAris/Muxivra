import { useCallback,useEffect,useRef,useState } from 'react'
import { Check,FileCode2,FolderOpen,Loader2,Save,Search,WrapText,ZoomIn,ZoomOut,Copy,AlertTriangle,RotateCcw,PanelLeftClose,PanelLeftOpen } from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import type { SourceEditorApi,SourceFileState,SourcePreferences,SourceWorkspace } from '../../shared/source-editor'
import { Button } from '../components/ui/button'
import { tr,setUiLanguage } from '../lib/i18n'
import { sourceLanguage } from './language'
import { monaco } from './monaco'
import { SourceExplorer } from './SourceExplorer'
import './source-editor.css'

const sourceApi=()=> (window as unknown as {sourceEditor:SourceEditorApi}).sourceEditor
const errorText=(error:unknown)=>String(error instanceof Error?error.message:error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'')
type EditorIntent={kind:'close'}|{kind:'switch';path:string;projectId:string}
type ModelView={model:monaco.editor.ITextModel;view:monaco.editor.ICodeEditorViewState|null}

export default function SourceEditor(){
  const [file,setFile]=useState<SourceFileState>(),[dirty,setDirty]=useState(false),[saving,setSaving]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[conflict,setConflict]=useState<SourceFileState>(),[transitioning,setTransitioning]=useState(false),[intent,setIntent]=useState<EditorIntent>(),[wrap,setWrap]=useState(false),[fontSize,setFontSize]=useState(15),[position,setPosition]=useState({lineNumber:1,column:1}),[editVersion,setEditVersion]=useState(0),[copied,setCopied]=useState('')
  const [preferences,setPreferences]=useState<SourcePreferences>({autoSave:true,sidebarOpen:true}),[preferencesReady,setPreferencesReady]=useState(false),[preferenceBusy,setPreferenceBusy]=useState(false),[workspace,setWorkspace]=useState<SourceWorkspace>(),[workspaceError,setWorkspaceError]=useState('')
  const host=useRef<HTMLDivElement>(null),editor=useRef<monaco.editor.IStandaloneCodeEditor|undefined>(undefined),models=useRef(new Map<string,ModelView>()),baseline=useRef<SourceFileState|undefined>(undefined),conflicting=useRef<SourceFileState|undefined>(undefined),inFlight=useRef<Promise<void>|undefined>(undefined),deferred=useRef<SourceFileState|undefined>(undefined),ignoreChange=useRef(false),alive=useRef(true),editBuffer=useRef(''),fileDirty=useRef(false),transition=useRef(false),pendingIntent=useRef<EditorIntent|undefined>(undefined),preferencesRef=useRef(preferences)
  const preferencesInitialized=useRef(false),workspaceRead=useRef<Promise<SourceWorkspace>|undefined>(undefined)
  const markDirty=(value:boolean)=>{fileDirty.current=value;setDirty(value)}
  const setProblem=(value:string)=>setError(value)
  const putText=(text:string)=>{ignoreChange.current=true;editBuffer.current=text;if(editor.current?.getValue()!==text)editor.current?.setValue(text);ignoreChange.current=false}
  const acceptPreferences=useCallback((next:SourcePreferences)=>{preferencesInitialized.current=true;preferencesRef.current=next;setPreferences(next);setPreferencesReady(true)},[])
  const readWorkspace=useCallback(()=>{
    if(workspaceRead.current)return workspaceRead.current
    const request=sourceApi().workspace();workspaceRead.current=request
    void request.finally(()=>{if(workspaceRead.current===request)workspaceRead.current=undefined}).catch(()=>{})
    return request
  },[])
  const refreshWorkspace=useCallback(async()=>{try{const next=await readWorkspace();if(alive.current){setWorkspace(next);setWorkspaceError('');if(!preferencesInitialized.current)acceptPreferences(next.preferences)}}catch(problem){if(alive.current)setWorkspaceError(errorText(problem))}},[acceptPreferences,readWorkspace])
  const accept=useCallback((next:SourceFileState,replace=true)=>{
    const previous=baseline.current,instance=editor.current,changedFile=previous?.path!==next.path
    ignoreChange.current=true
    if(instance&&changedFile){
      if(previous){const old=models.current.get(previous.path);if(old)old.view=instance.saveViewState()}
      let target=models.current.get(next.path)
      if(!target){target={model:monaco.editor.createModel(next.text,sourceLanguage(next.language,next.path)),view:null};models.current.set(next.path,target)}
      instance.setModel(target.model)
      if(target.view)instance.restoreViewState(target.view)
      setPosition(instance.getPosition()??{lineNumber:1,column:1})
    }
    baseline.current=next;setFile(next);setUiLanguage(next.locale,[]);document.documentElement.dataset.theme=next.theme;monaco.editor.setTheme(`muxivra-source-${next.theme}`)
    if(replace)putText(next.text)
    const model=instance?.getModel();if(model)monaco.editor.setModelLanguage(model,sourceLanguage(next.language,next.path))
    ignoreChange.current=false;instance?.updateOptions({readOnly:!!next.readOnly||transition.current});markDirty(editBuffer.current!==next.text)
  },[])
  const adoptFile=useCallback((next:SourceFileState)=>{
    conflicting.current=undefined;setConflict(undefined);setProblem('');setCopied('');accept(next)
    if(next.draftText!==undefined&&next.draftText!==next.text){putText(next.draftText);markDirty(true);if(next.draftRevision!==next.revision){conflicting.current=next;setConflict(next)}}
  },[accept])
  const incoming=useCallback((next:SourceFileState)=>{
    if(!alive.current)return
    if(inFlight.current||transition.current){deferred.current=next;return}
    const previous=baseline.current
    // The main process serializes requests, but an update already on the IPC wire
    // may still refer to the previous file after a successful explorer switch.
    if(previous&&next.path!==previous.path)return
    if(previous&&next.revision===previous.revision){accept({...previous,...next},false);return}
    if(fileDirty.current&&previous){
      if(next.text===editBuffer.current){accept(next);conflicting.current=undefined;setConflict(undefined);setProblem('');return}
      conflicting.current=next;setConflict(next);if(next.readOnly){baseline.current={...previous,readOnly:next.readOnly};setFile(baseline.current);editor.current?.updateOptions({readOnly:true})}return
    }
    if(!previous){adoptFile(next);return}
    conflicting.current=undefined;setConflict(undefined);setProblem('');accept(next)
  },[accept,adoptFile])
  const flush=useCallback(async():Promise<void>=>{
    if(inFlight.current){await inFlight.current;if(fileDirty.current)return flush();return}
    if(!fileDirty.current||!baseline.current)return
    if(conflicting.current)throw new Error(tr('文件已在其他窗口更改。请先重新载入，或将当前内容另存为副本。'))
    if(baseline.current.readOnly)throw new Error(tr(baseline.current.readOnly))
    const before=baseline.current,text=editBuffer.current
    const work=(async()=>{
      setSaving(true);setProblem('')
      try{
        const saved=await sourceApi().save({text,revision:before.revision,path:before.path})
        if(!alive.current||baseline.current?.path!==before.path)return
        if(editBuffer.current===text)accept(saved);else accept(saved,false)
      }catch(problem){if(alive.current)setProblem(errorText(problem));throw problem}
      finally{inFlight.current=undefined;if(alive.current){setSaving(false);const next=deferred.current;deferred.current=undefined;if(next&&next.path===baseline.current?.path){if(next.revision===baseline.current?.revision||next.revision!==before.revision)incoming(next);else if(baseline.current&&next.readOnly!==baseline.current.readOnly)incoming({...baseline.current,readOnly:next.readOnly})}}}
    })()
    inFlight.current=work;await work
  },[accept,incoming])
  const flushRef=useRef(flush);flushRef.current=flush
  const manualSave=()=>flushRef.current().catch(()=>undefined)
  const retryRead=async()=>{setLoading(true);setProblem('');try{const next=await sourceApi().read();if(next)incoming(next)}catch(problem){setProblem(errorText(problem))}finally{setLoading(false)}}
  const saveCopy=async()=>{try{const path=await sourceApi().saveCopy(editBuffer.current);if(path)setCopied(path)}catch(problem){setProblem(errorText(problem))}}
  const prompt=(next:EditorIntent)=>{pendingIntent.current=next;setIntent(next)}
  const advance=async(next:EditorIntent,mode:'save'|'discard'|'clean')=>{
    if(transition.current)return
    const actionPath=baseline.current?.path
    transition.current=true;setTransitioning(true);editor.current?.updateOptions({readOnly:true})
    try{
      if(mode==='save')await flushRef.current()
      else if(mode==='discard'){
        await inFlight.current?.catch(()=>undefined);if(actionPath)await sourceApi().discardDraft(actionPath)
        if(baseline.current)putText(baseline.current.text)
        markDirty(false);conflicting.current=undefined;setConflict(undefined);setProblem('')
      }else await inFlight.current
      if(next.kind==='close'){await sourceApi().finishClose(mode==='discard');return}
      const selected=await sourceApi().switchFile(next.path,next.projectId)
      deferred.current=undefined;adoptFile(selected);await refreshWorkspace();editor.current?.focus()
      pendingIntent.current=undefined;setIntent(undefined)
    }catch(problem){setProblem(errorText(problem));if(fileDirty.current)prompt(next)}
    finally{
      transition.current=false;if(alive.current){setTransitioning(false);editor.current?.updateOptions({readOnly:!!baseline.current?.readOnly});const update=deferred.current;deferred.current=undefined;if(update&&update.path===baseline.current?.path)incoming(update)}
    }
  }
  const advanceRef=useRef(advance);advanceRef.current=advance
  const requestAction=async(next:EditorIntent)=>{
    if(transition.current||pendingIntent.current)return
    if(next.kind==='switch'&&!baseline.current?.readOnly&&workspace?.project?.id===next.projectId){
      const requested=workspace.project.path.replace(/[\\/]+$/,'')+'/'+next.path
      if(baseline.current?.path.replaceAll('\\','/').toLowerCase()===requested.replaceAll('\\','/').toLowerCase()){editor.current?.focus();return}
    }
    if(!preferencesInitialized.current){
      try{const current=await readWorkspace();acceptPreferences(current.preferences);setWorkspace(current);setWorkspaceError('')}
      catch(problem){setProblem(errorText(problem));if(fileDirty.current){prompt(next);return}if(next.kind!=='close')return}
      if(transition.current||pendingIntent.current)return
    }
    if(!preferencesRef.current.autoSave&&fileDirty.current){prompt(next);return}
    await advanceRef.current(next,fileDirty.current||inFlight.current?'save':'clean')
  }
  const actionRef=useRef(requestAction);actionRef.current=requestAction
  const changePreferences=async(patch:Partial<SourcePreferences>)=>{
    if(preferenceBusy)return
    const previous=preferencesRef.current;acceptPreferences({...previous,...patch});setPreferenceBusy(true)
    try{acceptPreferences(await sourceApi().setPreferences(patch))}catch(problem){acceptPreferences(previous);setProblem(errorText(problem))}finally{setPreferenceBusy(false)}
  }
  useEffect(()=>{
    alive.current=true
    const instance=monaco.editor.create(host.current!,{value:'',language:'plaintext',theme:'muxivra-source-dark',automaticLayout:true,editContext:false,minimap:{enabled:true,renderCharacters:true,showSlider:'always',side:'right',size:'fit',maxColumn:120},fontFamily:'"Cascadia Code",Consolas,"Microsoft YaHei UI",monospace',fontSize:15,lineHeight:23,lineNumbers:'on',scrollBeyondLastLine:false,wordWrap:'off',padding:{top:14,bottom:18},smoothScrolling:true,mouseWheelZoom:true,folding:true,renderWhitespace:'selection',fixedOverflowWidgets:true,ariaLabel:tr('源码编辑器'),readOnly:true})
    const initialModel=instance.getModel();editor.current=instance
    instance.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyS,()=>void flushRef.current().catch(()=>undefined))
    instance.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyB,()=>void sourceApi().setPreferences({sidebarOpen:!preferencesRef.current.sidebarOpen}).then(acceptPreferences).catch(problem=>setProblem(errorText(problem))))
    const change=instance.onDidChangeModelContent(()=>{
      if(ignoreChange.current)return
      editBuffer.current=instance.getValue();const changed=editBuffer.current!==baseline.current?.text;markDirty(changed);setProblem('');setCopied('');setEditVersion(value=>value+1)
      const changedPath=baseline.current?.path
      if(!changed)void Promise.resolve(inFlight.current).catch(()=>undefined).then(async()=>{
        if(!alive.current||!changedPath||fileDirty.current||conflicting.current||baseline.current?.path!==changedPath||transition.current)return
        try{await sourceApi().discardDraft(changedPath);if(alive.current&&!fileDirty.current&&!conflicting.current&&baseline.current?.path===changedPath)setProblem('')}catch(problem){if(alive.current)setProblem(errorText(problem))}
      })
    })
    const cursor=instance.onDidChangeCursorPosition(event=>setPosition(event.position))
    const offUpdate=sourceApi().onUpdate(incoming),offClose=sourceApi().onCloseRequest(()=>void actionRef.current({kind:'close'})),offPreferences=sourceApi().onPreferences(acceptPreferences)
    const beforeUnload=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';void actionRef.current({kind:'close'})}
    window.addEventListener('beforeunload',beforeUnload)
    sourceApi().read().then(next=>{if(alive.current){if(next)incoming(next);setLoading(false)}}).catch(problem=>{if(alive.current){setProblem(errorText(problem));setLoading(false)}})
    void refreshWorkspace()
    const poll=setInterval(()=>void refreshWorkspace(),3000)
    return()=>{alive.current=false;clearInterval(poll);window.removeEventListener('beforeunload',beforeUnload);offUpdate();offClose();offPreferences();change.dispose();cursor.dispose();instance.dispose();initialModel?.dispose();for(const item of models.current.values())item.model.dispose();models.current.clear();editor.current=undefined;baseline.current=undefined}
  },[incoming,acceptPreferences,refreshWorkspace])
  useEffect(()=>{editor.current?.updateOptions({wordWrap:wrap?'on':'off'})},[wrap])
  useEffect(()=>{editor.current?.updateOptions({fontSize,lineHeight:Math.round(fontSize*1.55)})},[fontSize])
  useEffect(()=>{
    if(!preferencesReady||!preferences.autoSave||!dirty||saving||conflict||file?.readOnly||error||transitioning||intent)return
    const timer=setTimeout(()=>{if(preferencesRef.current.autoSave&&!transition.current&&!pendingIntent.current)void flushRef.current().catch(()=>undefined)},700)
    return()=>clearTimeout(timer)
  },[editVersion,dirty,saving,conflict,file?.readOnly,error,preferencesReady,preferences.autoSave,transitioning,intent])
  useEffect(()=>{document.title=file?`${dirty?'● ':''}${file.name} — Muxivra`:'Muxivra';},[file?.name,dirty])
  const reload=async()=>{const next=conflicting.current,path=baseline.current?.path;if(!next||!path||transition.current)return;transition.current=true;setTransitioning(true);editor.current?.updateOptions({readOnly:true});try{await sourceApi().discardDraft(path);accept(next);conflicting.current=undefined;setConflict(undefined);setProblem('')}catch(problem){setProblem(errorText(problem))}finally{transition.current=false;setTransitioning(false);editor.current?.updateOptions({readOnly:!!baseline.current?.readOnly})}}
  const open=async()=>{try{await sourceApi().open()}catch(problem){setProblem(errorText(problem))}}
  const cancelIntent=()=>{if(transition.current)return;const closing=pendingIntent.current?.kind==='close';pendingIntent.current=undefined;setIntent(undefined);editor.current?.focus();if(closing)void sourceApi().cancelClose().catch(problem=>setProblem(errorText(problem)))}
  const busy=loading||saving||transitioning||!!intent
  return <main className="source-editor-window" data-testid="source-editor">
    <header className="source-editor-toolbar">
      <div className="source-editor-brand"><FileCode2 size={20}/><strong>{tr('源码编辑器')}</strong></div>
      <div className="source-editor-actions">
        <label className={`source-autosave ${preferences.autoSave?'enabled':''}`} title={tr('停止输入后自动保存并同步')}><input type="checkbox" aria-label={tr('自动保存')} checked={preferences.autoSave} disabled={!preferencesReady||preferenceBusy} onChange={event=>void changePreferences({autoSave:event.target.checked})}/><span>{tr('自动保存')}</span></label>
        <Button size="sm" variant="secondary" disabled={busy} onClick={open}><FolderOpen size={15}/>{tr('打开文本文件')}</Button>
        <Button size="sm" disabled={!dirty||!!file?.readOnly||!!conflict||transitioning} loading={saving} onClick={manualSave}><Save size={15}/>{tr('保存')}</Button>
        <Button size="icon" variant="ghost" title={tr('查找与替换')} onClick={()=>editor.current?.getAction('editor.action.startFindReplaceAction')?.run()}><Search size={17}/></Button>
        <Button size="icon" variant={wrap?'secondary':'ghost'} title={tr('自动换行')} aria-pressed={wrap} onClick={()=>setWrap(value=>!value)}><WrapText size={17}/></Button>
        <Button size="icon" variant="ghost" title={tr('缩小字体')} disabled={fontSize<=10} onClick={()=>setFontSize(value=>Math.max(10,value-1))}><ZoomOut size={17}/></Button>
        <Button size="icon" variant="ghost" title={tr('放大字体')} disabled={fontSize>=30} onClick={()=>setFontSize(value=>Math.min(30,value+1))}><ZoomIn size={17}/></Button>
      </div>
    </header>
    <div className="source-editor-workspace">
      <div className="source-activity-bar"><Button size="icon" variant="ghost" aria-label={preferences.sidebarOpen?tr('隐藏资源管理器'):tr('显示资源管理器')} title={preferences.sidebarOpen?tr('隐藏资源管理器'):tr('显示资源管理器')} aria-pressed={preferences.sidebarOpen} disabled={!preferencesReady||preferenceBusy} onClick={()=>void changePreferences({sidebarOpen:!preferences.sidebarOpen})}>{preferences.sidebarOpen?<PanelLeftClose size={19}/>:<PanelLeftOpen size={19}/>}</Button></div>
      {preferences.sidebarOpen&&<SourceExplorer workspace={workspace} error={workspaceError} filePath={file?.path} busy={busy} onRefresh={refreshWorkspace} onHide={()=>void changePreferences({sidebarOpen:false})} onOpen={(path,projectId)=>void requestAction({kind:'switch',path,projectId})}/>}
      <section className="source-editor-pane">
        <div className="source-editor-file"><FileCode2 size={15}/><strong>{file?.name??tr('未打开文件')}</strong>{dirty&&<span className="source-dirty-dot"/>}{file?.managed&&<span className="source-managed">{tr('项目字幕 · 双向同步')}</span>}<span className="source-editor-path" title={file?.path}>{file?.path}</span></div>
        {(file?.readOnly||conflict||error||copied)&&<div className={`source-editor-notice ${conflict||error?'source-editor-warning':''}`} role={conflict||error?'alert':'status'}>
          {copied&&!error&&!conflict?<Copy size={16}/>:<AlertTriangle size={16}/>}<p>{conflict?tr('其他窗口已更改此文件，自动保存已暂停。当前编辑内容仍保留在此窗口。'):error||tr(file?.readOnly)||tr('副本已保存至 {0}',copied)}</p>
          {conflict&&<Button size="sm" variant="secondary" disabled={transitioning} onClick={reload}><RotateCcw size={14}/>{tr('重新载入')}</Button>}
          {(dirty||error||conflict||file?.readOnly)&&<Button size="sm" variant="secondary" onClick={saveCopy}>{tr('另存副本')}</Button>}
          {error&&!conflict&&!file?.readOnly&&<Button size="sm" variant="secondary" onClick={file?manualSave:retryRead}>{file?tr('重试保存'):tr('重新读取')}</Button>}
        </div>}
        <div className="source-editor-body"><div className="source-editor-monaco" ref={host}/>{(loading||!file)&&<div className="source-editor-placeholder">{loading?<><Loader2 className="spin" size={25}/>{tr('正在读取文件…')}</>:<><FileCode2 size={42}/><strong>{tr('打开文本源文件')}</strong><p>{tr('ASS / SSA / SRT 语法高亮、全文缩略图与自动保存')}</p><Button variant="secondary" onClick={open}><FolderOpen size={16}/>{tr('打开文本文件')}</Button></>}</div>}{transitioning&&<div className="source-transition" role="status"><Loader2 className="spin" size={18}/>{tr('正在切换文件…')}</div>}</div>
      </section>
    </div>
    <footer className="source-editor-status"><span className={error||conflict?'source-status-error':''} data-testid="source-save-status">{saving?<><Loader2 className="spin" size={14}/>{tr('正在保存…')}</>:conflict?<><AlertTriangle size={14}/>{tr('同步冲突')}</>:error?<><AlertTriangle size={14}/>{tr('保存失败 · 内容仍保留')}</>:file?.readOnly?tr('只读'):dirty?<><span className="source-dirty-dot"/>{preferences.autoSave?tr('等待自动保存'):tr('尚未保存 · 自动保存已关闭')}</>:<><Check size={14}/>{file?tr('已保存'):tr('就绪')}</>}</span><span className="source-status-spacer"/><span>{tr('行 {0}，列 {1}',position.lineNumber,position.column)}</span><span>{file?.encoding??'UTF-8'}</span><span>{sourceLanguage(file?.language??'',file?.path??'').replace('muxivra-','').toUpperCase()}</span><span>{fontSize}px</span></footer>
    <Dialog.Root open={!!intent} onOpenChange={value=>{if(!value)cancelIntent()}}><Dialog.Portal><Dialog.Overlay className="source-close-backdrop"/><Dialog.Content className="source-close-dialog" onEscapeKeyDown={event=>{if(transitioning)event.preventDefault()}} onPointerDownOutside={event=>{if(transitioning)event.preventDefault()}}><AlertTriangle size={25}/><Dialog.Title asChild><h2>{tr('文件尚未保存')}</h2></Dialog.Title><Dialog.Description asChild><p>{intent?.kind==='switch'?tr('切换文件前，请保存当前更改，或选择不保存。'):tr('关闭窗口前，请保存当前更改，或选择不保存。')}</p></Dialog.Description><p className="source-confirm-file">{file?.name}</p>{error&&<p className="source-confirm-error" role="alert">{error}</p>}<div className="source-close-actions"><Button variant="ghost" disabled={transitioning} onClick={cancelIntent}>{tr('取消')}</Button><Button variant="secondary" disabled={transitioning} onClick={saveCopy}>{tr('另存副本')}</Button><Button variant="secondary" disabled={transitioning} onClick={()=>intent&&void advanceRef.current(intent,'discard')}>{tr('不保存')}</Button><Button disabled={transitioning||!!conflict||!!file?.readOnly} loading={saving} onClick={()=>intent&&void advanceRef.current(intent,'save')}>{tr('保存')}</Button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </main>
}
