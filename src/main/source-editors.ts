import { BrowserWindow,dialog,ipcMain,nativeTheme } from 'electron'
import {basename,dirname,extname,join} from 'node:path'
import {readFile,unlink,open} from 'node:fs/promises'
import {z} from 'zod'
import {SourceFile,sourceHash,sourceLanguage,parseProjectSource,MAX_SOURCE_BYTES} from '../core/subtitles/source-file'
import {serializeAss} from '../core/subtitles/ass'
import {isWithin} from '../core/media/paths'
import {subtitleEditorKey,type SubtitleEditorState} from '../shared/subtitle-mcp'
import {sourceSaveSchema,sourcePreferencesSchema,type SourceFileState,type SourceSave,type SourcePreferences,type SourceWorkspace} from '../shared/source-editor'
import type {MediaService} from '../core/service'
import type {SubtitleEditorBridge} from './subtitle-editor-bridge'
import {resolveUiLocale} from '../shared/locale'
import {translateUi} from '../shared/i18n'
import {JsonStore} from '../core/storage/json'
import {listSourceProjectFiles,resolveSourceProjectPath} from '../core/subtitles/source-explorer'

interface Entry {window:BrowserWindow;file:SourceFile;projectId?:string;last?:SourceFileState;context?:SubtitleEditorState;hash?:string;queue:Promise<unknown>;closing:boolean;polling:boolean;timer?:ReturnType<typeof setInterval>}
export class SourceEditorCloseCancelled extends Error{}
export class SourceEditors {
  private entries=new Map<number,Entry>()
  private preferences=sourcePreferencesSchema.parse({})
  private preferencesStore:JsonStore<unknown>
  private ready:Promise<void>
  private preferenceWrites:Promise<unknown>=Promise.resolve()
  private cancelShutdown?:()=>void
  constructor(private service:MediaService,private bridge:()=>SubtitleEditorBridge,private devUrl:string|undefined,private preload:string,private parent:()=>BrowserWindow|undefined){
    this.preferencesStore=new JsonStore(join(service.dataPath,'source-editor-preferences.json'))
    this.ready=this.preferencesStore.read(undefined).then(value=>{const parsed=sourcePreferencesSchema.safeParse(value??{});if(parsed.success)this.preferences=parsed.data}).catch(()=>{})
    const handle=(name:string,callback:(entry:Entry,...args:any[])=>unknown)=>ipcMain.handle(`source-editor:${name}`,(event,...args)=>{const entry=this.entries.get(event.sender.id),url=event.senderFrame?.url;if(!entry||event.senderFrame!==entry.window.webContents.mainFrame||!(url?.startsWith('muxivra://app/')||(this.devUrl&&new URL(url??'').origin===new URL(this.devUrl).origin)))throw new Error('源码编辑窗口来源未获授权');return callback(entry,...args)})
    handle('read',entry=>this.exclusive(entry,()=>this.read(entry,true)))
    handle('save',(entry,input)=>this.exclusive(entry,()=>this.save(entry,sourceSaveSchema.parse(input))))
    handle('open',()=>this.open())
    handle('workspace',(entry,directory)=>this.workspace(entry,z.string().max(32760).optional().parse(directory)??''))
    handle('setPreferences',(_entry,patch)=>this.setPreferences(z.object({autoSave:z.boolean().optional(),sidebarOpen:z.boolean().optional()}).strict().parse(patch)))
    handle('switchFile',(entry,path,projectId)=>this.exclusive(entry,()=>this.switchFile(entry,z.string().min(1).max(32760).parse(path),z.string().uuid().parse(projectId))))
    handle('saveCopy',(entry,text)=>this.copy(entry,z.string().max(MAX_SOURCE_BYTES).parse(text)))
    handle('discardDraft',(entry,path)=>this.exclusive(entry,async()=>{this.checkPath(entry,z.string().min(1).max(32760).parse(path));await unlink(this.draftPath(entry)).catch(()=>{})}))
    handle('finishClose',(entry,discard)=>this.exclusive(entry,async()=>{if(z.boolean().optional().parse(discard))await unlink(this.draftPath(entry)).catch(()=>{});entry.closing=true;entry.window.destroy()}))
    handle('cancelClose',()=>this.cancelShutdown?.())
  }
  private ui(key:string,...values:unknown[]){return translateUi(key,resolveUiLocale(this.service.settings.language,this.service.systemLanguages),...values)}
  private draftPath(entry:Entry){return join(this.service.dataPath,'source-editor-drafts',sourceHash(entry.file.path.toLowerCase())+'.json')}
  private checkPath(entry:Entry,path:string){if(path.toLowerCase()!==entry.file.path.toLowerCase())throw new Error(this.ui('编辑器已切换文件，旧操作已停止。'))}
  private exclusive<T>(entry:Entry,operation:()=>Promise<T>):Promise<T>{const result=entry.queue.catch(()=>{}).then(operation);entry.queue=result;return result}
  private project(entry:Entry){
    const state=this.service.projects.state(),active=state.items.find(project=>project.id===state.activeId&&!project.archived)
    if(active)entry.projectId=active.id
    return active??state.items.find(project=>project.id===entry.projectId&&!project.archived)
  }
  private async workspace(entry:Entry,directory:string):Promise<SourceWorkspace>{
    await this.ready
    const project=this.project(entry),preferences={...this.preferences}
    if(!project)return {preferences,directory:'',entries:[],truncated:false}
    await this.service.projects.validate(project.id)
    return {...await listSourceProjectFiles(project.directory,directory),preferences,project:{id:project.id,name:project.name,path:project.directory,active:this.service.projects.state().activeId===project.id}}
  }
  private setPreferences(patch:Partial<SourcePreferences>){
    const operation=this.preferenceWrites.catch(()=>{}).then(async()=>{
      await this.ready
      const next=sourcePreferencesSchema.parse({...this.preferences,...patch});await this.preferencesStore.write(next);this.preferences=next
      for(const entry of this.entries.values())if(!entry.window.isDestroyed())entry.window.webContents.send('source-editor:preferences',next)
      return {...next}
    })
    this.preferenceWrites=operation;return operation
  }
  private async switchFile(entry:Entry,relativePath:string,projectId:string):Promise<SourceFileState>{
    const project=this.project(entry)
    if(!project||project.id!==projectId)throw new Error(this.ui('项目已切换，请刷新资源管理器后重试。'))
    await this.service.projects.validate(project.id)
    const target=await resolveSourceProjectPath(project.directory,relativePath),file=await SourceFile.open(target)
    const other=[...this.entries.values()].find(candidate=>candidate!==entry&&candidate.file.path.toLowerCase()===file.path.toLowerCase())
    if(other){other.window.show();other.window.focus();throw new Error(this.ui('此文件已在另一源码窗口中打开，已为你切换到该窗口。'))}
    const track=project.subtitles.find(item=>item.path.toLowerCase()===file.path.toLowerCase())
    if(track&&this.service.projects.state().activeId===project.id){
      await this.bridge().selectSource(project.id,track.id)
      if(this.service.projects.state().activeId!==project.id||this.service.subtitleProjects.get()?.projectPath?.toLowerCase()!==file.path.toLowerCase())throw new Error(this.ui('项目已切换，请刷新资源管理器后重试。'))
    }
    const previous={file:entry.file,last:entry.last,context:entry.context,hash:entry.hash}
    entry.file=file;entry.last=undefined;entry.context=undefined;entry.hash=undefined
    try{return await this.read(entry,true)}catch(error){Object.assign(entry,previous);throw error}
  }
  async open(path?:string):Promise<void>{
    if(!path){const options={title:this.ui('打开文本文件'),properties:['openFile'] as ('openFile')[],filters:[{name:this.ui('文本与字幕文件'),extensions:['ass','ssa','srt','vtt','txt','md','json','jsonc','yaml','yml','toml','ini','cfg','log','csv','xml','html','css','js','ts','py']}]};const selected=this.parent()?await dialog.showOpenDialog(this.parent()!,options):await dialog.showOpenDialog(options);path=selected.filePaths[0];if(!path)return}
    const file=await SourceFile.open(path)
    for(const entry of this.entries.values())if(entry.file.path.toLowerCase()===file.path.toLowerCase()){entry.window.show();entry.window.focus();return}
    const window=new BrowserWindow({width:1180,height:820,minWidth:720,minHeight:480,title:`${basename(path)} — Muxivra`,backgroundColor:'#1e1e1e',autoHideMenuBar:true,webPreferences:{preload:this.preload,contextIsolation:true,sandbox:true,nodeIntegration:false}})
    const project=this.service.projects.state().items.find(project=>isWithin(project.directory,file.path)&&!project.archived)??this.service.projects.active()
    const entry:Entry={window,file,projectId:project?.id,queue:Promise.resolve(),closing:false,polling:false};this.entries.set(window.webContents.id,entry)
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault())
    window.on('close',event=>{if(entry.closing)return;event.preventDefault();window.webContents.send('source-editor:close-request')})
    const contentsId=window.webContents.id
    window.on('closed',()=>{clearInterval(entry.timer);this.entries.delete(contentsId)})
    if(this.devUrl){const url=new URL(this.devUrl);url.searchParams.set('window','source-editor');await window.loadURL(url.toString())}else await window.loadURL('muxivra://app/index.html?window=source-editor')
    entry.timer=setInterval(()=>{if(entry.polling||window.isDestroyed())return;entry.polling=true;void this.exclusive(entry,async()=>{try{const previous=entry.last,state=await this.read(entry);if(previous?.revision!==state.revision||previous?.theme!==state.theme||previous?.locale!==state.locale)window.webContents.send('source-editor:update',state)}catch{/* A transient main-editor action is retried; never replace the open buffer. */}}).finally(()=>entry.polling=false)},1200)
  }
  private async read(entry:Entry,restoreDraft=false):Promise<SourceFileState>{
    let disk:Awaited<ReturnType<SourceFile['read']>>
    try{disk=await entry.file.read()}catch(error){if(!entry.last)throw error;const readOnly=this.ui('文件无法读取，已切换为只读；当前内容仍保留。'),state={...entry.last,readOnly,revision:sourceHash(JSON.stringify([entry.file.path,'unavailable',String(error)]))};entry.last=state;entry.context=undefined;return state}
    const current=await this.service.getSession(),managed=isWithin(this.service.projects.root,entry.file.path)
    let text=disk.text,context:SubtitleEditorState|undefined,readOnly:string|undefined
    if(managed){
      if(current?.projectPath?.toLowerCase()!==entry.file.path.toLowerCase())readOnly=this.ui('请在项目管理中打开此工程，并在字幕编辑中选择此字幕文件后编辑源码。')
      else{context=await this.bridge().readSource();if(context.document.projectPath!==current.projectPath)throw new Error('工程已切换');if(subtitleEditorKey(context.document)!==subtitleEditorKey(current)||this.service.subtitleProjects.state().dirty)text=serializeAss(context.document);if(this.service.subtitleProjects.state().recoveryPending)readOnly=this.ui('工程文件已被外部修改，请先处理工程恢复冲突。')}
    }
    const state:SourceFileState={path:entry.file.path,name:disk.name,text,revision:sourceHash(JSON.stringify([entry.file.path.toLowerCase(),disk.hash,context?subtitleEditorKey(context.document):null,readOnly??null])),language:sourceLanguage(entry.file.path),encoding:disk.encoding,managed,readOnly,savedAt:context?.lastSavedAt,locale:resolveUiLocale(this.service.settings.language,this.service.systemLanguages),theme:this.service.settings.theme==='system'?(nativeTheme.shouldUseDarkColors?'dark':'light'):this.service.settings.theme}
    if(restoreDraft){try{const draft=JSON.parse(await readFile(this.draftPath(entry),'utf8'));if(typeof draft.text==='string'&&draft.text.length<=MAX_SOURCE_BYTES&&typeof draft.revision==='string'){state.draftText=draft.text;state.draftRevision=draft.revision}}catch{}}
    entry.last=state;entry.context=context;entry.hash=disk.hash;return state
  }
  private async save(entry:Entry,request:SourceSave){
    this.checkPath(entry,request.path)
    if(Buffer.byteLength(request.text)>MAX_SOURCE_BYTES)throw new Error('文本文件超过 10 MB')
    await new JsonStore<SourceSave>(this.draftPath(entry)).write(request)
    const state=await this.read(entry)
    if(state.readOnly)throw new Error(state.readOnly)
    if(state.revision!==request.revision)throw new Error(this.ui('文件或主编辑器内容已更改，请重新载入或另存副本。'))
    if(entry.context){const current=entry.context,document=parseProjectSource(request.text,current.document);await this.bridge().applySource({baseline:subtitleEditorKey(current.document),version:current.version,document,summary:this.ui('源码编辑'),source:{text:request.text,hash:entry.hash!}})}
    else await entry.file.save(request.text,entry.hash!)
    await unlink(this.draftPath(entry)).catch(()=>{});return this.read(entry)
  }
  private async copy(entry:Entry,text:string){
    const extension=extname(entry.file.path),result=await dialog.showSaveDialog(entry.window,{title:this.ui('保存源码副本'),defaultPath:join(dirname(entry.file.path),`${basename(entry.file.path,extension)}-copy${extension}`)})
    if(!result.filePath)return
    // A copy never overwrites source files, project metadata, or another document.
    const handle=await open(result.filePath,'wx',0o600);try{await handle.writeFile(text,'utf8');await handle.sync()}finally{await handle.close()}
    return result.filePath
  }
  async shutdown(){
    const entries=[...this.entries.values()].filter(entry=>!entry.window.isDestroyed());if(!entries.length)return
    const cleanup:(()=>void)[]=[]
    try{await new Promise<void>((resolve,reject)=>{
      let remaining=entries.length
      const timer=setTimeout(()=>reject(new Error(this.ui('源码窗口尚未关闭，请先保存或处理未完成的更改，再重试退出。'))),20000);cleanup.push(()=>clearTimeout(timer))
      this.cancelShutdown=()=>reject(new SourceEditorCloseCancelled())
      for(const entry of entries){const closed=()=>{if(--remaining===0)resolve()};entry.window.once('closed',closed);cleanup.push(()=>entry.window.removeListener('closed',closed));entry.window.show();entry.window.webContents.send('source-editor:close-request')}
    })}finally{this.cancelShutdown=undefined;for(const dispose of cleanup)dispose()}
  }
}
