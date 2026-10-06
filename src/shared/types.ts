import type { PlayerOwner, PlayerRect, PlayerAction, PlayerState, PlayerEvent } from './player'
import type { ParameterValue, FilterSetting, EncoderSetting, ComponentCapabilities } from './parameters'
export type JobStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export type Source = 'gui' | 'mcp'
export interface Engine {
  id: string; ffmpegPath: string; ffprobePath: string; version: string; source: 'path' | 'local' | 'managed'
  encoders: string[]; decoders: string[]; filters: string[]; detectedAt: string
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
  codecParameters?:Record<string,string>
}
export interface Preset { id: string; name: string; description: string; options: TranscodeOptions }
export interface JobRequest { inputPath: string; outputPath: string; options: TranscodeOptions }
export interface Plan {
  input: MediaInfo; outputPath: string; options: TranscodeOptions; args: string[]; engine: Engine; warnings: string[]
  durationMs?: number
}
export interface Job {
  id: string; createdAt: string; source: Source; batchId?: string; requestKey?: string; requestFingerprint?: string; plan: Plan
  status: JobStatus; progress: number; processedMs: number; speed: string; startedAt?: string; finishedAt?: string
  error?: string; logPath: string; logTail: string; temporaryPath: string; outputSize?: number
  pausedFrom?: 'queued' | 'running'; elapsedMs?: number; estimatedRemainingMs?: number; estimateBasis?: 'progress' | 'history' | 'unknown'
  cancelling?: boolean
}
export interface Cue { id: string; startMs: number; endMs: number; text: string }
export interface SubtitleDocument { id: string; sourcePath?: string; cues: Cue[] }
export interface McpSettings {
  enabled: boolean; port: number; token: string; inputRoots: string[]; outputRoots: string[]
  allowInspect: boolean; allowSubmit: boolean; allowCancel: boolean
}
export interface Settings { theme: 'dark' | 'light' | 'system'; concurrency: number; mcp: McpSettings }
export interface DownloadState { state: 'idle' | 'downloading' | 'verifying' | 'extracting' | 'completed' | 'failed'; percent: number; message: string }
export interface Snapshot {
  engine?: Engine; engines: Engine[]; jobs: Job[]; presets: Preset[]; settings: Settings; download: DownloadState
  mcp: { running: boolean; url?: string; error?: string }; notice?: string; dataPath: string; enginePath: string; defaultOutputPath?: string
  hardware: import('./hardware').HardwareInfo; hardwareRefreshing: boolean
}
export interface ExitPrompt {
  phase: 'confirm' | 'closing'; running: number; waiting: number; paused: number; mcpRunning: boolean; error?: string
}
export interface McpSkillSummary { id:string; name:string; description:string; uri:string; version:string }
export interface McpSkillDocument extends McpSkillSummary { markdown:string; parameterReference?:unknown }
export interface McpSetupInfo { executablePath?:string; version:string; running:boolean; skills:McpSkillSummary[] }
export interface MuxivraApi {
  snapshot(): Promise<Snapshot>
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
  readSubtitles(path: string): Promise<SubtitleDocument>
  saveSession(document: SubtitleDocument): Promise<void>
  getSession(): Promise<SubtitleDocument | undefined>
  exportSubtitles(document: SubtitleDocument): Promise<string | undefined>
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
  waveform(path: string): Promise<number[]>
  reveal(path: string): Promise<void>
  readLog(id: string): Promise<string>
  copyText(text: string): Promise<void>
  mcpSetupInfo(): Promise<McpSetupInfo>
  mcpReadSkill(id:string): Promise<McpSkillDocument>
  copyMcpConnectionPrompt(): Promise<void>
  onUpdate(callback: (snapshot: Snapshot) => void): () => void
}
