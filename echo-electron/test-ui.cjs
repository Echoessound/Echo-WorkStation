/**
 * test-ui.mjs — Electron 渲染层探测（调试 Workflow 设计器连线）
 * 起完整栈（harness + 产品域 + UI 服务器）→ 打开窗口 → 模拟点击进入设计器
 * → 添加节点 → 探测 Handle 渲染状态与可见性。
 */
const { app, BrowserWindow } = require('electron')
const { spawn } = require('node:child_process')
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { startUiServer } = require('./proxy-server.js')
const { openProductDb } = require('./product/db.js')
const { createProductRouter } = require('./product/routes.js')

const HARNESS_BIN = 'F:\\deepseek harness\\deepseek-harness\\apps\\cli\\lib\\bin.js'
const TEST_ROOT = path.join(__dirname, 'data', 'test-ui')
const DSH_HOME = path.join(TEST_ROOT, 'dsh-home')

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

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true })
  fs.mkdirSync(DSH_HOME, { recursive: true })
  const realCred = path.join(os.homedir(), '.dsh', '.credentials.yaml')
  if (fs.existsSync(realCred)) fs.copyFileSync(realCred, path.join(DSH_HOME, '.credentials.yaml'))

  const harnessPort = await freePort()
  const child = spawn('node', [HARNESS_BIN, '--profile', 'web', '--port', String(harnessPort)], {
    cwd: __dirname,
    env: { ...process.env, DSH_HOME },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  let db = null
  let ui = null
  try {
    await waitReady(`http://127.0.0.1:${harnessPort}`)
    db = await openProductDb({ dbPath: path.join(TEST_ROOT, 'product.db') })
    const { handle: productRouter } = createProductRouter({ db, harnessBase: `http://127.0.0.1:${harnessPort}/api` })
    ui = await startUiServer({ harnessOrigin: `http://127.0.0.1:${harnessPort}`, port: 0, productRouter })
    const uiBase = `http://127.0.0.1:${ui.port}`
    console.log('[0] ui on', ui.port)

    await app.whenReady()
    const win = new BrowserWindow({
      width: 1280, height: 800, show: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    })
    win.webContents.on('console-message', (...args) => {
      const d = args[1]
      const msg = typeof d === 'object' && d !== null ? `${d.level} ${d.message}` : `${args[1]} ${args[2]}`
      console.log('[renderer]', msg)
    })
    await win.loadURL(uiBase)
    await sleep(1500)

    const js = (code) => win.webContents.executeJavaScript(code, true)

    // 1. 切到 Workflow 设计 tab
    const tabClicked = await js(`
      (() => {
        const b = [...document.querySelectorAll('.tabs button')].find(x => x.textContent.includes('Workflow'));
        if (!b) return 'NO_TAB'; b.click(); return 'CLICKED'
      })()
    `)
    console.log('[1] tab click:', tabClicked)
    await sleep(800)

    // 2. 添加节点
    const addClicked = await js(`
      (() => {
        const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('节点') && !x.textContent.includes('删除'));
        if (!b) return 'NO_ADD_BTN'; b.click(); return 'CLICKED'
      })()
    `)
    console.log('[2] add node click:', addClicked)
    await sleep(1200)

    // 3. 探测画布与 Handle
    const probe = await js(`
      JSON.stringify({
        nodeCount: document.querySelectorAll('.react-flow__node').length,
        handleCount: document.querySelectorAll('.react-flow__handle').length,
        handleInfo: [...document.querySelectorAll('.react-flow__handle')].map(h => ({
          pos: h.getAttribute('data-handlepos'),
          cls: h.className,
          w: getComputedStyle(h).width,
          h2: getComputedStyle(h).height,
          bg: getComputedStyle(h).background,
          display: getComputedStyle(h).display,
          pointerEvents: getComputedStyle(h).pointerEvents,
        })),
        rfRoot: !!document.querySelector('.react-flow'),
        cssLoaded: [...document.styleSheets].some(s => { try { return [...s.cssRules].some(r => r.selectorText && r.selectorText.includes('react-flow__handle')) } catch { return false } }),
        bodyText: document.body.innerText.slice(0, 200),
      })
    `)
    console.log('[3] probe:', probe)

    // 4. 再探测可见性
    const probe2 = await js(`
      JSON.stringify({
        handlesVisible: [...document.querySelectorAll('.react-flow__handle')].every(h => h.getBoundingClientRect().width > 0),
        nodeTypeAttr: [...document.querySelectorAll('.react-flow__node')].map(n => n.getAttribute('data-id') + ':' + n.className.split(' ').slice(0,3).join('.')),
      })
    `)
    console.log('[4] probe2:', probe2)

    // 4.5 CDP 输入管线验证：真实点击「＋ 节点」按钮
    let mouse = null
    try {
      win.webContents.debugger.attach('1.3')
      mouse = (type, x, y, opts = {}) =>
        win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type, x, y, button: 'left', clickCount: 1, ...opts,
        })
    } catch { /* noop */ }
    const btnRect = JSON.parse(await js(`
      JSON.stringify((() => {
        const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('节点') && !x.textContent.includes('删除'));
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })())
    `))
    if (btnRect && mouse) {
      await mouse('mousePressed', btnRect.x, btnRect.y, { buttons: 1 })
      await sleep(80)
      await mouse('mouseReleased', btnRect.x, btnRect.y, { buttons: 0 })
      await sleep(800)
      const n = await js(`document.querySelectorAll('.react-flow__node').length`)
      console.log('[4.5] CDP click add-node → nodeCount:', n, '(期望 2)')
    } else {
      console.log('[4.5] CDP click skipped')
    }

    // 4.6 handle 事件到达性探测（原生捕获监听）
    await js(`(() => {
      const hs = [...document.querySelectorAll('.react-flow__handle')]
      hs.forEach(h => {
        h.addEventListener('mousedown', e => { window.__hdMousedown = { x: e.clientX, y: e.clientY, button: e.button, isTrusted: e.isTrusted, cls: e.target.className } }, true)
        h.addEventListener('pointerdown', e => { window.__hdPointer = { x: e.clientX, isTrusted: e.isTrusted } }, true)
      })
      window.__hdMousedown = null
      window.__hdPointer = null
      return 'LISTENERS_ADDED'
    })()`)
    console.log('[4.6] listeners added')

    // 4.7 命中检测：source handle 中心处最上层元素 + 全层级
    const hitTest = await js(`JSON.stringify((() => {
      const hs = [...document.querySelectorAll('.react-flow__handle')]
      const src = hs.find(h => h.getAttribute('data-handlepos') === 'right')
      if (!src) return { err: 'NO_SRC' }
      const r = src.getBoundingClientRect()
      const x = r.x + r.width / 2, y = r.y + r.height / 2
      const els = document.elementsFromPoint(x, y).map(e => String(e.className).slice(0, 80) || e.tagName)
      const nodeEl = src.closest('.react-flow__node')
      const nodeRect = nodeEl ? nodeEl.getBoundingClientRect() : null
      return {
        x, y,
        handleRect: { l: r.left, t: r.top, w: r.width, h: r.height },
        nodeRect: nodeRect ? { l: nodeRect.left, t: nodeRect.top, w: nodeRect.width, h: nodeRect.height } : null,
        layers: els,
      }
    })())`)
    console.log('[4.7] hit test:', hitTest)

    // 4.8 读 ReactFlow 内部 store 的 nodeLookup.handleBounds（fiber 树遍历找 zustand store）
    const hbProbe = await js(`JSON.stringify((() => {
      const el = document.querySelector('.react-flow')
      if (!el) return { err: 'NO_FLOW' }
      const k = Object.keys(el).find(x => x.startsWith('__reactFiber$'))
      if (!k) return { err: 'NO_FIBER' }
      let found = null
      const walk = (f, depth) => {
        if (!f || depth > 100 || found) return
        try {
          for (const cand of [f.memoizedState, f.memoizedProps?.value, f.memoizedProps?.store]) {
            if (cand && typeof cand.getState === 'function') {
              const st = cand.getState()
              if (st && st.nodeLookup) { found = cand; return }
            }
          }
        } catch { /* noop */ }
        walk(f.child, depth + 1)
        walk(f.sibling, depth)
      }
      walk(el[k], 0)
      if (!found) return { err: 'STORE_NOT_FOUND' }
      const out = {}
      for (const [id, n] of found.getState().nodeLookup) {
        out[id] = {
          hbSource: n.internals?.handleBounds?.source,
          hbTarget: n.internals?.handleBounds?.target,
          measured: n.measured,
          position: n.position,
        }
      }
      return out
    })())`)
    console.log('[4.8] handleBounds:', hbProbe)

    // 5. CDP 真实鼠标从第一个 node 的 source handle 拖线到最后一个 node 的 target handle。
    //    等布局稳定（fitView 动画 + MiniMap 尺寸变化会导致 rect 短暂过期），
    //    拖拽前重读坐标并验证目标处确实是 handle，最多重试 3 次。
    await sleep(1500)
    let coords = null
    for (let attempt = 0; attempt < 3 && !coords; attempt += 1) {
      const cand = JSON.parse(await js(`
        JSON.stringify((() => {
          const hs = [...document.querySelectorAll('.react-flow__handle')]
          const src = hs.find(h => h.getAttribute('data-handlepos') === 'right')
          const tgts = hs.filter(h => h.getAttribute('data-handlepos') === 'left')
          const tgt = tgts[tgts.length - 1]
          if (!src || !tgt) return { err: 'NO_HANDLES' }
          const a = src.getBoundingClientRect()
          const b = tgt.getBoundingClientRect()
          const sx = Math.round(a.x + a.width / 2), sy = Math.round(a.y + a.height / 2)
          const tx = Math.round(b.x + b.width / 2), ty = Math.round(b.y + b.height / 2)
          const atTgt = document.elementFromPoint(tx, ty)
          const atSrc = document.elementFromPoint(sx, sy)
          const okTgt = atTgt && String(atTgt.className).includes('react-flow__handle-left')
          const okSrc = atSrc && String(atSrc.className).includes('react-flow__handle-right')
          return { sx, sy, tx, ty, okTgt, okSrc, attempt: ${attempt} }
        })())
      `))
      if (!cand.err && cand.okTgt && cand.okSrc) coords = cand
      else { console.log(`[5] coord retry ${attempt + 1}:`, JSON.stringify(cand)); await sleep(600) }
    }
    if (!coords.err && mouse) {
      const { sx, sy, tx, ty } = coords
      // document 级事件计数：验证 XYHandle 注册的 doc 监听能否收到
      await js(`(() => {
        window.__moveCount = 0; window.__upCount = 0
        document.addEventListener('mousemove', () => { window.__moveCount += 1 })
        document.addEventListener('mouseup', () => { window.__upCount += 1 })
        return 'COUNTING'
      })()`)
      await mouse('mousePressed', sx, sy, { buttons: 1 })
      for (let i = 1; i <= 10; i += 1) {
        await mouse('mouseMoved', Math.round(sx + (tx - sx) * i / 10), Math.round(sy + (ty - sy) * i / 10), { buttons: 1 })
        await sleep(30)
      }
      // mouseup 前查目标坐标处的元素
      const atTarget = await js(`JSON.stringify((() => {
        const els = document.elementsFromPoint(${tx}, ${ty}).map(e => String(e.className).slice(0, 70) || e.tagName)
        return { tx: ${tx}, ty: ${ty}, layers: els }
      })())`)
      console.log('[5.0] at target:', atTarget)
      await mouse('mouseReleased', tx, ty, { buttons: 0 })
      console.log(`[5] CDP drag: (${sx},${sy}) -> (${tx},${ty})`)
      await sleep(400)
      const counts = await js(`JSON.stringify({ move: window.__moveCount, up: window.__upCount })`)
      console.log('[5.1] doc event counts:', counts)
      const evtProbe = await js(`JSON.stringify({ md: window.__hdMousedown, pd: window.__hdPointer })`)
      console.log('[5.5] event reach:', evtProbe)
      await sleep(800)
    } else {
      console.log('[5] CDP drag skipped:', coords.err ?? 'no CDP')
    }
    const edgeProbe = await js(`
      JSON.stringify({
        edgeCount: document.querySelectorAll('.react-flow__edge').length,
        edges: [...document.querySelectorAll('.react-flow__edge')].map(e => e.className),
      })
    `)
    console.log('[6] edge probe:', edgeProbe)

    console.log('\nDONE')
  } finally {
    try { app.quit() } catch { /* noop */ }
    if (ui) await ui.close().catch(() => {})
    if (db) { try { db.close() } catch { /* noop */ } }
    child.kill()
    try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }) } catch { /* noop */ }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
