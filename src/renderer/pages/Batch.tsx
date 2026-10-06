import { useState } from 'react'
import { Plus, Play, FolderOpen, Settings2, X, CheckCircle2 } from 'lucide-react'
import type { Snapshot, MediaInfo, TranscodeOptions, JobRequest, Plan } from '../../shared/types'
import { defaultOptions } from '../../core/presets'
import { Button, Card, Field, Input, Empty, DropZone, Modal } from '../components/ui'
import { OptionsForm } from '../components/OptionsForm'
import { type RunAction } from '../components/Jobs'
import { formatBytes, formatDuration, joinPath, outputName, nameOf } from '../lib/utils'
interface Item { id: string; path: string; media?: MediaInfo; error?: string; override?: TranscodeOptions }
export function Batch({ snapshot, run, busy, onSubmitted }: { snapshot: Snapshot; run: RunAction; busy: boolean;onSubmitted:()=>void }) {
  const [items,setItems] = useState<Item[]>([]), [options,setOptions] = useState<TranscodeOptions>({ ...defaultOptions, presetId: 'h264-1080', maxHeight: 1080 })
  const [directory,setDirectory] = useState(snapshot.defaultOutputPath??''), [editing,setEditing] = useState<string>(), [plans,setPlans] = useState<Plan[]>(), [reviewedRequests,setReviewedRequests] = useState<JobRequest[]>([])
  async function add(paths: string[]) {
    if (items.length+paths.length > 500) throw new Error('一个批次最多 500 个文件')
    const next: Item[] = []
    for (const path of paths) {
      if (items.some(item => item.path === path) || next.some(item => item.path === path)) continue
      try { next.push({ id: crypto.randomUUID(), path, media: await window.muxivra.inspect(path) }) }
      catch (e) { next.push({ id: crypto.randomUUID(), path, error: (e as Error).message }) }
    }
    setItems(previous => [...previous,...next]); setPlans(undefined)
  }
  const importFiles = () => run(async () => add(await window.muxivra.selectFiles('media',true)))
  async function review() {
    if (!directory || !items.length) throw new Error('请导入文件并选择输出目录')
    if (items.some(item => item.error)) throw new Error('请先移除无法分析的文件')
    const requests = items.map(item => { const setting = item.override ?? options; return { inputPath: item.path, outputPath: joinPath(directory,outputName(item.path,setting.container)), options: setting } })
    const checked = await window.muxivra.planBatch(requests)
    setReviewedRequests(checked.map(plan => ({ inputPath: plan.input.path, outputPath: plan.outputPath, options: plan.options }))); setPlans(checked)
  }
  const selected = items.find(item => item.id === editing)
  return <div className="batch-layout">
    <Card title="批次文件" aside={<div className="toolbar"><Button variant="ghost" size="sm" onClick={() => { setItems([]); setPlans(undefined) }}>清空</Button><Button variant="secondary" size="sm" disabled={busy} onClick={() => importFiles()}><Plus size={15}/>添加文件</Button></div>}>
      <DropZone onFiles={files => void run(async () => add(await window.muxivra.acceptDrop(files)))}>{!items.length ? <Empty title="未添加文件" action={<Button disabled={busy} onClick={() => importFiles()}><Plus size={16}/>添加媒体文件</Button>}/> : <div className="table-scroll"><table className="file-table"><thead><tr><th>文件</th><th>时长 / 大小</th><th>输出</th><th>参数</th><th/></tr></thead><tbody>{items.map(item => <tr key={item.id}><td><strong title={item.path}>{nameOf(item.path)}</strong><small>{item.error ?? item.media?.streams.map(s => s.codec).join(' · ')}</small></td><td>{item.media ? <>{formatDuration(item.media.durationMs)}<small>{formatBytes(item.media.size)}</small></> : <span className="error-text">无法分析</span>}</td><td><span>{(item.override ?? options).container.toUpperCase()}</span><small>{(item.override ?? options).video}</small></td><td><Button variant="ghost" size="sm" onClick={() => setEditing(item.id)}><Settings2 size={14}/>{item.override ? '单项参数' : '共享参数'}</Button></td><td><Button variant="ghost" size="icon" aria-label={`移除 ${nameOf(item.path)}`} onClick={() => { setItems(items.filter(i => i.id !== item.id)); setPlans(undefined) }}><X size={15}/></Button></td></tr>)}</tbody></table></div>}</DropZone>
    </Card>
    <div className="batch-bottom"><Card title="共享输出设置"><div className="batch-options"><OptionsForm value={options} onChange={value => { setOptions(value); setPlans(undefined) }} presets={snapshot.presets} engine={snapshot.engine} compact/><div className="batch-destination"><Field label="统一输出目录"><div className="input-action"><Input value={directory} readOnly placeholder="选择输出目录"/><Button variant="secondary" size="icon" aria-label="选择批量输出目录" onClick={() => run(async () => { const path = await window.muxivra.selectDirectory('output'); if (path) { setDirectory(path); setPlans(undefined) } })}><FolderOpen size={17}/></Button></div></Field><Button className="full-width" disabled={busy || !items.length || !snapshot.engine} onClick={() => run(review)}><Play size={16}/>检查 {items.length} 个文件</Button></div></div></Card>
    </div>
    {selected && <Modal title={`单项参数 · ${nameOf(selected.path)}`} onClose={() => setEditing(undefined)}><OptionsForm value={selected.override ?? options} onChange={value => { setItems(previous => previous.map(item => item.id === selected.id ? { ...item, override: value } : item)); setPlans(undefined) }} presets={snapshot.presets} engine={snapshot.engine}/>{selected.media && <div className="track-list">{selected.media.streams.map(stream => { const value = selected.override ?? options; return <label className="track" key={stream.index}><input type="checkbox" checked={!value.streamIndices || value.streamIndices.includes(stream.index)} onChange={e => { const current = value.streamIndices ?? selected.media!.streams.map(s => s.index); setItems(items.map(item => item.id === selected.id ? { ...item, override: { ...value, streamIndices: e.target.checked ? [...current,stream.index] : current.filter(i => i !== stream.index) } } : item)) }}/>{stream.type} · {stream.codec} · #{stream.index}</label> })}</div>}<Button variant="secondary" className="full-width" onClick={() => { setItems(items.map(item => item.id === selected.id ? { ...item, override: undefined } : item)); setPlans(undefined); setEditing(undefined) }}>恢复共享参数</Button><Button className="full-width" onClick={() => setEditing(undefined)}>完成</Button></Modal>}
    {plans && <Modal title={`批次检查通过 · ${plans.length} 个文件`} onClose={() => setPlans(undefined)}><div className="plan-list">{plans.map(plan => <div key={plan.outputPath}><CheckCircle2 size={16}/><div><strong>{plan.input.name}</strong><p className="path-text">{plan.outputPath}</p>{plan.warnings.map(warning => <small key={warning}>{warning}</small>)}</div></div>)}</div><Button className="full-width" disabled={busy} onClick={() => run(async () => { await window.muxivra.submit(reviewedRequests,crypto.randomUUID()); setPlans(undefined); setItems([]); onSubmitted() },'批次已加入队列')}><Play size={16}/>提交整个批次</Button></Modal>}
  </div>
}
