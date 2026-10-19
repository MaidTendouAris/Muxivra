// Refresh only from publisher-owned endpoints; never download model weights here.
import { createHash } from 'node:crypto'
import { readFile,writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const assets=[['qwen-0.6b','Qwen/Qwen3-ASR-0.6B','5eb144179a02acc5e5ba31e748d22b0cf3e303b0'],['qwen-1.7b','Qwen/Qwen3-ASR-1.7B','7278e1e70fe206f11671096ffdd38061171dd6e5'],['qwen-aligner','Qwen/Qwen3-ForcedAligner-0.6B','c7cbfc2048c462b0d63a45797104fc9db3ad62b7']]
async function get(url){const r=await fetch(url,{signal:AbortSignal.timeout(45000)});assert.equal(r.status,200,url);return r}
const manifests={}
for(const [id,repo,revision] of assets){
  const hf=await(await get(`https://huggingface.co/api/models/${repo}/revision/${revision}?blobs=true`)).json()
  const ms=await(await get(`https://modelscope.cn/api/v1/models/${repo}/repo/files?Revision=master&Recursive=true`)).json()
  assert.equal(hf.sha,revision)
  const files=hf.siblings.filter(f=>/\.(json|safetensors|bin|model|txt|tiktoken|jinja)$/.test(f.rfilename))
  for(const file of files){
    const alternate=ms.Data.Files.find(f=>f.Path===file.rfilename);assert.ok(alternate,file.rfilename)
    assert.equal(alternate.Size,file.size);assert.match(alternate.Revision,/^[a-f0-9]{40}$/)
    if(file.lfs)assert.equal(alternate.Sha256,file.lfs.sha256)
    else{
      const data=Buffer.from(await(await get(`https://modelscope.cn/models/${repo}/resolve/${alternate.Revision}/${file.rfilename}`)).arrayBuffer())
      assert.equal(data.length,file.size);assert.equal(createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex'),file.blobId)
    }
    file.modelscopeRevision=alternate.Revision
  }
  manifests[id]={repo,revision,files};console.log(`${id}: ${files.length} publisher files match pinned Hugging Face hashes`)
}
const path='src/core/asr/modelscope-manifests.json',text=JSON.stringify(manifests,null,2)+'\n'
if(process.argv.includes('--write'))await writeFile(path,text)
else assert.equal(await readFile(path,'utf8'),text,'Bundled publisher manifests changed; review before updating')
