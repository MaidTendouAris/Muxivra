import { useEffect, useState } from 'react'
import { ArrowRight, Copy, Cpu, Download, FolderOpen, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { AsrState } from '../../shared/asr'
import type { HardwareInfo } from '../../shared/hardware'
import type { AsrEnvironment, AsrEnvironmentRequest, PythonCandidate } from '../../shared/asr-environments'
import { pythonAsrBackends, asrBackendLabels } from '../../shared/asr-parameters'
import { officialAsrCatalog } from '../../shared/asr-catalog'
import { nvidiaProfile, type AsrResourceRequest } from '../../shared/asr-deployment'
import { asrSetupPrompt } from '../../shared/asr-setup-prompt'
import { Button, Card, Field, Input, Select, Busy, Modal } from './ui'
import { AsrTransfer } from './AsrTransfer'
import type { RunAction } from './Jobs'
import { formatBytes } from '../lib/utils'
import { tr } from '../lib/i18n'

type ResourceKind = 'python' | 'dependencies' | 'whisper-runtime'
const officialTargets = [{ id: 'whisper-large-v3', name: 'Whisper large-v3', backend: 'whisper.cpp' }, ...officialAsrCatalog.filter(asset => asset.role === 'model')] as const
export function AsrEnvironments({ state, hardware, run, busy, onModels, targetAssetId }: { state?: AsrState; hardware?: HardwareInfo; run: RunAction; busy: boolean; onModels?: () => void; targetAssetId?: string }) {
  const [draft, setDraft] = useState<AsrEnvironmentRequest>()
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState<AsrEnvironment>()
  const [refreshing, setRefreshing] = useState('')
  const [target, setTarget] = useState(targetAssetId ?? state?.assets?.find(asset => asset.role === 'model')?.id ?? 'qwen-0.6b')
  const [gpuIndex, setGpuIndex] = useState(state?.nvidia?.devices[0]?.index ?? 0)
  const [detecting, setDetecting] = useState(false)
  const [promptBackend, setPromptBackend] = useState<AsrEnvironmentRequest['backend']>('qwen3-asr')
  const assets = state?.assets ?? []
  const targets = [...officialTargets, ...assets.filter(asset => asset.role === 'model' && !officialTargets.some(value => value.id === asset.id))]
  const selected = targets.find(asset => asset.id === target)
  const dependencyTarget = officialTargets.find(asset => asset.id === target)?.id ?? officialTargets.find(asset => asset.backend === selected?.backend)?.id
  const transferring = !!state?.download.active || !!state?.deployment?.active
  const gpu = state?.nvidia?.devices.find(device => device.index === gpuIndex)
  let gpuIssue = state?.nvidia?.issue
  if (gpu) try { nvidiaProfile(gpu) } catch (error) { gpuIssue = (error as Error).message }
  const detect = () => run(async () => { setDetecting(true); try { const value = await window.muxivra.asrDetectNvidia(); setGpuIndex(value.devices.slice().sort((a, b) => b.freeBytes - a.freeBytes)[0]?.index ?? 0) } finally { setDetecting(false) } })
  useEffect(() => { if (!state?.discovery?.checkedAt && !state?.discovery?.active) void window.muxivra.asrDiscoverPython().catch(error => run(async () => { throw error })); if (!state?.nvidia) void detect() }, [])
  useEffect(() => { if (targetAssetId) setTarget(targetAssetId) }, [targetAssetId])
  const request = (kind: ResourceKind): AsrResourceRequest => ({ kind, assetId: dependencyTarget, gpuIndex: Math.max(0, gpuIndex) })
  const patch = (value: Partial<AsrEnvironmentRequest>) => setDraft(current => current ? { ...current, ...value } : current)
  const candidates = state?.discovery?.candidates ?? []
  const copyPrompt = (backend = promptBackend) => run(() => window.muxivra.copyText(asrSetupPrompt(backend, state!, hardware)), tr('环境配置提示词已复制'))
  const addCandidate = (candidate?: PythonCandidate) => { const backend = pythonAsrBackends.find(value => candidate?.backends.includes(value)) ?? promptBackend; setDraft({ name: asrBackendLabels[backend] + tr(' 环境'), backend, pythonPath: candidate?.pythonPath ?? '' }); setPromptBackend(backend) }
  const pathField = (key: 'pythonPath' | 'sourcePath' | 'alignerPath', label: string) => <Field label={label}><div className="path-picker"><Input value={draft?.[key] ?? ''} onChange={event => patch({ [key]: event.target.value })}/><Button size="icon" aria-label={tr('选择 {0}', label)} variant="secondary" disabled={busy || transferring} onClick={() => run(async () => { if (key === 'alignerPath') { const value = await window.muxivra.asrImportComponent('aligner'); if (value) patch({ [key]: value.path }) } else { const value = await window.muxivra.asrSelectPath(key === 'pythonPath' ? 'python' : 'folder'); if (value) patch({ [key]: value }) } })}><FolderOpen size={16}/></Button></div></Field>
  return <div className="resource-environments-grid">
    <Card className="resource-pane" title={tr('已安装运行环境')} aside={<Button size="sm" variant="secondary" disabled={busy} onClick={() => addCandidate()}><Plus size={15}/>{tr('添加已有环境')}</Button>}>
      <div className="resource-scroll">
        <p className="hint resource-intro">{tr('每个模型环境独立管理。Python、PyTorch、CUDA 运行库和 Transformers 的实际版本显示于下方，不修改系统环境。')}</p>
        <div className="asr-environment-list">{state?.environments?.map(environment => {
          const probe = environment.probe
          const refs = state.models.filter(model => model.environmentId === environment.id)
          return <article className="inner-card resource-environment-card" key={environment.id}>
            <div className="card-heading"><div><strong>{environment.name}</strong><small className="hint">{asrBackendLabels[environment.backend]} · {environment.managed ? tr('应用管理') : tr('外部环境')}</small></div><span className={`status ${probe?.ready ? 'status-completed' : 'status-failed'}`}>{probe?.ready ? tr('可用') : tr('待配置')}</span></div>
            <div className="resource-version-grid"><div><span>Python</span><strong>{probe?.python ?? tr('未检查')}</strong></div><div><span>PyTorch</span><strong>{probe?.versions.torch ?? tr('未检测到')}</strong></div><div><span>CUDA</span><strong>{probe?.versions.cuda ?? probe?.versions['cuda-runtime'] ?? (probe?.cudaAvailable ? tr('可用 · 版本未读取') : tr('不可用'))}</strong></div><div><span>Transformers</span><strong>{probe?.versions.transformers ?? tr('未检测到')}</strong></div></div>
            <p className="path-text" title={environment.pythonPath}>{environment.pythonPath}</p>
            <div className="resource-environment-refs"><span className="hint">{tr('使用此环境的模型')}</span>{refs.length ? refs.map(model => <span className="tag" key={model.id}>{model.name}</span>) : <span className="hint">{tr('暂无绑定模型')}</span>}</div>
            {probe?.devices.map((device, index) => <small className="hint" key={index}>GPU {index} · {device.name} · {formatBytes(device.totalBytes)}</small>)}
            {probe?.issues.map((issue, index) => <p className="error-inline" key={index}>{issue}</p>)}
            <div className="toolbar wrap"><Button size="sm" variant="secondary" disabled={busy || transferring} loading={refreshing === environment.id} loadingText={tr('检查中…')} onClick={() => run(async () => { setRefreshing(environment.id); try { await window.muxivra.asrRefreshEnvironment(environment.id) } finally { setRefreshing('') } })}><RefreshCw size={14}/>{tr('检查环境')}</Button><Button size="sm" variant="ghost" disabled={busy || transferring} onClick={() => { const { probe, createdAt, managed, ...value } = environment; setDraft(value) }}><Pencil size={14}/>{tr('编辑环境')}</Button><Button size="icon" variant="ghost" aria-label={tr('移除环境 {0}', environment.name)} disabled={busy || transferring || !!refs.length} onClick={() => setRemoving(environment)}><Trash2 size={15}/></Button></div>
            <details className="resource-details"><summary>{tr('完整依赖与检查记录')}</summary>{probe ? <><div className="resource-dependency-list">{Object.entries(probe.versions).map(([name, version]) => <div key={name}><span>{name}</span><strong>{version}</strong></div>)}</div>{probe.warnings.map((warning, index) => <p className="hint" key={index}>{warning}</p>)}<small className="hint">{new Date(probe.checkedAt).toLocaleString()}</small></> : <p className="hint">{tr('尚未检查此环境')}</p>}</details>
          </article>
        })}</div>
        {!!state?.runtimes.length && <><div className="resource-subheading"><strong>{tr('Whisper 原生运行包')}</strong><span className="hint">{state.runtimes.length}</span></div>{state.runtimes.map(runtime => <article className="inner-card resource-environment-card" key={runtime.id}><div className="card-heading"><strong>{runtime.name}</strong><span className="tag">whisper.cpp</span></div><p className="path-text">{runtime.executable}</p><div className="resource-environment-refs">{state.models.filter(model => model.executable === runtime.executable).map(model => <span className="tag" key={model.id}>{model.name}</span>)}</div></article>)}</>}
        {!state?.environments?.length && !state?.runtimes.length && <div className="resource-empty"><Cpu size={28}/><strong>{tr('尚无已配置的环境')}</strong><p>{tr('从右侧准备所需文件，再为目标模型配置环境；已有 Python 也可添加并检查。')}</p></div>}
        <details className="resource-details resource-local-python"><summary>{tr('本机 Python 与手动兼容配置')}</summary><div className="toolbar wrap"><Button size="sm" variant="secondary" loading={!!state?.discovery?.active} loadingText={tr('检测中…')} disabled={transferring} onClick={() => run(() => window.muxivra.asrDiscoverPython())}><RefreshCw size={15}/>{tr('重新检测 Python')}</Button><Select aria-label={tr('准备配置的模型后端')} value={promptBackend} onChange={event => setPromptBackend(event.target.value as typeof promptBackend)}>{pythonAsrBackends.map(backend => <option key={backend} value={backend}>{asrBackendLabels[backend]}</option>)}</Select><Button size="sm" variant="ghost" disabled={!state?.storageRoot} onClick={() => copyPrompt()}><Copy size={15}/>{tr('复制环境配置提示词')}</Button></div><p className="hint">{tr('兼容选项可使用系统注册、PATH、Conda 或自有 Python。应用不会自动修改这些环境。')}</p>{state?.discovery?.active && <Busy text={tr('正在检测 Python 与已安装依赖…已发现 {0} 个环境', candidates.length)}/>}<div className="resource-python-candidates">{candidates.map(candidate => <article className="inner-card" key={candidate.pythonPath}><div className="card-heading"><strong>{candidate.name}</strong><Button size="sm" variant="secondary" disabled={busy || !!candidate.issue} onClick={() => addCandidate(candidate)}>{tr('添加此环境')}</Button></div><p className="path-text">{candidate.pythonPath}</p><span className="hint">{candidate.backends.map(backend => asrBackendLabels[backend]).join(' / ') || tr('基础 Python')}</span>{candidate.issue && <p className="error-inline">{candidate.issue}</p>}</article>)}</div>{state?.discovery?.issues.map((issue, index) => <p className="hint" key={index}>{issue}</p>)}</details>
      </div>
    </Card>
    <Card className="resource-pane resource-environment-setup" title={tr('运行资源文件')} aside={<div className="toolbar"><Button size="sm" variant="secondary" loading={detecting} loadingText={tr('检测中…')} disabled={transferring} onClick={detect}><RefreshCw size={15}/>{tr('检测 GPU')}</Button></div>}>
      <div className="resource-scroll">
        <Field label={tr('目标模型')}><Select value={target} disabled={transferring} onChange={event => setTarget(event.target.value)}>{targets.map(asset => <option key={asset.id} value={asset.id}>{asset.name}{assets.some(value => value.id === asset.id) ? tr(' · 文件已就绪') : tr(' · 未下载模型')}</option>)}</Select></Field>
        <Field label={tr('部署使用的 NVIDIA GPU')}><Select value={gpuIndex} disabled={transferring} onChange={event => setGpuIndex(Number(event.target.value))}><option value={-1}>{tr('请选择可用 NVIDIA GPU')}</option>{state?.nvidia?.devices.map(device => <option key={device.uuid} value={device.index}>{device.name} · {formatBytes(device.totalBytes)}</option>)}</Select></Field>
        {gpu && <small className="hint">{tr('驱动 {0} · 计算能力 {1}.{2} · 可用显存 {3}', gpu.driver, gpu.computeMajor, gpu.computeMinor, formatBytes(gpu.freeBytes))}</small>}{gpuIssue && <p className="error-inline">{gpuIssue}</p>}
        <AsrTransfer state={state} run={run}/>
        <div className="resource-subheading"><strong>{tr('下载或导入所需文件')}</strong></div><p className="hint">{tr('文件准备完成后再配置环境。离线依赖按目标模型和 GPU 匹配；Python 与依赖不安装到系统目录。')}</p>
        <p className="hint">{tr('先准备 Python，再下载目标模型的依赖。导入 Python 或依赖时，选择包含 muxivra-resource.json 的完整应用资源包目录；Whisper 导入解压后的运行包目录。')}</p><div className="resource-download-files">{(selected?.backend === 'whisper.cpp' ? [{ kind: 'whisper-runtime' as const, title: tr('Whisper CUDA 运行包'), detail: tr('原生程序与 CUDA 运行依赖，无需 Python。') }] : [{ kind: 'python' as const, title: tr('Python 基础运行时'), detail: tr('独立的 CPython 与 uv 工具，供应用管理的环境使用。') }, { kind: 'dependencies' as const, title: tr('PyTorch / CUDA / Transformers'), detail: tr('包含目标模型所需的完整离线依赖包。') }]).map(file => <article className="inner-card" key={file.kind}><strong>{file.title}</strong><p className="hint">{file.detail}</p><div className="toolbar"><Button size="sm" variant="secondary" disabled={busy || transferring || file.kind !== 'python' && (!gpu || !!gpuIssue)} onClick={() => run(() => window.muxivra.asrDownloadResource(request(file.kind)))}><Download size={14}/>{tr('下载文件')}</Button><Button size="sm" variant="ghost" disabled={busy || transferring || file.kind !== 'python' && (!gpu || !!gpuIssue)} onClick={() => run(() => window.muxivra.asrImportResource(request(file.kind)))}><FolderOpen size={14}/>{tr('导入文件')}</Button></div></article>)}</div>
        <div className="resource-subheading"><strong>{tr('已准备的资源')}</strong><span className="hint">{state?.resources?.length ?? 0}</span></div><div className="resource-file-inventory">{state?.resources?.map(resource => <article className="inner-card" key={resource.id}><div className="card-heading"><strong>{resource.name}</strong><span className={`status ${resource.ready ? 'status-completed' : 'status-failed'}`}>{resource.ready ? tr('已就绪') : tr('不可用')}</span></div><span className="hint">{resource.backend ? asrBackendLabels[resource.backend] : 'Python'}{resource.profile ? ' · ' + resource.profile : ''} · {formatBytes(resource.bytes)}</span><p className="path-text">{resource.path}</p>{Object.keys(resource.versions).length > 0 && <div className="resource-file-versions">{Object.entries(resource.versions).filter(([key]) => ['python', 'torch', 'cuda', 'transformers', 'uv', 'whisper.cpp'].includes(key)).map(([key, version]) => <span key={key}>{key} {version}</span>)}</div>}{resource.issue && <p className="error-inline">{resource.issue}</p>}</article>)}</div>{!state?.resources?.length && <p className="hint">{tr('尚无已下载或导入的基础运行资源。')}</p>}
        <p className="path-text">{tr('存储位置：')}{state?.storageRoot}</p>
      </div>
    </Card>
    {draft && <Modal title={draft.id ? tr('编辑运行环境') : tr('添加已有环境')} wide locked={saving} onClose={() => setDraft(undefined)}>
      <p className="hint">{tr('此兼容选项注册已有 Python 并检查依赖。应用管理的独立环境请使用一键部署页。')}</p><div className="form-grid"><Field label={tr('环境名称')}><Input value={draft.name} onChange={event => patch({ name: event.target.value })}/></Field><Field label={tr('环境对应后端')}><Select value={draft.backend} onChange={event => patch({ backend: event.target.value as AsrEnvironmentRequest['backend'] })}>{pythonAsrBackends.map(backend => <option key={backend} value={backend}>{asrBackendLabels[backend]}</option>)}</Select></Field></div><Field label={tr('检测到的 Python')}><Select value={candidates.some(candidate => candidate.pythonPath === draft.pythonPath) ? draft.pythonPath : ''} onChange={event => patch({ pythonPath: event.target.value })}><option value="">{tr('选择检测结果或手动指定')}</option>{candidates.map(candidate => <option key={candidate.pythonPath} value={candidate.pythonPath} disabled={!!candidate.issue}>{candidate.name} · {candidate.pythonPath}</option>)}</Select></Field>{pathField('pythonPath', tr('Python 可执行文件'))}{pathField('sourcePath', tr('官方源码目录（可选）'))}
      {draft.backend === 'qwen3-asr' && <><Field label={tr('已下载对齐模型')}><Select value={assets.some(asset => asset.path === draft.alignerPath) ? draft.alignerPath ?? '' : ''} onChange={event => patch({ alignerPath: event.target.value })}><option value="">{tr('不选择 / 导入本地辅助模型')}</option>{assets.filter(asset => asset.role === 'aligner').map(asset => <option key={asset.id} value={asset.path}>{asset.name}</option>)}</Select></Field>{pathField('alignerPath', tr('Qwen3-ForcedAligner 目录（可选）'))}</>}
      <div className="toolbar wrap"><Button variant="ghost" onClick={() => copyPrompt(draft.backend)}><Copy size={15}/>{tr('复制环境配置提示词')}</Button><Button variant="secondary" disabled={saving} onClick={() => setDraft(undefined)}>{tr('取消')}</Button><Button disabled={busy || !draft.name.trim() || !draft.pythonPath} loading={saving} loadingText={tr('保存检查中…')} onClick={() => run(async () => { setSaving(true); try { await window.muxivra.asrSaveEnvironment(draft); setDraft(undefined) } finally { setSaving(false) } })}>{tr('保存并检查')}</Button></div>
    </Modal>}
    {removing && <Modal title={tr('移除环境记录')} onClose={() => setRemoving(undefined)}><p>{tr('移除此环境的配置记录？Python、依赖和模型文件均保留。')}</p><div className="toolbar"><Button variant="secondary" onClick={() => setRemoving(undefined)}>{tr('取消')}</Button><Button disabled={busy} onClick={() => run(async () => { await window.muxivra.asrRemoveEnvironment(removing.id); setRemoving(undefined) })}>{tr('移除记录')}</Button></div></Modal>}
  </div>
}
