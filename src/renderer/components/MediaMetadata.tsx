import { useEffect,useState } from 'react'
import { tr } from '../lib/i18n'
import type { MediaMetadata as Metadata } from '../../shared/media-metadata'
import { Busy,Button,Input } from './ui'
const labels:Record<string,string>={General:'常规',Video:'视频',Audio:'音频',Text:'字幕',Image:'图像',Menu:'章节',Other:'其他'}
const fieldLabels:Record<string,string>={CompleteName:'文件',Format:'格式',Format_Profile:'Profile',CodecID:'编码标识',FileSize_String:'大小',Duration_String:'时长',OverallBitRate_String:'总码率',BitRate_String:'码率',Width_String:'宽度',Height_String:'高度',FrameRate_String:'帧率',DisplayAspectRatio_String:'显示比例',BitDepth_String:'位深',ColorSpace:'色彩空间',ChromaSubsampling:'色度采样',ScanType:'扫描方式',SamplingRate_String:'采样率',Channels_String:'声道',ChannelLayout:'声道布局',Language_String:'语言',Title:'标题',Album:'专辑',Performer:'艺术家',Genre:'风格',Comment:'备注',Encoded_Date:'编码时间',Encoded_Library:'编码库',extra:'附加标签'}
export function MediaMetadata({path,active}:{path:string;active:boolean}){
  const [value,setValue]=useState<Metadata>(),[error,setError]=useState(''),[track,setTrack]=useState(0),[search,setSearch]=useState(''),[retry,setRetry]=useState(0),[full,setFull]=useState(false)
  useEffect(()=>{if(!active)return;let live=true;setError('');setValue(undefined);setTrack(0);void window.muxivra.mediaMetadata(path).then(v=>{if(live)setValue(v)}).catch(e=>{if(live)setError(e.message)});return()=>{live=false}},[path,active,retry])
  if(error)return <div><p className="error-inline">{error}</p><Button variant="secondary" onClick={()=>setRetry(v=>v+1)}>{tr("重试")}</Button></div>
  if(!value)return <Busy text={tr("正在读取完整媒体信息…")}/>
  const entries=Object.entries(value.tracks[track]?.fields??{}),order=Object.keys(fieldLabels)
  const shown=entries.filter(([k,v])=>(full||search||fieldLabels[k])&&`${tr(fieldLabels[k]??k)} ${k} ${JSON.stringify(v)}`.toLowerCase().includes(search.toLowerCase())).sort(([a],[b])=>(order.indexOf(a)<0?999:order.indexOf(a))-(order.indexOf(b)<0?999:order.indexOf(b)))
  return <div className="metadata-reader"><div className="toolbar metadata-tabs">{value.tracks.map((t,i)=><Button variant={i===track?'secondary':'ghost'} size="sm" key={i} onClick={()=>setTrack(i)}>{tr(labels[t.type]??t.type)}{i>0?` ${i}`:''}</Button>)}</div><div className="toolbar"><Input aria-label={tr("搜索媒体信息")} placeholder={tr("搜索字段或数值")} value={search} onChange={e=>setSearch(e.target.value)}/><span className="hint">{value.library.name} {value.library.version}</span></div><label className="metadata-full"><input type="checkbox" checked={full} onChange={e=>setFull(e.target.checked)}/>{tr("显示全部原始字段")}</label><dl className="metadata-facts">{shown.map(([k,v])=><div key={k}><dt title={k}>{tr(fieldLabels[k]??k)}</dt><dd>{typeof v==='object'?JSON.stringify(v):String(v)}</dd></div>)}</dl></div>
}
