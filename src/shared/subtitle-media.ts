import type { MediaInfo,TranscodeOptions } from './types'
export interface SubtitleMediaTransfer {id:string;projectId:string;projectName:string;media:MediaInfo;subtitlePath:string;outputDirectory:string}
export function subtitleTransferOptions(path:string):TranscodeOptions {return {container:'mkv',video:'copy',audio:'copy',quality:22,speed:'medium',audioBitrate:192,subtitles:'none',conflict:'number',subtitleFile:path,subtitleMode:'embed'}}
export function changeSubtitleMode(value:TranscodeOptions,mode:'embed'|'burn'):TranscodeOptions {
  const advanced={...value.advanced};delete advanced.burnSubtitle
  if(mode==='embed')for(const key of Object.keys(advanced))if(key.startsWith('subtitle'))delete advanced[key]
  const container=mode==='embed'&&!['mkv','mp4','mov'].includes(value.container)?'mkv':mode==='burn'&&['m4a','mp3','wav','flac','ogg','opus','srt'].includes(value.container)?'mp4':value.container
  return {...value,presetId:undefined,subtitleMode:mode,container,video:mode==='burn'&&['copy','none'].includes(value.video)?'libx264':value.video,advanced}
}
