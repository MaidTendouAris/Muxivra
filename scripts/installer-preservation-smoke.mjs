import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, readdir, access } from 'node:fs/promises'
import { join, resolve, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'

// This harness has no registry keys, shortcuts or real application payload.
// It only invokes NSIS files that it generates under its own test directory.
const run = promisify(execFile)
const require = createRequire(import.meta.url)
const { generateManifest } = require('./prepare-installer-manifest.cjs')
const project = resolve('.'), data = join(project, '.test-data')
await mkdir(data, { recursive: true })
const root = await mkdtemp(join(data, 'installer-preservation-'))
const compiler = process.env.MUXIVRA_NSIS_PATH || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache', 'nsis', 'nsis-3.0.4.1', 'Bin', 'makensis.exe')
await access(compiler)
const escape = value => value.replaceAll('$', '$$').replaceAll('/', '\\').replaceAll('"', '$\\"')
const managed = { 'Muxivra.exe': 'application', 'LICENSE': 'license', 'resources/app.asar': 'archive', 'resources/mpv/mpv.exe': 'player', 'zz-busy.dll': 'locked runtime' }
const lateManaged = { 'resources/app-update.yml': 'late update metadata', 'resources/elevate.exe': 'late elevation helper', 'uninstallerIcon.ico': 'late uninstaller icon' }
const preserved = { 'outputs/音乐.m4a': 'output media', 'outputs/nested/subtitle.ass': 'output subtitle', 'source music.mp3': 'source media', 'resources/user-note.ass': 'unknown resource' }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const suites = []
async function seed(app, contents) {
  for (const [name, value] of Object.entries(contents)) { const file = join(app, name); await mkdir(resolve(file, '..'), { recursive: true }); await writeFile(file, value) }
}
async function hashes(app, contents) { return Object.fromEntries(await Promise.all(Object.keys(contents).map(async name => [name, digest(await readFile(join(app, name)))]))) }
async function compile(file) { await run(compiler, ['/V2', file], { cwd: project, windowsHide: true, timeout: 30000 }) }
async function launch(file, args = []) {
  try { await run(file, args, { cwd: root, windowsHide: true, timeout: 30000 }); return 0 }
  catch (error) { if (typeof error.code === 'number') return error.code; throw error }
}
async function removalFixture(name, withBusyFile = false) {
  const fixture = join(root, name), app = join(fixture, 'app'), manifest = join(fixture, 'managed.nsh'), installer = join(fixture, 'fixture.exe'), uninstaller = join(app, 'Uninstall fixture.exe')
  await seed(app, managed); await generateManifest(app, manifest)
  // Match electron-builder: these arrive only after the hook has recorded files.
  await seed(app, lateManaged)
  const allManaged = { ...managed, ...lateManaged }
  await seed(app, preserved); await mkdir(join(app, 'outputs/empty'), { recursive: true })
  const before = await hashes(app, preserved), beforeManaged = await hashes(app, allManaged)
  const nsi = join(fixture, 'fixture.nsi')
  await writeFile(nsi, `Unicode true\nRequestExecutionLevel user\nSilentInstall silent\nSilentUnInstall silent\n!include LogicLib.nsh\n!include FileFunc.nsh\n!define BUILD_UNINSTALLER\n!define UNINSTALL_FILENAME "Uninstall fixture.exe"\n!define MUXIVRA_MANAGED_FILES_INCLUDE "${escape(manifest)}"\n!include "${escape(join(project, 'resources/installer.nsh'))}"\n!insertmacro customHeader\nName "Muxivra isolated removal test"\nOutFile "${escape(installer)}"\nInstallDir "${escape(app)}"\nSection\nWriteUninstaller "${escape(uninstaller)}"\nSectionEnd\nSection "Uninstall"\n!insertmacro customRemoveFiles\nSectionEnd\n`, 'utf8')
  await compile(nsi); assert.equal(await launch(installer, ['/S']), 0)
  if (withBusyFile) {
    // A separate PowerShell process holds one package file without sharing.
    const ready = join(fixture, 'locked.ready'), release = join(fixture, 'unlock.ready')
    const lockScript = join(fixture, 'hold.ps1')
    await writeFile(lockScript, `$lockStream = [IO.File]::Open('${join(app, 'zz-busy.dll').replaceAll("'", "''")}', [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)\ntry { [IO.File]::WriteAllText('${ready.replaceAll("'", "''")}', 'ready'); while (-not (Test-Path -LiteralPath '${release.replaceAll("'", "''")}')) { Start-Sleep -Milliseconds 25 } } finally { $lockStream.Dispose() }\n`, 'utf8')
    const lockPromise = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', lockScript], { cwd: fixture, windowsHide: true, timeout: 30000 })
    try {
      const started = Date.now()
      for (;;) { try { await access(ready); break } catch {} if (Date.now() - started > 10000) throw new Error('File-lock fixture did not start'); await new Promise(done => setTimeout(done, 50)) }
      assert.equal(await launch(uninstaller, ['/S', '--updated', `_?=${app}`]), 2)
      const unlockedManaged = Object.fromEntries(Object.entries(allManaged).filter(([name]) => name !== 'zz-busy.dll'))
      assert.deepEqual(await hashes(app, unlockedManaged), Object.fromEntries(Object.entries(beforeManaged).filter(([name]) => name !== 'zz-busy.dll')))
      assert.deepEqual(await hashes(app, preserved), before)
      suites.push('busy file abort restores all managed files and preserves user data')
    } finally { await writeFile(release, 'release'); await lockPromise }
    assert.deepEqual(await hashes(app, allManaged), beforeManaged)
  }
  assert.equal(await launch(uninstaller, ['/S', ...(name === 'update' ? ['--updated'] : []), `_?=${app}`]), 0)
  assert.deepEqual(await hashes(app, preserved), before)
  await access(join(app, 'outputs/empty'))
  for (const name of Object.keys(allManaged)) await assert.rejects(access(join(app, name)))
  assert.equal((await readdir(app)).some(name => /^ns.+\.tmp$/i.test(name)), false)
  suites.push(`${name}: removes package files, preserves outputs and unknown files`)
}
await removalFixture('update', true)
await removalFixture('uninstall')

const legacy = join(root, 'legacy'), legacyApp = join(legacy, 'app'), legacyManifest = join(legacy, 'managed.nsh'), legacyExe = join(legacy, 'guard.exe')
await seed(legacyApp, managed); await generateManifest(legacyApp, legacyManifest); await seed(legacyApp, preserved)
const legacyBefore = await hashes(legacyApp, { ...managed, ...preserved })
await writeFile(join(legacy, 'guard.nsi'), `Unicode true\nRequestExecutionLevel user\nSilentInstall silent\n!include LogicLib.nsh\n!include FileFunc.nsh\n!define MUXIVRA_MANAGED_FILES_INCLUDE "${escape(legacyManifest)}"\n!include "${escape(join(project, 'resources/installer.nsh'))}"\n!insertmacro customHeader\nName "Muxivra isolated legacy guard test"\nOutFile "${escape(legacyExe)}"\nSection\nStrCpy $muxivraLegacyDirectory "${escape(legacyApp)}"\n\${GetParameters} $R0\n\${GetOptions} $R0 "--version=" $muxivraLegacyVersion\nCall MuxivraCheckLegacyOutputs\nSectionEnd\n`, 'utf8')
await compile(join(legacy, 'guard.nsi'))
assert.equal(await launch(legacyExe, ['/S', '--version=0.12.0']), 3)
assert.equal(await launch(legacyExe, ['/S', '--version=']), 3)
assert.equal(await launch(legacyExe, ['/S', '--version=0.13.0']), 0)
assert.equal(await launch(legacyExe, ['/S', '--version=0.14.0']), 0)
assert.deepEqual(await hashes(legacyApp, { ...managed, ...preserved }), legacyBefore)
suites.push('legacy bootstrap blocks before touching outputs; modern versions pass')
const report = { isolation: basename(root), registryAccess: false, shortcuts: false, realApplicationInstall: false, lateManagedFiles: Object.keys(lateManaged), suites }
await mkdir(join(project, 'artifacts/qa'), { recursive: true })
await writeFile(join(project, 'artifacts/qa/installer-preservation-smoke.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
