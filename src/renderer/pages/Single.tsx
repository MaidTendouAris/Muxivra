import { tr } from '../lib/i18n'
import { useState, useEffect,useRef } from 'react'
import { Plus, Play, FolderOpen, ArrowRight, Download } from 'lucide-react'
import type { MediaInfo, Snapshot, TranscodeOptions, Plan } from '../../shared/types'
import { defaultOptions } from '../../core/presets'
import { Button, Card, Empty, Field, Input, DropZone, Modal,Select } from '../components/ui'
import { subtitleTransferOptions,changeSubtitleMode,type SubtitleMediaTransfer } from '../../shared/subtitle-media'
import { OptionsForm } from '../components/OptionsForm'
import { type RunAction } from '../components/Jobs'
import { MpvPlayer } from '../components/MpvPlayer'
import { formatBytes, formatDuration, joinPath, outputName } from '../lib/utils'

export function Single({ snapshot, run, busy,visible,onSubmitted,transfer }: { snapshot: Snapshot; run: RunAction; busy: boolean;visible:boolean;onSubmitted:()=>void;transfer?:SubtitleMediaTransfer }) {
  const [media,setMedia]=useState<MediaInfo>(),[playerPath,setPlayerPath]=useState(''),[loadId,setLoadId]=useState(0),[options,setOptions]=useState<TranscodeOptions>({...defaultOptions,maxHeight:1080,presetId:'h264-1080'})
  const [directory,setDirectory]=useState(snapshot.defaultOutputPath??''),[filename,setFilename]=useState(''),[plan,setPlan]=useState<Plan>(),[presetName,setPresetName]=useState<string>()
  const pendingMedia=useRef<string|undefined>(undefined)
  const selectedIndices=(options.streamIndices??media?.streams.map(stream=>stream.index)??[]).filter(index=>options.subtitles==='copy'||media?.streams.find(stream=>stream.index===index)?.type!=='subtitle')
  useEffect(()=>{if(!transfer)return;pendingMedia.current=transfer.media.path;setMedia(transfer.media);setPlayerPath(transfer.media.path);setLoadId(value=>value+1);setOptions(subtitleTransferOptions(transfer.subtitlePath));setDirectory(transfer.outputDirectory);setFilename(outputName(transfer.media.path,'mkv'));setPlan(undefined)},[transfer?.id])
  useEffect(()=>{if(media)setFilename(outputName(media.path,options.container))},[media?.path,options.container])
  useEffect(()=>{if(media&&snapshot.engine)void window.muxivra.inspect(media.path).then(info=>setMedia(info)).catch(()=>{})},[snapshot.engine?.id])
  function updateMedia(info:MediaInfo){
    if(pendingMedia.current&&info.path!==pendingMedia.current)return
    if(info.path===pendingMedia.current)pendingMedia.current=undefined
    if(info.path!==media?.path||!media.streams.length){setOptions(current=>({...current,streamIndices:undefined,...(info.streams.length&&!info.streams.some(stream=>stream.type==='video')&&current.presetId==='h264-1080'?{container:'m4a',video:'none',maxHeight:undefined,presetId:'aac'}:{})}))}
    setMedia(info)
  }
  async function load(path:string){setPlan(undefined);const info=await window.muxivra.inspectPlayback(path);pendingMedia.current=info.path;if(media?.path!==info.path)setOptions(current=>({...current,subtitleFile:undefined,subtitleMode:undefined}));updateMedia(info);pendingMedia.current=info.path;setPlayerPath(path);setLoadId(value=>value+1)}
  const request=()=>{if(!media||!directory)throw new Error(tr("请导入媒体并选择输出目录"));return {inputPath:media.path,outputPath:joinPath(directory,filename),options}}
  const select=()=>run(async()=>{const files=await window.muxivra.selectFiles('media');if(files[0])await load(files[0])})
  return <div className="single-layout"><div className="single-main">
    <Card title={tr("媒体")} aside={<Button size="sm" variant="secondary" disabled={busy} onClick={()=> select()}><Plus size={15}/>{media?tr("更换文件"):tr("导入文件")}</Button>}>
      <DropZone onFiles={files=>void run(async()=>{const paths=await window.muxivra.acceptDrop(files);if(paths.length!==1)throw new Error(tr("请选择一个文件，多个文件请使用批量处理"));await load(paths[0])})}>
        {media?<><MpvPlayer owner="single" path={playerPath} loadId={loadId} active={visible} run={run} onMediaChange={updateMedia}/><div className="media-caption"><strong title={media.path}>{media.name}</strong></div></>:<Empty title={tr("未选择媒体")} description="" action={<Button disabled={busy} onClick={()=> select()}><Plus size={16}/>{tr("选择媒体文件")}</Button>}/>}
      </DropZone>
    </Card>
    {media&&<><div className="media-metrics">{[[tr("时长"),formatDuration(media.durationMs)],[tr("尺寸"),media.streams.find(stream=>stream.type==='video')?`${media.streams.find(stream=>stream.type==='video')!.width??'—'} × ${media.streams.find(stream=>stream.type==='video')!.height??'—'}`:tr("音频")],[tr("大小"),formatBytes(media.size)],[tr("轨道"),`${media.streams.length}`]].map(([label,value])=><span key={tr(label)}><small>{tr(label)}</small><strong>{value}</strong></span>)}</div>
      <Card title={tr("输出轨道")}><div className="track-list">{media.streams.map(stream=><label key={stream.index} className="track"><input type="checkbox" checked={selectedIndices.includes(stream.index)} onChange={event=>{const indices=event.target.checked?[...new Set([...selectedIndices,stream.index])]:selectedIndices.filter(index=>index!==stream.index);setOptions({...options,subtitles:stream.type==='subtitle'?(media.streams.some(item=>item.type==='subtitle'&&indices.includes(item.index))?'copy':'none'):options.subtitles,streamIndices:indices})}}/><span className="track-kind">{stream.type==='video'?tr("视频"):stream.type==='audio'?tr("音频"):stream.type==='subtitle'?tr("字幕"):stream.type}</span><strong>{stream.codec.toUpperCase()}</strong><span>{stream.language&&stream.language!=='und'?stream.language:''} {stream.title}</span><code>#{stream.index}</code></label>)}</div></Card>
    </>}
    {media&&<Card title={tr("字幕")} className="single-subtitle-card" aside={<Button variant="secondary" size="sm" disabled={busy} onClick={()=>run(async()=>{const files=await window.muxivra.selectFiles('subtitle-burn');if(files[0])setOptions(current=>changeSubtitleMode({...current,subtitleFile:files[0]},current.subtitleMode??'embed'))})}>{tr("选择字幕文件")}</Button>}>
      {options.subtitleFile?<><p className="path-text" title={options.subtitleFile}>{options.subtitleFile}</p><div className="form-grid"><Field label={tr("字幕处理方式")}><Select value={options.subtitleMode??'burn'} onChange={e=>setOptions(current=>changeSubtitleMode(current,e.target.value as 'burn'|'embed'))}><option value="embed">{tr("封装为字幕轨道")}</option><option value="burn">{tr("烧录到视频画面")}</option></Select></Field><Field label={tr("源文件字幕轨道")}><Select notifyOnReselect value={options.subtitles} onChange={e=>setOptions(current=>({...current,subtitles:e.target.value as 'copy'|'none',streamIndices:e.target.value==='copy'&&current.streamIndices?[...new Set([...current.streamIndices,...media.streams.filter(stream=>stream.type==='subtitle').map(stream=>stream.index)])]:current.streamIndices}))}><option value="none">{tr("不保留")}</option><option value="copy">{tr("保留")}</option></Select></Field></div><div className="toolbar"><span className="hint">{options.subtitleMode==='embed'?tr("MKV 保留 ASS 样式；MP4/MOV 转为文本字幕。"):tr("字幕写入画面，需要重新编码视频。")}</span><Button variant="ghost" size="sm" onClick={()=>setOptions(current=>({...current,subtitleFile:undefined,subtitleMode:undefined}))}>{tr("移除字幕")}</Button></div></>:<p className="hint">{tr("选择字幕文件，或从字幕编辑页转入。")}</p>}
    </Card>}
  </div><aside className="single-settings"><Card title={tr("输出配置")}><OptionsForm value={options} onChange={next=>setOptions(next.presetId&&options.subtitleFile?changeSubtitleMode({...next,subtitleFile:options.subtitleFile},options.subtitleMode??'burn'):next)} presets={snapshot.presets} engine={snapshot.engine}/><div className="divider"/>
    <Field label={tr("输出目录")}><div className="input-action"><Input value={directory} readOnly placeholder={tr("请选择目录")}/><Button variant="secondary" size="icon" aria-label={tr("选择输出目录")} onClick={()=> run(async()=>{const path=await window.muxivra.selectDirectory('output');if(path)setDirectory(path)})}><FolderOpen size={17}/></Button></div></Field>
    <Field label={tr("输出文件名")}><Input value={filename} onChange={event=>setFilename(event.target.value)}/></Field>
    <Button className="full-width" disabled={busy||!media||!snapshot.engine} onClick={()=> run(async()=>setPlan(await window.muxivra.plan(request())))}><ArrowRight size={17}/>{tr("检查处理计划")}</Button>
    <Button variant="secondary" className="full-width" disabled={!media||busy} onClick={()=>setPresetName('')}><Download size={16}/>{tr("保存为预设")}</Button>
  </Card></aside>
    {presetName!==undefined&&<Modal title={tr("保存预设")} onClose={()=>setPresetName(undefined)}><Field label={tr("预设名称")}><Input autoFocus maxLength={80} value={presetName} onChange={e=>setPresetName(e.target.value)}/></Field><Button className="full-width" disabled={busy||!presetName.trim()} onClick={()=> run(async()=>{await window.muxivra.savePreset({id:`custom-${crypto.randomUUID()}`,name:presetName.trim(),description:'',options:{...options,presetId:undefined,streamIndices:undefined}});setPresetName(undefined);return true},tr("预设已保存"))}>{tr("保存预设")}</Button></Modal>}
    {plan&&<Modal title={tr("处理计划")} onClose={()=>setPlan(undefined)}><p>{plan.input.name} → {plan.options.container.toUpperCase()}</p><p className="path-text">{plan.outputPath}</p><ul className="plan-summary"><li>{tr("视频：")}{plan.options.video} {tr("· 音频：")}{plan.options.audio}</li><li>FFmpeg：{plan.engine.version}</li>{plan.warnings.map(warning=><li key={warning}>{warning}</li>)}</ul><details><summary>{tr("执行参数")}</summary><pre className="code-box">{plan.args.map(arg=>JSON.stringify(arg)).join(' ')}</pre></details><Button className="full-width" disabled={busy} onClick={()=> run(async()=>{await window.muxivra.submit([{inputPath:plan.input.path,outputPath:plan.outputPath,options:plan.options}],crypto.randomUUID());setPlan(undefined);onSubmitted()},tr("任务已加入队列"))}><Play size={16}/>{tr("开始处理")}</Button></Modal>}
  </div>
}
