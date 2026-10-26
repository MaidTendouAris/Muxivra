import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { mkdir,readFile,readdir,stat,unlink } from 'node:fs/promises'
import { JsonStore } from '../storage/json'
/** Bounded disposable analysis only. Never traverses or removes project assets. */
export class AnalysisCache{
  constructor(readonly directory:string){}
  key(identity:unknown){return createHash('sha256').update(JSON.stringify(identity)).digest('hex')}
  async read<T>(key:string,validate:(value:unknown)=>T):Promise<T|undefined>{try{return validate(JSON.parse(await readFile(join(this.directory,key+'.json'),'utf8')))}catch{return undefined}}
  async write(key:string,value:unknown){await new JsonStore(join(this.directory,key+'.json')).write(value);await this.prune()}
  private async prune(){await mkdir(this.directory,{recursive:true});const files=await Promise.all((await readdir(this.directory)).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).map(async name=>({name,...await stat(join(this.directory,name))})));files.sort((a,b)=>b.mtimeMs-a.mtimeMs);let bytes=0;for(const [index,file]of files.entries()){bytes+=file.size;if(index>=256||bytes>128*1024*1024)await unlink(join(this.directory,file.name)).catch(()=>{})}}
}
