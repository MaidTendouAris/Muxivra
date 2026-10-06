import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve('artifacts/qa')
const load = async name => JSON.parse(await readFile(resolve(root, name), 'utf8'))
const [batch, cancellation, protocol] = await Promise.all([
  load('mcp-music-100.json'), load('mcp-running-cancel.json'), load('mcp-protocol-checks.json')
])
assert.ok(batch.passed && cancellation.passed && protocol.passed, 'All test suites must finish successfully before issuing the report')
assert.equal(batch.outputs.length, 100)
const checks = [...batch.checks, ...cancellation.checks, ...protocol.checks]
assert.ok(checks.every(c => c.passed))
const minutes = ms => `${Math.floor(ms / 60000)} 分 ${Math.round(ms / 1000) % 60} 秒`
const link = (name, path) => `[${name}](<${path.replaceAll('\\', '/')}>)`
const tests = {
  inspect_media: '逐首读取 100 个输入；读取生成的 AAC 输出',
  get_engine_capabilities: '获取实际 FFmpeg 版本、编码器、解码器与滤镜；确认 AAC 可用',
  get_component_capabilities: '从本机 FFmpeg 获取实际 AAC 编码选项',
  list_skills: '发现离线操作指南',
  read_skill: '读取各类内置指南及随应用定义生成的参数参考',
  get_system_hardware: '读取硬件、驱动、信息来源、缺失状态及未验证的硬件加速标记',
  list_presets: '读取完整 AAC M4A 预设',
  plan_transcode: '逐首生成 100 个计划；核对 AAC、192k、M4A 封装及关闭视频',
  submit_jobs: '批量提交 100 个任务；重复键去重；冲突键拒绝；非法批次原子拒绝',
  get_job: '读取实时进度、速度、耗时、剩余时间和最终完成状态',
  list_jobs: '按状态筛选；持续跟踪全部 100 个最终任务',
  cancel_job: '取消等待项、取消正在编码的诊断项、重复取消及临时文件清理',
  pause_job: '暂停等待项及实际编码进程；核对暂停时进度与处理计时停止',
  resume_job: '恢复等待项与实际编码进程',
  move_job: '等待项置顶及恢复队列顺序',
  list_media_files: '列出 100 个 MP3 输入及 100 个 M4A 输出；拒绝未授权目录'
}
const duration = batch.inputDurationSeconds
const sourceVideos = batch.inputs.filter(i => i.media.streams.some(s => s.type === 'video')).length
const maximumDelta = Math.max(...batch.outputs.map(o => o.durationDeltaSeconds))
const summary = `# 100 首音乐 MCP 实机测试

测试通过：100/100 首音乐已通过 Muxivra MCP 服务转换为 M4A / AAC-LC，目标码率 192 kbps。${batch.tools.length} 个工具全部实际调用，${checks.length} 项检查通过，未发现此次测试范围内的服务器功能异常。

- 服务：Muxivra ${batch.server.version}，${batch.url}；官方 MCP SDK 1.32.0，Streamable HTTP。
- 输入：${link('example_media', batch.inputDirectory)}，100 个 MP3，总时长 ${Math.floor(duration / 3600)} 小时 ${Math.floor(duration % 3600 / 60)} 分。
- 输出：${link('100 个 M4A 文件', batch.outputDirectory)}，合计 ${(batch.totalOutputBytes / 1024 / 1024).toFixed(1)} MiB。
- 批量提交校验耗时 ${(batch.submissionMs / 1000).toFixed(2)} 秒；编码阶段 ${minutes(batch.encodingWallMs)}；包含预检、控制测试与完整输出验证共 ${minutes(batch.totalWallMs)}。保持应用原有并发数 1。
- 最终 100 个任务均为 MCP 来源、completed 状态；一个等待项取消后补交，另有一个运行中取消诊断项，二者没有残留输出。
- 100 个输出均通过独立 ffprobe 核验和 FFmpeg 完整解码。AAC-LC、M4A、采样率、声道与常见歌曲标签正确；最大时长差 ${maximumDelta.toFixed(6)} 秒。
- 100 个原文件 SHA-256 均与处理前一致；输出目录只有 100 个 M4A，没有临时文件。
- ${sourceVideos ? `${sourceVideos} 个输入含视频或封面轨道；本次音频预设关闭视频输出。` : '输入均没有视频或封面轨道。'}

## MCP 功能覆盖

| 工具 | 实际验证 |
| --- | --- |
${batch.tools.map(name => `| ${name} | ${tests[name]} |`).join('\n')}

硬件资源发现与读取、客户端断开重连、重连后去重均通过。无凭据/错误凭据返回 401，未授权 Host/Origin 返回 403，GET 返回 405，错误内容类型返回 415，无效 JSON 返回 400；未授权目录与已有输出也被拒绝。

## 可核对记录

- ${link('批处理、任务和逐文件校验 JSON', resolve(root, 'mcp-music-100.json'))}
- ${link('运行中取消与清理检查', resolve(root, 'mcp-running-cancel.json'))}
- ${link('HTTP 边界检查与实时进度样本', resolve(root, 'mcp-protocol-checks.json'))}

测试脚本中的两处误判（对象引用比较、fetch 规范化 Host）已修正并重新验证，原始问题及修正说明保留在 JSON 的 harnessIssues 中；应用代码无需修改。凭据仅存在于客户端进程内存，没有写入脚本或报告。

结论覆盖本次实际服务的音频批处理和上述 MCP 接口；未逐一验证所有高级滤镜、视频硬件编码组合或 Codex 客户端的自动配置加载。
`
const path = resolve(root, 'MCP-MUSIC-100-REPORT.md')
await writeFile(path, summary)
console.log(JSON.stringify({ report: path, files: batch.outputs.length, tools: batch.tools.length, checks: checks.length, passed: true }))
