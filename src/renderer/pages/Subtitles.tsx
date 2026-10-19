import { tr, uiLocale } from '../lib/i18n'
import { useState, useRef, useEffect, useMemo } from 'react'
import { Eye, Pencil, FilePlus2, Bold, Italic, Underline, Strikethrough, WrapText, RemoveFormatting, Type, AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, Plus, Download, Undo2, Redo2, Film, Subtitles as SubtitleIcon, Trash2, Clock3, Play, Save, FolderOpen, Palette, Copy, ClipboardPaste, Scissors, Combine, Search, CheckCheck, ChevronLeft, ChevronRight } from 'lucide-react'
import type { Cue, SubtitleDocument, Snapshot } from '../../shared/types'
import type { MediaProject } from '../../shared/projects'
import type { SubtitleProjectState } from '../../shared/subtitle-project'
import { createSubtitleDocument, normalizeSubtitleDocument, type SubtitleFormat } from '../../shared/subtitles'
import { subtitleSchema } from '../../shared/schema'
import { Button, Card, Empty, Input, Field, DropZone, Busy, Select, Modal } from '../components/ui'
import type { RunAction } from '../components/Jobs'
import { MpvPlayer } from '../components/MpvPlayer'
import { SubtitleStyles } from '../components/SubtitleStyles'
import { formatTime, parseTime, nameOf } from '../lib/utils'
import { subtitleIssues, shiftCues, copyCues, pasteCues, splitCue, mergeCues, replaceSubtitleText } from '../lib/subtitle-editor'
import { formatShortcut, isShortcutInput, matchShortcut, type ShortcutId } from '../../shared/shortcuts'
import { useShortcuts } from '../components/ShortcutProvider'
import { asrSubtitleCues,type AsrResult } from '../../shared/asr'
import { ProjectSwitcher } from '../components/ProjectSwitcher'
import { ChevronUp,ChevronDown } from 'lucide-react'
import { AudioWaveform } from '../components/AudioWaveform'
import type { SubtitleMediaTransfer } from '../../shared/subtitle-media'
import { ArrowRight } from 'lucide-react'
import { SubtitleReview } from '../components/SubtitleReview'
import { formatSubtitleText,type SubtitleTextCommand } from '../lib/subtitle-format'
import { playingCues } from '../lib/subtitle-follow'
import { subtitleEditorKey,type SubtitleEditorRequest,type SubtitleEditorState } from '../../shared/subtitle-mcp'

const clipboardHeader='MUXIVRA_SUBTITLE_CUES_V2\n'
function TimeInput({label,value,onCommit,run}:{label:string;value:number;onCommit:(value:number)=>void;run:RunAction}) {
  const [text,setText]=useState(formatTime(value));useEffect(()=>setText(formatTime(value)),[value])
  const commit=()=>void run(async()=>{try{const next=parseTime(text);if(next<0||next>359999999)throw new Error(tr("时间不能超过 99:59:59,999"));if(next!==value)onCommit(next)}catch(error){setText(formatTime(value));throw error}})
  return <Field label={tr(label)}><Input value={text} onChange={event=>setText(event.target.value)} onBlur={commit} onKeyDown={event=>{if(event.key==='Enter')event.currentTarget.blur()}}/></Field>
}
export function Subtitles({run,busy:externalBusy,visible,onBeforeLeave,onBeforeExit,asrJobId,onAsrConsumed,snapshot,projectId,onTasks,onProjects,onSingle}:{snapshot:Snapshot;projectId?:string;onSingle:(transfer:SubtitleMediaTransfer)=>void;onTasks:()=>void;onProjects:()=>void;run:RunAction;busy:boolean;visible:boolean;onBeforeLeave?:(save:()=>Promise<void>)=>void;onBeforeExit?:(save:()=>Promise<void>)=>void;asrJobId?:string;onAsrConsumed?:()=>void}) {
  const [mcpApplying,setMcpApplying]=useState(false),busy=externalBusy||mcpApplying
  const remoteOperation=useRef<Promise<SubtitleEditorState>|undefined>(undefined),remoteHandler=useRef<(request:SubtitleEditorRequest)=>Promise<SubtitleEditorState>>(undefined)
  const [asrDraft,setAsrDraft]=useState<AsrResult>()
  const [reviewPage,setReviewPage]=useState(false),[fileDialog,setFileDialog]=useState<'new'|'rename'|'delete'>(),[fileName,setFileName]=useState(''),[fileChanging,setFileChanging]=useState(false),[fontDialog,setFontDialog]=useState(false),[fontSize,setFontSize]=useState(48)
  const textArea=useRef<HTMLTextAreaElement>(null),textRange=useRef({start:0,end:0}),fileViews=useRef(new Map<string,{history:SubtitleDocument[];future:SubtitleDocument[];selection:string[];focused?:string;page:number}>())
  const [fileProject,setFileProject]=useState<MediaProject>()
  const snapshotProject=snapshot.projects?.items.find(item=>item.id===projectId),currentProject=fileProject&&fileProject.id===projectId&&fileProject.updatedAt>(snapshotProject?.updatedAt??'')?fileProject:snapshotProject,subtitleFiles=currentProject?.subtitles??[]
  const shortcuts=useShortcuts(),shortcutTitle=(label:string,id:ShortcutId)=>shortcuts[id]?`${label} · ${formatShortcut(shortcuts[id]).replace('空格',tr('空格'))}`:label
  const [document,setDocument]=useState<SubtitleDocument>(()=>createSubtitleDocument()),[selection,setSelection]=useState<string[]>([]),[focused,setFocused]=useState<string>(),[history,setHistory]=useState<SubtitleDocument[]>([]),[future,setFuture]=useState<SubtitleDocument[]>([])
  const [projectState,setProjectState]=useState<SubtitleProjectState>({dirty:false,saving:false,canDeleteProject:false}),[cacheState,setCacheState]=useState<'saving'|'saved'|'error'>('saved'),[loaded,setLoaded]=useState(false),[stylesPage,setStylesPage]=useState(false)
  const [media,setMedia]=useState(''),[loadId,setLoadId]=useState(0),[time,setTime]=useState(0),[duration,setDuration]=useState(0),[followPlayback,setFollowPlayback]=useState(false),[editingCue,setEditingCue]=useState(false)
  const [playback,setPlayback]=useState({playing:false,speed:1}),[seekRevision,setSeekRevision]=useState(0)
  const [page,setPage]=useState(1),[searchOpen,setSearchOpen]=useState(false),[search,setSearch]=useState(''),[replacement,setReplacement]=useState(''),[caseSensitive,setCaseSensitive]=useState(false),[replaceScope,setReplaceScope]=useState('all'),[replaceCount,setReplaceCount]=useState<number>()
  const [offsetOpen,setOffsetOpen]=useState(false),[offset,setOffset]=useState(0),[offsetScope,setOffsetScope]=useState('selected'),[offsetEdge,setOffsetEdge]=useState<'both'|'start'|'end'>('both'),[validationOpen,setValidationOpen]=useState(false)
  const [deleteConfirm,setDeleteConfirm]=useState(false),[closingProject,setClosingProject]=useState(false)
  const transferLock=useRef(false)
  const flushing=useRef(0),remoteVersion=useRef(crypto.randomUUID())
  const playerReady=useRef(false),openingMedia=useRef(''),pendingSeek=useRef<number|undefined>(undefined),documentRef=useRef(document),selectionAnchor=useRef<string|undefined>(undefined),textCursor=useRef(0),clipboard=useRef<Cue[]>([]),lastEdit=useRef({key:'',at:0}),saveQueue=useRef<Promise<void>>(Promise.resolve())
  const layout=useRef<HTMLDivElement>(null)
  const [dockExpanded,setDockExpanded]=useState(true)
  const activeProject=useRef(projectId),activePath=useRef(currentProject?.subtitlePath)
  activeProject.current=projectId;activePath.current=currentProject?.subtitlePath
  documentRef.current=document
  const cue=document.cues.find(item=>item.id===focused),selected=new Set(selection),exportFormat=document.exportFormat??'ass',srtMode=exportFormat==='srt',issues=useMemo(()=>subtitleIssues(document),[document.cues,document.styles]),hasAssTags=!!cue&&/{\s*\\/.test(cue.text)
  const rows=useMemo(()=>document.cues.map((item,index)=>({item,index})).filter(({item})=>!search||(caseSensitive?item.text.includes(search):item.text.toLowerCase().includes(search.toLowerCase()))),[document.cues,search,caseSensitive]),pages=Math.max(1,Math.ceil(rows.length/50)),actualPage=Math.min(page,pages),pageRows=rows.slice((actualPage-1)*50,actualPage*50)

  remoteHandler.current=async request=>{
    if(!visible||!loaded||stylesPage||reviewPage||fileChanging||!activeProject.current||documentRef.current.projectPath!==activePath.current)throw new Error(tr("请在字幕编辑页打开已有工程，并返回字幕主工作区"))
    if(externalBusy||flushing.current||transferLock.current||remoteOperation.current)throw new Error(tr("字幕编辑器正在保存或转入媒体，请稍后重试"))
    const state=():SubtitleEditorState=>({projectId:activeProject.current!,version:remoteVersion.current,document:structuredClone(documentRef.current),selection:selection.filter(id=>documentRef.current.cues.some(cue=>cue.id===id)),lastSavedAt:projectState.lastSavedAt,dirty:projectState.dirty})
    if(request.type==='read')return state()
    if(window.document.querySelector('[role="dialog"],[role="listbox"]'))throw new Error(tr("请先关闭字幕弹窗，再进行 AI 修改"))
    if(remoteVersion.current!==request.version||subtitleEditorKey(documentRef.current)!==request.baseline||request.document.id!==documentRef.current.id)throw new Error(tr("字幕内容已更改，本次 AI 修改未应用，请重新读取"))
    editDocument(normalizeSubtitleDocument(subtitleSchema.parse(request.document)),'mcp-'+request.id)
    setSelection(ids=>ids.filter(id=>request.document.cues.some(cue=>cue.id===id)));setFocused(id=>request.document.cues.some(cue=>cue.id===id)?id:request.document.cues[0]?.id)
    transferLock.current=true;setMcpApplying(true)
    const operation=(async()=>{try{await save();const savedState=await window.muxivra.getSubtitleProjectState();void run(async()=>true,tr("AI 已更新字幕：")+request.summary);return {...state(),dirty:savedState.dirty,lastSavedAt:savedState.lastSavedAt}}catch(error){const message=tr("AI 修改已应用到编辑器，但保存失败，请读取当前内容后处理：")+(error as Error).message;void run(async()=>{throw new Error(message)});throw new Error(message)}finally{transferLock.current=false;setMcpApplying(false)}})()
    remoteOperation.current=operation
    try{return await operation}finally{remoteOperation.current=undefined}
  }
  useEffect(()=>window.muxivra.onSubtitleEditorRequest(request=>remoteHandler.current!(request)),[])

  useEffect(()=>{setDockExpanded(!projectId)},[projectId])
  useEffect(()=>{
    if(!loaded||!visible)return;let live=true
    void window.muxivra.getSession().then(next=>{if(!live)return;if(next&&(next.id!==documentRef.current.id||JSON.stringify(next)!==JSON.stringify(documentRef.current))){const changedMedia=next.mediaPath!==documentRef.current.mediaPath;acceptDocument(next);if(next.mediaPath&&changedMedia)activateMedia(next.mediaPath);else if(!next.mediaPath){setMedia('')}}else if(!projectId&&!next){acceptDocument(createSubtitleDocument());setMedia('')}return window.muxivra.getSubtitleProjectState().then(state=>{if(live)setProjectState(state)})}).catch(error=>void run(async()=>{throw error}))
    return()=>{live=false}
  },[projectId,loaded,visible])

  function acceptDocument(next:SubtitleDocument) { const normalized=normalizeSubtitleDocument(next);remoteVersion.current=crypto.randomUUID();documentRef.current=normalized;setDocument(normalized);setSelection(normalized.cues[0]?[normalized.cues[0].id]:[]);setFocused(normalized.cues[0]?.id);setHistory([]);setFuture([]);setPage(1);setSearch('');lastEdit.current={key:'',at:0} }
  function editDocument(next:SubtitleDocument,key='') {
    if(transferLock.current)return
    const previous=documentRef.current,now=Date.now()
    if(JSON.stringify(next)===JSON.stringify(previous))return
    if(!key||lastEdit.current.key!==key||now-lastEdit.current.at>750)setHistory(values=>[...values.slice(-99),structuredClone(previous)])
    remoteVersion.current=crypto.randomUUID();lastEdit.current={key,at:now};setFuture([]);documentRef.current=next;setDocument(next);setProjectState(state=>({...state,dirty:true}))
  }
  function edit(cues:Cue[],key='') { editDocument({...documentRef.current,cues},key) }
  function update(patch:Partial<Cue>,key='') { if(cue)edit(documentRef.current.cues.map(item=>item.id===cue.id?{...item,...patch}:item),key) }
  function undo() { if(transferLock.current||!history.length)return;const previous=history[history.length-1],current=structuredClone(documentRef.current);setFuture(values=>[current,...values]);setHistory(values=>values.slice(0,-1));remoteVersion.current=crypto.randomUUID();documentRef.current=previous;setDocument(previous);setProjectState(state=>({...state,dirty:true}));lastEdit.current={key:'',at:0} }
  function redo() { if(transferLock.current||!future.length)return;const next=future[0],current=structuredClone(documentRef.current);setHistory(values=>[...values.slice(-99),current]);setFuture(values=>values.slice(1));remoteVersion.current=crypto.randomUUID();documentRef.current=next;setDocument(next);setProjectState(state=>({...state,dirty:true}));lastEdit.current={key:'',at:0} }
  async function persistCache(next:SubtitleDocument) {
    const owner=activeProject.current
    if(!owner||!next.projectPath||next.projectPath!==activePath.current||next.id!==documentRef.current.id)return
    const task=saveQueue.current.catch(()=>{}).then(()=>{if(activeProject.current===owner&&documentRef.current.id===next.id)return window.muxivra.saveSession(next)})
    saveQueue.current=task;await task
  }
  function adoptSaved(saved:SubtitleDocument,current:SubtitleDocument) {
    if(documentRef.current.id!==saved.id)return
    const next=documentRef.current===current?saved:{...documentRef.current,projectPath:saved.projectPath,mediaPath:saved.mediaPath,sourcePath:saved.sourcePath}
    documentRef.current=next;setDocument(next)
    if(saved.projectPath!==current.projectPath){
      const bind=(value:SubtitleDocument)=>({...value,projectPath:saved.projectPath,mediaPath:saved.mediaPath,sourcePath:saved.sourcePath})
      setHistory(values=>values.map(bind));setFuture(values=>values.map(bind))
    }
  }
  async function flush() {
    await remoteOperation.current
    flushing.current++
    try{
    if(!loaded||!activeProject.current||!documentRef.current.projectPath)return
    const next=documentRef.current,current=await window.muxivra.getSession();if(current?.id!==next.id)return
    await persistCache(next)
    if(next.projectPath) {try{const saved=await window.muxivra.saveSubtitleProject(next);adoptSaved(saved,next)}catch(error){if((await window.muxivra.getSession())?.id===next.id)throw error}}
    setProjectState(await window.muxivra.getSubtitleProjectState())
    }finally{flushing.current--}
  }
  useEffect(()=>{onBeforeLeave?.(flush)},[onBeforeLeave,loaded])
  useEffect(()=>{onBeforeExit?.(async()=>{await remoteOperation.current;if(loaded&&visible)await persistCache(documentRef.current)})},[onBeforeExit,loaded,visible])
  useEffect(()=>{
    let live=true
    void Promise.all([window.muxivra.getSession(),window.muxivra.getSubtitleProjectState()]).then(([session,state])=>{if(!live)return;setProjectState(state);if(session){acceptDocument(session);if(session.mediaPath)activateMedia(session.mediaPath)}}).catch(error=>void run(async()=>{throw error})).finally(()=>{if(live)setLoaded(true)})
    const off=window.muxivra.onUpdate(snapshot=>{const changedProject=activeProject.current!==snapshot.projects?.activeId;activeProject.current=snapshot.projects?.activeId;if(changedProject||snapshot.subtitleProject?.projectPath===documentRef.current.projectPath)activePath.current=snapshot.projects?.items.find(p=>p.id===activeProject.current)?.subtitlePath;if(!activeProject.current&&documentRef.current.projectPath)clearEditor();if(snapshot.subtitleProject&&snapshot.subtitleProject.documentId===documentRef.current.id)setProjectState(snapshot.subtitleProject)})
    return()=>{live=false;off()}
  },[])
  useEffect(()=>{
    if(!loaded||!visible||!activeProject.current||document.projectPath!==activePath.current)return
    let live=true;setCacheState('saving')
    const next=document,timer=setTimeout(()=>{if(next.id!==documentRef.current.id||!activeProject.current)return;void persistCache(next).then(()=>{if(live)setCacheState('saved')}).catch(error=>{if(live&&next.id===documentRef.current.id&&activeProject.current){setCacheState('error');void run(async()=>{throw error})}})},800)
    return()=>{live=false;clearTimeout(timer)}
  },[document,loaded,visible,projectId])
  useEffect(()=>{if(!media||!visible||!projectId||document.projectPath!==activePath.current)return;let live=true;const timer=setTimeout(()=>void window.muxivra.playerSubtitles('subtitles',document).catch(error=>{if(live&&activeProject.current===projectId&&documentRef.current.id===document.id)void run(async()=>{throw error})}),250);return()=>{live=false;clearTimeout(timer)}},[media,document,visible,projectId])
  async function save() {if(!activeProject.current)return;const current=documentRef.current;await persistCache(current);const next=await window.muxivra.saveSubtitleProject(current);adoptSaved(next,current);setProjectState(await window.muxivra.getSubtitleProjectState());return next}
  async function changeSubtitle(operation:()=>Promise<SubtitleDocument>){
    if(transferLock.current||fileChanging)return
    setFileChanging(true)
    try{await flush();transferLock.current=true;const previous=documentRef.current
      fileViews.current.set(previous.id,{history,future,selection,focused,page})
      const next=await operation(),fresh=await window.muxivra.snapshot();setFileProject(fresh.projects?.items.find(item=>item.id===projectId));activePath.current=next.projectPath
      if(next.id===previous.id)adoptSaved(next,previous)
      else {acceptDocument(next);const view=fileViews.current.get(next.id);if(view){setHistory(view.history);setFuture(view.future);setSelection(view.selection);setFocused(view.focused);setPage(view.page)}}
      setProjectState(await window.muxivra.getSubtitleProjectState());setCacheState('saved');setFileDialog(undefined)
    }finally{transferLock.current=false;setFileChanging(false)}
  }
  function quickFormat(command:SubtitleTextCommand,value?:string|number){
    if(!cue||busy||fileChanging)return
    const input=textArea.current,range=input?{start:input.selectionStart,end:input.selectionEnd}:textRange.current
    const next=formatSubtitleText(cue.text,range,command,value);update({text:next.text})
    textRange.current={start:next.start,end:next.end}
    requestAnimationFrame(()=>{textArea.current?.focus();textArea.current?.setSelectionRange(next.start,next.end)})
  }
  function clearEditor(){setReviewPage(false);fileViews.current.clear();acceptDocument(createSubtitleDocument());setMedia('');setTime(0);setDuration(0);setStylesPage(false);setProjectState({dirty:false,saving:false,canDeleteProject:false});setCacheState('saved');playerReady.current=false;openingMedia.current='';pendingSeek.current=undefined}
  async function closeProject(){setClosingProject(true);try{await flush();const id=activeProject.current;if(id)await window.muxivra.closeProject(id);clearEditor()}finally{setClosingProject(false)}}
  function activateMedia(path:string) { playerReady.current=false;openingMedia.current=path;pendingSeek.current=undefined;setDuration(0);setTime(0);setMedia(path);setLoadId(value=>value+1) }
  useEffect(()=>{if(!asrJobId||!visible||!loaded)return;let live=true;void run(async()=>{const draft=await window.muxivra.asrResult(asrJobId);if(live)setAsrDraft(draft)});return()=>{live=false}},[asrJobId,visible,loaded])
  const dismissAsr=()=>{setAsrDraft(undefined);onAsrConsumed?.()}
  async function applyAsr(mode:'append'|'replace'){
    if(!asrDraft)return
    if(documentRef.current.mediaPath!==asrDraft.inputPath)await loadMedia(asrDraft.inputPath)
    if(documentRef.current.mediaPath!==asrDraft.inputPath)throw new Error(tr("尚未打开对应媒体工程，初稿未应用"))
    const cues=asrSubtitleCues(asrDraft.segments,()=>crypto.randomUUID())
    const current=documentRef.current
    editDocument({...current,cues:mode==='replace'?cues:[...current.cues,...cues]},'asr-import')
    setPage(1);setStylesPage(false);await persistCache(documentRef.current);dismissAsr()
  }
  async function loadMedia(path:string) { await flush();const next=await window.muxivra.openSubtitleMedia(path);if(!next)return;acceptDocument(next);activateMedia(next.mediaPath??path);setProjectState(await window.muxivra.getSubtitleProjectState()) }
  function seek(ms:number) { setTime(ms);setSeekRevision(value=>value+1);if(!media)return;if(!playerReady.current){pendingSeek.current=ms;return}void window.muxivra.playerAction('subtitles',{type:'seek',positionMs:ms}).catch(error=>void run(async()=>{throw error})) }
  async function setBoundary(edge:'start'|'end') {
    if(!cue)return
    const projectId=documentRef.current.id,cueId=cue.id
    // Playback notifications are throttled. A shortcut immediately after a
    // seek must read the current player clock, not the previous rendered time.
    const position=media&&playerReady.current?(await window.muxivra.playerState('subtitles')).positionMs:time
    if(documentRef.current.id!==projectId)return
    const value=Math.round(position/10)*10
    edit(documentRef.current.cues.map(item=>item.id===cueId?{...item,[edge==='start'?'startMs':'endMs']:value}:item))
  }
  function choose(id:string,event?:{shiftKey:boolean;ctrlKey:boolean;metaKey:boolean}) {
    if(event?.shiftKey&&selectionAnchor.current){const first=rows.findIndex(row=>row.item.id===selectionAnchor.current),last=rows.findIndex(row=>row.item.id===id);if(first>=0&&last>=0)setSelection(rows.slice(Math.min(first,last),Math.max(first,last)+1).map(row=>row.item.id))}
    else if(event?.ctrlKey||event?.metaKey)setSelection(values=>values.includes(id)?values.filter(value=>value!==id):[...values,id])
    else {setSelection([id]);selectionAnchor.current=id}
    setFocused(id)
  }
  function addCue() { const created:Cue={id:crypto.randomUUID(),startMs:Math.round(time/10)*10,endMs:Math.round(time/10)*10+2000,text:'',layer:0,style:cue?.style??'Default',name:'',marginL:0,marginR:0,marginV:0,effect:'',comment:false};const index=focused?document.cues.findIndex(c=>c.id===focused)+1:document.cues.length;edit([...document.cues.slice(0,index),created,...document.cues.slice(index)]);choose(created.id);setPage(Math.floor(index/50)+1) }
  async function copy() { clipboard.current=copyCues(document.cues,selected);if(clipboard.current.length)await window.muxivra.copyText(clipboardHeader+JSON.stringify(clipboard.current));return clipboard.current.length }
  async function paste() {
    let copied=clipboard.current
    const text=await window.muxivra.readClipboardText()
    if(text.startsWith(clipboardHeader)){const value=JSON.parse(text.slice(clipboardHeader.length));if(!Array.isArray(value)||value.length>10000)throw new Error(tr("剪贴板字幕条目无效"));copied=normalizeSubtitleDocument(subtitleSchema.parse({...document,cues:value})).cues}
    if(!copied.length)throw new Error(tr("请先复制字幕条目"))
    const next=pasteCues(document.cues,copied,focused);edit(next.cues);setSelection(next.ids);setFocused(next.ids[0]);setPage(Math.floor(next.cues.findIndex(c=>c.id===next.ids[0])/50)+1)
  }
  function removeSelected() { const remaining=document.cues.filter(c=>!selected.has(c.id)),index=document.cues.findIndex(c=>selected.has(c.id)),next=remaining[Math.min(index,remaining.length-1)];edit(remaining);setSelection(next?[next.id]:[]);setFocused(next?.id);setDeleteConfirm(false) }
  function split() { if(!cue)return;const next=splitCue(document.cues,cue.id,time,textCursor.current);edit(next.cues);setSelection(next.ids);setFocused(next.ids[1]) }
  function merge() { const next=mergeCues(document.cues,selected);edit(next.cues);choose(next.id) }
  useEffect(()=>{
    if(!visible||stylesPage||reviewPage||!projectId)return
    const listener=(event:KeyboardEvent)=>{
      if(event.defaultPrevented||window.document.querySelector('[role="dialog"], [role="listbox"]'))return
      if((event.ctrlKey||event.metaKey)&&!event.altKey&&event.code==='KeyS'){event.preventDefault();void run(()=>save());return}
      if(event.code==='Escape'&&window.document.querySelector('.player-settings-popover'))return
      if(event.code==='Escape'&&dockExpanded){event.preventDefault();setDockExpanded(false);return}
      if(isShortcutInput(event.target))return
      if(matchShortcut(event,'subtitles.setStart',shortcuts)&&cue){event.preventDefault();void run(()=>setBoundary('start'))}
      else if(matchShortcut(event,'subtitles.setEnd',shortcuts)&&cue){event.preventDefault();void run(()=>setBoundary('end'))}
      else if(matchShortcut(event,'subtitles.undo',shortcuts)){event.preventDefault();undo()}
      else if(matchShortcut(event,'subtitles.redo',shortcuts)){event.preventDefault();redo()}
      else if((event.target as Element)?.closest('.subtitle-event-table')){
        if((event.ctrlKey||event.metaKey)&&event.code==='KeyA'){event.preventDefault();setSelection(rows.map(row=>row.item.id))}
        else if((event.ctrlKey||event.metaKey)&&event.code==='KeyC'){event.preventDefault();void run(copy)}
        else if((event.ctrlKey||event.metaKey)&&event.code==='KeyV'){event.preventDefault();void run(paste)}
        else if(event.code==='Delete'&&selection.length){event.preventDefault();setDeleteConfirm(true)}
      }
    }
    const off=window.muxivra.onPlayerEvent(event=>{if(event.owner!=='subtitles')return;switch(event.type){case 'set-start':update({startMs:Math.round(event.positionMs/10)*10});break;case 'set-end':update({endMs:Math.round(event.positionMs/10)*10});break;case 'undo':undo();break;case 'redo':redo();break}})
    window.addEventListener('keydown',listener,true);return()=>{off();window.removeEventListener('keydown',listener,true)}
  },[visible,stylesPage,reviewPage,projectId,cue,document,history,future,time,shortcuts,selection,rows,loaded,dockExpanded])
  useEffect(()=>{
    if(!visible||!layout.current)return
    const element=layout.current,resize=()=>element.style.setProperty('--subtitle-dock-width',`${element.clientWidth}px`)
    const observer=new ResizeObserver(resize);observer.observe(element);resize();return()=>observer.disconnect()
  },[visible])
  useEffect(()=>{
    const focus=()=>setEditingCue(!!window.document.activeElement?.closest('.subtitle-edit-scroll')&&isShortcutInput(window.document.activeElement))
    window.addEventListener('focusin',focus);window.addEventListener('focusout',focus);return()=>{window.removeEventListener('focusin',focus);window.removeEventListener('focusout',focus)}
  },[])
  useEffect(()=>{
    if(!followPlayback||!visible||stylesPage||reviewPage||editingCue||window.document.querySelector('[role="dialog"],[role="listbox"]'))return
    const playing=playingCues(document.cues,time),ids=playing.map(item=>item.id),next=ids.includes(focused??'')?focused:ids[0]
    setSelection(current=>current.length===ids.length&&current.every((id,index)=>id===ids[index])?current:ids)
    if(next!==focused)setFocused(next)
    if(next){const index=rows.findIndex(row=>row.item.id===next);if(index>=0)setPage(Math.floor(index/50)+1)}
  },[followPlayback,time,document.cues,visible,stylesPage,reviewPage,editingCue,focused,rows])
  useEffect(()=>{
    if(!followPlayback||!focused||editingCue||!visible||stylesPage||reviewPage)return
    const row=layout.current?.querySelector(`[data-cue-id="${focused}"]`),table=row?.closest('.subtitle-event-table')
    if(!row||!table)return
    const rect=row.getBoundingClientRect(),bounds=table.getBoundingClientRect(),header=table.querySelector('thead')?.getBoundingClientRect().height??0
    if(rect.top<bounds.top+header)table.scrollTop+=rect.top-bounds.top-header-4
    else if(rect.bottom>bounds.bottom)table.scrollTop+=rect.bottom-bounds.bottom+4
  },[followPlayback,focused,actualPage,editingCue,visible,stylesPage,reviewPage])
  const sendToMedia=()=>run(async()=>{if(transferLock.current)return;transferLock.current=true;try{await flush();const transfer=await window.muxivra.prepareSubtitleMedia(documentRef.current);const saved=await window.muxivra.getSession();if(saved)adoptSaved(saved,documentRef.current);setProjectState(await window.muxivra.getSubtitleProjectState());onSingle(transfer)}finally{transferLock.current=false}},tr("字幕与媒体已转入单文件处理"))
  const saving=projectState.saving,projectError=projectState.error
  return <div ref={layout} className={`subtitle-layout subtitle-ass-editor${stylesPage||reviewPage?' subtitle-secondary-active':''}${dockExpanded?' subtitle-dock-expanded':''}${srtMode?' subtitle-srt-mode':''}`}>
  {mcpApplying&&<div className="subtitle-ai-status" role="status"><Busy text={tr("AI 正在应用并保存字幕修改…")}/></div>}
  {reviewPage&&<SubtitleReview document={document} name={nameOf(document.projectPath??'')} onBack={()=>setReviewPage(false)}/>}
  {stylesPage&&<SubtitleStyles document={document} onChange={next=>editDocument(next,'style-properties')} onBack={()=>setStylesPage(false)} run={run}/>}
  <div hidden={stylesPage||reviewPage} className="subtitle-editor-primary">
    {srtMode&&<div className="subtitle-format-note">{tr("SRT 导出模式仅编辑时间和纯文本。ASS 样式与事件属性保留在工程中，导出时再降级。")}</div>}
    <div className="subtitle-workspace"><div className="subtitle-main-column"><Card className="subtitle-preview-card" title={tr("媒体")} aside={<span className="hint">{nameOf(media)}</span>}>
      {media?<MpvPlayer owner="subtitles" path={media} loadId={loadId} active={visible&&!stylesPage&&!reviewPage} run={run} onState={state=>{if(openingMedia.current&&state.path!==openingMedia.current)return;openingMedia.current='';playerReady.current=state.ready&&!state.loading&&!!state.path;setDuration(state.durationMs);setPlayback(current=>{const playing=playerReady.current&&!state.paused&&!state.eof&&!state.error;return current.playing===playing&&current.speed===state.speed?current:{playing,speed:state.speed}});if(playerReady.current&&pendingSeek.current!==undefined){const target=pendingSeek.current;pendingSeek.current=undefined;seek(target)}else setTime(state.positionMs)}}/>:<Empty title={tr("未载入媒体")} description={tr("打开已有工程，或前往项目管理创建。")}/>}
      {media&&<AudioWaveform path={media} timeMs={time} durationMs={duration} cue={cue} active={visible&&!stylesPage&&!reviewPage} playing={playback.playing} speed={playback.speed} seekRevision={seekRevision} onSeek={seek}/>}
    </Card>
    <Card className="subtitle-list-card">
      <div className="subtitle-file-heading"><Select aria-label={tr("字幕文件")} value={currentProject?.activeSubtitleId??''} disabled={!projectId||busy||fileChanging} onChange={event=>void run(()=>changeSubtitle(()=>window.muxivra.selectProjectSubtitle(projectId!,event.target.value)))}>{subtitleFiles.length?subtitleFiles.map(file=><option value={file.id} key={file.id}>{file.name}</option>):<option value="">{tr("未打开字幕文件")}</option>}</Select><div className="toolbar"><Button size="icon" variant="ghost" aria-label={tr("重命名字幕文件")} title={tr("重命名字幕文件")} disabled={!projectId||busy||fileChanging} onClick={()=>{setFileName(nameOf(document.projectPath??''));setFileDialog('rename')}}><Pencil size={16}/></Button><Button size="icon" variant="ghost" aria-label={tr("新建字幕文件")} title={tr("新建字幕文件")} disabled={!projectId||busy||fileChanging} onClick={()=>{setFileName('subtitles.ass');setFileDialog('new')}}><FilePlus2 size={16}/></Button><Button size="icon" variant="ghost" aria-label={tr("删除字幕文件")} title={subtitleFiles.length<=1?tr("至少保留一个 ASS 字幕文件"):tr("删除字幕文件")} disabled={subtitleFiles.length<=1||busy||fileChanging} onClick={()=>setFileDialog('delete')}><Trash2 size={16}/></Button></div></div>
      <div className="subtitle-file-meta"><span className="hint">{document.cues.length} {tr("条")}</span><div className="subtitle-follow-control"><label title={tr("自动选择正在显示的字幕；编辑文本和事件属性时暂缓跟随")}><input type="checkbox" checked={followPlayback} onChange={event=>{setFollowPlayback(event.target.checked);if(event.target.checked)setSearch('')}}/>{tr("跟随播放")}</label><span className="hint">{tr("已选")}{selection.length} {tr("条")}</span></div></div>
      <div className="subtitle-list-toolbar"><Button variant="secondary" size="sm" disabled={busy||!loaded||!projectId} onClick={addCue}><Plus size={15}/>{tr("新增字幕")}</Button><Button variant="ghost" size="icon" aria-label={tr("复制条目")} title={tr("复制条目")} disabled={!selection.length||busy} onClick={()=>run(copy)}><Copy size={17}/></Button><Button variant="ghost" size="icon" aria-label={tr("粘贴条目")} title={tr("粘贴条目")} disabled={busy||!projectId} onClick={()=>run(paste)}><ClipboardPaste size={17}/></Button><Button variant="ghost" size="icon" aria-label={tr("删除所选")} title={tr("删除所选")} disabled={!selection.length} onClick={()=>setDeleteConfirm(true)}><Trash2 size={17}/></Button><Button aria-label={tr("拆分条目")} variant="ghost" size="icon" disabled={selection.length!==1||!cue||hasAssTags} title={tr("在播放位置拆分；位置不在字幕内时取时间中点。文本按光标位置拆分。")} onClick={()=>run(async()=>split())}><Scissors size={17}/></Button><Button aria-label={tr("合并所选")} variant="ghost" size="icon" disabled={selection.length<2} title={tr("按条目顺序合并文本，保留第一条样式和属性。")} onClick={()=>run(async()=>merge())}><Combine size={17}/></Button><Button aria-label={tr("搜索与替换")} title={tr("搜索与替换")} variant={searchOpen?'secondary':'ghost'} size="icon" onClick={()=>setSearchOpen(!searchOpen)}><Search size={17}/></Button><Button aria-label={tr("时间偏移")} title={tr("时间偏移")} variant="ghost" size="icon" disabled={!document.cues.length} onClick={()=>setOffsetOpen(true)}><Clock3 size={17}/></Button><Button aria-label={tr("校验字幕")} title={issues.length?tr("校验字幕 · {0} 项提示",issues.length):tr("校验字幕")} variant="ghost" size="icon" onClick={()=>setValidationOpen(true)}><CheckCheck size={17}/></Button><Button className="subtitle-list-preview" aria-label={tr("预览")} title={tr("预览全部字幕")} variant="ghost" size="sm" disabled={!projectId||fileChanging} onClick={()=>{setReviewPage(true);setDockExpanded(false)}}><Eye size={17}/><span>{tr("预览")}</span></Button></div>
      {searchOpen&&<div className="subtitle-inner-card subtitle-search-panel"><div className="form-grid"><Field label={tr("搜索文本")}><Input value={search} onChange={e=>{setSearch(e.target.value);setFollowPlayback(false);setPage(1);setReplaceCount(undefined)}}/></Field><Field label={tr("替换文本")}><Input value={replacement} onChange={e=>setReplacement(e.target.value)}/></Field></div><div className="toolbar"><label><input type="checkbox" checked={caseSensitive} onChange={e=>setCaseSensitive(e.target.checked)}/>{tr("区分大小写")}</label><Select aria-label={tr("替换范围")} value={replaceScope} onChange={e=>setReplaceScope(e.target.value)}><option value="all">{tr("全部条目")}</option><option value="selected">{tr("所选条目")}</option></Select><Button variant="secondary" size="sm" disabled={!search||replaceScope==='selected'&&!selection.length} onClick={()=>{const next=replaceSubtitleText(document.cues,search,replacement,replaceScope==='selected'?selected:undefined,caseSensitive);if(next.count)edit(next.cues);setReplaceCount(next.count)}}>{tr("替换全部")}</Button>{replaceCount!==undefined&&<span className="hint">{tr("已替换")}{replaceCount} {tr("处")}</span>}<Button variant="ghost" size="sm" onClick={()=>{setSearch('');setSearchOpen(false)}}>{tr("关闭搜索")}</Button></div></div>}
      <div className="subtitle-list-body"><div className="subtitle-table-container">
        {rows.length?<div className="cue-list subtitle-event-table"><table className="file-table subtitle-event-table-inner" aria-label={tr("字幕条目")}><thead><tr><th><input type="checkbox" aria-label={tr("选择本页全部字幕")} checked={!!pageRows.length&&pageRows.every(({item})=>selected.has(item.id))} onChange={e=>setSelection(values=>e.target.checked?[...new Set([...values,...pageRows.map(r=>r.item.id)])]:values.filter(id=>!pageRows.some(r=>r.item.id===id)))}/></th><th>#</th><th>{tr("开始 → 结束")}</th><th>{tr("样式")}</th><th>{tr("文本")}</th><th>{tr("时长")}</th></tr></thead><tbody>{pageRows.map(({item,index})=><tr tabIndex={0} data-cue-id={item.id} key={item.id} className={`${selected.has(item.id)?'selected-row':''} ${item.comment?'subtitle-comment-row':''}`} onClick={event=>{choose(item.id,event);seek(item.startMs)}} onKeyDown={event=>{if(event.key==='Enter'){choose(item.id,event);seek(item.startMs)}}}><td><input type="checkbox" aria-label={tr("选择第 {0} 条字幕",index+1)} checked={selected.has(item.id)} onClick={e=>e.stopPropagation()} onChange={e=>{setSelection(values=>e.target.checked?[...new Set([...values,item.id])]:values.filter(id=>id!==item.id));setFocused(item.id);selectionAnchor.current=item.id}}/></td><td>{index+1}{item.comment&&<small>{tr("注释")}</small>}</td><td><code className="subtitle-row-time"><span>{formatTime(item.startMs)}</span><span className="hint">→</span><span>{formatTime(item.endMs)}</span></code></td><td title={[item.style??'Default',item.name].filter(Boolean).join(' · ')}><span className="subtitle-row-style">{item.style??'Default'}</span>{item.name&&<small>{item.name}</small>}</td><td className="cue-row-text" title={item.text}>{item.text.replace(/\n/g,' ↵ ')||<span className="hint">{tr("空字幕")}</span>}</td><td>{((item.endMs-item.startMs)/1000).toFixed(2)}s</td></tr>)}</tbody></table></div>:<Empty title={search?tr("没有匹配条目"):tr("无字幕")} description={search?tr("修改搜索文本，或关闭搜索以显示全部条目。"):undefined}/>}
      </div></div>
      <div className="task-pagination"><span className="hint">{search?tr("{0} 条匹配 · ",rows.length):''}{tr("每页 50 条 · Ctrl / Shift 多选")}</span><div className="toolbar"><Button aria-label={tr("上一页")} title={tr("上一页")} variant="secondary" size="icon" disabled={actualPage===1} onClick={()=>setPage(actualPage-1)}><ChevronLeft size={15}/></Button><Input aria-label={tr("字幕页码")} type="number" min={1} max={pages} value={actualPage} onChange={e=>{const value=+e.target.value;if(Number.isInteger(value)&&value>0&&value<=pages)setPage(value)}}/><span>/ {pages}</span><Button aria-label={tr("下一页")} title={tr("下一页")} variant="secondary" size="icon" disabled={actualPage===pages} onClick={()=>setPage(actualPage+1)}><ChevronRight size={15}/></Button></div></div>
    </Card>
    </div><Card className="subtitle-edit-card" title={cue?tr("编辑第 {0} 条字幕",document.cues.findIndex(c=>c.id===cue.id)+1):tr("编辑字幕")} aside={<Button variant="secondary" size="sm" title={srtMode?tr("切换 ASS/SSA 后编辑样式"):undefined} disabled={srtMode||!projectId||busy} onClick={()=>setStylesPage(true)}><Palette size={15}/>{tr("样式与脚本设置")}</Button>}>
      {cue?<div className="subtitle-edit-scroll"><div className="subtitle-inner-card"><div className="form-grid"><TimeInput label={tr("开始时间")} value={cue.startMs} onCommit={value=>update({startMs:value})} run={run}/><TimeInput label={tr("结束时间")} value={cue.endMs} onCommit={value=>update({endMs:value})} run={run}/></div><TimeInput label={tr("时长")} value={Math.max(0,cue.endMs-cue.startMs)} onCommit={value=>{if(value<=0||cue.startMs+value>359999999)throw new Error(tr("时长必须大于零，结束时间不能超过 99:59:59,999"));update({endMs:cue.startMs+value})}} run={run}/><div className="toolbar"><Button size="sm" variant="secondary" title={shortcutTitle(tr("设置起点"),'subtitles.setStart')} onClick={()=>run(()=>setBoundary('start'))}>{tr("设置起点")}</Button><Button size="sm" variant="secondary" title={shortcutTitle(tr("设置终点"),'subtitles.setEnd')} onClick={()=>run(()=>setBoundary('end'))}>{tr("设置终点")}</Button><Button size="sm" variant="ghost" onClick={()=>seek(cue.startMs)}><Play size={14}/>{tr("定位")}</Button></div></div>
        <div className="subtitle-inner-card"><Field label={tr("字幕文本")} hint={srtMode&&hasAssTags?tr("此条含 ASS 标签，请切换 ASS/SSA 后编辑文本。"):undefined}><textarea ref={textArea} className="input cue-text" aria-label={tr("字幕文本")} disabled={srtMode&&hasAssTags} value={cue.text} onChange={event=>update({text:event.target.value},`text:${cue.id}`)} onSelect={event=>{textCursor.current=event.currentTarget.selectionStart;textRange.current={start:event.currentTarget.selectionStart,end:event.currentTarget.selectionEnd}}}/></Field><div className="toolbar subtitle-format-tools">{!srtMode&&<>{([{id:'bold',label:tr("粗体"),icon:Bold},{id:'italic',label:tr("斜体"),icon:Italic},{id:'underline',label:tr("下划线"),icon:Underline},{id:'strike',label:tr("删除线"),icon:Strikethrough},{id:'clear',label:tr("清除选区格式"),icon:RemoveFormatting},{id:'reset',label:tr("插入样式重置"),icon:Undo2}] as const).map(tool=><Button key={tool.id} size="icon" variant="ghost" aria-label={tr(tool.label)} title={tr(tool.label)} onMouseDown={event=>event.preventDefault()} onClick={()=>run(async()=>quickFormat(tool.id))}><tool.icon size={17}/></Button>)}<span className="toolbar-divider"/><Button size="icon" variant="ghost" aria-label={tr("字体大小")} title={tr("字体大小")} onClick={()=>{setFontSize(document.styles?.find(style=>style.name===(cue.style??'Default'))?.fontSize??48);setFontDialog(true)}}><Type size={17}/></Button><label className="subtitle-color-tool" title={tr("文字颜色")} aria-label={tr("文字颜色")}><Palette size={17}/><input type="color" aria-label={tr("文字颜色")} defaultValue="#ffffff" onChange={event=>void run(async()=>quickFormat('color',event.target.value))}/></label>{([{value:8,label:tr("顶部居中"),icon:AlignVerticalJustifyStart},{value:5,label:tr("垂直居中"),icon:AlignVerticalJustifyCenter},{value:2,label:tr("底部居中"),icon:AlignVerticalJustifyEnd}]).map(tool=><Button key={tool.value} variant="ghost" size="icon" aria-label={tr(tool.label)} title={tr(tool.label)} onMouseDown={event=>event.preventDefault()} onClick={()=>run(async()=>quickFormat('align',tool.value))}><tool.icon size={17}/></Button>)}</>}<Button size="icon" variant="ghost" aria-label={tr("插入换行")} title={tr("插入换行")} disabled={srtMode&&hasAssTags} onMouseDown={event=>event.preventDefault()} onClick={()=>run(async()=>quickFormat('newline'))}><WrapText size={17}/></Button></div></div>
        <details className="subtitle-event-properties" ><summary>{tr("事件属性")}{srtMode&&tr(" · SRT 模式不可编辑")}</summary><fieldset disabled={srtMode}><div className="form-grid"><Field label={tr("类型")}><Select disabled={srtMode} value={cue.comment?'comment':'dialogue'} onChange={e=>update({comment:e.target.value==='comment'})}><option value="dialogue">{tr("对白")}</option><option value="comment">{tr("注释")}</option></Select></Field><Field label={tr("图层")}><Input type="number" min={0} max={2147483647} value={cue.layer??0} onChange={e=>{const value=+e.target.value;if(Number.isInteger(value)&&value>=0&&value<=2147483647)update({layer:value})}}/></Field><Field label={tr("样式")}><Select disabled={srtMode} value={cue.style??'Default'} onChange={e=>update({style:e.target.value})}>{document.styles?.map(style=><option value={style.name} key={style.name}>{style.name}</option>)}</Select></Field><Field label={tr("角色")}><Input value={cue.name??''} onChange={e=>update({name:e.target.value.replace(/[,\r\n]/g,'')},`name:${cue.id}`)}/></Field>{(['marginL','marginR','marginV'] as const).map((key,i)=><Field label={[tr("左边距"),tr("右边距"),tr("垂直边距")][i]} key={key}><Input type="number" min={0} max={99999} value={cue[key]??0} onChange={e=>{const value=+e.target.value;if(Number.isInteger(value)&&value>=0&&value<=99999)update({[key]:value})}}/></Field>)}<Field label={tr("效果")}><Input value={cue.effect??''} onChange={e=>update({effect:e.target.value.replace(/[,\r\n]/g,'')},`effect:${cue.id}`)}/></Field></div></fieldset></details>
      </div>:<Empty title={tr("未选择字幕")} description={tr("选择条目开始编辑，或新增字幕。")}/>}
    </Card></div>
  {asrDraft&&<Modal title={tr("应用 ASR 字幕初稿")} locked={busy} onClose={dismissAsr}><p>{asrDraft.model.name} · {asrDraft.segments.filter(s=>s.startMs!==undefined).length} {tr("条带时间字幕")}</p><p className="path-text">{asrDraft.inputPath}</p><p className="hint">{tr("初稿将应用到此媒体对应的 ASS 工程。追加会保留原有条目；替换仅改变字幕条目，保留样式和脚本设置，可通过撤销恢复。")}</p>{asrDraft.segments.some(s=>s.startMs===undefined)&&<p className="hint">{tr("未打轴文本会保留为起止均为 0 秒的 ASS 注释条目；设定时间并取消注释后即可使用。")}</p>}{asrDraft.segments.some(s=>s.estimated)&&<p className="hint">{tr("部分时间由音频分块范围估算，请根据需要手动校正。")}</p>}<div className="toolbar"><Button variant="secondary" disabled={busy} onClick={dismissAsr}>{tr("取消")}</Button><Button variant="secondary" disabled={busy} onClick={()=>run(()=>applyAsr('replace'),tr("字幕初稿已应用"))}>{tr("替换条目")}</Button><Button disabled={busy} onClick={()=>run(()=>applyAsr('append'),tr("字幕初稿已追加"))}>{tr("追加到工程")}</Button></div></Modal>}
  </div>
  <div hidden={reviewPage} className="subtitle-dock"><Card className="subtitle-project-card"><div className="subtitle-dock-summary"><strong>{snapshot.projects?.items.find(p=>p.id===projectId)?.name??tr("未打开工程")}</strong><span className={projectState.dirty?'subtitle-unsaved':'hint'}>{saving?tr("正在保存…"):projectError?tr("保存未完成"):projectId&&projectState.dirty?tr("尚未保存"):projectId?tr("已保存"):tr("请打开已有工程")}</span>{projectId&&!dockExpanded&&<Button className="subtitle-dock-save" aria-label={tr("保存工程")} title={tr("保存工程")} size="sm" variant="secondary" disabled={busy||saving} onClick={()=>run(()=>save())}><Save size={15}/><span>{tr("保存工程")}</span></Button>}<Button className="subtitle-to-media" aria-label={tr("转到单文件处理")} title={tr("转到单文件处理")} variant="secondary" size="sm" disabled={busy||saving||!projectId||!loaded} onClick={sendToMedia}><ArrowRight size={15}/><span>{tr("单文件处理")}</span></Button><Button variant="ghost" size="sm" onClick={onProjects}>{tr("项目管理")}</Button><Button variant="ghost" size="icon" aria-label={dockExpanded?tr("收起工程栏"):tr("展开工程栏")} aria-expanded={dockExpanded} onClick={()=>setDockExpanded(v=>!v)}>{dockExpanded?<ChevronDown size={18}/>:<ChevronUp size={18}/>}</Button></div><div hidden={!dockExpanded}><div className="subtitle-project-top"><div className="subtitle-project-location"><strong>{tr("ASS 工程")}</strong><span title={document.projectPath}>{document.projectPath??tr("尚未创建工程")}</span></div><div className="subtitle-project-status" role="status">{!loaded?<Busy text={tr("读取工程…")}/>:saving?<Busy text={tr("保存工程中…")}/>:projectError?<span className="error-inline">{tr("保存未完成")}</span>:projectState.dirty?<span className="subtitle-unsaved">{tr("尚未保存")}</span>:document.projectPath?<span className="status status-completed">{tr("ASS 工程已保存")}</span>:null}{projectState.lastSavedAt&&<small>{new Date(projectState.lastSavedAt).toLocaleTimeString(uiLocale(),{hour12:false})}</small>}</div></div>
    <div className="subtitle-project-toolbar"><div className="toolbar"><ProjectSwitcher snapshot={snapshot} run={run} busy={busy||!loaded||closingProject} onProjects={onProjects} beforeOpen={flush} onOpened={next=>{acceptDocument(next);if(next.mediaPath)activateMedia(next.mediaPath)}} onClose={()=>run(closeProject)}/><Button variant="secondary" size="sm" disabled={busy||saving||!projectId||!loaded} onClick={()=>run(save)}><Save size={16}/>{tr("保存工程")}</Button><Button variant="ghost" size="icon" aria-label={tr("撤销")} disabled={!history.length||busy} onClick={undo}><Undo2 size={17}/></Button><Button variant="ghost" size="icon" aria-label={tr("重做")} disabled={!future.length||busy} onClick={redo}><Redo2 size={17}/></Button></div><div className="toolbar"><span className="hint">{tr("编辑模式")}</span><Select aria-label={tr("编辑模式")} value={exportFormat} disabled={busy||!projectId} onChange={event=>editDocument({...document,exportFormat:event.target.value as SubtitleFormat})}><option value="ass">ASS</option><option value="ssa">SSA</option><option value="srt">SRT</option></Select></div></div><div className="subtitle-project-footer"><span>{tr("每 60 秒自动保存 ASS")}</span>{projectId&&<span className="hint">{cacheState==='saving'?tr("保存恢复缓存…"):cacheState==='error'?tr("恢复缓存未保存"):tr("恢复缓存已更新")}</span>}</div></div></Card></div>

  {fileDialog&&<Modal title={fileDialog==='new'?tr("新建字幕文件"):fileDialog==='rename'?tr("重命名字幕文件"):tr("删除字幕文件？")} locked={busy||fileChanging} onClose={()=>setFileDialog(undefined)}>{fileDialog==='delete'?<p>{tr("将删除")}{nameOf(document.projectPath??'')}{tr("。其他字幕文件与源媒体保持不变。")}</p>:<Field label={tr("ASS 文件名称")}><Input autoFocus maxLength={180} value={fileName} onChange={event=>setFileName(event.target.value)}/></Field>}{fileDialog==='new'&&<p className="hint">{tr("创建空白 ASS 字幕，同名文件自动编号。")}</p>}<div className="toolbar"><Button variant="secondary" disabled={busy||fileChanging} onClick={()=>setFileDialog(undefined)}>{tr("取消")}</Button><Button disabled={busy||fileChanging||fileDialog!=='delete'&&!fileName.trim()} loading={fileChanging} loadingText={tr("处理中…")} onClick={()=>run(()=>changeSubtitle(()=>fileDialog==='new'?window.muxivra.createProjectSubtitle(projectId!,fileName):fileDialog==='rename'?window.muxivra.renameProjectSubtitle(projectId!,currentProject!.activeSubtitleId,fileName):window.muxivra.deleteProjectSubtitle(projectId!,currentProject!.activeSubtitleId)))}>{fileDialog==='delete'?tr("删除"):fileDialog==='new'?tr("创建"):tr("保存")}</Button></div></Modal>}
  {fontDialog&&<Modal title={tr("字体大小")} onClose={()=>setFontDialog(false)}><Field label={tr("字号（脚本像素）")}><Input type="number" min={1} max={10000} value={fontSize} onChange={event=>setFontSize(Number(event.target.value))}/></Field><div className="toolbar"><Button variant="secondary" onClick={()=>setFontDialog(false)}>{tr("取消")}</Button><Button onClick={()=>run(async()=>{quickFormat('size',fontSize);setFontDialog(false)})}>{tr("应用")}</Button></div></Modal>}
  {deleteConfirm&&<Modal title={tr("删除所选字幕？")} onClose={()=>setDeleteConfirm(false)}><p>{tr("删除")}{selection.length} {tr("条字幕。可通过撤销恢复。")}</p><div className="subtitle-dialog-actions"><Button variant="secondary" onClick={()=>setDeleteConfirm(false)}>{tr("取消")}</Button><Button onClick={removeSelected}>{tr("删除字幕")}</Button></div></Modal>}
  {offsetOpen&&<Modal title={tr("时间偏移")} onClose={()=>setOffsetOpen(false)}><Field label={tr("偏移（毫秒）")}><Input type="number" value={offset} onChange={e=>setOffset(+e.target.value)}/></Field><div className="form-grid"><Field label={tr("偏移范围")}><Select value={offsetScope} onChange={e=>setOffsetScope(e.target.value)}><option value="selected">{tr("所选条目 (")}{selection.length})</option><option value="all">{tr("全部条目")}</option><option value="from">{tr("当前条目及之后")}</option></Select></Field><Field label={tr("偏移时间")}><Select value={offsetEdge} onChange={e=>setOffsetEdge(e.target.value as typeof offsetEdge)}><option value="both">{tr("开始与结束")}</option><option value="start">{tr("仅开始")}</option><option value="end">{tr("仅结束")}</option></Select></Field></div><div className="subtitle-dialog-actions"><Button variant="secondary" onClick={()=>setOffsetOpen(false)}>{tr("取消")}</Button><Button onClick={()=>run(async()=>{const ids=offsetScope==='all'?new Set(document.cues.map(c=>c.id)):offsetScope==='from'?new Set(document.cues.slice(Math.max(0,document.cues.findIndex(c=>c.id===focused))).map(c=>c.id)):selected;if(!ids.size)throw new Error(tr("请先选择字幕条目"));edit(shiftCues(document.cues,ids,offset,offsetEdge));setOffsetOpen(false)})}>{tr("应用偏移")}</Button></div></Modal>}
  {validationOpen&&<Modal title={tr("字幕校验")} onClose={()=>setValidationOpen(false)} wide>{issues.length?<div className="subtitle-validation-list">{issues.slice(0,200).map((issue,i)=><button key={i} onClick={()=>{choose(issue.id);setSearch('');setPage(Math.floor((issue.row-1)/50)+1);setValidationOpen(false)}}><span className={issue.kind==='error'?'error-inline':'hint'}>{issue.kind==='error'?tr("错误"):tr("提示")}</span><strong>{tr("第")}{issue.row} {tr("条")}</strong><span>{issue.message}</span></button>)}{issues.length>200&&<p className="hint">{tr("共")}{issues.length} {tr("项，此处显示前 200 项。")}</p>}</div>:<p>{tr("未发现时间或样式问题。")}</p>}<p className="hint">{tr("时间重叠可能用于多层排版，按实际画面判断。ASS 工程可保留编辑中的草稿。")}</p></Modal>}

  </div>
}
