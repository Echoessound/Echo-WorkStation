/**
 * echo-api.mjs — Echo Workstation 的 DeepSeek Harness 契约层
 *
 * 把 M0 验证过的官方端点封装成类型化客户端，供 demo / Electron preload / renderer 复用。
 * 只做传输与领域封装，不包含任何渲染逻辑（渲染层见 echo-agent-demo.mjs 的 LiveRenderer）。
 *
 * 已验证端点：
 *   session.create / session.list / session.history / session.prompt / session.cancel
 *   events.mux 实时帧流（WebSocket，下行单向：客户端发消息会被 1008 关闭）
 *   session.export 下载 URL
 *
 * 重要契约事实（实测，勿改）：
 *  - RPC 信封：POST /api/<method>，body {type:'client-request', rpcId, method, payload}
 *    → 响应 {type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error}}
 *  - 路径必须精确等于方法名，且 body.method 与路径一致（否则 404 / bad-request）
 *  - GET /api/events.mux 在本部署被 client-connection 拦截返回 426，实时流只有 WebSocket
 *  - session.history 的分页语义随部署版本漂移（本部署 maxMessages 基本无效、一次返回整份日志），
 *    调用方必须按 seq 去重 + 防御式翻页（见 fetch-trajectory.mjs）
 *  - 历史条目为 { event, view? } 包裹结构，原始事件在 entry.event
 */

export class EchoApi {
  /**
   * @param {{ base?: string }} opts base 默认 http://127.0.0.1:3080/api（可被 DSH_API 覆盖）
   */
  constructor({ base } = {}) {
    this.base = base ?? process.env.DSH_API ?? 'http://127.0.0.1:3080/api'
    this.rpcId = 0
  }

  /** 通用 RPC（官方信封） */
  async rpc(method, payload) {
    let res
    try {
      res = await fetch(`${this.base}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: `echo-${++this.rpcId}`, method, payload }),
      })
    } catch (err) {
      throw new Error(`无法连接 harness（${this.base}）：${err.message}`)
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    const msg = await res.json()
    if (!msg.result?.ok) {
      const err = msg.result?.error ?? {}
      throw new Error(`rpc ${method} 失败 [${err.code}]: ${err.message}`)
    }
    return msg.result.value
  }

  // ---- sessions 域 ----

  /** 列出会话 → { items: SessionSummary[] } */
  sessionList() {
    return this.rpc('session.list', {})
  }

  /** 新建会话 → { sessionId, agentPreset? }；cwd/workspaceId 二选一 */
  sessionCreate({ cwd, workspaceId, sessionId, agentPreset } = {}) {
    const payload = { ...(cwd !== undefined ? { cwd } : {}), ...(workspaceId !== undefined ? { workspaceId } : {}), ...(sessionId !== undefined ? { sessionId } : {}), ...(agentPreset !== undefined ? { agentPreset } : {}) }
    return this.rpc('session.create', payload)
  }

  /** 读取历史 → { events: [{event, view?}], hasMore, projections? } */
  sessionHistory(sessionId, { beforeSeq, maxMessages } = {}) {
    const payload = { sessionId, ...(beforeSeq !== undefined ? { beforeSeq } : {}), ...(maxMessages !== undefined ? { maxMessages } : {}) }
    return this.rpc('session.history', payload)
  }

  /** 发送提示词（文本）→ { accepted, command? } */
  sessionPrompt(sessionId, text, { mode = 'queue' } = {}) {
    return this.rpc('session.prompt', { sessionId, mode, content: [{ type: 'text', text }] })
  }

  /** 取消进行中的回合 → { accepted } */
  sessionCancel(sessionId) {
    return this.rpc('session.cancel', { sessionId })
  }

  /** 会话日志下载 URL（GET → ZIP，含 session.jsonl + 媒体） */
  sessionExportUrl(sessionId, { includeDescendants } = {}) {
    const qs = new URLSearchParams({ sessionId })
    if (includeDescendants !== undefined) qs.set('includeDescendants', String(includeDescendants))
    return `${this.base}/session.export?${qs}`
  }

  // ---- events 域 ----

  /**
   * 实时帧流（WebSocket /api/events.mux，下行单向）。
   * 产出 {type:'server-request', rpcId, method, payload}，payload 为 MuxFrame
   * （session/event、session/projection、session/subscribed、session/queue…）。
   * 服务端打开即推送全部会话的帧，调用方按 payload.sessionId 过滤。
   * 连接失败时生成器直接结束（调用方应回退到轮询 session.history）。
   */
  async *muxFrames(signal = new AbortController().signal) {
    const wsUrl = `${this.base.replace(/^http/, 'ws')}/events.mux`
    let ws
    try {
      ws = new WebSocket(wsUrl)
    } catch (err) {
      throw new Error(`WebSocket 不可用: ${err.message}`)
    }
    const queue = []
    let wake = null
    let closed = false
    const onAbort = () => { try { ws.close() } catch { /* noop */ } }
    signal.addEventListener('abort', onAbort)
    ws.onmessage = (e) => {
      try { queue.push(JSON.parse(e.data)); wake?.() } catch { /* 忽略坏帧 */ }
    }
    ws.onclose = () => { closed = true; wake?.() }
    ws.onerror = () => { closed = true; wake?.() }
    try {
      while (!closed) {
        while (queue.length > 0) yield queue.shift()
        if (closed) break
        await new Promise(r => { wake = r })
        wake = null
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      try { ws.close() } catch { /* noop */ }
    }
  }
}
