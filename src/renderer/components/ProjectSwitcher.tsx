import { tr } from '../lib/i18n'
import { useState } from 'react'
import { FolderOpen,X } from 'lucide-react'
import type { Snapshot,SubtitleDocument } from '../../shared/types'
import { Button,Modal,Empty } from './ui'
import type { RunAction } from './Jobs'
export function ProjectSwitcher({snapshot,run,busy,onProjects,beforeOpen,onOpened,onClose}:{snapshot:Snapshot;run:RunAction;busy:boolean;onProjects:()=>void;beforeOpen?:()=>Promise<void>;onOpened?:(document:SubtitleDocument)=>void;onClose?:()=>Promise<void>}) {
  const [open,setOpen]=useState(false),projects=snapshot.projects?.items.filter(project=>!project.archived)??[]
  return <><Button size="sm" variant="secondary" disabled={busy} onClick={()=>setOpen(true)}><FolderOpen size={15}/>{tr("打开工程")}</Button>{snapshot.projects?.activeId&&onClose&&<Button size="sm" variant="ghost" disabled={busy} onClick={onClose}><X size={15}/>{tr("关闭工程")}</Button>}{open&&<Modal title={tr("打开已有工程")} onClose={()=>setOpen(false)}><div className="project-picker">{projects.map(project=><Button key={project.id} variant="secondary" disabled={busy} onClick={()=>run(async()=>{await beforeOpen?.();const document=await window.muxivra.openProject(project.id);onOpened?.(document);setOpen(false)})}><FolderOpen size={17}/><span title={project.name}>{project.name}</span>{project.id===snapshot.projects?.activeId&&<small>{tr("当前")}</small>}</Button>)}</div>{!projects.length&&<Empty title={tr("暂无工程")} description={tr("请先在项目管理中创建。")}/>}<div className="toolbar"><Button variant="ghost" disabled={busy} onClick={()=>{setOpen(false);onProjects()}}>{tr("项目管理")}</Button></div></Modal>}</>
}
