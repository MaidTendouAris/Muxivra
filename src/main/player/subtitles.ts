import { mkdir,writeFile } from 'node:fs/promises'
import { dirname,resolve } from 'node:path'
import { serializeAss } from '../../core/subtitles/ass'
import type { PlayerTrack } from '../../shared/player'
import type { SubtitleDocument } from '../../shared/types'

interface EditorSubtitleSession {
  editorTrack?:number
  command(command:unknown[]):Promise<any>
}

function samePath(left:string,right:string):boolean {
  const a=resolve(left),b=resolve(right)
  return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b
}

/** Update the external ASS while retaining the user's subtitle selection. */
export async function updateEditorSubtitles(session:EditorSubtitleSession,path:string,document:SubtitleDocument):Promise<void> {
  await mkdir(dirname(path),{recursive:true})
  // An empty ASS is a valid selected track. An initially empty document still
  // needs one, otherwise mpv keeps showing the original embedded subtitles.
  // Leave all events to libass, including comments and zero-duration events.
  await writeFile(path,serializeAss(document))
  const find=(tracks:PlayerTrack[])=>tracks.find(track=>track.type==='sub'&&track.external&&track['external-filename']&&samePath(track['external-filename'],path))
  const existing=find(await session.command(['get_property','track-list']))
  const selected=existing?await session.command(['get_property','sid']):undefined
  if(existing)await session.command(['sub-reload',existing.id])
  else await session.command(['sub-add',path,'select','编辑字幕'])
  // sub-reload unloads and adds a track. Resolve its current ID instead of
  // retaining a stale ID, and preserve any subtitle selection made by the user.
  const current=find(await session.command(['get_property','track-list']))
  if(!current)throw new Error('无法载入编辑字幕预览')
  session.editorTrack=current.id
  // mpv reselects a reloaded track even when the user disabled subtitles or
  // selected an embedded track. Restore that deliberate choice after reload.
  if(existing&&selected!==existing.id){
    // Reload changes actual selection without updating mpv's sid option. Make
    // the option match first, or setting its previous value can be a no-op.
    await session.command(['set_property','sid',current.id])
    await session.command(['set_property','sid',selected===false?'no':selected])
  }
}
