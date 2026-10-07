import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { MuxivraApi } from '../shared/types'

const invoke = (method: string, ...args: unknown[]) => ipcRenderer.invoke(`muxivra:${method}`,...args)
const api: MuxivraApi = {
  exitState:()=>invoke('exitState'),requestExit:()=>invoke('requestExit'),respondToExit:confirm=>invoke('respondToExit',confirm),
  onExitState:callback=>{const listener=(_event:unknown,state:Parameters<typeof callback>[0])=>callback(state);ipcRenderer.on('muxivra:exit-state',listener);return()=>ipcRenderer.removeListener('muxivra:exit-state',listener)},
  snapshot: () => invoke('snapshot'), selectFiles: (kind,multiple) => invoke('selectFiles',kind,multiple), selectDirectory: purpose => invoke('selectDirectory',purpose),
  acceptDrop: files => invoke('acceptDrop',files.map(file => webUtils.getPathForFile(file))),
  inspect: path => invoke('inspect',path), plan: request => invoke('plan',request), planBatch: requests => invoke('planBatch',requests), submit: (requests,key) => invoke('submit',requests,key),
  cancel: id => invoke('cancel',id), retry: id => invoke('retry',id), detectEngine: () => invoke('detectEngine'), useEngine: path => invoke('useEngine',path), downloadEngine: () => invoke('downloadEngine'),
  pause:id=>invoke('pause',id),resume:id=>invoke('resume',id),moveJob:(id,direction)=>invoke('moveJob',id,direction),refreshHardware:()=>invoke('refreshHardware'),systemUsage:()=>invoke('systemUsage'),
  jobDetails:id=>invoke('jobDetails',id),deleteJobRecords:ids=>invoke('deleteJobRecords',ids),readLogPage:(id,offset)=>invoke('readLogPage',id,offset),
  saveSettings: settings => invoke('saveSettings',settings), savePreset: preset => invoke('savePreset',preset), deletePreset: id => invoke('deletePreset',id),
  importPresets:()=>invoke('importPresets'),exportPresets:ids=>invoke('exportPresets',ids),componentCapabilities:(kind,name)=>invoke('componentCapabilities',kind,name),
  readSubtitles: path => invoke('readSubtitles',path), saveSession: document => invoke('saveSession',document), getSession: () => invoke('getSession'), exportSubtitles: document => invoke('exportSubtitles',document),
  inspectPlayback:path=>invoke('inspectPlayback',path),playerState:owner=>invoke('playerState',owner),playerOpen:(owner,paths,append)=>invoke('playerOpen',owner,paths,append),playerRect:(owner,rect)=>invoke('playerRect',owner,rect),playerAction:(owner,action)=>invoke('playerAction',owner,action),playerMedia:owner=>invoke('playerMedia',owner),playerAddTrack:(owner,kind)=>invoke('playerAddTrack',owner,kind),playerScreenshot:owner=>invoke('playerScreenshot',owner),playerSubtitles:(owner,document)=>invoke('playerSubtitles',owner,document),
  onPlayerState:callback=>{const listener=(_event:unknown,state:Parameters<typeof callback>[0])=>callback(state);ipcRenderer.on('muxivra:player-state',listener);return()=>ipcRenderer.removeListener('muxivra:player-state',listener)},
  onPlayerEvent:callback=>{const listener=(_event:unknown,event:Parameters<typeof callback>[0])=>callback(event);ipcRenderer.on('muxivra:player-event',listener);return()=>ipcRenderer.removeListener('muxivra:player-event',listener)},
  onPlayerError:callback=>{const listener=(_event:unknown,message:string)=>callback(message);ipcRenderer.on('muxivra:player-error',listener);return()=>ipcRenderer.removeListener('muxivra:player-error',listener)},
  waveform: path => invoke('waveform',path), reveal: path => invoke('reveal',path), readLog: id => invoke('readLog',id), copyText: text => invoke('copyText',text),
  mcpSetupInfo:()=>invoke('mcpSetupInfo'),mcpReadSkill:id=>invoke('mcpReadSkill',id),copyMcpConnectionPrompt:()=>invoke('copyMcpConnectionPrompt'),
  onUpdate: callback => { const listener = (_event: unknown,snapshot: Parameters<typeof callback>[0]) => callback(snapshot); ipcRenderer.on('muxivra:update',listener); return () => ipcRenderer.removeListener('muxivra:update',listener) }
}
contextBridge.exposeInMainWorld('muxivra',api)
