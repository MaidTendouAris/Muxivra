import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const batch = JSON.parse(await readFile(resolve('artifacts/qa/mcp-music-100.json'), 'utf8'))
const output = join(dirname(batch.outputDirectory), basename(batch.outputDirectory) + '-control')
const reportPath = resolve('artifacts/qa/mcp-running-cancel.json')
const token = process.env.MUXIVRA_MCP_TOKEN
assert.match(token ?? '', /^[a-f0-9]{64}$/)
const client = new Client({ name: 'muxivra-cancellation-acceptance', version: '1.0.0' })
const report = { startedAt: new Date().toISOString(), outputDirectory: output, checks: [], errors: [] }
const delay = ms => new Promise(r => setTimeout(r, ms))
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args })
  const text = r.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
  if (r.isError) throw new Error(name + ': ' + text)
  return JSON.parse(text)
}
const check = (name, passed) => { report.checks.push({ name, passed }); assert.ok(passed, name) }
try {
  await mkdir(output, { recursive: true })
  assert.equal((await readdir(output)).length, 0, 'Use an empty diagnostic directory')
  await client.connect(new StreamableHTTPClientTransport(new URL(batch.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  const request = { ...batch.requests[0], outputPath: join(output, 'running-cancel.m4a') }
  await call('plan_transcode', { request })
  const job = (await call('submit_jobs', { requests: [request], requestKey: 'mcp-running-cancel-' + Date.now() })).jobs[0]
  report.jobId = job.id
  if (job.status === 'queued') await call('move_job', { id: job.id, direction: 'first' })
  let state
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    state = await call('get_job', { id: job.id })
    if (state.status === 'running' && state.processedMs > 0) break
    if (['completed', 'failed', 'cancelled'].includes(state.status)) break
    await delay(100)
  }
  check('diagnostic task is actually encoding', state.status === 'running' && state.processedMs > 0)
  report.processedBeforeCancellationMs = state.processedMs
  const cancelling = await call('cancel_job', { id: job.id })
  report.initialCancellation = { status: cancelling.status, cancelling: cancelling.cancelling }
  check('running cancellation returns pending feedback', cancelling.cancelling === true)
  const cleanupDeadline = Date.now() + 10000
  while (Date.now() < cleanupDeadline) {
    state = await call('get_job', { id: job.id })
    if (state.status === 'cancelled' && !state.cancelling) break
    await delay(100)
  }
  check('running cancellation reaches final cancelled state', state.status === 'cancelled' && !state.cancelling)
  check('repeat cancellation is idempotent', (await call('cancel_job', { id: job.id })).status === 'cancelled')
  check('incomplete output and temporary files are removed', (await readdir(output)).length === 0)
  report.finalStatus = state.status
  report.elapsedMs = state.elapsedMs
  report.passed = true
} catch (error) {
  report.passed = false
  report.errors.push(String(error.message).split(token).join('[redacted]'))
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  await client.close().catch(() => {})
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, errors: report.errors, reportPath }))
}
