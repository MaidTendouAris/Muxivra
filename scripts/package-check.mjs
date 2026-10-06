import { readFile, readdir, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { listPackage, extractFile } from '@electron/asar'
import assert from 'node:assert/strict'
const root=process.env.MUXIVRA_PACKAGE_DIR||'release/win-unpacked',resources=join(root,'resources'),asar=join(resources,'app.asar')
const entries=listPackage(asar),files=[]
async function walk(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);entry.isDirectory()?await walk(path):files.push(path)}}
await walk(root)
const engines=files.filter(path=>/(^|[\\/])(ffmpeg|ffprobe)\.exe$/i.test(path));assert.deepEqual(engines,[])
assert.equal(entries.some(path=>/(^|[\\/])(ffmpeg|ffprobe)\.exe$/i.test(path)),false)
const manifest=JSON.parse(await readFile(join(resources,'mpv-manifest.json'),'utf8')),exe=await readFile(join(resources,'mpv/mpv.exe'))
assert.equal(createHash('sha256').update(exe).digest('hex'),manifest.executableSha256)
await access(join(resources,'mpv-input.conf'));await access(join(resources,'mpv/licenses/SOURCES.md'));await access(join(root,'ffmpeg.dll'))
assert.ok(extractFile(asar,'LICENSE').length>10000);assert.match(extractFile(asar,'THIRD-PARTY-NOTICES.txt').toString(),/Bundled mpv playback runtime/)
const native=files.filter(path=>/koffi.*\.node$/i.test(path));assert.ok(native.length>0)
assert.ok(extractFile(asar,join('out','main','hardware-worker.js')).length>100)
const guides=['connection','workflow','audio','video','parameters','troubleshooting']
for(const id of guides)assert.match(extractFile(asar,join('resources','mcp-skills',id,'SKILL.md')).toString(),/^---\r?\nname: muxivra-/)
const metadata=JSON.parse(extractFile(asar,'package.json').toString());assert.equal(metadata.version,JSON.parse(await readFile('package.json','utf8')).version)
const report={version:metadata.version,asarEntries:entries.length,bundledProcessingEngines:engines,license:true,thirdPartyNotices:true,chromiumPlaybackLibrary:true,mediaPlayback:'mpv',mpvVersion:manifest.version,mpvSha256:manifest.executableSha256,mpvInput:true,nativeModule:true,mcpSkills:guides}
await writeFile('artifacts/qa/package-contents.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
