import asyncio
import io
import os
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field

from .engines import build_engines

MAX_TEXT = 2500
SYNTH_TIMEOUT_S = float(os.environ.get("TTS_LOCAL_TIMEOUT", "240"))
MAX_QUEUE = 3

engines = build_engines()
# concurrency 1 per engine: one worker thread each
pools = {k: ThreadPoolExecutor(max_workers=1, thread_name_prefix=k) for k in engines}
waiting = {k: 0 for k in engines}
app = FastAPI(title="agent-radio tts-local")


def _load_all() -> None:
    # sequential: one download / RAM spike at a time
    for e in engines.values():
        e.load()


@app.on_event("startup")
def startup() -> None:
    threading.Thread(target=_load_all, name="loader", daemon=True).start()


class Synth(BaseModel):
    engine: str
    voice: str = ""
    text: str = Field(min_length=1, max_length=MAX_TEXT)
    rate: float = Field(default=1.0, ge=0.5, le=2.0)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/voices")
def voices():
    return {"engines": [e.info() for e in engines.values()]}


def _run(engine, req: Synth) -> tuple[bytes, bool]:
    samples, sr, native = engine.synthesize(req.voice, req.text, req.rate)
    buf = io.BytesIO()
    sf.write(buf, np.clip(samples, -1, 1), sr, format="WAV", subtype="PCM_16")
    return buf.getvalue(), native


@app.post("/synthesize")
async def synthesize(req: Synth):
    engine = engines.get(req.engine)
    if engine is None:
        raise HTTPException(404, "unknown or disabled engine")
    if engine.status != "ready":
        raise HTTPException(503, f"engine {engine.status}: {engine.error}".strip())
    if waiting[req.engine] >= MAX_QUEUE:
        raise HTTPException(429, "engine busy")
    waiting[req.engine] += 1
    loop = asyncio.get_running_loop()
    try:
        data, native = await asyncio.wait_for(loop.run_in_executor(pools[req.engine], _run, engine, req), SYNTH_TIMEOUT_S)
    except asyncio.TimeoutError:
        raise HTTPException(504, "synthesis timed out")
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        waiting[req.engine] -= 1
    return Response(content=data, media_type="audio/wav", headers={"X-Rate-Native": "1" if native else "0"})
