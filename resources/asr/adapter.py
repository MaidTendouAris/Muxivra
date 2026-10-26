"""Muxivra local JSONL bridge. Model packages and weights are installed separately."""
import argparse
import contextlib
import datetime
import importlib
import importlib.metadata
import importlib.util
import json
import math
import os
import re
import sys
import traceback
import unicodedata
import time

OUTPUT = sys.stdout
for stream in (sys.stdin, sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="strict")


def emit(event):
    OUTPUT.write(json.dumps(event, ensure_ascii=False, allow_nan=False) + "\n")
    OUTPUT.flush()


def progress(percent, stage, **metrics):
    # A missing denominator is indeterminate, never a fabricated audio percentage.
    emit({"type": "progress", "percent": 0 if percent is None else percent,
          "indeterminate": percent is None, "scope": "stage", "stage": stage, **metrics})


@contextlib.contextmanager
def observe_qwen_progress(model):
    """Observe official SDK batches without splitting/reordering its input or results."""
    if not callable(getattr(model, "_infer_asr", None)) or not callable(getattr(getattr(model, "model", None), "generate", None)):
        progress(None, "Qwen 识别中 · 当前 SDK 未提供可观测窗口")
        yield
        return
    original_infer = model._infer_asr
    original_generate = model.model.generate
    aligner = getattr(model, "forced_aligner", None)
    original_align = aligner.align if aligner else None
    state = {"durations": [], "index": 0, "done": 0, "aligned": 0}

    def report(steps=None):
        total = sum(state["durations"])
        completed = sum(state["durations"][:state["done"]])
        stage = "Qwen 识别 · 已完成 %d/%d 个原生窗口" % (state["done"], len(state["durations"]))
        if steps is not None:
            stage += " · 当前窗口已解码 %d 步" % steps
        progress(completed / total * 100 if completed and total else None, stage,
                 completed=round(completed), total=round(total), unit="audioMs")

    def infer(contexts, wavs, languages):
        state["durations"] = [len(wav) / 16000 * 1000 for wav in wavs]
        report()
        return original_infer(contexts, wavs, languages)

    def generate(*args, **kwargs):
        size = model.max_inference_batch_size
        size = len(state["durations"]) if size is None or size < 0 else size
        if getattr(model, "backend", "transformers") == "transformers":
            from transformers import StoppingCriteria, StoppingCriteriaList

            class ObserveSteps(StoppingCriteria):
                def __init__(self):
                    self.steps, self.last = 0, 0

                def __call__(self, input_ids, scores, **unused):
                    self.steps += 1
                    if time.monotonic() - self.last >= .35:
                        self.last = time.monotonic()
                        report(self.steps)
                    return False

            kwargs["stopping_criteria"] = StoppingCriteriaList([*(kwargs.get("stopping_criteria") or []), ObserveSteps()])
        result = original_generate(*args, **kwargs)
        state["done"] = min(len(state["durations"]), state["done"] + size)
        report()
        return result

    def align(*args, **kwargs):
        progress(None, "Qwen 词级对齐 · 已完成 %d 个原生窗口" % state["aligned"], completed=state["aligned"], unit="windows")
        result = original_align(*args, **kwargs)
        state["aligned"] += len(result)
        progress(None, "Qwen 词级对齐 · 已完成 %d 个原生窗口" % state["aligned"], completed=state["aligned"], unit="windows")
        return result

    model._infer_asr, model.model.generate = infer, generate
    if aligner:
        aligner.align = align
    try:
        yield
    finally:
        model._infer_asr, model.model.generate = original_infer, original_generate
        if aligner:
            aligner.align = original_align


def milliseconds(seconds):
    value = float(seconds)
    if not math.isfinite(value) or value < 0:
        raise ValueError("模型返回无效时间")
    return round(value * 1000)


def qwen_segments(text, timestamps, max_chars=72, max_seconds=8):
    """Group aligned words without inventing times or dropping native punctuation."""
    # The official aligner removes punctuation (e.g. twenty-five -> twentyfive).
    # Match normalized letters/numbers, but slice the original text for subtitles.
    def normalize(value):
        return ''.join(c.casefold() for c in unicodedata.normalize('NFKC', value) if c.isalnum())

    normalized, positions = '', []
    for index, character in enumerate(text):
        value = normalize(character)
        normalized += value
        positions.extend([index] * len(value))
    words, cursor, normalized_cursor = [], 0, 0
    for item in timestamps or []:
        get = lambda key: item.get(key) if isinstance(item, dict) else getattr(item, key)
        token = str(get("text"))
        start, end = milliseconds(get("start_time")), milliseconds(get("end_time"))
        if end < start:
            raise ValueError("模型返回倒置的词级时间")
        key = normalize(token)
        if not key:
            continue
        found = normalized.find(key, normalized_cursor)
        if found != normalized_cursor:
            return [{"text": text, "words": words}] if text.strip() else []
        normalized_cursor = found + len(key)
        finish = positions[normalized_cursor - 1] + 1
        if end == start:
            # Keep zero-duration words in the original text slice, attaching
            # them to the next valid aligned word rather than inventing a span.
            continue
        words.append({"text": text[cursor:finish], "startMs": start, "endMs": end})
        cursor = finish
    if not words:
        return [{"text": text}] if text.strip() else []
    words[-1]["text"] += text[cursor:]
    segments, group = [], []

    def finish():
        if group:
            segments.append({"text": "".join(w["text"] for w in group).strip(),
                             "startMs": min(w["startMs"] for w in group),
                             "endMs": max(w["endMs"] for w in group), "words": list(group)})
            group.clear()

    for word in words:
        if group and (len("".join(w["text"] for w in group)) + len(word["text"]) > max_chars
                      or word["endMs"] - group[0]["startMs"] > max_seconds * 1000
                      or word["startMs"] - group[-1]["endMs"] > 1000):
            finish()
        group.append(word)
    finish()
    return segments


def probe(backend, source=None):
    if source:
        sys.path.insert(0, source)
    versions, issues, warnings, devices = {}, [], [], []
    cuda = False
    packages = ["torch", "torchaudio", "transformers", "accelerate", "safetensors"]
    for package in packages:
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            if package != "accelerate" or backend == "qwen3-asr":
                issues.append("缺少依赖：" + package)
    for package in ("bitsandbytes", "optimum-quanto"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            warnings.append("未安装可选量化依赖 " + package + "；自动/FP16/BF16/FP32 不受影响。")
    try:
        torch = importlib.import_module("torch")
        versions["cuda"] = str(torch.version.cuda) if torch.version.cuda else "CPU"
        cuda = torch.cuda.is_available()
        if cuda:
            for index in range(torch.cuda.device_count()):
                free, total = torch.cuda.mem_get_info(index)
                devices.append({"name": torch.cuda.get_device_name(index), "totalBytes": total, "freeBytes": free})
        module = {"qwen3-asr": "qwen_asr", "moss-transcribe-diarize": "moss_transcribe_diarize"}[backend]
        importlib.import_module(module)
    except Exception as error:
        issues.append(str(error))
    version = versions.get("transformers", "")
    if backend == "qwen3-asr" and version != "4.57.6":
        issues.append("Qwen3-ASR 当前官方包需要 Transformers 4.57.6")
    if backend == "moss-transcribe-diarize" and not re.match(r"^5\.(?:[6-9]|[1-9]\d)\.", version):
        issues.append("MOSS 当前官方包需要 Transformers >=5.6,<6")
    return {"ready": not issues, "python": sys.version.split()[0], "platform": sys.platform,
            "versions": versions, "cudaAvailable": cuda, "devices": devices,
            "issues": issues, "warnings": warnings,
            "vllm": importlib.util.find_spec("vllm") is not None,
            "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}


def compute(options, parameters):
    import torch
    requested = options.get("device", "auto")
    if requested == "gpu" and not torch.cuda.is_available():
        raise RuntimeError("指定 GPU，但运行环境未检测到可用 CUDA")
    index = int(parameters.get("gpuIndex", 0))
    device = "cpu" if requested == "cpu" or not torch.cuda.is_available() else "cuda:%d" % index
    precision = parameters.get("dtype", "auto")
    if precision not in ("auto", "float32", "float16", "bfloat16", "fp4", "nf4", "fp8", "int8"):
        raise ValueError("不支持的模型精度：" + str(precision))
    dtype_name = parameters.get("quantComputeDtype", "auto") if precision in ("fp4", "nf4", "fp8", "int8") else precision
    if dtype_name not in ("auto", "float32", "float16", "bfloat16"):
        raise ValueError("不支持的计算精度：" + str(dtype_name))
    dtype = torch.float32 if dtype_name == "auto" and device == "cpu" else torch.float16 if dtype_name == "auto" else getattr(torch, dtype_name)
    if dtype == torch.bfloat16 and device.startswith("cuda") and torch.cuda.get_device_capability(device)[0] < 8:
        raise ValueError("所选 GPU 不支持本适配器的 BF16 计算，请使用 FP16 或 FP32")
    torch.set_num_threads(int(options.get("threads", 4)))
    return torch, device, dtype


def precision_loading(backend, torch, device, dtype, parameters):
    precision = parameters.get("dtype", "auto")
    if precision not in ("fp4", "nf4", "fp8", "int8"):
        return {}
    if parameters.get("implementation", "transformers") == "vllm":
        raise ValueError("此量化配置仅用于 Transformers，vLLM 请使用自动/FP16/BF16/FP32")
    # Keep acoustic encoders and output/tied embeddings in their original dtype.
    # Quantizing eligible linear layers is not a conversion of all tensors.
    excluded = ["lm_head", "thinker.lm_head", "thinker.audio_tower", "model.whisper_encoder"]
    package = "optimum-quanto" if precision == "fp8" else "bitsandbytes"
    try:
        importlib.metadata.version(package)
    except importlib.metadata.PackageNotFoundError as error:
        raise RuntimeError("所选精度需要 " + package + "。请在模型下载与部署页执行检查与修复部署，或在独立环境安装量化依赖。") from error
    if precision == "fp8":
        from transformers import QuantoConfig
        config = QuantoConfig(weights="float8", modules_to_not_convert=excluded)
    else:
        if not device.startswith("cuda"):
            raise ValueError("FP4/NF4/INT8 当前要求 NVIDIA CUDA GPU；CPU 可使用 FP8/FP16/BF16/FP32")
        major, minor = torch.cuda.get_device_capability(device)
        if major * 10 + minor < (75 if precision == "int8" else 60):
            raise ValueError("所选 GPU 不支持该 bitsandbytes 量化精度")
        from transformers import BitsAndBytesConfig
        config = BitsAndBytesConfig(load_in_8bit=precision == "int8", load_in_4bit=precision in ("fp4", "nf4"),
                                    bnb_4bit_quant_type=precision if precision in ("fp4", "nf4") else "fp4",
                                    bnb_4bit_compute_dtype=dtype, bnb_4bit_use_double_quant=bool(parameters.get("doubleQuant", True)),
                                    llm_int8_skip_modules=excluded)
    progress(None, "加载模型 · %s 权重量化 / %s 计算" % (precision.upper(), str(dtype)))
    return {"quantization_config": config}


def precision_report(model, dtype, parameters):
    precision = parameters.get("dtype", "auto")
    if precision in ("float16", "bfloat16", "float32") and getattr(model, "is_quantized", False):
        raise RuntimeError("导入的模型文件已预量化，不能将其标记为未量化的 %s；请使用原始权重或选择自动精度。" % precision)
    modules = [(name, module) for name, module in model.named_modules() if module.__class__.__name__ in ("Linear4bit", "Linear8bitLt", "QLinear")]
    if precision in ("fp4", "nf4", "fp8", "int8") and not modules:
        raise RuntimeError("模型没有实际转换为所选量化精度，已停止；未回退到未量化权重")
    types = {}
    for name, module in modules:
        if any(name == prefix or name.startswith(prefix + ".") for prefix in ("lm_head", "thinker.lm_head", "thinker.audio_tower", "model.whisper_encoder")):
            raise RuntimeError("量化后端意外转换了音频编码器或输出层，已停止：" + name)
        if module.__class__.__name__ == "Linear4bit":
            actual = getattr(getattr(module.weight, "quant_state", None), "quant_type", None)
        elif module.__class__.__name__ == "QLinear":
            actual = str(getattr(getattr(module.weight, "qtype", None), "name", ""))
            actual = "fp8" if actual.startswith("qfloat8") and module.frozen else actual
        else:
            actual = "int8" if str(module.weight.dtype) == "torch.int8" else str(module.weight.dtype)
        if precision in ("fp4", "nf4", "fp8", "int8") and actual != precision:
            raise RuntimeError("量化层实际精度与设置不一致：%s / %s" % (precision, actual))
        types[actual] = types.get(actual, 0) + 1
    values = {"type": "asr-precision", "requested": precision, "computeDtype": str(dtype), "quantizedLinearLayers": len(modules),
              "actualWeightTypes": types, "scope": "linear-weights" if modules else "unquantized"}
    print(json.dumps(values), file=sys.stderr, flush=True)
    return values


def kv_cache_bytes(config, tokens, dtype_bytes, beams=1):
    """Size of the full attention KV cache, excluding activations and weights."""
    config = getattr(config, "text_config", config)
    heads = config.num_key_value_heads
    head_dim = getattr(config, "head_dim", None) or config.hidden_size // config.num_attention_heads
    return int(2 * config.num_hidden_layers * heads * head_dim * tokens * dtype_bytes * beams)


def available_host_memory():
    if sys.platform != "win32":
        return None
    import ctypes
    class MemoryStatus(ctypes.Structure):
        _fields_ = [("length", ctypes.c_uint32), ("load", ctypes.c_uint32),
                    *[(name, ctypes.c_uint64) for name in ("totalPhysical", "availablePhysical", "totalPageFile", "availablePageFile", "totalVirtual", "availableVirtual", "extendedVirtual")]]
    status = MemoryStatus()
    status.length = ctypes.sizeof(status)
    return status.availablePhysical if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)) else None


class CudaMemoryPolicy:
    def __init__(self, torch, device, dtype, parameters):
        self.torch, self.device, self.dtype, self.parameters = torch, device, dtype, parameters
        self.enabled = str(device).startswith("cuda")
        self.limit = None
        self.cache = "disabled"
        if self.enabled:
            # Bound this worker's allocator to physical free VRAM. WDDM may otherwise
            # keep allocating into shared system memory long before CUDA reports OOM.
            free, total = torch.cuda.mem_get_info(device)
            reserve = max(384 * 1024**2, int(total * .08))
            self.limit = min(int(total * float(parameters.get("gpuMemoryFraction", .9))),
                             free - reserve + torch.cuda.memory_allocated(device))
            if self.limit < 256 * 1024**2:
                raise RuntimeError("可用专用显存不足，请先释放 GPU 资源或选择 CPU。未自动分片。")
            torch.cuda.set_per_process_memory_fraction(self.limit / total, device)
            torch.cuda.reset_peak_memory_stats(device)
            self.report("budget", freeBytes=free, totalBytes=total, limitBytes=self.limit)

    def configure_cache(self, model, prompt_tokens, max_new_tokens, beams=1, use_cache=True):
        if not self.enabled or not use_cache:
            return None
        expected = kv_cache_bytes(model.config, prompt_tokens + max_new_tokens,
                                  self.torch.empty((), dtype=self.dtype).element_size(), beams)
        remaining = self.limit - self.torch.cuda.memory_allocated(self.device) - 512 * 1024**2
        strategy = self.parameters.get("cacheStrategy", "auto")
        offload = strategy == "offloaded" or (strategy == "auto" and expected > remaining)
        self.cache = "offloaded" if offload else "dynamic"
        if offload:
            available = available_host_memory()
            if available is not None and expected * 1.25 + 512 * 1024**2 > available:
                raise RuntimeError("CPU KV 缓存预计需要约 %.2f GiB，但系统可用内存只有 %.2f GiB。请释放内存、缩小识别区间或手动启用兼容分片；本次未自动分片。" %
                                   (expected / 1024**3, available / 1024**3))
        self.report("cache", inputTokens=prompt_tokens, estimatedCacheBytes=expected, cache=self.cache)
        if offload:
            progress(None, "长上下文 KV 缓存使用 CPU 内存 · 保持整段识别")
        return self.cache

    def report(self, stage, **values):
        if not self.enabled:
            return {}
        values = {"type": "asr-memory", "stage": stage,
                  "limitBytes": self.limit,
                  "allocatedBytes": self.torch.cuda.memory_allocated(self.device),
                  "reservedBytes": self.torch.cuda.memory_reserved(self.device),
                  "peakAllocatedBytes": self.torch.cuda.max_memory_allocated(self.device),
                  "peakReservedBytes": self.torch.cuda.max_memory_reserved(self.device), **values}
        print(json.dumps(values), file=sys.stderr, flush=True)
        return values


@contextlib.contextmanager
def efficient_sdpa(torch, device, attention):
    """Keep exact full-context attention; never silently allocate quadratic math SDPA.

    Windows CUDA wheels lack Flash Attention. Transformers' enable_gqa=True then
    excludes the efficient kernel and defaults to math (many GiB for long audio).
    Expanding KV heads is mathematically identical GQA and enables efficient SDPA.
    The patch is confined to this isolated ASR worker and restored on exit.
    """
    if not str(device).startswith("cuda") or attention != "sdpa":
        yield
        return
    from torch.nn.attention import sdpa_kernel, SDPBackend
    functional = torch.nn.functional
    original = functional.scaled_dot_product_attention
    expand_gqa = not torch.backends.cuda.is_flash_attention_available()

    def bounded(query, key, value, *args, **kwargs):
        if query.device.type != "cuda":
            return original(query, key, value, *args, **kwargs)
        if expand_gqa and kwargs.pop("enable_gqa", False):
            groups = query.shape[-3] // key.shape[-3]
            if groups != 1:
                key = key.repeat_interleave(groups, dim=-3)
                value = value.repeat_interleave(groups, dim=-3)
        # Restrict only this CUDA call: a Qwen CPU aligner in the same worker
        # must retain its normal CPU attention backends.
        with sdpa_kernel([SDPBackend.FLASH_ATTENTION, SDPBackend.EFFICIENT_ATTENTION, SDPBackend.CUDNN_ATTENTION]):
            return original(query, key, value, *args, **kwargs)

    functional.scaled_dot_product_attention = bounded
    try:
        # A missing supported fused kernel fails explicitly instead of falling back
        # to a Q×K attention matrix and exhausting physical/shared memory.
        yield
    finally:
        functional.scaled_dot_product_attention = original


@contextlib.contextmanager
def bounded_moss_encoder(model, torch, batch_size=1):
    """Batch only independent native audio features, preserving the full LM context."""
    from transformers.modeling_outputs import BaseModelOutput
    encoder = model.model.whisper_encoder
    original = encoder.forward

    def encode(input_features, *args, **kwargs):
        if input_features.shape[0] <= batch_size:
            return original(input_features, *args, **kwargs)
        if kwargs.get("output_attentions") or kwargs.get("output_hidden_states") or kwargs.get("return_dict") is False:
            raise ValueError("分批音频编码只支持推理的 last_hidden_state 输出")
        outputs = []
        total = input_features.shape[0]
        for start in range(0, total, batch_size):
            outputs.append(original(input_features[start:start + batch_size], *args, **kwargs).last_hidden_state)
            done = min(total, start + batch_size)
            progress(done / total * 100, "MOSS 音频编码 · %d/%d 个原生特征窗口" % (done, total),
                     completed=done, total=total, unit="windows")
        progress(None, "MOSS 整段上下文预填充中")
        return BaseModelOutput(last_hidden_state=torch.cat(outputs, dim=0))

    encoder.forward = encode
    try:
        yield
    finally:
        encoder.forward = original


LANGUAGES = dict(zh="Chinese", en="English", yue="Cantonese", ar="Arabic", de="German", fr="French",
                 es="Spanish", pt="Portuguese", id="Indonesian", it="Italian", ko="Korean", ru="Russian",
                 th="Thai", vi="Vietnamese", ja="Japanese", tr="Turkish", hi="Hindi", ms="Malay", nl="Dutch",
                 sv="Swedish", da="Danish", fi="Finnish", pl="Polish", cs="Czech", fil="Filipino", fa="Persian",
                 el="Greek", hu="Hungarian", mk="Macedonian", ro="Romanian")


def transcribe_qwen(request):
    options, environment = request["options"], request["environment"]
    p = options.get("parameters", {})
    language = options.get("language", "auto")
    if language != "auto" and language not in LANGUAGES:
        raise ValueError("Qwen3-ASR 不支持该语言代码：" + language)
    if p.get("implementation", "transformers") == "vllm":
        if options.get("device") == "cpu":
            raise ValueError("本适配器的 vLLM 路径要求 CUDA GPU")
        # Set visibility before importing a package which may initialize CUDA.
        os.environ["CUDA_VISIBLE_DEVICES"] = str(p.get("gpuIndex", 0))
        p = {**p, "gpuIndex": 0}
    from qwen_asr import Qwen3ASRModel
    torch, device, dtype = compute(options, p)
    quantization = precision_loading("qwen3-asr", torch, device, dtype, p)
    memory = CudaMemoryPolicy(torch, device, dtype, p) if p.get("implementation", "transformers") != "vllm" else None
    stamps = bool(p.get("timestamps", False))
    aligner = environment.get("alignerPath") if stamps else None
    if stamps and not aligner:
        raise ValueError("词级时间戳需要配置 Qwen3-ForcedAligner 模型目录")
    kwargs = {"max_inference_batch_size": int(p.get("batchSize", 1)), "max_new_tokens": int(p.get("maxNewTokens", 4096))}
    if aligner:
        align_device = "cpu" if p.get("alignerDevice", "cpu") == "cpu" else device
        kwargs.update(forced_aligner=aligner, forced_aligner_kwargs={"device_map": align_device,
                       "dtype": torch.float32 if align_device == "cpu" else dtype, "attn_implementation": p.get("attention", "sdpa"), "local_files_only": True})
    progress(None, "加载 Qwen3-ASR 模型与依赖 · %s" % p.get("dtype", "auto").upper())
    if p.get("implementation", "transformers") == "vllm":
        if device == "cpu":
            raise ValueError("本适配器的 vLLM 路径要求 CUDA GPU")
        model = Qwen3ASRModel.LLM(model=request["modelPath"], gpu_memory_utilization=float(p.get("gpuMemoryUtilization", .7)),
                                max_model_len=int(p.get("maxModelLength", 32768)), tensor_parallel_size=int(p.get("tensorParallelSize", 1)), dtype=str(dtype).removeprefix("torch."), **kwargs)
    else:
        model = Qwen3ASRModel.from_pretrained(request["modelPath"], device_map=device, dtype=dtype,
                                            attn_implementation=p.get("attention", "sdpa"), local_files_only=True, **quantization, **kwargs)
        precision_report(model.model, dtype, p)
        memory.report("model-loaded", precision=p.get("dtype", "auto"))
    progress(None, "Qwen3-ASR 准备音频与原生识别窗口")
    with torch.inference_mode(), efficient_sdpa(torch, device, p.get("attention", "sdpa")), observe_qwen_progress(model):
        results = model.transcribe(audio=request["audioPath"], context=options.get("initialPrompt", ""),
                                   language=None if language == "auto" else LANGUAGES[language], return_time_stamps=stamps)
    if memory:
        memory.report("complete")
    segments, raw = [], []
    for result in results:
        timestamps = getattr(result, "time_stamps", None)
        words = [{"text": w.text, "start_time": w.start_time, "end_time": w.end_time} for w in timestamps or []]
        segments.extend(qwen_segments(result.text, words, int(p.get("cueMaxChars", 72)), float(p.get("cueMaxSeconds", 8))))
        raw.append({"text": result.text, "language": result.language, "time_stamps": words})
    return {"language": getattr(results[0], "language", None) if results else None, "segments": segments, "raw": raw}


def transcribe_moss(request):
    from moss_transcribe_diarize import MossTranscribeDiarizeForConditionalGeneration, MossTranscribeDiarizeProcessor, parse_transcript
    from moss_transcribe_diarize.inference_utils import DEFAULT_PROMPT, build_transcription_messages, generate_transcription
    options, p = request["options"], request["options"].get("parameters", {})
    torch, device, dtype = compute(options, p)
    quantization = precision_loading("moss-transcribe-diarize", torch, device, dtype, p)
    memory = CudaMemoryPolicy(torch, device, dtype, p)
    progress(None, "加载 MOSS-Transcribe-Diarize 模型与依赖 · %s" % p.get("dtype", "auto").upper())
    model = MossTranscribeDiarizeForConditionalGeneration.from_pretrained(request["modelPath"], dtype=dtype,
                 attn_implementation=p.get("attention", "sdpa"), local_files_only=True,
                 **({"device_map": device, **quantization} if quantization else {}))
    model = model.eval() if quantization else model.to(device).eval()
    precision_report(model, dtype, p)
    memory.report("model-loaded", precision=p.get("dtype", "auto"))
    processor = MossTranscribeDiarizeProcessor.from_pretrained(request["modelPath"], local_files_only=True)
    if not processor.chat_template:
        raise ValueError("MOSS 模型目录缺少官方聊天模板，请补全 chat_template.jinja 后重试")
    model.generation_config.repetition_penalty = float(p.get("repetitionPenalty", 1))
    model.generation_config.num_beams = int(p.get("numBeams", 1))
    model.generation_config.use_cache = bool(p.get("useCache", True))
    prompt = options.get("initialPrompt", "").strip() or DEFAULT_PROMPT
    language = options.get("language", "auto")
    if language != "auto":
        prompt += "\nAudio language hint: %s. Keep the original spoken language; do not translate." % LANGUAGES.get(language, language)
    progress(None, "MOSS 准备音频特征")
    last_progress = [0.0]
    def token_progress(count):
        if time.monotonic() - last_progress[0] >= .35:
            last_progress[0] = time.monotonic()
            progress(None, "MOSS 识别 · 已生成 %d Token" % count, completed=count, unit="tokens")
    def input_progress(count):
        cache = memory.configure_cache(model, count, int(p.get("maxNewTokens", 8192)),
                                       int(p.get("numBeams", 1)), bool(p.get("useCache", True)))
        if cache:
            model.generation_config.cache_implementation = cache
        progress(None, "MOSS 音频特征准备完成 · 输入 %d Token，开始生成%s" %
                 (count, " · CPU KV 缓存" if cache == "offloaded" else ""))

    with efficient_sdpa(torch, device, p.get("attention", "sdpa")), bounded_moss_encoder(model, torch, int(p.get("audioEncoderBatchSize", 1))):
        result = generate_transcription(model, processor, build_transcription_messages(request["audioPath"], prompt),
                 max_length=int(p.get("maxInputLength", 131072)), max_new_tokens=int(p.get("maxNewTokens", 8192)),
                 do_sample=bool(p.get("doSample", False)), temperature=float(p.get("temperature", .7)),
                 top_p=float(p.get("topP", .9)), top_k=int(p.get("topK", 50)), device=torch.device(device), dtype=dtype,
                 input_callback=input_progress,
                 token_callback=token_progress if int(p.get("numBeams", 1)) == 1 else None)
    diagnostics = memory.report("complete", cache=memory.cache)
    if diagnostics:
        result["memory"] = diagnostics
    parsed = parse_transcript(result["text"])
    segments = [{"text": item.text, "startMs": milliseconds(item.start), "endMs": milliseconds(item.end), "speaker": item.speaker} for item in parsed]
    if not segments and result["text"].strip():
        segments = [{"text": result["text"]}]
    # The native API does not return language detection. A requested hint is
    # not evidence of the language actually produced by this model.
    return {"segments": segments, "raw": {**result, "language_hint": language}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", choices=["qwen3-asr", "moss-transcribe-diarize"])
    parser.add_argument("--source")
    args = parser.parse_args()
    if args.probe:
        with contextlib.redirect_stdout(sys.stderr):
            result = probe(args.probe, args.source)
        OUTPUT.write(json.dumps(result, ensure_ascii=False, allow_nan=False) + "\n")
        OUTPUT.flush()
        return
    request = json.loads(sys.stdin.readline(4 * 1024 * 1024))
    if request.get("protocol") != "muxivra-asr" or request.get("version") != 1:
        raise ValueError("不支持的 ASR 协议版本")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    environment = request.get("environment", {})
    if environment.get("sourcePath"):
        sys.path.insert(0, environment["sourcePath"])
    backend = request["backend"]
    with contextlib.redirect_stdout(sys.stderr):
        result = {"qwen3-asr": transcribe_qwen, "moss-transcribe-diarize": transcribe_moss}[backend](request)
    if result.get("language") is None:
        result.pop("language", None)
    progress(100, "识别完成")
    emit({"type": "result", "result": result})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        message = str(error)
        if error.__class__.__name__ == "OutOfMemoryError":
            message = "本次推理超过可用专用显存预算，已停止以避免共享内存持续增长。请使用 FP16/BF16、自动或 CPU KV 缓存，降低 Beam/批次，或释放其他 GPU 资源。也可手动启用兼容分片；本次未自动分片。\n" + message
        elif "No available kernel" in message or "No viable backend" in message:
            message = "当前计算精度或 GPU 不支持节省显存的 SDPA 内核，请使用 FP16/BF16、更新驱动或选择 CPU；未回退至高内存注意力实现。\n" + message
        emit({"type": "error", "message": message})
        sys.exit(1)
