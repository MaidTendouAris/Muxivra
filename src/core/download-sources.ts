import { createHash } from 'node:crypto'
import { JsonStore } from './storage/json'
import { downloadSourcesSchema,officialSources,sourceUrl,type DownloadSources,type DownloadSourceState } from '../shared/download-sources'
let configuration:DownloadSources=downloadSourcesSchema.parse({})
export const resolveDownloadSource=(url:string)=>sourceUrl(url,configuration)
export function setDownloadSources(value:DownloadSources){configuration=downloadSourcesSchema.parse(value)}
export class DownloadSourceStore {
  private configuration=downloadSourcesSchema.parse({})
  private operations:Promise<unknown>=Promise.resolve()
  private store:JsonStore<DownloadSources>
  constructor(path:string,private changed:()=>void){this.store=new JsonStore(path)}
  async initialize(){this.configuration=downloadSourcesSchema.parse(await this.store.read(this.configuration));setDownloadSources(this.configuration)}
  state():DownloadSourceState{return {configuration:structuredClone(this.configuration),revision:createHash('sha256').update(JSON.stringify(this.configuration)).digest('hex'),official:officialSources}}
  save(value:DownloadSources,revision:string){const task=this.operations.catch(()=>{}).then(async()=>{if(this.state().revision!==revision)throw new Error('下载源已更改，请重新读取后提交');const parsed=downloadSourcesSchema.parse(value);await this.store.write(parsed);this.configuration=parsed;setDownloadSources(parsed);this.changed();return this.state()});this.operations=task;return task}
}
