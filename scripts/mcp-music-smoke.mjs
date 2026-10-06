import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { basename, dirname, extname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const arg = key => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1] }
const input = resolve(arg('--input') ?? 'example_media')
const output = resolve(arg('--output') ?? (() => { throw new Error('--output is required') })())
const reportPath = resolve(arg('--report') ?? 'artifacts/qa/mcp-music-100.json')
const expected = Number(arg('--expected') ?? 100)
const url = arg('--url') ?? 'http://127.0.0.1:19480/mcp'
const token = process.env.MUXIVRA_MCP_TOKEN
assert.match(token ?? '', /^[a-f0-9]{64}$/, 'Set MUXIVRA_MCP_TOKEN in the client process environment')
const config = JSON.parse(await readFile(join(process.env.APPDATA, 'Muxivra', 'config.json'), 'utf8'))
const engine = { ffmpegPath: config.engine?.ffmpegPath, ffprobePath: config.engine?.ffprobePath }
assert.ok(engine.ffmpegPath && engine.ffprobePath, 'An engine is required for independent output verification')
const resume = process.argv.includes('--resume')
let started = Date.now()
const report = { startedAt: new Date().toISOString(), url, inputDirectory: input, outputDirectory: output,
  expected, bitrateKbps: 192, checks: [], calls: {}, inputs: [], jobs: [], outputs: [], errors: [] }
if (resume) {
  Object.assign(report, JSON.parse(await readFile(reportPath, 'utf8')))
  assert.equal(report.inputDirectory, input)
  assert.equal(report.outputDirectory, output)
  assert.equal(report.jobs.length, expected, 'Resume requires a recorded batch')
  started = Date.parse(report.startedAt)
}
let client
let requests, submittedAt, activeId
const delay = ms => new Promise(r => setTimeout(r, ms))
const checkpoint = async () => { await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n') }
const check = (name, condition, details = {}) => { report.checks.push({ name, passed: Boolean(condition), ...details }); assert.ok(condition, name) }
const log = (stage, details = {}) => console.log(JSON.stringify({ stage, elapsedSeconds: Math.round((Date.now() - started) / 1000), ...details }))
const connect = async () => {
  client = new Client({ name: 'muxivra-music-acceptance', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
}
const call = async (name, args = {}, allowError = false) => {
  const time = Date.now()
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 })
  const count = report.calls[name] ??= { count: 0, totalMs: 0, maxMs: 0, errors: 0 }
  const elapsed = Date.now() - time
  count.count++; count.totalMs += elapsed; count.maxMs = Math.max(count.maxMs, elapsed)
  const text = response.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
  if (response.isError) { count.errors++; if (allowError) return { error: text }; throw new Error(`${name}: ${text}`) }
  return JSON.parse(text)
}
const sha = path => new Promise((resolveHash, reject) => {
  const hash = createHash('sha256'), stream = createReadStream(path)
  stream.on('error', reject); stream.on('data', c => hash.update(c)); stream.on('end', () => resolveHash(hash.digest('hex')))
})
const mapLimit = async (items, concurrency, fn) => {
  const result = new Array(items.length); let next = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < items.length) { const i = next++; result[i] = await fn(items[i], i) }
  }))
  return result
}
const command = (exe, args) => new Promise((resolveResult, reject) => {
  const child = spawn(exe, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr = (stderr + c).slice(-16000))
  child.on('error', reject); child.on('close', code => code === 0 ? resolveResult({ stdout, stderr }) : reject(new Error(`${basename(exe)} exited ${code}: ${stderr}`)))
})
const probe = async path => JSON.parse((await command(engine.ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path])).stdout)
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

try {
  await connect()
  report.server = client.getServerVersion()
  const tools = (await client.listTools()).tools.map(t => t.name)
  report.tools = tools
  if (!resume) {
  check('discover media tools', ['inspect_media','get_engine_capabilities','get_system_hardware','list_presets','plan_transcode','submit_jobs','get_job','list_jobs','cancel_job','pause_job','resume_job','move_job','list_media_files'].every(name=>tools.includes(name)))
  check('hardware included in server instructions', (client.getInstructions() ?? '').includes('hardware'))
  const resources = (await client.listResources()).resources.map(r => r.uri)
  check('discover hardware resource', resources.includes('muxivra://system/hardware'))
  const hardwareResource = await client.readResource({ uri: 'muxivra://system/hardware' })
  check('read hardware resource', hardwareResource.contents.some(c => c.text && JSON.parse(c.text).hardware))
  const unauthenticated = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  check('reject missing bearer credential', unauthenticated.status === 401, { httpStatus: unauthenticated.status })
  report.capabilities = await call('get_engine_capabilities')
  report.hardware = await call('get_system_hardware')
  if(tools.includes('list_skills')) {
    const guides=await call('list_skills')
    for(const guide of guides)check(`read bundled skill ${guide.id}`,Boolean((await call('read_skill',{id:guide.id})).markdown))
  }
  if(tools.includes('get_component_capabilities'))check('read real AAC encoder options',Boolean((await call('get_component_capabilities',{kind:'audioEncoder',name:'aac'})).options.length))
  check('AAC encoder available', report.capabilities.encoders.includes('aac'))
  const presets = await call('list_presets')
  report.preset = presets.find(p => p.id === 'aac')
  check('AAC M4A preset available', report.preset?.options.container === 'm4a' && report.preset.options.audio === 'aac')
  const files = (await call('list_media_files', { directory: input })).filter(p => extname(p).toLowerCase() === '.mp3').sort()
  check('discover exactly 100 MP3 inputs', files.length === expected, { count: files.length })
  const existing = await readdir(output).catch(e => { if (e.code !== 'ENOENT') throw e; return [] })
  check('use an empty output directory', existing.length === 0)
  await mkdir(output, { recursive: true })
  const outside = await call('list_media_files', { directory: resolve('src') }, true)
  check('reject unapproved input directory', Boolean(outside.error), { message: outside.error })
  report.inputs = await mapLimit(files, 3, async (path, i) => {
    const media = await call('inspect_media', { path })
    assert.equal(media.streams.filter(s => s.type === 'audio').length, 1, `${basename(path)}: exactly one audio stream required`)
    if ((i + 1) % 20 === 0) log('inspected', { count: i + 1, total: expected })
    return { path, sha256: await sha(path), media }
  })
  requests = files.map(inputPath => ({ inputPath, outputPath: join(output, basename(inputPath, extname(inputPath)) + '.m4a'),
    options: { ...report.preset.options, presetId: 'aac', subtitles: 'none', conflict: 'reject', audioBitrate: 192 } }))
  report.requests = requests
  report.inputDurationSeconds = report.inputs.reduce((sum, i) => sum + i.media.durationMs / 1000, 0)
  await checkpoint()
  for (let i = 0; i < requests.length; i++) {
    const plan = await call('plan_transcode', { request: requests[i] })
    assert.equal(plan.outputPath, requests[i].outputPath)
    assert.equal(plan.options.audio, 'aac')
    assert.ok(plan.args.includes('-vn') && plan.args.includes('192k') && plan.args.includes('ipod'))
    if (i === 0) report.examplePlan = plan
  }
  check('plan all 100 M4A AAC encodes', true)
  const deniedOutput = await call('plan_transcode', { request: { ...requests[0], outputPath: resolve('artifacts/qa/not-authorized.m4a') } }, true)
  check('reject unapproved output directory', Boolean(deniedOutput.error), { message: deniedOutput.error })
  const beforeAtomic = await call('list_jobs', { limit: 500 })
  const invalid = await call('submit_jobs', { requests: [requests[0], { ...requests[1], options: { ...requests[1].options, audio: 'nonexistent_aac_encoder' } }], requestKey: 'mcp-music-invalid-' + started }, true)
  const afterAtomic = await call('list_jobs', { limit: 500 })
  check('invalid batch is rejected atomically', Boolean(invalid.error) && afterAtomic.length === beforeAtomic.length, { message: invalid.error })
  report.requestKey = 'mcp-music-100-' + started
  log('submitting', { count: requests.length, audioDurationSeconds: report.inputDurationSeconds })
  submittedAt = Date.now()
  report.submittedAt = new Date(submittedAt).toISOString()
  const submission = await call('submit_jobs', { requests, requestKey: report.requestKey })
  report.submissionMs = Date.now() - submittedAt
  report.originalJobIds = submission.jobs.map(j => j.id)
  report.jobs = submission.jobs.map(j => ({ id: j.id, inputPath: j.plan.input.path, outputPath: j.plan.outputPath, status: j.status }))
  check('submit all 100 through MCP', report.jobs.length === expected && report.jobs.every(j => j.status === 'queued'))
  await checkpoint()
  const replay = await call('submit_jobs', { requests, requestKey: report.requestKey })
  check('duplicate submission returns identical job IDs', JSON.stringify(replay.jobs.map(j => j.id)) === JSON.stringify(report.originalJobIds))
  const conflict = await call('submit_jobs', { requests: [{ ...requests[0], options: { ...requests[0].options, audioBitrate: 128 } }], requestKey: report.requestKey }, true)
  check('reject different parameters for existing request key', Boolean(conflict.error), { message: conflict.error })

  // Controls act only on this batch. The cancelled attempt is replaced so all 100 outputs are delivered.
  const waiting = report.jobs.at(-1)
  const held = await call('pause_job', { id: waiting.id })
  check('pause queued task', held.status === 'paused' && held.pausedFrom === 'queued')
  await call('move_job', { id: waiting.id, direction: 'first' })
  const ordered = await call('list_jobs', { limit: 500 })
  check('move held task to first waiting position', ordered.filter(j => j.status === 'queued' || j.status === 'paused' && j.pausedFrom === 'queued')[0]?.id === waiting.id)
  await call('move_job', { id: waiting.id, direction: 'last' })
  const restored = await call('resume_job', { id: waiting.id })
  check('resume queued task', restored.status === 'queued')
  const active = (await call('list_jobs', { status: 'running', limit: 500 })).find(j => report.originalJobIds.includes(j.id))
  assert.ok(active, 'A batch task is running for pause verification')
  activeId = active.id
  report.controlActiveId = activeId
  await delay(300)
  const paused = await call('pause_job', { id: active.id })
  check('pause actual encoding process', paused.status === 'paused' && paused.pausedFrom === 'running')
  await delay(750)
  const whilePaused = await call('get_job', { id: active.id })
  check('paused process makes no progress and freezes active elapsed time', whilePaused.processedMs === paused.processedMs && Math.abs(whilePaused.elapsedMs - paused.elapsedMs) < 100)
  const resumed = await call('resume_job', { id: active.id })
  check('resume actual encoding process', resumed.status === 'running')
  const cancelled = await call('cancel_job', { id: waiting.id })
  check('cancel queued task', cancelled.status === 'cancelled')
  report.cancelledAttempt = { id: waiting.id, status: cancelled.status, inputPath: waiting.inputPath, outputPath: waiting.outputPath }
  check('cancelled task publishes no output', !(await stat(waiting.outputPath).catch(() => undefined)))
  const replacement = (await call('submit_jobs', { requests: [requests.at(-1)], requestKey: report.requestKey + '-replacement' })).jobs[0]
  check('resubmit cancelled song for final 100 outputs', replacement.id !== waiting.id)
  report.jobs[report.jobs.length - 1].id = replacement.id
  } else {
    requests = report.requests
    activeId = report.controlActiveId ?? report.originalJobIds[0]
    const first = await call('get_job', { id: report.originalJobIds[0] })
    submittedAt = report.submittedAt ? Date.parse(report.submittedAt) : Date.parse(first.createdAt)
    const replacement = await call('get_job', { id: report.jobs.at(-1).id })
    const oldHarnessError = 'resubmit cancelled song for final 100 outputs'
    if (report.errors.includes(oldHarnessError)) {
      report.harnessIssues = [{ message: 'The cancelled job record was mutated before comparing its old ID with the replacement ID. The test assertion was corrected; no server task failed.', corrected: true }]
      report.errors = report.errors.filter(e => e !== oldHarnessError)
      report.checks = report.checks.filter(c => !(c.name === oldHarnessError && !c.passed))
    }
    check('resubmit cancelled song for final 100 outputs', replacement.id !== report.cancelledAttempt.id && replacement.plan.input.path === requests.at(-1).inputPath && replacement.plan.outputPath === requests.at(-1).outputPath)
    log('resumed-existing-batch', { jobs: report.jobs.length })
  }
  await checkpoint()
  await client.close()
  await delay(750)
  await connect()
  const reconnected = await call('get_job', { id: activeId })
  check('task survives disconnect and reconnect', ['running', 'completed'].includes(reconnected.status))
  const replayAfterReconnect = await call('submit_jobs', { requests, requestKey: report.requestKey })
  check('idempotency survives client reconnect', JSON.stringify(replayAfterReconnect.jobs.map(j => j.id)) === JSON.stringify(report.originalJobIds))
  log('controls-passed', { toolsUsed: Object.keys(report.calls).length, jobs: expected, cancelledAttempts: 1 })

  const targetIds = new Set(report.jobs.map(j => j.id))
  const deadline = Date.now() + 60 * 60 * 1000
  let lastCompleted = -1, latest = []
  while (Date.now() < deadline) {
    latest = (await call('list_jobs', { limit: 500 })).filter(j => targetIds.has(j.id))
    assert.equal(latest.length, expected, 'All batch jobs remain queryable')
    const failed = latest.filter(j => ['failed', 'cancelled', 'interrupted'].includes(j.status))
    if (failed.length) throw new Error('Batch job failure: ' + JSON.stringify(failed.map(j => ({ id: j.id, file: j.plan.input.name, status: j.status, error: j.error }))))
    const completed = latest.filter(j => j.status === 'completed').length
    if (completed !== lastCompleted) {
      const activeJob = latest.find(j => j.status === 'running')
      log('encoding', { completed, total: expected, current: activeJob?.plan.input.name, progress: activeJob?.progress, speed: activeJob?.speed, remainingSeconds: activeJob?.estimatedRemainingMs / 1000 })
      lastCompleted = completed
      report.progress = { completed, total: expected, lastUpdate: new Date().toISOString() }
      await checkpoint()
    }
    if (latest.every(j => terminal.has(j.status))) break
    await delay(3000)
  }
  check('all 100 tasks completed', latest.length === expected && latest.every(j => j.status === 'completed'))
  report.encodingFinishedAt = new Date().toISOString()
  report.encodingWallMs = Date.now() - submittedAt
  report.jobs = latest.map(j => ({ id: j.id, inputPath: j.plan.input.path, outputPath: j.plan.outputPath, source: j.source, status: j.status, elapsedMs: j.elapsedMs,
    outputSize: j.outputSize, processedMs: j.processedMs, speed: j.speed, estimateBasis: j.estimateBasis, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt, logPath: j.logPath }))
  const completed = await call('list_jobs', { status: 'completed', limit: 500 })
  check('completed-status filtering includes all final tasks', [...targetIds].every(id => completed.some(j => j.id === id)))
  const queried = await call('get_job', { id: report.jobs[0].id })
  check('final job exposes completion and output size', queried.status === 'completed' && queried.progress === 100 && queried.outputSize > 0)
  const existingOutput = await call('plan_transcode', { request: requests[0] }, true)
  check('reject overwriting existing output', Boolean(existingOutput.error), { message: existingOutput.error })
  const outputMedia = await call('inspect_media', { path: requests[0].outputPath })
  check('inspect generated AAC through MCP', outputMedia.streams.some(s => s.type === 'audio' && s.codec === 'aac'))
  const outputFiles = await call('list_media_files', { directory: output })
  check('MCP can discover all 100 output files', outputFiles.length === expected)
  check('all discovered tools exercised', tools.every(t => report.calls[t]?.count > 0))
  await checkpoint()

  log('verifying', { count: expected, checks: 'ffprobe, full audio decoding, input SHA-256, tags and duration' })
  let verified = 0
  report.outputs = await mapLimit(requests, 2, async (request, i) => {
    const [original, encoded] = await Promise.all([probe(request.inputPath), probe(request.outputPath)])
    const audio = encoded.streams.filter(s => s.codec_type === 'audio')
    const originalAudio = original.streams.find(s => s.codec_type === 'audio')
    assert.equal(audio.length, 1, 'Exactly one output audio stream')
    assert.equal(audio[0].codec_name, 'aac', 'AAC encoded output')
    assert.equal(audio[0].profile, 'LC', 'AAC LC profile')
    assert.ok(encoded.format.format_name.includes('m4a'), 'M4A container')
    assert.equal(encoded.streams.filter(s => s.codec_type === 'video').length, 0, 'No video output')
    assert.equal(audio[0].channels, originalAudio.channels, 'Channel count preserved')
    assert.equal(audio[0].sample_rate, originalAudio.sample_rate, 'Sample rate preserved')
    const deltaSeconds = Math.abs(Number(encoded.format.duration) - Number(original.format.duration))
    assert.ok(deltaSeconds <= 0.15, `${basename(request.inputPath)}: duration difference ${deltaSeconds.toFixed(3)} s`)
    const tags = {}
    for (const key of ['title', 'artist', 'album', 'album_artist', 'genre', 'date', 'track', 'disc']) {
      if (original.format.tags?.[key] !== undefined) {
        assert.equal(encoded.format.tags?.[key], original.format.tags[key], `${key} metadata preserved`)
        tags[key] = encoded.format.tags[key]
      }
    }
    const decoding = await command(engine.ffmpegPath, ['-v', 'error', '-xerror', '-nostdin', '-i', request.outputPath, '-map', '0:a:0', '-f', 'null', '-'])
    assert.equal(decoding.stderr.trim(), '', 'Full output decodes without errors')
    const inputUnchanged = await sha(request.inputPath) === report.inputs[i].sha256
    assert.ok(inputUnchanged, 'Original input SHA-256 unchanged')
    const file = await stat(request.outputPath)
    verified++
    if (verified % 10 === 0) log('verified', { count: verified, total: expected })
    return { path: request.outputPath, size: file.size, sha256: await sha(request.outputPath), codec: audio[0].codec_name, profile: audio[0].profile,
      bitrate: Number(audio[0].bit_rate), sampleRate: Number(audio[0].sample_rate), channels: audio[0].channels, durationSeconds: Number(encoded.format.duration),
      durationDeltaSeconds: deltaSeconds, inputUnchanged, fullDecodePassed: true, tags }
  })
  const finalFiles = await readdir(output)
  check('exactly 100 M4A files and no temporary residue', finalFiles.length === expected && finalFiles.every(f => extname(f).toLowerCase() === '.m4a'))
  check('all 100 outputs independently validated', report.outputs.length === expected && report.outputs.every(o => o.inputUnchanged && o.fullDecodePassed))
  report.totalOutputBytes = report.outputs.reduce((sum, o) => sum + o.size, 0)
  report.finishedAt = new Date().toISOString()
  report.totalWallMs = Date.now() - started
  report.passed = true
  await checkpoint()
  log('complete', { passed: true, files: expected, tools: tools.length, outputDirectory: output, reportPath, encodingWallSeconds: Math.round(report.encodingWallMs / 1000) })
} catch (error) {
  report.passed = false
  report.errors.push(String(error.message).split(token).join('[redacted]'))
  report.totalWallMs = Date.now() - started
  await checkpoint()
  console.error(report.errors.at(-1))
  process.exitCode = 1
} finally { await client?.close().catch(() => {}) }
