---
name: muxivra-troubleshooting
description: 任务状态、去重、暂停恢复、取消清理、处理耗时及连接问题诊断。
---

# 任务与排错

## 队列控制

submit_jobs 返回初始 queued 状态及 ID。状态可能是 queued/running/paused/completed/failed/cancelled/interrupted。只控制当前用户明确指定的任务。

- pause_job 暂停等待项或实际处理进程；运行项保留进度，仍占用并发名额。暂停时处理计时停止。
- resume_job 恢复暂停项。move_job 仅支持未开始的等待项，direction 为 up/down/first/last，相对授权范围排序。
- cancel_job 取消等待项可以立即结束；运行项先返回 cancelling = true，随后轮询 get_job，直到 cancelled 且 cancelling 消失。临时输出清理完才算完成；原文件不删除。
- requestKey 用于相同批次重试。参数改变或真正重新创建取消/失败任务时用新键；同一键不同参数会被拒绝。重连后先查既有任务，不重复提交。
- completed 才能报告输出成功。进度和速度来自实际 FFmpeg。elapsedMs 不包含暂停时间；estimatedRemainingMs 只有可计算时出现，estimateBasis 为 progress/history/unknown。没有估计值时说明正在估算，不编造时间。

## HTTP 与权限

| 结果 | 操作 |
| --- | --- |
| 连接拒绝 | 检查提示词的应用启动路径、MCP 是否开启、端口及实际本机执行环境 |
| 401 | 核对用户复制的凭据、当前进程环境变量与应用当前凭据；重置后旧凭据失效 |
| 403 | 本服务仅接受本机连接，Host 为 localhost/127.0.0.1 与实际端口；检查 Origin |
| 404 | 路径必须为 /mcp |
| 405 | 本无会话服务仅支持 POST，不支持 GET SSE |
| 406 | Accept 应包含 application/json 和 text/event-stream |
| 415 | Content-Type 应为 application/json |
| 400 | 请求正文需有效 JSON；JSON-RPC 结构需符合协议 |
| 413 | 单个请求体超过 1 MB，按保持顺序的较小批次提交 |
| 工具 isError | 读取错误原因；权限、路径、轨道、容器、参数或引擎问题不应靠反复提交解决 |

输入/输出父目录须已授权且存在。权限分为分析查询、提交和任务控制；目录真实路径及链接边界会校验。用户提供新路径不自动扩大权限。不要修改应用的授权配置以绕过限制。

failed 时保留任务 error 与日志尾部。interrupted 表示进程曾中断，确认输出是否存在后再计划重新提交。已有输出拒绝覆盖；需要重试时使用新的目标路径或 conflict = number，并告知实际路径。

处理前确保外部 FFmpeg/ffprobe 引擎已配置。内置 mpv 播放库不能代替转码引擎。指南未覆盖的需求先依据当前 schema/引擎核对；仍无法确认时向用户询问。
