#!/usr/bin/env node
/**
 * fetch-trajectory.mjs — 拉取 DeepSeek Harness 会话的完整轨迹
 *
 * 用法：
 *   node fetch-trajectory.mjs                    # 列出所有会话
 *   node fetch-trajectory.mjs <sessionId>        # 输出 Markdown 对话轨迹
 *   node fetch-trajectory.mjs <sessionId> --json # 输出结构化 JSON（含原始事件）
 *   node fetch-trajectory.mjs <sessionId> --raw  # 只输出原始事件数组
 *   node fetch-trajectory.mjs <sessionId> --thinking # Markdown 包含思维链（折叠显示）
 *   node fetch-trajectory.mjs <sessionId> -o out.md   # 写入文件（utf-8）
 *
 * 环境变量：DSH_API 覆盖 API 地址（默认 http://127.0.0.1:3080/api）
 *
 * 原理：调用 harness 官方 RPC（信封见 packages/host/apiproxy/src/api/rpc.ts）
 *   POST /api/<method>  {type:'client-request', rpcId, method, payload}
 *   →   {type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error}}
 * 路径必须精确等于方法名（如 /api/session.history），且 body.method 与路径一致
 * （见 packages/host/apiproxy/src/fetch/handler.ts 的 methodFor）。
 * 翻页语义（见 api-proxy.ts 的 paginate）：beforeSeq 为开区间（seq < beforeSeq），
 * hasMore 为 true 时用当前页最小 seq 继续向前翻。
 *
 * 等价 curl（取最新一页，500 条）：
 *   curl -s http://127.0.0.1:3080/api/session.history -H 'content-type: application/json' \
 *     -d '{"type":"client-request","rpcId":"c1","method":"session.history",
 *          "payload":{"sessionId":"session-xxx","maxMessages":500}}'
 * 下载整个会话日志 ZIP：
 *   curl -OJ "http://127.0.0.1:3080/api/session.export?sessionId=session-xxx"
 */

const BASE = process.env.DSH_API ?? 'http://127.0.0.1:3080/api'
const PAGE_SIZE = 500
const MAX_PAGES = 200

let rpcId = 0
async function rpc(method, payload) {
  let res
  try {
    res = await fetch(`${BASE}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `cli-${++rpcId}`, method, payload }),
    })
  } catch (err) {
    throw new Error(`无法连接 harness（${BASE}）：${err.message}\n（确认 GUI 正在运行，或设置 DSH_API）`)
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  const msg = await res.json()
  if (msg.type !== 'server-response') throw new Error(`意外信封: ${JSON.stringify(msg).slice(0, 200)}`)
  if (!msg.result || !msg.result.ok) {
    const err = msg.result?.error ?? {}
    throw new Error(`rpc ${method} 失败 [${err.code}]: ${err.message}`)
  }
  return msg.result.value
}

/** session.list → 会话摘要列表 */
async function listSessions() {
  const { items } = await rpc('session.list', {})
  return items
}

/**
 * session.history 翻页拉取全部事件（按 seq 升序）。
 *
 * 注意：不同版本的服务端分页语义有差异——有的版本一次返回整份日志（hasMore=false），
 * 有的版本需要按 beforeSeq 向前翻页。这里做防御式处理：
 *  - 事件从 entry.event 读取（线上返回 {event, view} 包裹结构）；
 *  - 按 seq 去重（Map），防止重叠页重复计数；
 *  - beforeSeq 用「当前页最小 seq - 1」，对开区间/闭区间边界都安全；
 *  - 新页最小编号没有严格变小即终止（防死循环）。
 */
async function fetchAllEvents(sessionId) {
  const bySeq = new Map()
  let beforeSeq
  let prevMin
  for (let page = 0; page < MAX_PAGES; page++) {
    const payload = { sessionId, maxMessages: PAGE_SIZE }
    if (beforeSeq !== undefined) payload.beforeSeq = beforeSeq
    const pageRes = await rpc('session.history', payload)
    const entries = pageRes.events ?? []
    for (const entry of entries) {
      const ev = entry?.event
      if (ev && typeof ev.seq === 'number') bySeq.set(ev.seq, ev)
    }
    if (!pageRes.hasMore || entries.length === 0) break
    const minSeq = Math.min(...entries.map(e => e?.event?.seq ?? Infinity))
    if (!Number.isFinite(minSeq) || (prevMin !== undefined && minSeq >= prevMin)) break
    prevMin = minSeq
    beforeSeq = minSeq - 1
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

// ---- 提取 ----

/**
 * 拆分消息内容块：reasoning（思维链）与其余文本。
 * assistant 消息嵌套在 data.message，user 消息直接是 message。
 * reasoning 块结构为 { type:'reasoning', text:'<思考全文>' }，按原样保留。
 */
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

/** 仅取正文文本（不含思维链；无文本时返回 undefined） */
function messageText(data) {
  const { text } = messageParts(data)
  return text === '' ? undefined : text
}

function prettyJson(v) {
  try { return JSON.stringify(JSON.parse(v), null, 2) } catch { return String(v) }
}

function truncate(v, n = 2000) {
  const s = String(v)
  return s.length > n ? s.slice(0, n) + `\n…(截断，共 ${s.length} 字符)` : s
}

// ---- 渲染 ----

function renderMarkdown(events, opts = {}) {
  const out = []
  for (const ev of events) {
    const d = ev.data ?? {}
    switch (ev.type) {
      case 'turn/start':
        out.push(`\n---\n\n## 回合 ${d.turn}（seq ${ev.seq}）\n`)
        break
      case 'turn/end':
        out.push(`> 回合 ${d.turn} 结束：${d.reason?.kind ?? '?'}\n`)
        break
      case 'user/message': {
        const text = messageText(d)
        out.push(`\n### 👤 User（seq ${ev.seq}）\n\n${text ?? '（无文本内容）'}\n`)
        break
      }
      case 'assistant/message': {
        const parts = messageParts(d)
        let block = `\n### 🤖 Assistant（seq ${ev.seq}）\n`
        if (opts.thinking && parts.reasoning) {
          block += `\n<details>\n<summary>💭 思维链（思考过程）</summary>\n\n${parts.reasoning}\n\n</details>\n`
        }
        block += `\n${parts.text || '（无文本内容）'}\n`
        out.push(block)
        break
      }
      case 'tool/call':
        out.push(`\n### 🔧 工具调用 ${d.name}（seq ${ev.seq}）\n\n\`\`\`json\n${truncate(prettyJson(d.arguments), 4000)}\n\`\`\`\n`)
        break
      case 'tool/result':
        out.push(`\n### 📦 工具结果 ${d.name ?? d.callId ?? ''}（seq ${ev.seq}）\n\n\`\`\`json\n${truncate(JSON.stringify(d, null, 2), 4000)}\n\`\`\`\n`)
        break
      default:
        // step/start、step/end、session/title、compaction 等：跳过（--raw 里能看到全部）
        break
    }
  }
  return out.join('\n')
}

// ---- 主流程 ----

function usage() {
  console.log('用法:')
  console.log('  node fetch-trajectory.mjs                     列出所有会话')
  console.log('  node fetch-trajectory.mjs <sessionId>         输出 Markdown 轨迹')
  console.log('  node fetch-trajectory.mjs <sessionId> --json  输出 JSON')
  console.log('  node fetch-trajectory.mjs <sessionId> --raw   输出原始事件数组')
  console.log('  node fetch-trajectory.mjs <sessionId> --thinking   Markdown 包含思维链（折叠显示）')
  console.log('  node fetch-trajectory.mjs <sessionId> -o out  写入文件')
}

async function main() {
  const argv = process.argv.slice(2)
  const [sid, ...rest] = argv
  if (!sid) {
    const items = await listSessions()
    if (items.length === 0) { console.log('（没有会话）'); return }
    console.log(`${'sessionId'.padEnd(40)} ${'updatedAt'.padEnd(22)} ${'run'.padEnd(4)} blank  cwd`)
    for (const s of items.sort((a, b) => b.updatedAt - a.updatedAt)) {
      console.log(
        `${s.sessionId.padEnd(40)} ${new Date(s.updatedAt).toISOString().padEnd(22)} `
        + `${s.running ? '●' : '○'.padEnd(4)} ${s.blank ? 'true ' : 'false'}  ${s.cwd ?? ''}`,
      )
    }
    return
  }

  let format = 'md'
  let out
  let thinking = false
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--json') format = 'json'
    else if (a === '--raw') format = 'raw'
    else if (a === '--md') format = 'md'
    else if (a === '--thinking') thinking = true
    else if (a === '-o' || a === '--out') out = rest[++i]
    else { usage(); process.exit(2) }
  }

  const events = await fetchAllEvents(sid)
  let text
  if (format === 'raw') text = JSON.stringify(events, null, 2)
  else if (format === 'json') {
    text = JSON.stringify({
      sessionId: sid,
      eventCount: events.length,
      messageCount: events.filter(e => e.type === 'user/message' || e.type === 'assistant/message').length,
      toolCallCount: events.filter(e => e.type === 'tool/call').length,
      firstSeq: events[0]?.seq ?? null,
      lastSeq: events.at(-1)?.seq ?? null,
      events,
    }, null, 2)
  } else {
    text = `# 会话轨迹 ${sid}\n\n（事件总数 ${events.length}，seq ${events[0]?.seq ?? '-'} ~ ${events.at(-1)?.seq ?? '-'}`
      + `${thinking ? '，含思维链' : ''}）\n`
      + renderMarkdown(events, { thinking })
  }

  if (out) {
    await import('node:fs/promises').then(fs => fs.writeFile(out, text, 'utf8'))
    console.log(`已写入 ${out}（${text.length} 字符，${events.length} 个事件）`)
  } else {
    console.log(text)
  }
}

main().catch(err => {
  console.error(`错误: ${err.message}`)
  process.exit(1)
})
