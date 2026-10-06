# 连接 AI 与内置指南

## 复制完整连接提示词

1. 启动 Muxivra，在设置中添加授权媒体/输出目录并启用 MCP。
2. 点击“保存并复制完整连接提示词”。有未保存设置时，先保存并启动服务，再复制；保存失败时不生成新提示词。
3. 将提示词发送给有本机执行能力的 AI 客户端。内容包含实际 URL、凭据及用户/当前进程环境变量命令、授权目录、操作权限、应用启动路径、Codex CLI/TOML 配置、JSON-RPC 连接验证和内置指南入口。

提示词含凭据；界面预览会遮盖凭据，只向可信的 AI 发送。客户端必须能够访问这台电脑；远程云端的 127.0.0.1 不能连接用户本机。写入配置后如需重载或重启，AI 应说明真实状态；有本机代码执行能力时可按提示词直接通过 HTTP JSON-RPC 连接，无需重新检索或下载连接依赖。提示词只授权连接与读取指南，不授权处理现有文件。

## 手动配置

1. 启动 Muxivra，确认媒体引擎就绪。
2. 在设置中添加 MCP 可访问的媒体目录和输出目录，勾选需要的操作权限，开启 MCP 并保存。
3. 将下列内容加入 Codex 的用户 `config.toml`；默认位置是 `%USERPROFILE%\.codex\config.toml`。将端口与 Muxivra 设置保持一致。

```toml
[mcp_servers.muxivra]
url = "http://127.0.0.1:19480/mcp"
bearer_token_env_var = "MUXIVRA_MCP_TOKEN"
startup_timeout_sec = 15
tool_timeout_sec = 60
```

4. 在 Muxivra 设置中复制凭据设置命令，在 PowerShell 中执行。该命令设置用户环境变量 `MUXIVRA_MCP_TOKEN`。配置中仅存放环境变量名。
5. 完全退出并重新打开 Codex，使其读取新的环境变量与 MCP 配置。查询 MCP 工具或使用 `codex mcp list` 检查配置。

Codex 官方文档确认本地客户端支持 Streamable HTTP 和 Bearer 凭据，并共享 MCP 配置：[MCP 接入文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。应用会提供配置供用户复制，不自动修改 Codex 的个人配置。

## 工具

| 工具 | 作用 |
| --- | --- |
| `inspect_media` | 返回指定媒体的编码、轨道、尺寸、时长 |
| `get_engine_capabilities` | 返回真实编码器、解码器、滤镜与版本 |
| `get_component_capabilities` | 用本机 FFmpeg 帮助读取指定 videoEncoder/audioEncoder/filter 的实际参数、范围、默认值和枚举 |
| `get_system_hardware` | 返回 CPU/GPU/驱动/内存/系统、实体/虚拟分类、显存来源及缺失状态和编解码能力；硬件加速未验证 |
| `list_presets` | 返回内置与用户预设及结构化选项 |
| `plan_transcode` | 校验路径、轨道、编码组合并返回处理计划 |
| `submit_jobs` | 入队并立即返回任务 ID，尚未代表完成 |
| `get_job` | 查询进度、状态、耗时、预计剩余时间、错误与输出 |
| `list_jobs` | 按状态筛选授权目录中的任务 |
| `cancel_job` | 显式取消任务并清理未完成输出 |
| `pause_job` / `resume_job` | 暂停/继续任务，保留运行进度；使用任务控制权限 |
| `move_job` | 上移/下移/置顶/置底等待任务，使用查询及提交权限 |
| `list_media_files` | 列出授权目录一层内的媒体文件，最多 500 项 |
| `list_skills` | 列出 6 份随应用发布的 Markdown 操作指南 |
| `read_skill` | 按 id 读取指南；parameters 同时返回实际共享参数定义 |

## 内置 skills

源码位于 resources/mcp-skills/<id>/SKILL.md，打包时嵌入程序并保留 Markdown 文档。指南 ID：connection、workflow、audio、video、parameters、troubleshooting。AI 首先调用 list_skills 和 read_skill(workflow)，再按任务读取；设置页可预览和复制指南。

MCP 同时提供 muxivra://skills/catalog、muxivra://skills/<id> 和 muxivra://reference/parameters 资源，以及 muxivra_workflow prompt。参数参考直接来自应用的共享定义；编码器和滤镜专用参数用 get_component_capabilities 从配置的 FFmpeg 引擎读取。所有远程指南/参数/能力读取遵守分析与查询权限，不能用读取指南绕过限制。指南与应用版本一同发布，当前工具 schema、参数参考和实际引擎是支持范围依据。

连接时的服务 instructions 附带当前硬件快照；资源 `muxivra://system/hardware` 和 `get_system_hardware` 提供硬件与引擎能力。需要查询权限。先读取硬件和预设并分析输入，然后计划、提交、查询。设备缺失/读取失败与 not-tested 必须保留，不能仅根据编码器名称断定显卡可用。批量提交可使用稳定的 `requestKey`；重复键与相同请求返回同一组任务，重复键与不同参数返回错误。去重记录随任务历史保存，应用重启后仍有效。

自然语言示例：

> 把 D:\Media 里的视频转为 H.264 MP4，最高 1080p，音频 AAC，放到 D:\Media\output。先给我处理计划，再开始；任务提交后告诉我最终结果。

输入与输出目录必须已在 Muxivra 中授权。仅凭自然语言提供任意路径不会扩大访问权限。

关闭窗口后 Muxivra 位于系统托盘，MCP 继续运行；从托盘退出后服务停止。客户端断开连接不会取消已提交的任务。运行中的取消请求是异步的，随后查询任务状态确认终止。

## 诊断

- 401：凭据缺失或不一致。更新环境变量后重启 Codex。
- 403：Host/Origin 不被允许，或服务访问条件不符合本机限制。
- 路径未授权：重新检查媒体与输出目录；授权基于解析后的真实路径，包含符号链接边界检查。
- 端口被占用：修改 Muxivra 端口并同步 Codex 配置。
- 服务未运行：检查应用是否正在运行、MCP 是否开启，以及设置页错误提示。
- 编码失败：到任务页查看该任务日志；硬件编码器出现在能力列表中不等同于驱动可用。

当前采用无会话 Streamable HTTP；每次 HTTP 请求创建协议服务器，共享业务队列持有任务状态。支持所锁定官方 SDK 接受的协议版本；已通过官方 SDK 客户端的发现、提交、查询和重连测试。实际 Codex 接入需要用户启用服务并配置本机凭据。
