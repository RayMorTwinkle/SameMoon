import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { execSync } from 'node:child_process'

// 构建版本标识：git 短哈希 + 构建时间，前端展示用于核对部署的是哪一版
let appVersion: string
try {
  const hash = execSync('git rev-parse --short HEAD').toString().trim()
  const t = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`
  appVersion = `${hash} · ${stamp}`
} catch {
  appVersion = new Date().toISOString()
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    nodePolyfills({ include: ['buffer', 'stream', 'events', 'process'] }),
  ],
  server: {
    port: 3000,
    proxy: {
      '/ws': {
        target: 'http://localhost:4000',
        ws: true,
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  define: {
    global: 'globalThis',
    __APP_VERSION__: JSON.stringify(appVersion),
  },
})
