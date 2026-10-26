import { z } from 'zod'
export const sourceKinds=['github','codeload','python','pypi','pytorch','huggingface','modelscope'] as const
export type SourceKind=typeof sourceKinds[number]
export const officialSources:Record<SourceKind,string>={github:'https://github.com',codeload:'https://codeload.github.com',python:'https://releases.astral.sh/github',pypi:'https://pypi.org/simple',pytorch:'https://download.pytorch.org/whl',huggingface:'https://huggingface.co',modelscope:'https://modelscope.cn'}
const baseUrl=z.string().max(2048).url().refine(value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&!/\s/.test(value)}catch{return false}},'Use an HTTPS base URL without credentials, query or fragment').transform(value=>value.replace(/\/+$/,''))
export const downloadSourcesSchema=z.object({sources:z.array(z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),kind:z.enum(sourceKinds),name:z.string().trim().min(1).max(100),url:baseUrl}).strict()).max(40).default([]),active:z.partialRecord(z.enum(sourceKinds),z.string().max(64)).default({})}).strict().superRefine((value,ctx)=>{
  if(new Set(value.sources.map(item=>item.id)).size!==value.sources.length)ctx.addIssue({code:'custom',message:'Duplicate source ID'})
  for(const [kind,id] of Object.entries(value.active))if(id&&!value.sources.some(item=>item.id===id&&item.kind===kind))ctx.addIssue({code:'custom',message:'Selected source does not exist: '+kind})
})
export type DownloadSources=z.infer<typeof downloadSourcesSchema>
export interface DownloadSourceState {revision:string;configuration:DownloadSources;official:typeof officialSources}
export function sourceUrl(input:string,configuration:DownloadSources):string {
  const url=new URL(input)
  for(const kind of sourceKinds){const base=officialSources[kind],official=new URL(base),prefix=official.pathname.replace(/\/$/,'');if(url.origin!==official.origin||prefix&&url.pathname!==prefix&&!url.pathname.startsWith(prefix+'/'))continue
    const selected=configuration.sources.find(item=>item.id===configuration.active[kind]&&item.kind===kind);if(!selected)return input
    return selected.url+url.pathname.slice(prefix.length)+url.search
  }
  return input
}
