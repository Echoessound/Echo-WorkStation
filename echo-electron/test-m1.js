/**
 * test-m1.js — Echo Workstation M1 集成验证（无 Electron）
 *
 * 链路：隔离 harness（临时 DSH_HOME）→ 产品域 SQLite → UI 服务器（/prod/* + /api 代理）
 * 验证：
 *   1. /prod/health、/prod/toolsets
 *   2. workspace CRUD
 *   3. agent CRUD + preset 文件生成（<DSH_HOME>/.agent-presets/echo-<id>/）
 *   4. 试跑闭环：session.create({agentPreset}) → session.prompt → mux 实时事件 → turn/end
 *      （agent 的 persona 由 preset 注入，验证系统提示词链路）
 *
 * 用法：node test-m1.js [--no-llm]（--no-llm 跳过真实 LLM 试跑，只验证 preset 挂载）
 */
const { spawn } = require('node:child_process')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const { startUiServer } = require('./proxy-server.js')
const { openProductDb } = require('./product/db.js')
const { createProductRouter } = require('./product/routes.js')

const HARNESS_BIN = 'F:\\deepseek harness\\deepseek-harness\\apps\\cli\\lib\\bin.js'
const HARNESS_CWD = __dirname
const NO_LLM = process.argv.includes('--no-llm')

// 测试目录全部放在工作区内（data/test-m1），DSH_HOME 指到测试子目录，
// 这样 agent preset 生成不碰用户真实 ~/.dsh，且沙箱可写。
const TEST_ROOT = path.join(__dirname, 'data', 'test-m1')
const DSH_HOME = path.join(TEST_ROOT, 'dsh-home')
const DB_PATH = path.join(TEST_ROOT, 'product.db')

process.env.DSH_HOME = DSH_HOME

let passed = 0
let failed = 0
function check(label, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ''}`) }
  else { failed += 1; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`) }
}

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

async function rpc(base, method, payload) {
  const res = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'origin': base },
    body: JSON.stringify({ type: 'client-request', rpcId: `m1-${Math.random().toString(36).slice(2)}`, method, payload }),
  })
  const msg = await res.json()
  if (!msg.result?.ok) {
    const err = msg.result?.error ?? {}
    throw new Error(`${method} 失败 [${err.code}]: ${err.message}`)
  }
  return msg.result.value
}

async function prod(base, p, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}/prod/${p}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const msg = await res.json()
  if (!msg.ok) throw new Error(msg.error?.message ?? `HTTP ${res.status}`)
  return msg.value
}

/** 订阅 mux 直到 sessionId 的 turn/end（或超时） */
function collectTurn(wsUrl, sessionId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const events = []
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`等待 turn/end 超时（${timeoutMs}ms），已收集 ${events.length} 个事件`))
    }, timeoutMs)
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        const p = msg?.payload ?? {}
        if (msg?.type !== 'server-request' || p.type !== 'session/event' || p.sessionId !== sessionId) return
        events.push(p.event)
        if (p.event.type === 'turn/end') {
          clearTimeout(timer)
          ws.close()
          resolve(events)
        }
      } catch { /* 忽略坏帧 */ }
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('mux 连接失败')) }
  })
}

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true })
  fs.mkdirSync(TEST_ROOT, { recursive: true })

  const harnessPort = await freePort()
  const child = spawn('node', [HARNESS_BIN, '--profile', 'web', '--port', String(harnessPort)], {
    cwd: HARNESS_CWD,
    env: { ...process.env, DSH_HOME },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  let db = null
  let ui = null
  try {
    await waitReady(`http://127.0.0.1:${harnessPort}`)
    console.log(`[0] harness ready on ${harnessPort}（DSH_HOME=${DSH_HOME}）`)

    db = await openProductDb({ dbPath: DB_PATH })
    const productRouter = createProductRouter({ db })
    ui = await startUiServer({ harnessOrigin: `http://127.0.0.1:${harnessPort}`, port: 0, productRouter })
    const base = `http://127.0.0.1:${ui.port}`
    console.log(`[0] ui server on ${ui.port}`)

    // ── 1. 元信息 ─────────────────────────────────────────────
    console.log('\n[1] 元信息')
    const health = await prod(base, 'health')
    check('health.dshHome 指向测试目录', health.dshHome === DSH_HOME, health.dshHome)
    const toolsets = await prod(base, 'toolsets')
    check('toolsets 返回 3 档', toolsets.length === 3, toolsets.map(t => t.id).join(','))

    // ── 2. workspace CRUD ─────────────────────────────────────
    console.log('\n[2] workspace CRUD')
    const ws = await prod(base, 'workspaces', { method: 'POST', body: { name: '测试工作区', path: TEST_ROOT } })
    check('创建 workspace 返回 id', !!ws.id, ws.id)
    let list = await prod(base, 'workspaces')
    check('列表包含新 workspace', list.items.some(w => w.id === ws.id), `共 ${list.items.length} 个`)
    const wsUpdated = await prod(base, `workspaces/${ws.id}`, { method: 'PUT', body: { name: '改名工作区' } })
    check('更新 workspace 名称', wsUpdated.name === '改名工作区')

    // ── 3. agent CRUD + preset 生成 ───────────────────────────
    console.log('\n[3] agent CRUD + preset 生成')
    const promptText = `你是"测试评审员"。你的职责：用一句话评价用户输入。工作目录 {{cwd}}。`
    const agent = await prod(base, 'agents', {
      method: 'POST',
      body: { name: '测试评审员', description: 'M1 集成测试 agent', systemPrompt: promptText, toolset: 'basic', workspaceId: ws.id },
    })
    check('创建 agent 返回 presetId', /^echo-[0-9a-f]+$/.test(agent.presetId), agent.presetId)

    const presetDir = path.join(DSH_HOME, '.agent-presets', agent.presetId)
    const compositionPath = path.join(presetDir, 'agent.cordis.yml')
    check('preset 目录已生成', fs.existsSync(compositionPath))
    if (fs.existsSync(compositionPath)) {
      const content = fs.readFileSync(compositionPath, 'utf8')
      check('preset 含用户系统提示词', content.includes('你是"测试评审员"'), `${content.length} 字节`)
      check('preset 含 persona 插件行', content.includes("'@deepseek-ai/dsh-persona'"))
      check('preset.yml 已生成', fs.existsSync(path.join(presetDir, 'preset.yml')))
    }

    list = await prod(base, 'agents')
    check('agent 列表包含新 agent', list.items.some(a => a.id === agent.id))
    const agentUpdated = await prod(base, `agents/${agent.id}`, { method: 'PUT', body: { name: '测试评审员V2' } })
    check('更新 agent 名称', agentUpdated.name === '测试评审员V2')

    // ── 4. runs 记录 + 试跑闭环（preset 挂载 → prompt → mux 事件 → 历史可读）──
    console.log('\n[4] runs 记录 + 试跑闭环')
    let sessionId = null
    let runId = null
    try {
      const created = await rpc(base, 'session.create', { cwd: TEST_ROOT, agentPreset: agent.presetId })
      sessionId = created.sessionId
      check('session.create 挂载自定义 preset 成功', true, `${sessionId} · agentPreset=${created.agentPreset ?? ''}`)
    } catch (err) {
      check(`session.create 挂载自定义 preset 成功（失败：${err.message}）`, false)
    }

    if (sessionId) {
      // runs 表记录 agent→session 映射（Chat 面板恢复历史依赖此记录）
      const run = await prod(base, 'runs', {
        method: 'POST',
        body: { kind: 'chat', agentId: agent.id, workspaceId: ws.id, sessionId, input: { text: '测试' } },
      })
      runId = run.id
      check('创建 run 记录成功', !!runId && run.status === 'running', runId)
      const runList = await prod(base, `runs?agentId=${agent.id}`)
      check('按 agent 查询 run 列表', runList.items.some(r => r.id === runId), `共 ${runList.items.length} 条`)

      if (NO_LLM) {
        console.log('  （--no-llm 跳过真实试跑）')
      } else {
        const eventsPromise = collectTurn(`ws://127.0.0.1:${ui.port}/api/events.mux`, sessionId, 180000)
        const accepted = await rpc(base, 'session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: '请用一句话介绍你自己。' }] })
        check('session.prompt 被接受', accepted.accepted === true)
        try {
          const events = await eventsPromise
          const types = events.map(e => e.type)
          const count = (t) => types.filter(x => x === t).length
          console.log(`       收到 ${events.length} 个事件：${[...new Set(types)].join(', ')}`)
          check('收到 user/message', count('user/message') > 0)
          check('收到 assistant/chunk 或 assistant/message', count('assistant/chunk') > 0 || count('assistant/message') > 0)
          check('收到 turn/end', count('turn/end') > 0)
          // 验证 persona 生效：最终助手消息内容非空
          const finalMsg = events.find(e => e.type === 'assistant/message')
          if (finalMsg) {
            const text = JSON.stringify(finalMsg.data?.message ?? finalMsg.data ?? '')
            check('最终回复非空', text.length > 4, text.slice(0, 120))
          }
          // 历史可读（Chat 面板"对话历史保存"的数据基础）
          const hist = await rpc(base, 'session.history', { sessionId })
          const histTypes = (hist.events ?? []).map(e => e.event?.type).filter(Boolean)
          check('session.history 可读且含本回合事件', histTypes.includes('user/message') && histTypes.includes('turn/end'), `共 ${histTypes.length} 个事件`)
          // 状态流转：turn/end 后更新 run 为 success
          const runDone = await prod(base, `runs/${runId}`, { method: 'PUT', body: { status: 'success', finishedAt: Date.now() } })
          check('run 状态更新为 success', runDone.status === 'success' && !!runDone.finishedAt)
        } catch (err) {
          check(`试跑事件流（失败：${err.message}）`, false)
        }
      }
    }

    // ── 5. 清理 ───────────────────────────────────────────────
    console.log('\n[5] 清理')
    if (runId) {
      await prod(base, `runs/${runId}`, { method: 'DELETE' })
      const runsAfter = await prod(base, `runs?agentId=${agent.id}`)
      check('删除 run 后列表为空', runsAfter.items.length === 0)
    }
    await prod(base, `agents/${agent.id}`, { method: 'DELETE' })
    check('删除 agent 后 preset 目录已移除', !fs.existsSync(presetDir))
    await prod(base, `workspaces/${ws.id}`, { method: 'DELETE' })
    const listAfter = await prod(base, 'workspaces')
    check('删除 workspace 后列表为空', listAfter.items.length === 0)

    await ui.close()
    db.close()

    console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
    if (failed > 0) process.exit(1)
    console.log('M1 集成验证全部通过 ✅')
  } finally {
    if (ui) await ui.close().catch(() => {})
    if (db) { try { db.close() } catch { /* noop */ } }
    child.kill()
    try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }) } catch { /* noop */ }
  }
}

main().catch(err => {
  console.error('失败:', err.message)
  process.exit(1)
})
