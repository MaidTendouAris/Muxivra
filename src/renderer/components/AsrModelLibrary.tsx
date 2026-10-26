import { useState } from 'react'
import { ArrowRight, Download, FolderOpen, Plus, Settings2, Trash2, WandSparkles } from 'lucide-react'
import { officialAsrCatalog, type ManagedAsrAsset } from '../../shared/asr-catalog'
import type { AsrState, AsrModel } from '../../shared/asr'
import type { Job } from '../../shared/types'
import { asrBackendLabels, pythonAsrBackends } from '../../shared/asr-parameters'
import type { RunAction } from './Jobs'
import { Button, Card, Field, Input, Select, Modal } from './ui'
import { AsrTransfer } from './AsrTransfer'
import { formatBytes } from '../lib/utils'
import { tr } from '../lib/i18n'

type ImportBackend = 'whisper.cpp' | 'qwen3-asr' | 'moss-transcribe-diarize' | 'custom'
export function AsrModelLibrary({ state, jobs = [], run, busy, onEnvironment, onRecognition }: { state?: AsrState; jobs?: Job[]; run: RunAction; busy: boolean; onEnvironment: (assetId?: string) => void; onRecognition: (id: string) => void }) {
  const [binding, setBinding] = useState<ManagedAsrAsset>()
  const [environmentId, setEnvironmentId] = useState('')
  const [runtimeId, setRuntimeId] = useState('')
  const [importing, setImporting] = useState(false)
  const [backend, setBackend] = useState<ImportBackend>('whisper.cpp')
  const [name, setName] = useState('Whisper large-v3')
  const [removing, setRemoving] = useState<AsrModel>()
  const transferring = !!state?.download.active || !!state?.deployment?.active
  const activeModels = new Set(jobs.flatMap(job => ['queued', 'running', 'paused'].includes(job.status) && job.plan.kind === 'asr' ? [job.plan.asr.model.id] : []))
  const assets = state?.assets ?? []
  const catalog = [{ id: 'whisper-large-v3', name: 'Whisper large-v3', backend: 'whisper.cpp', role: 'model', repo: 'ggerganov/whisper.cpp', bytes: 3095033483 }, ...officialAsrCatalog]
  const bind = (asset: ManagedAsrAsset) => {
    setBinding(asset)
    setEnvironmentId(state?.environments?.find(value => value.backend === asset.backend && value.probe?.ready)?.id ?? '')
    setRuntimeId((state?.runtimes.find(value => value.id.endsWith('-cuda')) ?? state?.runtimes[0])?.id ?? '')
  }
  const importModel = () => run(async () => {
    if (backend === 'custom') {
      const model = await window.muxivra.asrImport({ backend, name })
      if (model) setImporting(false)
      return model
    }
    const asset = await window.muxivra.asrImportModelAsset({ backend, name })
    if (asset) setImporting(false)
    return asset
  }, tr('模型文件已导入'))
  return <div className="resource-asr-grid">
    <Card className="resource-pane" title={tr('已配置模型')} aside={<span className="hint">{state?.models.length ?? 0}</span>}>
      <div className="resource-scroll">
        <p className="hint resource-intro">{tr('在此保存模型的识别参数。可用模型会直接出现在 ASR 工作台，工作台只需选择项目与识别区间。')}</p>
        <div className="resource-model-list">{state?.models.map(model => <article className="inner-card resource-model-card" key={model.id}>
          <div className="card-heading"><strong>{model.name}</strong><span className={`status ${model.availability === 'missing' ? 'status-failed' : 'status-completed'}`}>{model.availability === 'missing' ? tr('不可用') : tr('可用')}</span></div>
          <span className="hint">{tr(asrBackendLabels[model.backend])} · {model.environment?.name ?? (model.backend === 'whisper.cpp' ? 'whisper.cpp' : tr('自定义程序'))}</span>
          <p className="path-text" title={model.modelPath}>{model.modelPath}</p>
          <div className="resource-recognition-summary"><span>{tr('语言')} <strong>{model.recognition?.language ?? 'auto'}</strong></span><span>{tr('计算设备')} <strong>{model.recognition?.device ?? 'auto'}</strong></span><span>{tr('精度')} <strong>{String(model.recognition?.parameters?.dtype ?? (model.backend === 'whisper.cpp' ? 'GGML' : 'auto'))}</strong></span></div>
          {model.issue && <p className="error-inline">{tr(model.issue)}</p>}
          <div className="toolbar wrap"><Button size="sm" variant="secondary" disabled={busy || activeModels.has(model.id)} onClick={() => onRecognition(model.id)}><Settings2 size={15}/>{tr('配置识别参数')}</Button><Button size="sm" variant="ghost" onClick={() => onEnvironment(assets.find(asset => asset.path === model.modelPath)?.id)}>{tr('运行环境')}<ArrowRight size={14}/></Button><Button size="icon" variant="ghost" aria-label={tr('移除模型记录')} title={tr('移除模型记录')} disabled={busy || transferring || activeModels.has(model.id)} onClick={() => setRemoving(model)}><Trash2 size={15}/></Button></div>
        </article>)}</div>
        {!state?.models.length && <div className="resource-empty"><Settings2 size={28}/><strong>{tr('尚无可直接使用的模型')}</strong><p>{tr('先下载或导入模型文件，再到环境页为目标模型配置运行环境。')}</p></div>}
      </div>
    </Card>
    <Card className="resource-pane" title={tr('模型文件')} aside={<Button size="sm" variant="secondary" disabled={busy || transferring} onClick={() => setImporting(true)}><FolderOpen size={15}/>{tr('导入模型')}</Button>}>
      <div className="resource-scroll">
        <p className="hint resource-intro">{tr('下载与导入只准备文件。模型文件、辅助模型及缓存均位于安装目录；配置环境时使用这些已有文件。')}</p>
        <AsrTransfer state={state} run={run}/>
        <div className="resource-subheading"><strong>{tr('官方模型')}</strong><span className="hint">Hugging Face / ModelScope</span></div>
        <div className="resource-catalog-grid">{catalog.map(asset => {
          const installed = assets.find(value => value.id === asset.id)
          return <article className="inner-card resource-catalog-card" key={asset.id}>
            <div className="card-heading"><strong>{asset.name}</strong><span className="tag">{asset.role === 'model' ? tr('模型') : tr('词级对齐')}</span></div>
            <span className="hint">{asset.repo} · {formatBytes(asset.bytes)}</span>
            {installed ? <><p className="path-text" title={installed.path}>{installed.path}</p><span className="status status-completed">{tr('文件已就绪')}</span></> : <Button size="sm" variant="secondary" disabled={busy || transferring} onClick={() => run(() => asset.id === 'whisper-large-v3' ? window.muxivra.asrDownload('model') : window.muxivra.asrDownloadModel(asset.id))}><Download size={15}/>{tr('下载模型文件')}</Button>}
            {asset.role === 'aligner' && <Button size="sm" variant="ghost" disabled={busy || transferring} onClick={() => run(() => window.muxivra.asrImportComponent('aligner'), tr('对齐模型已导入'))}><FolderOpen size={15}/>{tr('导入对齐模型')}</Button>}
          </article>
        })}</div>
        <div className="resource-subheading"><strong>{tr('已下载与导入的文件')}</strong><span className="hint">{assets.length}</span></div>
        <div className="resource-staged-list">{assets.map(asset => <article className="inner-card resource-staged-card" key={asset.id}>
          <div className="card-heading"><strong>{asset.name}</strong><span className="hint">{formatBytes(asset.bytes)}</span></div>
          <p className="path-text">{asset.path}</p>
          {asset.role === 'model' ? <div className="toolbar wrap"><Button size="sm" variant="secondary" disabled={busy || transferring} onClick={() => onEnvironment(asset.id)}><WandSparkles size={15}/>{tr('配置此模型环境')}</Button><Button size="sm" variant="ghost" disabled={busy || transferring} onClick={() => bind(asset)}><Plus size={15}/>{tr('使用已有环境')}</Button></div> : <span className="hint">{tr('配置 Qwen 环境时可选用此对齐模型。')}</span>}
        </article>)}</div>
        {!assets.length && <p className="hint">{tr('暂无已下载或导入的模型文件。')}</p>}
      </div>
    </Card>
    {importing && <Modal title={tr('导入 ASR 模型文件')} locked={busy} onClose={() => setImporting(false)}>
      <Field label={tr('后端类型')}><Select value={backend} onChange={event => { const next = event.target.value as ImportBackend; setBackend(next); setName(asrBackendLabels[next]) }}><option value="whisper.cpp">{tr('whisper.cpp · GGML 模型')}</option>{pythonAsrBackends.map(value => <option key={value} value={value}>{asrBackendLabels[value]} · Python</option>)}<option value="custom">{tr('自定义后端 · JSON 配置')}</option></Select></Field>
      {backend !== 'custom' && <Field label={tr('模型名称')}><Input value={name} onChange={event => setName(event.target.value)}/></Field>}
      <p className="hint">{backend === 'custom' ? tr('选择 muxivra-asr-backend v1 配置，使用配置指定的本地后端。') : backend === 'whisper.cpp' ? tr('选择 whisper.cpp 格式的 .bin 模型文件，运行包可稍后在环境页准备。') : tr('选择包含 config.json 和完整权重的本地模型目录，无需预先配置 Python。')}</p>
      <p className="hint">{tr('导入文件复制至安装目录，原文件保留。')}</p><AsrTransfer state={state} run={run}/>
      <div className="toolbar"><Button variant="secondary" disabled={busy} onClick={() => setImporting(false)}>{tr('取消')}</Button><Button disabled={busy || transferring || backend !== 'custom' && !name.trim()} loadingText={tr('正在导入…')} onClick={importModel}><FolderOpen size={16}/>{tr('选择文件并导入')}</Button></div>
    </Modal>}
    {binding && <Modal title={tr('使用已有环境')} onClose={() => setBinding(undefined)}><strong>{binding.name}</strong>{binding.backend === 'whisper.cpp' ? <Field label={tr('模型运行包')}><Select value={runtimeId} onChange={event => setRuntimeId(event.target.value)}><option value="">{tr('请先准备运行包')}</option>{state?.runtimes.map(runtime => <option key={runtime.id} value={runtime.id}>{runtime.name}</option>)}</Select></Field> : <Field label={tr('模型运行环境')}><Select value={environmentId} onChange={event => setEnvironmentId(event.target.value)}><option value="">{tr('请选择已验证可用的环境')}</option>{state?.environments?.filter(environment => environment.backend === binding.backend && environment.probe?.ready).map(environment => <option key={environment.id} value={environment.id}>{environment.name}</option>)}</Select></Field>}<div className="toolbar"><Button variant="secondary" onClick={() => { setBinding(undefined); onEnvironment(binding.id) }}>{tr('前往配置环境')}</Button><Button disabled={busy || (binding.backend === 'whisper.cpp' ? !runtimeId : !environmentId)} onClick={() => run(async () => { await window.muxivra.asrBindAsset(binding.id, environmentId || undefined, runtimeId || undefined); setBinding(undefined) }, tr('模型已配置，可在 ASR 工作台使用'))}>{tr('启用模型')}</Button></div></Modal>}
    {removing && <Modal title={tr('移除模型记录')} onClose={() => setRemoving(undefined)}><p>{tr('移除此模型的配置记录？模型文件和运行程序会保留。')}</p><div className="toolbar"><Button variant="secondary" onClick={() => setRemoving(undefined)}>{tr('取消')}</Button><Button disabled={busy || transferring || activeModels.has(removing.id)} onClick={() => run(async () => { await window.muxivra.asrRemoveModel(removing.id); setRemoving(undefined) })}>{tr('移除记录')}</Button></div></Modal>}
  </div>
}
