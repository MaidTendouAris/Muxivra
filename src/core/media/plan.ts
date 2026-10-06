import { extname } from 'node:path'
import type { Engine, MediaInfo, Plan, TranscodeOptions } from '../../shared/types'
import { optionsSchema } from '../../shared/schema'
import { parameters, filterLibrary } from '../../shared/parameters'
import { inputFormatWhitelist } from '../../shared/media-policy'

const mp4Video = new Set(['h264','hevc','av1','mpeg4','mjpeg','png','vp9'])
const mp4Audio = new Set(['aac','mp3','alac','ac3','eac3','opus'])
const audioFormats = new Set(['m4a','mp3','wav','flac','ogg','opus'])
const imageFormats = new Set(['png','jpg','webp','gif'])
// Escape the AVOption value, then the enclosing filtergraph. Arguments go directly to spawn, with no shell layer.
export const escapeFilterValue = (value:string) => value.replace(/[\\':]/g,c=>'\\'+c).replace(/[\\'[\],;]/g,c=>'\\'+c)
function filterText(name:string,options:Record<string,string>):string {const pairs=Object.entries(options).map(([key,value])=>`${key}=${escapeFilterValue(value)}`);return name+(pairs.length?'='+pairs.join(':'):'')}
export function buildPlan(engine: Engine, media: MediaInfo, outputPath: string, inputOptions: TranscodeOptions): Plan {
  const options = optionsSchema.parse(inputOptions) as TranscodeOptions, a=options.advanced??{}
  if(Object.keys(a).some(key=>key.startsWith('subtitle'))&&a.burnSubtitle===undefined&&!options.subtitleFile)throw new Error('字幕样式需要先选择烧录字幕来源')
  if(a.imageLoop!==undefined&&!['gif','webp'].includes(options.container))throw new Error('动画循环仅适用于 GIF / WebP')
  if(a.imageQuality!==undefined&&!['jpg','webp'].includes(options.container))throw new Error('图像质量仅适用于 JPEG / WebP')
  if(options.container==='jpg'&&Number(a.imageQuality??1)>31)throw new Error('JPEG 质量值范围为 1–31')
  if(['png','jpg'].includes(options.container)&&Number(a.videoFrames??1)>1)throw new Error('PNG / JPEG 单文件输出只能保存一帧')
  if (media.path.toLowerCase() === outputPath.toLowerCase()) throw new Error('输出不能是原文件')
  if (extname(outputPath).slice(1).toLowerCase() !== options.container) throw new Error(`输出扩展名必须是 .${options.container}`)
  const selected = options.streamIndices === undefined ? media.streams : media.streams.filter(s => options.streamIndices!.includes(s.index))
  if (options.streamIndices && (new Set(options.streamIndices).size !== options.streamIndices.length || selected.length !== options.streamIndices.length)) throw new Error('轨道选择包含重复或不存在的轨道')
  const video=selected.filter(s=>s.type==='video'),audio=selected.filter(s=>s.type==='audio'),subtitles=selected.filter(s=>s.type==='subtitle')
  const warnings:string[]=[],args=['-hide_banner','-nostats','-n']
  const start=Number(a.start??0),end=a.end===undefined?media.durationMs/1000:Number(a.end)
  if(a.end!==undefined&&end<=start)throw new Error('结束时间必须大于开始时间')
  if(media.durationMs>0&&start>=media.durationMs/1000)throw new Error('开始时间超出媒体时长')
  const duration=Math.min(end-start,Number(a.duration??Infinity))
  if(start&&a.seekMode==='fast')args.push('-ss',String(start))
  for(const p of parameters.filter(p=>p.scope==='input'&&p.flag))if(a[p.key]!==undefined)args.push('-'+p.flag,String(a[p.key]))
  if(a.decoder&&!engine.decoders.includes(String(a.decoder)))throw new Error(`当前引擎不支持解码器 ${a.decoder}`)
  if(a.autorotate==='off')args.push('-noautorotate')
  args.push('-protocol_whitelist','file,pipe','-format_whitelist',inputFormatWhitelist,'-i',media.path)
  if(start&&a.seekMode!=='fast')args.push('-ss',String(start))
  if(a.end!==undefined||a.duration!==undefined)args.push('-t',String(duration))
  if(start&&(options.video==='copy'||options.audio==='copy'))warnings.push('复制轨道剪辑受关键帧与音频包边界限制')
  const activeFilters=(options.filters??[]).filter(f=>f.enabled)
  const vf=activeFilters.filter(f=>filterLibrary.find(d=>d.name===f.name)?.kind==='video'),af=activeFilters.filter(f=>filterLibrary.find(d=>d.name===f.name)?.kind==='audio')
  for(const filter of activeFilters)if(!engine.filters.includes(filter.name))throw new Error(`当前引擎缺少 ${filter.name} 滤镜`)
  if(options.container==='srt') {
    if(subtitles.length!==1)throw new Error('提取 SRT 时请选择恰好一条文本字幕轨道')
    if(!['subrip','ass','ssa','mov_text','webvtt','text'].includes(subtitles[0].codec))throw new Error('图像字幕无法直接导出为 SRT')
    if(!engine.encoders.includes('srt')&&!engine.encoders.includes('subrip'))throw new Error('当前引擎不支持 SRT 编码')
    if(activeFilters.length||options.subtitleFile||(options.encoderOptions??[]).length||Object.keys(options.codecParameters??{}).length||Object.keys(a).some(key=>['video','audio'].includes(parameters.find(p=>p.key===key)?.scope??'')||key==='burnSubtitle'))throw new Error('SRT 输出不能应用音视频滤镜或编码参数')
    args.push('-map',`0:${subtitles[0].index}`,'-c:s','srt','-vn','-an')
  } else {
    const isAudio=audioFormats.has(options.container),isImage=imageFormats.has(options.container)
    if(isAudio&&options.video!=='none')throw new Error('音频格式需要关闭视频轨道')
    if(isImage&&options.audio!=='none')throw new Error('图像格式需要关闭音频轨道')
    if(options.container==='mp3'&&!['libmp3lame','mp3','copy','none'].includes(options.audio))throw new Error('MP3 格式需要 MP3 编码')
    if(options.container==='wav'&&!/^(pcm_|none)/.test(options.audio))throw new Error('WAV 格式需要 PCM 编码')
    if(options.container==='flac'&&!['flac','copy','none'].includes(options.audio))throw new Error('FLAC 格式需要 FLAC 编码')
    if(['mp4','m4a'].includes(options.container)&&!['aac','libfdk_aac','libmp3lame','alac','ac3','eac3','libopus','copy','none'].includes(options.audio))throw new Error('此格式需要 AAC/MP3 等兼容音频或复制音轨')
    if(options.container==='webm'&&(!['libvpx','libvpx_vp9','libaom_av1','libsvtav1','av1_nvenc','av1_qsv','av1_amf','copy','none'].includes(options.video)||!['libopus','libvorbis','opus','vorbis','copy','none'].includes(options.audio)))throw new Error('WebM 需要 VP8/VP9/AV1 视频和 Opus/Vorbis 音频')
    if(options.container==='opus'&&!['libopus','opus','copy','none'].includes(options.audio))throw new Error('Opus 格式需要 Opus 编码')
    const mapped=[...(options.video!=='none'?video:[]),...(options.audio!=='none'?audio:[]),...(!isAudio&&!isImage&&options.subtitles==='copy'?subtitles:[])]
    if(!mapped.length)throw new Error('没有可输出的轨道，请检查轨道选择和编码设置')
    if(isAudio&&audio.length>1)throw new Error('音频文件仅支持一条音轨，请指定轨道')
    if(isImage&&video.length!==1)throw new Error('图像输出请选择一条视频轨道')
    for(const stream of mapped)args.push('-map',`0:${stream.index}`)
    args.push('-map_metadata',a.metadata==='remove'?'-1':'0','-map_chapters',a.chapters==='remove'?'-1':'0')
    if(a.attachments==='copy') {
      if(options.container!=='mkv')throw new Error('附件复制需要 MKV 格式')
      args.push('-map','0:t?','-c:t','copy')
    }
    for(const item of options.metadata??[])args.push('-metadata',`${item.key}=${item.value}`)
    const videoChanges=vf.length||options.subtitleFile||Object.keys(a).some(key=>['encoder','quality','color','image'].includes(parameters.find(p=>p.key===key)?.group??'')||key.startsWith('subtitle')||key==='burnSubtitle')
    const audioChanges=af.length||Object.keys(a).some(key=>parameters.find(p=>p.key===key)?.group==='audio'||key==='audioDelay')
    if(options.video==='copy'&&(videoChanges||(options.maxHeight&&video.some(s=>(s.height??0)>options.maxHeight!))||(options.encoderOptions??[]).some(p=>p.scope==='video')))throw new Error('复制视频不能应用画面、滤镜或编码参数，请选择视频编码器')
    if(options.audio==='copy'&&(audioChanges||(options.encoderOptions??[]).some(p=>p.scope==='audio')))throw new Error('复制音频不能应用滤镜或编码参数，请选择音频编码器')
    if(options.video==='none'||!video.length) {
      if(videoChanges||Object.keys(a).some(key=>parameters.find(p=>p.key===key)?.scope==='video'))throw new Error('没有视频输出，不能应用视频参数')
      args.push('-vn')
    } else {
      if(options.video!=='copy'&&(!engine.encoders.includes(options.video)||(engine.encoderKinds?.[options.video]&&engine.encoderKinds[options.video]!=='video')))throw new Error(`当前引擎不支持视频编码器 ${options.video}`)
      if(options.video==='copy'&&['mp4','mov'].includes(options.container)&&video.some(s=>!mp4Video.has(s.codec)))throw new Error('所选视频轨道不适合直接封装到此格式，请改用 MKV 或重新编码')
      args.push('-c:v',options.video)
      if(options.video!=='copy') {
        const rc=String(a.rateControl??'auto'),codec=options.video
        if((codec==='libx264'||codec==='libx265')&&options.quality>51)throw new Error('H.264 / H.265 质量值不能大于 51')
        if(rc==='bitrate'&&a.videoBitrate===undefined)throw new Error('码率控制需要填写视频码率')
        if(rc==='crf'||(rc==='auto'&&['libx264','libx265','libaom_av1','libsvtav1','libvpx','libvpx_vp9'].includes(codec)))args.push('-crf',String(options.quality))
        else if(rc==='cq'||(rc==='auto'&&codec.endsWith('nvenc')))args.push('-cq',String(options.quality))
        else if(rc==='qp'||(rc==='auto'&&codec.endsWith('amf'))) {
          if(codec.endsWith('amf'))args.push('-rc','cqp','-qp_i',String(options.quality),'-qp_p',String(options.quality))
          else args.push('-qp',String(options.quality))
        } else if(rc==='auto'&&codec.endsWith('qsv'))args.push('-global_quality',String(options.quality))
        if(codec.endsWith('nvenc')&&rc==='auto'&&a.videoBitrate===undefined)args.push('-b:v','0')
        if(['libvpx','libvpx_vp9','libaom_av1'].includes(codec)&&rc==='auto'&&a.videoBitrate===undefined)args.push('-b:v','0')
        if(codec==='libsvtav1')args.push('-preset',/^[0-9]+$/.test(options.speed)?options.speed:options.speed==='slow'?'4':options.speed==='fast'?'10':'8')
        else if(codec.startsWith('libx')||codec.endsWith('qsv'))args.push('-preset',options.speed)
        else if(codec.endsWith('nvenc'))args.push('-preset', ['fast','medium','slow'].includes(options.speed)?({fast:'p2',medium:'p4',slow:'p6'}[options.speed]!):options.speed)
        if(/_(nvenc|qsv|amf)$/.test(codec)||a.hwaccel)warnings.push('硬件选项需要对应设备与驱动，实际可用性以执行结果为准')
        if(codec==='libx265'&&['mp4','mov'].includes(options.container))args.push('-tag:v','hvc1')
        if(!isImage&&(a.pixelFormat||/264|265|hevc|av1|vpx/.test(codec)))args.push('-pix_fmt',String(a.pixelFormat??'yuv420p'))
        const videoFilters:string[]=[]
        if(['cuda','qsv','d3d11'].includes(String(a.hwFormat)))videoFilters.push('hwdownload','format=nv12')
        videoFilters.push(...vf.map(f=>filterText(f.name,f.options)))
        if(a.width||a.height) {
          if(options.maxHeight)throw new Error('指定宽高时，请将最高高度设为原始尺寸')
          const w=a.width??-2,h=a.height??-2
          videoFilters.push(`scale=w=${w}:h=${h}${a.width&&a.height&&a.aspectMode!=='stretch'?':force_original_aspect_ratio=decrease:force_divisible_by=2':''}${a.scaleAlgorithm?`:flags=${a.scaleAlgorithm}`:''}`)
        } else if(options.maxHeight)videoFilters.push(`scale=w=-2:h=trunc(min(ih\\,${options.maxHeight})/2)*2${a.scaleAlgorithm?`:flags=${a.scaleAlgorithm}`:''}`)
        else if(!isImage)videoFilters.push(`scale=trunc(iw/2)*2:trunc(ih/2)*2${a.scaleAlgorithm?`:flags=${a.scaleAlgorithm}`:''}`)
        if(a.colorMode==='convert') {
          const pairs=[['space',a.colorspace],['primaries',a.primaries],['trc',a.transfer],['range',a.colorRange]].filter(([,v])=>v!==undefined)
          if(!pairs.length)throw new Error('色彩转换需要至少选择一项目标色彩参数')
          videoFilters.push('colorspace='+pairs.map(([k,v])=>`${k}=${v}`).join(':'))
        }
        if(a.burnSubtitle!==undefined||options.subtitleFile) {
          if(a.burnSubtitle!==undefined&&options.subtitleFile)throw new Error('请选择外部字幕或内嵌字幕中的一种来源')
          if(!options.subtitleFile){const sub=media.streams.filter(s=>s.type==='subtitle')[Number(a.burnSubtitle)];if(!sub||!['subrip','ass','ssa','mov_text','webvtt','text'].includes(sub.codec))throw new Error('烧录字幕需要存在的文本字幕轨道（按字幕轨从 0 编号）')}
          const color=(value:unknown)=>typeof value==='string'?`&H00${value.slice(5,7)}${value.slice(3,5)}${value.slice(1,3)}`:undefined
          const style=[['FontName',a.subtitleFont],['FontSize',a.subtitleSize],['Outline',a.subtitleOutline],['MarginV',a.subtitleMargin],['MarginL',a.subtitleMarginL],['MarginR',a.subtitleMarginR],['Spacing',a.subtitleSpacing],['Shadow',a.subtitleShadow],['Alignment',a.subtitleAlignment],['Bold',a.subtitleBold===undefined?undefined:a.subtitleBold==='on'?-1:0],['Italic',a.subtitleItalic===undefined?undefined:a.subtitleItalic==='on'?-1:0],['BorderStyle',a.subtitleBorder===undefined?undefined:a.subtitleBorder==='box'?3:1],['PrimaryColour',color(a.subtitleColor)],['OutlineColour',color(a.subtitleOutlineColor)],['BackColour',color(a.subtitleBackColor)]].filter(([,v])=>v!==undefined).map(([k,v])=>`${k}=${v}`).join(',')
          videoFilters.push(`subtitles=filename=${escapeFilterValue((options.subtitleFile??media.path).replace(/\\/g,'/'))}${options.subtitleFile?'':`:si=${a.burnSubtitle}`}${style?`:force_style=${escapeFilterValue(style)}`:''}`)
        }
        for(const f of videoFilters)if(!engine.filters.includes(f.split(/[=:]/)[0]))throw new Error(`当前引擎缺少 ${f.split(/[=:]/)[0]} 滤镜`)
        if(videoFilters.length)args.push('-vf',videoFilters.join(','))
        for(const p of parameters.filter(p=>p.scope==='video'&&p.flag))if(a[p.key]!==undefined) {
          if(p.key==='pixelFormat'&&!isImage)continue
          if(p.key==='imageLoop'){args.push('-loop',a.imageLoop==='forever'?'0':options.container==='gif'?'-1':'1');continue}
          if(p.key==='imageQuality'&&options.container==='webp'){args.push('-quality',String(a.imageQuality));continue}
          if(p.key==='frameRate'&& !/^\d+(?:\.\d+|\/[1-9]\d*)?$/.test(String(a[p.key])))throw new Error('帧率需要正数或有效分数')
          const suffix=['videoBitrate','minrate','maxrate','bufsize'].includes(p.key)?'k':''
          args.push('-'+p.flag,String(a[p.key])+suffix)
        }
        if(isImage&&a.videoFrames===undefined&&['jpg','png','webp'].includes(options.container)&&codec!=='libwebp_anim')args.push('-frames:v','1')
      }
    }
    if(options.audio==='none'||!audio.length) {
      if(audioChanges)throw new Error('没有音频输出，不能应用音频参数')
      args.push('-an')
    } else {
      if(options.audio!=='copy'&&(!engine.encoders.includes(options.audio)||(engine.encoderKinds?.[options.audio]&&engine.encoderKinds[options.audio]!=='audio')))throw new Error(`当前引擎不支持音频编码器 ${options.audio}`)
      if(options.audio==='copy') {
        if(['mp4','m4a'].includes(options.container)&&audio.some(s=>!mp4Audio.has(s.codec)))throw new Error('所选音轨不能直接复制到此格式，请改用 AAC 或 MKV')
        if(['mp3','flac','opus'].includes(options.container)&&audio.some(s=>s.codec!==options.container))throw new Error('音轨编码与输出格式不兼容')
      }
      args.push('-c:a',options.audio)
      if(options.audio!=='copy') {
        if(a.audioQuality===undefined&&['aac','libfdk_aac','libmp3lame','libopus','opus','libvorbis','vorbis','ac3','eac3'].includes(options.audio))args.push('-b:a',`${options.audioBitrate}k`)
        for(const p of parameters.filter(p=>p.scope==='audio'&&p.flag))if(a[p.key]!==undefined)args.push('-'+p.flag,String(a[p.key]))
        const audioFilters=af.map(f=>filterText(f.name,f.options))
        if(a.audioDelay!==undefined&&Number(a.audioDelay)!==0) {
          if(Number(a.audioDelay)>0)audioFilters.push(`adelay=${Number(a.audioDelay)*1000}:all=1`)
          else audioFilters.push(`atrim=start=${-Number(a.audioDelay)}`,'asetpts=PTS-STARTPTS')
          if(!engine.filters.includes(Number(a.audioDelay)>0?'adelay':'atrim'))throw new Error('引擎不支持音频延迟滤镜')
        }
        if(audioFilters.length)args.push('-af',audioFilters.join(','))
      }
    }
    for(const setting of options.encoderOptions??[]) {
      if((setting.scope==='video'&&(options.video==='none'||!video.length))||(setting.scope==='audio'&&(options.audio==='none'||!audio.length)))throw new Error('专用参数没有对应的编码输出')
      args.push(`-${setting.name}:${setting.scope==='video'?'v':'a'}`,setting.value)
    }
    if(Object.keys(options.codecParameters??{}).length) {
      if(options.video==='none'||options.video==='copy'||!video.length)throw new Error('内部编码参数需要视频编码输出')
      args.push(options.video==='libx264'?'-x264-params':'-x265-params',Object.entries(options.codecParameters!).map(([key,value])=>`${key}=${value}`).join(':'))
    }
    if(options.subtitles==='copy'&&subtitles.length&&!isAudio&&!isImage) {
      if(options.container==='webm'&&subtitles.some(s=>s.codec!=='webvtt'))throw new Error('WebM 字幕需要 WebVTT')
      if(['mp4','mov'].includes(options.container)&&subtitles.some(s=>!['subrip','ass','ssa','mov_text','webvtt','text'].includes(s.codec)))throw new Error('该字幕轨不能封装到 MP4/MOV，请使用 MKV')
      args.push('-c:s',['mp4','mov'].includes(options.container)?'mov_text':'copy')
    } else args.push('-sn')
    if(['mp4','m4a','mov'].includes(options.container)&&a.faststart!=='off')args.push('-movflags','+faststart')
  }
  if(a.fileSize!==undefined)args.push('-fs',String(Number(a.fileSize)*1024*1024))
  const formats:Record<string,string>={mkv:'matroska',m4a:'ipod',ts:'mpegts',jpg:'image2',png:'image2',webp:'webp'}
  args.push('-progress','pipe:1','-f',formats[options.container]??options.container,outputPath)
  return {input:media,outputPath,options,args,engine:structuredClone(engine),warnings,durationMs:Math.max(0,(Number.isFinite(duration)?duration:media.durationMs/1000)*1000)}
}
