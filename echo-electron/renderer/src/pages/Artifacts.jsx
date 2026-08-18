import React, { useEffect, useState } from 'react'
import { product } from '../api.js'
import ArtifactPreview from '../ArtifactPreview.jsx'

const KIND_LABEL = { markdown: 'Markdown', json: 'JSON', code: '代码', table: '表格' }

export default function Artifacts() {
  const [items, setItems] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [err, setErr] = useState('')

  async function load() {
    try {
      const { items: list } = await product.listArtifacts()
      setItems(list ?? [])
    } catch (e) { setErr(e.message) }
  }
  useEffect(() => { void load() }, [])

  const selected = items.find((a) => a.id === selectedId) ?? null

  async function remove(id) {
    if (!window.confirm('删除该产物？')) return
    try {
      await product.deleteArtifact(id)
      if (selectedId === id) setSelectedId(null)
      await load()
    } catch (e) { setErr(e.message) }
  }

  return (
    <>
      <div className="side">
        <div className="page-sub" style={{ margin: '0 0 10px' }}>产物库（{items.length}）</div>
        <div className="list">
          {items.length === 0 && <div className="empty">还没有产物。<br />Workflow 节点以 JSON 输出会自动注册；也可在运行中心手动保存。</div>}
          {items.map((a) => (
            <div key={a.id} className={`list-item ${a.id === selectedId ? 'selected' : ''}`} onClick={() => setSelectedId(a.id)}>
              <div className="name">{[KIND_LABEL[a.kind] ?? a.kind, a.name].filter(Boolean).join(' · ')}</div>
              <div className="meta">{new Date(a.createdAt).toLocaleString()}{a.nodeKey ? ` · ${a.nodeKey}` : ''}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="main" style={{ padding: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="wf-run-head">
          {selected ? (
            <>
              <strong>{selected.name}</strong>
              <span className="wf-badge">{KIND_LABEL[selected.kind] ?? selected.kind}</span>
              {selected.nodeKey && <span className="mono" style={{ color: 'var(--text-dim)', fontSize: 12 }}>节点 {selected.nodeKey}</span>}
              {selected.runId && <span className="mono" style={{ color: 'var(--text-dim)', fontSize: 12 }}>run {selected.runId.slice(0, 8)}</span>}
              <span style={{ marginLeft: 'auto' }} />
              <button className="btn danger small" onClick={() => remove(selected.id)}>删除</button>
            </>
          ) : <span style={{ color: 'var(--text-dim)' }}>选择左侧产物预览</span>}
        </div>
        {err && <div className="banner err" style={{ margin: '8px 12px 0' }}>{err}</div>}
        <div style={{ flex: 1, overflow: 'auto', padding: '16px 24px' }}>
          {selected ? <ArtifactPreview artifact={selected} /> : <div className="empty">← 从左侧选择一个产物查看渲染预览</div>}
        </div>
      </div>
    </>
  )
}
