import React, { useState } from 'react'
import { product } from '../api.js'

export default function Workspaces({ workspaces, agents, reload }) {
  const [name, setName] = useState('')
  const [wsPath, setWsPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function create(e) {
    e.preventDefault()
    if (!name.trim() || !wsPath.trim()) { setErr('名称与路径均为必填'); return }
    setBusy(true); setErr('')
    try {
      await product.createWorkspace({ name: name.trim(), path: wsPath.trim() })
      setName(''); setWsPath('')
      reload()
    } catch (e2) { setErr(e2.message) } finally { setBusy(false) }
  }

  async function remove(id) {
    if (!window.confirm('删除该工作区？其中的 agent 不会被删除，仅解除关联。')) return
    try {
      await product.deleteWorkspace(id)
      reload()
    } catch (e2) { setErr(e2.message) }
  }

  return (
    <div className="main" style={{ maxWidth: 860 }}>
      <h1 className="page-title">工作区</h1>
      <p className="page-sub">工作区 = 一个本地目录（如项目仓库）。agent 试跑时以此为工作目录（cwd）。</p>
      {err && <div className="banner err">{err}</div>}

      <div className="card">
        <h3>新建工作区</h3>
        <form onSubmit={create}>
          <div className="field">
            <label>名称</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：代码项目" />
          </div>
          <div className="field">
            <label>路径（绝对路径）</label>
            <input value={wsPath} onChange={(e) => setWsPath(e.target.value)} placeholder="例如：F:\projects\app" className="mono" />
          </div>
          <button className="btn primary" disabled={busy}>创建</button>
        </form>
      </div>

      <div className="list">
        {workspaces.length === 0 && <div className="empty">还没有工作区，先创建一个。</div>}
        {workspaces.map((ws) => {
          const count = agents.filter((a) => a.workspaceId === ws.id).length
          return (
            <div key={ws.id} className="card" style={{ marginBottom: 10 }}>
              <div className="row">
                <div className="grow">
                  <strong>{ws.name}</strong>
                  <div className="desc mono">{ws.path}</div>
                  <div className="desc">创建于 {new Date(ws.createdAt).toLocaleString()} · 关联 {count} 个 agent</div>
                </div>
                <button className="btn danger small" onClick={() => remove(ws.id)}>删除</button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
