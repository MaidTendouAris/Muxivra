# 开发与维护

Node.js 22.12+，使用 `package-lock.json` 复现依赖。npm 11 推荐；本机 npm 10 在较新可选 peer dependency 图中出现过解析崩溃，不应使用 `--force` 跳过兼容检查。

## 安装依赖与运行

在 Windows x64 上，从项目根目录执行：

```powershell
npm ci
npm run prepare:mpv
npm run dev
```

构建后运行或生成安装包：

```powershell
npm run build
npm start
npm run package:win
```

`npm start` 运行本地构建。`npm run package:win` 同时生成 NSIS 安装 EXE 与便携 ZIP，输出到 `release/`；源码归档、GitHub Releases 工作流与第三方许可说明见 [发行文档](DISTRIBUTION.md)。转码需要外部 FFmpeg/ffprobe，应用中的选择或下载流程见 [使用指南](USAGE.md)。

安装包更新使用 `electron-updater`。开发模式禁用真实更新，打包时依据 `electron-builder.yml` 中固定的 GitHub 仓库生成 `resources/app-update.yml`，同时生成 `latest.yml` 和安装包 blockmap。`node scripts/package-check.mjs` 验证包内更新依赖和固定仓库；设置 `MUXIVRA_RELEASE_DIR` 后还要求发行元数据存在，并核对安装包版本、文件名、大小、SHA-512 与 blockmap。更新使用方式见 [应用更新](updates.md)。

`scripts/prepare-installer-manifest.cjs` 的 afterPack hook 将应用文件清单写入忽略目录 `.runtime/`；`resources/installer.nsh` 将清单编译进卸载程序。删除时只处理这些应用文件，先在安装目录内暂存，遇到文件锁则恢复；不递归删除整个安装目录。构建后不能手动向发行包添加文件而跳过清单生成。`node scripts/installer-preservation-smoke.mjs` 编译独立 NSIS 夹具，验证更新/卸载保留输出与未知文件、文件锁回滚和旧版本安装保护，不访问注册表、创建快捷方式或安装真实应用；可用 `MUXIVRA_NSIS_PATH` 指定本机 makensis.exe。

## 检查与维护

```powershell
npm test
npm run test:integration
npm run smoke:desktop
npm run smoke:player
npm run smoke:parameters
npm run smoke:ui
npm run smoke:mcp-setup
npm run smoke:tasks
npm run smoke:interaction
npm run smoke:subtitles
npm run smoke:update
```

集成及桌面测试需要可调用的外部 FFmpeg，用于生成临时媒体。报告与截图保存到 `artifacts/qa/`，配置和数据在 `.test-data/` 中隔离。实际验收结果、安装版验证和下载测试开关见 [验收记录](VERIFICATION.md)。

`npm run prepare:mpv` 按固定清单下载与校验 Windows x64 播放器，只有 mpv.exe 被解压，原始许可证存放于独立目录并随包提供。下载文件缓存于 `.runtime/`，运行文件位于忽略目录 `resources/mpv/`。不使用 PATH 中的 mpv，也不运行上游安装或更新脚本。

`npm run dev` 准备播放器后启动 electron-vite；`npm run build` 包含类型检查和三端构建。`npm run package:win` 准备播放器并生成 Windows x64 安装包、便携包及依赖许可清单。`scripts/icons.mjs` 可重新生成应用 PNG/ICO。`node scripts/verify-release.mjs` 逐文件比较便携 ZIP 与已验证的解包目录，并检查版本、安装 EXE 和更新元数据；详细自动化入口见 [构建与发布](RELEASING.md)。

测试集中于参数/路径边界、字幕往返、真实转码、取消、恢复、MCP 及播放器异步消息。`npm run smoke:desktop` 在隔离配置中验证单文件、批量处理、任务、字幕编辑和设置页面，以及转码、MCP/托盘。`npm run smoke:player` 验证播放器全部动作、原生键盘、无外部引擎播放和实际视频像素，短暂置顶自己的测试窗口以截图，随后恢复。普通 Chromium 页面截图无法捕获原生视频区域。设置 `MUXIVRA_EXECUTABLE` 可以测试打包或已安装 EXE。

`npm run smoke:mcp-setup` 验证通用连接提示词、凭据预览隐藏、保存失败不更新剪贴板、实际 MCP 连接上下文、7 份指南和参数查询；只添加输入目录后，实际通过默认 outputs 完成 AAC 转码并核对媒体，输出仍不能作为未经输入授权的文件读取。另验证离开设置时保存失败保持页面和草稿。测试不修改客户端个人配置或持久环境变量，结束恢复剪贴板并清理自己的输出文件。

`npm run smoke:ui` 验证未保存字段在明暗主题下变色、设置子页保留草稿、离页时应用/放弃/继续编辑，以及应用中的加载和锁定；同时覆盖下拉菜单、取消反馈和自绘退出弹窗。

`npm run smoke:tasks` 使用 106 条合成旧记录和真实媒体副本验证三页历史、详情、完整 Unicode 日志、单条及跨页删除、媒体哈希保留和重启恢复，并单独执行一条真实 AAC 队列任务核对完整处理记录。合成历史不代表执行了 105 次转码。

0.10.0 新增的 `npm run smoke:interaction` 通过实际 MCP 客户端发起目录和转码申请，在应用内批准或拒绝；验证批准前无访问权限、拒绝不授权、审批加载反馈和重试去重。在持续提交权限关闭时批准一次 AAC M4A 转码，并用 ffprobe 核对输出。另验证快捷键二级页面的录入、冲突、未保存标记和离页应用，以及自定义按键在 React 与原生 mpv 视频区域生效、旧键失效、申请与快捷键重启保留。测试使用隔离配置和临时媒体，并检查明暗主题及最小窗口布局。

`npm run smoke:subtitles` 与 `smoke:projects` 使用当前独立项目工作流验证字幕编辑、保存、导出与管理。原 `scripts/subtitle-project-smoke.mjs` 保留旧版同目录工程的历史验收夹具，0.15.0 不将其作为 GUI 验收。ASS 解析、格式转换、自动保存、外部修改和备份继续由单元测试覆盖。

`npm run smoke:asr` 使用真实 FFmpeg 和隔离的 JSONL 测试后端验证工作台导入、预览、原始输出、ASS/SRT 导出、已有工程追加/替换、撤销/重做、未打轴注释、默认整段、自定义兼容分片时长、实际进程暂停/继续/取消，以及记录高度限制、内部滚动和安全删除，检查明暗主题与最小窗口。删除前后比较源媒体与 ASS 工程字节，并检查导出字幕保留。合成后端仅验证协议和工作流，不代表识别精度。

`npm run smoke:subtitle-layout` 检查 1040×720、1440×900、1920×1080 和 2560×1440 下的自适应 16:9 预览，确认页面无整体滚动、内部滚动可用，以及收起的工程栏不遮挡编辑区、展开为悬浮形式且不重新排布工作区。`node scripts/subtitle-fullscreen-smoke.mjs` 复验字幕预览全屏与卡片滚动裁剪。播放器测试还在连续滚动期间读取原生视频窗口的实际像素，检查画面保持可见，并在滚动结束后核对位置。

`MUXIVRA_ASR_REAL=1` 开启 `tests/integration/asr.test.ts` 的真实 large-v3 GPU 验证，要求 `.runtime/asr-validation/` 中已保存并校验 `cpu.zip`、`cuda12.zip`、`ggml-large-v3.bin`，并有 `example_media/0001...` 样本。下载响应用本地已校验字节流替换，应用自身仍完整执行大小/SHA-256 校验、运行包解压、模型安装和真实 CUDA 推理。报告写入 `artifacts/qa/asr-large-v3-report.json`。默认集成测试跳过这项大资源检查；下载资源及真实模型不进入源码或安装包。

`MUXIVRA_ASR_TIMING_SOURCE` 指向用于时间精度复验的 3:07 MP4，开启同文件中的长视频专项测试。要求上述完整模型和解压后的 `.runtime/asr-validation/cuda12/Release/whisper-cli.exe`。测试在隔离配置中分别完成整段和显式 120 秒兼容分片推理，确认启动次数、整段进程暂停/继续、token 小数时间与 ASS/SRT 往返；不写入源文件旁的工程。报告为 `artifacts/qa/asr-whole-report.json` 和 `asr-timing-report.json`。默认跳过这项需要实际媒体和 GPU 的检查。

`npm run smoke:update` 同时启用两项测试开关，模拟新版本、网络和下载失败、安装启动失败；验证启动检测、手动检查、进度、重启确认、设置草稿保护和字幕保存。不会下载或执行安装程序。集成测试另外使用真实 electron-updater 下载隔离的无害文本夹具，验证 SHA-512、缓存和重试；安装启动仅替换进程启动边界进行模拟。

`scripts/install-smoke.ps1` 检查已有安装与运行进程，在项目 `.test-data` 内临时安装当前版本 NSIS 包，运行桌面、播放器、参数/预设、界面/退出、MCP 接入、任务历史、MCP 交互与快捷键、ASS 工程与字幕编辑八组验证，再卸载；发现已有安装或正式运行进程时停止。`scripts/source-archive.ps1` 生成应用源码包，排除播放器二进制、依赖缓存和用户数据，保留准备脚本、清单和许可。

安装脚本默认执行全部八组；相关改动复验可用 `-Suites tasks`、`-Suites interaction` 或 `-Suites subtitles` 等已定义名称选择检查，仍在独立临时安装中验证并卸载。

内置指南位于 `resources/mcp-skills/<id>/SKILL.md`，由 `src/mcp/skills.ts` 导入并随安装包保留。调整请求字段、任务状态或引擎支持范围时，同步更新对应指南；参数参考直接来自共享定义。新增指南需要更新固定目录、连接入口和读取测试，不能将任意本机文件路径作为指南 ID。

环境变量仅用于开发/测试：

| 变量 | 作用 |
| --- | --- |
| `MUXIVRA_DATA_PATH` | 隔离的配置、任务与会话目录 |
| `MUXIVRA_ENGINE_PATH` | 独立引擎测试目录 |
| `MUXIVRA_SMOKE=1` | 自动测试退出时不弹出交互确认 |
| `MUXIVRA_UPDATE_TEST=1` | 仅与 SMOKE 同时启用更新测试驱动；不执行真实更新 |
| `MUXIVRA_EXECUTABLE` | 桌面验证所启动的 EXE |

新增引擎版本时，从发布方核对固定下载 URL、SHA-256、版本、架构、许可证与源码地址；更新固定清单后跑真实处理与下载验证，再发布。不要改用未固定的 latest 下载，也不要打包 `--enable-nonfree` 构建。

本地配置中的 MCP token 属于连接凭据，不应加入版本库、截图或源码包。测试数据、下载缓存、构建产物均不包含在源码归档中。

公开发布前补充签名、发布者元数据、发行说明、名称检查、硬件兼容矩阵，并核对 mpv 静态依赖的完整对应源码。上游提供的固定播放器包缺少完整的逐依赖版本清单；应用源码包不代表完整播放器源码，具体记录见 `resources/mpv-licenses/SOURCES.md`。不要把未经验证的平台写成已支持。

0.15.1 的 `npm run smoke:projects` 验证独立项目导入、默认保留源文件与显式删除、导航分组、长项目名称溢出保护、固定工作区和事件属性避让工程栏、视频封装、改名、回收站和恢复。项目使用隔离 profile/projects；生产环境使用安装目录 projects。`tests/unit/projects.test.ts` 覆盖复制、取消、源变化和目录边界；`tests/integration/projects.test.ts` 执行真实 MKV/MP4 封装与烧录，并核对排队字幕快照。旧版同目录工程测试仅作为底层存储回归夹具，当前应用不启用旧工程恢复。


0.16.0 的 `npm run smoke:subtitle-audio` 使用真实视频与音频、54 条 ASS 事件，验证默认 15 秒视窗、Ctrl＋滚轮缩放、页面缩放因子不变、点击波形定位、实际播放跨视窗切换、重置与明暗主题。字幕同步验证默认关闭、自动选中/滚动/翻页、重叠对白、排除注释，以及输入框编辑期间的保护。`smoke:subtitle-layout` 对比工程栏展开前后的预览、列表和编辑区坐标与尺寸，确保悬浮而不重排。

`tests/integration/waveform.test.ts` 生成 48 kHz、8 kHz 高频与反相双声道夹具，确认波形未因降采样或混合抵消而丢失；用延迟音轨验证补静音和非零视窗定位，另覆盖尾部补零、无音轨与取消。读取范围、像素桶和缓存条目均有限额。

0.17.0 的 `node scripts/project-lifecycle-smoke.mjs` 使用历史空缓存夹具，验证删除后全部导航、重新创建、关闭保存、打开重载、过期请求无副作用，以及隐藏编辑器在退出时不会覆盖管理页导入的内容。`node scripts/software-info-smoke.mjs` 校验软件信息卡片位于最后、组件许可、固定 GitHub 链接、自动检查开关的改色/离页确认/重启保存和关闭自动检查后的手动检查；链接被安全夹具截获，不打开浏览器。`scripts/gui-projects.mjs` 让字幕、ASR 和更新夹具共用当前项目管理创建流程。

## 0.18.0 ASR 适配器验证

npm run smoke:asr-config 检查独立参数页和环境页、Qwen/MOSS 的不同选项、环境诊断与删除保护、配置按模型保存和重启恢复。

python scripts/asr-adapter-test.py 检查 Qwen 标点规范化、零时长词保留、实际词时间分组与缺失时间处理。tests/integration/process-tree.test.ts 使用实际启动器/子进程验证 Windows 暂停、继续和取消。波形实播检查额外比较按帧指示线与实际状态更新次数，验证倍速和暂停冻结。

scripts/asr-real-validation.mjs 使用指定 tests/media/TED 视频、真实 FFmpeg、项目导入、独立环境检查和原生模型，默认整段提交一次，并核对时间、说话人、ASS/SRT 导出及源文件 SHA-256。MUXIVRA_ASR_BACKEND 为 qwen 或 moss，MUXIVRA_ASR_DEVICE 为 cpu 或 gpu；要求 .runtime/asr-adapters 下事先准备对应环境、上游源码和本地模型。测试使用独立配置和媒体副本。scripts/asr-download-validation.py 获取官方固定快照用于本地验证，须保留聊天模板；资源、tests/media 的用户视频和 Python 缓存均不进入源码归档。

详细依赖与配置见 [原生 ASR 适配器](asr/ADAPTERS.md)。MiMo 支持于 0.21.0 暂时移除，vLLM、FlashAttention 和全部设备组合未验证。

## 0.19.0 模型与环境配置验证

npm run smoke:asr-assets 使用隔离配置和小型下载夹具，检查实际 Python 自动发现、直接选择、完整环境检查、AI 提示词、官方目录、进度、绑定、取消、校验失败、安装目录转存和原件保留。主进程网络替身仅在该测试进程内启用，生产应用没有测试下载源。MUXIVRA_SMOKE=1 下共享 ASR 存储位于隔离配置的 installation/asr；普通运行始终使用安装目录。

node scripts/asr-official-validation.mjs 读取四个官方固定版本清单，实际下载小型配置并验证官方 Git blob 哈希，不重复下载大型权重。单元检查覆盖完整文件流、LFS SHA-256、失败不发布、临时目录清理、转存校验、磁盘空间和缓存目录。新配置流程不执行模型推理，0.18.0 的实际推理结果和 MOSS 限制仍单独保留。

字幕与媒体桥接回归：`npm run smoke:subtitle-media`，验证字幕保存/快照、单文件 MKV 任务、纵轴显示增益、紧凑表格与播放器浮层。`node scripts/subtitle-fullscreen-smoke.mjs` 同时检查原生视频裁剪与全屏。

## 0.21.0 NVIDIA deployment validation

`node scripts/asr-deployment-real-validation.mjs` downloads the hash-pinned official uv tool, installs application-managed Python and fresh Qwen/MOSS virtual environments, verifies dependencies and executes real CUDA math. Large downloads, caches and environments stay inside `.runtime/asr-deployment-validation/installation/asr` on the workspace drive. It requires a supported NVIDIA GPU and network access.

`node scripts/asr-deployment-seed-validation.mjs` copies previously downloaded official models into that isolated installation for desktop tests. `npm run smoke:asr-deployment` validates GPU discovery, primary one-click UI, cancellation/retry, log copying, separate environments and real 15-second Qwen/ForcedAligner, MOSS and Whisper inference. This test profile owns copied model assets; do not point it at user settings. Packaged smoke can set `MUXIVRA_EXECUTABLE`; `MUXIVRA_ASR_SKIP_INFERENCE=1` explicitly skips repeated inference and records that limit. Unit tests cover retired MiMo records, storage isolation, hashes, supported architectures, failure/retry and cancellation.

## 0.22.0 subtitle MCP and progress tests

`npm run smoke:subtitle-mcp` uses real HTTP MCP against the Electron editor, including unsaved input, translation, ASS effects/styles, insertion, atomic errors, undo, permissions and page/project scope. `MUXIVRA_EXECUTABLE` selects the packaged application.

`npm run smoke:asr-progress` uses existing isolated Qwen/MOSS environments and official models, records native telemetry and checks single-call results. Optional `MUXIVRA_QWEN_MODEL_PATH` reads an existing Qwen 1.7B directory for a separate 10-second validation. Tests write only inside the workspace test profile; the external model and source media are preserved.
