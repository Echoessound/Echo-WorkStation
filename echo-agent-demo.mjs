#!/usr/bin/env node
/**
 * echo-agent-demo.mjs — Echo Workstation 改造方案的 M0 最小验证（保守版）
 *
 * 目标：不动 harness、不写 Electron、不生成 preset，只用官方 /api 在
 * 「正在运行的 GUI harness」上完成一次 agent 试跑闭环：
 *
 *   session.create（新建会话）
 *     → 订阅 /api/events.mux SSE 实时事件流（CoT 增量 / 正文增量 / 工具调用）
 *     → session.prompt（发送提示词）
 *     → 回合结束 → 汇总（工具次数 / token 用量 / 结束原因）
 *     → 可选 --artifact：输出契约→产物注册最小版（§6.3 管线的雏形）
 *
 * 用法：
 *   node echo-agent-demo.mjs                          # 默认无害文本任务（不调用工具）
 *   node echo-agent-demo.mjs "你的自定义提示词"         # 自定义任务（可试工具类）
 *   node echo-agent-demo.mjs --artifact summary "把…结果以纯 JSON 输出"
 *   DSH_API=…  TIMEOUT_MS=180000  node echo-agent-demo.mjs
 *
 * 保守约定：
 *  - 只调官方 /api（session.create / session.prompt / session.history / events.mux），不改任何 harness 代码；
 *  - 会话会在 GUI 的会话列表里出现（可在 GUI 里同步观看同一份 CoT）；
 *  - 默认任务不调用工具，避免任何文件/命令副作用。
 *
 * 实时性：WebSocket（/api/events.mux，见 echo-api.mjs）为主，1.5s 轮询 session.history 兜底/回填
 * （两者按事件 seq 去重，WS 断流时轮询自动接管）。
 * 注：本部署的 /api/events.mux GET 被 client-connection 拦截返回 426，SSE 不可用，实时流只有 WS。
 */

import { EchoApi } from './echo-api.mjs'

const api = new EchoApi()
const BASE = api.base
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 180_000)
const POLL_MS = 1500
const DEFAULT_PROMPT = '请用一句话介绍你自己，并说明你能做什么。不要调用任何工具。'

// ---- 提取 ----
function messageParts(data) {
  const msg = data?.message ?? data
  if (!msg || typeof msg !== 'object') return { reasoning: '', text: '' }
  if (typeof msg.text === 'string') return { reasoning: '', text: msg.text }
  if (Array.isArray(msg.content)) {
    const reasoning = []
    const rest = []
    for (const b of msg.content) {
      if (b?.type === 'reasoning') reasoning.push(b.text ?? '')
      else if (b?.type === 'text') rest.push(b.text)
      else if (b?.type === 'image') rest.push('[image]')
      else rest.push(`[${b?.type ?? 'block'}]`)
    }
    return { reasoning: reasoning.join('\n\n'), text: rest.join('\n') }
  }
  return { reasoning: '', text: '' }
}
function prettyJson(v) { try { return JSON.stringify(JSON.parse(v), null, 2) } catch { return String(v) } }
function truncate(v, n = 300) {
  const s = String(v)
  return s.length > n ? `${s.slice(0, n)}…(${s.length} 字符)` : s
}

/** 从最终消息文本提取 JSON 对象（整段或 ```json 围栏），失败返回 null */
function extractJson(text) {
  if (!text) return null
  try {
    const v = JSON.parse(text)
    return typeof v === 'object' && v !== null ? v : null
  } catch { /* 继续尝试围栏 */ }
  const m = text.match(/```json\s*([\s\S]*?)```/)
  if (m) {
    try {
      const v = JSON.parse(m[1])
      return typeof v === 'object' && v !== null ? v : null
    } catch { return null }
  }
  return null
}

// ---- 渲染器：把事件流变成终端输出（≈ 未来 Echo 运行中心的事件→UI 映射）----
class LiveRenderer {
  constructor() {
    this.toolCallCount = 0
    this.tokens = null
    this.endReason = null
    this.blockKind = new Map()
    this.reasoningOpen = false
  }

  /** 处理一个会话事件；返回 'ended' 表示回合已结束 */
  event(ev) {
    const d = ev.data ?? {}
    switch (ev.type) {
      case 'turn/start':
        console.log(`\n── 回合 ${d.turn} 开始 ──`)
        break
      case 'user/message':
        console.log(`\n👤 user: ${truncate(messageParts(d).text, 120)}`)
        break
      case 'assistant/chunk': {
        const c = d.chunk ?? {}
        if (c.type === 'block-start') {
          this.blockKind.set(c.index, c.blockType)
          if (c.blockType === 'reasoning') { this.reasoningOpen = true; process.stdout.write('\n💭 CoT: ') }
        } else if (c.type === 'block-end') {
          const kind = this.blockKind.get(c.index)
          if (kind === 'reasoning') { this.reasoningOpen = false; process.stdout.write('\n') }
          else if (kind === 'tool-call') process.stdout.write('\n')
        } else if (c.type === 'text-delta' || c.type === 'reasoning-delta') {
          process.stdout.write(c.text ?? '')
        }
        break
      }
      case 'tool/call':
        this.toolCallCount++
        console.log(`\n\n🔧 工具调用: ${d.name}\n   args: ${truncate(prettyJson(d.arguments))}`)
        break
      case 'tool/result':
        console.log(`📦 工具结果: ${d.name ?? d.callId ?? ''} → ${truncate(JSON.stringify(d), 160)}`)
        break
      case 'assistant/message':
        console.log(`\n✅ 助手消息已提交（seq ${ev.seq}）`)
        break
      case 'turn/end':
        this.endReason = d.reason?.kind ?? null
        console.log(`\n── 回合 ${d.turn} 结束（${this.endReason}）──`)
        return 'ended'
      default:
        break
    }
    return null
  }
}

// ---- 主流程 ----
async function main() {
  const argv = process.argv.slice(2)
  let artifactName = null
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--artifact') {
      artifactName = argv[++i]
      if (!artifactName) throw new Error('--artifact 需要文件名参数')
    } else rest.push(argv[i])
  }
  const promptText = rest.join(' ').trim() || DEFAULT_PROMPT

  console.log('=== Echo agent 试跑 demo（保守版，WS 实时流）===')
  const { sessionId } = await api.sessionCreate({ cwd: process.cwd() })
  console.log(`会话已创建: ${sessionId}`)
  if (artifactName) console.log(`产物模式: 结束后注册 artifacts/${artifactName}（最终消息须为 JSON）`)
  console.log(`prompt: ${promptText}\n`)

  const renderer = new LiveRenderer()
  let lastSeen = -1
  let ended = false
  let timedOut = false

  // 渲染门（SSE 与轮询共用，按 seq 去重）
  const render = (ev) => {
    if (!ev || typeof ev.seq !== 'number' || ev.seq <= lastSeen) return
    lastSeen = ev.seq
    if (renderer.event(ev) === 'ended') ended = true
  }

  // WS 主通道（下行单向，服务端自动推送全部会话帧；在 create 之后打开，
  // mux 的 session/created 会自动订阅新会话）
  const controller = new AbortController()
  const wsTask = (async () => {
    try {
      for await (const msg of api.muxFrames(controller.signal)) {
        if (msg?.type !== 'server-request') continue
        const p = msg.payload ?? {}
        if (p.sessionId !== sessionId) continue
        if (p.type === 'session/event') render(p.event)
        else if (p.type === 'session/projection' && p.key === 'tokenUsage') renderer.tokens = p.value
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        console.log(`（WS 流中断: ${err.message}，由轮询兜底）`)
      }
    }
  })()

  // 轮询兜底：回填漏帧 + 拿 projections 基线
  const poll = async () => {
    const page = await api.sessionHistory(sessionId, { maxMessages: 100 })
    const events = (page.events ?? []).map(e => e.event).sort((a, b) => a.seq - b.seq)
    for (const ev of events) render(ev)
    if (page.projections?.values?.tokenUsage) renderer.tokens = page.projections.values.tokenUsage
  }

  // 发送 prompt
  await api.sessionPrompt(sessionId, promptText)
  console.log('（prompt 已入队，开始观测事件流…）')

  const deadline = Date.now() + TIMEOUT_MS
  while (!ended && Date.now() < deadline) {
    await poll().catch(err => { if (!ended) throw err })
    if (ended) break
    await new Promise(r => setTimeout(r, POLL_MS))
  }
  if (!ended) timedOut = true

  controller.abort() // 关 WS
  await wsTask.catch(() => {})

  // ---- 输出契约 → 产物注册（§6.3 最小版）----
  if (artifactName) {
    const page = await api.sessionHistory(sessionId, { maxMessages: 5 })
    const evs = (page.events ?? []).map(e => e.event)
    const lastAssistant = [...evs].reverse().find(e => e.type === 'assistant/message')
    const { text } = messageParts(lastAssistant?.data)
    const json = extractJson(text)
    if (json !== null) {
      const { mkdir, writeFile } = await import('node:fs/promises')
      await mkdir('artifacts', { recursive: true })
      await writeFile(`artifacts/${artifactName}`, JSON.stringify(json, null, 2), 'utf8')
      console.log(`\n📦 artifact.created: artifacts/${artifactName}（结构化 JSON 已注册，可供预览面板渲染）`)
    } else {
      console.log('\n💡 insight: 产物校验失败（最终消息不是合法 JSON 对象）→ 需要人工介入')
    }
  }

  const report = {
    sessionId,
    prompt: promptText,
    toolCallCount: renderer.toolCallCount,
    tokens: renderer.tokens,
    endReason: renderer.endReason,
    lastSeq: lastSeen,
    timedOut,
    artifact: artifactName ?? null,
  }

  console.log('\n────── 汇总 ──────')
  console.log(`会话: ${sessionId}`)
  console.log(`工具调用: ${renderer.toolCallCount} 次`)
  console.log(`token 用量: ${JSON.stringify(renderer.tokens ?? {})}`)
  console.log(`回合结束: ${timedOut ? `⚠️ 超时（${TIMEOUT_MS}ms）` : renderer.endReason}`)

  const { writeFile } = await import('node:fs/promises')
  const reportFile = `echo-demo-report-${sessionId.slice(8, 16)}.json`
  await writeFile(reportFile, JSON.stringify(report, null, 2), 'utf8')
  console.log(`报告: ${reportFile}`)
  console.log(`\n（提示：GUI 会话列表里可回看同一会话的 Trajectory/CoT；也可用 fetch-trajectory.mjs ${sessionId} --thinking 导出）`)
}

main().catch(err => {
  console.error(`错误: ${err.message}`)
  process.exit(1)
})
