/**
 * test-m2.js — Echo Workstation M2 集成验证（无 Electron）
 *
 * 链路：隔离 harness（临时 DSH_HOME）→ 产品域 SQLite → UI 服务器（/prod + /api 代理）
 * 验证：
 *  [--no-llm] workflow CRUD、DAG 校验（环/坏边）、seed 并行评审模板（幂等）
 *  [真实 LLM] 并行评审模板跑通（3 评审并行 → 汇总，验收核心）、审批挂起与放行、
 *             取消、断点恢复（模拟 interrupted → resume → 重新调度）
 *
 * 用法：node test-m2.js [--no-llm]
 */
const { spawn } = require('node:child_process')
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { startUiServer } = require('./proxy-server.js')
const { openProductDb } = require('./product/db.js')
const { createProductRouter } = require('./product/routes.js')
const { validateDefinition } = require('./product/workflow-service.js')

const HARNESS_BIN = 'F:\\deepseek harness\\deepseek-harness\\apps\\cli\\lib\\bin.js'
const HARNESS_CWD = __dirname
const NO_LLM = process.argv.includes('--no-llm')

const TEST_ROOT = path.join(__dirname, 'data', 'test-m2')
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

async function prod(base, p, { method = 'GET', body, expectOk = true } = {}) {
  const res = await fetch(`${base}/prod/${p}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const msg = await res.json()
  if (expectOk && !msg.ok) throw new Error(msg.error?.message ?? `HTTP ${res.status}`)
  return msg
}

/** harness RPC（信封） */
async function rpc(base, method, payload) {
  const res = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'origin': base },
    body: JSON.stringify({ type: 'client-request', rpcId: `m2-${Math.random().toString(36).slice(2)}`, method, payload }),
  })
  const msg = await res.json()
  if (!msg.result?.ok) {
    const err = msg.result?.error ?? {}
    throw new Error(`${method} 失败 [${err.code}]: ${err.message}`)
  }
  return msg.result.value
}

/** 轮询 run 详情直到 predicate 满足（或超时） */
async function waitRun(base, runId, predicate, label, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const msg = await prod(base, `workflows/runs/${runId}`)
    if (msg.ok && predicate(msg.value)) return msg.value
    if (Date.now() > deadline) {
      throw new Error(`${label} 超时（最后状态: ${msg.ok ? msg.value.run.status : 'err'}）`)
    }
    await new Promise(r => setTimeout(r, 1000))
  }
}

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true })
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  // 复制真实 credentials（API key）到测试 DSH_HOME：harness 调 LLM 需要
  const realCred = path.join(os.homedir(), '.dsh', '.credentials.yaml')
  fs.mkdirSync(DSH_HOME, { recursive: true })
  if (fs.existsSync(realCred)) fs.copyFileSync(realCred, path.join(DSH_HOME, '.credentials.yaml'))

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
    const { handle: productRouter } = createProductRouter({ db, harnessBase: `http://127.0.0.1:${harnessPort}/api` })
    ui = await startUiServer({ harnessOrigin: `http://127.0.0.1:${harnessPort}`, port: 0, productRouter })
    const base = `http://127.0.0.1:${ui.port}`
    console.log(`[0] ui server on ${ui.port}`)

    // ── 1. DAG 校验（纯逻辑）─────────────────────────────────
    console.log('\n[1] DAG 校验')
    check('合法定义通过', validateDefinition({ nodes: [{ key: 'a', agentId: 'x', prompt: 'p' }], edges: [] }).ok)
    check('缺节点拒绝', !validateDefinition({ nodes: [], edges: [] }).ok)
    check('重复 key 拒绝', !validateDefinition({
      nodes: [{ key: 'a', agentId: 'x', prompt: 'p' }, { key: 'a', agentId: 'y', prompt: 'q' }], edges: [],
    }).ok)
    check('坏边拒绝', !validateDefinition({ nodes: [{ key: 'a', agentId: 'x', prompt: 'p' }], edges: [{ source: 'a', target: 'zzz' }] }).ok)
    const cyclic = validateDefinition({
      nodes: [{ key: 'a', agentId: 'x', prompt: 'p' }, { key: 'b', agentId: 'y', prompt: 'q' }],
      edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }],
    })
    check('环检测拒绝', !cyclic.ok, cyclic.error)
    check('无 agent 节点拒绝', !validateDefinition({ nodes: [{ key: 'a', prompt: 'p' }], edges: [] }).ok)

    // ── 2. workflow CRUD ──────────────────────────────────────
    console.log('\n[2] workflow CRUD')
    // 先建一个占位 agent（模板节点需要 agentId；--no-llm 下也用）
    const agentMsg = await prod(base, 'agents', {
      method: 'POST',
      body: { name: 'M2测试agent', systemPrompt: '你是测试助手。', toolset: 'none' },
    })
    const agentId = agentMsg.value.id
    check('创建测试 agent', !!agentId)

    const wfMsg = await prod(base, 'workflows', {
      method: 'POST',
      body: {
        name: '链式测试模板',
        nodes: [
          { key: 'step1', agentId, prompt: '第一步：{{input}}', position: { x: 0, y: 0 } },
          { key: 'step2', agentId, prompt: '第二步：{{node:step1}}', position: { x: 260, y: 0 } },
        ],
        edges: [{ source: 'step1', target: 'step2' }],
      },
    })
    check('创建 workflow 成功', wfMsg.ok, wfMsg.value?.id)
    const wfId = wfMsg.value.id

    const listMsg = await prod(base, 'workflows')
    check('workflow 列表包含新模板', listMsg.value.items.some(w => w.id === wfId), `共 ${listMsg.value.items.length} 个`)

    const getMsg = await prod(base, `workflows/${wfId}`)
    check('模板详情含 nodes/edges', getMsg.value.nodes.length === 2 && getMsg.value.edges.length === 1)

    // 带环的更新应被拒绝
    const cyclicMsg = await prod(base, `workflows/${wfId}`, {
      method: 'PUT',
      expectOk: false,
      body: {
        name: '环模板',
        nodes: [
          { key: 'a', agentId, prompt: 'p' },
          { key: 'b', agentId, prompt: 'q' },
        ],
        edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }],
      },
    })
    check('保存带环定义被拒绝', !cyclicMsg.ok && /环/.test(cyclicMsg.error?.message ?? ''), cyclicMsg.error?.message)

    // ── 3. seed 并行评审模板（幂等）───────────────────────────
    console.log('\n[3] seed 并行评审模板')
    const seed1 = await prod(base, 'workflows/seed/review', { method: 'POST' })
    check('seed 创建评审模板', seed1.ok, seed1.value?.id)
    const reviewId = seed1.value.id
    check('模板结构：4 节点 + 3 边', seed1.value.nodes.length === 4 && seed1.value.edges.length === 3)
    const seed2 = await prod(base, 'workflows/seed/review', { method: 'POST' })
    check('seed 幂等（同 id）', seed2.value.id === reviewId)
    const agentsAfter = await prod(base, 'agents')
    const builtin = agentsAfter.value.items.filter(a => (a.params?.seedKey ?? '').startsWith('review-'))
    check('seed 创建 4 个内置评审 agent', builtin.length === 4, builtin.map(a => a.name).join(','))

    // 回归：内置 agent 的 systemPrompt 是多行的（含换行），preset YAML 缩进必须可挂载
    try {
      const codeAgent = builtin.find(a => a.name === '评审·代码')
      const created = await rpc(base, 'session.create', { cwd: TEST_ROOT, agentPreset: codeAgent.presetId })
      check('多行 systemPrompt 的 preset 可挂载（YAML 缩进回归）', true, created.sessionId)
    } catch (err) {
      check(`多行 systemPrompt 的 preset 可挂载（失败：${err.message}）`, false)
    }

    if (NO_LLM) {
      console.log('  （--no-llm 跳过真实运行验证）')
      // 清理
      for (const a of builtin) await prod(base, `agents/${a.id}`, { method: 'DELETE' })
      await prod(base, `workflows/${reviewId}`, { method: 'DELETE' })
      await prod(base, `workflows/${wfId}`, { method: 'DELETE' })
      await prod(base, `agents/${agentId}`, { method: 'DELETE' })
      console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
      if (failed > 0) process.exit(1)
      console.log('M2 集成验证（--no-llm）全部通过 ✅')
      return
    }

    // ── 4. 并行评审模板真实跑通（验收核心）────────────────────
    console.log('\n[4] 并行评审模板真实运行')
    const inputText = '评审对象：一个用 setTimeout 实现的防抖函数 debounce(fn, delay)。'
    const startMsg = await prod(base, `workflows/${reviewId}/run`, { method: 'POST', body: { input: inputText } })
    check('启动运行', startMsg.ok, startMsg.value?.runId)
    const reviewRunId = startMsg.value.runId

    const detail = await waitRun(base, reviewRunId,
      (d) => ['success', 'failed', 'cancelled'].includes(d.run.status), '评审运行收敛', 600000)
    console.log(`       终态: ${detail.run.status}，节点: ${detail.nodes.map(n => `${n.nodeKey}=${n.status}`).join(', ')}`)
    check('run 最终 success', detail.run.status === 'success', detail.run.error ?? '')
    const reviewNodes = detail.nodes.filter(n => n.nodeKey.startsWith('review_') && !n.nodeKey.includes('summary'))
    check('3 个评审节点全部 success', reviewNodes.length === 3 && reviewNodes.every(n => n.status === 'success'))
    check('评审节点输出非空', reviewNodes.every(n => (n.output ?? '').length > 20))
    const summaryNode = detail.nodes.find(n => n.nodeKey === 'summary')
    check('汇总节点 success 且输出非空', summaryNode?.status === 'success' && (summaryNode.output ?? '').length > 50, `输出 ${summaryNode?.output?.length ?? 0} 字符`)
    check('汇总输出包含评审内容（变量传递）', /评审|问题|建议/.test(summaryNode?.output ?? ''), summaryNode?.output?.slice(0, 80))

    // ── 5. 审批挂起 → 放行 ────────────────────────────────────
    console.log('\n[5] 审批挂起与放行')
    const apprMsg = await prod(base, 'workflows', {
      method: 'POST',
      body: {
        name: '审批测试模板',
        nodes: [
          { key: 'draft', agentId, prompt: '草拟一段两句话的产品介绍：{{input}}' },
          { key: 'publish', agentId, prompt: '润色以下草稿并发布：{{node:draft}}', requiresApproval: true },
        ],
        edges: [{ source: 'draft', target: 'publish' }],
      },
    })
    const apprWfId = apprMsg.value.id
    const apprStart = await prod(base, `workflows/${apprWfId}/run`, { method: 'POST', body: { input: '智能台灯' } })
    const apprRunId = apprStart.value.runId
    // 等 draft 完成 → publish 应停在 awaiting_approval
    const awaiting = await waitRun(base, apprRunId,
      (d) => d.nodes.some(n => n.nodeKey === 'publish' && n.status === 'awaiting_approval'), '节点进入等待审批', 300000)
    const publishNode = awaiting.nodes.find(n => n.nodeKey === 'publish')
    check('审批节点进入 awaiting_approval', publishNode.status === 'awaiting_approval')
    check('审批节点尚未建会话', !publishNode.sessionId)
    // 放行
    const approveMsg = await prod(base, `workflows/runs/${apprRunId}/nodes/publish/approve`, { method: 'POST' })
    check('approve 放行', approveMsg.ok)
    const apprDone = await waitRun(base, apprRunId,
      (d) => ['success', 'failed', 'cancelled'].includes(d.run.status), '审批运行收敛', 300000)
    const pubDone = apprDone.nodes.find(n => n.nodeKey === 'publish')
    check('审批通过后节点执行成功', apprDone.run.status === 'success' && pubDone.status === 'success', pubDone.error ?? '')

    // ── 6. 取消 ───────────────────────────────────────────────
    console.log('\n[6] 取消运行')
    const cancelStart = await prod(base, `workflows/${apprWfId}/run`, { method: 'POST', body: { input: '取消测试' } })
    const cancelRunId = cancelStart.value.runId
    await new Promise(r => setTimeout(r, 800))
    const cancelMsg = await prod(base, `workflows/runs/${cancelRunId}/cancel`, { method: 'POST' })
    check('cancel 请求成功', cancelMsg.ok)
    const cancelled = await waitRun(base, cancelRunId,
      (d) => d.run.status === 'cancelled', '运行置为 cancelled', 60000)
    check('run 状态 cancelled', cancelled.run.status === 'cancelled')
    check('无节点残留 running', cancelled.nodes.every(n => n.status !== 'running'))

    // ── 7. 断点恢复（模拟中断 → resume → 重新调度）────────────
    console.log('\n[7] 断点恢复')
    const recStart = await prod(base, `workflows/${apprWfId}/run`, { method: 'POST', body: { input: '恢复测试' } })
    const recRunId = recStart.value.runId
    // 模拟应用崩溃：直接把 run 标 failed、节点标 interrupted（引擎 recover 的行为）
    db.run('UPDATE workflow_run_nodes SET status = ? WHERE run_id = ?', ['interrupted', recRunId])
    db.run("UPDATE runs SET status = 'failed', error = '模拟中断' WHERE id = ?", [recRunId])
    const before = await prod(base, `workflows/runs/${recRunId}`)
    check('模拟中断后节点 interrupted', before.value.nodes.every(n => n.status === 'interrupted'))
    const resumeMsg = await prod(base, `workflows/runs/${recRunId}/resume`, { method: 'POST' })
    check('resume 请求成功', resumeMsg.ok)
    const resumed = await waitRun(base, recRunId,
      (d) => d.run.status === 'running' && d.nodes.some(n => n.status === 'running'), 'resume 后重新调度', 60000)
    check('resume 后节点重新进入 running', resumed.nodes.some(n => n.status === 'running'))
    await prod(base, `workflows/runs/${recRunId}/cancel`, { method: 'POST' })

    // ── 8. 清理 ───────────────────────────────────────────────
    console.log('\n[8] 清理')
    for (const a of builtin) await prod(base, `agents/${a.id}`, { method: 'DELETE' })
    await prod(base, `workflows/${reviewId}`, { method: 'DELETE' })
    await prod(base, `workflows/${apprWfId}`, { method: 'DELETE' })
    await prod(base, `workflows/${wfId}`, { method: 'DELETE' })
    await prod(base, `agents/${agentId}`, { method: 'DELETE' })
    const leftover = await prod(base, 'workflows')
    check('清理后无 workflow 残留', leftover.value.items.length === 0)

    await ui.close()
    db.close()

    console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
    if (failed > 0) process.exit(1)
    console.log('M2 集成验证全部通过 ✅')
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
