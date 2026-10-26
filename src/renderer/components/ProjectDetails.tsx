import { tr } from '../lib/i18n'
import { useEffect,useState } from 'react'
import { ArrowLeft,Captions,Copy,Download,FolderOpen,RefreshCw,Upload } from 'lucide-react'
import type { Snapshot,SubtitleDocument } from '../../shared/types'
import type { MediaProject } from '../../shared/projects'
import { Button,Card,Field,Select,Modal,Busy,Progress } from './ui'
import { ProjectVideoExportPanel } from './ProjectVideoExport'
import type { RunAction } from './Jobs'
import { nameOf } from '../lib/utils'

export function ProjectDetails({project,snapshot,run,busy,onBack,onDuplicate,onTasks,onEditor}:{project:MediaProject;snapshot:Snapshot;run:RunAction;busy:boolean;onBack:()=>void;onDuplicate:(id:string)=>void;onTasks:()=>void;onEditor:()=>void}) {
  const [rebuilding,setRebuilding]=useState(false),[importing,setImporting]=useState<'file'|'embedded'>(),[reading,setReading]=useState(true),[loadError,setLoadError]=useState(''),[importError,setImportError]=useState('')
  const [findingTracks,setFindingTracks]=useState(false),[embeddedTracks,setEmbeddedTracks]=useState<{index:number;codec:string;language?:string;title?:string}[]>(),[embeddedTrack,setEmbeddedTrack]=useState('')
  const [document,setDocument]=useState<SubtitleDocument>(),[losses,setLosses]=useState<string[]>(),[format,setFormat]=useState<'ass'|'ssa'|'srt'>('ass')
  const applyDocument=(next:SubtitleDocument)=>{setDocument(next);setFormat(next.exportFormat??'ass');setLosses(undefined);setLoadError('')}
  useEffect(()=>{
    let live=true
    setDocument(current=>current?.projectPath===project.subtitlePath?current:undefined);setLosses(undefined);setReading(true);setLoadError('');setImportError('')
    void (async()=>{
      try {
        const next=await window.muxivra.getSession()
        if(!live)return
        if(!next||next.projectPath!==project.subtitlePath)throw new Error(tr("当前工程已切换，请重新打开项目文件"))
        applyDocument(next)
      }catch(error){if(live)setLoadError((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,''))}
      finally{if(live)setReading(false)}
    })()
    return()=>{live=false}
  },[project.id,project.subtitlePath,project.activeSubtitleId,snapshot.subtitleProject?.documentId,snapshot.subtitleProject?.lastSavedAt])
  useEffect(()=>{setEmbeddedTracks(undefined);setEmbeddedTrack('')},[project.id])
  const currentDocument=document?.projectPath===project.subtitlePath?document:undefined
  const locked=busy||!!importing||findingTracks
  const importSubtitle=()=>run(async()=>{
    setImporting('file');setImportError('')
    try {
      const [file]=await window.muxivra.selectFiles('subtitle')
      if(!file)return
      const next=await window.muxivra.importProjectSubtitle(project.id,file)
      applyDocument(next)
      return next
    }catch(error){setImportError((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,''));throw error}
    finally{setImporting(undefined)}
  },tr("字幕已导入项目"))
  const findEmbeddedTracks=()=>run(async()=>{
    setFindingTracks(true);setImportError('')
    try {
      const tracks=await window.muxivra.projectEmbeddedSubtitles(project.id)
      setEmbeddedTracks(tracks);setEmbeddedTrack(tracks[0]?String(tracks[0].index):'')
    }catch(error){setImportError((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,''));throw error}
    finally{setFindingTracks(false)}
  })
  const importEmbeddedTrack=()=>run(async()=>{
    if(!embeddedTrack)return
    setImporting('embedded');setImportError('')
    try {
      const next=await window.muxivra.importEmbeddedProjectSubtitle(project.id,Number(embeddedTrack))
      applyDocument(next)
      return next
    }catch(error){setImportError((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,''));throw error}
    finally{setImporting(undefined)}
  },tr("字幕已导入项目"))
  const save=async()=>{if(!currentDocument)throw new Error(tr("工程尚未载入"));return window.muxivra.saveSubtitleProject(currentDocument)}
  const exportNow=async()=>{if(!currentDocument)return;await window.muxivra.exportSubtitles(currentDocument,format);setLosses(undefined)}
  return <div className="project-details-page">
    <div className="subtitle-secondary-heading"><Button variant="ghost" disabled={locked} onClick={onBack}><ArrowLeft size={16}/>{tr("返回项目管理")}</Button><h2>{tr("项目文件")}</h2></div>
    <Card title={project.name}>
      <div className="project-files"><Field label={tr("媒体副本")}><span className="path-text">{project.mediaPath}</span></Field><Field label={tr("ASS 工程")}><span className="path-text">{project.subtitlePath}</span></Field></div>
      <div className="toolbar wrap">
        <Button variant="secondary" disabled={locked} onClick={()=>run(()=>window.muxivra.reveal(project.mediaPath))}><FolderOpen size={16}/>{tr("项目位置")}</Button>
        <Button variant="secondary" disabled={locked||!currentDocument} onClick={()=>run(async()=>{if((await window.muxivra.getSession())?.id!==currentDocument?.id)throw new Error(tr("当前工程已切换，请重新打开项目文件"));await window.muxivra.duplicateProject();const value=await window.muxivra.snapshot();if(value.projects?.activeId)onDuplicate(value.projects.activeId)})}><Copy size={16}/>{tr("复制工程")}</Button>
      </div>
    </Card>
    <Card title={tr("字幕文件")}>
      <p className="hint">{tr("支持 ASS、SSA、SRT；SRT 自动转换为 ASS。导入为新的字幕文件，源文件和项目已有字幕均保留，同名文件自动编号。")}</p>
      <div className="project-files"><Field label={tr("当前字幕文件")}><Select value={project.activeSubtitleId} disabled={locked||reading} onChange={event=>run(async()=>applyDocument(await window.muxivra.selectProjectSubtitle(project.id,event.target.value)))}>{project.subtitles.map(file=><option value={file.id} key={file.id}>{file.name}</option>)}</Select></Field></div>
      <p className="hint">{tr("{0} 个字幕文件",project.subtitles.length)}{currentDocument&&<> · {nameOf(currentDocument.projectPath??'')} · {tr("{0} 条字幕",currentDocument.cues.length)}</>}</p>
      {importError&&<p className="error-inline" role="alert">{importError}</p>}
      {loadError&&<p className="error-inline" role="alert">{loadError}</p>}
      <div className="toolbar wrap">
        <Button variant="secondary" disabled={locked} loading={importing==='file'} loadingText={tr("导入字幕中…")} onClick={importSubtitle}><Upload size={16}/>{tr("导入字幕")}</Button>
        <Button variant="secondary" disabled={locked} loading={findingTracks} loadingText={tr("查找字幕轨道…")} onClick={findEmbeddedTracks}><Captions size={16}/>{tr("查找内嵌字幕")}</Button>
        <Button disabled={locked||!currentDocument} onClick={onEditor}><Captions size={16}/>{tr("编辑字幕")}</Button>
      </div>
      {embeddedTracks&&<div className="project-files">
        <p className="hint">{embeddedTracks.length?tr("只列出可导入的文本字幕轨道，导入后新增 ASS 文件。当前字幕与其他字幕文件均保留。"):tr("媒体中没有可导入的文本字幕轨道。")}</p>
        {!!embeddedTracks.length&&<><Field label={tr("内嵌字幕轨道")}><Select value={embeddedTrack} disabled={locked} onChange={event=>setEmbeddedTrack(event.target.value)}>{embeddedTracks.map(track=><option value={String(track.index)} key={track.index}>{[`#${track.index}`,track.language||tr("未标记语言"),track.title,track.codec.toUpperCase()].filter(Boolean).join(' · ')}</option>)}</Select></Field><div className="toolbar"><Button variant="secondary" disabled={locked||!embeddedTrack} loading={importing==='embedded'} loadingText={tr("导入字幕中…")} onClick={importEmbeddedTrack}><Upload size={16}/>{tr("导入所选轨道")}</Button></div></>}
      </div>}
    </Card>
    <Card title={tr("项目预处理")}>
      <p className="hint">{tr("波形和视频帧索引保存在项目目录。已有项目缺少分析数据时可在此生成；重新预处理保留媒体和全部字幕，失败或取消时保留上一份可用数据。")}</p>
      {rebuilding&&<div className="project-import-progress" role="status"><Busy text={tr(snapshot.projects?.import.phase)||tr("预处理项目…")}/><Progress value={snapshot.projects?.import.percent??0}/></div>}
      <div className="toolbar"><Button variant="secondary" disabled={locked&&!rebuilding} loading={rebuilding} loadingText={tr("预处理中…")} onClick={()=>run(async()=>{setRebuilding(true);try{await window.muxivra.rebuildProjectAnalysis(project.id)}finally{setRebuilding(false)}},tr("项目预处理已更新"))}><RefreshCw size={16}/>{tr("重新预处理")}</Button>{rebuilding&&<Button variant="ghost" onClick={()=>window.muxivra.cancelProjectImport()}>{tr("取消预处理")}</Button>}</div>
    </Card>
    <Card title={tr("导出")}>
      {!currentDocument?reading?<Busy text={tr("读取工程…")}/>:<p className="hint">{loadError||tr("工程尚未载入")}</p>:<><p className="hint">{currentDocument.cues.length} {tr("条字幕 · 项目 exports 目录")}</p><div className="toolbar wrap"><Select aria-label={tr("导出格式")} value={format} disabled={locked} onChange={event=>setFormat(event.target.value as typeof format)}><option value="ass">ASS</option><option value="ssa">SSA</option><option value="srt">SRT</option></Select><Button disabled={locked||!currentDocument.cues.length} onClick={()=>run(async()=>{const value=await window.muxivra.subtitleExportLosses(currentDocument,format);if(value.length)setLosses(value);else await exportNow()})}><Download size={16}/>{tr("导出字幕")}</Button><ProjectVideoExportPanel engine={snapshot.engine} run={run} busy={locked} beforeExport={async()=>{await save()}} onSubmitted={onTasks} disabled={!currentDocument.cues.length}/></div></>}
    </Card>
    {losses&&<Modal title={tr("导出 {0}",format.toUpperCase())} locked={locked} onClose={()=>setLosses(undefined)}><p>{tr("ASS 工程保留完整内容，此次导出将简化：")}</p><ul>{losses.map(value=><li key={value}>{value}</li>)}</ul><div className="toolbar"><Button variant="secondary" disabled={locked} onClick={()=>setLosses(undefined)}>{tr("取消")}</Button><Button disabled={locked} onClick={()=>run(exportNow)}>{tr("继续导出")}</Button></div></Modal>}
  </div>
}
