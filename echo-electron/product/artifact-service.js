/**
 * product/artifact-service.js — Echo Workstation 产物管线（M3）
 *
 * ArtifactRegistry：workflow / agent 运行产出的结构化产物（markdown / json / code / table）。
 * 产物来源：
 *  1. 自动：节点输出是 JSON（对象或 markdown 代码块中的 JSON），形如
 *     { "type": "markdown|json|code|table", "title": "…", "content": "…" } → 引擎节点完成时注册
 *  2. 手动：UI 把任意节点输出保存为产物（POST /prod/artifacts）
 *
 * artifacts 表：id, run_id, session_id, node_key, name, kind, path, content_json, created_at
 */
const { newId } = require('./db.js')

/** 允许的产物类型 */
const ARTIFACT_KINDS = ['markdown', 'json', 'code', 'table']

/**
 * 从节点输出文本中解析结构化产物。
 * 支持：
 *  - 纯 JSON 对象 { type, title, content }
 *  - markdown 代码块 ```json … ``` 包裹的上述对象
 * @param {string} text 节点输出
 * @returns {{ kind, name, content } | null} 解析成功返回产物字段；否则 null
 */
function parseArtifactOutput(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  const trimmed = text.trim()

  // 提取 JSON：优先整体，其次 ```json 代码块
  let candidate = null
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    candidate = trimmed
  } else {
    const m = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
    if (m) candidate = m[1].trim()
  }
  if (!candidate) return null

  let parsed
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const { type, title, content } = parsed
  if (!ARTIFACT_KINDS.includes(type)) return null
  if (typeof content !== 'string' || !content.trim()) return null
  return {
    kind: type,
    name: typeof title === 'string' && title.trim() ? title.trim() : '未命名产物',
    content,
  }
}

function artifactRow(row) {
  if (!row) return undefined
  return {
    id: row.id,
    runId: row.run_id ?? null,
    sessionId: row.session_id ?? null,
    nodeKey: row.node_key ?? null,
    name: row.name,
    kind: row.kind,
    path: row.path ?? null,
    content: safeJson(row.content_json, null),
    createdAt: row.created_at,
  }
}

function safeJson(text, fallback) {
  try {
    const v = JSON.parse(text)
    return v === null || v === undefined ? fallback : v
  } catch {
    return fallback
  }
}

function createArtifactService(db) {
  return {
    /** 列出产物（可选按 runId / sessionId 过滤），created_at 倒序 */
    async list({ runId, sessionId } = {}) {
      let rows
      if (runId) rows = db.all('SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at DESC', [runId])
      else if (sessionId) rows = db.all('SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at DESC', [sessionId])
      else rows = db.all('SELECT * FROM artifacts ORDER BY created_at DESC')
      return rows.map(artifactRow)
    },

    async get(id) {
      return artifactRow(db.get('SELECT * FROM artifacts WHERE id = ?', [id]))
    },

    /**
     * 注册一个产物。
     * @param {{ runId?, sessionId?, nodeKey?, name, kind, content }} input kind ∈ markdown|json|code|table
     */
    async create({ runId, sessionId, nodeKey, name, kind, content }) {
      if (!name?.trim()) throw new Error('产物需要 name')
      if (!ARTIFACT_KINDS.includes(kind)) throw new Error(`未知产物类型: ${kind}（支持 ${ARTIFACT_KINDS.join('/')}）`)
      if (typeof content !== 'string' || !content.trim()) throw new Error('产物内容不能为空')
      const id = newId()
      db.run(
        `INSERT INTO artifacts (id, run_id, session_id, node_key, name, kind, content_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, runId ?? null, sessionId ?? null, nodeKey ?? null, name.trim(), kind,
          JSON.stringify({ content }), Date.now()],
      )
      return this.get(id)
    },

    async remove(id) {
      db.run('DELETE FROM artifacts WHERE id = ?', [id])
    },
  }
}

module.exports = { createArtifactService, parseArtifactOutput, ARTIFACT_KINDS }
