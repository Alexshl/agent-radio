# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS prod-deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# the React app (vite build -> dist/client)
FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY public ./public
COPY src/client ./src/client
RUN npx vite build

# piper (python wheel, bundles onnxruntime + espeak-ng data) in its own venv
FROM node:22-bookworm-slim AS piper
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/piper && /opt/piper/bin/pip install --no-cache-dir piper-tts

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=piper /opt/piper /opt/piper
ENV PATH=/opt/piper/bin:$PATH NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY migrations ./migrations
COPY src ./src
COPY client ./client
COPY --from=web /app/dist/client ./dist/client
# volumes inherit this ownership on first creation (liquidsoap reads /shared with another uid: files are written world-readable)
RUN mkdir -p /data /shared && chown node:node /data /shared
USER node
ENV DATA_DIR=/data PORT=8790
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/server/index.ts"]
