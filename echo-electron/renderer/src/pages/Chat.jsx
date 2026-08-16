import React, { useEffect, useRef, useState } from 'react'
import { product, sessions } from '../api.js'
import { subscribeMux, foldEvent } from '../mux.js'

const EMPTY_FEED = { messages: [], blocks: {}, turn: null, turnStart: 0, turnEnded: false }

export default function Chat({ agents, workspaces, toolsets }) {
  const [agentId, setAgentId] = useState(null)
  const [prompt, setPrompt] = useState('')
  const [feed, setFeed] = useState(EMPTY_FEED)
  const [running, setRunning] = useState(false)
  const [muxStatus, setMuxStatus] = useState('')
  const [sessionId, setSessionId] = useState(null)
  const [err, setErr] = useState('')
  const [loadingHistory, setLoadingHistory] = useState(false)

  const subRef = useRef(null)
  const runIdRef = useRef(null) // 当前 run 的 id（事件回调闭包用）
  const logRef = useRef(null)

  const agent = agents.find((a) => a.id === agentId) ?? null
  const workspace = agent?.workspaceId ? workspaces.find((w) => w.id === agent.workspaceId) : null

  // 卸载时清理 mux
  useEffect(() => () => { subRef.current?.close() }, [])

  // 切换 agent：恢复该 agent 最近一次会话的历史
  useEffect(() => {
    subRef.current?.close()
    subRef.current = null
    runIdRef.current = null
    setFeed(EMPTY_FEED)
    setSessionId(null)
    setRunning(false)
    setMuxStatus('')
    setErr('')
    if (!agentId) return

    let alive = true
    ;(async () => {
      setLoadingHistory(true)
      try {
        const { items } = await product.listRuns(agentId)
        const latest = (items ?? []).find((r) => r.kind === 'chat' && r.sessionId)
        if (!latest) return
        // 历史在 harness 会话日志里；这里拉取并按相同的事件折叠规则渲染
        const hist = await sessions.history(latest.sessionId)
        const events = (hist.events ?? []).map((e) => e.event).filter(Boolean)
        if (!alive) return
        let s = { ...EMPTY_FEED }
        for (const ev of events) s = foldEvent(s, ev)
        setFeed(s)
        setSessionId(latest.sessionId)
        runIdRef.current = latest.id
      } catch (e) {
        // 会话日志不可读（如 harness 数据被清理）→ 当作新对话开始
        if (alive) {
          setErr(`未恢复历史（${e.message}），将从新对话开始。`)
        }
      } finally {
        if (alive) setLoadingHistory(false)
      }
    })()
    return () => { alive = false }
  }, [agentId])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [feed.messages.length])

  const toolsetLabel = (id) => toolsets.find((t) => t.id === id)?.label ?? id

  async function send() {
    if (!agent) { setErr('请先选择一个 agent'); return }
    const text = prompt.trim()
    if (!text) { setErr('请输入提示词'); return }
    setErr('')
    setRunning(true)
    setMuxStatus('connecting')

    let sid = sessionId
    let runId = runIdRef.current
    try {
      if (!sid) {
        // 新对话：建会话（agentPreset 注入 persona）→ 选模型 → 记录 run
        const createPayload = { agentPreset: agent.presetId }
        if (workspace?.path) createPayload.cwd = workspace.path
        const created = await sessions.create(createPayload)
        sid = created.sessionId
        setSessionId(sid)

        const m = agent.model ?? {}
        if (m.provider && m.model) {
          try {
            await sessions.selectModel(sid, { provider: m.provider, model: m.model })
          } catch (e2) {
            pushSystem(`模型选择失败（将使用默认）：${e2.message}`)
          }
        }

        const run = await product.createRun({
          kind: 'chat',
          agentId: agent.id,
          workspaceId: agent.workspaceId ?? null,
          sessionId: sid,
          input: { text },
        })
        runId = run.id
        runIdRef.current = run.id
      }

      // 订阅实时事件流（turn/end 后自动收尾并落库状态）
      subRef.current = subscribeMux({
        sessionId: sid,
        onStatus: setMuxStatus,
        onEvent: (ev) => {
          setFeed((prev) => foldEvent(prev, ev))
          if (ev.type === 'turn/end') {
            subRef.current?.close()
            subRef.current = null
            setRunning(false)
            setMuxStatus('ended')
            if (runId) {
              void product.updateRun(runId, { status: 'success', finishedAt: Date.now() }).catch(() => {})
            }
          }
        },
      })

      await sessions.prompt(sid, text)
      setPrompt('')
      pushSystem(`已发送 → ${agent.name}（会话 ${sid.slice(0, 8)}…）`)
    } catch (e2) {
      setErr(`发送失败：${e2.message}`)
      setRunning(false)
      subRef.current?.close()
      subRef.current = null
      if (runId) {
        void product.updateRun(runId, { status: 'failed', finishedAt: Date.now(), error: e2.message }).catch(() => {})
      }
    }
  }

  async function stop() {
    if (sessionId) {
      try { await sessions.cancel(sessionId) } catch { /* 已结束 */ }
    }
    subRef.current?.close()
    subRef.current = null
    setRunning(false)
    pushSystem('已请求停止')
    if (runIdRef.current) {
      void product.updateRun(runIdRef.current, { status: 'cancelled', finishedAt: Date.now() }).catch(() => {})
    }
  }

  /** 开新对话：清掉当前会话引用，下次发送自动 session.create */
  function newSession() {
    if (running) return
    subRef.current?.close()
    subRef.current = null
    runIdRef.current = null
    setSessionId(null)
    setFeed(EMPTY_FEED)
    setErr('')
  }

  function pushSystem(text) {
    setFeed((prev) => ({
      ...prev,
      messages: [...prev.messages, { id: prev.messages.length, kind: 'system', text }],
    }))
  }

  return (
    <>
      <div className="side">
        <div className="page-sub" style={{ margin: '0 0 10px' }}>选择要试跑的 agent</div>
        <div className="list">
          {agents.length === 0 && <div className="empty">还没有 agent，请先到 Agents 页创建。</div>}
          {agents.map((a) => {
            const ws = a.workspaceId ? workspaces.find((w) => w.id === a.workspaceId) : null
            return (
              <div
                key={a.id}
                className={`list-item ${a.id === agentId ? 'selected' : ''}`}
                onClick={() => setAgentId(a.id)}
              >
                <div className="name">{a.name}</div>
                <div className="meta">{toolsetLabel(a.toolset)}{ws ? ` · ${ws.name}` : ''}</div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="main" style={{ display: 'flex', flexDirection: 'column', paddingBottom: 18 }}>
        <div className="row" style={{ marginBottom: 4 }}>
          <h1 className="page-title" style={{ margin: 0 }}>Chat 试跑</h1>
          <span style={{ marginLeft: 'auto' }} />
          <button className="btn small" onClick={newSession} disabled={!sessionId || running} title="放弃当前对话，下次发送时开新会话">
            ＋ 新对话
          </button>
        </div>
        {agent ? (
          <p className="page-sub">
            {agent.name} · 工具集 {toolsetLabel(agent.toolset)} · preset <code>{agent.presetId}</code>
            {workspace ? ` · cwd ${workspace.path}` : ' · cwd（引擎默认）'}
            {sessionId ? ` · 会话 ${sessionId.slice(0, 8)}…（继续上次对话）` : ' · 新对话'}
          </p>
        ) : (
          <p className="page-sub">从左侧选择一个 agent 开始试跑（自动恢复最近一次对话历史）。</p>
        )}
        {err && <div className="banner err">{err}</div>}
        {muxStatus && <div className="banner info">事件流：{muxStatus}</div>}
        {loadingHistory && <div className="banner info">正在恢复历史对话…</div>}

        <div className="chat-log" ref={logRef}>
          {feed.messages.length === 0 && (
            <div className="empty">
              {running ? '等待事件流…' : '输入提示词，点「发送」开始（CoT、工具调用、回复实时渲染）。'}
            </div>
          )}
          {feed.messages.map((msg) => (
            <Msg key={msg.id} msg={msg} />
          ))}
        </div>

        <div className="chat-input-row">
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !running) send() }}
            placeholder={agent ? `向「${agent.name}」发送消息，回车发送` : '请先选择 agent'}
            disabled={!agent || running}
          />
          <button className="btn primary" onClick={send} disabled={!agent || running}>{sessionId ? '发送' : '试跑'}</button>
          <button className="btn danger" onClick={stop} disabled={!running}>停止</button>
        </div>
      </div>
    </>
  )
}

function Msg({ msg }) {
  const tag = { user: '你', assistant: 'AI', cot: '思维链', tool: msg.toolName ?? '工具', system: '系统' }[msg.kind]
  if (msg.kind === 'cot' && !msg.text.trim()) return null
  return (
    <div className={`msg ${msg.kind}`}>
      <span className="tag">{tag}</span>
      {msg.text}
    </div>
  )
}
