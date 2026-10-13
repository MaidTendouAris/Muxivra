import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'

// Every updater response is supplied by the explicitly enabled main-process
// fixture. No network update is downloaded and no installer is executed.
await mkdir('.test-data', { recursive: true })
await mkdir('artifacts/qa', { recursive: true })
const root = await mkdtemp(resolve('.test-data', 'app-update-'))
const launch = () => electron.launch({
  executablePath: process.env.MUXIVRA_EXECUTABLE || electronPath,
  args: process.env.MUXIVRA_EXECUTABLE ? [] : ['.'],
  cwd: process.cwd(),
  env: { ...process.env, MUXIVRA_SMOKE: '1', MUXIVRA_UPDATE_TEST: '1', MUXIVRA_DATA_PATH: join(root, 'profile'), MUXIVRA_ENGINE_PATH: join(root, 'engines') },
  timeout: 60000
})
const report = { executable: process.env.MUXIVRA_EXECUTABLE || 'development build', errors: [], checks: [] }
let desktop = await launch(), page, closed = false
const fixture = request => desktop.evaluate(async (_electron, value) => {
  if (typeof globalThis.__muxivraUpdateTest !== 'function') throw new Error('Safe updater test fixture is unavailable')
  return globalThis.__muxivraUpdateTest(value)
}, request)
const state = () => page.evaluate(() => window.muxivra.appUpdateState())
async function poll(read, check, description, timeout = 15000) {
  const deadline = Date.now() + timeout
  let value
  while (Date.now() < deadline) {
    value = await read()
    if (check(value)) return value
    await page.waitForTimeout(30)
  }
  throw new Error(`${description}: ${JSON.stringify(value)}`)
}
const phase = desired => poll(state, current => current.phase === desired, `Updater did not reach ${desired}`)

try {
  page = await desktop.firstWindow()
  page.on('pageerror', error => report.errors.push(error.message))
  report.appVersion = await desktop.evaluate(({ app }) => app.getVersion())
  await page.getByRole('heading', { name: '单文件', exact: true }).waitFor({ timeout: 60000 })
  await phase('available')
  const expectedVersion = (await state()).version
  assert.ok(expectedVersion && expectedVersion !== report.appVersion)
  report.updateVersion = expectedVersion
  assert.equal((await fixture()).checks, 1, 'Application must check once at startup')
  const notice = page.locator('.app-update-notice')
  await notice.waitFor()
  assert.ok((await notice.innerText()).includes(expectedVersion))
  await notice.getByRole('button', { name: '查看更新', exact: true }).click()
  const card = page.locator('.app-update-card')
  await card.waitFor()
  assert.ok((await card.innerText()).includes(report.appVersion))
  assert.equal((await fixture()).checks, 1, 'Opening settings must not start another automatic check')
  await page.locator('.navigation').getByRole('button', { name: '单文件', exact: true }).click()
  await page.locator('.navigation').getByRole('button', { name: '设置', exact: true }).click()
  assert.equal((await fixture()).checks, 1)
  report.startupCheckOnceAndGlobalNotice = true

  await fixture({ mode: 'current', delayMs: 450 })
  await card.getByRole('button', { name: '检查更新', exact: true }).click()
  await phase('checking')
  assert.equal(await card.getByRole('button', { name: '正在检查…', exact: true }).isDisabled(), true)
  assert.equal(await card.getByRole('button', { name: '正在检查…', exact: true }).locator('.spin').count() > 0, true)
  await phase('current')
  await card.getByText('已是最新版本', { exact: true }).waitFor()
  report.manualCheckHasBusyFeedback = true

  await fixture({ mode: 'error', delayMs: 450 })
  await card.getByRole('button', { name: '检查更新', exact: true }).click()
  await phase('error')
  await card.locator('.app-update-error').waitFor()
  assert.ok((await card.locator('.app-update-error').innerText()).length > 0)
  assert.equal(await card.getByRole('button', { name: '检查更新', exact: true }).isEnabled(), true)
  await fixture({ mode: 'available', delayMs: 450 })
  await card.getByRole('button', { name: '检查更新', exact: true }).click()
  await phase('available')
  assert.equal((await state()).error, undefined)
  report.failedCheckCanRetry = true

  await fixture({ mode: 'download-error', delayMs: 700 })
  await card.getByRole('button', { name: '下载更新', exact: true }).click()
  await phase('downloading')
  await card.locator('.app-update-progress').waitFor()
  assert.equal(await card.getByRole('button', { name: '检查更新', exact: true }).isDisabled(), true)
  const downloading = await poll(state, current => current.phase === 'downloading' && current.percent > 0, 'Download progress never increased')
  report.progress = { percent: downloading.percent, transferred: downloading.transferred, total: downloading.total }
  assert.ok(downloading.total > 0 && downloading.transferred > 0)
  await page.screenshot({ path: 'artifacts/qa/app-update-downloading.png', fullPage: true })
  // Page navigation and settings editing must remain usable during downloads.
  await page.locator('.navigation').getByRole('button', { name: '任务', exact: true }).click()
  await page.getByRole('heading', { name: '任务', exact: true }).waitFor()
  await page.locator('.navigation').getByRole('button', { name: '设置', exact: true }).click()
  await phase('error')
  await card.getByRole('button', { name: '重试下载', exact: true }).waitFor()
  assert.equal((await fixture()).installs, 0)
  await fixture({ mode: 'available', delayMs: 700 })
  await card.getByRole('button', { name: '重试下载', exact: true }).click()
  await phase('downloaded')
  assert.equal((await state()).percent, 100)
  assert.equal((await fixture()).downloads, 2)
  assert.equal((await fixture()).installs, 0, 'Downloaded updates must wait for explicit restart approval')
  report.downloadFeedbackRetryAndNoImplicitInstall = true

  await card.getByRole('button', { name: '重启并安装', exact: true }).click()
  const exitDialog = page.getByRole('dialog', { name: '安装应用更新', exact: true })
  await exitDialog.waitFor()
  assert.ok((await exitDialog.innerText()).includes(expectedVersion))
  assert.ok((await exitDialog.innerText()).includes('没有未完成任务'))
  await exitDialog.getByRole('button', { name: '继续运行', exact: true }).click()
  await exitDialog.waitFor({ state: 'hidden' })
  assert.equal((await fixture()).installs, 0)
  assert.equal((await state()).phase, 'downloaded')
  report.restartUsesCustomDialogAndCancellationKeepsAppRunning = true

  // A pending Settings draft cannot be silently discarded during restart.
  const saved = await page.evaluate(() => window.muxivra.snapshot())
  await page.getByLabel('端口', { exact: true }).fill(String(saved.settings.mcp.port + 1))
  await card.getByRole('button', { name: '重启并安装', exact: true }).click()
  const draftDialog = page.getByRole('dialog', { name: '应用设置更改？', exact: true })
  await draftDialog.waitFor()
  await draftDialog.getByRole('button', { name: '继续编辑', exact: true }).click()
  assert.equal(await exitDialog.count(), 0)
  assert.equal(await page.getByLabel('端口', { exact: true }).inputValue(), String(saved.settings.mcp.port + 1))
  assert.equal((await fixture()).installs, 0)
  await card.getByRole('button', { name: '重启并安装', exact: true }).click()
  await draftDialog.getByRole('button', { name: '应用并继续', exact: true }).click()
  await exitDialog.waitFor()
  assert.equal((await page.evaluate(() => window.muxivra.snapshot())).settings.mcp.port, saved.settings.mcp.port + 1)
  await exitDialog.getByRole('button', { name: '继续运行', exact: true }).click()
  report.unsavedSettingsMustBeResolvedBeforeRestart = true

  for (const theme of ['light', 'dark']) {
    const snapshot = await page.evaluate(() => window.muxivra.snapshot())
    await page.evaluate(settings => window.muxivra.saveSettings(settings), { ...snapshot.settings, theme })
    await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme)
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 720))
    await card.scrollIntoViewIfNeeded()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
    const geometry = await card.evaluate(element => { const { left, right, width } = element.getBoundingClientRect(); return { left, right, width, windowWidth: innerWidth } })
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.windowWidth)
    await card.getByRole('button', { name: '重启并安装', exact: true }).click()
    await exitDialog.waitFor()
    await page.screenshot({ path: `artifacts/qa/app-update-${theme}-minimum.png` })
    await exitDialog.getByRole('button', { name: '继续运行', exact: true }).click()
  }
  report.minimumWindowAndThemes = true

  // Prove the real renderer shutdown saves a pending ASS edit before invoking
  // the safe fixture's quitAndInstall. All source files are temporary fixtures.
  const audio = join(root, 'update-subtitle.wav'), project = join(root, 'update-subtitle.ass')
  await promisify(execFile)('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', audio], { windowsHide: true })
  await page.locator('.navigation').getByRole('button', { name: '字幕编辑', exact: true }).click()
  await desktop.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, audio)
  await page.getByRole('button', { name: '载入媒体', exact: true }).click()
  await poll(() => page.evaluate(() => window.muxivra.getSession()), document => document?.mediaPath === audio, 'Subtitle project was not opened')
  await page.getByRole('button', { name: '新增字幕', exact: true }).click()
  await page.getByLabel('字幕文本', { exact: true }).fill('更新前保存的字幕')
  await page.waitForTimeout(250)
  const subtitleGeometry = await page.evaluate(() => {
    const box = selector => { const { top, bottom, left, right } = document.querySelector(selector).getBoundingClientRect(); return { top, bottom, left, right } }
    return { height: innerHeight, preview: box('.subtitle-preview-card'), list: box('.subtitle-list-card'), editor: box('.subtitle-edit-card'), footer: box('.subtitle-project-card'), banner: box('.app-update-notice') }
  })
  for (const box of [subtitleGeometry.preview, subtitleGeometry.list, subtitleGeometry.editor, subtitleGeometry.footer]) assert.ok(box.top >= 0 && box.bottom <= subtitleGeometry.height, `Update banner overlaps subtitle workspace: ${JSON.stringify(subtitleGeometry)}`)
  assert.ok(subtitleGeometry.preview.top >= subtitleGeometry.banner.bottom)
  assert.ok(subtitleGeometry.footer.top >= subtitleGeometry.list.bottom - 2)
  report.updateBannerRetainsSubtitleWorkspace = subtitleGeometry
  await page.screenshot({ path: 'artifacts/qa/app-update-subtitle-minimum.png' })
  // Use the global update banner to restart from the currently active editor.
  await fixture({ mode: 'install-error', delayMs: 300 })
  await notice.getByRole('button', { name: '重启并安装', exact: true }).click()
  await exitDialog.waitFor()
  await exitDialog.getByRole('button', { name: '重启并安装', exact: true }).click()
  await poll(() => page.evaluate(() => window.muxivra.exitState()), value => value?.runtimeStopped && !!value.error && value.phase === 'confirm', 'Installer launch error did not reach the custom exit dialog')
  await phase('downloaded')
  await exitDialog.getByRole('button', { name: '重试安装', exact: true }).waitFor()
  assert.equal(await exitDialog.getByRole('button', { name: '继续运行', exact: true }).count(), 0)
  assert.equal(await exitDialog.getByRole('button', { name: '关闭', exact: true }).isDisabled(), true)
  await page.keyboard.press('Escape')
  assert.equal(await exitDialog.isVisible(), true)
  assert.equal(await page.evaluate(() => window.muxivra.respondToExit(false).then(() => false, () => true)), true)
  assert.equal((await fixture()).installs, 1)
  assert.ok((await readFile(project, 'utf8')).includes('更新前保存的字幕'))
  report.failedInstallerLaunchDoesNotQuitOrResumeStoppedServices = true
  await page.screenshot({ path: 'artifacts/qa/app-update-install-error.png' })
  await fixture({ mode: 'available', delayMs: 300 })
  const exited = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Safe update restart did not close the isolated app')), 15000)
    desktop.process().once('exit', code => { clearTimeout(timeout); resolve(code) })
  })
  await exitDialog.getByRole('button', { name: '重试安装', exact: true }).click()
  await exited
  closed = true
  assert.ok((await readFile(project, 'utf8')).includes('更新前保存的字幕'))
  report.safeFixtureRestartSavedPendingSubtitle = true
  assert.deepEqual(report.errors, [])
  await writeFile('artifacts/qa/app-update-smoke.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  if (!closed) await desktop.close().catch(() => {})
  const local = relative(resolve('.test-data'), root)
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error('Refusing cleanup outside .test-data')
  await rm(root, { recursive: true, force: true })
}
