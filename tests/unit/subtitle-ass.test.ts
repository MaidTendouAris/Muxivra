import { describe,expect,it } from 'vitest'
import { subtitleSchema } from '../../src/shared/schema'
import { assColourToHex,createSubtitleDocument,defaultSubtitleStyle,hexToAssColour,normalizeSubtitleDocument } from '../../src/shared/subtitles'
import { assTextToPlain,exportSubtitleText,formatAssTime,parseAss,parseAssTime,parseSubtitleText,serializeAss,serializeSsa,srtTextToAss,subtitleExportLosses } from '../../src/core/subtitles/ass'

const fixture=`[Script Info]
; retained script comment
Title: 自定义标题
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
Custom metadata: 有冒号: 以及逗号,内容

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding, Vendor
Style: Default,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,30,31,32,1,retained
Style: Notes,Arial,24,&H00FFFF00,&H000000FF,&H00000000,&H80000000,0,-1,0,0,100,100,0,0,1,2,0,8,20,20,20,1,note
; retained style comment

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Vendor, Text
Dialogue: 3,0:00:01.23,0:00:02.34,Notes,演员,0010,0011,0012,,abc,{\\i1}Hello, comma\\N第二行
Comment: 0,0:00:02.50,0:00:03.00,Default,,0000,0000,0000,,xyz,草稿注释
; retained event comment

[Aegisub Project Garbage]
Video File: video.mp4
Audio File: audio.wav

[Vendor Data]
arbitrary: line,with,commas`

describe('ASS document codecs',()=>{
  it('upgrades legacy sessions to ASS and retains unfinished cues without changing milliseconds',()=>{
    const legacy={id:'old',cues:[{id:'cue',startMs:1234,endMs:1000,text:''}]}
    const document=normalizeSubtitleDocument(legacy)
    expect(document).toMatchObject({id:'old',version:2,format:'ass',exportFormat:'ass',cues:[{id:'cue',startMs:1234,endMs:1000,text:'',style:'Default',layer:0}]})
    expect(document.styles).toHaveLength(1)
    expect(subtitleSchema.parse(document)).toEqual(document)
    expect(serializeAss(document)).toContain('0:00:01.23,0:00:01.00')
    expect(document.cues[0].startMs).toBe(1234)
  })
  it('round trips metadata, both event kinds, commas, editable hard breaks, styles and unknown sections/fields',()=>{
    const original=parseAss(fixture)
    const saved=parseAss(serializeAss(original))
    expect(saved.scriptInfo).toEqual(original.scriptInfo)
    expect(saved.styles).toEqual(original.styles)
    expect(saved.sections).toEqual(original.sections)
    expect(saved.cues.map(({id,...cue})=>cue)).toEqual(original.cues.map(({id,...cue})=>cue))
    expect(saved.cues[0].text).toBe('{\\i1}Hello, comma\n第二行')
    expect(saved.cues[0]).toMatchObject({layer:3,style:'Notes',name:'演员',marginL:10,marginR:11,marginV:12,extra:{Vendor:'abc'}})
    expect(saved.sectionLines.Events).toContain('; retained event comment')
    expect(saved.sectionLines['V4+ Styles']).toContain('; retained style comment')
    expect(saved.sectionLines['Script Info']).toContain('; retained script comment')
    expect(subtitleSchema.parse(saved)).toEqual(saved)
  })
  it('respects declared field order and retains comma-containing text even when Text is not last',()=>{
    const document=parseAss(`[Script Info]\nScriptType: v4.00+\n[Events]\nFormat: Text, Start, End, Style\nDialogue: a,b,c,0:00:00.00,0:00:01.00,Default`)
    expect(document.cues[0].text).toBe('a,b,c')
    expect(parseAss(serializeAss(document)).cues[0].text).toBe('a,b,c')
    expect(document.eventFormat.at(-1)).toBe('Text')
  })
  it('preserves unknown extra fields created via the document API',()=>{
    const document=createSubtitleDocument({cues:[{id:'1',startMs:0,endMs:1000,text:'x',extra:{Vendor:'event'}}],styles:[defaultSubtitleStyle({extra:{Vendor:'style'}})]})
    const saved=parseAss(serializeAss(document))
    expect(saved.cues[0].extra).toEqual({Vendor:'event'})
    expect(saved.styles[0].extra).toEqual({Vendor:'style'})
  })
  it('keeps layered opening effects, subset font names and karaoke as opaque ASS text in source order',()=>{
    const opening='{\\fnSUBSET42\\an7\\org(960,540)\\pos(320.5,80)\\frx12\\fry-30\\frz6\\fax0.2\\blur0.8\\1c&HFAFBF7&\\alpha&H60&\\t(0,450,1.2,\\alpha&H00&\\fscx120)\\clip(1,m 0 0 l 150 0 150 60 0 60)\\p1}m 0 0 b 15 20 40 20 60 0{\\p0}{\\k15}Ka{\\kf30}ra{\\ko45}oke\\hword\\nsoft\nsecond line'
    const document=createSubtitleDocument({styles:[defaultSubtitleStyle({name:'OP - JP',fontName:'SUBSET42',spacing:1.5,outline:2.2})],cues:[
      {id:'effect',startMs:126030,endMs:126780,text:opening,layer:8,style:'OP - JP',name:'singer',effect:'karaoke'},
      {id:'background',startMs:126030,endMs:126780,text:'{\\move(0,0,100,100,0,750)\\p1}m 0 0 l 20 0 20 20 0 20',layer:7,style:'OP - JP'},
      {id:'note',startMs:0,endMs:1000,text:'effect source note',comment:true,style:'OP - JP'}
    ]})
    const saved=parseAss(serializeAss(document))
    expect(saved.cues.map(({id,...cue})=>cue)).toEqual(document.cues.map(({id,...cue})=>cue))
    expect(saved.styles.find(style=>style.name==='OP - JP')).toEqual(document.styles.find(style=>style.name==='OP - JP'))
    expect(saved.cues[0].text).toBe(opening)
    expect(subtitleSchema.parse(saved)).toEqual(saved)
    expect(subtitleExportLosses(saved,'ass')).toEqual([])
  })
  it('accepts existing case-variant style names and canonicalizes standard script keys',()=>{
    const document=createSubtitleDocument({styles:[defaultSubtitleStyle({name:'default',fontSize:24})],scriptInfo:{playresx:'1280',playresy:'720',scripttype:'v4.00+',title:'Case'}})
    expect(document.styles.some(style=>style.name==='default')).toBe(true)
    expect(document.scriptInfo).toMatchObject({PlayResX:'1280',PlayResY:'720',ScriptType:'v4.00+',Title:'Case'})
    expect(document.scriptInfo).not.toHaveProperty('playresx')
    expect(()=>parseAss(serializeAss(document))).not.toThrow()
  })
  it('imports SSA into ASS, translating alignment, tertiary colour and alpha',()=>{
    const ssa=`[Script Info]\nScriptType: v4.00\n[V4 Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding\nStyle: Default,Arial,32,16777215,255,65280,0,-1,0,1,2,1,6,10,11,12,64,1\n[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: Marked=1,0:00:00.00,0:00:01.20,Default,,0000,0000,0000,,SSA\\N文本`
    const document=parseAss(ssa,'ssa')
    expect(document).toMatchObject({format:'ass',exportFormat:'ssa',scriptInfo:{ScriptType:'v4.00+'},styles:[{name:'Default',alignment:8,outlineColour:'&H4000FF00',primaryColour:'&H40FFFFFF'}]})
    expect(document.cues[0].extra).toEqual({Marked:'1'})
    const roundtrip=parseAss(serializeSsa(document),'ssa')
    expect(roundtrip.styles[0].alignment).toBe(8)
    expect(roundtrip.styles[0].outlineColour).toBe('&H4000FF00')
    expect(roundtrip.cues[0].text).toBe('SSA\n文本')
    expect(roundtrip.cues[0].extra).toEqual({Marked:'1'})
  })
  it('imports SRT styling as ASS overrides and preserves HTML entities as text',()=>{
    const text='1\n00:00:01,234 --> 00:00:02,345\n<i>斜体</i> <b>粗体</b> <u>下划线</u> <font color="#FF8800">颜色</font> &amp; &lt;字符&gt;'
    const document=parseSubtitleText(text,'srt')
    expect(document.format).toBe('ass')
    expect(document.exportFormat).toBe('srt')
    expect(document.cues[0].text).toBe('{\\i1}斜体{\\i0} {\\b1}粗体{\\b0} {\\u1}下划线{\\u0} {\\c&H0088FF&}颜色{\\c} & <字符>')
    expect(document.cues[0].startMs).toBe(1234)
    expect(srtTextToAss('<br>&#65;&#x42;')).toBe('\nAB')
  })
  it('restores outer SRT colour and emphasis for nested markup',()=>{
    expect(srtTextToAss('<font color="#ff0000">A<font color="#00ff00">B</font>C</font>')).toBe('{\\c&H0000ff&}A{\\c&H00ff00&}B{\\c&H0000ff&}C{\\c}')
    expect(srtTextToAss('<b>A<b>B</b>C</b>')).toBe('{\\b1}A{\\b1}B{\\b1}C{\\b0}')
  })
  it('uses edited ASS transparency rather than the imported SSA AlphaLevel on SSA export',()=>{
    const document=createSubtitleDocument({styles:[defaultSubtitleStyle({primaryColour:'&H80FFFFFF',extra:{AlphaLevel:'64'}})]})
    expect(parseAss(serializeSsa(document),'ssa').styles[0].primaryColour).toBe('&H80FFFFFF')
  })
  it('downgrades SRT without leaking ASS drawing commands and reports losses',()=>{
    const document=createSubtitleDocument({styles:[defaultSubtitleStyle({name:'Default',fontSize:30})],sections:[{name:'Extra',lines:['metadata']}],cues:[
      {id:'text',startMs:1000,endMs:2000,text:'{\\pos(30,40)\\i1}One\\Ntwo\\nthree\\hfour{\\p1}m 0 0 l 20 20{\\p0} end',style:'Default',layer:3},
      {id:'drawing',startMs:2000,endMs:3000,text:'{\\p1}m 0 0 l 20 20'},
      {id:'comment',startMs:3000,endMs:4000,text:'private note',comment:true},
      {id:'empty',startMs:0,endMs:0,text:''}
    ]})
    const srt=exportSubtitleText(document,'srt')
    expect(srt).toContain('One\r\ntwo\r\nthree\u00a0four end')
    expect(srt).not.toMatch(/\\pos|m 0 0|private note|Default/)
    expect((srt.match(/-->/g)??[])).toHaveLength(1)
    const losses=subtitleExportLosses(document,'srt')
    expect(losses.some(loss=>loss.includes('覆盖标签'))).toBe(true)
    expect(losses.some(loss=>loss.includes('矢量绘图'))).toBe(true)
    expect(losses.some(loss=>loss.includes('注释'))).toBe(true)
    expect(losses.some(loss=>loss.includes('样式表'))).toBe(true)
    expect(document.cues).toHaveLength(4)
  })
  it('rejects malformed timing for SRT export while retaining it in the ASS project',()=>{
    const document=createSubtitleDocument({cues:[{id:'draft',startMs:2000,endMs:1000,text:'editing'}]})
    expect(()=>exportSubtitleText(document,'srt')).toThrow('修正结束时间')
    expect(()=>serializeAss(document)).not.toThrow()
  })
  it('allows an empty document and collapses empty SRT separator lines',()=>{
    const document=createSubtitleDocument()
    expect(parseAss(serializeAss(document)).cues).toEqual([])
    expect(exportSubtitleText(document,'srt')).toBe('')
    document.cues=[{id:'1',startMs:0,endMs:1000,text:'first\n\nsecond'}]
    expect(exportSubtitleText(document,'srt')).toContain('first\r\nsecond')
    expect(subtitleExportLosses(document,'srt').some(loss=>loss.includes('空行'))).toBe(true)
  })
  it('explicitly reports centisecond quantization without mutating cached time',()=>{
    const document=createSubtitleDocument({cues:[{id:'1',startMs:1236,endMs:2344,text:'precise'}]})
    expect(subtitleExportLosses(document,'ass').join()).toContain('10 毫秒')
    expect(parseAss(serializeAss(document)).cues[0]).toMatchObject({startMs:1240,endMs:2340})
    expect(document.cues[0]).toMatchObject({startMs:1236,endMs:2344})
    expect(formatAssTime(359999999)).toBe('99:59:59.99')
  })
  it('reports SSA-only style, transparency and layer downgrades',()=>{
    const document=createSubtitleDocument({styles:[defaultSubtitleStyle({underline:true,scaleX:120})],cues:[{id:'1',startMs:0,endMs:1000,text:'x',layer:2}]})
    const losses=subtitleExportLosses(document,'ssa').join('\n')
    expect(losses).toContain('图层')
    expect(losses).toContain('下划线')
    expect(losses).toContain('透明度')
    const ssa=parseAss(serializeSsa(document),'ssa')
    expect(ssa.styles[0].underline).toBe(false)
    expect(ssa.styles[0].scaleX).toBe(100)
  })
  it('retains vector mode until an explicit reset, including mixed overrides',()=>{
    expect(assTextToPlain('before{\\p1\\c&HFFFFFF&}m 0 0{\\i1}l 4 4{\\p0}after')).toBe('beforeafter')
    expect(assTextToPlain('{inline comment}text')).toBe('text')
  })
  it('validates time and structural fields instead of injecting new ASS records',()=>{
    expect(()=>parseAss('not an ASS subtitle')).toThrow('缺少 [Events]')
    expect(()=>parseAss('')).toThrow('缺少 [Events]')
    expect(()=>parseAss('[Script Info]\nTitle: incomplete')).toThrow('缺少 [Events]')
    expect(parseAss('[Events]').cues).toEqual([])
    expect(()=>parseAssTime('0:60:00.00')).toThrow()
    expect(()=>parseAssTime('100:00:00.00')).toThrow()
    expect(()=>normalizeSubtitleDocument({id:'1',cues:[{id:'x',startMs:-1,endMs:3,text:'x'}]})).toThrow()
    expect(()=>createSubtitleDocument({scriptInfo:{Title:'x\n[Events]'}})).toThrow()
    expect(()=>createSubtitleDocument({styles:[defaultSubtitleStyle({fontName:'Arial,evil'})]})).toThrow()
    expect(()=>createSubtitleDocument({sections:[{name:'Injected',lines:['[Events]']}]})).toThrow()
    expect(()=>createSubtitleDocument({cues:[{id:'x',startMs:0,endMs:1,text:'x',extra:{Vendor:'x\nDialogue: y'}}]})).toThrow()
    expect(()=>parseAss('[Events]\nFormat: Start, End, Text\nDialogue: invalid,0:00:01.00,x')).toThrow('第 3 行')
    expect(()=>parseAss('[Events]\nFormat: Start, End, Start, Text')).toThrow('重复')
  })
  it('converts ASS BGR colours accurately, including decimal SSA values and alpha',()=>{
    expect(assColourToHex('&H80112233')).toBe('#332211')
    expect(assColourToHex('255')).toBe('#FF0000')
    expect(hexToAssColour('#FF8800',128)).toBe('&H800088FF')
    expect(()=>hexToAssColour('bad')).toThrow()
  })
})
