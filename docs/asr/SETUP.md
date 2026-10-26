# 模型与运行资源准备

资源管理的标题 Dock 分为**主页 / ASR / 环境**。ASR 页负责下载、导入模型与辅助文件，保存模型的识别参数。环境页显示所有已注册环境的实际 Python / PyTorch / CUDA / Transformers 版本及其引用模型，分别准备运行资源，再为目标模型一键配置隔离环境。ASR 工作台只选择可用模型、当前项目音轨和识别区间。

配置步骤：先在 ASR 页准备目标模型；然后在环境页下载或导入基础 Python、目标模型的离线依赖，或 Whisper 原生运行包；最后选择 GPU，点击“一键配置环境”。配置只使用已准备文件，缺少资源会停止，不在这一阶段联网下载。Qwen 如需词级时间，请另行准备 ForcedAligner 并保留启用对齐选项；不需要时可取消勾选。MiMo 支持暂时移除。

Python 与依赖导入使用包含 `muxivra-resource.json` 的完整资源目录，可由另一台设备准备后复制，验证清单、大小和 SHA-256。不能把任意 Python 目录或零散 wheel 当作已验证的完整资源包；已有 Python 可通过兼容入口注册。Whisper 导入解压后的运行包目录。完整操作见[资源管理](../RESOURCES.md)。

## 硬件范围

当前自动部署面向 Windows x64、仍获完整驱动更新的 NVIDIA GPU：Turing 或更新架构，计算能力至少 7.5。Maxwell、Pascal、Volta 的 GeForce 已转入安全更新，使用手动兼容入口。软件读取 nvidia-smi 的 GPU UUID、计算能力、驱动、总显存与可用显存，绑定所选 GPU；读不到时显示原因，不猜测显卡型号或自动使用 CPU。

Turing/Ampere/Ada/Hopper 使用 PyTorch 2.8.0 + CUDA 12.6；Blackwell 使用 CUDA 12.8 构建。驱动最低检查分别为 560.76、572.61。部署不安装驱动、系统 CUDA Toolkit、WSL 或全局 Python，不修改系统 PATH。显卡仍受支持并不意味着显存足以处理任意模型和音频；显存不足会保留实际错误，可调整识别参数或显式启用兼容分片。

PyTorch 环境验证包含依赖探测和真实 CUDA FP16 矩阵运算。Whisper 使用固定的官方 whisper.cpp b5454 CUDA 12.4 Windows 包，载入 large-v3 并执行短音频 GPU 校验；未实际启用 GPU 时部署失败，不悄悄回退 CPU。当前实机验证设备为 RTX 3060 Laptop 6 GB，其他架构不算实测通过。

## 存储与环境隔离

所有大型资源始终位于应用安装目录，安装盘不可写或空间不足时停止，不另存到 C 盘用户目录。若软件安装在 C 盘，资源也会在 C 盘；减少 C 盘占用需选择其他磁盘的可写安装位置。

| 安装目录下的路径 | 内容 |
| --- | --- |
| asr/components/ | 可搬运的 Python / uv 与目标后端离线依赖资源包 |
| asr/python/ | 早期一键部署使用的基础 Python，保留兼容 |
| asr/packages/wheels/ | 按内容校验的共享 wheel 文件 |
| asr/environments/managed-* | 按后端和 CUDA 构建分别创建的虚拟环境 |
| asr/models/ | 官方下载或本地导入的模型与对齐器 |
| asr/runtimes/ | Whisper 原生运行包及 DLL |
| asr/tools/ | 校验后的 uv 安装工具 |
| asr/cache/ | uv、pip、Hugging Face、Torch、CUDA、Numba 等缓存 |
| asr/temp/ | 安装、推理和检查的临时文件 |
| asr/logs/ | 部署步骤、命令及诊断日志 |
| asr/.transfer-*、.download-* | 下载或导入期间的暂存文件 |

Qwen 使用 Transformers 4，MOSS 使用 Transformers 5，逻辑环境和不同版本依赖分离。基础 Python 与下载缓存可以共享；同卷相同内容的 wheel 与 uv 缓存文件使用硬链接，不能硬链接时复制。配置创建独立环境，不向系统 Python 安装包，忽略继承的 Python 路径、用户包和安装源配置。安装与推理的缓存/临时目录通过子进程环境设置，不修改用户全局变量。

首次准备会下载数 GiB 的运行依赖，模型大小不包含环境和缓存。各步骤按资源大小与暂存需求检查空间；依赖准备还需临时环境空间。完整资源校验后才发布目录；不支持模型权重断点续传。取消会结束本次进程树并清理未完成环境，已完成资源保留，便于重试。状态区显示实际步骤、文件下载进度、日志与取消反馈，不生成虚假的整体进度。

轻量配置记录仍保存在用户配置目录 asr/models.json。识别结果、日志、准备音频属于 projects 中各自的媒体项目。移除模型或环境记录不删除对应文件。

## 官方来源与校验

| 资源 | 官方渠道 / 固定版本 | 模型文件约大小 |
| --- | --- | --- |
| Whisper large-v3 GGML | [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp) | 2.88 GiB |
| Qwen3-ASR-0.6B | [Qwen/Qwen3-ASR-0.6B](https://huggingface.co/Qwen/Qwen3-ASR-0.6B) | 1.75 GiB |
| Qwen3-ASR-1.7B | [Qwen/Qwen3-ASR-1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) | 4.38 GiB |
| Qwen3-ForcedAligner-0.6B | [Qwen/Qwen3-ForcedAligner-0.6B](https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B) | 1.71 GiB |
| MOSS-Transcribe-Diarize | [OpenMOSS-Team/MOSS-Transcribe-Diarize](https://huggingface.co/OpenMOSS-Team/MOSS-Transcribe-Diarize) | 1.71 GiB |
| uv / 独立 Python | [Astral uv 0.13.1](https://github.com/astral-sh/uv/releases/tag/0.13.1)，由 uv 获取官方 python-build-standalone 3.12.13 | 按平台 |
| PyTorch / torchaudio | [PyTorch 官方 CUDA wheel](https://download.pytorch.org/whl/)，2.8.0+cu126 或 +cu128 | 数 GiB |
| Qwen Python 包 | [官方 Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR)，qwen-asr 0.0.6 / Transformers 4.57.6 / accelerate 1.12.0 | 含依赖 |
| MOSS Python 包 | [官方 MOSS](https://github.com/OpenMOSS/MOSS-Transcribe-Diarize)，源码 e3bdd93f8ad58418e04659818efd5fd87a0bc486 / Transformers 5.19.0 / accelerate 1.15.0 | 含依赖 |
| FP4/NF4/INT8 | [bitsandbytes](https://huggingface.co/docs/bitsandbytes/main/en/installation)，0.50.2 | Windows CUDA wheel |
| FP8 权重 | [Optimum Quanto](https://github.com/huggingface/optimum-quanto)，0.2.7 | 含必要依赖 |

uv、MOSS 源码与 Whisper 下载包按代码中固定的大小及 SHA-256 验证。uv 校验独立 Python 下载；Python 包由官方 PyPI / PyTorch HTTPS 源解析并校验。模型直接读取官方 Hugging Face 固定 revision 的文件清单，LFS 文件验证 SHA-256，普通文件验证 Git blob SHA-1，并检查大小与分片完整性，全部成功才发布模型目录。下载入口不依赖预先安装的 Python。

NVIDIA 范围依据[完整驱动支持政策](https://nvidia.custhelp.com/app/answers/detail/a_id/5676/kw/Video%20%26%20Television%20-%20Adjust)与 [CUDA 兼容说明](https://docs.nvidia.com/deploy/cuda-compatibility/minor-version-compatibility.html)。模型和第三方组件继续受各自上游许可证约束。

nvidia-v2 清单包含量化依赖和实际 FP4/FP8 CUDA 运算检查。已保存的环境与模型继续列出；安装目录内检测到但未注册的受管环境标记为待检查，不能仅凭目录存在宣称可用。各档精度含义、设备限制及测试见 [精度与量化](PRECISION.md)。

## 手动兼容入口

ASR 页提供独立模型文件下载与导入；环境页的本机 Python 与手动兼容配置保留 CPU、旧显卡和自有 Python 的使用方式。导入模型会将副本转存到安装目录并校验，原文件保留；已经位于应用 ASR 存储的文件直接复用。目录符号链接不支持转存。

手动页自动检测注册环境、Python 启动器、PATH、Conda 和应用有限目录，不递归扫描磁盘。检测最多 64 个解释器；任意位置的环境可手动指定。选择后“保存并检查”读取实际依赖与 CUDA，失败显示原因，不升级现有环境。

“复制环境配置提示词”包含目标路径、官方依赖、硬件、已有 Python 和模型，供有本机工具权限的 AI 处理。该入口供兼容场景使用；NVIDIA 文件准备与自动环境配置无需用户寻找 python.exe。识别参数仍位于独立二级页，参见[适配器说明](ADAPTERS.md)。
