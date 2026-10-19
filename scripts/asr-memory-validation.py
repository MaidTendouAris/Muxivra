"""Real CUDA regression: exact GQA, native encoder parity, and a 23m40s prefill.

Run with the managed MOSS Python environment. All data stays in the workspace.
Long mode deliberately stops generation at 64 tokens; it verifies memory, not ASR
quality/completion of a 23 minute transcript. No application audio splitting.
"""
import argparse
import contextlib
import gc
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "resources/asr"))
sys.path.insert(0, str(ROOT / ".runtime/asr-adapters/upstream/moss"))
import adapter
import torch
from torch.profiler import profile, ProfilerActivity


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--long", action="store_true")
    args = parser.parse_args()
    report = {"startedAt": time.time(), "cuda": torch.cuda.get_device_name(0), "checks": []}
    artifact = ROOT / ("artifacts/qa/asr-memory-validation.json" if args.long else "artifacts/qa/asr-memory-kernels.json")
    artifact.parent.mkdir(parents=True, exist_ok=True)
    try:
        torch.manual_seed(17)
        original_sdpa = torch.nn.functional.scaled_dot_product_attention
        cpu = torch.randn(1, 1, 5, 3, dtype=torch.float64)
        expected = original_sdpa(cpu, cpu, cpu)
        with adapter.efficient_sdpa(torch, "cuda:0", "sdpa"):
            torch.testing.assert_close(original_sdpa(cpu, cpu, cpu), expected)
            torch.testing.assert_close(torch.nn.functional.scaled_dot_product_attention(cpu, cpu, cpu), expected)
        assert torch.nn.functional.scaled_dot_product_attention is original_sdpa
        try:
            with adapter.efficient_sdpa(torch, "cuda:0", "sdpa"):
                raise RuntimeError("restore check")
        except RuntimeError:
            pass
        assert torch.nn.functional.scaled_dot_product_attention is original_sdpa
        report["checks"].append("CPU attention is unaffected; CUDA hooks restore on success and failure")
        q = torch.randn(1, 16, 2048, 128, device="cuda", dtype=torch.float16)
        k = torch.randn(1, 8, 2048, 128, device="cuda", dtype=torch.float16)
        v = torch.randn_like(k)
        outputs = []
        for name, context in [("original", contextlib.nullcontext()), ("bounded", adapter.efficient_sdpa(torch, "cuda:0", "sdpa"))]:
            torch.cuda.empty_cache()
            torch.cuda.reset_peak_memory_stats()
            before = torch.cuda.memory_allocated()
            with context, profile(activities=[ProfilerActivity.CPU]) as prof:
                output = torch.nn.functional.scaled_dot_product_attention(q, k, v, is_causal=True, enable_gqa=True)
            torch.cuda.synchronize()
            report[name] = {"peakExtraBytes": torch.cuda.max_memory_allocated() - before,
                            "operators": [e.key for e in prof.key_averages() if "attention" in e.key]}
            outputs.append(output.cpu())
            del output
        torch.testing.assert_close(outputs[0], outputs[1], rtol=.005, atol=.005)
        assert not any("math" in op for op in report["bounded"]["operators"])
        assert report["bounded"]["peakExtraBytes"] < report["original"]["peakExtraBytes"] / 10
        report["checks"].append("GQA outputs match; quadratic math fallback is absent")
        del q, k, v, outputs
        gc.collect()
        torch.cuda.empty_cache()

        from moss_transcribe_diarize import MossTranscribeDiarizeForConditionalGeneration, MossTranscribeDiarizeProcessor
        from moss_transcribe_diarize.inference_utils import generate_transcription, build_transcription_messages, DEFAULT_PROMPT
        model_path = str(ROOT / ".runtime/asr-adapters/models/moss")
        policy = adapter.CudaMemoryPolicy(torch, "cuda:0", torch.float16, {})
        model = MossTranscribeDiarizeForConditionalGeneration.from_pretrained(
            model_path, dtype=torch.float16, attn_implementation="sdpa", local_files_only=True).to("cuda").eval()
        # Compare the encoder in FP32: changing GEMM batch shape in FP16 changes
        # rounding over 24 layers, so a bitwise/near-zero FP16 tolerance is invalid.
        encoder = model.model.whisper_encoder.float()
        features = torch.randn(3, 80, 3000, device="cuda", dtype=torch.float32)
        with torch.inference_mode(), adapter.efficient_sdpa(torch, "cuda:0", "sdpa"):
            native = encoder(features, return_dict=True).last_hidden_state
            with adapter.bounded_moss_encoder(model, torch, 1):
                bounded = encoder(features, return_dict=True).last_hidden_state
        torch.testing.assert_close(native, bounded, rtol=.001, atol=.001)
        report["checks"].append("Native/batched audio encoder FP32 parity; all feature windows and their order preserved")
        report["encoderOutputShape"] = list(bounded.shape)
        report["encoderMaxDifference"] = float((native - bounded).abs().max().item())
        del native, bounded, features
        encoder.half()
        gc.collect()
        torch.cuda.empty_cache()

        if args.long:
            work = ROOT / ".runtime/asr-memory-validation"
            work.mkdir(parents=True, exist_ok=True)
            source = next((ROOT / "tests/media").glob("*.mp4"))
            audio = work / "whole-1420s.wav"
            subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-stream_loop", "-1", "-i", str(source),
                            "-t", "1420.044", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(audio)], check=True)
            processor = MossTranscribeDiarizeProcessor.from_pretrained(model_path, local_files_only=True)
            from transformers import StoppingCriteria, StoppingCriteriaList
            original = model.generate
            events = []

            class StopAfter64(StoppingCriteria):
                def __init__(self): self.steps = 0
                def __call__(self, input_ids, scores, **kwargs):
                    self.steps += 1
                    return self.steps >= 64

            def generate(**kwargs):
                kwargs["stopping_criteria"] = StoppingCriteriaList([StopAfter64()])
                return original(**kwargs)

            def on_input(count):
                report["inputTokens"] = count
                model.generation_config.cache_implementation = policy.configure_cache(model, count, 8192)
                report["cache"] = model.generation_config.cache_implementation

            def on_token(count):
                if count % 8 == 0:
                    print("Generated", count, "tokens", flush=True)

            start = time.monotonic()
            torch.cuda.reset_peak_memory_stats()
            with patch.object(model, "generate", generate), adapter.efficient_sdpa(torch, "cuda:0", "sdpa"), adapter.bounded_moss_encoder(model, torch, 1):
                result = generate_transcription(model, processor, build_transcription_messages(str(audio), DEFAULT_PROMPT),
                    max_length=131072, max_new_tokens=8192, device=torch.device("cuda:0"), dtype=torch.float16,
                    input_callback=on_input, token_callback=on_token)
            torch.cuda.synchronize()
            report["long"] = {"durationMs": 1420044, "elapsedSeconds": time.monotonic() - start,
                              "generatedTokens": result["generated_tokens"], "text": result["text"],
                              "limitBytes": policy.limit, **policy.report("long-validation-complete")}
            assert report["inputTokens"] >= 18000
            assert report["cache"] == "offloaded"
            assert 1 <= result["generated_tokens"] <= 64
            assert report["long"]["peakReservedBytes"] < policy.limit
            report["checks"].append("23m40s whole input, full context prefill and 64-token decode fit the VRAM budget")
        report["passed"] = True
    except Exception as error:
        report["failure"] = repr(error)
        raise
    finally:
        report["finishedAt"] = time.time()
        artifact.write_bytes(json.dumps(report, indent=2, ensure_ascii=False).encode("utf-8"))
        print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
