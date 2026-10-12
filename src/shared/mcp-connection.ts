import type { McpSettings, McpSetupInfo } from './types'

export function buildMcpConnectionPrompt(settings:McpSettings, info:McpSetupInfo, redactToken=false):string {
  const token=redactToken?'[复制时包含实际凭据]':settings.token
  const roots=(values:string[])=>values.length?values.map(v=>JSON.stringify(v)).join('、'):'未授权'
  const permission=(value:boolean)=>value?'允许':'未授权'
  return `请连接以下 Muxivra MCP 服务器，根据你所在平台的能力选择连接方式。连接后读取内置指南，等待我的处理需求。

连接信息：
- 服务：muxivra ${info.version}
- 地址：http://127.0.0.1:${settings.port}/mcp
- 传输：Streamable HTTP / JSON-RPC 2.0；无会话，仅 POST
- 请求头：Content-Type: application/json；Accept: application/json, text/event-stream
- 认证头：Authorization: Bearer ${token}
- 凭据可使用环境变量 MUXIVRA_MCP_TOKEN；静态 Bearer，无需 OAuth
- 连接超时：15 秒；工具超时：60 秒
- 状态：${info.running?'运行中':'尚未运行，需启动应用并启用 MCP'}
- 应用路径：${info.executablePath?JSON.stringify(info.executablePath):'开发构建，使用运行中的开发进程'}
- 输入目录：${roots(settings.inputRoots)}
- 输出目录：${roots(settings.outputRoots)}
- 权限：查询与读取指南：${permission(settings.allowInspect)}；提交任务：${permission(settings.allowSubmit)}；暂停/恢复/取消：${permission(settings.allowCancel)}
- 仅本机可访问；远程平台需本机执行器。提示词含私密凭据，请勿公开。

服务器返回内容：
- initialize 返回实际协议版本、serverInfo 和 instructions，包含当前目录权限与硬件信息。发送 notifications/initialized 后进行工具发现；通知可返回 202 空正文。
- tools/list 返回工具及 inputSchema；工具结果先检查 isError，成功结果在 content 的 text 中为 JSON，错误文本说明原因。
- list_skills / read_skill 返回离线指南及版本：${info.skills.map(s=>`${s.id}（${s.name}）`).join('、')}。先读 workflow，模糊需求再读 goals；parameters 附带实际参数定义。
- resources/read 可读取 muxivra://skills/<id>、muxivra://reference/parameters、muxivra://system/hardware；muxivra_workflow 提供操作流程。
- 硬件和引擎查询返回能力及缺失状态；not-tested 表示硬件加速尚未验证。plan_transcode 返回计划和警告，不执行任务。
- request_directory_access / request_transcode 返回待审申请 ID；用户在 MCP 交互页批准或拒绝，get_request 查询结果及 jobIds。pending 不是授权或已创建任务。已授权操作仍可直接执行。
- submit_jobs 返回任务 ID 与初始状态；之后通过 get_job 查询进度、耗时、预计剩余时间及最终结果。提交成功不代表处理完成。`
}
