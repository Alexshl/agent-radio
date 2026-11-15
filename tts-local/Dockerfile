# syntax=docker/dockerfile:1
# Local neural voices sidecar (CPU only). Models are downloaded on first start into /models (volume `ttsmodels`).
FROM python:3.11-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git build-essential && rm -rf /var/lib/apt/lists/*
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH PIP_NO_CACHE_DIR=1
COPY requirements.txt /tmp/requirements.txt
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.8.0 torchaudio==2.8.0 \
 && pip install -r /tmp/requirements.txt \
 && pip install --no-deps "git+https://github.com/patriotyk/styletts2-inference@209352700cf703a05ff94501290095dd9072fd5f" \
 && pip install --no-deps git+https://github.com/patriotyk/ipa-uk.git \
 && pip install --no-deps git+https://github.com/patriotyk/ukrainian-word-stress.git \
 && pip install --no-deps git+https://github.com/egorsmkv/ukrainian-accentor.git \
 && pip install --no-deps f5-tts

FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends libsndfile1 espeak-ng ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd -m -u 1000 tts && mkdir /models && chown tts /models
COPY --from=build /opt/venv /opt/venv
# ruaccent installs a helper package (koziev) into its own directory on first start
RUN chown -R tts /opt/venv/lib/python3.11/site-packages/ruaccent
ENV PATH=/opt/venv/bin:$PATH PYTHONUNBUFFERED=1 MODELS_DIR=/models HF_HOME=/models/hf TORCH_HOME=/models/torch \
    STANZA_RESOURCES_DIR=/models/stanza NUMBA_CACHE_DIR=/tmp/numba
WORKDIR /srv
COPY app /srv/app
COPY ref /srv/ref
USER tts
EXPOSE 8795
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request,sys;urllib.request.urlopen('http://127.0.0.1:8795/health',timeout=2)" || exit 1
CMD ["python", "-m", "uvicorn", "app.server:app", "--host", "0.0.0.0", "--port", "8795", "--workers", "1"]
