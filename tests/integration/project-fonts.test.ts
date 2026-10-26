import { mkdir,mkdtemp,readFile,readdir,rm,writeFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { expect,it } from 'vitest'
import { detectEngine } from '../../src/core/engine'
import { run } from '../../src/core/engine/process'
import { isWithin } from '../../src/core/media/paths'
import { inspectMedia } from '../../src/core/media/probe'
import { buildPlan } from '../../src/core/media/plan'
import { ensureProjectFonts } from '../../src/core/media/project-fonts'
import { serializeAss } from '../../src/core/subtitles/ass'
import { createSubtitleDocument,defaultSubtitleStyle } from '../../src/shared/subtitles'
import { changeSubtitleMode,subtitleTransferOptions } from '../../src/shared/subtitle-media'

it('extracts a real attached font, uses it for external ASS burn-in and preserves it in MKV muxing',async()=>{
  const engine=await detectEngine();if(!engine)throw new Error('Font integration requires FFmpeg and ffprobe on PATH')
  await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data','project-fonts-'))
  try {
    const font=resolve('tests/fixtures/fonts/muxivra-test.ttf'),source=join(root,'source.mkv'),subtitle=join(root,'edited.ass')
    await run(engine.ffmpegPath,['-v','error','-f','lavfi','-i','color=c=black:s=320x180:r=25:d=1','-c:v','libx264','-attach',font,'-metadata:s:t:0','mimetype=application/x-truetype-font','-metadata:s:t:0','filename=../../untrusted-name.ttf',source])
    const media=await inspectMedia(engine,source),fonts=await ensureProjectFonts(engine,source,root)
    expect(fonts).toBeDefined();expect(await readdir(fonts!)).toEqual(['font-1.ttf'])
    expect(await readFile(join(fonts!,'font-1.ttf'))).toEqual(await readFile(font))
    expect(await ensureProjectFonts(engine,source,root)).toBe(fonts)
    await writeFile(subtitle,serializeAss(createSubtitleDocument({scriptInfo:{PlayResX:'320',PlayResY:'180'},styles:[defaultSubtitleStyle({fontName:'Muxivra Test Attached',fontSize:80,outline:0,shadow:0,alignment:5,marginL:0,marginR:0,marginV:0})],cues:[{id:'line',startMs:0,endMs:1000,text:'A'}]})))
    const options=subtitleTransferOptions(subtitle),embedded=buildPlan(engine,media,join(root,'embedded.mkv'),options)
    await run(engine.ffmpegPath,embedded.args)
    const muxed=await inspectMedia(engine,embedded.outputPath)
    expect(muxed.streams.filter(stream=>stream.type==='subtitle').map(stream=>stream.codec)).toEqual(['ass'])
    expect(muxed.streams.filter(stream=>stream.type==='attachment')).toHaveLength(1)
    const reopened=join(root,'reopened');await mkdir(reopened)
    const exportedFonts=await ensureProjectFonts(engine,embedded.outputPath,reopened)
    expect(await readFile(join(exportedFonts!,`font-${muxed.streams.find(stream=>stream.type==='attachment')!.index}.ttf`))).toEqual(await readFile(font))
    const burned=buildPlan(engine,media,join(root,'burned.mkv'),changeSubtitleMode(options,'burn'),{subtitleFontsDirectory:fonts})
    const fallback=buildPlan(engine,media,join(root,'fallback.mkv'),changeSubtitleMode(options,'burn'))
    await run(engine.ffmpegPath,burned.args);await run(engine.ffmpegPath,fallback.args)
    const frame=async(path:string)=>{
      const output=await run(engine.ffmpegPath,['-v','error','-ss','0.5','-i',path,'-frames:v','1','-f','framemd5','pipe:1'])
      return output.split(/\r?\n/).filter(line=>line&&!line.startsWith('#')).at(-1)?.split(',').at(-1)?.trim()
    }
    const original=await frame(source),withFont=await frame(burned.outputPath),withoutFont=await frame(fallback.outputPath)
    expect(withFont).toMatch(/^[a-f0-9]{32}$/);expect(withFont).not.toBe(original);expect(withFont).not.toBe(withoutFont)
    expect((await inspectMedia(engine,burned.outputPath)).streams.some(stream=>stream.type==='subtitle')).toBe(false)
  } finally {
    if(!isWithin(resolve('.test-data'),root))throw new Error('Unsafe font test cleanup')
    await rm(root,{recursive:true,force:true})
  }
})
