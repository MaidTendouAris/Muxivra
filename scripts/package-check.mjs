import { readFile, readdir, writeFile, access, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { listPackage, extractFile } from '@electron/asar'
import assert from 'node:assert/strict'
import { load } from 'js-yaml'
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
const guides=['connection','workflow','goals','audio','video','parameters','troubleshooting']
for(const id of guides)assert.match(extractFile(asar,join('resources','mcp-skills',id,'SKILL.md')).toString(),/^---\r?\nname: muxivra-/)
const metadata=JSON.parse(extractFile(asar,'package.json').toString());assert.equal(metadata.version,JSON.parse(await readFile('package.json','utf8')).version)
assert.ok(metadata.dependencies['electron-updater'])
const updateConfig=load(await readFile(join(resources,'app-update.yml'),'utf8'))
assert.equal(updateConfig.provider,'github');assert.equal(updateConfig.owner,'MaidTendouAris');assert.equal(updateConfig.repo,'Muxivra')
assert.ok(!updateConfig.token&&!updateConfig.requestHeaders)
const releaseDirectory=process.env.MUXIVRA_RELEASE_DIR||dirname(root),updateManifestPath=join(releaseDirectory,'latest.yml')
let updateManifest=false
try{await access(updateManifestPath);updateManifest=true}catch(error){if(process.env.MUXIVRA_RELEASE_DIR||error.code!=='ENOENT')throw error}
if(updateManifest){
  await access(join(resources,'elevate.exe'))
  const latest=load(await readFile(updateManifestPath,'utf8')),expectedName=`Muxivra-${metadata.version}-win-x64-setup.exe`
  assert.equal(latest.version,metadata.version);assert.ok(Array.isArray(latest.files)&&latest.files.length===1)
  const installerInfo=latest.files[0];assert.equal(installerInfo.url,expectedName)
  const installer=await readFile(join(releaseDirectory,expectedName))
  assert.equal(installerInfo.size,installer.length);assert.equal(installerInfo.sha512,createHash('sha512').update(installer).digest('base64'))
  await access(join(releaseDirectory,`${expectedName}.blockmap`))
}
const report={version:metadata.version,asarEntries:entries.length,bundledProcessingEngines:engines,license:true,thirdPartyNotices:true,chromiumPlaybackLibrary:true,mediaPlayback:'mpv',mpvVersion:manifest.version,mpvSha256:manifest.executableSha256,mpvInput:true,nativeModule:true,mcpSkills:guides,autoUpdate:{provider:updateConfig.provider,owner:updateConfig.owner,repo:updateConfig.repo,releaseManifest:updateManifest}}
await mkdir('artifacts/qa',{recursive:true})
await writeFile('artifacts/qa/package-contents.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
