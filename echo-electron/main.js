/**
 * Echo Workstation M0 — Electron 主进程
 *
 * 职责（对应改造方案 §1 架构）：
 *  1. 挑一个空闲的 loopback 端口
 *  2. 以独立 Node 子进程启动 DeepSeek Harness（dsh 的 web profile；避开 koffi/node-pty 的 Electron ABI 问题）
 *  3. 轮询等待 harness 的 /api 就绪
 *  4. 打开 BrowserWindow 加载 http://127.0.0.1:<port>（loopback 通过 /api 信任围栏，零改动）
 *  5. 退出时回收子进程
 *
 * 渲染进程通过「同源 fetch/WebSocket」直连 harness 的 /api（页面就由 harness 的 web 服务器 serve）。
 * preload 目前只暴露最小元信息；后续把 echo-api.mjs 搬进渲染层即可复用完整契约层。
 */
const { app, BrowserWindow } = require('electron')
const { spawn } = require('node:child_process')
const net = require('node:net')
const path = require('node:path')
const { startUiServer } = require('./proxy-server.js')
const { openProductDb } = require('./product/db.js')
const { createProductRouter } = require('./product/routes.js')
const { createAgentService } = require('./product/services.js')

// 无 GPU 环境（虚拟机/远程桌面/显卡驱动缺失）下，Electron 的 GPU 进程会启动失败
// （exit_code=-1073741515 / 0xC0000135）并导致整个应用退出。Echo 是纯文本 UI，
// 直接禁用硬件加速即可；这些行必须在 app ready 之前执行。
// 本机实测：GPU 进程与渲染进程都死于 0xC0000135 —— LPAC AppContainer 沙箱权限不全，
// 必须 --no-sandbox（见 package.json start 脚本）；以下开关作为 JS 层兜底保留。
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

/** harness 启动器（与 C:\Users\毛颖康\.dsh\bin\dsh.cmd 指向同一个构建产物） */
const HARNESS_BIN = 'F:\\deepseek harness\\deepseek-harness\\apps\\cli\\lib\\bin.js'

/** 从操作系统申请一个空闲的 loopback 端口 */
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

/** 轮询 POST /api/session.list 直到 harness 就绪（HTTP 200 即就绪；业务错误也是 200+信封） */
async function waitHarnessReady(base, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  const fetchFn = globalThis.fetch
  for (;;) {
    try {
      const res = await fetchFn(`${base}/api/session.list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'm0-ping', method: 'session.list', payload: {} }),
      })
      if (res.ok) return
    } catch { /* 还没起来，继续等 */ }
    if (Date.now() > deadline) throw new Error(`harness 启动超时（${timeoutMs}ms）`)
    await new Promise(r => setTimeout(r, 250))
  }
}

let child = null
let ui = null
let productDb = null

async function startHarness(port) {
  // 子进程 cwd 用 echo-electron 自身目录：工作区与用户正在跑的 GUI 隔离，互不干扰
  child = spawn('node', [HARNESS_BIN, '--profile', 'web', '--port', String(port)], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', d => console.log('[harness]', String(d).trim()))
  child.stderr.on('data', d => console.error('[harness]', String(d).trim()))
  child.on('exit', code => console.log(`[harness] exited code=${code}`))
  await waitHarnessReady(`http://127.0.0.1:${port}`)
  console.log(`[harness] ready: http://127.0.0.1:${port}`)
  return port
}

app.whenReady().then(async () => {
  try {
    const distDir = path.join(__dirname, 'renderer', 'dist')
    if (!require('node:fs').existsSync(path.join(distDir, 'index.html'))) {
      console.error('[ui] renderer/dist 缺失，请先执行 npm run build:renderer')
    }
    const port = await freePort()
    await startHarness(port)
    // M1：产品域存储（sql.js）——轨迹留在 harness 会话日志，这里只存产品域
    productDb = await openProductDb()
    // M2：workflow 引擎（调度 harness 会话）需要 harness 的 /api 基址
    const { handle: productRouter, workflowEngine } = createProductRouter({
      db: productDb,
      harnessBase: `http://127.0.0.1:${port}/api`,
    })
    // 应用重启后若 preset 文件丢失（如用户手动删除），重新生成
    const agentService = createAgentService(productDb)
    void agentService.ensurePresets().then(n => {
      if (n > 0) console.log(`[product] ensured ${n} agent preset(s)`)
    }).catch(err => console.error('[product] ensurePresets failed:', err.message))
    // M2：恢复上次中断的 workflow 运行（标记 interrupted，可 resume）
    if (workflowEngine) {
      void workflowEngine.recover().then(n => {
        if (n > 0) console.log(`[workflow] recovered ${n} interrupted run(s)`)
      }).catch(err => console.error('[workflow] recover failed:', err.message))
    }
    // M0.5：serve 我们自己的渲染页（Vite 构建产物），/api 代理 + /prod 产品域
    ui = await startUiServer({ harnessOrigin: `http://127.0.0.1:${port}`, port: 0, productRouter })
    console.log(`[ui] echo page: http://127.0.0.1:${ui.port} (proxy -> ${port})`)
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    // 诊断通道：渲染进程的加载结果与控制台全部转发到主进程终端（调试空白页用）
    win.webContents.on('did-finish-load', async () => {
      console.log('[renderer] page loaded')
      // 页面渲染探针：读取真实 DOM 状态（远程检查窗口是否真的画出了界面）
      try {
        const probe = await win.webContents.executeJavaScript(
          `JSON.stringify({ title: document.title, hasLog: !!document.querySelector('#log'), bodyLen: document.body.innerText.length })`,
        )
        console.log('[renderer] probe:', probe)
      } catch (err) {
        console.error('[renderer] probe failed:', err.message)
      }
    })
    win.webContents.on('did-fail-load', (_e, code, desc, url) =>
      console.error('[renderer] load failed:', code, desc, url))
    win.webContents.on('render-process-gone', (_e, details) =>
      console.error('[renderer] process gone:', JSON.stringify(details)))
    win.webContents.on('preload-error', (_e, p, err) =>
      console.error('[renderer] preload error:', p, err?.message))
    win.webContents.on('console-message', (...args) => {
      // Electron 新旧签名兼容：取 message 字段或位置参数
      const d = args[1]
      const msg = typeof d === 'object' && d !== null ? `${d.level ?? ''} ${d.message} (${d.sourceId ?? ''}:${d.lineNumber ?? ''})`
        : `${args[1]} ${args[2]}`
      console.log('[renderer]', msg)
    })
    win.loadURL(`http://127.0.0.1:${ui.port}`)
    // 调试期自动打开 DevTools（分离窗口），空白页的错误一眼可见；稳定后删掉这行
    win.webContents.openDevTools({ mode: 'detach' })
  } catch (err) {
    console.error('startup failed:', err)
    app.quit()
  }
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('quit', () => {
  // 保守回收：直接 kill node 子进程。Windows 上若 harness 派生过子进程
  // （如原生目录选择器），可换成 taskkill /PID <pid> /T /F 整树回收。
  if (child && !child.killed) child.kill()
  if (ui !== undefined) void ui.close()
  if (productDb) { try { productDb.close() } catch { /* 已关闭 */ } }
})
