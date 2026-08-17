import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  addEdge, useReactFlow, MarkerType,
  useNodesState, useEdgesState, Handle, Position,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { product } from '../api.js'

/** 画布节点（设计器用；data.status 用于运行中心着色） */
const WorkNodeView = React.memo(function WorkNodeView({ id, data, selected }) {
  const status = data.status ?? ''
  return (
    <div className={`wf-node ${status} ${selected ? 'wf-selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="wf-node-title">{data.label}</div>
      <div className="wf-node-sub">{data.agentName || '未选择 agent'}</div>
      {data.requiresApproval && <div className="wf-node-flag">审批</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  )
})

const nodeTypes = { workNode: WorkNodeView }

/** 边的默认外观：箭头表示方向（source → target），让连线方向一目了然 */
const defaultEdgeOptions = {
  markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: '#4c9aff' },
  style: { stroke: '#8b98a8', strokeWidth: 1.7 },
}

function Designer({ agents, reload }) {
  const [templates, setTemplates] = useState([])
  const [currentId, setCurrentId] = useState(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selectedKey, setSelectedKey] = useState(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState(null)
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const nodeSeq = useRef(1)
  const { updateNodeInternals, fitView } = useReactFlow()

  /** 节点 DOM 挂载后强制重测 handle 位置（v12 的 handleBounds 测量时序补偿，
   *  否则 internals.handleBounds 为空时连接无法启动 ——"节点不能相连"根因之一） */
  function remeasure(ids) {
    setTimeout(() => {
      try { updateNodeInternals(ids) } catch { /* noop */ }
      // 新节点可能在视口外（或被侧栏盖住）——重新适配视图让所有节点可见可连
      try { fitView({ padding: 0.25, duration: 200 }) } catch { /* noop */ }
    }, 60)
  }

  async function loadTemplates() {
    try {
      const { items } = await product.listWorkflows()
      setTemplates(items ?? [])
    } catch (e) { setErr(e.message) }
  }
  useEffect(() => { void loadTemplates() }, [])

  function agentName(id) { return agents.find((a) => a.id === id)?.name ?? '' }

  async function openTemplate(wf) {
    setCurrentId(wf.id)
    setName(wf.name)
    setDescription(wf.description ?? '')
    setSelectedKey(null)
    const seq = wf.nodes.reduce((m, n) => Math.max(m, Number(String(n.key).replace(/\D/g, '')) || 0), 0)
    nodeSeq.current = seq + 1
    setNodes(wf.nodes.map((n) => ({
      id: n.key,
      type: 'workNode',
      position: n.position && n.position.x !== undefined ? n.position : { x: 60, y: 60 },
      data: {
        label: n.key,
        agentId: n.agentId ?? '',
        agentName: n.agentId ? agentName(n.agentId) : '',
        prompt: n.params?.prompt ?? '',
        requiresApproval: !!n.params?.requiresApproval,
      },
    })))
    setEdges(wf.edges.map((e) => ({ id: `${e.source}->${e.target}`, source: e.source, target: e.target })))
    setErr('')
    remeasure(wf.nodes.map((n) => n.key))
  }

  async function selectTemplate(id) {
    try {
      const wf = await product.getWorkflow(id)
      await openTemplate(wf)
    } catch (e) { setErr(e.message) }
  }

  function newTemplate() {
    setCurrentId(null)
    setName('')
    setDescription('')
    setSelectedKey(null)
    setNodes([])
    setEdges([])
    nodeSeq.current = 1
    setErr('')
  }

  async function seedReview() {
    try {
      const wf = await product.seedReviewWorkflow()
      reload() // 刷新 App 的 agents（seed 会创建内置 agent）
      await loadTemplates()
      await openTemplate(wf)
    } catch (e) { setErr(e.message) }
  }

  function addNode() {
    let key = `node_${nodeSeq.current}`
    nodeSeq.current += 1
    while (nodes.some((n) => n.id === key)) { key = `node_${nodeSeq.current++}` }
    // 间距必须大于节点宽度（约 150px），否则新节点会盖住已有节点的连线把手
    // （"节点不能相连"根因：节点横向重叠 60px，handle 被邻居节点遮住）
    const pos = { x: 60 + (nodes.length % 3) * 280, y: 60 + Math.floor(nodes.length / 3) * 170 }
    setNodes((prev) => [...prev, {
      id: key, type: 'workNode', position: pos,
      data: { label: key, agentId: '', agentName: '', prompt: '', requiresApproval: false },
    }])
    setSelectedKey(key)
    remeasure([key])
  }

  function updateSelected(patch) {
    setNodes((prev) => prev.map((n) => (n.id === selectedKey ? { ...n, data: { ...n.data, ...patch } } : n)))
  }

  function deleteSelected() {
    if (!selectedKey) return
    setNodes((prev) => prev.filter((n) => n.id !== selectedKey))
    setEdges((prev) => prev.filter((e) => e.source !== selectedKey && e.target !== selectedKey))
    setSelectedKey(null)
  }

  /** 删除选中的连线（先点连线再点此按钮，或按 Delete 键） */
  function deleteSelectedEdge() {
    if (!selectedEdgeId) return
    setEdges((prev) => prev.filter((e) => e.id !== selectedEdgeId))
    setSelectedEdgeId(null)
  }

  async function save() {
    if (!name.trim()) { setErr('模板名必填'); return }
    const def = {
      name: name.trim(),
      description: description.trim(),
      nodes: nodes.map((n) => ({
        key: n.id,
        agentId: n.data.agentId || null,
        prompt: n.data.prompt ?? '',
        requiresApproval: !!n.data.requiresApproval,
        position: n.position ?? { x: 0, y: 0 },
      })),
      edges: edges.map((e) => ({ source: e.source, target: e.target })),
    }
    setSaving(true); setErr('')
    try {
      const saved = currentId
        ? await product.updateWorkflow(currentId, def)
        : await product.createWorkflow(def)
      setCurrentId(saved.id)
      await loadTemplates()
      setErr('')
    } catch (e) { setErr(e.message) } finally { setSaving(false) }
  }

  async function removeTemplate(id) {
    if (!window.confirm('删除该模板？历史运行记录保留。')) return
    try {
      await product.deleteWorkflow(id)
      if (currentId === id) newTemplate()
      await loadTemplates()
    } catch (e) { setErr(e.message) }
  }

  const onConnect = useCallback(
    (params) => {
      setEdges((prev) => addEdge({ ...params, id: `${params.source}->${params.target}` }, prev))
    },
    [],
  )

  const selectedNode = nodes.find((n) => n.id === selectedKey)

  return (
    <>
      <div className="side">
        <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap', gap: 6 }}>
          <button className="btn primary small" onClick={newTemplate}>＋ 新建模板</button>
          <button className="btn small" onClick={seedReview} title="一键创建 3 个内置评审 agent + 并行评审模板">载入并行评审模板</button>
        </div>
        <div className="page-sub" style={{ margin: '0 0 10px' }}>模板列表</div>
        <div className="list">
          {templates.length === 0 && <div className="empty">还没有模板</div>}
          {templates.map((t) => (
            <div key={t.id} className={`list-item ${t.id === currentId ? 'selected' : ''}`} onClick={() => selectTemplate(t.id)}>
              <div className="row">
                <div className="name grow" style={{ cursor: 'pointer' }}>{t.name}</div>
                <button className="btn danger small" onClick={(e) => { e.stopPropagation(); void removeTemplate(t.id) }}>删</button>
              </div>
              <div className="meta">{t.nodeCount} 个节点 · {new Date(t.updatedAt).toLocaleString()}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="main" style={{ display: 'flex', flexDirection: 'column', padding: 0 }}>
        <div className="wf-toolbar">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="模板名称" style={{ width: 160 }} />
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="描述（可选）" style={{ flex: 1 }} />
          <button className="btn small" onClick={addNode}>＋ 节点</button>
          {selectedKey && <button className="btn danger small" onClick={deleteSelected}>删除节点</button>}
          {selectedEdgeId && <button className="btn danger small" onClick={deleteSelectedEdge}>删除连线</button>}
          <button className="btn primary small" onClick={save} disabled={saving}>{saving ? '保存中…' : currentId ? '保存修改' : '创建模板'}</button>
        </div>
        {err && <div className="banner err" style={{ margin: '8px 12px 0' }}>{err}</div>}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              nodeTypes={nodeTypes}
              defaultEdgeOptions={defaultEdgeOptions}
              connectionLineStyle={{ stroke: '#4c9aff', strokeWidth: 2, strokeDasharray: '6 3' }}
              onNodeClick={(_e, node) => { setSelectedKey(node.id); setSelectedEdgeId(null) }}
              onEdgeClick={(_e, edge) => { setSelectedEdgeId(edge.id); setSelectedKey(null) }}
              onPaneClick={() => { setSelectedKey(null); setSelectedEdgeId(null) }}
              fitView
            >
              <Background />
              <Controls />
              <MiniMap pannable zoomable />
            </ReactFlow>
            {nodes.length === 0 && (
              <div className="wf-empty-hint">点「＋ 节点」添加 agent 节点，从节点<b>右端圆点</b>拖出连线（箭头指向下游）；点连线可选中，再点「删除连线」或按 Delete。</div>
            )}
          </div>

          {selectedNode && (
            <div className="wf-inspector">
              <div className="row" style={{ marginBottom: 8 }}>
                <h4 style={{ margin: 0 }}>节点：{selectedNode.data.label}</h4>
                <button className="btn small" onClick={() => setSelectedKey(null)} style={{ marginLeft: 'auto' }}>✕</button>
              </div>
              <div className="field">
                <label>Agent</label>
                <select
                  value={selectedNode.data.agentId}
                  onChange={(e) => updateSelected({ agentId: e.target.value, agentName: agentName(e.target.value) })}
                >
                  <option value="">（选择 agent）</option>
                  {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Prompt 模板（<code>{'{{input}}'}</code> = 运行输入；<code>{'{{node:key}}'}</code> = 上游输出）</label>
                <textarea value={selectedNode.data.prompt} onChange={(e) => updateSelected({ prompt: e.target.value })} rows={5} />
              </div>
              <label className="wf-check">
                <input type="checkbox" checked={!!selectedNode.data.requiresApproval}
                  onChange={(e) => updateSelected({ requiresApproval: e.target.checked })} />
                需要人工审批后才执行
              </label>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

export default function Workflows(props) {
  return (
    <ReactFlowProvider>
      <Designer {...props} />
    </ReactFlowProvider>
  )
}
