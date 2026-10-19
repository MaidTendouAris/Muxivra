import importlib.util
from pathlib import Path
import unittest
import io,json,contextlib
from unittest.mock import patch
from types import SimpleNamespace,ModuleType

spec = importlib.util.spec_from_file_location("adapter", Path(__file__).resolve().parents[1] / "resources/asr/adapter.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)

class AdapterTests(unittest.TestCase):
    def test_low_precision_config_preserves_compute_dtype_and_excludes_acoustic_encoder(self):
        transformers=ModuleType('transformers');transformers.BitsAndBytesConfig=lambda **values:values;transformers.QuantoConfig=lambda **values:values
        torch=SimpleNamespace(cuda=SimpleNamespace(get_device_capability=lambda device:(8,6)))
        with patch.dict('sys.modules',{'transformers':transformers}),patch.object(adapter.importlib.metadata,'version',return_value='installed'),patch.object(adapter,'progress'):
            for precision in ('fp4','nf4'):
                config=adapter.precision_loading('qwen3-asr',torch,'cuda:0','bf16',{'dtype':precision,'doubleQuant':False})['quantization_config']
                self.assertTrue(config['load_in_4bit']);self.assertEqual(config['bnb_4bit_quant_type'],precision);self.assertEqual(config['bnb_4bit_compute_dtype'],'bf16');self.assertFalse(config['bnb_4bit_use_double_quant']);self.assertIn('thinker.audio_tower',config['llm_int8_skip_modules'])
            fp8=adapter.precision_loading('moss-transcribe-diarize',torch,'cpu','fp32',{'dtype':'fp8'})['quantization_config']
            self.assertEqual(fp8['weights'],'float8');self.assertIn('model.whisper_encoder',fp8['modules_to_not_convert'])
            with self.assertRaisesRegex(ValueError,'NVIDIA'):adapter.precision_loading('qwen3-asr',torch,'cpu','fp32',{'dtype':'fp4'})
            with self.assertRaisesRegex(ValueError,'Transformers'):adapter.precision_loading('qwen3-asr',torch,'cuda:0','fp16',{'dtype':'fp8','implementation':'vllm'})
    def test_quantization_missing_dependency_has_repair_instruction_without_downgrade(self):
        with patch.object(adapter.importlib.metadata,'version',side_effect=importlib.metadata.PackageNotFoundError('bitsandbytes')):
            with self.assertRaisesRegex(RuntimeError,'bitsandbytes'):adapter.precision_loading('qwen3-asr',None,'cuda:0',None,{'dtype':'fp4'})
    def test_actual_quantization_must_match_request_and_preserve_encoder(self):
        model=SimpleNamespace(named_modules=lambda:[])
        with self.assertRaisesRegex(RuntimeError,'实际转换'):adapter.precision_report(model,'fp16',{'dtype':'fp4'})
        with self.assertRaisesRegex(RuntimeError,'预量化'):adapter.precision_report(SimpleNamespace(is_quantized=True),'fp32',{'dtype':'float32'})
        module=type('Linear4bit',(),{})();module.weight=SimpleNamespace(quant_state=SimpleNamespace(quant_type='nf4'))
        model.named_modules=lambda:[('thinker.model.layers.0.mlp.up_proj',module)]
        with self.assertRaisesRegex(RuntimeError,'不一致'):adapter.precision_report(model,'fp16',{'dtype':'fp4'})
        model.named_modules=lambda:[('thinker.audio_tower.layer',module)]
        with self.assertRaisesRegex(RuntimeError,'音频编码器'):adapter.precision_report(model,'fp16',{'dtype':'nf4'})
    def test_compute_does_not_pass_fp4_to_torch_dtype_and_preserves_legacy_precision(self):
        torch=ModuleType('torch');torch.cuda=SimpleNamespace(is_available=lambda:True,get_device_capability=lambda device:(8,6));torch.float16='f16';torch.float32='f32';torch.bfloat16='bf16';torch.set_num_threads=lambda count:None
        with patch.dict('sys.modules',{'torch':torch}):
            self.assertEqual(adapter.compute({'device':'gpu'},{'dtype':'fp4','quantComputeDtype':'bfloat16'})[2],'bf16')
            self.assertEqual(adapter.compute({'device':'cpu'},{'dtype':'auto'})[2],'f32')
            self.assertEqual(adapter.compute({'device':'gpu'},{'dtype':'float16'})[2],'f16')
            with self.assertRaisesRegex(ValueError,'精度'):adapter.compute({'device':'gpu'},{'dtype':'fp3'})
    def test_kv_estimate_includes_all_layers_heads_dtype_and_beams(self):
        config=SimpleNamespace(num_hidden_layers=28,num_key_value_heads=8,head_dim=128)
        self.assertEqual(adapter.kv_cache_bytes(SimpleNamespace(text_config=config),18754,2),2150858752)
        self.assertEqual(adapter.kv_cache_bytes(config,100,4,3),68812800)
    def test_budget_reserves_physical_memory_and_auto_offloads_long_context(self):
        gib=1024**3;fractions=[];logs=io.StringIO()
        cuda=SimpleNamespace(mem_get_info=lambda device:(3*gib,6*gib),memory_allocated=lambda device:2*gib,
            set_per_process_memory_fraction=lambda fraction,device:fractions.append(fraction),reset_peak_memory_stats=lambda device:None,
            memory_reserved=lambda device:2*gib,max_memory_allocated=lambda device:2*gib,max_memory_reserved=lambda device:2*gib)
        torch=SimpleNamespace(cuda=cuda,empty=lambda *args,**kwargs:SimpleNamespace(element_size=lambda:2))
        config=SimpleNamespace(num_hidden_layers=28,num_key_value_heads=8,head_dim=128)
        with patch('sys.stderr',logs),patch.object(adapter,'progress'),patch.object(adapter,'available_host_memory',return_value=32*gib):
            policy=adapter.CudaMemoryPolicy(torch,'cuda:0','fp16',{})
            # Existing allocations are part of the allocator cap; leave 8% physical headroom.
            self.assertAlmostEqual(fractions[0],4.52/6)
            self.assertEqual(policy.configure_cache(SimpleNamespace(config=config),18754,8192),'offloaded')
            self.assertEqual(policy.configure_cache(SimpleNamespace(config=config),200,512),'dynamic')
            self.assertIsNone(policy.configure_cache(SimpleNamespace(config=config),18754,8192,use_cache=False))
            with patch.object(adapter,'available_host_memory',return_value=gib),self.assertRaisesRegex(RuntimeError,'CPU KV'):
                policy.configure_cache(SimpleNamespace(config=config),18754,8192)
    def test_budget_never_expands_to_shared_memory_when_gpu_is_busy(self):
        gib=1024**3;fractions=[];logs=io.StringIO()
        cuda=SimpleNamespace(mem_get_info=lambda device:(2*gib,6*gib),memory_allocated=lambda device:0,
            set_per_process_memory_fraction=lambda fraction,device:fractions.append(fraction),reset_peak_memory_stats=lambda device:None,
            memory_reserved=lambda device:0,max_memory_allocated=lambda device:0,max_memory_reserved=lambda device:0)
        with patch('sys.stderr',logs):
            policy=adapter.CudaMemoryPolicy(SimpleNamespace(cuda=cuda),'cuda:0',None,{})
        self.assertLess(policy.limit,2*gib);self.assertLess(fractions[0],1/3)
    def test_loading_stage_does_not_invent_audio_progress(self):
        output=io.StringIO()
        with patch.object(adapter,'OUTPUT',output):adapter.progress(None,'loading')
        self.assertEqual(json.loads(output.getvalue())['percent'],0)
        self.assertTrue(json.loads(output.getvalue())['indeterminate'])
    def test_qwen_observer_counts_native_batches_preserves_results_and_restores_hooks(self):
        output=io.StringIO();calls=[];sentinel=object()
        class Generator:
            def generate(self,**kwargs):
                calls.append(kwargs)
                for criterion in kwargs.get('stopping_criteria',[]):
                    self.assert_false=criterion(None,None)
                return sentinel
        class Model:
            backend='transformers';max_inference_batch_size=1;forced_aligner=None
            def __init__(self):self.model=Generator()
            def _infer_asr(self,contexts,wavs,languages):return [self.model.generate() for _ in wavs]
        transformers=ModuleType('transformers');transformers.StoppingCriteria=type('StoppingCriteria',(),{});transformers.StoppingCriteriaList=list
        model=Model();original=model._infer_asr
        with patch.dict('sys.modules',{'transformers':transformers}),patch.object(adapter,'OUTPUT',output),adapter.observe_qwen_progress(model):
            result=model._infer_asr(['',''],[[0]*16000,[0]*32000],[None,None])
        self.assertEqual(result,[sentinel,sentinel]);self.assertEqual(len(calls),2);self.assertEqual(model._infer_asr,original)
        events=[json.loads(line) for line in output.getvalue().splitlines()]
        self.assertTrue(any(e['indeterminate'] and '\u89e3\u7801 1' in e['stage'] for e in events))
        self.assertTrue(any(abs(e['percent']-100/3)<.001 for e in events));self.assertEqual(events[-1]['completed'],3000);self.assertEqual(events[-1]['percent'],100)
    def test_qwen_observer_restores_native_methods_on_failure(self):
        generator=SimpleNamespace(generate=lambda **kwargs:(_ for _ in ()).throw(ValueError('native failure')))
        model=SimpleNamespace(model=generator,_infer_asr=lambda *args:None,forced_aligner=None,backend='vllm',max_inference_batch_size=1)
        original=generator.generate
        with self.assertRaises(ValueError),adapter.observe_qwen_progress(model):generator.generate()
        self.assertIs(generator.generate,original)
    def test_word_alignment_preserves_punctuation_and_milliseconds(self):
        words=[{"text":"Hello", "start_time":.123,"end_time":.689},{"text":"Fibonacci", "start_time":.789,"end_time":1.234}]
        result=adapter.qwen_segments("Hello, Fibonacci!",words)
        self.assertEqual(result[0]["text"],"Hello, Fibonacci!")
        self.assertEqual([result[0]["startMs"],result[0]["endMs"]],[123,1234])
    def test_missing_alignment_never_invents_time(self):
        self.assertEqual(adapter.qwen_segments("No timestamps",None),[{"text":"No timestamps"}])
        result=adapter.qwen_segments("Unmatched native text",[{"text":"different","start_time":.1,"end_time":.2}])
        self.assertEqual(result[0]["text"],"Unmatched native text")
        self.assertNotIn("startMs",result[0])
    def test_aligner_normalized_punctuation_preserves_original_text(self):
        words=[{"text":"twentyfive", "start_time":137.12,"end_time":137.92},
               {"text":"is", "start_time":138.08,"end_time":138.32},
               {"text":"fun", "start_time":138.32,"end_time":138.64}]
        result=adapter.qwen_segments("Twenty-five is fun!",words)
        self.assertEqual(result[0]["text"],"Twenty-five is fun!")
        self.assertEqual([result[0]["startMs"],result[0]["endMs"]],[137120,138640])
    def test_zero_duration_word_keeps_text_without_fabricating_word_times(self):
        result=adapter.qwen_segments('To learn.',[{"text":"to","start_time":1.52,"end_time":1.52},{"text":"learn","start_time":1.52,"end_time":2}])
        self.assertEqual(result[0]['text'],'To learn.')
        self.assertEqual(result[0]['words'],[{'text':'To learn.','startMs':1520,'endMs':2000}])
    def test_limits_group_using_real_word_bounds(self):
        words=[{"text":"One","start_time":.01,"end_time":.4},{"text":"two","start_time":2.55,"end_time":3.16}]
        result=adapter.qwen_segments("One two.",words,max_seconds=1)
        self.assertEqual(len(result),2)
        self.assertEqual(result[1]["startMs"],2550)
        self.assertEqual(result[1]["text"],"two.")
    def test_invalid_time_is_rejected(self):
        for value in [-1,float('nan'),float('inf')]:
            with self.assertRaises(ValueError):adapter.milliseconds(value)
    def test_moss_language_hint_is_not_reported_as_detected_language(self):
        class Model:
            generation_config=SimpleNamespace()
            @classmethod
            def from_pretrained(cls,*args,**kwargs):return cls()
            def to(self,device):return self
            def eval(self):return self
            def named_modules(self):return []
        class Processor:
            chat_template='official template'
            @classmethod
            def from_pretrained(cls,*args,**kwargs):return cls()
        native=ModuleType('moss_transcribe_diarize');native.MossTranscribeDiarizeForConditionalGeneration=Model;native.MossTranscribeDiarizeProcessor=Processor;native.parse_transcript=lambda text:[SimpleNamespace(text='Texto nativo',start=.123,end=1.987,speaker='S01')]
        inference=ModuleType('moss_transcribe_diarize.inference_utils');inference.DEFAULT_PROMPT='Native prompt';inference.build_transcription_messages=lambda audio,prompt:prompt
        calls={}
        def generate(model,processor,messages,**kwargs):calls['prompt']=messages;return {'text':'native output','generated_tokens':20}
        inference.generate_transcription=generate
        with patch.dict('sys.modules',{'moss_transcribe_diarize':native,'moss_transcribe_diarize.inference_utils':inference}),patch.object(adapter,'compute',return_value=(SimpleNamespace(device=lambda value:value),'cpu',None)),patch.object(adapter,'progress'),patch.object(adapter,'bounded_moss_encoder',return_value=contextlib.nullcontext()):
            result=adapter.transcribe_moss({'modelPath':'model','audioPath':'audio.wav','options':{'language':'en','parameters':{}}})
        self.assertNotIn('language',result);self.assertEqual(result['raw']['language_hint'],'en');self.assertIn('English',calls['prompt']);self.assertEqual(result['segments'][0]['startMs'],123)

if __name__ == '__main__':unittest.main()
