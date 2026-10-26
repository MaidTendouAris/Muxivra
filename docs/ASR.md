# ASR 工作台

工作台把用户选择的音视频转换为字幕初稿。模型决定识别能力、语言覆盖和时间精度；Muxivra 负责音频准备、任务管理、格式统一和工程衔接，不按评分筛除内容，也不要求逐字打轴。

## 使用

1. 在项目管理创建并打开项目，然后进入 ASR 工作台；项目的打开、切换和关闭都在项目管理完成，工作台只处理当前已打开的项目。
2. 在“资源管理 → ASR”下载或导入模型文件。进入“环境”，选择目标模型与 NVIDIA GPU，分别下载或导入 Python / 离线依赖资源（Whisper 使用原生运行包），然后点击“一键配置环境”。文件准备与环境配置相互独立，缺少文件时配置会停止，不会隐式下载。也可注册并检查已有 Python 环境，再在 ASR 页绑定模型。
3. 在“资源管理 → ASR → 已配置模型”保存识别参数。回到 ASR 工作台选择可用模型，仅设置当前项目的音轨和起止区间。工作台不再承载模型与运行环境配置。详见 [资源管理](RESOURCES.md)和[模型与环境准备](asr/SETUP.md)。
4. 点击“生成字幕初稿”。任务进入共用任务页，识别记录中可查看进度、初稿和原始输出。
5. 导出 ASS/SRT，或点击“编辑初稿”，确认追加或替换条目，再按需要手动修正。

本地 whisper.cpp 模型需选择 GGML .bin 和配套 whisper-cli.exe，保留运行程序旁的 DLL。Qwen3-ASR、MOSS-Transcribe-Diarize 使用各自原生 Python 加载器；MiMo 支持暂时移除。各后端依赖、模型目录、时间戳和配置范围见 [本地模型适配器](asr/ADAPTERS.md)。其他格式继续通过自定义 JSONL 后端接入。

内置下载清单使用 whisper.cpp **b5454** Windows x64 CPU / CUDA 12.4 运行包和完整 `ggml-large-v3.bin`（3,095,033,483 字节，约 2.88 GiB）。这是完整 large-v3，未替换为 turbo 或量化模型。资源保存在安装目录 `asr/`，不打入安装包。NVIDIA 模式需要支持该运行包的显卡驱动；显式选择 GPU 时，未实际启用 GPU 会报错，自动模式允许后端选择 CPU。默认后端不要求 Python、PyTorch 或系统 CUDA Toolkit。

资源来源：[whisper.cpp](https://github.com/ggml-org/whisper.cpp)、[固定运行包](https://github.com/ggml-org/whisper.cpp/releases/tag/b5454)、[转换模型](https://huggingface.co/ggerganov/whisper.cpp)，使用各自原有许可。

## 时间与工程

- 按源媒体时间轴解码选定音轨，重采样为后端要求的 PCM WAV。默认将完整选定区间一次交给后端，识别结束后删除临时 WAV。
- 后端返回本次音频内的毫秒时间，应用加入媒体区间偏移；越界时间裁剪到音频边界，重叠和评分保留。兼容分片时逐片加入各自偏移。
- whisper.cpp 使用完整 JSON 输出启用 token 级时间计算，以有效语音 token 的首尾时间细化段边界；控制 token 不参与打轴。没有有效首尾时间时保留原段边界，不人为增加小数。各分块使用同一规则，保留 token 时间与原始 JSON。小数分辨率不代表识别或对齐必然准确，仍可手动修正。
- 0.14.0 的普通 JSON 记录可能只有整秒段时间，缺少细化所需的 token 数据；升级后需重新识别，已有工程不会自动改写。
- 无时间戳文本保留为未打轴文本，可复制。导出 ASS 或进入编辑时，它们成为起止均为 0 秒的**注释条目**，角色标记 `ASR 未打轴`；设定时间并取消注释后参与显示。SRT 只导出带时间条目。
- 可明确开启“为无时间戳结果使用识别区间估算时间”。整段模式使用完整选定区间，兼容分片使用对应片段范围。这些条目显示“估算”，ASS 角色标为 `ASR 估算`。估算不是模型时间戳。
- 初稿独立保存为 JSON。编辑时打开该媒体所属项目的 ASS，媒体、初稿和缓存均位于安装目录 projects 下的项目文件夹中。应用前确认追加或替换，保留样式和脚本，支持撤销；随后沿用工程保存、60 秒自动保存、恢复缓存与备份规则。

## 任务与资源

默认**整段识别**，应用不按时长切断音频，后端仅启动一次。模型自身的推理窗口或内部切分仍由该后端决定。整段模式直接暂停当前处理进程，继续时保持同一进程和模型；取消终止进程并清理临时音频。

只有在后端长度限制、资源不足等原因导致整段无法处理时，才手动打开“资源管理 → ASR → 配置识别参数 → 识别兼容选项 → 启用兼容分片”。分片时长可自定义为 1–359999 整秒，初始值 120 秒，尾片使用剩余时长。分片逐次启动后端并重新加载模型，会打断上下文，边界可能出错。兼容模式在当前片段识别完成后暂停，等待时显示状态。整段失败不会自动改为分片或覆盖已有初稿。

0.14.2 之前已提交的队列计划保持原分片方式；旧失败、取消或中断任务重试时使用新的整段默认。新版明确启用兼容分片的任务，重试保留其选项和时长。重试创建独立新任务，不改写现有工程或结果。

同一时间执行一个 ASR 任务，避免多个模型同时占用显存；转码并行规则继续生效。任务页支持暂停、继续、取消、排序、记录删除、完整日志和预计剩余时间。模型加载阶段或不返回进度的后端可能暂时没有时间估计。

| 项目目录内路径 | 内容 |
| --- | --- |
| `asr/results/<任务 ID>.json` | 统一的完整初稿 |
| `asr/cache/<任务 ID>/` | 整段或分片原始输出与检查点 |
| `logs/<任务 ID>.log` | 提取音频、后端命令、诊断与结束日志 |

保留最近 1000 条已结束记录。工作台的识别记录每页 10 条，列表高度不超过 320px，超过可用高度时在卡片内滚动。已结束的记录可点击删除按钮并确认；正在等待、识别或暂停的任务须先取消。删除或淘汰 ASR 记录同时清理应用拥有的初稿 JSON、缓存和日志，保留导出的字幕、源媒体、ASS 工程和用户模型。模型与运行包共享保存在安装目录的 asr 文件夹。移除模型只移除配置，任务进行中不可移除其模型。识别记录按当前项目显示；项目导入、回收站和视频导出见 [媒体项目](PROJECTS.md)。

## 自定义后端协议 v1

通用后端是任务调度和结果协议，不是能加载任意权重的单一引擎。用户模型仍需要对应推理运行时。适配器可为本地 EXE，也可通过明确的 Python/Node 等解释器启动脚本；HTTP 服务也可由适配器封装。应用不自动安装自定义后端依赖。

选择“导入 ASR 模型 → 自定义后端 · JSON 配置”：

```json
{
  "format": "muxivra-asr-backend",
  "version": 1,
  "name": "My ASR model",
  "executable": "C:/ASR/env/python.exe",
  "args": ["{manifestDir}/worker.py"],
  "modelPath": "./model",
  "sampleRate": 16000,
  "channels": 1
}
```

程序与模型路径相对清单目录解析；参数中的 `{manifestDir}` 替换为该目录。程序以 `shell: false` 启动，不把清单拼成命令脚本。导入即表示用户选择此本地程序用于推理。

默认整段只启动一次适配器；显式开启兼容分片后每片启动一次。stdin 提供一行 UTF-8 JSON：

```json
{
  "protocol": "muxivra-asr", "version": 1,
  "audioPath": "C:/.../audio-0.wav", "modelPath": "C:/ASR/model",
  "sampleRate": 16000, "channels": 1,
  "durationMs": 120000, "timebase": "chunk-relative-ms",
  "options": {
    "language": "zh", "device": "auto", "threads": 4,
    "beamSize": 5, "initialPrompt": ""
  }
}
```

stdout 仅输出 UTF-8 JSONL，诊断写到 stderr。进度可选，结果必须恰好返回一次，成功以退出码 0 结束：

```jsonl
{"type":"progress","percent":50}
{"type":"result","result":{"language":"zh","segments":[{"text":"一条台词","startMs":500,"endMs":2000,"score":-0.2},{"text":"只有文本，没有时间"}]}}
```

`durationMs` 是本次送入后端的实际音频时长；整段模式中可以大于 120000。为兼容 v1 适配器，`timebase` 字段仍叫 `chunk-relative-ms`，在整段模式同样表示相对本次音频起点，而非源媒体起点。

失败可输出 `{"type":"error","message":"失败原因"}` 并返回非零退出码。时间必须成对提供，为有限非负毫秒且结束晚于开始，**不要提前加入媒体区间偏移**。段可附带 `speaker`、`words`、`estimated`，结果可附带模型专有字段。原始输出保留，标准化字段用于编辑。输出上限 64 MiB、100000 条段，不支持将二进制或进度条写到 stdout。

参考实现：[faster-whisper 适配器](asr/faster-whisper-worker.py)、[清单](asr/faster-whisper.example.json)。它接入用户已有的本地 CTranslate2 Whisper 模型目录，Python 环境需要 `faster-whisper` 及其依赖；GPU 依赖和模型格式见 [官方说明](https://github.com/SYSTRAN/faster-whisper)。模板可以修改，首轮真实模型验证采用 whisper.cpp large-v3。

## 识别进度

Qwen/MOSS 的加载、音频特征准备、生成和词级对齐分别显示当前阶段。无可靠分母时显示动态“处理中”和真实计数，耗时每秒刷新，避免长期停留在 0%。不会按生成 Token 上限伪造音频完成百分比或剩余时间。

Qwen 观察官方 SDK 原生窗口完成量，并在当前窗口显示解码步数；识别窗口具有可用分母时显示“当前阶段”百分比，词级对齐另显示已完成窗口数。只观察调用，不额外切分音频、不改调用次序、模型参数、上下文或输出。官方 SDK 的内部窗口长度仍由其版本决定。

MOSS 显示输入准备状态及实际生成 Token 数，保持未知百分比的动态状态；Beam 大于 1 时不挂接官方不支持的 Token streamer，仍显示阶段动画。加载检查点的进度条只是加载过程，不表示音频识别完成。

任务与 MCP job 数据提供 progressIndeterminate、progressScope、progressMetrics，阶段计数不用于计算整段剩余时间。原生进度摘要会定期写入任务日志。自定义后端原有 percent 消息继续兼容，也可返回以下状态：

```json
{"type":"progress","stage":"已生成 128 Token","percent":0,"indeterminate":true,"scope":"stage","completed":128,"unit":"tokens"}
```

## NVIDIA 长音频与显存

0.23.0 修正 Windows PyTorch 的 GQA/SDPA 回退路径：没有编译 Flash Attention 时，默认 GQA 可能使用会生成巨大注意力矩阵的 math kernel。应用使用等价的 KV 头展开启用融合计算，并禁止无提示退回高内存 math。若精度、GPU 或依赖不支持可用融合内核，会明确提示选择 FP16/BF16、更新驱动或使用 CPU。

MOSS 默认每次只编码一个原生音频特征窗口，所有特征随后仍合并到完整语言上下文。这个批次与“兼容分片”不同，不重载模型、不重置上下文，也不重新打轴。

“配置识别参数 → 显存管理”提供：

- **专用显存预算比例**：Transformers 默认按总专用显存的 90% 设置 PyTorch allocator 上限，并受启动时空闲显存限制，另外预留至少 384 MiB 或总显存的 8%。这是工作进程的分配预算，不是整机所有程序的总占用上限；vLLM 继续使用其独立比例。
- **KV 缓存位置（MOSS）**：默认自动。根据输入 Token、生成上限、层数、KV 头、精度和 Beam 数估算缓存，预算不足时使用 Transformers 的 CPU offloaded 缓存。仍保留完整上下文，但 CPU/GPU 间传输会降低速度并增加系统内存占用；可明确选择 GPU 或 CPU。
- **音频编码批次上限（MOSS）**：默认 1。增加批次可能提速，但需要更多显存。

CPU 缓存也需要可用系统内存。预算不足会明确停止；不隐式分片、不自动更换模型、量化或降级到 CPU 识别。可释放其他进程资源、降低 Beam/批次、使用半精度，或最后手动打开兼容分片。

日志的 asr-memory 记录输入 Token、缓存估算、缓存位置、PyTorch allocated/reserved 及峰值。任务页硬件监控显示整个系统全部进程的 GPU 数据；不能把该读数直接当作单个模型的分配量。CPU KV 缓存使用受控的主存，区别于 Windows 因专用显存耗尽而持续扩展共享 GPU 内存。

升级应用即可使用这些修正，现有环境和权重无需重新下载。未设置的新参数采用默认值；已排队任务仍保留原有识别/兼容分片选项。实际内存回归与范围见 [验收记录](VERIFICATION.md)。

实现参考：[PyTorch 2.8 SDPA](https://docs.pytorch.org/docs/2.8/generated/torch.nn.functional.scaled_dot_product_attention.html)、[PyTorch allocator 预算](https://docs.pytorch.org/docs/2.8/generated/torch.cuda.memory.set_per_process_memory_fraction.html)、[Transformers KV 缓存](https://huggingface.co/docs/transformers/kv_cache)。

## 首次部署的网络检查

0.23.1 起，部署页提供“检查下载网络”。可分别查看 GitHub、PyPI、PyTorch 和 Hugging Face 入口状态，并复制诊断报告。检查不下载大模型文件；实际下载遇到 CDN、代理、DNS、超时或证书问题时，部署提示与完整日志会显示资源地址及原因。

同一局域网内，两台设备的 Windows 系统代理/PAC、DNS、根证书、系统时间与防火墙可能不同。应用下载使用系统网络代理；Python/依赖安装步骤把该入口的代理传给独立 uv 进程，并启用系统根证书。已有 HTTPS_PROXY/ALL_PROXY 对依赖安装程序保留优先级，不修改用户或系统环境变量。复杂分流和认证代理可能仍需固定代理设置。

遇到错误时，在新设备打开“资源管理 → 模型下载与部署 → 检查下载网络”，复制诊断及完整部署日志。优先根据具体地址和错误检查该设备设置。证书错误应修正系统时间、根证书或受信任的代理证书；应用不会通过禁用 TLS 校验绕过。所有资源仍来自官方地址，原有大小/哈希校验保留。

连接失败及部分临时 HTTP 错误最多重试三次并显示状态；取消会立即停止。已完成的独立环境和模型会保留，下次部署优先复用。流中断不会伪装成已完成文件。

下载使用无磁盘 HTTP 缓存的独立会话；资源、安装包缓存、Python 和依赖继续位于安装目录 asr 下，不会因更换网络栈将模型正文缓存到 C 盘。检查入口可连接，不代表大文件 CDN 或整次部署一定成功。

[网络修复验收](VERIFICATION.md) · [环境部署说明](asr/SETUP.md)

0.23.2 增加 uv 官方 PyPI 备用包，以及 Qwen 两个模型和对齐模型的官方 ModelScope 备用下载；均保留固定版本与哈希。诊断扩展到八个入口，并显示实际重定向、系统代理和 DNS。MOSS、Whisper 权重仍需 Hugging Face。具体范围及维护方式见 [官方渠道与诊断](asr/DOWNLOADS.md)。

## 精度与量化

0.24.0 增加 Qwen/MOSS 的 FP4、NF4、FP8、INT8、FP16、BF16 和 FP32 选择，位于识别参数二级页；低位权重可单独选择计算精度，FP4/NF4 支持嵌套量化。一键部署包含固定版本的量化依赖，旧环境仍保留。原始模型文件不变，任务加载时转换；量化不改变自动分片规则或专用显存预算。Whisper GGML 与自定义后端的精度由模型文件/后端管理。具体范围、设备与验证见 [精度说明](asr/PRECISION.md)。
