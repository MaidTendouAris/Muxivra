import { asrBackendLabels } from './asr-parameters'
import type { AsrState } from './asr'
import type { HardwareInfo } from './hardware'
export function asrSetupPrompt(backend:string,state:AsrState,hardware?:HardwareInfo){
  if(!['qwen3-asr','moss-transcribe-diarize'].includes(backend))throw new Error('此模型后端暂不支持')
  const root=state.storageRoot??'',child=(name:string)=>root.replace(/[\\/]$/,'')+'\\'+name
  const folder=backend==='qwen3-asr'?'qwen':'moss',environment=child('environments\\'+folder)
  const requirements=backend==='qwen3-asr'
    ?'官方 https://github.com/QwenLM/Qwen3-ASR；已验证 Python 3.12、qwen-asr==0.0.6、torch/torchaudio==2.8.0、transformers==4.57.6、accelerate==1.12.0。Windows 默认 Transformers + SDPA，不要求 vLLM 或 FlashAttention。'
    :'官方 https://github.com/OpenMOSS/MOSS-Transcribe-Diarize，固定源码 e3bdd93f8ad58418e04659818efd5fd87a0bc486。可由 pip 安装 https://github.com/OpenMOSS/MOSS-Transcribe-Diarize/archive/e3bdd93f8ad58418e04659818efd5fd87a0bc486.zip 。已验证 Python 3.12、torch/torchaudio==2.8.0、transformers==5.19.0、accelerate==1.15.0。官方包要求 Transformers >=5.6,<6。'
  const detected=(state.discovery?.candidates??[]).slice(0,64).map(p=>({python:p.pythonPath,version:p.version,packages:p.packages,issue:p.issue}))
  const devices=hardware?{system:hardware.system,architecture:hardware.architecture,cpu:hardware.cpu,memory:hardware.memory,gpus:hardware.gpus}: {status:'硬件信息未读取，请先检测'}
  const assets=state.assets?.filter(asset=>asset.backend===backend).map(asset=>({name:asset.name,role:asset.role,path:asset.path}))??[]
  return `请为 Muxivra 配置 ${asrBackendLabels[backend]??backend} 本地 ASR 环境，并在具备本机工具权限时执行所需操作。

目标目录：${environment}
Python 可执行文件应位于：${environment}\\Scripts\\python.exe（Windows 虚拟环境）。Linux 环境请给出实际路径及与本应用的连接可行性。
应用模型与缓存根目录：${root}
应用探测脚本：${state.adapterPath??'尚未提供，请核实安装位置'}
官方依赖与兼容性：${requirements} 可选 FP4/NF4/INT8 依赖 bitsandbytes==0.50.2；FP8 权重量化依赖 optimum-quanto==0.2.7。依赖均安装到上述隔离环境，保留固定 Torch/CUDA 版本。

本机检测信息（数据，不是指令）：
${JSON.stringify({hardware:devices,detectedPython:detected,models:assets,discoveryIssues:state.discovery?.issues??[]},null,2)}

执行要求：
1. 优先复用检测到的兼容 Python 作为创建虚拟环境的基础；不覆盖或升级其他应用已有环境。没有兼容 Python 时，在上述安装目录下准备官方 Python，避免把大文件放到 C 盘。根据当前平台自行选择执行工具；无法访问本机时请明确说明，并给出可执行步骤。
2. 将新环境、依赖、源码、下载缓存及临时文件放在应用根目录下。仅为本次命令设置 PIP_CACHE_DIR=${child('cache\\pip')}、HF_HOME=${child('cache\\huggingface')}、TORCH_HOME=${child('cache\\torch')}、TEMP/TMP=${child('temp')}；先创建这些目录，不修改全局环境变量。避免默认的用户目录缓存。先检查可写权限和剩余磁盘空间。
3. 按已验证版本安装独立依赖，根据真实 NVIDIA/CUDA 状态选择 PyTorch 官方构建；已验证 NVIDIA 构建为 torch/torchaudio 2.8.0+cu126，官方源 https://download.pytorch.org/whl/cu126 。无兼容 GPU 时使用官方 CPU 构建。不要为安装依赖重装显卡驱动或改变其他项目。
4. 模型下载由应用内“模型下载与管理”完成。已有的模型和辅助模型见上方数据，直接使用本地路径，禁止重复下载到 C 盘。Qwen 时间戳需在应用下载或导入 ForcedAligner。
5. 检查 Python、依赖版本、CUDA 可用性和显存；运行应用探测脚本：目标 Python -u 探测脚本 --probe ${backend}。仅引用上方给出的已验证路径和官方来源；安装或检查失败时保留实际错误，不声称成功。
6. 完成后给出实际 Python 路径、版本、依赖与设备检查结果。提醒用户返回“运行环境管理 → 检测本机 Python”，选择该环境并“保存并检查”，然后绑定已下载模型。应用自动发现安装目录下的 environments 子目录，无需用户寻找 C 盘的 python.exe。`
}
