import assert from 'node:assert/strict'

export async function createProject(page,desktop,source,{subtitle,deleteOriginal=false,name,resolution,format,target='subtitles',creationTimeout=60000}={}) {
  await page.locator('.navigation').getByRole('button',{name:'项目管理',exact:true}).click()
  await page.getByRole('button',{name:'新建项目',exact:true}).click()
  const pick=file=>desktop.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]})},file)
  await pick(source);await page.getByRole('button',{name:'选择媒体',exact:true}).click()
  const check=page.getByLabel('导入后删除原文件',{exact:true});assert.equal(await check.isChecked(),false)
  if(deleteOriginal)await check.check()
  if(name)await page.getByLabel('项目名称',{exact:true}).fill(name)
  if(subtitle){await pick(subtitle);await page.getByRole('button',{name:'选择字幕',exact:true}).click()}
  if(resolution){await page.getByLabel('字幕画面尺寸',{exact:true}).click();await page.getByRole('option',{name:'自定义',exact:true}).click();await page.getByLabel('字幕画面宽度',{exact:true}).fill(String(resolution.width));await page.getByLabel('字幕画面高度',{exact:true}).fill(String(resolution.height))}
  if(format){await page.getByLabel('默认导出格式',{exact:true}).click();await page.getByRole('option',{name:format.toUpperCase(),exact:true}).click()}
  await page.screenshot({path:'artifacts/qa/project-create.png',fullPage:true})
  await page.getByLabel('创建后打开',{exact:true}).click()
  await page.getByRole('option',{name:target==='subtitles'?'字幕编辑':target==='asr'?'ASR 工作台':'留在项目管理',exact:true}).click()
  await page.getByRole('button',{name:'创建项目',exact:true}).click()
  await page.locator('.project-create-page').waitFor({state:'hidden',timeout:creationTimeout})
  const snapshot=await page.evaluate(()=>window.muxivra.snapshot())
  const project=snapshot.projects.items.find(p=>p.id===snapshot.projects.activeId)
  assert.ok(project,'Creation must activate the new managed project')
  return project
}
