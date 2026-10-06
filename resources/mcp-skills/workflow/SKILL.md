---
name: muxivra-workflow
description: 用实际硬件、引擎、预设和处理计划完成媒体任务，保留原文件并核对最终结果。
---

# 媒体处理流程

优先使用本应用内置指南、当前工具 inputSchema、参数参考及实际引擎响应。网上的 FFmpeg 命令不能直接作为本应用的结构化请求；不要猜测选项或把缺失信息当作可用能力。

1. 阅读相关指南：音频用 audio，视频用 video，高级调整用 parameters，队列管理与排错用 troubleshooting。
2. 调用 get_system_hardware 与 get_engine_capabilities。硬件字段有 available/missing/error 状态；显存有来源。accelerationValidation 为 not-tested 时，编码器出现在列表中仍不能证明当前 GPU/驱动可用。
3. 调用 list_presets，优先复制合适预设的完整 options，仅覆盖用户要求的参数。
4. 用 list_media_files 列出授权目录一层内的文件；不会递归，最多 500 项。逐个 inspect_media，确认媒体类型、音轨、时长与输出需求。遇到无法分析、权限不足或用户目标不明确，向用户说明并询问。
5. 构造 inputPath、outputPath、options。输出父目录必须已经存在且属于授权输出目录。路径使用完整本机路径。保留原文件；conflict = reject 拒绝覆盖，number 产生不冲突的新名称。
6. 对每个请求先调用 plan_transcode。核对 warnings、输出轨道、编码、剪辑时长与目标路径。用户只要求计划时停在计划；用户已经授权处理时执行。计划不会启动任务。
7. 调用 submit_jobs，最多 500 项。为同一组请求保留稳定 requestKey；相同键及相同请求返回原任务，参数改变时必须使用新的键。批次预检可能耗时，等待响应，不因延迟重复入队。
8. 保存返回的任务 ID，定期 get_job 或 list_jobs。只跟踪当前任务组，不要干预其他来源的任务。报告进度、实际耗时与存在时的预计剩余时间。
9. completed 才是处理完成。failed/cancelled/interrupted 需要如实说明；提交成功或 progress 接近 100 不代表完成。核对输出路径及 outputSize；有本机检查能力时进一步 inspect_media 或完整解码。

GUI 和 MCP 使用同一任务队列、并发上限和引擎。处理时固定提交时的引擎与参数。用户没有要求取消、改参数或换路径时，客户端重连后继续查询既有 ID。

连接提示词只授权连接与读取指南，不授权把目录中的文件自动全部转码。根据用户后续的实际任务操作。
