import { randomUUID } from 'node:crypto'
import { mkdir,readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { JsonStore } from '../storage/json'
import type { McpActivity,McpActivityPage } from '../../shared/mcp-activity'
export function redactActivity(value:unknown,depth=0):unknown {
  if(depth>8)return '[depth limit]'
  if(typeof value==='string')return value.replace(/Bearer\s+[^\s"']+/gi,'Bearer [redacted]').replace(/https?:\/\/[^\s"'<>]+/gi,text=>{try{const url=new URL(text);url.username='';url.password='';url.search='';url.hash='';return url.href}catch{return '[URL]'}}).slice(0,8000)
  if(Array.isArray(value))return value.slice(0,100).map(item=>redactActivity(item,depth+1))
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,100).map(([key,item])=>[key,/token|password|secret|authorization|credential|api.?key/i.test(key)?'[redacted]':redactActivity(item,depth+1)]))
  return value
}
function bounded(value:unknown){const safe=redactActivity(value),json=JSON.stringify(safe);return json&&Buffer.byteLength(json)>24000?{truncated:true,preview:json.slice(0,8000)}:safe}
/** Fifty operations per durable page; no history pruning. Unknown outcomes never replay. */
export class McpActivityStore {
  private total=0
  private operations:Promise<unknown>=Promise.resolve()
  constructor(private root:string,private changed:()=>void){}
  private store(page:number){return new JsonStore<McpActivity[]>(join(this.root,String(page).padStart(9,'0')+'.json'))}
  private exclusive<T>(action:()=>Promise<T>):Promise<T>{const task=this.operations.catch(()=>{}).then(action);this.operations=task;return task}
  async initialize(){await mkdir(this.root,{recursive:true});const pages=(await readdir(this.root)).filter(name=>/^\d{9}\.json$/.test(name)).sort();for(const name of pages){const store=this.store(Number(name.slice(0,9))),records=await store.read([]);if(records.length>50)throw new Error('Invalid MCP activity page');this.total+=records.length;let changed=false;for(const record of records)if(record.status==='running'){record.status='interrupted';record.finishedAt=new Date().toISOString();changed=true}if(changed)await store.write(records)}}
  begin(request:unknown){return this.exclusive(async()=>{const data=request as {method?:string;params?:{name?:string}},sequence=this.total,page=Math.floor(sequence/50),store=this.store(page),records=await store.read([]),record:McpActivity={id:randomUUID(),sequence,createdAt:new Date().toISOString(),method:typeof data?.method==='string'?data.method:'invalid',name:typeof data?.params?.name==='string'?data.params.name:undefined,status:'running',request:bounded(request)};records.push(record);await store.write(records);this.total++;this.changed();return record})}
  finish(record:McpActivity,status:McpActivity['status'],response:unknown){return this.exclusive(async()=>{const store=this.store(Math.floor(record.sequence/50)),records=await store.read([]),current=records.find(item=>item.id===record.id);if(!current||current.status!=='running')return;Object.assign(current,{status,finishedAt:new Date().toISOString(),durationMs:Date.now()-Date.parse(current.createdAt),response:bounded(response)});await store.write(records);this.changed()})}
  async page(input=1):Promise<McpActivityPage>{await this.operations;const pages=Math.max(1,Math.ceil(this.total/50)),page=Math.max(1,Math.min(pages,Math.trunc(input)||1)),end=this.total-(page-1)*50,start=Math.max(0,end-50),records:McpActivity[]=[];for(let part=Math.floor(start/50);part<=Math.floor(Math.max(0,end-1)/50);part++)records.push(...await this.store(part).read([]));return {records:records.filter(item=>item.sequence>=start&&item.sequence<end).reverse(),page,pages,total:this.total}}
  async flush(){await this.operations}
}
