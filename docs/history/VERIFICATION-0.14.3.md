# 0.14.3 验收记录

日期：2026-10-14。Windows x64，Electron 44.5.1，内置 mpv v0.41.0-1087-ge470f8986。

本版调整字幕工作区的预览尺寸，修复滚动时隐藏原生视频的行为，并为 ASR 工作台加入有高度限制的识别记录列表和安全删除。整段 ASR、模型与时间精度验证见 [0.14.2 历史记录](VERIFICATION-0.14.2.md)。本版未改变模型推理和时间映射，不重复执行大模型专项。

## 核心检查

| 项目 | 结果 |
| --- | --- |
| 单元测试 | 18 个文件、142 项通过 |
| ASR 集成测试 | 6 项通过；3 项真实模型专项默认跳过，已在上一版单独验证 |
| 构建 | TypeScript 与 main/preload/renderer 构建通过 |
| 预览布局 | 1040×720、1440×900、1920×1080、2560×1440 四种窗口均保持 16:9 视频比例；条目、编辑区和底部工程栏同屏可用 |
| 可用空间 | 1920×1080 测试窗口的预览画面约 382px 高；2560×1440 约 646px 高，不再限制为原来的约 205px |
| 连续滚动 | 原生窗口持续可见，读取实际视频窗口像素确认仍有画面；结束后位置误差不超过 1 个物理像素，窗口和滚动祖先裁剪正确 |
| 字幕全屏 | 卡片内滚动保持视频，全屏覆盖完整播放区域，后台滚动不隐藏全屏，返回保持尺寸、定位和暂停状态 |
| ASR 记录 | 10 条一页，高度不超过 320px，内容在卡片内滚动；未结束任务禁用删除 |
| 删除保护 | 删除记录同时清理初稿和应用拥有的原始结果、缓存与日志；源媒体和 ASS 工程逐字节一致，导出 ASS/SRT 保留 |
| 记录选中 | 修复新任务返回早于队列快照时误选旧记录的问题 |

## 桌面复验

开发版播放器、字幕布局、字幕全屏和 ASR 界面检查通过，页面错误列表为空。ASR 界面测试实际执行整段和显式兼容分片任务，覆盖暂停、继续、暂停后取消、预览、原始输出、ASS/SRT 导出、工程追加/替换、撤销/重做、记录删除及明暗主题。测试后端用于协议和界面验证，不代表识别精度。

播放器检查读取原生 mpv 窗口的屏幕像素。常规 Chromium 截图只能用于界面布局检查，无法捕获原生视频。所有测试使用隔离配置、生成的测试媒体和有边界检查的清理流程，不改写用户媒体。

报告：`artifacts/qa/player-smoke.json`、`subtitle-layout-smoke.json`、`subtitle-fullscreen-smoke.json`、`asr-smoke.json`。

## 打包

`release/final-0.14.3/win-unpacked/Muxivra.exe` 的播放器、四种窗口字幕布局、字幕滚动/全屏和 ASR 界面检查均通过，页面错误列表为空。

- NSIS Windows x64 安装包已生成，版本为 0.14.3。
- `latest.yml` 中的版本、文件名、大小和 SHA-512 与安装包一致，blockmap 存在，更新源为官方 GitHub 仓库。
- 包含原生模块、mpv、MCP 指南与许可证；没有捆绑 FFmpeg/ffprobe 处理引擎、ASR 运行包或模型权重。

报告：`artifacts/qa/packaged-player-smoke.json`、`packaged-subtitle-layout-smoke.json`、`packaged-subtitle-fullscreen-smoke.json`、`packaged-asr-smoke.json` 和 `package-contents.json`。本轮未安装/卸载用户应用或发布 GitHub Release。

复验命令见 [开发文档](../DEVELOPMENT.md)，使用方式见 [使用指南](../USAGE.md) 和 [ASR 指南](../ASR.md)。
