import { describe,it,expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir,mkdtemp,writeFile,readFile,rm } from 'node:fs/promises'
import { resolve,join } from 'node:path'
import { asrBackends,asrSubtitleCues,asrRecognitionSchema } from '../../src/shared/asr'
import { parseAsrParameters,asrPrecisionIssue,asrPrecisionLabel } from '../../src/shared/asr-parameters'
import { AsrModels } from '../../src/core/asr/models'
import { isWithin } from '../../src/core/media/paths'
describe('ASR native adapters',()=>{
  it('accepts actual FP4 through FP32 choices, preserves legacy dtype, and rejects incompatible engines/devices',()=>{
    for(const dtype of ['fp4','nf4','fp8','int8','float16','bfloat16','float32'])expect(parseAsrParameters('qwen3-asr',{dtype}).dtype).toBe(dtype)
    expect(parseAsrParameters('moss-transcribe-diarize',{dtype:'fp4',quantComputeDtype:'bfloat16',doubleQuant:false})).toMatchObject({dtype:'fp4',quantComputeDtype:'bfloat16',doubleQuant:false})
    expect(()=>parseAsrParameters('qwen3-asr',{dtype:'fp8',implementation:'vllm'})).toThrow('Transformers')
    expect(asrPrecisionIssue('qwen3-asr',{dtype:'fp4'},'cpu')).toContain('NVIDIA');expect(asrPrecisionIssue('moss-transcribe-diarize',{dtype:'fp8'},'cpu')).toBeUndefined()
    expect(asrPrecisionLabel('qwen3-asr',{dtype:'fp4',quantComputeDtype:'float16'})).toBe('FP4 权重 · FP16计算');expect(asrPrecisionLabel('whisper.cpp')).toBe('GGML 文件精度')
    expect(()=>parseAsrParameters('moss-transcribe-diarize',{dtype:'fp3'})).toThrow();expect(()=>parseAsrParameters('qwen3-asr',{quantComputeDtype:'fp4'})).toThrow()
  })
  it('keeps backend options distinct and validates bounds instead of forwarding unknown options',()=>{
    expect(asrBackends).toContain('qwen3-asr');expect(asrBackends).toContain('moss-transcribe-diarize');expect(asrBackends).not.toContain('mimo-v2.5-asr')
    expect(parseAsrParameters('qwen3-asr')).toMatchObject({batchSize:1,timestamps:false,maxNewTokens:4096})
    expect(parseAsrParameters('moss-transcribe-diarize')).toMatchObject({gpuMemoryFraction:.9,cacheStrategy:'auto',audioEncoderBatchSize:1})
    expect(()=>parseAsrParameters('moss-transcribe-diarize',{audioEncoderBatchSize:0})).toThrow();expect(()=>parseAsrParameters('qwen3-asr',{gpuMemoryFraction:1})).toThrow()
    expect(()=>parseAsrParameters('qwen3-asr',{topP:.8})).toThrow();expect(()=>parseAsrParameters('moss-transcribe-diarize',{maxInputLength:0})).toThrow();expect(()=>parseAsrParameters('mimo-v2.5-asr',{minNewTokens:8192,maxNewTokens:8192})).toThrow()
    expect(asrRecognitionSchema.parse({}).chunkingEnabled).toBe(false)
  })
  it('preserves speakers and marks untimed/estimated text accurately in ASS cues',()=>{
    const cues=asrSubtitleCues([{text:'Native timestamp',speaker:'S01',startMs:123,endMs:1987},{text:'Untimed text',speaker:'S02'},{text:'Estimated',speaker:'S03',startMs:0,endMs:1000,estimated:true}],()=>randomUUID())
    expect(cues[0]).toMatchObject({name:'S01',startMs:123,endMs:1987});expect(cues[1]).toMatchObject({comment:true,name:'S02 · ASR 未打轴'});expect(cues[2].name).toBe('S03 · ASR 估算')
  })
  it('persists model settings and environment bindings; deleting records leaves files intact',async()=>{
    await mkdir('.test-data',{recursive:true});const root=await mkdtemp(resolve('.test-data','asr-adapter-')),id=randomUUID(),environment={id,name:'Fixture environment',backend:'qwen3-asr',pythonPath:process.execPath,createdAt:new Date().toISOString(),probe:{ready:true,python:'fixture',platform:'win32',versions:{},cudaAvailable:false,devices:[],issues:[],warnings:[],checkedAt:new Date().toISOString(),vllm:false}}
    const models=new AsrModels(root,()=>{}),directory=join(root,'weights')
    try{
      await mkdir(join(root,'asr'),{recursive:true});await writeFile(join(root,'asr','models.json'),JSON.stringify({version:1,models:[],runtimes:[],environments:[environment]}));await mkdir(directory);await writeFile(join(directory,'config.json'),JSON.stringify({model_type:'qwen3_asr'}));await writeFile(join(directory,'model.safetensors'),'fixture weights');await models.initialize()
      const model=await models.import({name:'Qwen fixture',backend:'qwen3-asr',modelPath:directory,environmentId:id});expect(models.get(model.id).environment?.id).toBe(id)
      await models.saveRecognition(model.id,asrRecognitionSchema.parse({device:'cpu',parameters:{batchSize:2}}));expect(models.get(model.id).recognition?.parameters).toMatchObject({batchSize:2,maxNewTokens:4096})
      await expect(models.removeEnvironment(id)).rejects.toThrow('仍有模型');await expect(models.saveEnvironment({id,name:environment.name,backend:'moss-transcribe-diarize',pythonPath:process.execPath})).rejects.toThrow('不能更改后端')
      await models.remove(model.id);await models.removeEnvironment(id);expect(await readFile(join(directory,'model.safetensors'),'utf8')).toBe('fixture weights');expect(models.state().environments).toEqual([])
    }finally{await models.shutdown();if(!isWithin(resolve('.test-data'),root))throw new Error('Unsafe cleanup');await rm(root,{recursive:true,force:true})}
  })
})
