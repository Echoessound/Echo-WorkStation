import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: dir,
  plugins: [react()],
  base: './', // 相对路径：Electron 的 http://127.0.0.1:<port>/ 与 file:// 均可
  build: {
    outDir: path.join(dir, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    // 开发模式（npm run dev:renderer）：把 harness /api 与产品域 /prod 代理到
    // 正在运行的 harness（默认 http://127.0.0.1:3080，可用环境变量 DSH_API_TARGET 覆盖）。
    // 开发时先手动起一个 harness：node <harness bin> --profile web --port 3080
    proxy: {
      '/api': { target: process.env.DSH_API_TARGET || 'http://127.0.0.1:3080', changeOrigin: true, ws: true },
    },
  },
})
