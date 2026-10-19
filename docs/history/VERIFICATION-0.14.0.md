# 0.14.0 验收记录

日期：2026-10-14。Windows x64，Electron 44.5.1，内置 mpv v0.41.0-1087-ge470f8986。

本版新增 ASR 工作台，以模型适配器生成可编辑的字幕初稿。首轮提供 whisper.cpp GGML 模型和自定义 JSONL 后端，接入共用任务队列、原始结果查看、ASS/SRT 导出及源媒体关联的 ASS 工程。修复了字幕撤销/重做读取可变工程引用导致的历史快照错误。

## 核心检查

| 项目 | 结果 |
| --- | --- |
| 单元测试 | 18 个文件、139 项通过 |
| 集成测试 | 启用真实 ASR 验证后，29 项通过；固定 FFmpeg 大包下载 1 项按配置跳过 |
| 构建 | TypeScript 检查及 main/preload/renderer 构建通过 |
| 通用后端 | 实际 FFmpeg 分块提取、自定义子进程 JSONL、UTF-8 分包、进度、错误与原始结果持久化通过 |
| 时间映射 | 区间偏移、分块边界、词时间与无时间戳结果处理通过；不把未打轴文本伪装成精确时间 |
| 队列 | 暂停后恢复、暂停时取消、一个 ASR 推理任务的并发限制、重启中断及记录清理通过 |
| 文件保护 | 删除记录只清理应用拥有的结果、缓存与日志；源媒体、导出字幕、ASS 工程和自定义模型保留 |

原有更新、转码、字幕工程等集成测试也在本轮完整测试集中执行。测试配置使用隔离目录；清理前验证路径边界。

## Whisper large-v3 实际验证

参考运行包为 whisper.cpp b5454 的 Windows x64 CPU 和 CUDA 12.4 版本；模型为完整 `ggml-large-v3.bin`，大小 3,095,033,483 字节，SHA-256 为 `64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2`，没有改用 turbo 或量化模型。

- 从官方资源取得运行包和权重并校验摘要；集成复验将已取得的原始字节流送入应用的安装器，完整执行流式大小/摘要校验、解压、运行程序检查和模型自动登记，不重复下载大文件。
- 在本机 NVIDIA GeForce RTX 3060 Laptop GPU（6 GiB）上，通过标准任务工作流识别示例 MP3 的 30–42 秒区间，语言 `zh`、显式 GPU、Beam size 5。
- 任务完成并返回 3 条带时间字幕；统一结果时间均落在媒体的 30–42 秒区间。日志确认模型类型为 large v3，加载 CUDA 后端并实际使用 CUDA0。
- 初次尝试的 CUDA 11.8 运行包缺少所需 cuBLAS 动态库，会退回 CPU；应用显式 GPU 验证将其判为失败。下载清单已改用包含依赖的 CUDA 12.4 运行包。

详细报告为 `artifacts/qa/asr-large-v3-report.json`。这次实际模型验证覆盖一个 12 秒区间，未据此承诺所有媒体的识别质量或长时间运行性能。多块结果与时间偏移另由实际 FFmpeg 加协议夹具验证。

## 桌面与打包检查

开发构建及最终打包副本 `release/final-0.14.0/win-unpacked/Muxivra.exe` 的 ASR 工作台检查通过，页面错误列表为空：

- 模型清单导入、媒体与音轨选择、生成任务、初稿预览、未打轴标记、分块原始输出和任务详细信息。
- ASS/SRT 实际写出；初稿追加与替换现有源文件 ASS，保留脚本信息，撤销/重做后保存内容正确。
- 取消实际运行中的自定义后端进程，任务进入已取消状态。
- 明暗主题及 1040×720 最小窗口，无横向页面溢出；原有字幕预览、条目、编辑与工程栏仍可同屏操作。
- NSIS x64 安装包生成成功。包内容检查确认 ASR 协议、原生模块、mpv、7 份 MCP 离线指南与许可文件存在；不包含 FFmpeg/ffprobe 命令行引擎、ASR 推理运行包或模型权重。
- `latest.yml` 的版本、文件名、大小和 SHA-512 与最终安装包一致，blockmap 存在，更新源仍为官方 GitHub 仓库。

报告为 `artifacts/qa/packaged-asr-smoke.json`、`packaged-subtitle-layout-smoke.json` 和 `package-contents.json`。本轮未安装或卸载用户应用，未发布 GitHub Release；安装保护与更新 GUI 的前轮完整验收见 [0.13.0 历史记录](VERIFICATION-0.13.0.md)。

## 复验与范围

执行命令与真实模型测试开关见 [开发文档](../DEVELOPMENT.md)，使用流程与后端协议见 [ASR 工作台](../ASR.md)。本轮执行 `npm test`、启用 `MUXIVRA_ASR_REAL=1` 的 `npm run test:integration`、`npm run build`、`npm run smoke:asr`、`scripts/subtitle-layout-smoke.mjs`、Windows 打包与 `scripts/package-check.mjs`；打包后设置 `MUXIVRA_EXECUTABLE` 重复界面检查。

模型及运行包需用户在工作台下载或导入。whisper.cpp 每块启动并加载模型一次，暂停在块结束时生效；取消可终止当前进程。自定义模型需要自己的推理依赖，不能把不同格式的权重交给同一加载器。附带的 faster-whisper Python 适配器已检查语法与接口，未安装其依赖或执行该后端的模型推理。

ASR 暂仅通过 GUI 使用，没有新增 MCP ASR 工具。代码签名、许可与发行要求见 [发行文档](../DISTRIBUTION.md)。
