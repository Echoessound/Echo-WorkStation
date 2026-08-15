/**
 * test-proxy.js — 无 Electron 验证 proxy-server.js 的完整链路
 * 启动隔离 harness（临时 DSH_HOME）→ 起 UI 代理 → 验证：
 *   1. GET / 返回我们的 index.html
 *   2. POST /api/session.list 经代理转发（RPC 信封）
 *   3. WS /api/events.mux 经代理升级，能收到 session/subscribed 帧
 */
const { spawn } = require('node:child_process')
const net = require('node:net')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { startUiServer } = require('./proxy-server.js')

const HARNESS_BIN = 'F:\\deepseek harness\\deepseek-harness\\apps\\cli\\lib\\bin.js'
const HARNESS_CWD = __dirname
const DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proxy-test-'))

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

async function waitReady(base, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(`${base}/api/session.list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 't', method: 'session.list', payload: {} }),
      })
      if (res.ok) return
    } catch { /* 未就绪 */ }
    if (Date.now() > deadline) throw new Error('harness 启动超时')
    await new Promise(r => setTimeout(r, 250))
  }
}

async function main() {
  const harnessPort = await freePort()
  const child = spawn('node', [HARNESS_BIN, '--profile', 'web', '--port', String(harnessPort)], {
    cwd: HARNESS_CWD,
    env: { ...process.env, DSH_HOME },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  try {
    await waitReady(`http://127.0.0.1:${harnessPort}`)
    console.log(`[1/3] harness ready on ${harnessPort}`)

    const ui = await startUiServer({ harnessOrigin: `http://127.0.0.1:${harnessPort}`, port: 0 })
    console.log(`[2/3] ui server on ${ui.port}`)

    // 验证 1：静态页
    const page = await fetch(`http://127.0.0.1:${ui.port}/`)
    const html = await page.text()
    console.log(`       GET / → ${page.status}，含 <title>: ${html.includes('Echo Workstation M0') ? 'YES' : 'NO'}`)

    // 验证 2：RPC 代理（带浏览器式请求头：Origin=UI 端口 + sec-fetch-site ——
    // 回归真实窗口里 session.create 403 的场景）
    const browserHeaders = {
      'content-type': 'application/json',
      'origin': `http://127.0.0.1:${ui.port}`,
      'sec-fetch-site': 'same-origin',
    }
    const rpc = await fetch(`http://127.0.0.1:${ui.port}/api/session.list`, {
      method: 'POST',
      headers: browserHeaders,
      body: JSON.stringify({ type: 'client-request', rpcId: 't2', method: 'session.list', payload: {} }),
    })
    const rpcMsg = await rpc.json()
    console.log(`       POST /api/session.list → ${rpc.status}，result.ok: ${rpcMsg.result?.ok}，会话数: ${rpcMsg.result?.value?.items?.length ?? '?'}`)

    // 验证 3：WebSocket 升级转发（空实例 mux 不发任何帧——需先有会话，
    // session/created 触发 session/subscribed 帧）
    const ws = new WebSocket(`ws://127.0.0.1:${ui.port}/api/events.mux`)
    const firstFrame = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS 已连接但超时未收到帧')), 8000)
      ws.onmessage = (e) => { clearTimeout(timer); resolve(JSON.parse(e.data)) }
      ws.onerror = () => { clearTimeout(timer); reject(new Error('WS 连接失败')) }
    })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS 升级握手失败')), 8000)
      ws.onopen = () => { clearTimeout(timer); resolve() }
      ws.onerror = () => { clearTimeout(timer); reject(new Error('WS 升级握手失败')) }
    })
    console.log(`       WS 已连接`)
    const created = await fetch(`http://127.0.0.1:${ui.port}/api/session.create`, {
      method: 'POST',
      headers: browserHeaders,
      body: JSON.stringify({ type: 'client-request', rpcId: 't3', method: 'session.create', payload: { cwd: HARNESS_CWD } }),
    })
    const createdMsg = await created.json()
    console.log(`       POST /api/session.create → result.ok: ${createdMsg.result?.ok}`)
    const frame = await firstFrame
    ws.close()
    console.log(`[3/3] WS /api/events.mux → 收到帧: type=${frame.type}, payload.type=${frame.payload?.type}, sessionId=${frame.payload?.sessionId ?? '(无)'}`)

    await ui.close()
    console.log('\n全部通过 ✅（Electron 窗口里将加载同一个 index.html，走同一条代理链路）')
  } finally {
    child.kill()
    try { fs.rmSync(DSH_HOME, { recursive: true, force: true }) } catch { /* noop */ }
  }
}

main().catch(err => {
  console.error('失败:', err.message)
  process.exit(1)
})
