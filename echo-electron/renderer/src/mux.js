/**
 * renderer/src/mux.js — harness /api/events.mux 实时帧流订阅
 *
 * WebSocket 下行单向（客户端发消息会被 1008 关闭），服务端打开即推送全部会话的帧。
 * 调用方按 payload.sessionId 过滤。连接失败时自动重连（指数退避）。
 */

/**
 * 订阅 mux 帧流。
 * @param {{ sessionId?: string, onEvent: (event: Object) => void, onStatus?: (s: string) => void }} opts
 * @returns {{ close: () => void }}
 */
export function subscribeMux({ sessionId, onEvent, onStatus }) {
  let ws = null
  let closed = false
  let retry = 0

  function connect() {
    if (closed) return
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://'
    ws = new WebSocket(`${proto}${location.host}/api/events.mux`)
    onStatus?.('connecting')
    ws.onopen = () => {
      retry = 0
      onStatus?.('connected')
    }
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg?.type !== 'server-request') return
        const p = msg.payload ?? {}
        if (p.type !== 'session/event') return
        if (sessionId && p.sessionId !== sessionId) return
        onEvent(p.event)
      } catch { /* 忽略坏帧 */ }
    }
    ws.onclose = () => {
      if (closed) return
      onStatus?.('disconnected')
      const delay = Math.min(2000 * (2 ** retry), 15000)
      retry += 1
      setTimeout(connect, delay)
    }
    ws.onerror = () => { try { ws.close() } catch { /* noop */ } }
  }

  connect()

  return {
    close() {
      closed = true
      try { ws?.close() } catch { /* noop */ }
    },
  }
}

/**
 * 把原始 SessionEvent 折叠为展示友好的消息列表。
 * 处理 turn/start、user/message、assistant/chunk（block-start/end/text-delta/reasoning-delta）、
 * tool/call、tool/result、assistant/message、turn/end。
 * 返回值：{ messages: [{id, kind: 'user'|'assistant'|'tool'|'system'|'cot', ...}], turnEnded: bool }
 */
export function foldEvent(state, event) {
  const d = event.data ?? {}
  const next = { ...state, messages: [...state.messages] }

  switch (event.type) {
    case 'turn/start': {
      next.messages.push({ id: next.messages.length, kind: 'system', text: `── 回合 ${d.turn ?? ''} 开始 ──` })
      next.turn = d.turn
      break
    }
    case 'user/message': {
      next.messages.push({ id: next.messages.length, kind: 'user', text: textOf(d) })
      break
    }
    case 'assistant/chunk': {
      const c = d.chunk ?? {}
      if (c.type === 'block-start') {
        next.blocks = { ...next.blocks, [c.index]: c.blockType }
        if (c.blockType === 'reasoning') {
          next.messages.push({ id: next.messages.length, kind: 'cot', text: '💭 ' })
        } else if (c.blockType === 'text') {
          next.messages.push({ id: next.messages.length, kind: 'assistant', text: '' })
        }
      } else if (c.type === 'block-end') {
        const kind = next.blocks?.[c.index]
        if (kind === 'reasoning') {
          // 折叠思维链：保留，前端可展开
          const last = next.messages[next.messages.length - 1]
          if (last?.kind === 'cot' && last.text.trim() === '💭') last.text = '💭 (空)'
        }
        next.blocks = { ...next.blocks, [c.index]: undefined }
      } else if (c.type === 'text-delta' || c.type === 'reasoning-delta') {
        const target = c.type === 'reasoning-delta' ? 'cot' : 'assistant'
        const last = next.messages[next.messages.length - 1]
        if (last?.kind === target) last.text += c.text ?? ''
      }
      break
    }
    case 'tool/call': {
      let argsText = ''
      try {
        const parsed = JSON.parse(d.arguments ?? '{}')
        argsText = JSON.stringify(parsed, null, 2).slice(0, 2000)
      } catch {
        argsText = String(d.arguments ?? '')
      }
      next.messages.push({
        id: next.messages.length,
        kind: 'tool',
        toolName: d.name,
        text: `🔧 调用 ${d.name}${argsText ? `\n${argsText}` : ''}`,
        status: 'running',
      })
      break
    }
    case 'tool/result': {
      // 把最近的 running 工具标记为完成
      for (let i = next.messages.length - 1; i >= 0; i -= 1) {
        const m = next.messages[i]
        if (m.kind === 'tool' && m.status === 'running') {
          m.status = 'done'
          m.text += `\n📦 结果${d.summary ? `: ${d.summary}` : '已返回'}`
          break
        }
      }
      break
    }
    case 'assistant/message': {
      const msg = d.message ?? {}
      const text = extractMessageText(msg)
      next.messages.push({ id: next.messages.length, kind: 'assistant', text: text || '(无文本)' })
      break
    }
    case 'turn/end': {
      next.messages.push({ id: next.messages.length, kind: 'system', text: `── 回合结束（${d.reason?.kind ?? 'unknown'}）──` })
      next.turnEnded = true
      break
    }
    default:
      break
  }
  return next
}

function textOf(data) {
  const msg = data?.message ?? data
  return extractMessageText(msg)
}

function extractMessageText(msg) {
  if (typeof msg?.text === 'string') return msg.text
  if (Array.isArray(msg?.content)) {
    return msg.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n')
  }
  return ''
}
