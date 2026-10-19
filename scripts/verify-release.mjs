import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { load } from 'js-yaml'
import yauzl from 'yauzl'

const directory = resolve(process.env.MUXIVRA_RELEASE_DIR || 'release')
const { version } = JSON.parse(await readFile('package.json', 'utf8'))
const tag = process.env.RELEASE_TAG
assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
if (tag) assert.equal(tag, `v${version}`, 'The stable release tag must match package.json')
const shared = await readFile('src/shared/version.ts', 'utf8')
assert.equal(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(shared)?.[1], version)
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'))
assert.equal(lock.version, version)
assert.equal(lock.packages[''].version, version)
const installerName = `Muxivra-${version}-win-x64-setup.exe`
const portableName = `Muxivra-${version}-win-x64-portable.zip`
async function hash(stream, algorithm = 'sha256', encoding = 'hex') {
  const digest = createHash(algorithm)
  for await (const bytes of stream) digest.update(bytes)
  return digest.digest(encoding)
}
const installer = await readFile(join(directory, installerName))
assert.equal(installer.subarray(0, 2).toString(), 'MZ', 'The installer must be a Windows executable')
const latest = load(await readFile(join(directory, 'latest.yml'), 'utf8'))
assert.equal(latest.version, version)
assert.equal(latest.path, installerName)
assert.equal(latest.sha512, createHash('sha512').update(installer).digest('base64'))
assert.equal(latest.files.filter(file => file.url === installerName).length, 1)
assert.ok(latest.files.every(file => [installerName, portableName].includes(file.url)))
for (const file of latest.files) {
  const bytes = await readFile(join(directory, file.url))
  assert.equal(file.size, bytes.length)
  assert.equal(file.sha512, createHash('sha512').update(bytes).digest('base64'))
}

// Read every archived file and compare it with the verified unpacked build.
// This catches missing native modules/resources and accidental user data.
const unpacked = join(directory, 'win-unpacked'), expected = new Map()
async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name)
    assert.equal(entry.isSymbolicLink(), false)
    if (entry.isDirectory()) await walk(file)
    else expected.set(relative(unpacked, file).replaceAll('\\', '/'), file)
  }
}
await walk(unpacked)
const names = new Set()
await new Promise((done, reject) => {
  yauzl.open(join(directory, portableName), { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error)
    zip.on('error', reject)
    zip.on('end', done)
    zip.on('entry', async entry => {
      try {
        const name = entry.fileName
        assert.ok(!name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..'))
        if (name.endsWith('/')) { zip.readEntry(); return }
        assert.ok(!/^(outputs|projects|asr|\.runtime|\.test-data)\//i.test(name), `User data in ZIP: ${name}`)
        assert.ok(expected.has(name), `Unexpected file in ZIP: ${name}`)
        assert.ok(!names.has(name), `Duplicate file in ZIP: ${name}`)
        names.add(name)
        const stream = await new Promise((accept, fail) => zip.openReadStream(entry, (e, value) => e ? fail(e) : accept(value)))
        assert.equal(await hash(stream), await hash(createReadStream(expected.get(name))), `ZIP content differs: ${name}`)
        zip.readEntry()
      } catch (failure) { zip.close(); reject(failure) }
    })
    zip.readEntry()
  })
})
for (const name of expected.keys()) assert.ok(names.has(name), `Missing file in ZIP: ${name}`)
for (const name of ['Muxivra.exe', 'resources/app.asar', 'resources/mpv/mpv.exe', 'resources/asr/adapter.py', 'resources/app-update.yml']) assert.ok(names.has(name), name)
const assets = [installerName, portableName, 'latest.yml']
const report = { version, tag: tag || null, portableFiles: names.size, assets: await Promise.all(assets.map(async name => ({ name, sha256: await hash(createReadStream(join(directory, name))) }))) }
await mkdir('artifacts/qa', { recursive: true })
await writeFile('artifacts/qa/release-contents.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
