# 0.18.0 验收记录

日期：2026-10-14。Windows x64，Electron 44.5.1，内置 mpv v0.41.0-1087-ge470f8986。此前项目生命周期与软件信息验收见 [0.17.0](history/VERIFICATION-0.17.0.md)。

本版新增 Qwen3-ASR、MOSS-Transcribe-Diarize 和 MiMo-V2.5-ASR 本地适配器，将识别参数和运行环境分别移至二级页面，并平滑字幕波形播放指示条。MiMo 按用户确认的范围只交付适配器与配置入口，未进行实际部署。

## 配置与任务

- ASR 主页仅显示模型、识别参数和环境概览；识别二级页按后端展示参数，应用后按模型保存，重启后保留。音轨和识别区间跟随当前媒体，不写入其他项目。
- 运行环境页单独管理 Python、官方源码、Qwen 对齐器和 MiMo 音频 Tokenizer 路径；检查依赖版本、CUDA、设备及显存，缺失信息和失败原因可见。检查不安装依赖或修改环境。
- 缺少环境的模型仍能配置，但不能提交识别；绑定模型或存在未完成任务的环境不能移除或改变后端。
- 自定义 JSONL 后端和 Whisper 工作流保留。原生适配器输出统一文本、时间和说话人，保留模型原始输出；没有时间戳的文本不会自动伪造时间。
- 默认将完整选定音频区间交给官方接口，应用兼容分片仍默认关闭、时长可调。官方 SDK 内部窗口和特征分块由上游实现决定。
- 加载和生成 Token 阶段显示当前状态；无法测量进度时不生成虚假的百分比或预计时间。任务暂停、继续和取消覆盖 Windows Python 启动器及其子进程，环境检查中止亦终止所拥有的进程树。

## 实际模型验证

输入为 tests/media/TED演讲：神奇的斐波那契数列_P1_中英字幕.mp4，时长约 371.265 秒。两次已完成的全片任务均由应用提交一个完整音频区间，保留 raw-0.json，并生成 ASS/SRT 初稿。源文件 SHA-256 为 666b7f9c1cfe8304bab8348c6d280032238a7c159d371bec78edd0c1c170a9cd，测试前后相同。

### Qwen3-ASR

使用 Qwen3-ASR-0.6B 与 ForcedAligner-0.6B，Python 3.12.13、Torch/torchaudio 2.8.0+cu126、Transformers 4.57.6、accelerate 1.12.0。识别使用 RTX 3060 Laptop GPU，对齐使用 CPU，识别语言指定 en。

- 全片任务完成，得到 79 条带时间的英文字幕和 944 个有效词时间段；首个起点 4.240 秒，最后终点 366.279 秒，保留小数时间。
- 对齐器标点差异、零时长词与原文规范化匹配经过回归验证；原文及原始词时间保留，无法对应的结果标记未打轴。
- 另用 15 秒音频验证 auto 自动识别为 English，得到英文文本。
- 全片任务耗时约 12 分 24 秒。该数字包含当前机器的负载，不作为性能基准；未测量字错率或词错率，仍需人工校对。

报告：artifacts/qa/asr-real-qwen-report.json、asr-real-qwen-result.json、asr-diagnostic-qwen.jsonl。

### MOSS-Transcribe-Diarize

使用官方 0.9B 权重，Python 3.12.13、Torch/torchaudio 2.8.0+cu126、Transformers 5.19.0、accelerate 1.15.0。CPU 全片任务完成，得到 84 条带时间和 S01 说话人的字幕，首个起点 4.250 秒、最后终点 366.360 秒，耗时约 47 分 15 秒。

**本次全片输出出现语言偏差：英文音频在附加 en 语言提示的配置下输出西班牙语。** 原生文本、时间、说话人及原始 JSON 均保留，没有通过翻译或改写掩盖结果。尚不能确定语言提示是偏差的原因，也不能据此声称全片英文识别准确度已通过。

- 使用官方默认提示的 15 秒音频测试正常输出英文，得到 5 条带时间和 S01 的结果；显式英文提示的短片也输出英文。这只证明短片路径可用。
- 修正适配器的语言元数据：官方接口不返回检测语言，不再把用户请求语言当作实际输出语言；语言配置明确标为软提示，auto 保留官方默认提示。历史 CPU 报告中的 language=en 是旧适配器复制的请求值，不代表输出语言。
- 默认提示的 GPU 全片复测因显存仅剩约 224 MiB、进度明显变慢，按用户决定停止，未形成完整识别结果。该次停止是结束隔离测试运行器，所有拥有的 Python 子进程随之退出；不计为识别成功或 GUI 取消测试。
- 环境、权重和原生接口路径已验证；长音频的语言稳定性及 6 GB 显卡下的完整 GPU 识别仍有上述限制。

报告：artifacts/qa/asr-real-moss-report.json、asr-real-moss-result.json、asr-real-moss-en-hint-report.json、asr-real-moss-en-hint-result.json、asr-diagnostic-moss-auto.jsonl、asr-diagnostic-moss-english.jsonl、asr-real-moss-gpu-interrupted-report.json。

### MiMo 与可选加速

MiMo 按官方 MimoAudio 构造器、独立音频 Tokenizer、生成参数和停止条件完成适配，协议夹具验证配置及文本结果处理。未下载 MiMo 权重、未验证实际推理、Windows/CUDA 部署或精度。Qwen 的 vLLM、FlashAttention、多 GPU 路径提供配置和缺失依赖诊断，未进行实际部署验证。

## 波形与桌面

- 波形使用现有 48 kHz 音频数据，默认 15 秒窗口，保留 Ctrl+滚轮缩放、点击定位和随播放换页。
- 播放指示条按浏览器动画帧插值，倍速变化、暂停和跳转重置显示时钟，短时同步误差平滑校正；状态长时间不更新时停止外推。字幕打轴及条目跟随仍使用真实播放器时间。
- 打包版实际 mpv 的 2 倍速验证中，观察到 34 次指示条更新、4 次真实时间报告；暂停后指示条保持不动。绘制不重新解码波形、不按帧发送播放器 IPC。
- 配置页明暗主题和两种窗口宽度、参数持久化与重启、真实 Qwen 环境检查及缺失依赖提示通过。四种窗口尺寸字幕布局和现有桌面/MCP 流程回归通过。

报告：artifacts/qa/packaged-asr-config-smoke.json、packaged-asr-smoke.json、packaged-subtitle-audio-smoke.json、packaged-subtitle-layout-smoke.json、packaged-desktop-smoke.json。

## 检查与分发

类型检查及 main/preload/renderer 构建通过。22 个单元文件、160 项通过；常规及新增集成合计 40 项通过、4 项默认跳过；Python 适配器回归 9 项通过。默认跳过项不计为通过，真实 Qwen/MOSS 验证单独记录于上文。

安装包：release/final-0.18.0/Muxivra-0.18.0-win-x64-setup.exe。包内版本、原生适配器、许可证、mpv 校验、原生模块、MCP 指南、GitHub 更新配置，以及 latest.yml 大小、SHA-512 和 blockmap 检查通过。安装包不捆绑 FFmpeg/ffprobe 引擎、Python、PyTorch、模型权重或上游推理源码。

测试使用隔离配置和项目副本，没有修改用户工程、安装/卸载用户应用或发布 GitHub Release。源码归档排除测试视频、运行环境、模型与 Python 缓存。配置与依赖说明见 [本地模型适配器](asr/ADAPTERS.md) 和 [ASR 工作台](ASR.md)。
