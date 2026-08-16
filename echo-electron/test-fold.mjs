/**
 * test-fold.mjs — foldEvent 单元测试（Node 环境）
 *
 * 通过 data: URL 加载浏览器 ESM（renderer/src/mux.js）以复用同一个 foldEvent 实现。
 * 重点回归两个已修复的 bug：
 *  A. assistant/message 与 chunk 流重复渲染（同一条回复显示两遍）
 *  B. reasoning-delta / text-delta 与 tool 消息交错时文本丢失
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, 'renderer', 'src', 'mux.js'), 'utf8')
const { foldEvent } = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`)

let passed = 0
let failed = 0
function check(label, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ''}`) }
  else { failed += 1; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`) }
}

function ev(type, data) { return { type, data } }
const EMPTY = { messages: [], blocks: {}, turn: null, turnStart: 0, turnEnded: false }
const fold = (events, state = { ...EMPTY, messages: [] }) => {
  let s = state
  for (const e of events) s = foldEvent(s, e)
  return s
}

// ── A. chunk 流 + assistant/message 不应重复 ────────────────────────────────
console.log('\n[A] assistant/message 与 chunk 流去重')
{
  const s = fold([
    ev('turn/start', { turn: 1 }),
    ev('user/message', { message: { text: 'hi' } }),
    ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }),
    ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'Hello' } }),
    ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: ' world' } }),
    ev('assistant/chunk', { chunk: { type: 'block-end', index: 0 } }),
    ev('assistant/message', { message: { text: 'Hello world' } }),
    ev('turn/end', { reason: { kind: 'done' } }),
  ])
  const assistants = s.messages.filter((m) => m.kind === 'assistant')
  check('流式渲染后仅一条 assistant 消息', assistants.length === 1, `实际 ${assistants.length} 条`)
  check('assistant 文本完整', assistants[0]?.text === 'Hello world', JSON.stringify(assistants[0]?.text))
}

// ── B. 无 chunk 流时 assistant/message 兜底 ─────────────────────────────────
console.log('\n[B] 无流式正文时 assistant/message 兜底')
{
  const s = fold([
    ev('turn/start', { turn: 1 }),
    ev('assistant/message', { message: { text: '完整回复' } }),
    ev('turn/end', { reason: { kind: 'done' } }),
  ])
  const assistants = s.messages.filter((m) => m.kind === 'assistant')
  check('兜底渲染一条 assistant', assistants.length === 1 && assistants[0].text === '完整回复')
}

// ── C. reasoning + text 两 block，delta 与 tool 消息交错 ────────────────────
console.log('\n[C] CoT 与正文分块 + 工具调用交错')
{
  const s = fold([
    ev('turn/start', { turn: 1 }),
    ev('user/message', { message: { text: '写个脚本' } }),
    ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } }),
    ev('assistant/chunk', { chunk: { type: 'reasoning-delta', index: 0, text: '先想' } }),
    ev('assistant/chunk', { chunk: { type: 'reasoning-delta', index: 0, text: '一下' } }),
    ev('assistant/chunk', { chunk: { type: 'block-end', index: 0 } }),
    ev('assistant/chunk', { chunk: { type: 'block-start', index: 1, blockType: 'text' } }),
    ev('assistant/chunk', { chunk: { type: 'text-delta', index: 1, text: '来' } }),
    ev('assistant/message', { message: { text: '来' } }), // 部分流式
    ev('tool/call', { name: 'pwsh', arguments: '{"command":"ls"}' }),
    ev('assistant/chunk', { chunk: { type: 'text-delta', index: 1, text: '了' } }),
    ev('tool/result', {}),
    ev('assistant/message', { message: { text: '来了' } }),
    ev('turn/end', { reason: { kind: 'done' } }),
  ])
  const cots = s.messages.filter((m) => m.kind === 'cot')
  const assistants = s.messages.filter((m) => m.kind === 'assistant')
  const tools = s.messages.filter((m) => m.kind === 'tool')
  check('CoT 一条且文本完整', cots.length === 1 && cots[0].text === '💭 先想一下', JSON.stringify(cots[0]?.text))
  // text-delta 在 tool/call 之后到达：必须仍附着到 assistant 而非丢失
  check('正文跨工具消息续接', assistants.length === 1 && assistants[0].text === '来了', JSON.stringify(assistants))
  check('工具消息独立', tools.length === 1 && tools[0].status === 'done')
}

// ── D. 多回合：去重只按当前回合判断 ─────────────────────────────────────────
console.log('\n[D] 跨回合去重边界')
{
  let s = fold([
    ev('turn/start', { turn: 1 }),
    ev('user/message', { message: { text: 'q1' } }),
    ev('assistant/message', { message: { text: 'a1' } }),
    ev('turn/end', { reason: { kind: 'done' } }),
  ])
  s = fold([
    ev('turn/start', { turn: 2 }),
    ev('user/message', { message: { text: 'q2' } }),
    ev('assistant/message', { message: { text: 'a2' } }),
    ev('turn/end', { reason: { kind: 'done' } }),
  ], s)
  const assistants = s.messages.filter((m) => m.kind === 'assistant')
  check('两个回合各一条回复', assistants.length === 2 && assistants[0].text === 'a1' && assistants[1].text === 'a2', JSON.stringify(assistants.map(a => a.text)))
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
console.log('foldEvent 单元测试全部通过 ✅')
