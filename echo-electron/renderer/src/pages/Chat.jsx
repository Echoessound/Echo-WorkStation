import React, { useEffect, useRef, useState } from 'react'
import { sessions } from '../api.js'
import { subscribeMux, foldEvent } from '../mux.js'

const EMPTY_FEED = { messages: [], blocks: {}, turn: null, turnEnded: false }

export default function Chat({ agents, workspaces, toolsets, reload }) {
  const [agentId, setAgentId] = useState(null)
  const [prompt, setPrompt] = useState('')
  const [feed, setFeed] = useState(EMPTY_FEED)
  const [running, setRunning] = useState(false)
  const [muxStatus, setMuxStatus] = useState('')
  const [sessionId, setSessionId] = useState(null)
  const [err, setErr] = useState('')

  const subRef = useRef(null)
  const logRef = useRef(null)

  const agent = agents.find((a) => a.id === agentId) ?? null
  const workspace = agent?.workspaceId ? workspaces.find((w) => w.id === agent.workspaceId) : null

  // 切换 agent / 卸载时清理
  useEffect(() => {
    return () => { subRef.current?.close() }
  }, [])

  useEffect(() => {
    subRef.current?.close()
    subRef.current = null
    setFeed(EMPTY_FEED)
    setSessionId(null)
    setRunning(false)
    setErr('')
  }, [agentId])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [feed.messages.length])

  const toolsetLabel = (id) => toolsets.find((t) => t.id === id)?.label ?? id

  async function run() {
    if (!agent) { setErr('请先选择一个 agent'); return }
    const text = prompt.trim()
    if (!text) { setErr('请输入提示词'); return }
    setErr('')
    setRunning(true)
    setFeed(EMPTY_FEED)
    setMuxStatus('connecting')

    try {
      // 1. 建会话：cwd = 关联工作区路径（无则省略 → 用 harness host cwd）；agentPreset 注入 persona
      const createPayload = { agentPreset: agent.presetId }
      if (workspace?.path) createPayload.cwd = workspace.path
      const { sessionId: sid } = await sessions.create(createPayload)
      setSessionId(sid)

      // 2. 模型选择（agent 配置了 provider/model 时）
      const m = agent.model ?? {}
      if (m.provider && m.model) {
        try {
          await sessions.selectModel(sid, { provider: m.provider, model: m.model })
        } catch (e2) {
          pushSystem(`模型选择失败（将使用默认）：${e2.message}`)
        }
      }

      // 3. 订阅实时事件流
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
          }
        },
      })

      // 4. 发送提示词
      await sessions.prompt(sid, text)
      pushSystem(`已发送 → ${agent.name}（会话 ${sid.slice(0, 8)}…）`)
    } catch (e2) {
      setErr(`试跑失败：${e2.message}`)
      setRunning(false)
      subRef.current?.close()
      subRef.current = null
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
        <h1 className="page-title">Chat 试跑</h1>
        {agent ? (
          <p className="page-sub">
            {agent.name} · 工具集 {toolsetLabel(agent.toolset)} · preset <code>{agent.presetId}</code>
            {workspace ? ` · cwd ${workspace.path}` : ' · cwd（引擎默认）'}
          </p>
        ) : (
          <p className="page-sub">从左侧选择一个 agent 开始试跑。</p>
        )}
        {err && <div className="banner err">{err}</div>}
        {muxStatus && <div className="banner info">事件流：{muxStatus}</div>}

        <div className="chat-log" ref={logRef}>
          {feed.messages.length === 0 && (
            <div className="empty">
              {running ? '等待事件流…' : '输入提示词，点「试跑」开始（CoT、工具调用、回复实时渲染）。'}
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
            onKeyDown={(e) => { if (e.key === 'Enter' && !running) run() }}
            placeholder={agent ? `向「${agent.name}」发送提示词，回车发送` : '请先选择 agent'}
            disabled={!agent || running}
          />
          <button className="btn primary" onClick={run} disabled={!agent || running}>试跑</button>
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
