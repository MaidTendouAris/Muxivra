import { existsSync } from 'node:fs'
import { mkdir,mkdtemp,readFile,rm } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import koffi from 'koffi'
import { describe,expect,it } from 'vitest'
import { updateEditorSubtitles } from '../../src/main/player/subtitles'
import { createSubtitleDocument } from '../../src/shared/subtitles'
import { isWithin } from '../../src/core/media/paths'

const media=resolve('tests/media/[KitaujiSub] Make Heroine ga Oosugiru! [06][WebRip][HEVC_AAC][CHS_JP&CHT_JP].mkv')
const libraryPath=resolve('resources/mpv/libmpv-2.dll')

describe.skipIf(process.platform!=='win32'||!existsSync(media)||!existsSync(libraryPath))('bundled libmpv ASS preview on the local MKV fixture',()=>{
  it('selects an empty edited ASS and retains disabled or embedded selections across real native reloads',async()=>{
    await mkdir('.test-data',{recursive:true})
    const root=await mkdtemp(resolve('.test-data','native-ass-')),path=join(root,'preview.ass')
    const library=koffi.load(libraryPath),handle=library.func('void *mpv_create()')()
    const set=library.func('int mpv_set_option_string(void *,const char *,const char *)')
    const nativeCommand=library.func('int mpv_command_async(void *,uint64_t,const char **)')
    const setProperty=library.func('int mpv_set_property_string(void *,const char *,const char *)')
    const waitEvent=library.func('void *mpv_wait_event(void *,double)')
    const eventType=koffi.struct({event_id:'int',error:'int',reply_userdata:'uint64_t',data:'void *'})
    const get=library.func('void *mpv_get_property_string(void *,const char *)'),free=library.func('void mpv_free(void *)')
    const errorString=library.func('const char *mpv_error_string(int)')
    const check=(code:number)=>{if(code<0)throw new Error(`libmpv: ${errorString(code)}`)}
    const property=(name:string):string|null=>{const pointer=get(handle,name);if(!pointer)return null;try{return koffi.decode(pointer,'char',-1) as string}finally{free(pointer)}}
    let request=0
    const command=async(values:unknown[])=>{
      const id=++request;check(nativeCommand(handle,id,[...values.map(String),null]))
      const deadline=Date.now()+10000
      while(Date.now()<deadline){
        const event=koffi.decode(waitEvent(handle,0),eventType) as {event_id:number;error:number;reply_userdata:number|bigint}
        if(event.event_id===5&&Number(event.reply_userdata)===id){check(event.error);return}
        await new Promise(resolve=>setTimeout(resolve,2))
      }
      throw new Error(`libmpv command timed out: ${String(values[0])}`)
    }
    const session={editorTrack:undefined as number|undefined,async command(values:unknown[]):Promise<any>{
      if(values[0]==='get_property'){
        if(values[1]==='sid'){const value=property('sid');return value==='no'?false:Number(value)}
        if(values[1]==='track-list')return Array.from({length:Number(property('track-list/count'))},(_,index)=>({
          id:Number(property(`track-list/${index}/id`)),type:property(`track-list/${index}/type`),external:property(`track-list/${index}/external`)==='yes',
          'external-filename':property(`track-list/${index}/external-filename`)
        }))
      }
      if(values[0]==='set_property'){check(setProperty(handle,String(values[1]),String(values[2])));return}
      await command(values)
    }}
    try {
      if(!handle)throw new Error('Cannot create libmpv')
      for(const [name,value]of Object.entries({config:'no','load-scripts':'no',vo:'null',audio:'no',idle:'yes',pause:'yes','sub-auto':'no',demuxer:'lavf','embeddedfonts':'yes','sub-ass-override':'no','sub-ass-use-video-data':'all',terminal:'no'}))check(set(handle,name,value))
      check(library.func('int mpv_initialize(void *)')(handle))
      await command(['loadfile',media])
      const deadline=Date.now()+10000
      while(Number(property('track-list/count'))<4&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25))
      expect(Number(property('track-list/count'))).toBe(4)
      expect(property('sid')).toBe('1')
      expect(property('sub-ass-override')).toBe('no')
      const empty=createSubtitleDocument({mediaPath:media})
      await updateEditorSubtitles(session,path,empty)
      expect(property('sid')).toBe(String(session.editorTrack))
      expect((await session.command(['get_property','track-list'])).filter((track:any)=>track.external)).toHaveLength(1)
      await updateEditorSubtitles(session,path,{...empty,cues:[{id:'cue',startMs:1000,endMs:2000,text:'{\\pos(50,50)}Edited'}]})
      await updateEditorSubtitles(session,path,empty)
      expect(property('sid')).toBe(String(session.editorTrack))
      expect(await readFile(path,'utf8')).not.toContain('Dialogue:')
      await command(['set','sid','no'])
      expect(property('sid')).toBe('no')
      await updateEditorSubtitles(session,path,empty)
      expect(property('sid')).toBe('no')
      await command(['set','sid','2'])
      await updateEditorSubtitles(session,path,empty)
      expect(property('sid')).toBe('2')
    }finally{
      if(handle)library.func('void mpv_terminate_destroy(void *)')(handle)
      if(!isWithin(resolve('.test-data'),root))throw new Error('Invalid native test directory')
      await rm(root,{recursive:true,force:true})
    }
  },30000)
})
