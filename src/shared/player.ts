import type { z } from 'zod'
import type { playerOwnerSchema, playerRectSchema, playerActionSchema } from './player-schema'
export type PlayerOwner = z.infer<typeof playerOwnerSchema>
export type PlayerRect = z.infer<typeof playerRectSchema>
export type PlayerAction = z.infer<typeof playerActionSchema>
export interface PlayerTrack { id:number; type:string; title?:string; lang?:string; codec?:string; selected?:boolean; external?:boolean; 'external-filename'?:string; 'ff-index'?:number; 'demux-w'?:number; 'demux-h'?:number; 'demux-fps'?:number; 'demux-channel-count'?:number; 'demux-samplerate'?:number }
export interface PlayerState {
  owner:PlayerOwner; ready:boolean; loading:boolean; path?:string; title:string; durationMs:number; positionMs:number; paused:boolean; volume:number; muted:boolean; speed:number
  tracks:PlayerTrack[]; playlist:{filename:string;current?:boolean;title?:string}[]; playlistIndex:number; audioTrack:number|'no'|'auto'; subtitleTrack:number|'no'|'auto'
  audioDelay:number; subtitleDelay:number; loop:'none'|'file'|'playlist'; loopA?:number; loopB?:number; eof:boolean; fullscreen:boolean; error?:string; version?:string; videoWidth:number; videoHeight:number; videoAspect?:number
}
export function emptyPlayerState(owner:PlayerOwner):PlayerState {return {owner,ready:false,loading:false,title:'',durationMs:0,positionMs:0,paused:true,volume:50,muted:false,speed:1,tracks:[],playlist:[],playlistIndex:-1,audioTrack:'auto',subtitleTrack:'auto',audioDelay:0,subtitleDelay:0,loop:'none',eof:false,fullscreen:false,videoWidth:0,videoHeight:0}}
export interface PlayerEvent {owner:PlayerOwner;type:'set-start'|'set-end'|'undo'|'redo';positionMs:number}
