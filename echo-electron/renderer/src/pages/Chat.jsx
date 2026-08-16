import React, { useEffect, useRef, useState } from 'react'
import { product, sessions } from '../api.js'
import { subscribeMux, foldEvent } from '../mux.js'

const EMPTY_FEED = { messages: [], blocks: {}, turn: null, turnStart: 0, turnEnded: false }

const RUN_STATUS = {
  pending: '待开始',
  running: '进行中',
  success: '完成',
  failed: '失败',
  cancelled: '已停止',
}

export default function Chat({ agents, workspaces, toolsets }) {
  const [agentId, setAgentId] = useState(null)
  const [prompt, setPrompt] = useState('')
  const [feed, setFeed] = useState(EMPTY_FEED)
  const [running, setRunning] = useState(false)
  const [muxStatus, setMuxStatus] = useState('')
  const [sessionId, setSessionId] = useState(null)
  const [runs, setRuns] = useState([])            // 该 agent 的历史会话（倒序）
  const [activeRunId, setActiveRunId] = useState(null) // 当前展示/进行中的 run
  const [err, setErr] = useState('')
  const [loadingHistory, setLoadingHistory] = useState(false)

  const subRef = useRef(null)
  const runIdRef = useRef(null) // 当前 run 的 id（事件回调闭包用）
  const loadSeqRef = useRef(0)  // 历史加载竞态序号（快速切换时丢弃过期响应）
  const logRef = useRef(null)

  const agent = agents.find((a) => a.id === agentId) ?? null
  const workspace = agent?.workspaceId ? workspaces.find((w) => w.id === agent.workspaceId) : null

  // 卸载时清理 mux
  useEffect(() => () => { subRef.current?.close() }, [])

  /** 加载某个 run（历史会话）的内容到消息区 */
  async function loadRun(run) {
    const seq = ++loadSeqRef.current
    subRef.current?.close()
    subRef.current = null
    setRunning(false)
    setMuxStatus('')
    setErr('')
    setActiveRunId(run.id)
    runIdRef.current = run.id
    setSessionId(run.sessionId)
    setLoadingHistory(true)
    try {
      const hist = await sessions.history(run.sessionId)
      if (loadSeqRef.current !== seq) return // 已被更新的加载取代
      const events = (hist.events ?? []).map((e) => e.event).filter(Boolean)
      let s = { ...EMPTY_FEED }
      for (const ev of events) s = foldEvent(s, ev)
      setFeed(s)
    } catch (e) {
      if (loadSeqRef.current !== seq) return
      setErr(`会话历史不可读（${e.message}），将从新对话开始。`)
      setSessionId(null)
      runIdRef.current = null
      setActiveRunId(null)
    } finally {
      if (loadSeqRef.current === seq) setLoadingHistory(false)
    }
  }

  // 切换 agent：拉历史会话列表 + 自动加载最近一次对话
  useEffect(() => {
    subRef.current?.close()
    subRef.current = null
    runIdRef.current = null
    setFeed(EMPTY_FEED)
    setSessionId(null)
    setRuns([])
    setActiveRunId(null)
    setRunning(false)
    setMuxStatus('')
    setErr('')
    if (!agentId) return

    let alive = true
    ;(async () => {
      setLoadingHistory(true)
      try {
        const { items } = await product.listRuns(agentId)
        if (!alive) return
        const chats = (items ?? []).filter((r) => r.kind === 'chat' && r.sessionId)
        setRuns(chats)
        if (chats.length > 0) await loadRun(chats[0]) // 最新会话
      } catch (e) {
        if (alive) setErr(`加载会话列表失败：${e.message}`)
      } finally {
        if (alive) setLoadingHistory(false)
      }
    })()
    return () => { alive = false }
  }, [agentId]) // eslint-disable-line react-hooks/exhaustive-deps

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
        setActiveRunId(run.id)
        setRuns((prev) => [run, ...prev]) // 新会话插入历史列表顶部
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
              setRuns((prev) => prev.map((r) => (r.id === runId ? { ...r, status: 'success' } : r)))
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
      const rid = runIdRef.current
      setRuns((prev) => prev.map((r) => (r.id === rid ? { ...r, status: 'cancelled' } : r)))
    }
  }

  /** 开新对话：清掉当前会话引用，下次发送自动 session.create（历史列表保留） */
  function newSession() {
    if (running) return
    subRef.current?.close()
    subRef.current = null
    runIdRef.current = null
    setSessionId(null)
    setActiveRunId(null)
    setFeed(EMPTY_FEED)
    setErr('')
  }

  function pushSystem(text) {
    setFeed((prev) => ({
      ...prev,
      messages: [...prev.messages, { id: prev.messages.length, kind: 'system', text }],
    }))
  }

  /** 历史会话列表项的第一条输入摘要 */
  function runSummary(run) {
    const text = run.input?.text ?? ''
    return text ? text.slice(0, 28) : '(空对话)'
  }

  return (
    <>
      <div className="side">
        <div className="page-sub" style={{ margin: '0 0 10px' }}>选择 agent</div>
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

        {agent && (
          <>
            <div className="side-sep" />
            <div className="page-sub" style={{ margin: '0 0 10px' }}>历史会话（{runs.length}）</div>
            <div className="list">
              {runs.length === 0 && <div className="empty">暂无历史会话，发送第一条消息后自动创建。</div>}
              {runs.map((r) => (
                <div
                  key={r.id}
                  className={`list-item ${r.id === activeRunId ? 'selected' : ''}`}
                  onClick={() => loadRun(r)}
                >
                  <div className="name">{runSummary(r)}</div>
                  <div className="meta">
                    {new Date(r.createdAt).toLocaleString()} · {RUN_STATUS[r.status] ?? r.status}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
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
            {sessionId ? ` · 会话 ${sessionId.slice(0, 8)}…` : ' · 新对话（未创建）'}
          </p>
        ) : (
          <p className="page-sub">从左侧选择一个 agent 开始试跑（自动恢复最近一次对话，历史会话见左侧列表）。</p>
        )}
        {err && <div className="banner err">{err}</div>}
        {muxStatus && <div className="banner info">事件流：{muxStatus}</div>}
        {loadingHistory && <div className="banner info">正在加载对话历史…</div>}

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
