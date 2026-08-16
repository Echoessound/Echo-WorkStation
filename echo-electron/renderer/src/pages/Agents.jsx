import React, { useEffect, useState } from 'react'
import { product } from '../api.js'

const EMPTY_FORM = {
  name: '',
  description: '',
  systemPrompt: '',
  toolset: 'basic',
  workspaceId: '',
  model: '',
}

export default function Agents({ agents, workspaces, toolsets, reload }) {
  const [selectedId, setSelectedId] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [isEdit, setIsEdit] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const selected = agents.find((a) => a.id === selectedId) ?? null

  useEffect(() => {
    if (!selected) return
    const m = selected.model ?? {}
    setForm({
      name: selected.name,
      description: selected.description ?? '',
      systemPrompt: selected.systemPrompt ?? '',
      toolset: selected.toolset,
      workspaceId: selected.workspaceId ?? '',
      model: [m.provider, m.model].filter(Boolean).join('/'),
    })
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  function startNew() {
    setSelectedId(null)
    setIsEdit(false)
    setForm(EMPTY_FORM)
    setErr('')
  }

  function patch(k, v) { setForm((f) => ({ ...f, [k]: v })) }

  async function save(e) {
    e.preventDefault()
    if (!form.name.trim()) { setErr('名称必填'); return }
    if (!form.systemPrompt.trim()) { setErr('系统提示词必填'); return }
    setBusy(true); setErr('')
    try {
      // model: "provider/model" → { provider, model }；空则 {}
      let model = {}
      const slash = form.model.lastIndexOf('/')
      if (slash > 0) {
        model = { provider: form.model.slice(0, slash).trim(), model: form.model.slice(slash + 1).trim() }
      } else if (form.model.trim()) {
        model = { provider: '', model: form.model.trim() }
      }
      const payload = {
        name: form.name.trim(),
        description: form.description.trim(),
        systemPrompt: form.systemPrompt,
        toolset: form.toolset,
        workspaceId: form.workspaceId || null,
        model,
      }
      if (isEdit && selectedId) await product.updateAgent(selectedId, payload)
      else await product.createAgent(payload)
      reload()
      startNew()
    } catch (e2) { setErr(e2.message) } finally { setBusy(false) }
  }

  async function remove() {
    if (!selectedId) return
    if (!window.confirm(`删除 agent「${selected?.name}」？其 preset 目录也会被删除。`)) return
    try {
      await product.deleteAgent(selectedId)
      reload()
      startNew()
    } catch (e2) { setErr(e2.message) }
  }

  const toolsetLabel = (id) => toolsets.find((t) => t.id === id)?.label ?? id

  return (
    <>
      <div className="side">
        <div className="row" style={{ marginBottom: 12 }}>
          <button className="btn primary small grow" onClick={startNew}>＋ 新建 Agent</button>
        </div>
        <div className="list">
          {agents.length === 0 && <div className="empty">还没有 agent。</div>}
          {agents.map((a) => (
            <div
              key={a.id}
              className={`list-item ${a.id === selectedId ? 'selected' : ''}`}
              onClick={() => { setSelectedId(a.id); setIsEdit(true) }}
            >
              <div className="name">{a.name}</div>
              <div className="meta">工具集：{toolsetLabel(a.toolset)}</div>
              {a.description && <div className="meta">{a.description}</div>}
            </div>
          ))}
        </div>
      </div>

      <div className="main" style={{ maxWidth: 640 }}>
        <h1 className="page-title">{isEdit ? '编辑 Agent' : '新建 Agent'}</h1>
        <p className="page-sub">
          系统提示词通过 <code>agent preset</code> 注入 harness（<code>{'session.create({ agentPreset })'}</code>）。
          保存后立即生成 preset 文件，无需重启引擎。
        </p>
        {err && <div className="banner err">{err}</div>}

        <form onSubmit={save} className="card">
          <div className="field">
            <label>名称 *</label>
            <input value={form.name} onChange={(e) => patch('name', e.target.value)} placeholder="例如：论文评审员" />
          </div>
          <div className="field">
            <label>描述</label>
            <input value={form.description} onChange={(e) => patch('description', e.target.value)} placeholder="一句话说明用途" />
          </div>
          <div className="field">
            <label>系统提示词 *（persona，即模型看到的 system prompt）</label>
            <textarea value={form.systemPrompt} onChange={(e) => patch('systemPrompt', e.target.value)}
              placeholder="你是一个…。你的任务是…。" />
          </div>
          <div className="field">
            <label>工具集</label>
            <select value={form.toolset} onChange={(e) => patch('toolset', e.target.value)}>
              {toolsets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
            <div className="hint">{toolsets.find((t) => t.id === form.toolset)?.description}</div>
          </div>
          <div className="field">
            <label>关联工作区（可选，决定试跑的 cwd）</label>
            <select value={form.workspaceId} onChange={(e) => patch('workspaceId', e.target.value)}>
              <option value="">（不关联）</option>
              {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name} — {w.path}</option>)}
            </select>
          </div>
          <div className="field">
            <label>模型（可选，格式 <code>provider/model</code>，例如 <code>deepseek/deepseek-chat</code>；留空用引擎默认）</label>
            <input value={form.model} onChange={(e) => patch('model', e.target.value)} className="mono" placeholder="provider/model" />
          </div>
          <div className="row">
            <button className="btn primary" disabled={busy}>{isEdit ? '保存修改' : '创建'}</button>
            {isEdit && <button type="button" className="btn danger" onClick={remove}>删除</button>}
            <button type="button" className="btn" onClick={startNew}>取消</button>
          </div>
          {selected && (
            <div className="hint" style={{ marginTop: 12 }}>
              preset：<code>{selected.presetId}</code>（写入引擎的 <code className="mono">.agent-presets/</code> 目录，实时扫描生效）
            </div>
          )}
        </form>
      </div>
    </>
  )
}
