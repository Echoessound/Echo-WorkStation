import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlow, ReactFlowProvider, Background, Handle, Position } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { product } from '../api.js'
import { subscribeMux, foldEvent } from '../mux.js'

const RUN_STATUS_LABEL = {
  pending: '待开始', running: '运行中', success: '成功', failed: '失败', cancelled: '已取消',
}
const NODE_STATUS_LABEL = {
  pending: '待开始', running: '运行中', success: '成功', failed: '失败',
  awaiting_approval: '等待审批', cancelled: '已取消', interrupted: '已中断',
}
const RUN_ACTIVE = ['pending', 'running']

function StatusNodeView({ id, data, selected }) {
  return (
    <div className={`wf-node ${data.status ?? 'pending'} ${selected ? 'wf-selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="wf-node-title">{data.label}</div>
      <div className="wf-node-sub">{data.agentName || 'agent'}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
const nodeTypes = { workNode: StatusNodeView }

const EMPTY_FEED = { messages: [], blocks: {}, turn: null, turnStart: 0, turnEnded: false }

function RunsInner({ agents }) {
  const [templates, setTemplates] = useState([])
  const [templateId, setTemplateId] = useState(null)
  const [runs, setRuns] = useState([])
  const [runId, setRunId] = useState(null)
  const [detail, setDetail] = useState(null) // {run, nodes}
  const [input, setInput] = useState('')
  const [selectedKey, setSelectedKey] = useState(null)
  const [nodeFeeds, setNodeFeeds] = useState({}) // sessionId -> feed
  const [err, setErr] = useState('')
  const [starting, setStarting] = useState(false)

  const template = templates.find((t) => t.id === templateId) ?? null

  async function loadTemplates() {
    try {
      const { items } = await product.listWorkflows()
      setTemplates(items ?? [])
    } catch (e) { setErr(e.message) }
  }
  useEffect(() => { void loadTemplates() }, [])

  async function loadRuns(tid) {
    try {
      const { items } = await product.listWorkflowRuns(tid)
      setRuns(items ?? [])
    } catch (e) { setErr(e.message) }
  }

  // 选中模板 → 载入运行列表；默认不自动选 run
  useEffect(() => {
    setRunId(null)
    setDetail(null)
    setSelectedKey(null)
    if (templateId) void loadRuns(templateId)
  }, [templateId])

  // run 详情轮询（活动 run 每 1s）
  useEffect(() => {
    if (!runId) return
    let alive = true
    async function poll() {
      try {
        const d = await product.getWorkflowRun(runId)
        if (!alive) return
        setDetail(d)
        if (!RUN_ACTIVE.includes(d.run.status)) {
          void loadRuns(templateId) // 终态时刷新列表徽标
        }
      } catch (e) {
        if (alive) setErr(e.message)
      }
    }
    void poll()
    const timer = setInterval(poll, 1000)
    return () => { alive = false; clearInterval(timer) }
  }, [runId]) // eslint-disable-line react-hooks/exhaustive-deps

  // mux 订阅该 run 的所有节点会话（节点级 CoT/工具实时流）
  const sessionIdsKey = useMemo(() => (detail?.nodes ?? []).map((n) => n.sessionId).filter(Boolean).join(','), [detail])
  useEffect(() => {
    if (!sessionIdsKey) return
    const sessionIds = sessionIdsKey.split(',')
    setNodeFeeds({})
    const sub = subscribeMux({
      sessionIds,
      onStatus: () => {},
      onEvent: (ev, sid) => {
        setNodeFeeds((prev) => {
          const current = prev[sid] ?? { ...EMPTY_FEED, messages: [] }
          return { ...prev, [sid]: foldEvent(current, ev) }
        })
      },
    })
    return () => sub.close()
  }, [sessionIdsKey])

  async function startRun() {
    if (!templateId) { setErr('先选择模板'); return }
    if (!input.trim()) { setErr('请输入运行输入'); return }
    setStarting(true); setErr('')
    try {
      const { runId: rid } = await product.startWorkflowRun(templateId, input.trim())
      await loadRuns(templateId)
      setRunId(rid)
    } catch (e) { setErr(e.message) } finally { setStarting(false) }
  }

  async function cancelRun() {
    if (!runId) return
    try { await product.cancelWorkflowRun(runId) } catch (e) { setErr(e.message) }
  }
  async function resumeRun() {
    if (!runId) return
    try { await product.resumeWorkflowRun(runId) } catch (e) { setErr(e.message) }
  }
  async function approveNode(nodeKey) {
    if (!runId) return
    try { await product.approveWorkflowNode(runId, nodeKey) } catch (e) { setErr(e.message) }
  }

  // 只读 DAG：模板快照（含位置）+ nodeRuns 状态
  const rfNodes = useMemo(() => {
    const snapshot = detail?.run?.input?.template ?? { nodes: [], edges: [] }
    const statusByKey = {}
    for (const n of detail?.nodes ?? []) statusByKey[n.nodeKey] = n.status
    return snapshot.nodes.map((n, i) => ({
      id: n.key,
      type: 'workNode',
      position: n.position && n.position.x !== undefined ? n.position : { x: 60, y: 60 + i * 90 },
      data: {
        label: n.key,
        agentName: n.agentId ? agents.find((a) => a.id === n.agentId)?.name ?? '' : '?',
        status: statusByKey[n.key] ?? 'pending',
      },
    }))
  }, [detail, agents])
  const rfEdges = useMemo(() => {
    const snapshot = detail?.run?.input?.template ?? { nodes: [], edges: [] }
    return snapshot.edges.map((e, i) => ({ id: `${e.source}->${e.target}-${i}`, source: e.source, target: e.target }))
  }, [detail])

  const selectedNodeRun = (detail?.nodes ?? []).find((n) => n.nodeKey === selectedKey) ?? null
  const selectedSnapNode = (detail?.run?.input?.template?.nodes ?? []).find((n) => n.key === selectedKey) ?? null
  const selectedFeed = selectedNodeRun?.sessionId ? nodeFeeds[selectedNodeRun.sessionId] : null

  return (
    <>
      <div className="side">
        <div className="page-sub" style={{ margin: '0 0 10px' }}>选择模板</div>
        <div className="list">
          {templates.length === 0 && <div className="empty">还没有模板，请先到 Workflow 页创建。</div>}
          {templates.map((t) => (
            <div key={t.id} className={`list-item ${t.id === templateId ? 'selected' : ''}`} onClick={() => setTemplateId(t.id)}>
              <div className="name">{t.name}</div>
              <div className="meta">{t.nodeCount} 个节点</div>
            </div>
          ))}
        </div>

        {template && (
          <>
            <div className="side-sep" />
            <div className="page-sub" style={{ margin: '0 0 8px' }}>新建运行</div>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={'运行输入（{{input}}）'}
              rows={3}
              style={{ width: '100%', background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: 8, font: 'inherit', fontSize: 12.5 }}
            />
            <div style={{ marginTop: 8 }}>
              <button className="btn primary small" onClick={startRun} disabled={starting}>{starting ? '启动中…' : '运行'}</button>
            </div>
            <div className="side-sep" />
            <div className="page-sub" style={{ margin: '0 0 10px' }}>运行历史（{runs.length}）</div>
            <div className="list">
              {runs.length === 0 && <div className="empty">暂无运行记录</div>}
              {runs.map((r) => (
                <div key={r.id} className={`list-item ${r.id === runId ? 'selected' : ''}`} onClick={() => { setRunId(r.id); setSelectedKey(null) }}>
                  <div className="name">{RUN_STATUS_LABEL[r.status] ?? r.status} {r.id.slice(0, 8)}</div>
                  <div className="meta">{new Date(r.createdAt).toLocaleString()}{r.error ? ` · ${r.error.slice(0, 24)}` : ''}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="main" style={{ display: 'flex', padding: 0 }}>
        <div style={{ flex: 1, position: 'relative', borderRight: '1px solid var(--border)' }}>
          <div className="wf-run-head">
            {detail ? (
              <>
                <strong>{detail.run.input?.template?.name ?? '运行'}</strong>
                <span className={`wf-badge ${detail.run.status}`}>{RUN_STATUS_LABEL[detail.run.status] ?? detail.run.status}</span>
                <span className="mono" style={{ color: 'var(--text-dim)', fontSize: 12 }}>{detail.run.id.slice(0, 8)}</span>
                {RUN_ACTIVE.includes(detail.run.status) && <button className="btn danger small" onClick={cancelRun}>取消</button>}
                {detail.run.status === 'failed' && <button className="btn small" onClick={resumeRun}>恢复</button>}
              </>
            ) : <span style={{ color: 'var(--text-dim)' }}>选择左侧运行记录查看 DAG 与节点详情</span>}
          </div>
          {err && <div className="banner err" style={{ margin: '8px 12px 0' }}>{err}</div>}
          <div style={{ height: 'calc(100% - 62px)', minHeight: 300 }}>
            {detail ? (
              <ReactFlow
                nodes={rfNodes}
                edges={rfEdges}
                nodeTypes={nodeTypes}
                onNodeClick={(_e, node) => setSelectedKey(node.id)}
                onPaneClick={() => setSelectedKey(null)}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable
                fitView
              >
                <Background />
              </ReactFlow>
            ) : (
              <div className="wf-empty-hint">选择运行记录后这里展示 DAG（节点颜色实时点亮）。</div>
            )}
          </div>
        </div>

        <div className="wf-inspector" style={{ position: 'static', width: 380, flexShrink: 0, border: 'none', borderLeft: '1px solid var(--border)', borderRadius: 0, overflow: 'auto' }}>
          {!selectedNodeRun && <div className="empty" style={{ marginTop: 40 }}>点击 DAG 节点查看详情与实时事件流</div>}
          {selectedNodeRun && (
            <>
              <h4>节点：{selectedNodeRun.nodeKey}
                <span className={`wf-badge ${selectedNodeRun.status}`} style={{ marginLeft: 8 }}>
                  {NODE_STATUS_LABEL[selectedNodeRun.status] ?? selectedNodeRun.status}
                </span>
              </h4>
              <div className="desc mono" style={{ marginBottom: 8 }}>会话 {selectedNodeRun.sessionId ?? '(未创建)'}</div>
              {selectedSnapNode && (
                <>
                  <div className="field">
                    <label>Agent</label>
                    <div className="desc">{agents.find((a) => a.id === selectedSnapNode.agentId)?.name ?? selectedSnapNode.agentId}</div>
                  </div>
                  <div className="field">
                    <label>Prompt 模板</label>
                    <div className="desc code" style={{ whiteSpace: 'pre-wrap', padding: 8 }}>{selectedSnapNode.prompt}</div>
                  </div>
                </>
              )}
              {selectedNodeRun.status === 'awaiting_approval' && (
                <button className="btn primary" onClick={() => approveNode(selectedNodeRun.nodeKey)}>批准执行</button>
              )}
              {selectedNodeRun.status === 'success' && (
                <div className="field">
                  <label>输出</label>
                  <div className="desc" style={{ whiteSpace: 'pre-wrap' }}>{selectedNodeRun.output ?? '(空)'}</div>
                </div>
              )}
              {selectedNodeRun.status === 'failed' && (
                <div className="banner err">{selectedNodeRun.error ?? '未知错误'}</div>
              )}
              <div className="side-sep" />
              <label style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>实时事件流</label>
              <div className="wf-event-log">
                {(selectedFeed?.messages ?? []).length === 0 && <div className="empty">暂无事件</div>}
                {(selectedFeed?.messages ?? []).map((m) => (
                  <div key={m.id} className={`msg ${m.kind}`}>
                    <span className="tag">
                      {{ user: '输入', assistant: 'AI', cot: '思维链', tool: m.toolName ?? '工具', system: '系统' }[m.kind]}
                    </span>
                    {m.text}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}

export default function Runs(props) {
  return (
    <ReactFlowProvider>
      <RunsInner {...props} />
    </ReactFlowProvider>
  )
}
