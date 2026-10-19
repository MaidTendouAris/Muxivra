import { z } from 'zod'

export const pythonAsrBackends=['qwen3-asr','moss-transcribe-diarize'] as const
export type PythonAsrBackend=typeof pythonAsrBackends[number]
export const asrBackendLabels:Record<string,string>={'whisper.cpp':'Whisper · whisper.cpp',custom:'自定义 JSONL 后端','qwen3-asr':'Qwen3-ASR','moss-transcribe-diarize':'MOSS-Transcribe-Diarize'}
export interface AsrParameter {key:string;label:string;group:string;type:'number'|'boolean'|'select';defaultValue:string|number|boolean;min?:number;max?:number;step?:number;choices?:[string,string][];hint?:string}
const number=(key:string,label:string,group:string,value:number,min:number,max:number,step=1):AsrParameter=>({key,label,group,type:'number',defaultValue:value,min,max,step})
const toggle=(key:string,label:string,group:string,value:boolean,hint?:string):AsrParameter=>({key,label,group,type:'boolean',defaultValue:value,hint})
const select=(key:string,label:string,group:string,value:string,choices:[string,string][],hint?:string):AsrParameter=>({key,label,group,type:'select',defaultValue:value,choices,hint})
export const quantizedAsrPrecisions=['fp4','nf4','fp8','int8'] as const
export function isQuantizedAsrPrecision(value:unknown){return quantizedAsrPrecisions.includes(value as typeof quantizedAsrPrecisions[number])}
export function asrPrecisionLabel(backend:string,p:Record<string,string|number|boolean>={}){if(backend==='whisper.cpp')return 'GGML 文件精度';if(backend==='custom')return '后端自行管理';const labels:Record<string,string>={auto:'自动',float32:'FP32',float16:'FP16',bfloat16:'BF16'};return (labels[String(p.dtype??'auto')]??String(p.dtype).toUpperCase())+(isQuantizedAsrPrecision(p.dtype)?' 权重 · '+(labels[String(p.quantComputeDtype??'auto')]??'自动')+'计算':'')}
export function asrPrecisionIssue(backend:string,p:Record<string,string|number|boolean>,device:string){if(!pythonAsrBackends.includes(backend as PythonAsrBackend))return undefined;if(isQuantizedAsrPrecision(p.dtype)&&p.implementation==='vllm')return '当前量化精度配置用于 Transformers；vLLM 请使用自动/FP16/BF16/FP32。';if(['fp4','nf4','int8'].includes(String(p.dtype))&&device==='cpu')return 'FP4/NF4/INT8 当前需要 NVIDIA CUDA GPU，请选择 GPU 或使用 FP8/FP16/BF16/FP32。';return undefined}
const loading:AsrParameter[]=[select('dtype','模型精度','精度与量化','auto',[['auto','自动（GPU FP16 / CPU FP32）'],['fp4','FP4 · 4 位浮点权重'],['nf4','NF4 · 4 位归一化权重'],['fp8','FP8 · 8 位浮点权重'],['int8','INT8 · 8 位整数权重'],['float16','FP16'],['bfloat16','BF16'],['float32','FP32']],'量化压缩符合条件的线性层权重；音频编码器、输出层与对齐器保留计算精度。不会将 KV 缓存或全部计算降为 4/8 位。'),select('quantComputeDtype','计算／未量化层精度','精度与量化','auto',[['auto','自动'],['float16','FP16'],['bfloat16','BF16'],['float32','FP32']],'FP4/NF4 使用 bitsandbytes，FP8 使用 Quanto 权重量化；FP8 不要求显卡具备原生 FP8 Tensor Core。'),toggle('doubleQuant','嵌套量化','精度与量化',true,'仅 FP4/NF4：压缩量化常数，进一步减少权重占用。'),select('attention','注意力实现','模型加载','sdpa',[['sdpa','SDPA'],['eager','Eager'],['flash_attention_2','FlashAttention 2']],'FlashAttention 2 需要另行安装且设备支持。'),number('gpuIndex','GPU 序号','模型加载',0,0,63),{...number('gpuMemoryFraction','专用显存预算比例','显存管理',.9,.1,.95,.05),hint:'Transformers 推理的显存申请上限，同时按启动时可用显存预留余量；超限会停止。vLLM 使用其独立比例设置。'}]
export const asrParameterCatalog:Record<string,AsrParameter[]>={
  'whisper.cpp':[],custom:[],
  'qwen3-asr':[...loading,select('implementation','推理引擎','模型加载','transformers',[['transformers','Transformers'],['vllm','vLLM（需要独立安装）']]),number('maxNewTokens','最大生成 Token','识别',4096,1,65536),number('batchSize','推理批次上限','识别',1,1,256),toggle('timestamps','返回词级时间戳','对齐',false,'需要在运行环境中指定 Qwen3-ForcedAligner。关闭时保留未打轴文本。'),select('alignerDevice','对齐设备','对齐','cpu',[['cpu','CPU'],['same','与识别相同']]),number('cueMaxChars','字幕条目最大字符数','字幕初稿',72,1,500),number('cueMaxSeconds','字幕条目最长时长（秒）','字幕初稿',8,.25,120,.25),number('gpuMemoryUtilization','vLLM 显存比例','vLLM',.7,.1,.95,.01),number('maxModelLength','vLLM 上下文上限','vLLM',32768,256,131072),number('tensorParallelSize','vLLM 张量并行数','vLLM',1,1,16)],
  'moss-transcribe-diarize':[...loading,select('cacheStrategy','KV 缓存位置','显存管理','auto',[['auto','自动（长上下文按预算转至 CPU）'],['dynamic','GPU'],['offloaded','CPU 内存']],'保留完整上下文；CPU 缓存节省显存，但可能降低生成速度。'),{...number('audioEncoderBatchSize','音频编码批次上限','显存管理',1,1,8),hint:'只对模型内部独立特征窗口分批计算，识别仍使用完整音频与上下文。'},number('maxNewTokens','最大生成 Token','识别',8192,1,65536),number('maxInputLength','最大输入 Token','识别',131072,256,262144),toggle('doSample','启用采样','采样',false),number('temperature','Temperature','采样',.7,.01,2,.01),number('topP','Top P','采样',.9,.01,1,.01),number('topK','Top K','采样',50,0,1000),number('repetitionPenalty','重复惩罚','生成',1,.1,3,.05),number('numBeams','Beam 数','生成',1,1,20),toggle('useCache','使用 KV 缓存','生成',true)],
}
export function parseAsrParameters(backend:string,value:unknown={}) {
  if(!asrParameterCatalog[backend])throw new Error('模型后端暂不支持')
  const shape:Record<string,z.ZodType>={}
  for(const field of asrParameterCatalog[backend]??[]){let schema:z.ZodType=field.type==='boolean'?z.boolean():field.type==='select'?z.enum(field.choices!.map(c=>c[0]) as [string,...string[]]):field.step===1?z.number().int().min(field.min!).max(field.max!):z.number().finite().min(field.min!).max(field.max!);shape[field.key]=schema.default(field.defaultValue)}
  const result=z.object(shape).strict().parse(value??{}) as Record<string,string|number|boolean>
  const issue=asrPrecisionIssue(backend,result,'auto');if(issue)throw new Error(issue)
  return result
}
