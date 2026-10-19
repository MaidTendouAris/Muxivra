import { build } from 'esbuild'
import { mkdir,mkdtemp,readFile,writeFile,rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve,join,relative,isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true});const root=await mkdtemp(resolve('.test-data','asr-official-')),modulePath=join(root,'download.mjs'),report={checkedAt:new Date().toISOString(),sources:[],largeWeightsDownloaded:false}
try{
  await build({stdin:{contents:"export {officialManifest} from './src/core/asr/official-download'; export {officialAsrCatalog} from './src/shared/asr-catalog'",resolveDir:process.cwd(),loader:'ts'},outfile:modulePath,bundle:true,platform:'node',format:'esm',packages:'external'})
  const {officialManifest,officialAsrCatalog}=await import(pathToFileURL(modulePath).href)
  for(const asset of officialAsrCatalog){const manifest=await officialManifest(asset,new AbortController().signal),config=manifest.files.find(file=>file.rfilename==='config.json'),url=`https://huggingface.co/${asset.repo}/resolve/${asset.revision}/config.json`,response=await fetch(url,{signal:AbortSignal.timeout(45000)});assert.ok(response.ok);const buffer=Buffer.from(await response.arrayBuffer());assert.equal(buffer.length,config.size);assert.equal(createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex'),config.blobId);const parsed=JSON.parse(buffer.toString());assert.ok(parsed.model_type||asset.role==='tokenizer');report.sources.push({id:asset.id,repo:asset.repo,revision:asset.revision,files:manifest.files.length,totalBytes:manifest.total,configModelType:parsed.model_type??'audio-tokenizer',configHashVerified:true});await writeFile(join(root,asset.id+'-config.json'),buffer)}
  await writeFile('artifacts/qa/asr-official-validation.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}finally{const rel=relative(resolve('.test-data'),root);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('Unsafe cleanup');await rm(root,{recursive:true,force:true})}
