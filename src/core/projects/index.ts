import { createHash,randomUUID } from 'node:crypto'
import { createReadStream,createWriteStream } from 'node:fs'
import { mkdir,readdir,readFile,writeFile,lstat,realpath,rename,unlink,open,stat,rm } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { basename,extname,join,dirname } from 'node:path'
import type { MediaProject,ProjectsState,ProjectImportResult } from '../../shared/projects'
import type { SubtitleDocument,Job } from '../../shared/types'
import { createSubtitleDocument } from '../../shared/subtitles'
import { PathPolicy,isWithin,localPath } from '../media/paths'
import { JsonStore } from '../storage/json'
import { SubtitleProjectStore } from '../subtitles/project'
import { atomicRename } from '../storage/atomic'
import { z } from 'zod'
import { JobHistoryStore } from '../jobs/history'
import { serializeAss } from '../subtitles/ass'

const MANIFEST='project.json'
interface Manifest { format:'muxivra-project';version:1;id:string;name:string;folder:string;mediaFile:string;subtitleFile:string;subtitleFiles?:{id:string;name:string}[];sourceName:string;mediaBytes:number;createdAt:string;updatedAt:string }
const filename=z.string().min(1).max(260).refine(v=>basename(v)===v&&!['.','..'].includes(v)&&!/[<>:"/\\|?*\x00-\x1f]/.test(v))
const assFilename=filename.refine(v=>extname(v).toLowerCase()==='.ass'&&!v.startsWith('.')&&!/[. ]$/.test(v)&&! /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(v),'ASS 文件名无效')
const manifestSchema=z.object({format:z.literal('muxivra-project'),version:z.literal(1),id:z.string().uuid(),name:z.string().min(1).max(200),folder:filename.refine(v=>!v.startsWith('.')),mediaFile:filename,subtitleFile:assFilename,subtitleFiles:z.array(z.object({id:z.string().uuid(),name:assFilename}).strict()).min(1).max(200).optional(),sourceName:filename,mediaBytes:z.number().int().min(0),createdAt:z.string().datetime(),updatedAt:z.string().datetime()}).strict().refine(v=>!v.subtitleFiles||(v.subtitleFiles.some(s=>s.name===v.subtitleFile)&&new Set(v.subtitleFiles.map(s=>s.id)).size===v.subtitleFiles.length&&new Set(v.subtitleFiles.map(s=>s.name.toLowerCase())).size===v.subtitleFiles.length),'字幕文件列表无效')
const progress=():ProjectsState['import']=>({active:false,name:'',phase:'',percent:0,transferred:0,total:0})
interface InitialProject {name?:string;subtitle?:{name:string;content:Buffer;document:SubtitleDocument};resolution?:{width:number;height:number};exportFormat?:'ass'|'ssa'|'srt'}
export interface ProjectSubtitleSource {name:string;content:Buffer;document:SubtitleDocument}
const fileHash=async(path:string,signal?:AbortSignal)=>{const hash=createHash('sha256');for await(const chunk of createReadStream(path,{signal}))hash.update(chunk);return hash.digest('hex')}
export class ProjectManager {
  /** Service-owned analysis runs on the verified project copy before publication. */
  prepareMedia?:(path:string,directory:string,signal:AbortSignal,progress:(phase:string,percent:number)=>void,options?:import('../media/project-analysis').ProjectAnalysisOptions)=>Promise<void>
  private entries=new Map<string,{manifest:Manifest;project:MediaProject}>()
  private pointer:JsonStore<{id?:string}>
  private operations:Promise<unknown>=Promise.resolve()
  private copying=progress();private failure?:string;private activeId?:string
  private importController?:AbortController
  private histories=new Map<string,JobHistoryStore>()
  subtitles:SubtitleProjectStore
  constructor(readonly root:string,private dataPath:string,private paths:PathPolicy,private update:()=>void){
    this.pointer=new JsonStore(join(dataPath,'active-project.json'))
    this.subtitles=this.emptyStore()
  }
  private emptyStore(){return new SubtitleProjectStore(join(this.dataPath,'empty-subtitle-workspace'),this.paths,this.update)}
  state():ProjectsState{return {root:this.root,activeId:this.activeId,items:[...this.entries.values()].map(v=>structuredClone(v.project)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),import:{...this.copying},error:this.failure}}
  get(id:string):MediaProject {const entry=this.entries.get(id);if(!entry||entry.project.archived)throw new Error('项目不存在或已移入回收站');return structuredClone(entry.project)}
  artifactRoot(id:string){const entry=this.entries.get(id);if(!entry)throw new Error('项目不存在，已停止访问项目文件');return entry.project.directory}
  async validate(id:string){return this.safeDirectory(this.artifactRoot(id))}
  forMedia(path:string):MediaProject|undefined{return [...this.entries.values()].find(v=>!v.project.archived&&v.project.mediaPath.toLowerCase()===path.toLowerCase())?.project}
  active(){return this.activeId?this.get(this.activeId):undefined}
  cancelImport(){if(!this.importController||this.importController.signal.aborted)return;this.importController.abort();this.copying.phase='正在取消导入';this.update()}
  private exclusive<T>(fn:()=>Promise<T>):Promise<T>{const result=this.operations.catch(()=>{}).then(fn);this.operations=result;return result}
  private tracks(manifest:Manifest){return manifest.subtitleFiles??[{id:manifest.id,name:manifest.subtitleFile}]}
  private sessionFile(manifest:Manifest,id:string){return id===manifest.id?'subtitle-session.json':`subtitle-session-${id}.json`}
  private item(manifest:Manifest,directory:string,archived=false):MediaProject{return {id:manifest.id,name:manifest.name,folder:manifest.folder,directory,mediaPath:join(directory,manifest.mediaFile),subtitlePath:join(directory,manifest.subtitleFile),subtitles:this.tracks(manifest).map(s=>({...s,path:join(directory,s.name)})),activeSubtitleId:this.tracks(manifest).find(s=>s.name===manifest.subtitleFile)!.id,sourceName:manifest.sourceName,mediaBytes:manifest.mediaBytes,createdAt:manifest.createdAt,updatedAt:manifest.updatedAt,...(archived?{archived:true}:{})}}
  private async safeDirectory(directory:string):Promise<string>{
    const rootInfo=await lstat(this.root);if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory())throw new Error('projects 必须是普通目录，不能使用符号链接')
    const root=await realpath(this.root),info=await lstat(directory),actual=await realpath(directory)
    if(!info.isDirectory()||info.isSymbolicLink()||!isWithin(root,actual)||actual.toLowerCase()!==localPath(directory).toLowerCase()||actual.toLowerCase()===root.toLowerCase())throw new Error('项目目录已变化，操作已停止')
    return actual
  }
  async initialize(){
    try{
      await mkdir(this.root,{recursive:true});if((await lstat(this.root)).isSymbolicLink())throw new Error('projects 不能使用符号链接');await this.paths.grantDirectory(this.root)
      for(const archived of [false,true]){
        const parent=archived?join(this.root,'.trash'):this.root
        let names;try{names=await readdir(parent,{withFileTypes:true})}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error}
        for(const name of names){if(!name.isDirectory()||name.isSymbolicLink()||!archived&&name.name.startsWith('.'))continue
          try{
            const directory=await this.safeDirectory(join(parent,name.name)),file=join(directory,MANIFEST),info=await lstat(file)
            if(!info.isFile()||info.isSymbolicLink()||info.size>64000)continue
            const manifest=manifestSchema.parse(JSON.parse(await readFile(file,'utf8'))) as Manifest
            if(this.entries.has(manifest.id))continue
            this.entries.set(manifest.id,{manifest,project:this.item(manifest,directory,archived)})
          }catch{}
        }
      }
      const previous=await this.pointer.read({})
      if(previous.id&&this.entries.has(previous.id)&&!this.entries.get(previous.id)!.project.archived)await this.activate(previous.id)

    }catch(error){this.failure=`项目目录不可用：${(error as Error).message}`}
  }
  private async activate(id:string,changed?:Manifest,template?:SubtitleDocument){
    const entry=this.entries.get(id)!;this.get(id)
    const manifest=changed??entry.manifest,project=this.item(manifest,entry.project.directory);await this.safeDirectory(project.directory)
    const next=new SubtitleProjectStore(project.directory,this.paths,this.update,{mediaPath:project.mediaPath,projectPath:project.subtitlePath,sessionFile:this.sessionFile(manifest,project.activeSubtitleId)})
    try{
      await next.initialize()
      if(!next.get()){
        const blank=await next.openManaged(project.mediaPath,project.subtitlePath)
        if(template)await next.save({...structuredClone(template),id:blank.id,mediaPath:blank.mediaPath,projectPath:blank.projectPath,sourcePath:undefined,cues:[],exportFormat:'ass'})
      }
      await this.subtitles.shutdown()
      if(changed)await new JsonStore(join(project.directory,MANIFEST)).write(changed)
      this.subtitles=next;entry.manifest=manifest;entry.project=project;this.activeId=id;await this.pointer.write({id});this.update()
      return this.subtitles.get()!
    }catch(error){if(this.subtitles!==next)await next.shutdown();throw error}
  }
  private editing(id:string){const project=this.get(id);if(id!==this.activeId)throw new Error('当前项目已切换，请重新打开字幕文件');return {project,entry:this.entries.get(id)!}}
  private subtitleName(name:string){const trimmed=name.trim();return assFilename.parse(/\.ass$/i.test(trimmed)?trimmed:trimmed+'.ass')}
  selectSubtitle(id:string,subtitleId:string){return this.exclusive(async()=>{
    const {entry}=this.editing(id),track=this.tracks(entry.manifest).find(s=>s.id===subtitleId);if(!track)throw new Error('字幕文件不存在')
    await this.subtitles.save();if(entry.manifest.subtitleFile===track.name)return this.subtitles.get()!
    return this.activate(id,{...entry.manifest,subtitleFiles:this.tracks(entry.manifest),subtitleFile:track.name,updatedAt:new Date().toISOString()})
  })}
  createSubtitle(id:string,name='subtitles.ass'){return this.exclusive(async()=>{
    const {entry,project}=this.editing(id),tracks=this.tracks(entry.manifest);if(tracks.length>=200)throw new Error('每个项目最多包含 200 个字幕文件')
    await this.subtitles.save();await this.safeDirectory(project.directory)
    const base=this.subtitleName(name),stem=basename(base,extname(base));let chosen=''
    for(let i=0;i<10000;i++){const candidate=i?`${stem} (${i+1}).ass`:base;if(tracks.some(s=>s.name.toLowerCase()===candidate.toLowerCase()))continue;try{await lstat(join(project.directory,candidate))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;chosen=candidate;break}}
    if(!chosen)throw new Error('同名字幕文件过多，请更换名称')
    const track={id:randomUUID(),name:chosen},manifest={...entry.manifest,subtitleFiles:[...tracks,track],subtitleFile:chosen,updatedAt:new Date().toISOString()}
    return this.activate(id,manifest,this.subtitles.get())
  })}
  importSubtitle(id:string,source:ProjectSubtitleSource|((project:MediaProject)=>Promise<ProjectSubtitleSource>)){return this.exclusive(async()=>{
    const {entry,project}=this.editing(id),tracks=this.tracks(entry.manifest)
    if(tracks.length>=200)throw new Error('每个项目最多包含 200 个字幕文件')
    await this.safeDirectory(project.directory)
    const imported=typeof source==='function'?await source(project):source
    filename.parse(imported.name)
    if(imported.content.length>10*1024*1024)throw new Error('字幕文件超过 10 MB')
    const text=serializeAss({...imported.document,sourcePath:undefined,mediaPath:project.mediaPath,projectPath:undefined,exportFormat:'ass'})
    if(Buffer.byteLength(text)>10*1024*1024)throw new Error('转换后的 ASS 超过 10 MB')
    await this.subtitles.save();await this.safeDirectory(project.directory)
    const imports=join(project.directory,'imports');await mkdir(imports,{recursive:true})
    const importsInfo=await lstat(imports)
    if(importsInfo.isSymbolicLink()||!importsInfo.isDirectory()||!isWithin(project.directory,await realpath(imports)))throw new Error('字幕导入目录已变化，已停止导入')
    let original='',target='',chosen=''
    const reserve=async(directory:string,name:string,data:Buffer|string)=>{
      const stem=basename(name,extname(name)),extension=extname(name)
      for(let i=0;i<10000;i++){
        const candidate=i?`${stem} (${i+1})${extension}`:name
        if(directory===project.directory&&tracks.some(track=>track.name.toLowerCase()===candidate.toLowerCase()))continue
        const path=join(directory,candidate)
        try{await writeFile(path,data,{flag:'wx'});return {path,name:candidate}}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}
      }
      throw new Error('同名字幕文件过多，请更换名称')
    }
    try{
      original=(await reserve(imports,imported.name,imported.content)).path
      const published=await reserve(project.directory,this.subtitleName(basename(imported.name,extname(imported.name))),text)
      target=published.path;chosen=published.name
      const track={id:randomUUID(),name:chosen},manifest={...entry.manifest,subtitleFiles:[...tracks,track],subtitleFile:chosen,updatedAt:new Date().toISOString()}
      return await this.activate(id,manifest)
    }catch(error){
      // Never remove a track already published by activate, even if pointer persistence fails.
      if(!chosen||entry.manifest.subtitleFile!==chosen){
        if(target&&await fileHash(target).catch(()=>undefined)===createHash('sha256').update(text).digest('hex'))await unlink(target).catch(()=>{})
        if(original&&await fileHash(original).catch(()=>undefined)===createHash('sha256').update(imported.content).digest('hex'))await unlink(original).catch(()=>{})
      }
      throw error
    }
  })}
  renameSubtitle(id:string,subtitleId:string,name:string){return this.exclusive(async()=>{
    const {entry,project}=this.editing(id),tracks=this.tracks(entry.manifest),track=tracks.find(s=>s.id===subtitleId)
    if(!track||project.activeSubtitleId!==subtitleId)throw new Error('当前字幕文件已切换')
    const nextName=this.subtitleName(name);if(nextName.toLowerCase()===track.name.toLowerCase())return this.subtitles.get()!
    if(tracks.some(s=>s.name.toLowerCase()===nextName.toLowerCase()))throw new Error('已存在同名字幕文件')
    await this.safeDirectory(project.directory);await this.subtitles.save()
    const old=project.subtitlePath,document=await this.subtitles.relocateManaged(join(project.directory,nextName)),manifest={...entry.manifest,subtitleFile:nextName,subtitleFiles:tracks.map(s=>s.id===subtitleId?{...s,name:nextName}:s),updatedAt:new Date().toISOString()}
    try{await new JsonStore(join(project.directory,MANIFEST)).write(manifest)}catch(error){await this.subtitles.relocateManaged(old);throw error}
    entry.manifest=manifest;entry.project=this.item(manifest,project.directory);this.update();return document
  })}
  deleteSubtitle(id:string,subtitleId:string){return this.exclusive(async()=>{
    const {entry,project}=this.editing(id),tracks=this.tracks(entry.manifest),track=tracks.find(s=>s.id===subtitleId)
    if(tracks.length<=1)throw new Error('项目必须至少保留一个 ASS 字幕文件')
    if(!track||project.activeSubtitleId!==subtitleId)throw new Error('当前字幕文件已切换')
    await this.subtitles.save();await this.safeDirectory(project.directory)
    const file=join(project.directory,track.name),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw new Error('字幕文件路径已变化，已停止删除')
    const previous=structuredClone(entry.manifest),remaining=tracks.filter(s=>s.id!==subtitleId)
    let survivor:typeof track|undefined=undefined
    for(const candidate of remaining){try{const info=await lstat(join(project.directory,candidate.name));if(info.isFile()&&!info.isSymbolicLink()){survivor=candidate;break}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}}
    if(!survivor)throw new Error('项目必须至少保留一个 ASS 字幕文件')
    const manifest={...entry.manifest,subtitleFiles:remaining,subtitleFile:survivor.name,updatedAt:new Date().toISOString()}
    const document=await this.activate(id,manifest)
    try{await unlink(file)}catch(error){await this.activate(id,previous);throw error}
    this.paths.files.delete(file);await unlink(join(project.directory,this.sessionFile(previous,subtitleId))).catch(()=>{});this.update();return document
  })}
  open(id:string){return this.exclusive(async()=>{await this.subtitles.save();return this.activate(id)})}
  close(id:string){return this.exclusive(async()=>{
    if(this.activeId!==id)return
    await this.subtitles.save();await this.subtitles.shutdown()
    this.subtitles=this.emptyStore();this.activeId=undefined;await this.pointer.write({});this.update()
  })}
  save(document:SubtitleDocument,source?:{text:string;hash:string}){return this.exclusive(async()=>{
    if(!this.activeId||this.subtitles.get()?.id!==document.id)return undefined
    const saved=await this.subtitles.save(document,source);await this.touch(this.activeId);return saved
  })}
  cache(document:SubtitleDocument){return this.exclusive(async()=>{
    if(!this.activeId||this.subtitles.get()?.id!==document.id)return
    await this.subtitles.cache(document);await this.touch(this.activeId)
  })}
  persistJobRecords(jobs:Job[]){return this.exclusive(async()=>{
    for(const {project} of this.entries.values()){
      await this.safeDirectory(project.directory)
      let store=this.histories.get(project.directory);if(!store){store=new JobHistoryStore(project.directory);this.histories.set(project.directory,store)}
      await store.write(jobs.filter(j=>j.plan.projectId===project.id))
    }
  })}
  async importMedia(input:string,deleteOriginal=false,preserveRecovery=false,initial:InitialProject={}):Promise<ProjectImportResult>{return this.exclusive(async()=>{
    if(!preserveRecovery)await this.subtitles.save()
    const source=await this.paths.input(input),original=await lstat(source)
    if(!original.isFile()||original.isSymbolicLink()||(await lstat(localPath(input))).isSymbolicLink())throw new Error('请选择普通本地媒体文件')
    if(isWithin(this.root,source)&&deleteOriginal)throw new Error('项目目录中的文件不能通过导入操作删除')
    const sourceName=basename(source),stem=basename(source,extname(source)),safe=stem.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/^[. ]+|[. ]+$/g,'').slice(0,150)||'Project'
    const base=/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe)?`_${safe}`:safe
    await mkdir(this.root,{recursive:true});if((await lstat(this.root)).isSymbolicLink())throw new Error('projects 不能使用符号链接');await this.paths.grantDirectory(this.root)
    let directory='',folder='';for(let i=0;i<10000;i++){folder=i?`${base} (${i+1})`:base;directory=join(this.root,folder);try{await mkdir(directory);break}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;directory=''}}
    if(!directory)throw new Error('同名项目过多，请更换媒体文件名')
    const destination=join(directory,sourceName),id=randomUUID(),now=new Date().toISOString(),temporary=join(directory,'.media-import.tmp')
    this.copying={active:true,name:sourceName,phase:'复制媒体',percent:0,transferred:0,total:original.size};this.failure=undefined;this.update()
    const controller=new AbortController();this.importController=controller;let committed=false,createdStore:SubtitleProjectStore|undefined
    try{
      const hash=createHash('sha256');let last=0
      await pipeline(createReadStream(source),new Transform({transform:(chunk,encoding,done)=>{hash.update(chunk);this.copying.transferred+=chunk.length;this.copying.percent=original.size?this.copying.transferred/original.size*25:25;if(Date.now()-last>100){last=Date.now();this.update()}done(null,chunk)}}),createWriteStream(temporary,{flags:'wx'}),{signal:controller.signal})
      const handle=await open(temporary,'r+');try{await handle.sync()}finally{await handle.close()}
      this.copying.phase='校验媒体';this.update();const expected=hash.digest('hex')
      if(await fileHash(temporary,controller.signal)!==expected)throw new Error('媒体副本校验失败，源文件已保留')
      const current=await stat(source);if(current.size!==original.size||current.mtimeMs!==original.mtimeMs||current.ino!==original.ino)throw new Error('复制期间源媒体发生变化，请重新导入')
      await rename(temporary,destination)
      controller.signal.throwIfAborted()
      await this.prepareMedia?.(destination,directory,controller.signal,(phase,percent)=>{this.copying.phase=phase;this.copying.percent=30+Math.max(0,Math.min(100,percent))*.65;this.update()})
      controller.signal.throwIfAborted()
      this.copying.phase='保存项目';this.copying.percent=96;this.update()
      const manifest:Manifest={format:'muxivra-project',version:1,id,name:initial.name??folder,folder,mediaFile:sourceName,subtitleFile:`${basename(sourceName,extname(sourceName))}.ass`,sourceName,mediaBytes:original.size,createdAt:now,updatedAt:now}
      const store=new SubtitleProjectStore(directory,this.paths,this.update,{mediaPath:destination,projectPath:join(directory,manifest.subtitleFile)});createdStore=store;await store.initialize();await this.paths.grantFile(destination);let document=await store.openMedia(destination)
      if(initial.subtitle){
        this.copying.phase='导入初始字幕';this.update()
        const imports=join(directory,'imports');await mkdir(imports);await writeFile(join(imports,initial.subtitle.name),initial.subtitle.content,{flag:'wx'})
        document={...initial.subtitle.document,id:document.id,mediaPath:document.mediaPath,projectPath:document.projectPath,sourcePath:undefined}
      }
      if(initial.resolution)document={...document,scriptInfo:{...document.scriptInfo,PlayResX:String(initial.resolution.width),PlayResY:String(initial.resolution.height)}}
      if(initial.exportFormat)document={...document,exportFormat:initial.exportFormat}
      document=(await store.save(document))!
      controller.signal.throwIfAborted()
      await new JsonStore(join(directory,MANIFEST)).write(manifest)
      await this.subtitles.shutdown();this.subtitles=store;this.activeId=id;this.entries.set(id,{manifest,project:this.item(manifest,directory)});await this.pointer.write({id});committed=true
      let warning:string|undefined
      if(deleteOriginal){this.copying.phase='删除源文件';this.update();try{
        const before=await lstat(source);if(before.isSymbolicLink()||before.size!==original.size||before.mtimeMs!==original.mtimeMs||before.ino!==original.ino||await fileHash(source,controller.signal)!==expected)throw new Error('源文件发生变化')
        controller.signal.throwIfAborted()
        await unlink(source);this.paths.files.delete(source)
      }catch(error){warning=`项目已创建，源文件未删除：${(error as Error).message}`}}
      this.copying.percent=100;return {project:this.get(id),document,warning}
    }catch(error){this.failure=controller.signal.aborted?'导入已取消，源文件已保留':(error as Error).message;throw new Error(this.failure,{cause:error})}
    finally{
      if(!committed){await createdStore?.shutdown().catch(()=>{});const target=await this.safeDirectory(directory);await rm(target,{recursive:true,force:true})}
      this.importController=undefined
      this.copying.active=false;this.update()
    }
  })}
  async touch(id:string){const entry=this.entries.get(id);if(!entry||entry.project.archived)return;entry.manifest.updatedAt=new Date().toISOString();entry.project.updatedAt=entry.manifest.updatedAt;await new JsonStore(join(entry.project.directory,MANIFEST)).write(entry.manifest);this.update()}
  rebuildAnalysis(id:string){return this.exclusive(async()=>{
    const project=this.get(id);await this.safeDirectory(project.directory)
    if(!this.prepareMedia)throw new Error('项目预处理服务不可用，请先配置 FFmpeg')
    const controller=new AbortController();this.importController=controller;this.copying={active:true,name:project.name,phase:'准备项目预处理',percent:0,transferred:0,total:0};this.failure=undefined;this.update()
    try{
      await this.prepareMedia(project.mediaPath,project.directory,controller.signal,(phase,percent)=>{this.copying.phase=phase;this.copying.percent=Math.max(0,Math.min(100,percent));this.update()},{replace:true,beforePublish:async()=>{await this.safeDirectory(project.directory)}})
      this.copying.phase='预处理完成';this.copying.percent=100
    }catch(error){this.failure=controller.signal.aborted?'项目预处理已取消，媒体和字幕均已保留':(error as Error).message;throw new Error(this.failure,{cause:error})}
    finally{this.importController=undefined;this.copying.active=false;this.update()}
  })}
  rename(id:string,name:string){return this.exclusive(async()=>{const entry=this.entries.get(id);this.get(id);if(!entry||!name.trim()||name.length>150)throw new Error('项目名称应为 1–150 个字符');await this.safeDirectory(entry.project.directory);entry.manifest.name=name.trim();entry.project.name=name.trim();await this.touch(id)})}
  archive(id:string){return this.exclusive(async()=>{
    const project=this.get(id),entry=this.entries.get(id)!;await this.safeDirectory(project.directory)
    const wasActive=id===this.activeId;if(wasActive)await this.subtitles.shutdown()
    const trash=join(this.root,'.trash');await mkdir(trash,{recursive:true});await this.safeDirectory(trash)
    const target=join(trash,id)
    try{await atomicRename(project.directory,target,()=>this.safeDirectory(project.directory).then(()=>{}))}
    catch(error){if(wasActive)await this.activate(id);throw error}
    entry.project=this.item(entry.manifest,target,true)
    if(wasActive){this.subtitles=this.emptyStore();this.activeId=undefined;await this.pointer.write({})}
    this.update();return createSubtitleDocument()
  })}
  restore(id:string){return this.exclusive(async()=>{
    const entry=this.entries.get(id);if(!entry?.project.archived)throw new Error('项目不在回收站')
    await this.safeDirectory(entry.project.directory);const target=join(this.root,entry.manifest.folder)
    try{await lstat(target);throw new Error('原项目目录已存在，请先处理同名目录')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    await rename(entry.project.directory,target);entry.project=this.item(entry.manifest,target);this.update()
  })}
  async shutdown(){this.cancelImport();await this.operations.catch(()=>{});await this.subtitles.shutdown();await this.pointer.flush()}
}
