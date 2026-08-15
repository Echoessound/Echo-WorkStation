/**
 * proxy-server.js — M0.5 UI 服务器
 *
 * 职责：让 Echo 自己的渲染页与 harness 的 /api 处于「同源」，从而绕开 CORS：
 *  1. 静态 serve renderer/ 目录（index.html + 后续的 JS/CSS 资源）
 *  2. 把 /api/*（HTTP RPC）原样代理到 harness 端口
 *  3. 把 /api/events.mux、/api/events.host 的 WebSocket 升级转发到 harness（mux 下行单向，
 *     升级后做纯 TCP 管道即可）
 *
 * 信任围栏：代理转发时保留 Host: 127.0.0.1:<harness端口>，loopback 天然通过 harness 的
 * 浏览器信任围栏（isTrustedApiRequest），无需改 harness 任何配置。
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function startUiServer({ harnessOrigin, dir = path.join(__dirname, 'renderer'), port = 0, host = '127.0.0.1' }) {
  const harness = new URL(harnessOrigin)

  function proxyApi(req, res) {
    // 关键：harness 信任围栏要求 Origin 与 Host 的 authority 精确一致
    // （isTrustedApiRequest 的跨站检查）。Host 已改写为上游，Origin 必须同步改写，
    // 否则浏览器渲染页发来的 Origin（带 UI 端口）会与上游 Host 不一致 → 403 forbidden。
    const upstreamHeaders = {
      ...req.headers,
      host: `${harness.hostname}:${harness.port}`,
      origin: `${harness.protocol}//${harness.host}`,
    }
    const upstream = http.request({
      host: harness.hostname,
      port: harness.port,
      path: req.url,
      method: req.method,
      headers: upstreamHeaders,
    }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    })
    upstream.on('error', () => {
      try { res.writeHead(502); res.end('bad gateway') } catch { /* 已响应 */ }
    })
    req.pipe(upstream)
  }

  function serveStatic(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const file = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)
    const target = path.normalize(path.join(dir, file))
    if (!target.startsWith(path.normalize(dir))) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    try {
      const data = fs.readFileSync(target)
      res.writeHead(200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream' })
      res.end(data)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/api' || req.url.startsWith('/api/')) proxyApi(req, res)
    else serveStatic(req, res)
  })

  // WebSocket 升级转发：harness 的 mux/host 流是下行单向（客户端发消息会被 1008 关闭），
  // 升级握手转发后做双向裸管道即可。
  server.on('upgrade', (req, socket, head) => {
    const isEvents = req.url === '/api/events.mux' || req.url === '/api/events.host'
    if (!isEvents) {
      socket.destroy()
      return
    }
    const upstream = net.connect(harness.port, harness.hostname, () => {
      // 与 proxyApi 同理：Host/Origin 都归一化为上游 authority，围栏才放行
      const headers = { ...req.headers }
      headers.host = `${harness.hostname}:${harness.port}`
      headers.origin = `${harness.protocol}//${harness.host}`
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`
      for (const [k, v] of Object.entries(headers)) raw += `${k}: ${v}\r\n`
      raw += '\r\n'
      upstream.write(raw)
      if (head && head.length > 0) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.on('close', () => upstream.destroy())
    upstream.on('close', () => socket.destroy())
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      resolve({
        port: server.address().port,
        close: () => new Promise(r => server.close(r)),
      })
    })
  })
}

module.exports = { startUiServer }
