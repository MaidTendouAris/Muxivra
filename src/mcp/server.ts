import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { readdir, realpath, stat } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { MediaService } from '../core/service'
import type { McpSettings } from '../shared/types'
import { APP_VERSION } from '../shared/version'
import { requestSchema, pathSchema } from '../shared/schema'
import { isWithin, localPath } from '../core/media/paths'
import { skillCatalog, skillIds, readSkill, parameterReference } from './skills'

const instructions = 'Muxivra performs local media jobs using one shared GUI Tasks page. First call list_skills and read_skill with id workflow, then read the relevant bundled skill. Use the current tools inputSchema, read_skill(parameters) parameterReference and actual engine capabilities as the reference for supported options. Only access configured input/output directories. Read get_system_hardware before choosing an encoder. Missing/error hardware fields and not-tested acceleration must not be treated as verified support. Inspect files and use plan_transcode before submit_jobs. Submit structured options, never shell commands. A submitted job is queued, not completed: poll get_job for its final status, elapsed time and estimated remaining time. pause_job/resume_job retain progress; move_job changes pending execution order. Use a stable requestKey on client retries; cancellation is explicit. Original files are preserved and existing outputs are never silently overwritten. Respect the user’s requested operation.'
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
export function createMediaMcp(service: MediaService): McpServer {
  const context=service.settings.mcp.allowInspect?` System hardware at connection: ${JSON.stringify(service.snapshot().hardware)}. Engine acceleration support is not runtime-tested.`:''
  const server = new McpServer({ name: 'muxivra', version: APP_VERSION },{ instructions:instructions+context })
  server.registerResource('system_hardware','muxivra://system/hardware',{description:'本机处理硬件、缺失状态和 FFmpeg 编解码能力',mimeType:'application/json'},async uri=>({contents:[{uri:uri.href,mimeType:'application/json',text:JSON.stringify(service.systemHardware('mcp'))}]}))
  const requireInspect = () => {const settings=service.settings.mcp;if(!settings.enabled||!settings.allowInspect)throw new Error('分析与查询权限未开启')}
  for(const skill of skillCatalog())server.registerResource(`skill_${skill.id}`,skill.uri,{title:skill.name,description:skill.description,mimeType:'text/markdown'},async uri=>{requireInspect();return {contents:[{uri:uri.href,mimeType:'text/markdown',text:readSkill(skill.id).markdown}]}})
  server.registerResource('skill_catalog','muxivra://skills/catalog',{description:'内置操作指南目录与版本',mimeType:'application/json'},async uri=>{requireInspect();return {contents:[{uri:uri.href,mimeType:'application/json',text:JSON.stringify(skillCatalog())}]}})
  server.registerResource('parameter_reference','muxivra://reference/parameters',{description:'当前应用共享定义生成的参数、滤镜与范围',mimeType:'application/json'},async uri=>{requireInspect();return {contents:[{uri:uri.href,mimeType:'application/json',text:JSON.stringify(parameterReference())}]}})
  server.registerPrompt('muxivra_workflow',{title:'Muxivra 媒体处理流程',description:'读取随应用发布的媒体处理指南'},async()=>{requireInspect();return {description:'使用实际工具与参数完成本地媒体处理',messages:[{role:'user' as const,content:{type:'text' as const,text:readSkill('workflow').markdown}}]}})
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  const writable = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  function register(name: string, description: string, inputSchema: z.ZodRawShape, handler: (args: any) => Promise<unknown>, annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean; idempotentHint?: boolean } = readOnly) {
    server.registerTool(name,{ description, inputSchema, annotations },async args => {
      try { return result(await handler(args)) }
      catch (error) { return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true } }
    })
  }
  register('list_skills','列出随应用发布的离线 Markdown 操作指南。连接后先读取 workflow，再按任务选择其他指南。',{},async()=>{requireInspect();return skillCatalog()})
  register('read_skill','读取内置 Markdown 指南。parameters 同时返回当前应用定义的完整参数/滤镜参考，优先据此构造请求。',{id:z.enum(skillIds)},async({id})=>{requireInspect();return readSkill(id)})
  register('inspect_media','检查授权目录内的本地媒体文件，返回轨道、编码、时长与尺寸。',{ path: pathSchema },async ({ path }) => service.inspect(path,'mcp'))
  register('get_engine_capabilities','查询当前 FFmpeg 的版本与真实编码器、解码器、滤镜。',{},async () => { if (!service.settings.mcp.allowInspect) throw new Error('查询权限未开启'); return service.engine })
  register('get_component_capabilities','读取本机 FFmpeg 编码器或滤镜的实际选项、范围、默认值与枚举，不查询互联网。',{kind:z.enum(['videoEncoder','audioEncoder','filter']),name:z.string().regex(/^[a-zA-Z0-9_]{1,80}$/)},async({kind,name})=>{requireInspect();return service.componentCapabilities(kind,name)})
  register('get_system_hardware','读取 CPU、GPU 型号、驱动、内存、系统及 FFmpeg 编解码能力。缺失或读取失败有明确状态；列出的硬件加速尚未实际验证。',{},async()=>service.systemHardware('mcp'))
  register('list_presets','列出可用预设及完整处理选项。',{},async () => { if (!service.settings.mcp.allowInspect) throw new Error('查询权限未开启'); return service.snapshot().presets })
  register('plan_transcode','验证结构化参数和路径，返回 FFmpeg 处理计划，不启动任务。',{ request: requestSchema },async ({ request }) => service.plan(request,'mcp'))
  register('submit_jobs','提交 1 至 500 个任务到共享队列，立即返回初始状态和任务 ID。尚未处理完成。requestKey 用于重试去重。',{ requests: z.array(requestSchema).min(1).max(500), requestKey: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional() },async ({ requests, requestKey }) => ({ jobs: await service.submit(requests,'mcp',requestKey), message: '任务已提交到后台队列，请查询 get_job 确认最终结果' }),{ ...writable, idempotentHint: false })
  register('get_job','查询授权范围内任务的状态、进度、错误或输出。',{ id: z.string().uuid() },async ({ id }) => service.job(id,'mcp'))
  register('list_jobs','列出授权目录内任务，未完成项按队列顺序，其余按最近提交排列，支持按状态过滤。',{ status: z.enum(['queued','running','paused','completed','failed','cancelled','interrupted']).optional(), limit: z.number().int().min(1).max(500).default(100) },async ({ status, limit }) => {const jobs=await service.jobs('mcp');return [...jobs.filter(j=>['queued','running','paused'].includes(j.status)),...jobs.filter(j=>!['queued','running','paused'].includes(j.status)).reverse()].filter(j=>!status||j.status===status).slice(0,limit)})
  register('cancel_job','明确取消授权范围内的任务，删除未完成的临时输出；运行任务的终止是异步的。',{ id: z.string().uuid() },async ({ id }) => service.cancel(id,'mcp'),{ ...writable, idempotentHint: true })
  register('pause_job','暂停授权任务。等待项暂不启动；运行项保留进度并占用当前并行名额。需要任务控制权限。',{id:z.string().uuid()},async({id})=>service.pause(id,'mcp'),{...writable,idempotentHint:true})
  register('resume_job','继续授权范围内已暂停的任务。需要任务控制权限。',{id:z.string().uuid()},async({id})=>service.resume(id,'mcp'),{...writable,idempotentHint:true})
  register('move_job','上移、下移、置顶或置底尚未开始的授权任务。仅相对授权范围内的等待项排序。需要查询及提交权限。',{id:z.string().uuid(),direction:z.enum(['up','down','first','last'])},async({id,direction})=>{await service.moveJob(id,direction,'mcp');return service.job(id,'mcp')},{...writable,idempotentHint:false})
  register('list_media_files','列出授权媒体目录的一层媒体文件，不递归扫描，不传输文件内容。',{ directory: pathSchema },async ({ directory }) => {
    if (!service.settings.mcp.allowInspect) throw new Error('查询权限未开启')
    const canonical = await realpath(localPath(directory))
    const roots = await Promise.all(service.settings.mcp.inputRoots.map(root => realpath(root)))
    if (!roots.some(root => isWithin(root,canonical)) || !(await stat(canonical)).isDirectory()) throw new Error('目录未获授权')
    const entries = await readdir(canonical,{ withFileTypes: true })
    return entries.filter(entry => entry.isFile() && /\.(mp4|mkv|mov|avi|webm|m4v|m4a|mp3|wav|flac|ogg|aac|ts|srt)$/i.test(extname(entry.name))).slice(0,500).map(entry => join(canonical,entry.name))
  })
  return server
}
export class McpHost {
  private http?: Server
  private transports = new Set<StreamableHTTPServerTransport>()
  constructor(readonly service: MediaService) {}
  async configure(settings: McpSettings): Promise<void> {
    if (!settings.enabled) { await this.stop(); return }
    if (this.http && this.service.mcpState.url === `http://127.0.0.1:${settings.port}/mcp`) return
    const http = createServer((request,response) => { void this.handle(request,response,settings.port).catch(() => { if (!response.headersSent) response.writeHead(500); response.end() }) })
    http.requestTimeout = 60000; http.headersTimeout = 15000
    await new Promise<void>((resolve,reject) => { const error = (e: Error) => reject(e); http.once('error',error); http.listen(settings.port,'127.0.0.1',() => { http.removeListener('error',error); resolve() }) })
    await this.stop()
    this.http = http
    http.on('error',error => { this.service.mcpState = { running: false, error: error.message }; this.service.emit('update') })
    this.service.mcpState = { running: true, url: `http://127.0.0.1:${settings.port}/mcp` }
  }
  private async handle(request: IncomingMessage, response: ServerResponse, port: number): Promise<void> {
    const deny = (code: number, message: string) => { response.writeHead(code,{ 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: message })) }
    if (!['127.0.0.1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) { deny(403,'仅允许本机连接'); return }
    if (![`127.0.0.1:${port}`,`localhost:${port}`].includes(request.headers.host ?? '')) { deny(403,'Host 不合法'); return }
    if (request.headers.origin && ![`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(request.headers.origin)) { deny(403,'Origin 未获授权'); return }
    if (request.url !== '/mcp') { deny(404,'不存在此接口'); return }
    const expected = Buffer.from(`Bearer ${this.service.settings.mcp.token}`), provided = Buffer.from(request.headers.authorization ?? '')
    if (!this.service.settings.mcp.enabled || expected.length !== provided.length || !timingSafeEqual(expected,provided)) { deny(401,'需要有效的 Bearer 连接凭据'); return }
    if (request.method !== 'POST') { response.setHeader('Allow','POST'); deny(405,'无会话模式仅支持 POST'); return }
    if (!(request.headers['content-type'] ?? '').startsWith('application/json')) { deny(415,'需要 application/json'); return }
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of request) { size += chunk.length; if (size > 1024*1024) { deny(413,'请求体超过 1 MB'); return }; chunks.push(chunk) }
    let body: unknown
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { deny(400,'JSON 无效'); return }
    const server = createMediaMcp(this.service)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    this.transports.add(transport)
    const cleanup = () => { this.transports.delete(transport); void transport.close(); void server.close() }
    response.once('close',cleanup)
    await server.connect(transport)
    await transport.handleRequest(request,response,body)
  }
  async stop(): Promise<void> {
    for (const transport of this.transports) await transport.close()
    this.transports.clear()
    const http = this.http; this.http = undefined
    if (http) { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())) }
    this.service.mcpState = { running: false }
  }
}
