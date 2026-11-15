import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The SPA lives in src/client, is built to dist/client and served by the Hono app. `npm run dev:client` proxies the API to a running app.
export default defineConfig({
  root: 'src/client',
  publicDir: '../../public',
  plugins: [react()],
  build: { outDir: '../../dist/client', emptyOutDir: true, target: ['safari15', 'chrome90', 'firefox90'] },
  server: { proxy: { '/api': 'http://127.0.0.1:8791', '/stream': 'http://127.0.0.1:8791' } },
})
