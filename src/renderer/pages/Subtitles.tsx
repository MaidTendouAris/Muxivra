import { useState, useRef, useEffect, useMemo } from 'react'
import { Plus, Download, Undo2, Redo2, Film, Subtitles as SubtitleIcon, Trash2, Clock3, Play, Save, FolderOpen, Palette, Copy, ClipboardPaste, Scissors, Combine, Search, CheckCheck, ChevronLeft, ChevronRight } from 'lucide-react'
import type { Cue, SubtitleDocument, MediaInfo } from '../../shared/types'
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

type ProjectState={documentId?:string;projectPath?:string;lastSavedAt?:string;dirty:boolean;saving:boolean;error?:string;recoveryPending?:boolean;backupPath?:string}
const clipboardHeader='MUXIVRA_SUBTITLE_CUES_V2\n'
function TimeInput({label,value,onCommit,run}:{label:string;value:number;onCommit:(value:number)=>void;run:RunAction}) {
  const [text,setText]=useState(formatTime(value));useEffect(()=>setText(formatTime(value)),[value])
  const commit=()=>void run(async()=>{try{const next=parseTime(text);if(next<0||next>359999999)throw new Error('时间不能超过 99:59:59,999');if(next!==value)onCommit(next)}catch(error){setText(formatTime(value));throw error}})
  return <Field label={label}><Input value={text} onChange={event=>setText(event.target.value)} onBlur={commit} onKeyDown={event=>{if(event.key==='Enter')event.currentTarget.blur()}}/></Field>
}
export function Subtitles({run,busy,visible,onBeforeLeave,onBeforeExit}:{run:RunAction;busy:boolean;visible:boolean;onBeforeLeave?:(save:()=>Promise<void>)=>void;onBeforeExit?:(save:()=>Promise<void>)=>void}) {
  const shortcuts=useShortcuts(),shortcutTitle=(label:string,id:ShortcutId)=>shortcuts[id]?`${label} · ${formatShortcut(shortcuts[id])}`:label
  const [document,setDocument]=useState<SubtitleDocument>(()=>createSubtitleDocument()),[selection,setSelection]=useState<string[]>([]),[focused,setFocused]=useState<string>(),[history,setHistory]=useState<SubtitleDocument[]>([]),[future,setFuture]=useState<SubtitleDocument[]>([])
  const [projectState,setProjectState]=useState<ProjectState>({dirty:false,saving:false}),[cacheState,setCacheState]=useState<'saving'|'saved'|'error'>('saved'),[loaded,setLoaded]=useState(false),[stylesPage,setStylesPage]=useState(false)
  const [media,setMedia]=useState(''),[loadId,setLoadId]=useState(0),[time,setTime]=useState(0),[duration,setDuration]=useState(0),[waveform,setWaveform]=useState<number[]>([]),[waveformError,setWaveformError]=useState(''),[waveformLoading,setWaveformLoading]=useState(false)
  const [page,setPage]=useState(1),[searchOpen,setSearchOpen]=useState(false),[search,setSearch]=useState(''),[replacement,setReplacement]=useState(''),[caseSensitive,setCaseSensitive]=useState(false),[replaceScope,setReplaceScope]=useState('all'),[replaceCount,setReplaceCount]=useState<number>()
  const [offsetOpen,setOffsetOpen]=useState(false),[offset,setOffset]=useState(0),[offsetScope,setOffsetScope]=useState('selected'),[offsetEdge,setOffsetEdge]=useState<'both'|'start'|'end'>('both'),[validationOpen,setValidationOpen]=useState(false)
  const [deleteConfirm,setDeleteConfirm]=useState(false),[exportLosses,setExportLosses]=useState<string[]|undefined>(),[exporting,setExporting]=useState(false)
  const canvas=useRef<HTMLCanvasElement>(null),mediaGeneration=useRef(0),waveformSource=useRef(''),playerReady=useRef(false),openingMedia=useRef(''),pendingSeek=useRef<number|undefined>(undefined),documentRef=useRef(document),selectionAnchor=useRef<string|undefined>(undefined),textCursor=useRef(0),clipboard=useRef<Cue[]>([]),lastEdit=useRef({key:'',at:0}),saveQueue=useRef<Promise<void>>(Promise.resolve())
  documentRef.current=document
  const cue=document.cues.find(item=>item.id===focused),selected=new Set(selection),exportFormat=document.exportFormat??'ass',srtMode=exportFormat==='srt',issues=useMemo(()=>subtitleIssues(document),[document.cues,document.styles]),hasAssTags=!!cue&&/{\s*\\/.test(cue.text)
  const rows=useMemo(()=>document.cues.map((item,index)=>({item,index})).filter(({item})=>!search||(caseSensitive?item.text.includes(search):item.text.toLowerCase().includes(search.toLowerCase()))),[document.cues,search,caseSensitive]),pages=Math.max(1,Math.ceil(rows.length/50)),actualPage=Math.min(page,pages),pageRows=rows.slice((actualPage-1)*50,actualPage*50)

  function acceptDocument(next:SubtitleDocument) { const normalized=normalizeSubtitleDocument(next);documentRef.current=normalized;setDocument(normalized);setSelection(normalized.cues[0]?[normalized.cues[0].id]:[]);setFocused(normalized.cues[0]?.id);setHistory([]);setFuture([]);setPage(1);setSearch('');lastEdit.current={key:'',at:0} }
  function editDocument(next:SubtitleDocument,key='') {
    const previous=documentRef.current,now=Date.now()
    if(JSON.stringify(next)===JSON.stringify(previous))return
    if(!key||lastEdit.current.key!==key||now-lastEdit.current.at>750)setHistory(values=>[...values.slice(-99),structuredClone(previous)])
    lastEdit.current={key,at:now};setFuture([]);documentRef.current=next;setDocument(next);setProjectState(state=>({...state,dirty:true}))
  }
  function edit(cues:Cue[],key='') { editDocument({...documentRef.current,cues},key) }
  function update(patch:Partial<Cue>,key='') { if(cue)edit(documentRef.current.cues.map(item=>item.id===cue.id?{...item,...patch}:item),key) }
  function undo() { if(!history.length)return;const previous=history[history.length-1];setFuture(values=>[structuredClone(documentRef.current),...values]);setHistory(values=>values.slice(0,-1));documentRef.current=previous;setDocument(previous);setProjectState(state=>({...state,dirty:true}));lastEdit.current={key:'',at:0} }
  function redo() { if(!future.length)return;const next=future[0];setHistory(values=>[...values.slice(-99),structuredClone(documentRef.current)]);setFuture(values=>values.slice(1));documentRef.current=next;setDocument(next);setProjectState(state=>({...state,dirty:true}));lastEdit.current={key:'',at:0} }
  async function persistCache(next:SubtitleDocument) {
    const task=saveQueue.current.catch(()=>{}).then(()=>window.muxivra.saveSession(next));saveQueue.current=task;await task
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
    if(!loaded)return
    const next=documentRef.current;await persistCache(next)
    if(next.projectPath) { const saved=await window.muxivra.saveSubtitleProject(next);adoptSaved(saved,next) }
    setProjectState(await window.muxivra.getSubtitleProjectState())
  }
  useEffect(()=>{onBeforeLeave?.(flush)},[onBeforeLeave,loaded])
  useEffect(()=>{onBeforeExit?.(async()=>{if(loaded)await persistCache(documentRef.current)})},[onBeforeExit,loaded])
  useEffect(()=>{
    let live=true
    void Promise.all([window.muxivra.getSession(),window.muxivra.getSubtitleProjectState()]).then(([session,state])=>{if(!live)return;setProjectState(state);if(session){acceptDocument(session);if(session.mediaPath)activateMedia(session.mediaPath)}}).catch(error=>void run(async()=>{throw error})).finally(()=>{if(live)setLoaded(true)})
    const off=window.muxivra.onUpdate(snapshot=>{if(snapshot.subtitleProject&&snapshot.subtitleProject.documentId===documentRef.current.id)setProjectState(snapshot.subtitleProject)})
    return()=>{live=false;off()}
  },[])
  useEffect(()=>{
    if(!loaded)return
    let live=true;setCacheState('saving')
    const next=document,timer=setTimeout(()=>{void persistCache(next).then(()=>{if(live)setCacheState('saved')}).catch(error=>{if(live)setCacheState('error');void run(async()=>{throw error})})},800)
    return()=>{live=false;clearTimeout(timer)}
  },[document,loaded])
  useEffect(()=>{if(!media)return;const timer=setTimeout(()=>void window.muxivra.playerSubtitles('subtitles',document).catch(error=>void run(async()=>{throw error})),250);return()=>clearTimeout(timer)},[media,document])
  async function save(as=false) {
    const current=documentRef.current;await persistCache(current)
    const next=await (as||!current.projectPath?window.muxivra.saveSubtitleProjectAs(current):window.muxivra.saveSubtitleProject(current))
    if(next)adoptSaved(next,current)
    setProjectState(await window.muxivra.getSubtitleProjectState());return next
  }
  function activateMedia(path:string) { playerReady.current=false;openingMedia.current=path;pendingSeek.current=undefined;setDuration(0);setTime(0);setMedia(path);setLoadId(value=>value+1);updateWaveform({path}) }
  async function loadMedia(path:string) { await flush();const next=await window.muxivra.openSubtitleMedia(path);if(!next)return;acceptDocument(next);activateMedia(path);setProjectState(await window.muxivra.getSubtitleProjectState()) }
  async function importSubtitles(path:string) { await flush();const next=await window.muxivra.readSubtitles(path);if(!next)return;acceptDocument(next);if(next.mediaPath&&next.mediaPath!==media)activateMedia(next.mediaPath);setProjectState(await window.muxivra.getSubtitleProjectState()) }
  function updateWaveform(info:Pick<MediaInfo,'path'>) { if(waveformSource.current===info.path)return;waveformSource.current=info.path;setWaveform([]);setWaveformError('');setWaveformLoading(true);const generation=++mediaGeneration.current;void window.muxivra.waveform(info.path).then(wave=>{if(generation===mediaGeneration.current)setWaveform(wave)}).catch(error=>{if(generation===mediaGeneration.current)setWaveformError(error.message)}).finally(()=>{if(generation===mediaGeneration.current)setWaveformLoading(false)}) }
  function seek(ms:number) { setTime(ms);if(!media)return;if(!playerReady.current){pendingSeek.current=ms;return}void window.muxivra.playerAction('subtitles',{type:'seek',positionMs:ms}).catch(error=>void run(async()=>{throw error})) }
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
    if(text.startsWith(clipboardHeader)){const value=JSON.parse(text.slice(clipboardHeader.length));if(!Array.isArray(value)||value.length>10000)throw new Error('剪贴板字幕条目无效');copied=normalizeSubtitleDocument(subtitleSchema.parse({...document,cues:value})).cues}
    if(!copied.length)throw new Error('请先复制字幕条目')
    const next=pasteCues(document.cues,copied,focused);edit(next.cues);setSelection(next.ids);setFocused(next.ids[0]);setPage(Math.floor(next.cues.findIndex(c=>c.id===next.ids[0])/50)+1)
  }
  function removeSelected() { const remaining=document.cues.filter(c=>!selected.has(c.id)),index=document.cues.findIndex(c=>selected.has(c.id)),next=remaining[Math.min(index,remaining.length-1)];edit(remaining);setSelection(next?[next.id]:[]);setFocused(next?.id);setDeleteConfirm(false) }
  function split() { if(!cue)return;const next=splitCue(document.cues,cue.id,time,textCursor.current);edit(next.cues);setSelection(next.ids);setFocused(next.ids[1]) }
  function merge() { const next=mergeCues(document.cues,selected);edit(next.cues);choose(next.id) }
  async function exportNow() { setExporting(true);try{await flush();const path=await window.muxivra.exportSubtitles(documentRef.current,documentRef.current.exportFormat??'ass');if(path)setExportLosses(undefined);return path}finally{setExporting(false)} }
  async function prepareExport() { await persistCache(documentRef.current);const losses=await window.muxivra.subtitleExportLosses(documentRef.current,exportFormat);if(losses.length){setExportLosses(losses);return}return exportNow() }
  useEffect(()=>{
    if(!visible||stylesPage)return
    const listener=(event:KeyboardEvent)=>{
      if(event.defaultPrevented||window.document.querySelector('[role="dialog"], [role="listbox"]'))return
      if((event.ctrlKey||event.metaKey)&&!event.altKey&&event.code==='KeyS'){event.preventDefault();void run(()=>save());return}
      if(isShortcutInput(event.target))return
      if(matchShortcut(event,'subtitles.setStart',shortcuts)&&cue){event.preventDefault();update({startMs:Math.round(time/10)*10})}
      else if(matchShortcut(event,'subtitles.setEnd',shortcuts)&&cue){event.preventDefault();update({endMs:Math.round(time/10)*10})}
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
    window.addEventListener('keydown',listener);return()=>{off();window.removeEventListener('keydown',listener)}
  },[visible,stylesPage,cue,document,history,future,time,shortcuts,selection,rows,loaded])
  useEffect(()=>{
    const element=canvas.current,context=element?.getContext('2d');if(!element||!context)return
    const {width,height}=element;context.clearRect(0,0,width,height);context.fillStyle='#8ea65d';const step=Math.max(1,Math.floor(waveform.length/width))
    for(let x=0;x<width;x+=2){let amplitude=0;for(let i=Math.floor(x/width*waveform.length);i<Math.min(waveform.length,Math.floor(x/width*waveform.length)+step);i++)amplitude=Math.max(amplitude,waveform[i]);const size=Math.max(1,amplitude*height*.85);context.fillRect(x,(height-size)/2,1,size)}
    if(cue&&duration){context.fillStyle='rgba(142,166,93,.16)';context.fillRect(cue.startMs/duration*width,0,(cue.endMs-cue.startMs)/duration*width,height)}
    context.strokeStyle='#cfdf8c';const x=duration?time/duration*width:0;context.beginPath();context.moveTo(x,0);context.lineTo(x,height);context.stroke()
  },[waveform,time,duration,visible,stylesPage,cue])
  const saving=projectState.saving,projectError=projectState.error
  return <div className="subtitle-layout subtitle-ass-editor"><Card className="subtitle-project-card"><div className="subtitle-project-top"><div className="subtitle-project-location"><strong>ASS 工程</strong><span title={document.projectPath}>{document.projectPath??'尚未创建工程'}</span></div><div className="subtitle-project-status" role="status">{!loaded?<Busy text="读取工程…"/>:saving?<Busy text="保存工程中…"/>:projectError?<span className="error-inline">保存未完成</span>:projectState.dirty?<span className="subtitle-unsaved">尚未保存</span>:document.projectPath?<span className="status status-completed">ASS 工程已保存</span>:null}{projectState.lastSavedAt&&<small>{new Date(projectState.lastSavedAt).toLocaleTimeString('zh-CN',{hour12:false})}</small>}</div></div>
    <div className="subtitle-project-toolbar"><div className="toolbar"><Button variant="secondary" disabled={busy||!loaded} onClick={()=>run(async()=>{const paths=await window.muxivra.selectFiles('media');if(paths[0])await loadMedia(paths[0])})}><Film size={16}/>载入媒体</Button><Button variant="secondary" disabled={busy||!loaded} onClick={()=>run(async()=>{const paths=await window.muxivra.selectFiles('subtitle');if(paths[0])await importSubtitles(paths[0])})}><SubtitleIcon size={16}/>导入字幕</Button><Button variant="secondary" disabled={busy||saving||!loaded} title="Ctrl + S" loadingText="保存中…" onClick={()=>run(()=>save())}><Save size={16}/>保存工程</Button><Button variant="ghost" disabled={busy||saving||!loaded} onClick={()=>run(()=>save(true))}>工程另存为</Button><Button variant="ghost" size="icon" aria-label="撤销" title={shortcutTitle('撤销','subtitles.undo')} disabled={!history.length||busy} onClick={undo}><Undo2 size={17}/></Button><Button variant="ghost" size="icon" aria-label="重做" title={shortcutTitle('重做','subtitles.redo')} disabled={!future.length||busy} onClick={redo}><Redo2 size={17}/></Button></div><div className="toolbar subtitle-export-toolbar"><Select aria-label="导出格式" value={exportFormat} disabled={busy} onChange={e=>editDocument({...document,exportFormat:e.target.value as SubtitleFormat})}><option value="ass">ASS</option><option value="ssa">SSA</option><option value="srt">SRT</option></Select><Button disabled={busy||!document.cues.length||saving} loading={exporting} loadingText="导出中…" onClick={()=>run(prepareExport,'字幕已导出')}><Download size={16}/>导出字幕</Button></div></div>
    <div className="subtitle-project-footer"><span>每 60 秒自动保存 ASS 工程</span><span>{cacheState==='saving'?<Busy text="备份编辑中…"/>:cacheState==='error'?'恢复缓存未保存':'恢复缓存已更新'}</span>{document.projectPath&&<Button variant="ghost" size="sm" onClick={()=>run(()=>window.muxivra.reveal(document.projectPath!))}><FolderOpen size={14}/>工程位置</Button>}</div>{projectError&&<p className="error-inline" role="alert">{projectError}{projectState.recoveryPending&&'；请另存工程以保留恢复内容。'}</p>}
  </Card>
  {stylesPage?<SubtitleStyles document={document} onChange={next=>editDocument(next,'style-properties')} onBack={()=>setStylesPage(false)} run={run}/>:<>
    {srtMode&&<div className="subtitle-format-note">SRT 导出模式仅编辑时间和纯文本。ASS 样式与事件属性保留在工程中，导出时再降级。</div>}
    <div className="subtitle-workspace"><Card title="媒体" aside={<span className="hint">{nameOf(media)}</span>}>
      {media?<MpvPlayer owner="subtitles" path={media} loadId={loadId} active={visible&&!stylesPage} run={run} onMediaChange={updateWaveform} onState={state=>{if(openingMedia.current&&state.path!==openingMedia.current)return;openingMedia.current='';playerReady.current=state.ready&&!state.loading&&!!state.path;setDuration(state.durationMs);if(playerReady.current&&pendingSeek.current!==undefined){const target=pendingSeek.current;pendingSeek.current=undefined;seek(target)}else setTime(state.positionMs)}}/>:<Empty title="未载入媒体" description="载入视频或音频后，将创建或打开同名 ASS 工程。"/>}
      {waveformLoading&&<div className="waveform-loading" role="status"><Busy text="正在生成音频波形…"/><div className="activity-line"/></div>}{waveform.length>0&&<canvas className="waveform" ref={canvas} width={1000} height={72} aria-label="音频波形，点击定位" onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();seek(Math.round((event.clientX-rect.left)/rect.width*duration))}}/>}{waveformError&&<small className="hint" title={waveformError}>波形不可用</small>}
    </Card><Card title={cue?`编辑第 ${document.cues.findIndex(c=>c.id===cue.id)+1} 条字幕`:'编辑字幕'} aside={<Button variant="secondary" size="sm" disabled={srtMode} title={srtMode?'切换 ASS/SSA 后编辑样式':undefined} onClick={()=>setStylesPage(true)}><Palette size={15}/>样式与脚本设置</Button>}>
      {cue?<><div className="subtitle-inner-card"><div className="form-grid"><TimeInput label="开始时间" value={cue.startMs} onCommit={value=>update({startMs:value})} run={run}/><TimeInput label="结束时间" value={cue.endMs} onCommit={value=>update({endMs:value})} run={run}/></div><TimeInput label="时长" value={Math.max(0,cue.endMs-cue.startMs)} onCommit={value=>{if(value<=0||cue.startMs+value>359999999)throw new Error('时长必须大于零，结束时间不能超过 99:59:59,999');update({endMs:cue.startMs+value})}} run={run}/><div className="toolbar"><Button size="sm" variant="secondary" title={shortcutTitle('设置起点','subtitles.setStart')} onClick={()=>update({startMs:Math.round(time/10)*10})}>设置起点</Button><Button size="sm" variant="secondary" title={shortcutTitle('设置终点','subtitles.setEnd')} onClick={()=>update({endMs:Math.round(time/10)*10})}>设置终点</Button><Button size="sm" variant="ghost" onClick={()=>seek(cue.startMs)}><Play size={14}/>定位</Button></div></div>
        <div className="subtitle-inner-card"><Field label="字幕文本" hint={srtMode&&hasAssTags?'此条含 ASS 标签，请切换 ASS/SSA 后编辑文本。':!srtMode?'换行直接输入；ASS 覆盖标签会原样保存。':undefined}><textarea className="input cue-text" aria-label="字幕文本" disabled={srtMode&&hasAssTags} value={cue.text} onChange={event=>update({text:event.target.value},`text:${cue.id}`)} onSelect={event=>{textCursor.current=event.currentTarget.selectionStart}}/></Field>{!srtMode&&<div className="toolbar subtitle-format-tools">{[['粗体','b'],['斜体','i'],['下划线','u']].map(([label,tag])=><Button key={tag} size="sm" variant="ghost" onClick={()=>update({text:`{\\${tag}1}${cue.text}{\\${tag}0}`})}>{label}</Button>)}</div>}</div>
        <details className="subtitle-event-properties" open={!srtMode}><summary>事件属性{srtMode&&' · SRT 模式不可编辑'}</summary><fieldset disabled={srtMode}><div className="form-grid"><Field label="类型"><Select disabled={srtMode} value={cue.comment?'comment':'dialogue'} onChange={e=>update({comment:e.target.value==='comment'})}><option value="dialogue">对白</option><option value="comment">注释</option></Select></Field><Field label="图层"><Input type="number" min={0} max={2147483647} value={cue.layer??0} onChange={e=>{const value=+e.target.value;if(Number.isInteger(value)&&value>=0&&value<=2147483647)update({layer:value})}}/></Field><Field label="样式"><Select disabled={srtMode} value={cue.style??'Default'} onChange={e=>update({style:e.target.value})}>{document.styles?.map(style=><option value={style.name} key={style.name}>{style.name}</option>)}</Select></Field><Field label="角色"><Input value={cue.name??''} onChange={e=>update({name:e.target.value.replace(/[,\r\n]/g,'')},`name:${cue.id}`)}/></Field>{(['marginL','marginR','marginV'] as const).map((key,i)=><Field label={['左边距','右边距','垂直边距'][i]} key={key}><Input type="number" min={0} max={99999} value={cue[key]??0} onChange={e=>{const value=+e.target.value;if(Number.isInteger(value)&&value>=0&&value<=99999)update({[key]:value})}}/></Field>)}<Field label="效果"><Input value={cue.effect??''} onChange={e=>update({effect:e.target.value.replace(/[,\r\n]/g,'')},`effect:${cue.id}`)}/></Field></div></fieldset></details>
      </>:<Empty title="未选择字幕" description="选择条目开始编辑，或新增字幕。"/>}
    </Card></div>
    <Card title={`字幕条目 · ${document.cues.length}`} aside={<span className="hint">已选 {selection.length} 条</span>}>
      <div className="subtitle-list-toolbar"><Button variant="secondary" size="sm" onClick={addCue}><Plus size={15}/>新增字幕</Button><Button variant="ghost" size="sm" disabled={!selection.length||busy} onClick={()=>run(copy)}><Copy size={15}/>复制条目</Button><Button variant="ghost" size="sm" disabled={busy} onClick={()=>run(paste)}><ClipboardPaste size={15}/>粘贴条目</Button><Button variant="ghost" size="sm" disabled={!selection.length} onClick={()=>setDeleteConfirm(true)}><Trash2 size={15}/>删除所选</Button><Button variant="ghost" size="sm" disabled={selection.length!==1||!cue||hasAssTags} title="在播放位置拆分；位置不在字幕内时取时间中点。文本按光标位置拆分。" onClick={()=>run(async()=>split())}><Scissors size={15}/>拆分条目</Button><Button variant="ghost" size="sm" disabled={selection.length<2} title="按条目顺序合并文本，保留第一条样式和属性。" onClick={()=>run(async()=>merge())}><Combine size={15}/>合并所选</Button><Button variant={searchOpen?'secondary':'ghost'} size="sm" onClick={()=>setSearchOpen(!searchOpen)}><Search size={15}/>搜索与替换</Button><Button variant="ghost" size="sm" disabled={!document.cues.length} onClick={()=>setOffsetOpen(true)}><Clock3 size={15}/>时间偏移</Button><Button variant="ghost" size="sm" onClick={()=>setValidationOpen(true)}><CheckCheck size={15}/>校验字幕{issues.length?` (${issues.length})`:''}</Button></div>
      {searchOpen&&<div className="subtitle-inner-card subtitle-search-panel"><div className="form-grid"><Field label="搜索文本"><Input value={search} onChange={e=>{setSearch(e.target.value);setPage(1);setReplaceCount(undefined)}}/></Field><Field label="替换文本"><Input value={replacement} onChange={e=>setReplacement(e.target.value)}/></Field></div><div className="toolbar"><label><input type="checkbox" checked={caseSensitive} onChange={e=>setCaseSensitive(e.target.checked)}/>区分大小写</label><Select aria-label="替换范围" value={replaceScope} onChange={e=>setReplaceScope(e.target.value)}><option value="all">全部条目</option><option value="selected">所选条目</option></Select><Button variant="secondary" size="sm" disabled={!search||replaceScope==='selected'&&!selection.length} onClick={()=>{const next=replaceSubtitleText(document.cues,search,replacement,replaceScope==='selected'?selected:undefined,caseSensitive);if(next.count)edit(next.cues);setReplaceCount(next.count)}}>替换全部</Button>{replaceCount!==undefined&&<span className="hint">已替换 {replaceCount} 处</span>}<Button variant="ghost" size="sm" onClick={()=>{setSearch('');setSearchOpen(false)}}>关闭搜索</Button></div></div>}
      <DropZone onFiles={files=>void run(async()=>{const paths=await window.muxivra.acceptDrop(files);if(paths.length!==1||!/\.(srt|ass|ssa)$/i.test(paths[0]))throw new Error('请拖入一个 SRT、ASS 或 SSA 文件');await importSubtitles(paths[0])})}>
        {rows.length?<div className="cue-list subtitle-event-table"><table className="file-table subtitle-event-table-inner" aria-label="字幕条目"><thead><tr><th><input type="checkbox" aria-label="选择本页全部字幕" checked={!!pageRows.length&&pageRows.every(({item})=>selected.has(item.id))} onChange={e=>setSelection(values=>e.target.checked?[...new Set([...values,...pageRows.map(r=>r.item.id)])]:values.filter(id=>!pageRows.some(r=>r.item.id===id)))}/></th><th>#</th><th>开始 → 结束</th><th>样式</th><th>文本</th><th>时长</th></tr></thead><tbody>{pageRows.map(({item,index})=><tr tabIndex={0} data-cue-id={item.id} key={item.id} className={`${selected.has(item.id)?'selected-row':''} ${item.comment?'subtitle-comment-row':''}`} onClick={event=>{choose(item.id,event);seek(item.startMs)}} onKeyDown={event=>{if(event.key==='Enter'){choose(item.id,event);seek(item.startMs)}}}><td><input type="checkbox" aria-label={`选择第 ${index+1} 条字幕`} checked={selected.has(item.id)} onClick={e=>e.stopPropagation()} onChange={e=>{setSelection(values=>e.target.checked?[...new Set([...values,item.id])]:values.filter(id=>id!==item.id));setFocused(item.id);selectionAnchor.current=item.id}}/></td><td>{index+1}{item.comment&&<small>注释</small>}</td><td><code>{formatTime(item.startMs)}<br/>{formatTime(item.endMs)}</code></td><td><span className="subtitle-row-style">{item.style??'Default'}</span>{item.name&&<small>{item.name}</small>}</td><td className="cue-row-text">{item.text||<span className="hint">空字幕</span>}</td><td>{((item.endMs-item.startMs)/1000).toFixed(2)}s</td></tr>)}</tbody></table></div>:<Empty title={search?'没有匹配条目':'无字幕'} description={search?'修改搜索文本，或关闭搜索以显示全部条目。':undefined}/>}
      </DropZone>
      <div className="task-pagination"><span className="hint">{search?`${rows.length} 条匹配 · `:''}每页 50 条 · Ctrl 多选 / Shift 连选</span><div className="toolbar"><Button variant="secondary" size="sm" disabled={actualPage===1} onClick={()=>setPage(actualPage-1)}><ChevronLeft size={15}/>上一页</Button><Input aria-label="字幕页码" type="number" min={1} max={pages} value={actualPage} onChange={e=>{const value=+e.target.value;if(Number.isInteger(value)&&value>0&&value<=pages)setPage(value)}}/><span>/ {pages}</span><Button variant="secondary" size="sm" disabled={actualPage===pages} onClick={()=>setPage(actualPage+1)}>下一页<ChevronRight size={15}/></Button></div></div>
    </Card>
  </>}
  {deleteConfirm&&<Modal title="删除所选字幕？" onClose={()=>setDeleteConfirm(false)}><p>删除 {selection.length} 条字幕。可通过撤销恢复。</p><div className="subtitle-dialog-actions"><Button variant="secondary" onClick={()=>setDeleteConfirm(false)}>取消</Button><Button onClick={removeSelected}>删除字幕</Button></div></Modal>}
  {offsetOpen&&<Modal title="时间偏移" onClose={()=>setOffsetOpen(false)}><Field label="偏移（毫秒）"><Input type="number" value={offset} onChange={e=>setOffset(+e.target.value)}/></Field><div className="form-grid"><Field label="偏移范围"><Select value={offsetScope} onChange={e=>setOffsetScope(e.target.value)}><option value="selected">所选条目 ({selection.length})</option><option value="all">全部条目</option><option value="from">当前条目及之后</option></Select></Field><Field label="偏移时间"><Select value={offsetEdge} onChange={e=>setOffsetEdge(e.target.value as typeof offsetEdge)}><option value="both">开始与结束</option><option value="start">仅开始</option><option value="end">仅结束</option></Select></Field></div><div className="subtitle-dialog-actions"><Button variant="secondary" onClick={()=>setOffsetOpen(false)}>取消</Button><Button onClick={()=>run(async()=>{const ids=offsetScope==='all'?new Set(document.cues.map(c=>c.id)):offsetScope==='from'?new Set(document.cues.slice(Math.max(0,document.cues.findIndex(c=>c.id===focused))).map(c=>c.id)):selected;if(!ids.size)throw new Error('请先选择字幕条目');edit(shiftCues(document.cues,ids,offset,offsetEdge));setOffsetOpen(false)})}>应用偏移</Button></div></Modal>}
  {validationOpen&&<Modal title="字幕校验" onClose={()=>setValidationOpen(false)} wide>{issues.length?<div className="subtitle-validation-list">{issues.slice(0,200).map((issue,i)=><button key={i} onClick={()=>{choose(issue.id);setSearch('');setPage(Math.floor((issue.row-1)/50)+1);setValidationOpen(false)}}><span className={issue.kind==='error'?'error-inline':'hint'}>{issue.kind==='error'?'错误':'提示'}</span><strong>第 {issue.row} 条</strong><span>{issue.message}</span></button>)}{issues.length>200&&<p className="hint">共 {issues.length} 项，此处显示前 200 项。</p>}</div>:<p>未发现时间或样式问题。</p>}<p className="hint">时间重叠可能用于多层排版，按实际画面判断。ASS 工程可保留编辑中的草稿。</p></Modal>}
  {exportLosses&&<Modal title={`导出 ${exportFormat.toUpperCase()}`} onClose={()=>setExportLosses(undefined)} locked={exporting}><p>此次导出会简化以下内容，ASS 工程保留完整编辑信息。</p><ul className="subtitle-export-losses">{exportLosses.map(loss=><li key={loss}>{loss}</li>)}</ul><div className="subtitle-dialog-actions"><Button variant="secondary" disabled={exporting} onClick={()=>setExportLosses(undefined)}>取消</Button><Button loading={exporting} loadingText="导出中…" onClick={()=>run(exportNow,'字幕已导出')}>继续导出</Button></div></Modal>}
  </div>
}
