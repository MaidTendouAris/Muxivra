# ASR adapters

`adapter.py` implements Muxivra JSONL v1 for Qwen3-ASR and MOSS-Transcribe-Diarize. Whisper uses its native whisper.cpp executable. MiMo support is temporarily removed on Windows.

ASR Workbench offers NVIDIA one-click deployment, installing a managed Python, separate backend environments and official models under the application installation directory. The installer does not bundle these large resources. Manual environment configuration remains a compatibility option. Runtime model loading is offline.

Qwen uses qwen-asr 0.0.6 / Transformers 4.57.6; MOSS uses its pinned official source / Transformers 5.19.0. See docs/asr/SETUP.md and ADAPTERS.md for versions, official sources and validation limits.

Precision choices for the Transformers adapters include FP4/NF4/INT8 (bitsandbytes 0.50.2), FP8 weight-only (optimum-quanto 0.2.7), FP16, BF16 and FP32. Quantization preserves acoustic encoders and output layers, and never overwrites source checkpoints. Actual weight types and layer counts are validated and logged. Compute precision and KV caches remain distinct. Managed NVIDIA environment manifest nvidia-v2 includes both optional packages; older environments remain usable with their existing precision choices. See docs/asr/PRECISION.md.
