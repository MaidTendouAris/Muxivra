// Opt in with MUXIVRA_COMPLEX_PROJECT_SMOKE=1. Uses the licensed local fixture,
// real GPU playback and an isolated project/profile; it never edits the source.
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { createReadStream } from 'node:fs'
import { mkdir,mkdtemp,readFile,writeFile,stat,rm } from 'node:fs/promises'
import { basename,join,resolve,relative,isAbsolute,sep } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { createProject } from './gui-projects.mjs'

if(process.env.MUXIVRA_COMPLEX_PROJECT_SMOKE!=='1') {
  console.log('Complex project smoke skipped; set MUXIVRA_COMPLEX_PROJECT_SMOKE=1 to run the local media audit.')
  process.exit(0)
}

const source=resolve(process.env.MUXIVRA_COMPLEX_MEDIA||'tests/media/[KitaujiSub] Make Heroine ga Oosugiru! [06][WebRip][HEVC_AAC][CHS_JP&CHT_JP].mkv')
const sourceStat=await stat(source)
assert.ok(sourceStat.isFile(),'The complex media fixture must be a regular local file')
await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const root=await mkdtemp(resolve('.test-data','complex-project-')),profile=join(root,'profile')
const report={source:basename(source),executable:process.env.MUXIVRA_EXECUTABLE||'development',timings:{},tracks:[],screenshots:[],errors:[],checks:[]}
const exec=promisify(execFile),reportPath=resolve('artifacts/qa/complex-project-smoke.json'),progressPath=resolve('artifacts/qa/complex-project-progress.json'),failurePath=resolve('artifacts/qa/complex-project-failed.json')
let desktop,page,project,success=false,stage='setup'
const hash=async path=>{const digest=createHash('sha256');for await(const part of createReadStream(path))digest.update(part);return digest.digest('hex')}
const sourceHash=await hash(source)
const checkpoint=()=>writeFile(progressPath,JSON.stringify(report,null,2))
const timed=async(name,operation)=>{stage=name;const started=performance.now();const result=await operation();report.timings[name]=Math.round(performance.now()-started);await checkpoint();console.log(`${name}: ${report.timings[name]} ms`);return result}
const until=async(check,label,timeout=60000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await page.waitForTimeout(100)}throw new Error(`${label} timed out after ${timeout} ms`)}
const nav=async name=>{await page.locator('.navigation').getByRole('button',{name,exact:true}).click();await page.getByRole('heading',{name,exact:true,level:1}).waitFor()}
const session=()=>page.evaluate(async()=>{const document=await window.muxivra.getSession();return document?{id:document.id,path:document.projectPath,events:document.cues.length,styles:document.styles?.length,drawings:document.cues.filter(cue=>/\\p[1-9]\d*/.test(cue.text)).length,comments:document.cues.filter(cue=>cue.comment).length}:undefined})
const currentProject=()=>page.evaluate(async id=>(await window.muxivra.snapshot()).projects.items.find(item=>item.id===id),project.id)
const player=()=>page.evaluate(()=>window.muxivra.playerState('subtitles'))
const openDetails=async()=>{
  await nav('项目管理')
  const back=page.getByRole('button',{name:'返回项目管理',exact:true})
  if(await back.count())await back.click()
  await page.locator('.project-card').filter({hasText:project.name}).getByRole('button',{name:'项目文件',exact:true}).click()
  await page.getByLabel('当前字幕文件',{exact:true}).waitFor()
}
const choose=async(label,value)=>{await page.getByLabel(label,{exact:true}).click();await page.locator(`[role="option"][data-value="${value}"]`).click()}
const rawAss=text=>{
  const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/)
  const time=value=>{const [h,m,s]=value.split(':');return Math.round((Number(h)*3600+Number(m)*60+Number(s))*1000)}
  const events=lines.filter(line=>/^(Dialogue|Comment):/.test(line)).map(line=>{
    const [kind,...values]=line.split(',')
    return {comment:kind.startsWith('Comment:'),layer:Number(kind.slice(kind.indexOf(':')+1)),startMs:time(values[0]),endMs:time(values[1]),style:values[2],name:values[3],marginL:Number(values[4]),marginR:Number(values[5]),marginV:Number(values[6]),effect:values[7],text:values.slice(8).join(',')}
  })
  return {events,styles:lines.filter(line=>line.startsWith('Style:')&&!line.startsWith('Style: Default,'))}
}
const assertEvents=(actual,expected,label)=>{
  assert.equal(actual.length,expected.length,`${label}: event count changed`)
  const index=actual.findIndex((event,i)=>JSON.stringify(event)!==JSON.stringify(expected[i]))
  assert.equal(index,-1,`${label}: event ${index+1} changed unexpectedly`)
}
const semanticDigest=()=>page.evaluate(async()=>{
  const document=await window.muxivra.getSession()
  const value=JSON.stringify({cues:document.cues.map(({id,...cue})=>cue),styles:document.styles,scriptInfo:document.scriptInfo,eventFormat:document.eventFormat,styleFormat:document.styleFormat,sections:document.sections,sectionLines:document.sectionLines})
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map(value=>value.toString(16).padStart(2,'0')).join('')
})
const reopen=async expected=>{
  await nav('项目管理')
  const back=page.getByRole('button',{name:'返回项目管理',exact:true})
  if(await back.count())await back.click()
  const card=page.locator('.project-card').filter({hasText:project.name})
  await card.getByRole('button',{name:'关闭工程',exact:true}).click();await until(async()=>!await session(),'Close complex project')
  await card.getByRole('button',{name:'编辑字幕',exact:true}).click()
  await until(async()=>(await session())?.path===expected.path,'Reopen selected ASS')
  await page.getByLabel('字幕文件',{exact:true}).waitFor()
  assert.equal((await session()).events,expected.events)
}
const capturePreview=async(track,seconds)=>{
  const canvas=page.locator('canvas[data-mpv-surface="subtitles"]')
  await until(async()=>{const state=await player();if(state.error)throw new Error(state.error);return state.ready&&!state.loading&&state.videoWidth>0},'Native GPU player')
  await page.waitForFunction(()=>Number(document.querySelector('canvas[data-mpv-surface="subtitles"]')?.dataset.presentedFrames)>0)
  await page.evaluate(()=>window.muxivra.playerAction('subtitles',{type:'pause'}))
  const previous=Number(await canvas.getAttribute('data-presented-frames'))
  await page.evaluate(seconds=>window.muxivra.playerAction('subtitles',{type:'seek',positionMs:seconds*1000}),seconds)
  await until(async()=>{const state=await player();return state.paused&&Math.abs(state.positionMs-seconds*1000)<90},`Seek preview ${seconds}s`)
  await until(()=>canvas.getAttribute('data-presented-frames').then(value=>Number(value)>previous),`GPU frame ${seconds}s`)
  await page.waitForTimeout(500)
  const pixels=await canvas.evaluate(canvas=>{const context=canvas.getContext('2d'),data=context.getImageData(0,0,canvas.width,canvas.height).data,colors=new Set();for(let i=0;i<data.length;i+=400)colors.add(`${data[i]},${data[i+1]},${data[i+2]}`);return {width:canvas.width,height:canvas.height,colors:colors.size,presentedFrames:Number(canvas.dataset.presentedFrames)}})
  assert.ok(pixels.width>100&&pixels.height>100&&pixels.colors>8,'The native canvas must contain actual video pixels')
  const filename=`complex-project-${track}-${String(seconds).replace('.','-')}s.png`,path=resolve('artifacts/qa',filename)
  await canvas.screenshot({path})
  const state=await player(),selected=state.tracks.find(item=>item.type==='sub'&&(state.subtitleTrack===item.id||state.subtitleTrack==='auto'&&item.selected))
  assert.ok(selected?.external,'The editor must preview the imported external ASS track')
  report.screenshots.push({track,seconds,path,pixels,positionMs:state.positionMs,subtitleTrack:state.subtitleTrack,externalSubtitle:basename(selected['external-filename']||'')})
}

try {
  const baselines=[]
  for(const track of [{index:2,label:'CHS_JP',events:10112,drawings:5493},{index:3,label:'CHT_JP',events:10506,drawings:5887}]) {
    const path=join(root,`source-track-${track.index}.ass`)
    await exec('ffmpeg',['-v','error','-nostdin','-i',source,'-map',`0:${track.index}`,'-c:s','copy',path],{windowsHide:true,timeout:120000,maxBuffer:1024*1024})
    const original=rawAss(await readFile(path,'utf8'));assert.equal(original.events.length,track.events);assert.equal(original.styles.length,13)
    baselines.push({...track,original})
  }
  await timed('launch',async()=>{
    desktop=await electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE||electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_TEST_SYSTEM_LANGUAGES:'zh-CN',MUXIVRA_DATA_PATH:profile,MUXIVRA_ENGINE_PATH:join(root,'engines')},timeout:60000})
    page=await desktop.firstWindow();page.setDefaultTimeout(60000);page.on('pageerror',error=>report.errors.push(error.message.slice(0,2000)))
    await page.getByRole('heading',{name:'视频处理',exact:true}).waitFor({timeout:60000})
    await desktop.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.setSize(1600,1000);window.show();window.focus()})
    report.gpu=await desktop.evaluate(async({app})=>({features:app.getGPUFeatureStatus(),info:await app.getGPUInfo('basic')}))
    assert.equal(report.gpu.features.gpu_compositing,'enabled','This opt-in audit requires real GPU compositing')
    report.appVersion=await desktop.evaluate(({app})=>app.getVersion())
  })
  await timed('create-preprocess-project',async()=>{
    let last=''
    const progress=setInterval(()=>{void page.evaluate(async()=>(await window.muxivra.snapshot()).projects.import).then(value=>{const summary=`${value.phase} ${Math.round(value.percent)}%`;if(value.active&&summary!==last){last=summary;console.log(`Project preprocessing: ${summary}`)}}).catch(()=>{})},15000)
    try{project=await createProject(page,desktop,source,{name:'Complex ASS import audit',creationTimeout:600000})}finally{clearInterval(progress)}
    const inside=relative(root,project.directory);assert.ok(inside&&!inside.startsWith('..')&&!isAbsolute(inside),'Project files must stay inside the isolated test profile')
    assert.equal(project.subtitles.length,1);assert.equal((await session()).events,0)
    report.project={id:project.id,directory:project.directory,mediaBytes:project.mediaBytes}
    assert.equal(await hash(project.mediaPath),sourceHash,'The managed media copy must match the source')
  })
  const blank={...project.subtitles[0],hash:await hash(project.subtitlePath)}
  for(const baseline of baselines) {
    const imported=await timed(`import-${baseline.label}`,async()=>{
      await openDetails();await page.getByRole('button',{name:'查找内嵌字幕',exact:true}).click();await page.getByLabel('内嵌字幕轨道',{exact:true}).waitFor();await choose('内嵌字幕轨道',String(baseline.index))
      baseline.uiLabel=await page.getByLabel('内嵌字幕轨道',{exact:true}).innerText()
      await page.getByRole('button',{name:'导入所选轨道',exact:true}).click();await until(async()=>(await session())?.events===baseline.events,`${baseline.label} managed import`,120000)
      const document=await session(),current=await currentProject();assert.equal(current.subtitles.length,baseline.index);assert.match(document.path,/\.ass$/i);assert.notEqual(document.path,blank.path)
      const actual=rawAss(await readFile(document.path,'utf8'));assertEvents(actual.events,baseline.original.events,`${baseline.label} import`);assert.deepEqual(actual.styles,baseline.original.styles)
      await page.getByRole('button',{name:'编辑字幕',exact:true}).click();await page.getByLabel('字幕文件',{exact:true}).waitFor();await until(()=>page.getByLabel('字幕文件',{exact:true}).innerText().then(value=>value===basename(document.path)),'Editor imported file')
      return document
    })
    await timed(`edit-save-reopen-${baseline.label}`,async()=>{
      const candidate=await page.evaluate(async()=>{const document=await window.muxivra.getSession();const cue=document.cues.find(cue=>!cue.comment&&/^Text\s*-/.test(cue.style??'')&&!cue.text.includes('\\')&&cue.text.trim().length>=12&&document.cues.filter(item=>item.text===cue.text).length===1);return cue?{id:cue.id,text:cue.text,style:cue.style,index:document.cues.indexOf(cue)}:undefined})
      assert.ok(candidate,'The fixture must contain a unique normal dialogue cue')
      const nextText=candidate.text+' [QA]'
      await page.getByRole('button',{name:'搜索与替换',exact:true}).click();await page.getByLabel('搜索文本',{exact:true}).fill(candidate.text)
      await page.locator(`tr[data-cue-id="${candidate.id}"]`).click();assert.equal(await page.getByLabel('字幕文本',{exact:true}).inputValue(),candidate.text)
      await page.getByLabel('字幕文本',{exact:true}).fill(nextText);await page.getByRole('button',{name:'保存工程',exact:true}).click()
      await until(async()=>(await readFile(imported.path,'utf8')).includes(nextText),'Save benign dialogue change')
      const expected=baseline.original.events.map((cue,index)=>index===candidate.index?{...cue,text:nextText}:cue)
      const saved=rawAss(await readFile(imported.path,'utf8'));assertEvents(saved.events,expected,`${baseline.label} save`);assert.deepEqual(saved.styles,baseline.original.styles)
      const beforeReopen=await semanticDigest();await page.getByRole('button',{name:'关闭搜索',exact:true}).click();await reopen(imported);assert.equal(await semanticDigest(),beforeReopen,'Reopening must preserve all event attributes, styles and script sections')
      const reopened=rawAss(await readFile(imported.path,'utf8'));assertEvents(reopened.events,expected,`${baseline.label} reopen`)
      report.tracks.push({...await session(),track:baseline.index,label:baseline.label,uiLabel:baseline.uiLabel,editedEvent:candidate.index+1,editedStyle:candidate.style,eventPreservation:true,stylePreservation:true,semanticDigest:beforeReopen})
      assert.equal((await session()).drawings,baseline.drawings);assert.equal((await session()).comments,21)
    })
    await timed(`preview-${baseline.label}`,async()=>{for(const seconds of [126.4,155,1355])await capturePreview(baseline.label,seconds);await page.screenshot({path:resolve(`artifacts/qa/complex-project-${baseline.label}-editor.png`),fullPage:true})})
  }
  await timed('external-srt-import',async()=>{
    const external=join(root,'external.srt'),content='1\n00:00:01,230 --> 00:00:02,340\nExternal SRT preserved\n';await writeFile(external,content)
    const previous=await currentProject(),existingHashes=await Promise.all(previous.subtitles.map(async file=>({path:file.path,hash:await hash(file.path)})))
    await openDetails();await desktop.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]})},external)
    await page.getByRole('button',{name:'导入字幕',exact:true}).click();await until(async()=>(await session())?.events===1,'External SRT conversion')
    const current=await currentProject(),document=await session();assert.equal(current.subtitles.length,4);assert.match(document.path,/\.ass$/i);assert.equal(await readFile(external,'utf8'),content)
    for(const file of existingHashes)assert.equal(await hash(file.path),file.hash,'External import must preserve every existing project subtitle')
    assert.equal(await hash(blank.path),blank.hash,'The original blank track must be retained')
    const converted=rawAss(await readFile(document.path,'utf8'));assert.equal(converted.events[0].text,'External SRT preserved');assert.equal(converted.events[0].startMs,1230);assert.equal(converted.events[0].endMs,2340)
    await page.screenshot({path:resolve('artifacts/qa/complex-project-imports.png'),fullPage:true})
    report.externalSrt={files:current.subtitles.length,path:document.path,sourcePreserved:true,existingTracksPreserved:true,blankTrackRetained:true,timingPreserved:true}
  })
  await timed('source-preservation',async()=>{const after=await stat(source);assert.equal(after.size,sourceStat.size);assert.equal(after.mtimeMs,sourceStat.mtimeMs);assert.equal(await hash(source),sourceHash);report.sourcePreserved=true})
  assert.deepEqual(report.errors,[]);assert.equal(await page.locator('.toast-error').count(),0)
  report.checks=['Full real media copy and waveform/frame preprocessing','Separate CHS_JP and CHT_JP ASS imports','One normal dialogue edit per track; every other event and style preserved','Close/reopen retains all event, script and section data','Six real GPU canvas captures across OP, animated drawings and ED','External SRT adds a new ASS while all earlier files and source remain intact']
  report.result='passed';success=true;await checkpoint();await writeFile(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify({result:report.result,timings:report.timings,tracks:report.tracks.map(({label,events,drawings,comments})=>({label,events,drawings,comments})),screenshots:report.screenshots.length,report:reportPath}))
}catch(error){
  report.result='failed';report.failedStage=stage;report.failure=error.stack;report.retainedTestDirectory=root
  if(page){report.visibleText=(await page.locator('body').innerText().catch(()=>''))?.slice(0,5000);await page.screenshot({path:resolve('artifacts/qa/complex-project-failed.png'),fullPage:true}).catch(()=>{})}
  await checkpoint();await writeFile(failurePath,JSON.stringify(report,null,2));console.error(JSON.stringify({result:'failed',stage,error:error.message,report:failurePath,retainedTestDirectory:root}));throw error
}finally{
  await desktop?.close().catch(()=>{})
  if(success){const inside=relative(resolve('.test-data'),root);if(!inside||inside==='..'||inside.startsWith(`..${sep}`)||isAbsolute(inside))throw new Error('Unsafe complex audit cleanup');await rm(root,{recursive:true,force:true})}
}
