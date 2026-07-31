import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

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
  },
})
