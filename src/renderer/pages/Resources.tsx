import { AsrDeploymentPage } from '../components/AsrDeploymentPage'
import { ResourceNetwork } from '../components/ResourceNetwork'
import { useEffect, useState } from 'react'
import { ArrowRight, Boxes, Cpu, Download, FolderOpen, HardDrive, Home, RotateCcw, Search } from 'lucide-react'
import type { Snapshot } from '../../shared/types'
import { asrRecognitionSchema } from '../../shared/asr'
import { asrBackendLabels } from '../../shared/asr-parameters'
import { AsrEnvironments } from '../components/AsrEnvironments'
import { AsrModelLibrary } from '../components/AsrModelLibrary'
import { AsrRecognitionSettings } from '../components/AsrRecognitionSettings'
import { HeaderDock } from '../components/HeaderDock'
import { Button, Card, Progress } from '../components/ui'
import type { RunAction } from '../components/Jobs'
import { tr } from '../lib/i18n'
import './resources.css'

type ResourceTab = 'home' | 'asr' | 'environments' | 'deploy' | 'network'
export function Resources({ snapshot, run, busy, visible = true, navigation }: { snapshot: Snapshot; run: RunAction; busy: boolean; visible?: boolean; navigation?: { id: number; tab: ResourceTab; modelId?: string } }) {
  const [tab, setTab] = useState<ResourceTab>('home')
  const [configuring, setConfiguring] = useState<string>()
  const [targetAsset, setTargetAsset] = useState<string>()
  useEffect(() => { if (navigation) { setTab(navigation.tab); setConfiguring(navigation.modelId) } }, [navigation?.id])
  const state = snapshot.asr
  const models = state?.models ?? []
  const readyModels = models.filter(model => model.availability !== 'missing')
  const environments = state?.environments ?? []
  const runtimes = state?.runtimes ?? []
  const model = models.find(value => value.id === configuring)
  const changeTab = (next: string) => { setTab(next as ResourceTab); setConfiguring(undefined) }
  const openEnvironment = (assetId?: string) => { setTargetAsset(assetId); changeTab('environments') }
  return <div className="resources-page" data-resource-tab={tab}>
    <HeaderDock active={visible} className="resource-dock" ariaLabel={tr('资源分类')} value={tab} onChange={changeTab} items={[
      { id: 'home', label: tr('主页'), icon: Home },
      { id: 'asr', label: 'ASR', icon: Boxes },
      { id: 'environments', label: tr('环境'), icon: Cpu },
      {id:'deploy',label:tr('一键部署'),icon:Download},
      {id:'network',label:tr('网络检测'),icon:Search}
    ]}/>
    {model ? <AsrRecognitionSettings key={model.id} model={model} config={asrRecognitionSchema.parse(model.recognition ?? {})} resourceMode backLabel={tr('返回模型管理')} run={run} busy={busy} onBack={() => setConfiguring(undefined)} onModels={() => openEnvironment(state?.assets?.find(asset => asset.path === model.modelPath)?.id)} onApply={() => setConfiguring(undefined)}/>
      : tab === 'deploy' ? <AsrDeploymentPage state={state} run={run} busy={busy}/>
      : tab === 'network' ? <ResourceNetwork run={run} busy={busy}/>
      : tab === 'asr' ? <AsrModelLibrary state={state} jobs={snapshot.jobs} run={run} busy={busy} onEnvironment={openEnvironment} onRecognition={setConfiguring}/>
      : tab === 'environments' ? <AsrEnvironments state={state} hardware={snapshot.hardware} run={run} busy={busy} targetAssetId={targetAsset} onModels={() => changeTab('asr')}/>
      : <div className="resource-home-grid">
        <Card className="resource-pane resource-engine-pane" title={tr('转码引擎 · FFmpeg')} aside={<span className={snapshot.engine ? 'status status-completed' : 'status status-failed'}>{snapshot.engine ? tr('已就绪') : tr('未配置')}</span>}>
          <div className="resource-scroll">
            <div className="resource-engine-current inner-card">
              <div className="resource-section-icon"><HardDrive size={24}/></div>
              <div><span className="hint">{tr('当前使用的引擎')}</span><strong>{snapshot.engine?.version ?? tr('尚未添加 FFmpeg')}</strong><p className="path-text">{snapshot.engine?.ffmpegPath ?? tr('下载引擎或导入已有的 FFmpeg 与 ffprobe。')}</p></div>
            </div>
            <div className="toolbar wrap resource-engine-actions">
              <Button disabled={busy || ['downloading', 'verifying', 'extracting'].includes(snapshot.download.state)} onClick={() => run(() => window.muxivra.downloadEngine(), tr('引擎已启用'))}><Download size={16}/>{tr('下载引擎')}</Button>
              <Button variant="secondary" disabled={busy} onClick={() => run(async () => { const path = await window.muxivra.selectDirectory('engine'); if (path) await window.muxivra.useEngine(path) }, tr('引擎已启用'))}><FolderOpen size={16}/>{tr('导入本地引擎')}</Button>
              <Button variant="ghost" disabled={busy} onClick={() => run(async () => { if (!await window.muxivra.detectEngine()) throw new Error(tr('PATH 中未找到 FFmpeg 与 ffprobe')) }, tr('引擎已启用'))}><Search size={16}/>{tr('检测 PATH')}</Button>
            </div>
            <p className="hint">{tr('下载的 FFmpeg 保存在应用安装目录，已有的系统引擎仍可手动选用。')}</p>
            {snapshot.download.state !== 'idle' && <div className="download-state inner-card"><Progress value={snapshot.download.percent}/><p className={snapshot.download.state === 'failed' ? 'error-text' : 'hint'}>{tr(snapshot.download.message)}</p></div>}
            <div className="resource-subheading"><strong>{tr('已添加的引擎')}</strong><span className="hint">{snapshot.engines.length}</span></div>
            <div className="resource-engine-list">{snapshot.engines.map(engine => <article className="inner-card" key={engine.id}><div><strong>{engine.version}</strong><p className="path-text">{engine.ffmpegPath}</p></div><Button variant="secondary" size="sm" disabled={busy || engine.id === snapshot.engine?.id} onClick={() => run(() => window.muxivra.useEngine(engine.id), tr('引擎已切换'))}>{engine.id === snapshot.engine?.id ? tr('当前') : <><RotateCcw size={14}/>{tr('切换')}</>}</Button></article>)}</div>
            {!snapshot.engines.length && <div className="resource-empty"><HardDrive size={28}/><p>{tr('尚无已添加的引擎')}</p></div>}
          </div>
        </Card>
        <Card className="resource-pane resource-overview-pane" title={tr('资源概览')}>
          <div className="resource-scroll">
            <div className="resource-overview-stats"><div className="inner-card"><Boxes size={20}/><strong>{readyModels.length}<small> / {models.length}</small></strong><span>{tr('就绪模型')}</span></div><div className="inner-card"><Cpu size={20}/><strong>{environments.length + runtimes.length}</strong><span>{tr('运行环境')}</span></div><div className="inner-card"><Download size={20}/><strong>{state?.assets?.length ?? 0}</strong><span>{tr('模型文件')}</span></div></div>
            <div className="resource-shortcut inner-card"><Boxes size={24}/><div><strong>{tr('ASR 模型')}</strong><p className="hint">{tr('下载或导入模型，绑定运行环境并保存识别参数，之后直接在 ASR 工作台使用。')}</p></div><Button size="icon" variant="secondary" aria-label={tr('管理 ASR 模型')} onClick={() => changeTab('asr')}><ArrowRight size={18}/></Button></div>
            <div className="resource-shortcut inner-card"><Cpu size={24}/><div><strong>{tr('Python 与推理依赖')}</strong><p className="hint">{tr('查看已安装的 Python、PyTorch、CUDA 与 Transformers，按目标模型配置隔离环境。')}</p></div><Button size="icon" variant="secondary" aria-label={tr('管理运行环境')} onClick={() => openEnvironment()}><ArrowRight size={18}/></Button></div>
            <div className="resource-storage inner-card"><span className="hint">{tr('ASR 存储位置')}</span><p className="path-text">{state?.storageRoot ?? '—'}</p><p className="hint">{tr('模型、Python、环境、离线依赖、缓存与临时文件均存放在安装目录。下载文件与配置环境分别管理，不修改系统 Python。')}</p></div>
            {models.length > 0 && <><div className="resource-subheading"><strong>{tr('可用模型')}</strong><Button size="sm" variant="ghost" onClick={() => changeTab('asr')}>{tr('查看全部')}<ArrowRight size={14}/></Button></div>{models.slice(0, 4).map(value => <div className="resource-model-summary" key={value.id}><div><strong>{value.name}</strong><span className="hint">{tr(asrBackendLabels[value.backend])}</span></div><span className={`status ${value.availability === 'missing' ? 'status-failed' : 'status-completed'}`}>{value.availability === 'missing' ? tr('不可用') : tr('可用')}</span></div>)}</>}
          </div>
        </Card>
      </div>}
  </div>
}
