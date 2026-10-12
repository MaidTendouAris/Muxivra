---
name: muxivra-connection
description: 连接本机 Muxivra Streamable HTTP MCP、配置凭据并验证工具发现。
---

# 连接 Muxivra

本指南随应用发布。地址、凭据、目录及权限以用户复制的连接提示词和当前服务器配置为准。只连接用户的本机执行环境；远程 AI 的 127.0.0.1 指向远程主机，需要本机执行器。

## 连接与验证

1. 使用提示词中的实际 URL，协议为 Streamable HTTP。每个请求包含 `Authorization: Bearer <凭据>`。凭据可存入用户环境变量 `MUXIVRA_MCP_TOKEN`，不写入项目、提交记录或报告。
2. 根据当前平台的 MCP 配置或本机执行能力选择连接方式，使用相同的 URL、传输和认证头。保留客户端其他连接配置；本服务器不要求采用某一种客户端的配置格式。
3. 当前进程不会因修改用户环境变量而自动继承新值。为当前操作进程设置环境变量，并在客户端要求时重新加载 MCP 或由用户重启客户端。配置写入成功不等于连接成功。
4. 使用现有 MCP 客户端完成 initialize、通知 initialized、tools/list。无需 OAuth 登录；本服务采用用户设置的静态 Bearer 凭据。
5. 调用 `list_skills`、`read_skill({"id":"workflow"})`。查询权限允许时读取 `get_system_hardware` 和 `list_presets`。以真实响应报告应用版本、工具及指南，不提交媒体任务作为连接测试。

## 本机脚本方式

客户端尚未加载新工具但有本机代码执行能力时，可使用已安装的官方 MCP SDK，或 Python 标准库的 HTTP JSON-RPC。无需下载第三方连接程序。

- 请求方式：POST，Content-Type: application/json，Accept: application/json, text/event-stream。
- initialize 请求指定受支持的协议版本，例如 `2025-03-26`，capabilities 为 `{}`，clientInfo 包含 name 和 version。
- initialize 成功后发送 `notifications/initialized`；后续用 `tools/list`、`tools/call`、`resources/list`、`resources/read`。
- 服务无会话，不依赖 Mcp-Session-Id。通知可能返回 202 且无正文；不要对空正文强行解析 JSON。保留每个请求的鉴权头，使用 60 秒工具超时。
- `tools/call` 的 params 为 `{ "name": "read_skill", "arguments": { "id": "workflow" } }`。content 中 text 是 JSON；先检查 isError 再解析。

## 生命周期与限制

Muxivra 必须运行；关闭主窗口后托盘中的服务继续，退出应用后停止。客户端断开不会取消媒体任务。授权目录不会因自然语言提供其他路径而扩大。

401 表示凭据不匹配，403 表示 Host/Origin 或本机访问限制，406 通常是缺少正确 Accept。其他排错见 `read_skill({"id":"troubleshooting"})`。

initialize 的 instructions 提供当前授权输入/输出目录、权限和硬件快照。安装目录下的 outputs 默认已提供；输入目录需用户在设置中手动添加，或通过 request_directory_access 发起申请并由用户在 MCP 交互页批准。服务可在输入目录尚未授权时连接；这不代表可以访问任何媒体。后续按 workflow 和 goals 处理需求，不能自行扩大输入授权。
