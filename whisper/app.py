"""Thin faster-whisper HTTP wrapper. One model, loaded once, batch transcribe."""
import os
import tempfile

from fastapi import FastAPI, File, Form, UploadFile
from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
DEVICE = os.environ.get("WHISPER_DEVICE", "auto")  # cuda when present, else cpu
COMPUTE = os.environ.get("WHISPER_COMPUTE", "default")  # ctranslate2 picks per device

app = FastAPI()
model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE)


@app.get("/healthz")
def healthz():
    # model.device reflects what ctranslate2 actually picked under "auto".
    return {"ok": True, "model": MODEL_NAME, "device": model.model.device if hasattr(model, "model") else DEVICE}


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: str = Form(""),
    prompt: str = Form(""),
):
    # faster-whisper wants a path or file-like; spool to a temp file so
    # ffmpeg can sniff the container format (webm/ogg/mp4/wav).
    with tempfile.NamedTemporaryFile(suffix=os.path.splitext(file.filename or "a.webm")[1] or ".webm") as tmp:
        tmp.write(await file.read())
        tmp.flush()
        segments, info = model.transcribe(
            tmp.name,
            language=language or None,
            initial_prompt=prompt or None,
            vad_filter=True,
            temperature=0,
        )
        text = " ".join(s.text.strip() for s in segments).strip()
    return {"text": text, "language": info.language, "duration": info.duration}
