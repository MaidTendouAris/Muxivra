import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Engine, Job } from '../../shared/types'
import { JsonStore } from '../storage/json'

export const HISTORY_LIMIT = 1000
export const JOB_PAGE_SIZE = 50
export const isFinishedJob = (job:Job) => ['completed','failed','cancelled','interrupted'].includes(job.status)
interface Index { version:1; pageSize:50; pages:string[] }
interface Page { engines:Record<string,Engine>; jobs:(Omit<Job,'plan'> & {engineKey:string;plan:Omit<Job['plan'],'engine'>})[] }
const pageName = /^page-[a-f0-9]{64}\.json$/

// Immutable pages are written first. Replacing the index atomically commits the
// new generation; an interrupted write cannot expose a partial history.
export class JobHistoryStore {
  private operations:Promise<void> = Promise.resolve()
  private index:JsonStore<Index | undefined>
  readonly directory:string
  constructor(readonly dataPath:string) { this.directory=join(dataPath,'job-history');this.index=new JsonStore(join(this.directory,'index.json')) }
  async read():Promise<Job[]> {
    const index=await this.index.read(undefined)
    if(!index)return new JsonStore<Job[]>(join(this.dataPath,'jobs.json')).read([])
    if(index.version!==1||index.pageSize!==JOB_PAGE_SIZE||!Array.isArray(index.pages)||index.pages.some(p=>!pageName.test(p)))throw new Error('任务历史索引无效，请保留文件并检查')
    const pages=await Promise.all(index.pages.map(async name=>{
      const json=await readFile(join(this.directory,name),'utf8')
      if(name!==`page-${createHash('sha256').update(json).digest('hex')}.json`)throw new Error('任务历史分页校验失败，请保留文件并检查')
      const page=JSON.parse(json) as Page
      if(!Array.isArray(page.jobs)||page.jobs.length>JOB_PAGE_SIZE)throw new Error('任务历史分页无效，请保留文件并检查')
      return page.jobs.map(({engineKey,plan,...job})=>{const engine=page.engines[engineKey];if(!engine)throw new Error('任务历史缺少引擎记录');return {...job,plan:{...plan,engine}} as Job})
    }))
    return pages.flat()
  }
  write(jobs:Job[]):Promise<void> {
    const pages:{name:string;json:string}[]=[],engines=new Map<Engine,{key:string;engine:Engine}>()
    for(let offset=0;offset<jobs.length;offset+=JOB_PAGE_SIZE){
      const page:Page={engines:{},jobs:[]}
      page.jobs=jobs.slice(offset,offset+JOB_PAGE_SIZE).map(job=>{
        let item=engines.get(job.plan.engine)
        if(!item){item={key:createHash('sha256').update(JSON.stringify(job.plan.engine)).digest('hex'),engine:job.plan.engine};engines.set(job.plan.engine,item)}
        page.engines[item.key]=item.engine
        const {engine:_,...plan}=job.plan
        return {...job,plan,engineKey:item.key}
      })
      const json=JSON.stringify(page,null,2),name=`page-${createHash('sha256').update(json).digest('hex')}.json`
      pages.push({name,json})
    }
    const operation=this.operations.catch(()=>{}).then(async()=>{
      await mkdir(this.directory,{recursive:true})
      for(const page of pages){
        try{const existing=await readFile(join(this.directory,page.name),'utf8');if(existing!==page.json)throw new Error('任务历史分页校验失败')}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await new JsonStore<Page>(join(this.directory,page.name)).write(JSON.parse(page.json))}
      }
      await this.index.write({version:1,pageSize:JOB_PAGE_SIZE,pages:pages.map(p=>p.name)})
      await unlink(join(this.dataPath,'jobs.json')).catch(()=>{})
      const current=new Set(pages.map(p=>p.name))
      // Cleanup follows the commit. A cleanup failure must not report that the
      // committed generation failed, or callers could restore stale records.
      for(const file of await readdir(this.directory).catch(()=>[]))if(pageName.test(file)&&!current.has(file))await unlink(join(this.directory,file)).catch(()=>{})
    })
    this.operations=operation;return operation
  }
  async flush():Promise<void>{await this.operations}
}
