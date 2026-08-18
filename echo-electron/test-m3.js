/**
 * test-m3.js — Echo Workstation M3 集成验证（产物管线 + 论文模板）
 *
 * 链路：隔离 harness（临时 DSH_HOME）→ 产品域 SQLite → UI 服务器
 * 验证：
 *  [--no-llm] parseArtifactOutput 单测、artifacts CRUD、seed 论文工作流结构
 *  [真实 LLM] 节点以 JSON 输出 → 引擎自动注册产物 → 内容正确；手动保存产物
 *
 * 用法：node test-m3.js [--no-llm]
 */
const { spawn } = require('node:child_process')
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { startUiServer } = require('./proxy-server.js')
const { openProductDb } = require('./product/db.js')
const { createProductRouter } = require('./product/routes.js')
const { parseArtifactOutput } = require('./product/artifact-service.js')

const HARNESS_BIN = 'F:\\deepseek harness\\deepseek-harness\\apps\\cli\\lib\\bin.js'
const HARNESS_CWD = __dirname
const NO_LLM = process.argv.includes('--no-llm')

const TEST_ROOT = path.join(__dirname, 'data', 'test-m3')
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

async function waitRun(base, runId, predicate, label, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const msg = await prod(base, `workflows/runs/${runId}`)
    if (msg.ok && predicate(msg.value)) return msg.value
    if (Date.now() > deadline) throw new Error(`${label} 超时`)
    await new Promise(r => setTimeout(r, 1000))
  }
}

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true })
  fs.mkdirSync(TEST_ROOT, { recursive: true })
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
    console.log(`[0] harness ready on ${harnessPort}`)

    db = await openProductDb({ dbPath: DB_PATH })
    const { handle: productRouter } = createProductRouter({ db, harnessBase: `http://127.0.0.1:${harnessPort}/api` })
    ui = await startUiServer({ harnessOrigin: `http://127.0.0.1:${harnessPort}`, port: 0, productRouter })
    const base = `http://127.0.0.1:${ui.port}`
    console.log(`[0] ui server on ${ui.port}`)

    // ── 1. parseArtifactOutput 单测（纯逻辑）──────────────────
    console.log('\n[1] parseArtifactOutput')
    const mdArt = parseArtifactOutput('{"type":"markdown","title":"报告","content":"# 标题\\n正文"}')
    check('解析 markdown 产物', mdArt?.kind === 'markdown' && mdArt.name === '报告')
    const codeArt = parseArtifactOutput('```json\n{"type":"code","title":"脚本","content":"console.log(1)"}\n```')
    check('解析代码块包裹的 JSON 产物', codeArt?.kind === 'code' && codeArt.name === '脚本')
    check('非 JSON 输出返回 null', parseArtifactOutput('这是普通文本') === null)
    check('未知 type 返回 null', parseArtifactOutput('{"type":"pdf","title":"x","content":"y"}') === null)
    const tableArt = parseArtifactOutput('{"type":"table","title":"表","content":"| a |\\n|---|---|"}')
    check('解析 table 产物', tableArt?.kind === 'table')

    // ── 2. artifacts CRUD API ─────────────────────────────────
    console.log('\n[2] artifacts CRUD')
    const a1 = await prod(base, 'artifacts', {
      method: 'POST',
      body: { name: '测试产物', kind: 'markdown', content: '# Hello\\nworld', runId: 'run-test' },
    })
    check('创建产物', a1.ok && !!a1.value.id, a1.value?.name)
    const list1 = await prod(base, 'artifacts?runId=run-test')
    check('按 runId 查询产物', list1.value.items.some(a => a.id === a1.value.id))
    const get1 = await prod(base, `artifacts/${a1.value.id}`)
    check('产物详情含内容', get1.value.content?.content === '# Hello\\nworld')
    check('未知类型被拒', !(await prod(base, 'artifacts', { method: 'POST', expectOk: false, body: { name: 'x', kind: 'bad', content: 'y' } })).ok)
    await prod(base, `artifacts/${a1.value.id}`, { method: 'DELETE' })
    const listAfter = await prod(base, 'artifacts?runId=run-test')
    check('删除产物', listAfter.value.items.length === 0)

    // ── 3. seed 论文工作流模板 ────────────────────────────────
    console.log('\n[3] seed 论文工作流模板')
    const seed = await prod(base, 'workflows/seed/paper', { method: 'POST' })
    check('seed 创建论文模板', seed.ok, seed.value?.id)
    check('模板结构：5 节点 + 4 边（串行）', seed.value.nodes.length === 5 && seed.value.edges.length === 4)
    const seed2 = await prod(base, 'workflows/seed/paper', { method: 'POST' })
    check('seed 幂等（同 id）', seed2.value.id === seed.value.id)
    const agents = await prod(base, 'agents')
    const builtin = agents.value.items.filter(a => (a.params?.seedKey ?? '').startsWith('paper-'))
    check('seed 创建 5 个内置论文 agent', builtin.length === 5, builtin.map(a => a.name).join(','))
    // 论文节点 prompt 含 JSON 输出契约
    const outlineNode = seed.value.nodes.find(n => n.key === 'paper_outline')
    check('论文节点 prompt 带 JSON 输出契约', /type.*markdown.*title/.test(outlineNode.params?.prompt ?? ''), (outlineNode.params?.prompt ?? '').slice(0, 40))
    const edgeChain = seed.value.edges.map(e => `${e.source}>${e.target}`).join(',')
    const chainOk = ['paper_outline>paper_draft', 'paper_draft>paper_self_review', 'paper_self_review>paper_revise', 'paper_revise>paper_final'].every(s => edgeChain.includes(s))
    check('串行依赖链正确', chainOk, edgeChain)

    // 清理内置论文 agent（真实 LLM 分支不用它们）
    // （--no-llm 也清理，统一在 finally 或此处）

    if (NO_LLM) {
      for (const a of builtin) await prod(base, `agents/${a.id}`, { method: 'DELETE' })
      await prod(base, `workflows/${seed.value.id}`, { method: 'DELETE' })
      console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
      if (failed > 0) process.exit(1)
      console.log('M3 集成验证（--no-llm）全部通过 ✅')
      return
    }

    // ── 4. 引擎自动产物注册（真实 LLM）─────────────────────────
    console.log('\n[4] 引擎节点 JSON 产物自动注册')
    // 用一个自定义 agent + 2 节点 workflow（节点要求 JSON 输出）
    const agentMsg = await prod(base, 'agents', {
      method: 'POST',
      body: { name: 'M3测试agent', systemPrompt: '你是测试助手，严格按要求输出 JSON，不要输出任何其他文字。', toolset: 'none' },
    })
    const agentId = agentMsg.value.id
    const wfMsg = await prod(base, 'workflows', {
      method: 'POST',
      body: {
        name: 'M3产物测试模板',
        nodes: [
          { key: 'writer', agentId, prompt: '用一段话介绍深海探测技术。只输出 JSON：{"type":"markdown","title":"深海探测简介","content":"<一段话 markdown>"}', position: { x: 60, y: 60 } },
        ],
        edges: [],
      },
    })
    const wfId = wfMsg.value.id
    const start = await prod(base, `workflows/${wfId}/run`, { method: 'POST', body: { input: '深海探测' } })
    const runId = start.value.runId
    const detail = await waitRun(base, runId, (d) => ['success', 'failed', 'cancelled'].includes(d.run.status), '产物运行收敛')
    check('run 成功', detail.run.status === 'success', detail.run.error ?? '')
    // 引擎应自动注册产物
    await new Promise(r => setTimeout(r, 1500))
    const artList = await prod(base, `artifacts?runId=${runId}`)
    const autoArt = artList.value.items.find(a => a.nodeKey === 'writer')
    check('引擎自动注册节点产物（JSON 输出）', !!autoArt, artList.value.items.map(a => `${a.nodeKey}:${a.kind}`).join(',') || '(无)')
    if (autoArt) {
      check('自动产物 kind 为 markdown', autoArt.kind === 'markdown')
      check('自动产物内容非空', (autoArt.content?.content ?? '').length > 10, (autoArt.content?.content ?? '').slice(0, 40))
    }

    // ── 5. 手动保存为产物（节点输出原样存）─────────────────────
    console.log('\n[5] 手动保存产物')
    const manual = await prod(base, 'artifacts', {
      method: 'POST',
      body: { runId, sessionId: detail.nodes[0].sessionId, nodeKey: 'writer', name: '手动保存', kind: 'markdown', content: '手动内容' },
    })
    check('手动保存产物', manual.ok && !!manual.value.id)
    const artList2 = await prod(base, `artifacts?runId=${runId}`)
    check('run 产物共 2 个（自动 + 手动）', artList2.value.items.length >= 2, `${artList2.value.items.length} 个`)

    // ── 6. 清理 ───────────────────────────────────────────────
    console.log('\n[6] 清理')
    for (const a of builtin) await prod(base, `agents/${a.id}`, { method: 'DELETE' })
    await prod(base, `workflows/${seed.value.id}`, { method: 'DELETE' })
    await prod(base, `workflows/${wfId}`, { method: 'DELETE' })
    await prod(base, `agents/${agentId}`, { method: 'DELETE' })
    const leftover = await prod(base, 'workflows')
    check('清理后无 workflow 残留', leftover.value.items.length === 0)

    await ui.close()
    db.close()

    console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
    if (failed > 0) process.exit(1)
    console.log('M3 集成验证全部通过 ✅')
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
