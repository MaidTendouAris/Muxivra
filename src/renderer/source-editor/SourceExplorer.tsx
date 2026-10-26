import {useCallback,useEffect,useRef,useState} from 'react'
import {ChevronRight,ChevronDown,Folder,FolderOpen,FileCode2,FileText,FileVideo,File,RefreshCw,PanelLeftClose,Loader2} from 'lucide-react'
import type {SourceProjectFile,SourceWorkspace,SourceEditorApi} from '../../shared/source-editor'
import {Button} from '../components/ui/button'
import {tr} from '../lib/i18n'
const api=()=> (window as unknown as {sourceEditor:SourceEditorApi}).sourceEditor
const samePath=(a:string,b:string)=>a.replaceAll('\\','/').toLowerCase()===b.replaceAll('\\','/').toLowerCase()
interface Props{workspace?:SourceWorkspace;error:string;filePath?:string;busy:boolean;onRefresh:()=>Promise<void>;onHide:()=>void;onOpen:(path:string,projectId:string)=>void}
export function SourceExplorer({workspace,error,filePath,busy,onRefresh,onHide,onOpen}:Props){
  const [opened,setOpened]=useState(new Set<string>()),[directories,setDirectories]=useState(new Map<string,SourceWorkspace>()),[pending,setPending]=useState(new Set<string>()),[failures,setFailures]=useState(new Map<string,string>()),[refreshing,setRefreshing]=useState(false),[rootOpen,setRootOpen]=useState(true)
  const projectId=useRef(workspace?.project?.id),generation=useRef(0),active=useRef(true)
  const root=workspace?.project
  useEffect(()=>{active.current=true;return()=>{active.current=false;generation.current++}},[])
  useEffect(()=>{if(projectId.current===root?.id)return;projectId.current=root?.id;generation.current++;setOpened(new Set());setDirectories(new Map());setPending(new Set());setFailures(new Map());setRootOpen(true)},[root?.id])
  const load=useCallback(async(path:string)=>{
    const version=generation.current,id=projectId.current
    setPending(values=>new Set(values).add(path));setFailures(values=>{const next=new Map(values);next.delete(path);return next})
    try{const result=await api().workspace(path);if(!active.current||version!==generation.current||id!==result.project?.id)return;setDirectories(values=>new Map(values).set(path,result))}
    catch(problem){if(active.current&&version===generation.current)setFailures(values=>new Map(values).set(path,String((problem as Error).message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'')))}
    finally{if(active.current&&version===generation.current)setPending(values=>{const next=new Set(values);next.delete(path);return next})}
  },[])
  const toggle=(path:string)=>{if(opened.has(path)){setOpened(values=>{const next=new Set(values);next.delete(path);return next})}else{setOpened(values=>new Set(values).add(path));if(!directories.has(path))void load(path)}}
  const refresh=async()=>{setRefreshing(true);try{await onRefresh();await Promise.all([...opened].map(path=>load(path)))}finally{if(active.current)setRefreshing(false)}}
  const row=(item:SourceProjectFile,level:number)=>{
    const directory=item.type==='directory',expanded=opened.has(item.path),selected=!!root&&!!filePath&&samePath(filePath,root.path.replace(/[\\/]+$/,'')+'/'+item.path)
    const Icon=directory?(expanded?FolderOpen:Folder):item.subtitle?FileCode2:item.text?FileText:/\.(mp4|mkv|webm|avi|mov|wav|mp3|m4a|flac|ogg)$/i.test(item.name)?FileVideo:File
    const contents=directories.get(item.path)
    return <div key={item.path} role="none"><button type="button" role="treeitem" className={`source-tree-row ${selected?'selected':''} ${directory?'directory':''} ${!directory&&!item.text?'binary':''}`} style={{paddingLeft:10+level*15}} data-source-path={item.path} aria-level={level+1} aria-expanded={directory?expanded:undefined} aria-selected={selected} disabled={!directory&&(busy||!item.text)} title={item.text||directory?item.path:tr('此文件不支持文本编辑')} onClick={()=>directory?toggle(item.path):root&&onOpen(item.path,root.id)}>
      <span className="source-tree-chevron">{directory?(pending.has(item.path)?<Loader2 className="spin" size={13}/>:expanded?<ChevronDown size={13}/>:<ChevronRight size={13}/>):null}</span><Icon size={15} className={item.subtitle?'source-tree-subtitle':''}/><span className="source-tree-name">{item.name}</span>{selected&&<span className="source-tree-current"/>}
    </button>{directory&&expanded&&<div role="group">{contents?.entries.map(entry=>row(entry,level+1))}{failures.has(item.path)&&<button className="source-tree-message error" title={failures.get(item.path)} onClick={()=>void load(item.path)} style={{paddingLeft:25+(level+1)*15}}>{tr('读取失败，点击重试')}</button>}{!pending.has(item.path)&&contents&&!contents.entries.length&&<span className="source-tree-message" style={{paddingLeft:25+(level+1)*15}}>{tr('空文件夹')}</span>}{contents?.truncated&&<span className="source-tree-message">{tr('仅显示前 500 项')}</span>}</div>}</div>
  }
  return <aside className="source-explorer" data-testid="source-explorer" aria-label={tr('项目资源管理器')}>
    <div className="source-explorer-heading"><strong>{tr('资源管理器')}</strong><div><Button size="icon" variant="ghost" aria-label={tr('刷新项目资源')} title={tr('刷新项目资源')} disabled={refreshing} onClick={()=>void refresh()}><RefreshCw size={14} className={refreshing?'spin':''}/></Button><Button size="icon" variant="ghost" aria-label={tr('收起资源管理器')} title={tr('收起资源管理器')} onClick={onHide}><PanelLeftClose size={15}/></Button></div></div>
    {error?<div className="source-explorer-empty" role="alert"><p>{error}</p><Button size="sm" variant="secondary" onClick={()=>void refresh()}>{tr('重试')}</Button></div>:!workspace?<div className="source-explorer-empty"><Loader2 className="spin" size={18}/><p>{tr('正在读取项目资源…')}</p></div>:!root?<div className="source-explorer-empty"><Folder size={26}/><p>{tr('未打开项目')}</p><small>{tr('请在项目管理中打开工程，随后可在这里浏览项目文件。')}</small></div>:<>
      <button className="source-project-root" aria-expanded={rootOpen} title={root.path} onClick={()=>setRootOpen(value=>!value)}>{rootOpen?<ChevronDown size={14}/>:<ChevronRight size={14}/>}<span>{root.name}</span>{!root.active&&<small>{tr('已关闭')}</small>}</button>
      <div className="source-explorer-tree" role="tree" aria-label={tr('项目文件')} hidden={!rootOpen} onKeyDown={event=>{
        if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(event.key))return
        const target=(event.target as Element).closest<HTMLButtonElement>('button[role="treeitem"]');if(!target)return
        const rows=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="treeitem"]:not(:disabled)')],index=rows.indexOf(target);if(index<0)return
        event.preventDefault();const path=target.dataset.sourcePath!
        if(event.key==='ArrowUp')rows[Math.max(0,index-1)]?.focus()
        else if(event.key==='ArrowDown')rows[Math.min(rows.length-1,index+1)]?.focus()
        else if(event.key==='Home')rows[0]?.focus()
        else if(event.key==='End')rows.at(-1)?.focus()
        else if(event.key==='ArrowRight'){if(target.getAttribute('aria-expanded')==='false')toggle(path);else if(target.getAttribute('aria-expanded')==='true')rows[index+1]?.focus()}
        else if(target.getAttribute('aria-expanded')==='true')toggle(path)
        else{const parent=path.slice(0,path.lastIndexOf('/'));rows.find(row=>row.dataset.sourcePath===parent)?.focus()}
      }}>{workspace.entries.map(item=>row(item,0))}{!workspace.entries.length&&<span className="source-tree-message">{tr('项目文件夹为空')}</span>}{workspace.truncated&&<span className="source-tree-message">{tr('仅显示前 500 项')}</span>}</div>
    </>}
  </aside>
}
