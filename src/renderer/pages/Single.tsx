import { useState, useEffect } from 'react'
import { Plus, Play, FolderOpen, ArrowRight, Download } from 'lucide-react'
import type { MediaInfo, Snapshot, TranscodeOptions, Plan } from '../../shared/types'
import { defaultOptions } from '../../core/presets'
import { Button, Card, Empty, Field, Input, DropZone, Modal } from '../components/ui'
import { OptionsForm } from '../components/OptionsForm'
import { type RunAction } from '../components/Jobs'
import { MpvPlayer } from '../components/MpvPlayer'
import { formatBytes, formatDuration, joinPath, outputName } from '../lib/utils'

export function Single({ snapshot, run, busy,visible,onSubmitted }: { snapshot: Snapshot; run: RunAction; busy: boolean;visible:boolean;onSubmitted:()=>void }) {
  const [media,setMedia]=useState<MediaInfo>(),[playerPath,setPlayerPath]=useState(''),[loadId,setLoadId]=useState(0),[options,setOptions]=useState<TranscodeOptions>({...defaultOptions,maxHeight:1080,presetId:'h264-1080'})
  const [directory,setDirectory]=useState(snapshot.defaultOutputPath??''),[filename,setFilename]=useState(''),[plan,setPlan]=useState<Plan>(),[presetName,setPresetName]=useState<string>()
  useEffect(()=>{if(media)setFilename(outputName(media.path,options.container))},[media?.path,options.container])
  useEffect(()=>{if(media&&snapshot.engine)void window.muxivra.inspect(media.path).then(info=>setMedia(info)).catch(()=>{})},[snapshot.engine?.id])
  function updateMedia(info:MediaInfo){
    if(info.path!==media?.path||!media.streams.length){setOptions(current=>({...current,streamIndices:undefined,...(info.streams.length&&!info.streams.some(stream=>stream.type==='video')&&current.presetId==='h264-1080'?{container:'m4a',video:'none',maxHeight:undefined,presetId:'aac'}:{})}))}
    setMedia(info)
  }
  async function load(path:string){setPlan(undefined);updateMedia(await window.muxivra.inspectPlayback(path));setPlayerPath(path);setLoadId(value=>value+1)}
  const request=()=>{if(!media||!directory)throw new Error('请导入媒体并选择输出目录');return {inputPath:media.path,outputPath:joinPath(directory,filename),options}}
  const select=()=>run(async()=>{const files=await window.muxivra.selectFiles('media');if(files[0])await load(files[0])})
  return <div className="single-layout"><div className="single-main">
    <Card title="媒体" aside={<Button size="sm" variant="secondary" disabled={busy} onClick={()=> select()}><Plus size={15}/>{media?'更换文件':'导入文件'}</Button>}>
      <DropZone onFiles={files=>void run(async()=>{const paths=await window.muxivra.acceptDrop(files);if(paths.length!==1)throw new Error('请选择一个文件，多个文件请使用批量处理');await load(paths[0])})}>
        {media?<><MpvPlayer owner="single" path={playerPath} loadId={loadId} active={visible} run={run} onMediaChange={updateMedia}/><div className="media-caption"><strong title={media.path}>{media.name}</strong></div></>:<Empty title="未选择媒体" description="" action={<Button disabled={busy} onClick={()=> select()}><Plus size={16}/>选择媒体文件</Button>}/>}
      </DropZone>
    </Card>
    {media&&<><div className="media-metrics">{[['时长',formatDuration(media.durationMs)],['尺寸',media.streams.find(stream=>stream.type==='video')?`${media.streams.find(stream=>stream.type==='video')!.width??'—'} × ${media.streams.find(stream=>stream.type==='video')!.height??'—'}`:'音频'],['大小',formatBytes(media.size)],['轨道',`${media.streams.length}`]].map(([label,value])=><span key={label}><small>{label}</small><strong>{value}</strong></span>)}</div>
      <Card title="输出轨道"><div className="track-list">{media.streams.map(stream=><label key={stream.index} className="track"><input type="checkbox" checked={!options.streamIndices||options.streamIndices.includes(stream.index)} onChange={event=>{const current=options.streamIndices??media.streams.map(stream=>stream.index);setOptions({...options,streamIndices:event.target.checked?[...current,stream.index]:current.filter(index=>index!==stream.index)})}}/><span className="track-kind">{stream.type==='video'?'视频':stream.type==='audio'?'音频':stream.type==='subtitle'?'字幕':stream.type}</span><strong>{stream.codec.toUpperCase()}</strong><span>{stream.language&&stream.language!=='und'?stream.language:''} {stream.title}</span><code>#{stream.index}</code></label>)}</div></Card>
    </>}
  </div><aside className="single-settings"><Card title="输出配置"><OptionsForm value={options} onChange={setOptions} presets={snapshot.presets} engine={snapshot.engine}/><div className="divider"/>
    <Field label="输出目录"><div className="input-action"><Input value={directory} readOnly placeholder="请选择目录"/><Button variant="secondary" size="icon" aria-label="选择输出目录" onClick={()=> run(async()=>{const path=await window.muxivra.selectDirectory('output');if(path)setDirectory(path)})}><FolderOpen size={17}/></Button></div></Field>
    <Field label="输出文件名"><Input value={filename} onChange={event=>setFilename(event.target.value)}/></Field>
    <Button className="full-width" disabled={busy||!media||!snapshot.engine} onClick={()=> run(async()=>setPlan(await window.muxivra.plan(request())))}><ArrowRight size={17}/>检查处理计划</Button>
    <Button variant="secondary" className="full-width" disabled={!media||busy} onClick={()=>setPresetName('')}><Download size={16}/>保存为预设</Button>
  </Card></aside>
    {presetName!==undefined&&<Modal title="保存预设" onClose={()=>setPresetName(undefined)}><Field label="预设名称"><Input autoFocus maxLength={80} value={presetName} onChange={e=>setPresetName(e.target.value)}/></Field><Button className="full-width" disabled={busy||!presetName.trim()} onClick={()=> run(async()=>{await window.muxivra.savePreset({id:`custom-${crypto.randomUUID()}`,name:presetName.trim(),description:'',options:{...options,presetId:undefined,streamIndices:undefined}});setPresetName(undefined);return true},'预设已保存')}>保存预设</Button></Modal>}
    {plan&&<Modal title="处理计划" onClose={()=>setPlan(undefined)}><p>{plan.input.name} → {plan.options.container.toUpperCase()}</p><p className="path-text">{plan.outputPath}</p><ul className="plan-summary"><li>视频：{plan.options.video} · 音频：{plan.options.audio}</li><li>FFmpeg：{plan.engine.version}</li>{plan.warnings.map(warning=><li key={warning}>{warning}</li>)}</ul><details><summary>执行参数</summary><pre className="code-box">{plan.args.map(arg=>JSON.stringify(arg)).join(' ')}</pre></details><Button className="full-width" disabled={busy} onClick={()=> run(async()=>{await window.muxivra.submit([{inputPath:plan.input.path,outputPath:plan.outputPath,options:plan.options}],crypto.randomUUID());setPlan(undefined);onSubmitted()},'任务已加入队列')}><Play size={16}/>开始处理</Button></Modal>}
  </div>
}
