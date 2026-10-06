# 架构

`renderer → preload → main → MediaService → JobQueue → FFmpeg`。MCP 的 16 个工具使用同一个服务及内置指南，任务集中显示在独立的“任务”页面。

- `src/shared/`：数据类型、Zod 输入校验、媒体容器边界。
- `src/renderer/`：React 页面、统一控件、Tailwind/CSS 变量与字幕编辑会话交互。
- `src/preload/`：有限业务 API；不暴露原始 IPC、Node 或 shell。
- `src/main/`：窗口、托盘、文件对话框、IPC 来源检查和 mpv 原生播放区域。
- `src/core/`：引擎验证、处理计划、输出校验、JSON 存储、队列、字幕、波形和异步播放器控制通道。没有 Electron/React 依赖。
- `src/mcp/`：官方 SDK、回环 HTTP、凭据和来源检查、工具 Schema，以及固定目录的离线指南。

## AI 接入与指南

连接提示词由 shared/mcp-connection.ts 根据实际设置和应用路径生成。主进程仅在 MCP 已运行时复制包含凭据的完整内容；设置页先保存用户草稿，成功后复制。预览隐藏凭据，复制失败不会覆盖剪贴板。提示词包含本机启动、用户与当前进程环境变量、Codex 用户配置、HTTP JSON-RPC 验证和指南入口；不直接修改其他客户端的配置。

resources/mcp-skills 中的 6 份 Markdown 通过构建静态导入嵌入主进程，安装包也保留原始文档。list_skills/read_skill、skills 资源与 muxivra_workflow prompt 遵守分析查询权限；不能接受文件路径或读取用户任意 Markdown。参数资源来自共享定义，get_component_capabilities 读取本机引擎帮助并使用已有缓存。指南与应用版本同步，initialize instructions 指向工作流程指南。

第一版核心由主进程管理，其 I/O、子进程和队列均为异步；FFmpeg 执行媒体计算。未引入 utilityProcess，模块边界已为后续独立承载保留。

## 任务与输出

提交时顺序完成所有参数、媒体和路径检查，保存最终预设/轨道/引擎快照及批次 ID，然后原子写入历史。整批计划失败不会部分入队。提交响应的状态是 `queued`。

队列默认串行，支持 1–4 并发。输出重名拒绝或编号；转码写入输出目录内的独立临时文件，成功后以独占方式发布到最终路径，始终拒绝覆盖。取消先发送退出请求，2 秒后仍在运行则终止子进程；未完成输出被清理。

取消请求被接受后，describe 返回临时 cancelling 状态并推送更新，执行收尾后删除标志。界面从点击开始保持加载反馈，不把接口返回当成进程已经结束；该临时状态不写入任务历史。

运行中任务随异常重启转为 `interrupted`；已排队任务可继续执行。每条任务保存引擎绝对路径、参数、时间、进度、状态、日志和最终输出大小。错误日志单独存盘；界面仅显示尾部摘要。

暂停等待项不会启动进程；暂停运行项在 Windows 上通过 `NtSuspendProcess` / `NtResumeProcess` 控制队列自身的 FFmpeg 子进程，保留进度与并行名额。仅请求 PROCESS_SUSPEND_RESUME 权限，不接受外部 PID。取消/退出先恢复暂停进程，再执行原取消流程；恢复失败则终止该子进程。暂停状态保存来源（queued/running）：异常重启时暂停运行项标记中断，暂停等待项保持暂停。等待项的上移/下移/置顶/置底写入持久化队列顺序，运行项不变；MCP 只能调整授权等待项之间的顺序。

活动计时在暂停期间冻结。运行任务以实际处理时长与 out_time_us 估算剩余时间；等待项仅从相同参数、引擎、视频尺寸和媒体类型的最近完成记录估算。没有可靠样本时显示“暂无估算/估算中”，不伪造固定速度。MCP 查询同样返回 elapsedMs、estimatedRemainingMs 与估算来源。

进程控制 API 参考：[Windows 进程权限](https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights)、[System Informer 原生 API 声明](https://github.com/winsiderss/phnt/blob/master/ntpsapi.h)。

客户端去重键以来源划分，关联原始请求摘要和任务 ID。重复请求不会再次执行；不同请求不能复用同一键。

## 接入边界

窗口启用 `contextIsolation`、`sandbox`、禁用 Node integration；主进程验证 IPC 的窗口和主 frame。生产页面使用 `muxivra://app` 加载应用静态文件，媒体不交给 Chromium。外部导航和新窗口均被拒绝。

GUI 读取文件经对话框或拖入授权。默认输出目录为安装目录下的 outputs，开发模式为项目根目录下的 outputs；启动时创建并授权 GUI，可另选目录。创建/写入失败会明确提示，不静默换路径。MCP 使用设置中的媒体/输出目录与操作权限，默认输出的 GUI 授权不扩展 MCP 授权。解析真实路径以防符号链接越界；网络地址、相对路径、UNC/设备路径和播放列表不被接收。FFmpeg 以绝对可执行路径、参数数组、`shell: false` 启动。

MCP 默认关闭，绑定 `127.0.0.1`，验证 Host、Origin（若存在）和 Bearer 凭据，请求上限 1 MB。队列与运行中的任务不会因 HTTP 连接关闭而取消。

## 存储与引擎

配置、个人预设、任务历史和字幕会话通过临时文件 + rename 原子写入 JSON。存储损坏不会被静默覆盖；启动会明确报错，原文件保留。

引擎固定清单在 `src/core/engine/index.ts`。下载先校验固定 SHA-256，防止 ZIP 越界与符号链接，再验证版本和能力，最后切换。原引擎与运行任务不受影响；旧引擎记录可用于切回。默认引擎目录位于 LocalAppData，不随应用升级改变。

FFmpeg/ffprobe 命令行处理引擎由用户选择或按需下载，不随安装包分发。Electron 必需的 `ffmpeg.dll` 保留；应用播放使用内置 mpv。

## 硬件信息

HardwareStore 首次启动通过 Node.js、固定 PowerShell CIM 查询、原生 DXGI 和可用的 NVIDIA 驱动接口读取硬件，缓存到 userData/hardware.json。CIM 提供 CPU 型号/核心数及显卡驱动；DXGI_ADAPTER_DESC1 的 SIZE_T 提供 64 位专用显存、共享内存上限和 LUID。D3DKMT PCI 地址匹配实体设备；只对相同 PCI 地址/厂商/设备/子系统合并适配器，虚拟及软件适配器单独标记。NVIDIA 驱动自带 NVML 可读取物理总容量，按 PCI 地址与设备 ID 匹配，保留 DXGI 系统可用容量，两者不混用。不存在驱动库时回退 DXGI 并标明来源，不捆绑厂商 DLL，不再使用 32 位 CIM AdapterRAM。

缓存版本升级为 2；旧版、无效硬件缓存重新采集，有效缓存直接读取。记录系统启动时间，重启后重新采集 GPU LUID，避免性能计数器匹配过期标识。设置页展示紧凑摘要，独立详情子页展示完整设备、来源、缺失字段和可搜索的编码器/解码器/滤镜，返回不丢失设置草稿。字段状态为 available/missing/error；CIM 失败保留 Node.js 基础数据，DXGI 独立尝试采集，未获得准确容量时不填入旧值。手动更新重新读取并原子保存。MCP 查询权限开启时，初始化 instructions、get_system_hardware 与 muxivra://system/hardware 提供同一硬件快照和引擎能力；硬件加速保留 not-tested，需实际试编码验证。

UsageMonitor 为任务页提供独立 systemUsage IPC，不把每秒性能数据放入应用全局快照或 MCP 静态缓存。CPU 按 os.cpus 的各逻辑线程时间差计算，内存使用总量减空闲量。独立 Node Worker 持有 Windows PDH 查询，PdhAddEnglishCounterW 使用不受系统语言影响的计数器名；GPU Engine 按 LUID/物理引擎聚合进程实例，整体值取最忙引擎而非相加，GPU Adapter Memory 提供整机专用/共享使用量，字节值使用 NOCAP100。默认摘要取最忙实体 GPU，展开显示各卡及所有线程。首个样本、驱动计数器缺失和失败都有明确状态。只在任务页可见且窗口未隐藏时请求，6 秒无人请求后关闭查询与 Worker，退出前清理；采样耗时不阻塞主进程。

接口依据：[DXGI 容量字段](https://learn.microsoft.com/en-us/windows/win32/api/dxgi/ns-dxgi-dxgi_adapter_desc1)、[Windows GPU 使用率口径](https://devblogs.microsoft.com/directx/gpus-in-the-task-manager/)、[PDH 数组采样](https://learn.microsoft.com/en-us/windows/win32/api/pdh/nf-pdh-pdhgetformattedcounterarrayw)、[NVIDIA NVML](https://docs.nvidia.com/deploy/nvml-api/latest/api/group__nvmlDeviceQueries.html)。

## mpv 播放

`renderer → preload → MpvPlayers → Windows named pipe → mpv`。主进程为单文件和字幕页面分别创建会话，以固定、经 SHA-256 校验的 mpv.exe 启动。Koffi 调用 Win32 创建 Electron 窗口内的子窗口，mpv 通过 `--wid` 在此区域渲染，使用 D3D11 与可用的安全硬件解码。

播放器不暴露任意 mpv 命令、脚本或可执行路径。公开动作经严格 Schema 校验，再映射为有限命令。文件必须已通过 GUI 对话框或拖放授权；只允许本地容器，强制 lavf 及协议/格式白名单，禁用网络、自动附加文件、用户配置、脚本与 yt-dlp。

IPC 按请求 ID 关联异步响应，处理拆分消息、超时、进程退出和未完成请求。播放状态与轨道由属性观察推送至 renderer。显示比例来自 video-out-params 的显示尺寸与旋转，普通预览高度同时限制为 540px 和 60vh。音量从 50% 开始；拖动先显示本地值，每次仅发送一个音量请求，后续请求合并为最后值，避免旧状态覆盖滑块。播放列表最多 500 项。页面离开、最小化或隐藏会暂停播放器，不影响转码与 MCP。

截图先由 mpv 写入私有临时文件，再独占发布到用户选择的新 PNG。字幕编辑会话写入内部 SRT 并更新同一字幕轨道，不修改源字幕。实时预览与波形分开，波形仍使用外部 FFmpeg；没有处理引擎也能播放。

运行时固定清单位于 `resources/mpv-manifest.json`，下载准备脚本位于 `scripts/prepare-mpv.ps1`。播放器的静态播放库、许可和上游源码信息见 `resources/mpv-licenses/`。

## 参数和预设

静态参数目录在 src/shared/parameters.ts；严格 Schema 与核心计划共用同一数据模型。组件 AVOptions 从引擎帮助解析、缓存并验证，不能指定执行文件、额外输入输出或任意命令。滤镜值经过 AVOption 与 filtergraph 两层转义，直接传入 spawn。字幕引用经与输入相同的路径授权，任务启动时重新检查真实路径。新字段可选，旧预设和处理请求保持兼容。

预设 JSON 带 format/version；导入整批验证后原子保存，并为每项生成新的个人 ID。导出独占写入，不保存输入轨道与当前预设引用。详细参数编辑器使用草稿，取消不修改参数；主面板和批量共用组件。Radix 菜单/对话框提供键盘操作和焦点管理；下拉菜单使用滚轮和自绘滑条，滑条采用指针捕获，支持拖动、轨道点击和键盘滚动。renderer 为普通菜单/提示发送实际交叠的矩形，主进程使用 SetWindowRgn 局部裁剪原生窗口；菜单采用实心直角边框，裁剪不额外扩张，按同一屏幕像素原点取整，避免圆角和阴影周围露出黑色底层。退出弹窗期间隐藏原生视频表面以覆盖完整遮罩，取消退出后恢复显示，不重载媒体；参数编辑弹窗保留原有局部裁剪。

## 操作反馈与退出

Button 自动跟踪返回的 Promise，显示加载图标、aria-busy 并阻止重复点击；RunAction 统一处理错误和页面顶部的固定处理指示。取消任务还结合本地点击状态与后端 cancelling 标志持续反馈。字幕自动保存与波形生成单独显示加载状态，避免后台读取阻塞其他编辑。

托盘和正常退出流程共用主进程的退出状态。requestExit 显示并聚焦主窗口，通过专用事件和 exitState 查询让 renderer 展示应用内确认框；respondToExit 仅在存在退出请求时接受确认，布尔值和 IPC 来源均校验。取消、Escape 或关闭确认框继续运行；确认后即时锁定弹窗并显示动画，主进程顺序关闭播放器、MCP、队列、硬件采样及存储，完成后才允许真正关闭窗口。自动化退出仅在隔离测试环境启用。
