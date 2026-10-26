import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { mkdir,mkdtemp,writeFile,readFile,rm } from 'node:fs/promises'
import { join,resolve,relative,isAbsolute,sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

await mkdir('.test-data',{recursive:true});await mkdir('artifacts/qa',{recursive:true})
const root=await mkdtemp(resolve('.test-data','asr-config-')),profile=join(root,'profile'),createdAt=new Date().toISOString()
const deployed=JSON.parse(await readFile('.runtime/asr-deployment-validation/asr/models.json','utf8')).environments
const manualFixture=backend=>{const {managed,...environment}=deployed.find(value=>value.backend===backend);return environment}
const qwen=manualFixture('qwen3-asr'),moss=manualFixture('moss-transcribe-diarize')
for(const [directory,type]of [['qwen','qwen3_asr'],['moss','moss_transcribe_diarize']]){await mkdir(join(root,directory));await writeFile(join(root,directory,'config.json'),JSON.stringify({model_type:type}));await writeFile(join(root,directory,'model.safetensors'),'Structural fixture only; no model inference.')}
await mkdir(join(profile,'asr'),{recursive:true});await writeFile(join(profile,'asr','models.json'),JSON.stringify({version:1,models:[],runtimes:[],environments:[qwen,moss]}))
const report={executable:process.env.MUXIVRA_EXECUTABLE||'development build',errors:[],layouts:[]}
const launch=()=>electron.launch({executablePath:process.env.MUXIVRA_EXECUTABLE||electronPath,args:process.env.MUXIVRA_EXECUTABLE?[]:['.'],cwd:process.cwd(),env:{...process.env,MUXIVRA_SMOKE:'1',MUXIVRA_DATA_PATH:profile,MUXIVRA_ENGINE_PATH:join(root,'engines')},timeout:60000})
let desktop=await launch(),page
try{
  page=await desktop.firstWindow();page.on('pageerror',e=>report.errors.push(e.message))
  await page.getByRole('heading',{name:'视频处理',exact:true}).waitFor({timeout:60000})
  const nav=()=>page.locator('.navigation').getByRole('button',{name:'ASR 工作台',exact:true}).click()
  const resources=()=>page.locator('.navigation').getByRole('button',{name:'资源管理',exact:true}).click()
  const choose=async(label,value)=>{await page.getByLabel(label,{exact:true}).click();await page.getByRole('option',{name:value,exact:true}).click()}
  const pick=path=>desktop.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]})},path)
  const importModel=async(backend,name,directory)=>{
    await resources();await page.locator('.resource-dock').getByRole('button',{name:'ASR',exact:true}).click()
    await page.getByRole('button',{name:'导入模型',exact:true}).click();await choose('后端类型',backend+' · Python');await page.getByLabel('模型名称',{exact:true}).fill(name);await pick(directory);await page.getByRole('button',{name:'选择文件并导入',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});await page.locator('.resource-staged-card').filter({hasText:name}).getByRole('button',{name:'使用已有环境',exact:true}).click();await page.getByRole('button',{name:'启用模型',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});await page.locator('.resource-model-card').filter({hasText:name}).waitFor()
  }
  await resources();await page.locator('.resource-dock').getByRole('button',{name:'环境',exact:true}).click()
  await page.getByRole('heading',{name:'已安装运行环境',exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'添加已有环境',exact:true}).count(),1)
  const qwenCard=page.locator('.resource-environment-card').filter({hasText:qwen.name})
  await qwenCard.locator('summary').click();await qwenCard.getByText('transformers',{exact:true}).waitFor();assert.equal(await qwenCard.locator('.resource-version-grid').count(),1)
  await qwenCard.getByRole('button',{name:'检查环境',exact:true}).click();let refreshed
  for(const deadline=Date.now()+90000;Date.now()<deadline;){const current=await page.evaluate(async id=>(await window.muxivra.snapshot()).asr.environments.find(value=>value.id===id),qwen.id);if(current.probe?.checkedAt!==qwen.probe?.checkedAt){refreshed=current;break}await new Promise(done=>setTimeout(done,100))}
  assert.equal(refreshed?.probe?.ready,true,JSON.stringify(refreshed?.probe));await qwenCard.getByRole('button',{name:'检查环境',exact:true}).waitFor({timeout:90000})
  await page.getByRole('button',{name:'添加已有环境',exact:true}).click();await page.getByLabel('环境名称',{exact:true}).fill('Invalid environment fixture');await page.getByLabel('Python 可执行文件',{exact:true}).fill(process.execPath)
  await page.getByRole('button',{name:'保存并检查',exact:true}).click()
  const bad=page.locator('.resource-environment-card').filter({hasText:'Invalid environment fixture'});await bad.waitFor({timeout:30000});assert.ok(await bad.innerText().then(t=>t.includes('待配置')))
  assert.ok(await bad.locator('.error-inline').count()>0)
  await bad.getByRole('button',{name:'移除环境 Invalid environment fixture',exact:true}).click();await page.getByRole('button',{name:'移除记录',exact:true}).click();await bad.waitFor({state:'hidden'})
  await importModel('Qwen3-ASR','Qwen UI configuration',join(root,'qwen'))
  assert.equal(await page.getByLabel('语言代码',{exact:true}).count(),0);assert.equal(await page.getByLabel('识别音轨',{exact:true}).count(),0)
  await page.locator('.resource-model-card').filter({hasText:'Qwen UI configuration'}).getByRole('button',{name:'配置识别参数',exact:true}).click()
  await page.getByLabel('语言代码',{exact:true}).fill('en');await choose('计算设备','CPU');await page.getByLabel('返回词级时间戳',{exact:true}).check();await page.getByLabel('最大生成 Token',{exact:true}).fill('7000');await page.getByLabel('字幕条目最大字符数',{exact:true}).fill('80');await page.getByLabel('专用显存预算比例',{exact:true}).fill('0.8')
  await choose('推理引擎','vLLM（需要独立安装）');assert.equal(await page.getByLabel('vLLM 显存比例',{exact:true}).count(),1);await choose('推理引擎','Transformers');assert.equal(await page.getByLabel('vLLM 显存比例',{exact:true}).count(),0)
  for(const [label,quantized] of [['FP4 · 4 位浮点权重',true],['NF4 · 4 位归一化权重',true],['FP8 · 8 位浮点权重',true],['INT8 · 8 位整数权重',true],['FP16',false],['BF16',false],['FP32',false]]){await choose('模型精度',label);assert.equal(await page.getByLabel('计算／未量化层精度',{exact:true}).count(),quantized?1:0)}
  await choose('模型精度','FP4 · 4 位浮点权重');assert.ok(await page.locator('.error-inline').filter({hasText:'NVIDIA'}).count());await choose('计算设备','GPU');await choose('计算／未量化层精度','BF16');await page.getByLabel('嵌套量化',{exact:true}).uncheck()
  for(const [width,height,theme] of [[1440,900,'light'],[1040,720,'dark']]){
    await desktop.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().includes('devtools'))?.setSize(size.width,size.height),{width,height})
    await page.evaluate(async theme=>{const s=await window.muxivra.snapshot();await window.muxivra.saveSettings({...s.settings,theme})},theme)
    await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme)
    const layout=await page.evaluate(()=>({width:innerWidth,total:document.documentElement.scrollWidth}));report.layouts.push({...layout,theme});assert.ok(layout.total<=layout.width)
    await page.screenshot({path:`artifacts/qa/asr-parameters-${theme}.png`,fullPage:true})
  }
  await page.getByRole('button',{name:'应用配置',exact:true}).click();await page.locator('.resource-model-card').filter({hasText:'Qwen UI configuration'}).waitFor()
  await importModel('MOSS-Transcribe-Diarize','MOSS UI configuration',join(root,'moss'))
  await page.locator('.resource-model-card').filter({hasText:'MOSS UI configuration'}).getByRole('button',{name:'配置识别参数',exact:true}).click();assert.equal(await page.getByLabel('返回词级时间戳',{exact:true}).count(),0);await choose('模型精度','FP8 · 8 位浮点权重');await choose('计算／未量化层精度','FP16');assert.equal(await page.getByLabel('嵌套量化',{exact:true}).count(),0);await page.getByLabel('启用采样',{exact:true}).check();await page.getByLabel('Temperature',{exact:true}).fill('0.6');await choose('KV 缓存位置','CPU 内存');await page.getByLabel('音频编码批次上限',{exact:true}).fill('2');await page.getByLabel('重复惩罚',{exact:true}).fill('1.1');await page.getByRole('button',{name:'应用配置',exact:true}).click()
  await page.locator('.resource-model-card').filter({hasText:'Qwen UI configuration'}).getByRole('button',{name:'配置识别参数',exact:true}).click();assert.equal(await page.getByLabel('最大生成 Token',{exact:true}).inputValue(),'7000');assert.equal(await page.getByLabel('返回词级时间戳',{exact:true}).isChecked(),true)
  await page.getByRole('button',{name:'返回模型管理',exact:true}).click();await resources();await page.locator('.resource-dock').getByRole('button',{name:'环境',exact:true}).click()
  await page.screenshot({path:'artifacts/qa/asr-environments-dark.png',fullPage:true})
  assert.equal(await page.getByRole('button',{name:'移除环境 '+qwen.name,exact:true}).isDisabled(),true);await nav();assert.equal(await page.getByRole('button',{name:'配置识别参数',exact:true}).count(),0);await choose('当前模型','Qwen UI configuration')
  await desktop.close();desktop=await launch();page=await desktop.firstWindow();await page.getByRole('heading',{name:'视频处理',exact:true}).waitFor({timeout:60000});await nav()
  const state=await page.evaluate(async()=>(await window.muxivra.snapshot()).asr);assert.equal(state.models.length,2);assert.equal(state.environments.length,2)
  assert.equal(state.models.find(m=>m.backend==='qwen3-asr').recognition.parameters.maxNewTokens,7000);assert.equal(state.models.find(m=>m.backend==='moss-transcribe-diarize').recognition.parameters.repetitionPenalty,1.1);assert.equal(state.models.find(m=>m.backend==='moss-transcribe-diarize').recognition.parameters.cacheStrategy,'offloaded');assert.equal(state.models.find(m=>m.backend==='moss-transcribe-diarize').recognition.parameters.audioEncoderBatchSize,2);assert.equal(state.models.find(m=>m.backend==='qwen3-asr').recognition.parameters.gpuMemoryFraction,.8)
  assert.equal(state.models.find(m=>m.backend==='qwen3-asr').recognition.parameters.dtype,'fp4');assert.equal(state.models.find(m=>m.backend==='qwen3-asr').recognition.parameters.quantComputeDtype,'bfloat16');assert.equal(state.models.find(m=>m.backend==='qwen3-asr').recognition.parameters.doubleQuant,false);assert.equal(state.models.find(m=>m.backend==='moss-transcribe-diarize').recognition.parameters.dtype,'fp8')
  assert.deepEqual(report.errors,[])
  report.result={separatePages:true,modelSpecificFields:true,environmentDiagnostics:true,referencedEnvironmentProtected:true,perModelPersistence:true,restart:true,missingEnvironmentConfigurable:true,mainOverviewOnly:true}
  await writeFile('artifacts/qa/asr-config-smoke.json',JSON.stringify(report,null,2));console.log('ASR configuration smoke passed')
}catch(error){if(page){report.screen=await page.locator('body').innerText().catch(()=>undefined);report.asr=await page.evaluate(async()=>(await window.muxivra.snapshot()).asr).catch(()=>undefined);await page.screenshot({path:'artifacts/qa/asr-config-failed.png',fullPage:true}).catch(()=>{})}report.failure=error.stack;await writeFile('artifacts/qa/asr-config-failed.json',JSON.stringify(report,null,2));throw error}
finally{await desktop.close().catch(()=>{});const path=relative(resolve('.test-data'),root);if(!path||path.startsWith('..')||isAbsolute(path))throw new Error('Unsafe test cleanup');await rm(root,{recursive:true,force:true})}
