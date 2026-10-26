import { afterEach,describe,expect,it } from 'vitest'
import { mkdtemp,readFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,resolve,sep } from 'node:path'
import { updateEditorSubtitles } from '../../src/main/player/subtitles'
import { createSubtitleDocument } from '../../src/shared/subtitles'
import { parseAss,serializeAss } from '../../src/core/subtitles/ass'
import type { PlayerTrack } from '../../src/shared/player'

const directories:string[]=[]
afterEach(async()=>{
  for(const directory of directories.splice(0)){
    if(!resolve(directory).startsWith(resolve(tmpdir())+sep)||!directory.includes('muxivra-preview-'))throw new Error('Invalid test directory')
    await rm(directory,{recursive:true,force:true})
  }
})

async function preview(){
  const directory=await mkdtemp(join(tmpdir(),'muxivra-preview-'));directories.push(directory)
  const path=join(directory,'player-subtitles','subtitles.ass'),calls:unknown[][]=[]
  let nextId=3,selected:number|'no'=1,option:number|'no'=1,tracks:PlayerTrack[]=[{id:1,type:'sub',codec:'ass',selected:true}]
  const session={editorTrack:undefined as number|undefined,async command(command:unknown[]){
    calls.push(command)
    if(command[0]==='get_property'&&command[1]==='track-list')return structuredClone(tracks)
    if(command[0]==='get_property'&&command[1]==='sid')return selected==='no'?false:selected
    if(command[0]==='set_property'&&command[1]==='sid'){
      // mpv can keep the old sid option while sub-reload selects a track.
      // Reapplying the unchanged option then skips the actual track switch.
      const value=command[2] as number|'no';if(value!==option){option=value;selected=value}return
    }
    if(command[0]==='sub-add'){
      const id=nextId++;tracks.push({id,type:'sub',external:true,'external-filename':String(command[1])});selected=id;return
    }
    if(command[0]==='sub-reload'){
      const track=tracks.find(track=>track.id===command[1]);if(!track)throw new Error('Track not found')
      track.id=nextId++;selected=track.id;return
    }
    throw new Error(`Unexpected command: ${JSON.stringify(command)}`)
  }}
  return {path,calls,session,get selected(){return selected},disable(){option=selected='no'},chooseEmbedded(){option=selected=1},removeExternal(){tracks=tracks.filter(track=>!track.external)}}
}

describe('editor ASS native preview',()=>{
  it('keeps an empty selected external track after deleting the last cue',async()=>{
    const player=await preview(),document=createSubtitleDocument({cues:[{id:'cue',startMs:1000,endMs:3000,text:'edited'}]})
    await updateEditorSubtitles(player.session,player.path,document)
    expect(player.selected).toBe(3)
    await updateEditorSubtitles(player.session,player.path,{...document,cues:[]})
    expect(player.selected).toBe(4)
    expect(player.session.editorTrack).toBe(4)
    expect(parseAss(await readFile(player.path,'utf8')).cues).toEqual([])
    expect(player.calls.filter(command=>command[0]==='sub-add')).toHaveLength(1)
    expect(player.calls.some(command=>command[0]==='sub-remove')).toBe(false)
  })

  it('uses the current track ID after reload and keeps subtitles disabled when the user disables them',async()=>{
    const player=await preview(),document=createSubtitleDocument()
    await updateEditorSubtitles(player.session,player.path,document)
    player.disable()
    await updateEditorSubtitles(player.session,player.path,document)
    await updateEditorSubtitles(player.session,player.path,document)
    expect(player.calls.filter(command=>command[0]==='sub-reload')).toEqual([['sub-reload',3],['sub-reload',4]])
    expect(player.selected).toBe('no')
    expect(player.session.editorTrack).toBe(5)
    player.chooseEmbedded()
    await updateEditorSubtitles(player.session,player.path,document)
    expect(player.selected).toBe(1)
  })

  it('recovers a removed track and writes every ASS event and script field without preview filters',async()=>{
    const player=await preview(),document=createSubtitleDocument({scriptInfo:{PlayResX:'1920',PlayResY:'1080',LayoutResX:'1920',LayoutResY:'1080','YCbCr Matrix':'TV.709'},cues:[
      {id:'drawing',startMs:1000,endMs:2000,text:'{\\p1\\clip(0,0,100,100)\\t(0,500,\\fscx150)}m 0 0 l 50 50',layer:5},
      {id:'comment',startMs:2000,endMs:2000,text:'retained comment',comment:true},
      {id:'empty',startMs:3000,endMs:4000,text:' '}
    ]})
    await updateEditorSubtitles(player.session,player.path,document)
    expect(await readFile(player.path,'utf8')).toBe(serializeAss(document))
    player.removeExternal()
    await updateEditorSubtitles(player.session,player.path,document)
    expect(player.calls.filter(command=>command[0]==='sub-add')).toHaveLength(2)
    expect(player.calls.some(command=>command[0]==='sub-reload')).toBe(false)
    expect(player.session.editorTrack).toBe(4)
  })
})
