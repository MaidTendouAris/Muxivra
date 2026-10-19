import { execFile,type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir,realpath,stat } from 'node:fs/promises'
import { basename,dirname,join,resolve } from 'node:path'
import { homedir } from 'node:os'
import { trackChildTree,terminateChild } from '../jobs/process-control'
import type { PythonCandidate,PythonDiscovery } from '../../shared/asr-environments'
import { asrProcessEnvironment } from './storage'
const exec=promisify(execFile)
const probe=String.raw`import sys,json,importlib.metadata as m
names=['torch','torchaudio','transformers','accelerate','qwen-asr','moss-transcribe-diarize','safetensors']
packages={}
for name in names:
 try: packages[name]=m.version(name)
 except m.PackageNotFoundError: pass
print(json.dumps({'pythonPath':sys.executable,'version':'.'.join(map(str,sys.version_info[:3])),'prefix':sys.prefix,'isVenv':sys.prefix!=sys.base_prefix,'packages':packages}))`
export function discoveredPythonPaths(text:string){return [...text.matchAll(/[A-Za-z]:\\[^\r\n]*?python(?:\d+(?:\.\d+)?)?\.exe/gi)].map(match=>match[0].trim())}
async function execute(file:string,args:string[],signal:AbortSignal,root:string,timeout=7000){
  signal.throwIfAborted();const task=exec(file,args,{windowsHide:true,maxBuffer:2*1024**2,env:asrProcessEnvironment(root)}),child=task.child as ChildProcessWithoutNullStreams;let timedOut=false
  const abort=()=>terminateChild(child);trackChildTree(child);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();const timer=setTimeout(()=>{timedOut=true;abort()},timeout)
  try{const result=await task;if(timedOut)throw new Error('检测超时');return result.stdout}
  finally{clearTimeout(timer);signal.removeEventListener('abort',abort)}
}
export async function discoverPython(root:string,registered:string[],signal:AbortSignal,onUpdate:(state:PythonDiscovery)=>void):Promise<PythonDiscovery>{
  const state:PythonDiscovery={active:true,candidates:[],issues:[]};onUpdate(structuredClone(state))
  const candidates=new Map<string,{path:string;sources:Set<string>}>()
  const add=(path:string,source:string)=>{if(!path||candidates.size>=1024)return;const value=resolve(path);if(/WindowsApps/i.test(value))return;const key=value.toLowerCase();const current=candidates.get(key);if(current)current.sources.add(source);else candidates.set(key,{path:value,sources:new Set([source])})}
  for(const path of registered)add(path,'已注册环境')
  const home=homedir(),local=process.env.LOCALAPPDATA??join(home,'AppData','Local')
  for(const directory of (process.env.PATH??'').split(';').filter(Boolean)){add(join(directory.replace(/^"|"$/g,''),'python.exe'),'PATH')}
  for(const key of ['VIRTUAL_ENV','CONDA_PREFIX'])if(process.env[key])add(join(process.env[key]!,key==='VIRTUAL_ENV'?'Scripts':'','python.exe'),key)
  const children=async(directory:string,label:string,environment=false)=>{try{for(const entry of (await readdir(directory,{withFileTypes:true})).slice(0,100)){if(!entry.isDirectory())continue;add(join(directory,entry.name,environment?'Scripts':'','python.exe'),label);if(environment)add(join(directory,entry.name,'python.exe'),label)}}catch{}}
  await children(join(local,'Programs','Python'),'用户 Python 安装')
  for(const directory of [join(home,'miniconda3'),join(home,'anaconda3'),join(home,'miniforge3'),join(process.env.ProgramData??'C:\\ProgramData','miniconda3'),join(process.env.ProgramData??'C:\\ProgramData','anaconda3')]){add(join(directory,'python.exe'),'Conda');await children(join(directory,'envs'),'Conda 环境',true)}
  try{const {readFile}=await import('node:fs/promises');for(const path of (await readFile(join(home,'.conda','environments.txt'),'utf8')).split(/\r?\n/).filter(Boolean))add(join(path,'python.exe'),'Conda 环境')}catch{}
  await children(join(root,'environments'),'应用运行环境',true)
  const installation=dirname(root)
  for(const name of ['.venv','venv'])add(join(installation,name,'Scripts','python.exe'),'应用目录')
  // Discover only known local environment containers; never traverse a drive.
  for(const directory of [join(installation,'.runtime','asr-adapters'),join(installation,'.runtime','asr-python')])await children(directory,'应用目录中的环境',true)
  if(process.platform==='win32'){
    const system=join(process.env.SystemRoot??'C:\\Windows','System32')
    for(const command of [()=>execute(join(system,'where.exe'),['py.exe'],signal,root),()=>execute(join(system,'where.exe'),['conda.exe'],signal,root)]){
      try{const paths=(await command()).split(/\r?\n/).filter(Boolean);for(const path of paths.slice(0,3)){
        if(basename(path).toLowerCase()==='py.exe'){try{for(const python of discoveredPythonPaths(await execute(path,['-0p'],signal,root)))add(python,'Python 启动器')}catch{}}
        else add(join(dirname(dirname(path)),'python.exe'),'Conda')
      }}catch{}
    }
    let registryReadable=false
    for(const key of ['HKCU\\SOFTWARE\\Python','HKLM\\SOFTWARE\\Python','HKLM\\SOFTWARE\\WOW6432Node\\Python']){try{const text=await execute(join(system,'reg.exe'),['query',key,'/s'],signal,root);registryReadable=true;let installPath=false
      for(const line of text.split(/\r?\n/)){if(/^HKEY_/i.test(line.trim()))installPath=/\\InstallPath$/i.test(line.trim());const raw=line.match(/REG_(?:EXPAND_)?SZ\s+(.+)$/)?.[1]?.trim();if(!raw)continue;const value=raw.replace(/%([^%]+)%/g,(match,name)=>process.env[name]??match).replace(/^"|"$/g,'');for(const path of discoveredPythonPaths(value))add(path,'系统注册');if(installPath&&/^[A-Za-z]:\\/.test(value)&&!value.toLowerCase().endsWith('.exe'))add(join(value,'python.exe'),'系统注册')}
    }catch{}}
    if(!registryReadable)state.issues.push('系统 Python 注册项不存在或无法读取；已继续检测其他来源。')
  }
  const existing:typeof candidates extends Map<string,infer V>?V[]:never=[]
  for(const candidate of candidates.values()){signal.throwIfAborted();try{const canonical=await realpath(candidate.path);if((await stat(canonical)).isFile()){candidate.path=canonical;const duplicate=existing.find(e=>e.path.toLowerCase()===canonical.toLowerCase());if(duplicate)for(const source of candidate.sources)duplicate.sources.add(source);else if(existing.length<64)existing.push(candidate)}}catch{}}
  let index=0
  const worker=async()=>{while(index<existing.length){const value=existing[index++];signal.throwIfAborted();let candidate:PythonCandidate
    try{const data=JSON.parse((await execute(value.path,['-I','-B','-c',probe],signal,root,10000)).trim());if(!data.version||!data.prefix||!data.pythonPath)throw new Error('未返回有效 Python 信息');const packages:Record<string,string>=data.packages??{}
      const major=Number(packages.transformers?.split('.')[0]??0),base=['torch','torchaudio','transformers','accelerate','safetensors'].every(name=>!!packages[name]),backends=[]
      if(base&&packages['qwen-asr']&&major===4)backends.push('qwen3-asr');if(base&&packages['moss-transcribe-diarize']&&major===5)backends.push('moss-transcribe-diarize')
      candidate={pythonPath:value.path,name:`Python ${data.version}${data.isVenv?' · 虚拟环境':''}`,version:data.version,prefix:data.prefix,isVenv:!!data.isVenv,sources:[...value.sources],packages,backends}
    }catch(error){if(signal.aborted)throw error;candidate={pythonPath:value.path,name:basename(dirname(value.path)),version:'无法读取',prefix:dirname(value.path),isVenv:false,sources:[...value.sources],packages:{},backends:[],issue:(error as Error).message.slice(0,500)}}
    state.candidates.push(candidate);onUpdate(structuredClone(state))
  }}
  try{await Promise.all([worker(),worker(),worker()]);state.candidates.sort((a,b)=>Number(!!b.backends.length)-Number(!!a.backends.length)||a.pythonPath.localeCompare(b.pythonPath));state.checkedAt=new Date().toISOString();return state}
  finally{state.active=false;onUpdate(structuredClone(state))}
}
