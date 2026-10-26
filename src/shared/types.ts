import type { PlayerOwner, PlayerRect, PlayerAction, PlayerState, PlayerEvent } from './player'
import type { ParameterValue, FilterSetting, EncoderSetting, ComponentCapabilities } from './parameters'
export type JobStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export type Source = 'gui' | 'mcp'
export interface Engine {
  id: string; ffmpegPath: string; ffprobePath: string; version: string; source: 'path' | 'local' | 'managed'
  encoders: string[]; decoders: string[]; filters: string[]; detectedAt: string
  license?:string
  encoderKinds?: Record<string,'video'|'audio'|'subtitle'>
}
export interface MediaStream {
  index: number; type: string; codec: string; language?: string; title?: string
  width?: number; height?: number; frameRate?: string; sampleRate?: number; channels?: number
}
export interface MediaInfo {
  path: string; name: string; durationMs: number; size: number; format: string; streams: MediaStream[]
}
export interface TranscodeOptions {
  container: 'mp4' | 'mkv' | 'mov' | 'm4a' | 'mp3' | 'wav' | 'flac' | 'srt' | 'webm' | 'avi' | 'ts' | 'ogg' | 'opus' | 'gif' | 'png' | 'jpg' | 'webp'
  video: string
  audio: string
  quality: number; speed: string; audioBitrate: number; maxHeight?: number
  streamIndices?: number[]; subtitles: 'copy' | 'none'
  conflict: 'reject' | 'number'; presetId?: string
  advanced?: Record<string,ParameterValue>
  filters?: FilterSetting[]
  encoderOptions?: EncoderSetting[]
  metadata?: {key:string;value:string}[]
  subtitleFile?: string
  subtitleMode?: 'burn' | 'embed'
  codecParameters?:Record<string,string>
}
export interface Preset { id: string; name: string; description: string; options: TranscodeOptions }
export interface JobRequest { inputPath: string; outputPath: string; options: TranscodeOptions }
export interface Plan {
  commandEdited?:boolean
  projectId?: string
  kind?: 'transcode'
  input: MediaInfo; outputPath: string; options: TranscodeOptions; args: string[]; engine: Engine; warnings: string[]
  durationMs?: number
}
export interface Job {
  id: string; createdAt: string; source: Source; batchId?: string; requestKey?: string; requestFingerprint?: string; plan: Plan | import('./asr').AsrPlan
  status: JobStatus; progress: number; processedMs: number; speed: string; startedAt?: string; finishedAt?: string
  error?: string; logPath: string; logTail: string; temporaryPath: string; outputSize?: number
  pausedFrom?: 'queued' | 'running'; elapsedMs?: number; estimatedRemainingMs?: number; estimateBasis?: 'progress' | 'history' | 'unknown'
  cancelling?: boolean
  exitCode?: number | null; exitSignal?: string | null
  events?: { at:string; type:string; message:string }[]
  requestJobCount?: number; requestExpired?: boolean
  executedArgs?:string[]
  stage?:string; pausing?:boolean
  progressIndeterminate?:boolean; progressScope?:'job'|'stage'
  progressMetrics?:{completed:number;total?:number;unit:'audioMs'|'tokens'|'windows'}
}
export interface JobLogPage { text:string; offset:number; nextOffset:number; totalBytes:number; hasMore:boolean }
export type { Cue, SubtitleDocument } from './subtitles'
import type { Cue, SubtitleDocument } from './subtitles'
export interface McpSettings {
  enabled: boolean; port: number; token: string; inputRoots: string[]; outputRoots: string[]
  allowInspect: boolean; allowSubmit: boolean; allowCancel: boolean
  allowSubtitleEdit?:boolean
}
export interface Settings { language?:import('./locale').UiLanguage; theme: 'dark' | 'light' | 'system'; concurrency: number; autoUpdate?:boolean; mcp: McpSettings; shortcuts?: import('./shortcuts').ShortcutBindings }
export interface DownloadState { state: 'idle' | 'downloading' | 'verifying' | 'extracting' | 'completed' | 'failed'; percent: number; message: string }
export interface Snapshot {
  systemLanguages?:string[]
  engine?: Engine; engines: Engine[]; jobs: Job[]; presets: Preset[]; settings: Settings; download: DownloadState
  mcp: { running: boolean; url?: string; error?: string }; notice?: string; dataPath: string; enginePath: string; defaultOutputPath?: string; defaultMcpOutputPath?: string
  hardware: import('./hardware').HardwareInfo; hardwareRefreshing: boolean
  mcpRequests: { pending:number; total:number; revision:number }
  subtitleProject: import('./subtitle-project').SubtitleProjectState
  asr?: import('./asr').AsrState
  projects?: import('./projects').ProjectsState
}
export interface ExitPrompt {
  phase: 'confirm' | 'closing'; running: number; waiting: number; paused: number; mcpRunning: boolean; error?: string
  reason?: 'update'; updateVersion?: string
  runtimeStopped?: boolean
}
export interface McpSkillSummary { id:string; name:string; description:string; uri:string; version:string }
export interface McpSkillDocument extends McpSkillSummary { markdown:string; parameterReference?:unknown }
export interface McpSetupInfo { executablePath?:string; version:string; running:boolean; skills:McpSkillSummary[] }
export interface MuxivraApi {
  mediaMetadata(path:string):Promise<import('./media-metadata').MediaMetadata>
  importLyrics():Promise<string|undefined>
  reviewCommand(request:JobRequest,command:string):Promise<{plan:Plan;reviewId:string}>
  submitCommand(reviewId:string):Promise<Job[]>
  openSourceEditor(request?:{path?:string}):Promise<void>
  saveSourceSubtitle(document:SubtitleDocument,text:string,hash:string):Promise<SubtitleDocument>
  videoFrames(path:string):Promise<import('./video-timing').VideoTiming>
  videoFrameProgress():Promise<number>
  cancelVideoFrames():Promise<void>
  importSubtitleStyles(path:string):Promise<import('./subtitles').SubtitleStyle[]>
  subtitleTools():Promise<import('./subtitle-tools').SubtitleToolsState>
  saveSubtitleTools(value:import('./subtitle-tools').SubtitleToolsState):Promise<void>
  onSubtitleEditorRequest(handler:(request:import('./subtitle-mcp').SubtitleEditorRequest)=>Promise<import('./subtitle-mcp').SubtitleEditorState>):()=>void
  importProject(request:import('./projects').ProjectImportRequest):Promise<import('./projects').ProjectImportResult>
  cancelProjectImport():Promise<void>
  rebuildProjectAnalysis(id:string):Promise<void>
  openProject(id:string):Promise<SubtitleDocument>
  closeProject(id:string):Promise<void>
  renameProject(id:string,name:string):Promise<void>
  archiveProject(id:string):Promise<SubtitleDocument>
  restoreProject(id:string):Promise<void>
  duplicateProject():Promise<SubtitleDocument>
  selectProjectSubtitle(projectId:string,subtitleId:string):Promise<SubtitleDocument>
  createProjectSubtitle(projectId:string,name?:string):Promise<SubtitleDocument>
  importProjectSubtitle(projectId:string,path:string):Promise<SubtitleDocument>
  projectEmbeddedSubtitles(projectId:string):Promise<{index:number;codec:string;language?:string;title?:string}[]>
  importEmbeddedProjectSubtitle(projectId:string,index:number):Promise<SubtitleDocument>
  renameProjectSubtitle(projectId:string,subtitleId:string,name:string):Promise<SubtitleDocument>
  deleteProjectSubtitle(projectId:string,subtitleId:string):Promise<SubtitleDocument>
  exportProjectVideo(request:import('./projects').ProjectVideoExport):Promise<Job|undefined>
  asrImport(request: {name:string;backend:import('./asr').AsrImportRequest['backend'];runtimeId?:string;environmentId?:string}):Promise<import('./asr').AsrModel|undefined>
  asrSaveRecognition(id:string,config:import('./asr').AsrRecognition):Promise<import('./asr').AsrRecognition>
  asrSaveEnvironment(request:import('./asr-environments').AsrEnvironmentRequest):Promise<import('./asr-environments').AsrEnvironment>
  asrRefreshEnvironment(id:string):Promise<import('./asr-environments').AsrEnvironment>
  asrDiscoverPython():Promise<void>
  asrDetectNvidia():Promise<import('./asr-deployment').NvidiaDetection>
  asrDeploymentPlan(request:import('./asr-deployment').AsrDeploymentRequest):Promise<import('./asr-deployment').AsrDeploymentPlan>
  asrDeployNvidia(request:import('./asr-deployment').AsrDeploymentRequest):Promise<void>
  asrDownloadResource(request:import('./asr-deployment').AsrResourceRequest):Promise<void>
  asrImportResource(request:import('./asr-deployment').AsrResourceRequest):Promise<void>
  asrConfigureModel(request:import('./asr-deployment').AsrConfigureModelRequest):Promise<void>
  asrImportModelAsset(request:{name:string;backend:'whisper.cpp'|'qwen3-asr'|'moss-transcribe-diarize'}):Promise<import('./asr-catalog').ManagedAsrAsset|undefined>
  asrCancelDeployment():Promise<void>
  asrDeploymentLog():Promise<string>
  downloadSources():Promise<import('./download-sources').DownloadSourceState>
  saveDownloadSources(configuration:import('./download-sources').DownloadSources,revision:string):Promise<import('./download-sources').DownloadSourceState>
  mcpActivity(page:number):Promise<import('./mcp-activity').McpActivityPage>
  asrCheckNetwork():Promise<import('./download-network').DownloadNetworkReport>
  asrDownloadModel(id:string):Promise<void>
  asrBindAsset(id:string,environmentId?:string,runtimeId?:string):Promise<import('./asr').AsrModel>
  asrStoreModel(id:string):Promise<import('./asr').AsrModel>
  asrImportComponent(role:'aligner'):Promise<import('./asr-catalog').ManagedAsrAsset|undefined>
  asrRemoveEnvironment(id:string):Promise<void>
  asrSelectPath(kind:'python'|'folder'):Promise<string|undefined>
  asrRemoveModel(id:string):Promise<void>
  asrDownload(kind:'model'|'runtime',runtime?:'cpu'|'cuda'):Promise<void>
  asrCancelDownload():Promise<void>
  asrSubmit(options:import('./asr').AsrOptions):Promise<Job>
  asrResult(id:string):Promise<import('./asr').AsrResult>
  asrRaw(id:string,index:number):Promise<string>
  appUpdateState(): Promise<import('./app-update').AppUpdateState>
  openAppLink(kind:'repository'|'issues'|'releases'):Promise<void>
  checkAppUpdate(): Promise<import('./app-update').AppUpdateState>
  downloadAppUpdate(): Promise<import('./app-update').AppUpdateState>
  installAppUpdate(): Promise<void>
  onAppUpdate(callback: (state: import('./app-update').AppUpdateState) => void): () => void
  snapshot(): Promise<Snapshot>
  mcpRequests(): Promise<import('./mcp-requests').McpRequest[]>
  mcpRequest(id:string): Promise<import('./mcp-requests').McpRequest>
  reviewMcpRequest(id:string,approve:boolean,note?:string): Promise<import('./mcp-requests').McpRequest>
  exitState(): Promise<ExitPrompt | undefined>
  requestExit(): Promise<void>
  respondToExit(confirm: boolean): Promise<void>
  onExitState(callback: (state: ExitPrompt | undefined) => void): () => void
  selectFiles(kind: 'media' | 'subtitle' | 'subtitle-burn', multiple?: boolean): Promise<string[]>
  selectDirectory(purpose: 'output' | 'engine' | 'mcp-input' | 'mcp-output'): Promise<string | undefined>
  acceptDrop(files: File[]): Promise<string[]>
  inspect(path: string): Promise<MediaInfo>
  plan(request: JobRequest): Promise<Plan>
  planBatch(requests: JobRequest[]): Promise<Plan[]>
  submit(requests: JobRequest[], requestKey?: string): Promise<Job[]>
  cancel(id: string): Promise<Job>
  pause(id: string): Promise<Job>
  resume(id: string): Promise<Job>
  moveJob(id: string, direction: 'up' | 'down' | 'first' | 'last'): Promise<void>
  jobDetails(id:string):Promise<Job>
  deleteJobRecords(ids:string[]):Promise<number>
  readLogPage(id:string,offset?:number):Promise<JobLogPage>
  refreshHardware(): Promise<void>
  systemUsage():Promise<import('./hardware').SystemUsage>
  retry(id: string): Promise<Job>
  detectEngine(): Promise<Engine | undefined>
  useEngine(pathOrId: string): Promise<Engine>
  downloadEngine(): Promise<void>
  saveSettings(settings: Settings): Promise<Snapshot>
  savePreset(preset: Preset): Promise<Snapshot>
  deletePreset(id: string): Promise<Snapshot>
  importPresets(): Promise<{count:number;names:string[]} | undefined>
  exportPresets(ids:string[]): Promise<string | undefined>
  componentCapabilities(kind:ComponentCapabilities['kind'],name:string):Promise<ComponentCapabilities>
  readSubtitles(path: string): Promise<SubtitleDocument | undefined>
  openSubtitleMedia(path: string): Promise<SubtitleDocument | undefined>
  saveSubtitleProject(document: SubtitleDocument): Promise<SubtitleDocument>
  prepareSubtitleMedia(document:SubtitleDocument):Promise<import('./subtitle-media').SubtitleMediaTransfer>
  saveSubtitleProjectAs(document: SubtitleDocument): Promise<SubtitleDocument | undefined>
  deleteSubtitleProject(documentId: string): Promise<SubtitleDocument>
  getSubtitleProjectState(): Promise<import('./subtitle-project').SubtitleProjectState>
  subtitleExportLosses(document: SubtitleDocument, format: import('./subtitles').SubtitleExportFormat): Promise<string[]>
  saveSession(document: SubtitleDocument): Promise<void>
  getSession(): Promise<SubtitleDocument | undefined>
  exportSubtitles(document: SubtitleDocument, format?: import('./subtitles').SubtitleExportFormat): Promise<string | undefined>
  inspectPlayback(path:string):Promise<MediaInfo>
  playerState(owner:PlayerOwner):Promise<PlayerState>
  playerOpen(owner:PlayerOwner,paths:string[],append?:boolean):Promise<void>
  playerRect(owner:PlayerOwner,rect:PlayerRect):Promise<void>
  playerAction(owner:PlayerOwner,action:PlayerAction):Promise<void>
  playerMedia(owner:PlayerOwner):Promise<MediaInfo|undefined>
  playerAddTrack(owner:PlayerOwner,kind:'audio'|'subtitle'):Promise<void>
  playerScreenshot(owner:PlayerOwner):Promise<string|undefined>
  playerSubtitles(owner:PlayerOwner,document:SubtitleDocument):Promise<void>
  onPlayerState(callback:(state:PlayerState)=>void):()=>void
  onPlayerEvent(callback:(event:PlayerEvent)=>void):()=>void
  onPlayerError(callback:(message:string)=>void):()=>void
  waveform(path:string,options?:Partial<import('./waveform').WaveformRequest>):Promise<import('./waveform').WaveformWindow>
  reveal(path: string): Promise<void>
  readLog(id: string): Promise<string>
  copyText(text: string): Promise<void>
  readClipboardText(): Promise<string>
  mcpSetupInfo(): Promise<McpSetupInfo>
  mcpReadSkill(id:string): Promise<McpSkillDocument>
  copyMcpConnectionPrompt(): Promise<void>
  onUpdate(callback: (snapshot: Snapshot) => void): () => void
}
