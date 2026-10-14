"""Transcribe one audio file with faster-whisper, with a timestamp for every word.

Usage: python transcribe.py <audio file> <output.json> <model> [language]

The editor's server runs this. It prints lines the server reads on standard output:
  PROGRESS <0..1>   how far through the audio it is
  NOTE <text>       something worth telling the person waiting
and writes {"language", "device", "words": [{"text", "start", "end", "probability"}]}
to the output file. Times are seconds from the start of the audio.

It tries the graphics card first and falls back to the processor if the graphics card
can't be used (for example when CUDA libraries are missing).
"""

import json
import sys


def say(kind, text):
    print(f"{kind} {text}", flush=True)


def looks_like_gpu_problem(err):
    text = str(err).lower()
    return any(k in text for k in ("cuda", "cublas", "cudnn", "gpu", "float16"))


def transcribe(audio, model_name, language, device, compute_type):
    from faster_whisper import WhisperModel

    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    segments, info = model.transcribe(audio, language=language, word_timestamps=True, vad_filter=True)
    words = []
    for segment in segments:
        for w in segment.words or []:
            text = w.word.strip()
            if text:
                words.append({
                    "text": text,
                    "start": round(float(w.start), 3),
                    "end": round(float(w.end), 3),
                    "probability": round(float(w.probability), 2),
                })
        if info.duration:
            say("PROGRESS", f"{min(1.0, segment.end / info.duration):.4f}")
    return {"language": info.language, "device": device, "words": words}


def main():
    if len(sys.argv) < 4:
        print(__doc__, file=sys.stderr)
        return 2
    audio, output, model_name = sys.argv[1:4]
    language = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None
    try:
        import faster_whisper  # noqa: F401
    except ImportError:
        print("faster-whisper is not installed for this Python. Install it with: pip install faster-whisper", file=sys.stderr)
        return 3

    say("NOTE", f"Loading the {model_name} speech model (the first time, it is downloaded, which can take a few minutes)")
    try:
        result = transcribe(audio, model_name, language, "auto", "default")
    except Exception as err:  # noqa: BLE001 - any GPU failure: retry on the processor
        if not looks_like_gpu_problem(err):
            raise
        say("NOTE", "The graphics card can't be used for transcription here, so the processor is used instead (slower)")
        say("PROGRESS", "0")
        result = transcribe(audio, model_name, language, "cpu", "int8")

    with open(output, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
