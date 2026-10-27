# server.py — Teobeanie Whisper: speech to text on the Home Assistant host, for
# Teobeanie's voice lane. faster-whisper (CTranslate2, int8 on the CPU) behind an
# OpenAI-compatible endpoint, so Teobeanie can also be pointed at any other server
# that speaks it.
#
#   POST /v1/audio/transcriptions   multipart: file, language?, prompt?, response_format?
#   GET  /health                    200 once the model is loaded, 503 before
#
# One transcription at a time (the CPU is the limit); the model is loaded once, at
# start, and downloaded into /data/models the first time.

import json
import os
import sys
import tempfile
import threading
import time
from email.parser import BytesParser
from email.policy import HTTP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from faster_whisper import WhisperModel

OPTIONS_FILE = os.environ.get("OPTIONS_FILE", "/data/options.json")
MODELS_DIR = os.environ.get("MODELS_DIR", "/data/models")
PORT = int(os.environ.get("PORT", "8200"))
# A voice message is short: anything above this is not one.
MAX_BODY = 25 * 1024 * 1024


def log(msg: str) -> None:
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}", file=sys.stderr, flush=True)


def options() -> dict:
    try:
        with open(OPTIONS_FILE) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


OPT = options()
MODEL_NAME = os.environ.get("WHISPER_MODEL") or OPT.get("model") or "small"
LANGUAGE = OPT.get("language") or None
BEAM_SIZE = int(OPT.get("beam_size") or 5)
THREADS = int(OPT.get("cpu_threads") or os.cpu_count() or 4)

model: WhisperModel | None = None
lock = threading.Lock()


def load() -> None:
    global model
    t0 = time.time()
    log(f"loading {MODEL_NAME} (int8, {THREADS} threads) into {MODELS_DIR}")
    model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8", cpu_threads=THREADS, download_root=MODELS_DIR)
    log(f"model {MODEL_NAME} ready in {time.time() - t0:.1f} s")


def transcribe(audio: bytes, language: str | None, prompt: str | None) -> dict:
    assert model is not None
    with tempfile.NamedTemporaryFile(suffix=".audio") as f:
        f.write(audio)
        f.flush()
        t0 = time.time()
        with lock:
            segments, info = model.transcribe(
                f.name,
                language=language or LANGUAGE,
                initial_prompt=prompt or None,
                beam_size=BEAM_SIZE,
                vad_filter=True,
                condition_on_previous_text=False,
            )
            text = " ".join(s.text.strip() for s in segments).strip()
        ms = round((time.time() - t0) * 1000)
    return {
        "text": text,
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "duration": round(info.duration, 2),
        "model": MODEL_NAME,
        "processing_ms": ms,
    }


def form_fields(content_type: str, body: bytes) -> dict[str, bytes]:
    """multipart/form-data → {name: value}; the stdlib's MIME parser reads it."""
    msg = BytesParser(policy=HTTP).parsebytes(b"Content-Type: " + content_type.encode() + b"\r\n\r\n" + body)
    out: dict[str, bytes] = {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if name:
            out[name] = part.get_payload(decode=True) or b""
    return out


class Handler(BaseHTTPRequestHandler):
    def reply(self, status: int, body: dict | str) -> None:
        data = (body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)).encode()
        self.send_response(status)
        self.send_header("content-type", "text/plain; charset=utf-8" if isinstance(body, str) else "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/health":
            self.reply(200 if model is not None else 503, {"model": MODEL_NAME, "ready": model is not None})
        else:
            self.reply(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path.split("?")[0] != "/v1/audio/transcriptions":
            return self.reply(404, {"error": "not found"})
        if model is None:
            return self.reply(503, {"error": "the model is still loading"})
        length = int(self.headers.get("content-length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self.reply(413, {"error": f"body of {length} bytes"})
        body = self.rfile.read(length)
        ctype = self.headers.get("content-type", "")
        if not ctype.startswith("multipart/form-data"):
            return self.reply(400, {"error": "multipart/form-data with a file field"})
        fields = form_fields(ctype, body)
        audio = fields.get("file")
        if not audio:
            return self.reply(400, {"error": "no file"})
        dec = lambda k: fields[k].decode() if k in fields else None  # noqa: E731
        try:
            result = transcribe(audio, dec("language"), dec("prompt"))
        except Exception as err:  # a file the decoder cannot read
            log(f"transcription failed: {err}")
            return self.reply(422, {"error": str(err)})
        log(f"{result['duration']} s of {result['language']} in {result['processing_ms']} ms")
        if dec("response_format") == "text":
            return self.reply(200, result["text"])
        self.reply(200, result)

    def log_message(self, format: str, *args) -> None:  # the access log stays quiet
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    threading.Thread(target=load, daemon=True).start()
    log(f"listening on :{PORT}")
    server.serve_forever()
