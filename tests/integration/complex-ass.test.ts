import { existsSync } from 'node:fs'
import { mkdir,mkdtemp,readFile,readdir,rm,stat,writeFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { describe,expect,it } from 'vitest'
import { detectEngine } from '../../src/core/engine'
import { run } from '../../src/core/engine/process'
import { isWithin } from '../../src/core/media/paths'
import { escapeFilterValue } from '../../src/core/media/plan'
import { ensureProjectFonts } from '../../src/core/media/project-fonts'
import { parseAss,serializeAss,subtitleExportLosses } from '../../src/core/subtitles/ass'
import { subtitleSchema } from '../../src/shared/schema'
import type { Cue } from '../../src/shared/subtitles'

// This local, licensed media fixture is deliberately not checked into Git.
const target=resolve('tests/media/[KitaujiSub] Make Heroine ga Oosugiru! [06][WebRip][HEVC_AAC][CHS_JP&CHT_JP].mkv')
const tracks=[{index:2,name:'chs-jp',events:10112,drawings:5493,maxText:2295},{index:3,name:'cht-jp',events:10506,drawings:5887,maxText:1929}]
function rawEvents(text:string) {
  const time=(value:string)=>{const [h,m,s]=value.split(':');return Math.round((Number(h)*3600+Number(m)*60+Number(s))*1000)}
  return text.split(/\r?\n/).filter(line=>/^(?:Dialogue|Comment):/.test(line)).map(line=>{
    const [kind,...values]=line.split(',')
    return {layer:Number(kind.slice(kind.indexOf(':')+1)),startMs:time(values[0]),endMs:time(values[1]),style:values[2],name:values[3],marginL:Number(values[4]),marginR:Number(values[5]),marginV:Number(values[6]),effect:values[7],comment:kind.startsWith('Comment:'),text:values.slice(8).join(',')}
  })
}
function eventValue(cue:Cue) {
  const {layer,startMs,endMs,style,name,marginL,marginR,marginV,effect,comment,text}=cue
  return {layer,startMs,endMs,style,name,marginL,marginR,marginV,effect,comment,text:text.replace(/\n/g,'\\N')}
}

describe.skipIf(!existsSync(target))('complex anime ASS round trip against the local MKV fixture',()=>{
  it('preserves every event, source style, timing, override and font-subset record on both tracks',async()=>{
    const engine=await detectEngine()
    if(!engine)throw new Error('This audit requires FFmpeg and ffprobe on PATH')
    await mkdir('.test-data',{recursive:true})
    const root=await mkdtemp(resolve('.test-data','complex-ass-'))
    try {
      const before=await stat(target)
      const probe=JSON.parse(await run(engine.ffprobePath,['-v','error','-show_entries','stream=index,codec_name,codec_type:stream_tags=filename,title','-of','json',target])) as {streams:{index:number;codec_type:string;codec_name:string;tags?:Record<string,string>}[]}
      expect(probe.streams.filter(stream=>stream.codec_type==='subtitle').map(stream=>stream.index)).toEqual([2,3])
      const fonts=probe.streams.filter(stream=>stream.codec_type==='attachment')
      expect(fonts).toHaveLength(21)
      const fontsDirectory=await ensureProjectFonts(engine,target,root)
      expect(fontsDirectory).toBeDefined();expect(await readdir(fontsDirectory!)).toHaveLength(21)
      expect(await ensureProjectFonts(engine,target,root)).toBe(fontsDirectory)
      const render=async(subtitle?:string,seconds=0)=>{
        const filter=`setpts=PTS+${seconds}/TB${subtitle?`,subtitles=filename=${escapeFilterValue(subtitle.replace(/\\/g,'/'))}:fontsdir=${escapeFilterValue(fontsDirectory!.replace(/\\/g,'/'))}`:''}`
        const output=await run(engine.ffmpegPath,['-v','error','-f','lavfi','-i','color=c=black:s=1920x1080:r=25:d=0.04','-vf',filter,'-frames:v','1','-f','framemd5','pipe:1'])
        return output.split(/\r?\n/).filter(line=>line&&!line.startsWith('#')).at(-1)?.split(',').at(-1)?.trim()
      }
      const blankFrame=await render()
      expect(blankFrame).toMatch(/^[a-f0-9]{32}$/)
      const results=[]
      for(const track of tracks) {
        const sourcePath=join(root,`${track.name}.ass`)
        await run(engine.ffmpegPath,['-v','error','-i',target,'-map',`0:${track.index}`,'-c:s','copy',sourcePath])
        const source=await readFile(sourcePath,'utf8'),expected=rawEvents(source),start=performance.now(),document=parseAss(source),parsedAt=performance.now()
        subtitleSchema.parse(document)
        const validatedAt=performance.now(),serialized=serializeAss(document),serializedAt=performance.now(),reopened=parseAss(serialized)
        // Compare raw source events too: a self-round-trip alone can miss import loss.
        expect(document.cues).toHaveLength(track.events)
        expect(document.cues.findIndex((cue,index)=>JSON.stringify(eventValue(cue))!==JSON.stringify(expected[index]))).toBe(-1)
        expect(reopened.cues.findIndex((cue,index)=>JSON.stringify(eventValue(cue))!==JSON.stringify(expected[index]))).toBe(-1)
        expect(reopened.cues.map(({id,...cue})=>cue)).toEqual(document.cues.map(({id,...cue})=>cue))
        expect(reopened.scriptInfo).toEqual(document.scriptInfo)
        expect(reopened.styles).toEqual(document.styles)
        expect(reopened.sections).toEqual(document.sections)
        expect(reopened.sectionLines).toEqual(document.sectionLines)
        const sourceStyles=source.split(/\r?\n/).filter(line=>line.startsWith('Style:'))
        const savedStyles=serialized.split(/\r?\n/).filter(line=>line.startsWith('Style:')&&!line.startsWith('Style: Default,'))
        expect(savedStyles).toEqual(sourceStyles)
        expect(sourceStyles).toHaveLength(13)
        expect(document.cues.filter(cue=>cue.comment)).toHaveLength(21)
        expect(document.cues.filter(cue=>/\\p[1-9]\d*/.test(cue.text))).toHaveLength(track.drawings)
        expect(Math.max(...document.cues.map(cue=>cue.text.length))).toBe(track.maxText)
        expect(document.cues.filter(cue=>/\\(?:k|K|kf|ko)\d/.test(cue.text))).toHaveLength(4)
        expect(document.cues.filter(cue=>cue.effect)).toHaveLength(0)
        expect(subtitleExportLosses(document,'ass')).toEqual([])
        const savedPath=join(root,`${track.name}.roundtrip.ass`)
        await writeFile(savedPath,serialized)
        // Real libass pixel equality covers OP karaoke, animated drawings and ED text.
        for(const seconds of [126.4,155,1355]) {
          const original=await render(sourcePath,seconds),saved=await render(savedPath,seconds)
          expect(original).toMatch(/^[a-f0-9]{32}$/)
          expect(saved).toBe(original)
          expect(saved).not.toBe(blankFrame)
        }
        results.push({track:track.index,events:document.cues.length,sourceStyles:sourceStyles.length,parseMs:Math.round(parsedAt-start),schemaMs:Math.round(validatedAt-parsedAt),serializeMs:Math.round(serializedAt-validatedAt),assBytes:Buffer.byteLength(source),identicalRenderedFrames:3})
      }
      const after=await stat(target)
      expect({size:after.size,mtimeMs:after.mtimeMs}).toEqual({size:before.size,mtimeMs:before.mtimeMs})
      console.info('Complex ASS audit:',JSON.stringify(results))
    } finally {
      if(!isWithin(resolve('.test-data'),root))throw new Error('Unsafe audit cleanup')
      await rm(root,{recursive:true,force:true})
    }
  })
})
