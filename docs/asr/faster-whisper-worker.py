"""Muxivra ASR JSONL adapter for a local CTranslate2 Whisper model directory."""
import argparse
import contextlib
import json
import sys
import traceback

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
protocol_output = sys.stdout


def emit(value):
    protocol_output.write(json.dumps(value, ensure_ascii=False) + "\n")
    protocol_output.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--compute-type", default="default")
    parser.add_argument("--vad", action="store_true")
    parser.add_argument("--words", action="store_true")
    args = parser.parse_args()
    request = json.loads(sys.stdin.readline())
    if (request.get("protocol"), request.get("version"), request.get("timebase")) != (
        "muxivra-asr", 1, "chunk-relative-ms"
    ):
        raise ValueError("Unsupported ASR protocol")
    options = request["options"]
    device = "cuda" if options["device"] == "gpu" else options["device"]
    with contextlib.redirect_stdout(sys.stderr):
        from faster_whisper import WhisperModel
        model = WhisperModel(
            request["modelPath"], device=device, compute_type=args.compute_type,
            cpu_threads=options["threads"], local_files_only=True
        )
        iterator, info = model.transcribe(
            request["audioPath"], language=None if options["language"] == "auto" else options["language"],
            beam_size=options["beamSize"], initial_prompt=options["initialPrompt"] or None,
            vad_filter=args.vad, word_timestamps=args.words
        )
        segments = []
        for segment in iterator:
            if segment.end <= segment.start:
                continue
            item = dict(text=segment.text, startMs=segment.start * 1000,
                        endMs=segment.end * 1000, score=segment.avg_logprob)
            if segment.words:
                item["words"] = [dict(text=w.word, startMs=w.start * 1000,
                                      endMs=w.end * 1000, score=w.probability)
                                 for w in segment.words if w.end > w.start]
            segments.append(item)
            emit(dict(type="progress", percent=min(100, segment.end * 100000 / request["durationMs"])))
        emit(dict(type="result", result=dict(language=info.language, segments=segments)))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        emit(dict(type="error", message=str(error)))
        sys.exit(1)
