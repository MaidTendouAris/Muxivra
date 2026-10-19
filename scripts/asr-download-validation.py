"""Download official, revision-pinned weights into the ignored validation tree."""
import json
import os
from pathlib import Path
from huggingface_hub import HfApi, snapshot_download

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
root = Path(__file__).resolve().parents[1] / ".runtime" / "asr-adapters" / "models"
root.mkdir(parents=True, exist_ok=True)
models = [("qwen", "Qwen/Qwen3-ASR-0.6B"), ("aligner", "Qwen/Qwen3-ForcedAligner-0.6B"),
          ("moss", "OpenMOSS-Team/MOSS-Transcribe-Diarize")]
records = []
for key, repo in models:
    info = HfApi().model_info(repo, files_metadata=True)
    total = sum(getattr(file, "size", 0) or 0 for file in info.siblings)
    print(json.dumps({"model": key, "repo": repo, "revision": info.sha, "bytes": total}), flush=True)
    snapshot_download(repo_id=repo, revision=info.sha, local_dir=str(root / key), max_workers=2,
                      allow_patterns=["*.json", "*.safetensors", "*.bin", "*.txt", "*.model", "*.tiktoken", "*.jinja", "*.jinja2"])
    records.append({"repo": repo, "revision": info.sha, "path": str(root / key), "bytes": total})
    (root / "validation-downloads.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
