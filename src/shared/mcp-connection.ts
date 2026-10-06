import type { McpSettings, McpSetupInfo } from './types'

export const mcpConfig = (port:number) => `[mcp_servers.muxivra]\nurl = "http://127.0.0.1:${port}/mcp"\nbearer_token_env_var = "MUXIVRA_MCP_TOKEN"\nstartup_timeout_sec = 15\ntool_timeout_sec = 60\n`
const ps = (value:string) => `'${value.replaceAll("'","''")}'`
export function buildMcpConnectionPrompt(settings:McpSettings, info:McpSetupInfo, redactToken=false):string {
  const url=`http://127.0.0.1:${settings.port}/mcp`,token=redactToken?'[复制时包含实际凭据]':settings.token
  const roots=(values:string[])=>values.length?values.map(v=>`- ${JSON.stringify(v)}`).join('\n'):'- 未授权'
  const permission=(value:boolean)=>value?'允许':'未授权'
  const start=info.executablePath?`启动命令（需要时在本机执行）：\n\n\`\`\`powershell\nStart-Process -FilePath ${ps(info.executablePath)} -WindowStyle Hidden\n\`\`\``:'这是开发构建，请使用已经运行的 Muxivra 开发进程。'
  return `请在这台 Windows 电脑上为当前 AI 客户端连接 Muxivra MCP，并读取内置操作指南。你可以设置本机用户环境变量、添加或更新当前客户端的 muxivra 连接配置；保留其他配置。此请求只授权连接、发现和读取指南，不授权转码或取消现有媒体任务。连接后等待我提供处理需求。

## 连接信息

- 应用版本：${info.version}
- 服务名称：muxivra
- 协议：Streamable HTTP / JSON-RPC 2.0，POST，无会话
- 服务地址：${url}
- 认证：Authorization: Bearer <MUXIVRA_MCP_TOKEN 的值>，静态凭据，无需 OAuth
- 凭据环境变量：MUXIVRA_MCP_TOKEN
- 工具超时：60 秒；连接超时：15 秒
- 当前服务：${info.running?'运行中':'尚未运行，请先启动应用并启用 MCP'}
- 查询与读取指南：${permission(settings.allowInspect)}；提交任务：${permission(settings.allowSubmit)}；暂停/恢复/取消：${permission(settings.allowCancel)}

授权媒体目录：
${roots(settings.inputRoots)}

授权输出目录：
${roots(settings.outputRoots)}

这些目录不允许通过修改应用配置来自动扩大。输出父目录须存在。

${start}

## 配置凭据与客户端

以下包含连接凭据，仅用于本机连接。不要把提示词、凭据或带鉴权的请求写入项目、公开日志或测试报告。

\`\`\`powershell
[Environment]::SetEnvironmentVariable('MUXIVRA_MCP_TOKEN', ${ps(token)}, 'User')
$env:MUXIVRA_MCP_TOKEN = ${ps(token)}
\`\`\`

如果当前客户端是 Codex，先检查既有 muxivra 条目与本机 CLI 帮助。用户级配置文件为 $CODEX_HOME/config.toml，未自定义 CODEX_HOME 时为 %USERPROFILE%/.codex/config.toml。可以使用以下命令；已有条目需更新而不删除其他设置：

\`\`\`powershell
codex mcp add muxivra --url ${ps(url)} --bearer-token-env-var MUXIVRA_MCP_TOKEN
codex mcp list
\`\`\`

或在用户配置中合并以下条目（只保存环境变量名，不保存凭据）：

\`\`\`toml
${mcpConfig(settings.port)}\`\`\`

其他具备本机操作能力的 AI 客户端使用同一 URL、Streamable HTTP 和 Bearer 环境变量完成配置。若客户端支持重载 MCP，请重载；若必须重启，由用户完成。用户环境变量不会自动进入已经运行的客户端进程。不要仅凭配置文件存在就声称连接成功。

## 当前会话连接与验证

先使用当前客户端已提供的 MCP 连接/工具功能。尚未加载新 MCP 时，如有本机 Shell/代码执行能力，使用已安装的官方 MCP SDK，或 Python 标准库 urllib.request 的 HTTP JSON-RPC 连接，不需要实时联网查询文档或下载依赖。

每个 HTTP 请求头：Content-Type: application/json；Accept: application/json, text/event-stream；Authorization: Bearer <本进程的 MUXIVRA_MCP_TOKEN>。initialize 请求示例：

\`\`\`json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"muxivra-local-client","version":"1.0"}}}
\`\`\`

成功后发送 {"jsonrpc":"2.0","method":"notifications/initialized"}，通知可能返回 202 空正文。随后 tools/list；tools/call 的 params 为 {"name":"list_skills","arguments":{}}，再调用 read_skill({"id":"workflow"})。工具响应先检查 isError，再解析 content 中的 text。

内置指南：${info.skills.map(s=>`${s.id}（${s.name}）`).join('、')}。
也可通过 resources/read 读取 muxivra://skills/workflow、其他 muxivra://skills/<id>，以及 muxivra://reference/parameters；MCP prompt 名为 muxivra_workflow。

查询权限允许时再调用 get_system_hardware、list_presets。报告实际服务版本、发现的工具/指南、授权目录与权限；不要输出凭据。优先使用内置指南、当前工具 schema、实际参数参考和引擎能力。完成用户后续媒体请求时先分析和计划，再提交并查询最终结果。

如果只有远程云端环境或没有本机操作能力，明确告诉我需要本机客户端/执行器。远程 127.0.0.1 无法访问这台电脑。连接失败时说明真实错误及缺失条件，不扩大监听地址或绕过权限。应用保持运行即可，关闭主窗口后托盘中的 MCP 会继续运行。`
}
