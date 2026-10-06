import { readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
const seen=new Map()
async function walk(directory) {
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    if(!entry.isDirectory() || entry.name.startsWith('.')) continue
    const path=join(directory,entry.name)
    if(entry.name.startsWith('@')) { await walk(path);continue }
    try {
      const metadata=JSON.parse(await readFile(join(path,'package.json'),'utf8'))
      const key=`${metadata.name}@${metadata.version}`
      if(!seen.has(key)) {
        let licenseText=''
        for(const file of await readdir(path)) if(/^(licen[sc]e|copying|notice)(\.|$)/i.test(file) && (await stat(join(path,file))).isFile()) licenseText+=`${file}\n${await readFile(join(path,file),'utf8')}\n`
        seen.set(key,{license:metadata.license??'See upstream notices',repository:typeof metadata.repository==='string'?metadata.repository:metadata.repository?.url??'',text:licenseText})
      }
      try { await walk(join(path,'node_modules')) } catch(error) { if(error.code!=='ENOENT') throw error }
    } catch(error) { if(error.code!=='ENOENT') throw error }
  }
}
await walk('node_modules')
let output='Muxivra third-party notices\n\nApplication: GPL-3.0-only\nThis file conservatively includes build and development dependencies as well as runtime dependencies. Each component retains its own license and copyright. FFmpeg/ffprobe command-line processing engines are not bundled. Electron/Chromium includes its own ffmpeg.dll playback library, distributed with upstream Electron and Chromium notices.\n\nshadcn/ui button pattern: MIT, Copyright (c) 2023 shadcn\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n'
for(const [name,record] of [...seen].sort(([a],[b])=>a.localeCompare(b))) output+=`\n${'='.repeat(78)}\n${name}\nLicense: ${typeof record.license==='string'?record.license:JSON.stringify(record.license)}\nRepository: ${record.repository}\n\n${record.text||'Refer to the upstream repository for component notices.'}\n`
output+='\nBundled mpv playback runtime: see resources/mpv-licenses and resources/mpv-manifest.json.\n';for(const entry of await readdir('resources/mpv-licenses'))output+='\n'+entry+'\n'+await readFile(join('resources/mpv-licenses',entry),'utf8')+'\n';
await writeFile('THIRD-PARTY-NOTICES.txt',output)
console.log(`Preserved notices for ${seen.size} third-party packages`)
