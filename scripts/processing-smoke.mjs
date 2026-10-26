import { installHeadlessTextureFixture } from './headless-texture-fixture.mjs'
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { mkdir,mkdtemp,readFile,writeFile,rm,stat } from 'node:fs/promises'
import { join,resolve,relative,isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
const exec=promisify(execFile)
await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const root=await mkdtemp(resolve('.test-data','processing-')),input=join(root,'视频 with spaces.mp4'),output=join(root,'output'),lyrics=join(root,'lyrics.lrc')
await mkdir(output)
await exec('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24','-f','lavfi','-i','sine=frequency=440','-t','5','-c:v','libx264','-c:a','aac',input],{windowsHide:true})
await writeFile(lyrics,'[00:00.50]First line\n[00:02.00]第二句\n')
const original=await readFile(input),report={errors:[],layouts:[]}
const desktop=await electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE||electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_DATA_PATH:join(root,'profile'),MUXIVRA_ENGINE_PATH:join(root,'engines')},timeout:60000})
let page
try{
  await installHeadlessTextureFixture(desktop);page=await desktop.firstWindow();page.on('pageerror',e=>report.errors.push(e.message))
  await page.getByRole('heading',{name:'视频处理',exact:true}).waitFor({timeout:60000})
  const nav=name=>page.locator('.navigation').getByRole('button',{name,exact:true}).click()
  const scope=()=>page.locator('.processing-page:visible'),dock=()=>page.locator('.workspace-header .processing-dock')
  const step=name=>dock().getByRole('button',{name:new RegExp(name)}).click()
  const pick=path=>desktop.evaluate(({dialog},p)=>{dialog.showOpenDialog=async(_window,options)=>({canceled:false,filePaths:[options.properties.includes('openDirectory')?p.output:p.input]})},{input:path,output})
  const choose=async(label,value)=>{await scope().getByRole('combobox',{name:label,exact:true}).click();await page.locator(`[role="option"][data-value="${value}"]`).click()}
  const until=async check=>{const end=Date.now()+45000;while(Date.now()<end){if(await check())return;await page.waitForTimeout(80)}throw new Error('Processing check timed out')}
  const checkLayout=async name=>{
    const state=await page.evaluate(()=>({height:innerHeight,width:innerWidth,docHeight:document.documentElement.scrollHeight,docWidth:document.documentElement.scrollWidth,workspace:document.querySelector('.workspace').getBoundingClientRect().toJSON()}))
    assert.ok(state.docHeight<=state.height+1,`${name}: whole page must not scroll`);assert.ok(state.docWidth<=state.width+1,`${name}: horizontal overflow`)
    if(await scope().count()){const d=await dock().boundingBox(),header=await page.locator('.workspace-header').boundingBox(),title=await page.locator('.workspace-header h1').boundingBox(),preview=await scope().locator('.processing-preview').boundingBox();assert.ok(d.height<=40,'Dock must fit the title row');assert.ok(d.y>=header.y&&d.y+d.height<=header.y+header.height,'Dock must stay inside header');assert.ok(d.x>=title.x+title.width,'Dock must be right of title');assert.ok(d.y+d.height<=preview.y,'Dock must not cover working cards');assert.equal(await dock().locator('small').count(),0,'No numbered corner badges')}
    report.layouts.push({name,...state})
  }
  assert.equal(await dock().getByRole('button').count(),9)
  assert.equal(await dock().getByRole('button').filter({has:page.locator(':disabled')}).count(),0) // Buttons themselves carry disabled.
  assert.equal(await dock().locator('button:disabled').count(),8)
  await nav('音频处理');assert.equal(await dock().getByRole('button').count(),7);assert.equal(await dock().locator('button:disabled').count(),6)
  await nav('视频处理');await pick(input);await scope().getByRole('button',{name:'选择媒体文件',exact:true}).click()
  await until(()=>page.evaluate(async()=>(await window.muxivra.playerState('single')).videoWidth===640))
  assert.equal(await dock().locator('button:disabled').count(),0)
  await page.evaluate(()=>window.muxivra.playerAction('single',{type:'seek',positionMs:1500}))
  await step('元数据');await scope().locator('.metadata-facts').waitFor({timeout:60000})
  assert.match(await scope().locator('.metadata-reader').innerText(),/MediaInfoLib/)
  await scope().locator('.metadata-tabs').getByRole('button',{name:'视频 1',exact:true}).click();assert.match(await scope().locator('.metadata-facts').innerText(),/640/)
  assert.ok((await page.evaluate(()=>window.muxivra.playerState('single'))).positionMs>=1400,'Step changes must keep position')
  const metadata=await page.evaluate(path=>window.muxivra.mediaMetadata(path),input);report.metadata={library:metadata.library,types:metadata.tracks.map(t=>t.type)}
  const ted=resolve('tests/media/TED演讲：神奇的斐波那契数列_P1_中英字幕.mp4')
  if(await stat(ted).catch(()=>null)){await pick(ted);await page.evaluate(()=>window.muxivra.selectFiles('media'));const real=await page.evaluate(path=>window.muxivra.mediaMetadata(path),ted);report.referenceMedia={library:real.library,tracks:real.tracks.map(t=>t.type)};assert.ok(real.tracks.some(t=>t.type==='Video'))}
  await step('尺寸');await scope().getByLabel('输出宽度（像素）',{exact:true}).fill('320')
  await step('交付');await pick(input);await scope().getByRole('button',{name:'选择输出目录',exact:true}).click();await scope().getByLabel('FFmpeg 执行命令',{exact:true}).waitFor()
  await pick(input);await scope().getByRole('button',{name:'更换文件',exact:true}).click();await scope().getByLabel('FFmpeg 执行命令',{exact:true}).waitFor({state:'hidden'});await scope().getByLabel('FFmpeg 执行命令',{exact:true}).waitFor()
  const command=scope().getByLabel('FFmpeg 执行命令',{exact:true}),generated=await command.inputValue()
  assert.match(generated,/scale=w=320/)
  await command.fill(generated.replace('"-crf" "22"','"-crf" "31"'))
  await step('元数据');await step('交付');assert.match(await command.inputValue(),/"-crf" "31"/,'Navigating without form edits must preserve command edits')
  await scope().getByRole('button',{name:'检查处理计划',exact:true}).click();await until(()=>scope().getByRole('button',{name:'开始处理',exact:true}).isEnabled())
  await scope().getByRole('button',{name:'开始处理',exact:true}).click()
  await until(()=>page.evaluate(async()=>{const job=(await window.muxivra.snapshot()).jobs[0];return job?.status==='completed'||job?.status==='failed'}))
  const video=await page.evaluate(async()=>{const job=(await window.muxivra.snapshot()).jobs[0];return window.muxivra.jobDetails(job.id)})
  assert.equal(video.status,'completed',video.error);assert.equal(video.plan.commandEdited,true);assert.equal(video.executedArgs[video.executedArgs.indexOf('-crf')+1],'31');assert.equal(video.plan.options.quality,22)
  const checked=JSON.parse((await exec('ffprobe',['-v','error','-show_streams','-of','json',video.plan.outputPath],{windowsHide:true})).stdout);assert.equal(checked.streams[0].width,320)
  await nav('音频处理');await pick(input);await scope().getByRole('button',{name:'选择媒体文件',exact:true}).click();await until(()=>scope().locator('.processing-filename').count())
  await step('歌词');await pick(lyrics);await scope().getByRole('button',{name:'导入歌词',exact:true}).click();await until(async()=>(await scope().getByLabel('歌词文本',{exact:true}).inputValue()).includes('第二句'))
  await step('增益');await choose('添加音频滤镜','volume');await scope().getByRole('button',{name:'添加',exact:true}).click();await scope().getByLabel(/ · volume$/).fill('0.5')
  await step('交付');await pick(input);await scope().getByRole('button',{name:'选择输出目录',exact:true}).click();await scope().getByLabel('FFmpeg 执行命令',{exact:true}).waitFor();assert.match(await scope().getByLabel('FFmpeg 执行命令',{exact:true}).inputValue(),/lyrics=/)
  await scope().getByRole('button',{name:'检查处理计划',exact:true}).click();await until(()=>scope().getByRole('button',{name:'开始处理',exact:true}).isEnabled());await scope().getByRole('button',{name:'开始处理',exact:true}).click()
  await until(()=>page.evaluate(async()=>(await window.muxivra.snapshot()).jobs.length===2&&(await window.muxivra.snapshot()).jobs.every(j=>['completed','failed'].includes(j.status))))
  const audio=await page.evaluate(async()=>(await window.muxivra.snapshot()).jobs.find(j=>j.plan.outputPath.endsWith('.m4a')))
  assert.equal(audio.status,'completed',audio.error)
  const audioProbe=JSON.parse((await exec('ffprobe',['-v','error','-show_streams','-show_format','-of','json',audio.plan.outputPath],{windowsHide:true})).stdout)
  assert.equal(audioProbe.streams.length,1);assert.equal(audioProbe.streams[0].codec_name,'aac');assert.match(audioProbe.format.tags.lyrics,/第二句/)
  for(const [width,height]of [[1440,900],[1040,720]]){
    await desktop.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setSize(size[0],size[1]),[width,height])
    for(const name of ['视频处理','音频处理','批量处理','字幕编辑','ASR 工作台']){await nav(name);await checkLayout(`${name}-${width}`)}
    await nav('视频处理');await step('元数据');await scope().locator('.metadata-facts').waitFor();await page.screenshot({path:`artifacts/qa/processing-${width}.png`})
  }
  assert.deepEqual(await readFile(input),original)
  assert.deepEqual(report.errors,[])
  report.result={separateWorkflows:true,fileGating:true,realMediaInfo:true,keepsPreviewPosition:true,editedCommandActuallyExecuted:true,videoResize:true,audioGain:true,lyricImportAndMux:true,allFivePagesNoWholeScroll:true,sourcePreserved:true}
  await writeFile('artifacts/qa/processing-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}catch(error){report.failure=error.stack;if(page){report.screen=await page.locator('body').innerText().catch(()=>undefined);await page.screenshot({path:'artifacts/qa/processing-failed.png'}).catch(()=>{})}await writeFile('artifacts/qa/processing-failed.json',JSON.stringify(report,null,2));throw error}
finally{await desktop.close().catch(()=>{});const local=relative(resolve('.test-data'),root);if(!local||local.startsWith('..')||isAbsolute(local))throw new Error('Unsafe smoke cleanup');await rm(root,{recursive:true,force:true})}
