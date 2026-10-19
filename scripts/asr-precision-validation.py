"""Real offline ASR precision runs; never writes the original media or weights."""
import hashlib,json,os,shutil,subprocess,sys,time,uuid
from pathlib import Path

workspace=Path(__file__).resolve().parents[1]
root=workspace/'.runtime'/'asr-precision-validation'
root.mkdir(parents=True,exist_ok=True)
source=next((workspace/'tests/media').glob('TED*mp4'))
def digest(path):
    value=hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):value.update(block)
    return value.hexdigest()
source_hash=digest(source)
audio=root/'speech-8s.wav'
subprocess.run([shutil.which('ffmpeg'),'-v','error','-nostdin','-y','-i',str(source),'-t','8','-vn','-ac','1','-ar','16000','-c:a','pcm_s16le',str(audio)],check=True)
storage=workspace/'.runtime/asr-deployment-validation/installation/asr'
models=workspace/'.runtime/asr-adapters/models'
backends={'qwen3-asr':('managed-qwen3-asr-cu126-2413674f-ec16-48f3-a8d3-6b398254a621','qwen'),
          'moss-transcribe-diarize':('managed-moss-transcribe-diarize-cu126-d3bef1a1-85e1-4feb-b0fb-8a53fabd2509','moss')}
selected=[sys.argv[1]] if len(sys.argv)>1 else list(backends)
precisions=sys.argv[2:] or ['fp4','nf4','fp8','int8','float16','bfloat16','float32']
report={'checkedAt':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'sourceSha256':source_hash,'audioSeconds':8,'runs':[]}
destination=workspace/'artifacts/qa'/('asr-precision-'+(sys.argv[1] if len(sys.argv)>1 else 'all')+'.json')
destination.parent.mkdir(parents=True,exist_ok=True)
if destination.exists():
    previous=json.loads(destination.read_text(encoding='utf-8'))
    if previous.get('sourceSha256')==source_hash and previous.get('audioSeconds')==8:report['runs']=previous.get('runs',[])
for backend in selected:
    environment,folder=backends[backend]
    for precision in precisions:
        run=root/(backend+'-'+precision+'-'+str(uuid.uuid4())[:8]);run.mkdir()
        env=os.environ.copy()
        for key in ('PYTHONHOME','PYTHONPATH'):env.pop(key,None)
        for name,part in [('HF_HOME','huggingface'),('TORCH_HOME','torch'),('TORCH_EXTENSIONS_DIR','extensions'),('NUMBA_CACHE_DIR','numba'),('MPLCONFIGDIR','matplotlib'),('TEMP','temp'),('TMP','temp')]:
            path=root/'cache'/part;path.mkdir(parents=True,exist_ok=True);env[name]=str(path)
        env.update({'HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1','PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1'})
        device=os.environ.get('MUXIVRA_PRECISION_DEVICE') or ('cpu' if precision=='float32' else 'gpu')
        request={'protocol':'muxivra-asr','version':1,'backend':backend,'modelPath':str(models/folder),'audioPath':str(audio),'durationMs':8000,
                 'environment':{},'options':{'device':device,'language':'auto','threads':6,
                 'parameters':{'dtype':precision,'quantComputeDtype':'auto' if device=='cpu' else 'float16','attention':'sdpa','maxNewTokens':128,'gpuMemoryFraction':.9,'batchSize':1,'timestamps':False}}}
        (run/'request.json').write_text(json.dumps(request,ensure_ascii=False,indent=2),encoding='utf-8')
        start=time.monotonic();print('Checking',backend,precision,flush=True)
        completed=subprocess.run([str(storage/'environments'/environment/'Scripts/python.exe'),'-u',str(workspace/'resources/asr/adapter.py')],
                                 input=json.dumps(request),encoding='utf-8',capture_output=True,env=env,cwd=root,timeout=300)
        (run/'stdout.jsonl').write_text(completed.stdout,encoding='utf-8');(run/'stderr.log').write_text(completed.stderr,encoding='utf-8')
        events=[json.loads(line) for line in completed.stdout.splitlines() if line.startswith('{')]
        records=[]
        for line in completed.stderr.splitlines():
            try:
                value=json.loads(line)
                if isinstance(value,dict) and value.get('type') in ('asr-precision','asr-memory'):records.append(value)
            except json.JSONDecodeError:pass
        result=next((event['result'] for event in events if event.get('type')=='result'),None)
        item={'backend':backend,'precision':precision,'device':request['options']['device'],'exitCode':completed.returncode,'elapsedSeconds':round(time.monotonic()-start,2),
              'records':records,'segments':result.get('segments',[]) if result else [],'logs':str(run)}
        report['runs']=[value for value in report['runs'] if (value['backend'],value['precision'],value['device'])!=(backend,precision,device)]+[item]
        destination.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        if completed.returncode or not result or not records:
            print(completed.stderr[-2500:],flush=True);raise RuntimeError('ASR precision validation failed: '+backend+' '+precision)
        assert any(record['type']=='asr-precision' and record['requested']==precision for record in records)
        if precision in ('fp4','nf4','fp8','int8'):assert any(record.get('quantizedLinearLayers',0)>0 for record in records)
        assert any(segment.get('text','').strip() for segment in result['segments'])
        print('Passed',backend,precision,item['elapsedSeconds'],'seconds',flush=True)
assert digest(source)==source_hash
print('ASR precision validation passed:',destination,flush=True)
