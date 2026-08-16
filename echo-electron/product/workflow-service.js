/**
 * product/workflow-service.js — Echo Workstation Workflow 服务（M2）
 *
 * 职责：
 *  1. Workflow 模板 CRUD（规范化存储：workflow_templates + workflow_nodes + workflow_edges）
 *  2. DAG 定义校验（节点 key 唯一、边引用存在、拓扑排序检测环）
 *  3. seed：一键载入「并行评审」内置模板（自动创建 4 个内置 agent，幂等）
 *
 * 节点定义（params_json）：
 *  { prompt: string, requiresApproval?: boolean }
 * 节点 prompt 模板变量：{{input}} = run 输入；{{node:<key>}} = 上游节点输出文本。
 */
const { newId } = require('./db.js')

const NODE_KEY_RE = /^[a-zA-Z0-9_-]{1,64}$/

function templateRow(row) {
  if (!row) return undefined
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function nodeRow(row) {
  if (!row) return undefined
  return {
    id: row.id,
    templateId: row.template_id,
    key: row.node_key,
    agentId: row.agent_id ?? null,
    params: safeJson(row.params_json, {}),
    position: safeJson(row.position_json, {}),
  }
}

function edgeRow(row) {
  if (!row) return undefined
  return {
    id: row.id,
    templateId: row.template_id,
    source: row.source_node,
    target: row.target_node,
    condition: safeJson(row.condition_json, null),
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

/**
 * DAG 定义校验。返回 { ok: true } 或 { ok: false, error }。
 * @param {{ nodes: Array, edges: Array }} def nodes: [{key, agentId?, prompt?, requiresApproval?, position?}]
 */
function validateDefinition(def) {
  const nodes = def?.nodes ?? []
  const edges = def?.edges ?? []
  if (!Array.isArray(nodes) || nodes.length === 0) return { ok: false, error: 'workflow 至少需要一个节点' }
  if (!Array.isArray(edges)) return { ok: false, error: 'edges 必须是数组' }

  const keys = new Set()
  for (const [i, node] of nodes.entries()) {
    if (typeof node.key !== 'string' || !NODE_KEY_RE.test(node.key)) {
      return { ok: false, error: `节点 #${i + 1} 的 key 非法（须匹配 ${NODE_KEY_RE}）` }
    }
    if (keys.has(node.key)) return { ok: false, error: `节点 key 重复: ${node.key}` }
    keys.add(node.key)
    if (!node.agentId) return { ok: false, error: `节点 ${node.key} 未选择 agent` }
    if (typeof node.prompt !== 'string' || !node.prompt.trim()) {
      return { ok: false, error: `节点 ${node.key} 缺少 prompt` }
    }
  }

  for (const [i, edge] of edges.entries()) {
    if (!edge || typeof edge.source !== 'string' || typeof edge.target !== 'string') {
      return { ok: false, error: `边 #${i + 1} 缺少 source/target` }
    }
    if (!keys.has(edge.source)) return { ok: false, error: `边 #${i + 1} 的 source 不存在: ${edge.source}` }
    if (!keys.has(edge.target)) return { ok: false, error: `边 #${i + 1} 的 target 不存在: ${edge.target}` }
    if (edge.source === edge.target) return { ok: false, error: `边 #${i + 1} 是自环: ${edge.source}` }
  }

  // 拓扑排序（Kahn）检测环
  const indegree = new Map([...keys].map((k) => [k, 0]))
  const out = new Map([...keys].map((k) => [k, []]))
  for (const edge of edges) {
    indegree.set(edge.target, indegree.get(edge.target) + 1)
    out.get(edge.source).push(edge.target)
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([k]) => k)
  const sorted = []
  while (queue.length > 0) {
    const k = queue.shift()
    sorted.push(k)
    for (const t of out.get(k)) {
      indegree.set(t, indegree.get(t) - 1)
      if (indegree.get(t) === 0) queue.push(t)
    }
  }
  if (sorted.length !== keys.size) {
    const cyclic = [...keys].filter((k) => !sorted.includes(k))
    return { ok: false, error: `检测到环，涉及节点: ${cyclic.join(', ')}` }
  }
  return { ok: true }
}

/** 提取 definition 里直接引用的全部上游 key 集合（用于提示词变量合法性检查） */
function upstreamKeysOf(def, nodeKey) {
  return new Set((def.edges ?? []).filter((e) => e.target === nodeKey).map((e) => e.source))
}

/**
 * Workflow 模板 CRUD。依赖 AgentService（seed 内置 agent 用）。
 */
function createWorkflowService(db, agents) {
  return {
    async list() {
      const rows = db.all('SELECT * FROM workflow_templates ORDER BY updated_at DESC')
      return rows.map((row) => {
        const count = db.get('SELECT COUNT(*) AS n FROM workflow_nodes WHERE template_id = ?', [row.id])
        return { ...templateRow(row), nodeCount: count?.n ?? 0 }
      })
    },

    /** 完整定义：{ ...template, nodes, edges } */
    async get(id) {
      const t = db.get('SELECT * FROM workflow_templates WHERE id = ?', [id])
      if (!t) return undefined
      const nodes = db.all('SELECT * FROM workflow_nodes WHERE template_id = ? ORDER BY created_at', [id]).map(nodeRow)
      const edges = db.all('SELECT * FROM workflow_edges WHERE template_id = ? ORDER BY created_at', [id]).map(edgeRow)
      return { ...templateRow(t), nodes, edges }
    },

    async create({ name, description = '', nodes, edges }) {
      const check = validateDefinition({ nodes, edges })
      if (!check.ok) throw new Error(check.error)
      if (!name?.trim()) throw new Error('workflow 需要 name')
      const now = Date.now()
      const id = newId()
      db.run(
        'INSERT INTO workflow_templates (id, name, description, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, name.trim(), description, '{}', now, now],
      )
      writeDefinition(db, id, nodes, edges)
      return this.get(id)
    },

    /** 全量替换定义（name/description 可选更新） */
    async update(id, { name, description, nodes, edges }) {
      const existing = db.get('SELECT * FROM workflow_templates WHERE id = ?', [id])
      if (!existing) throw new Error('workflow 不存在')
      const check = validateDefinition({ nodes, edges })
      if (!check.ok) throw new Error(check.error)
      const now = Date.now()
      db.run(
        'UPDATE workflow_templates SET name = ?, description = ?, updated_at = ? WHERE id = ?',
        [name?.trim() ?? existing.name, description !== undefined ? description : existing.description, now, id],
      )
      writeDefinition(db, id, nodes, edges)
      return this.get(id)
    },

    async remove(id) {
      db.run('DELETE FROM workflow_templates WHERE id = ?', [id])
      db.run('DELETE FROM workflow_nodes WHERE template_id = ?', [id])
      db.run('DELETE FROM workflow_edges WHERE template_id = ?', [id])
    },

    /**
     * 一键载入「并行评审」模板（幂等：模板按固定名称查重，agent 按 seedKey 查重）。
     * 结构：3 个评审节点（无入边，并行入口）→ 1 个汇总节点。
     */
    async seedReview() {
      const NAME = '并行评审模板'
      const existing = db.get('SELECT id FROM workflow_templates WHERE name = ?', [NAME])
      if (existing) return this.get(existing.id)

      const specs = [
        {
          seedKey: 'review-code',
          name: '评审·代码',
          description: '内置：代码质量/正确性/安全性评审',
          // agentPersona：静态系统提示词（harness persona 只支持 {{provider}}/{{model}}/{{cwd}}，不能放业务变量）
          agentPersona: '你是资深代码评审员。你评审用户提供的代码的质量、正确性、安全性与可维护性，输出 3-5 条按优先级排列的具体意见（含位置与改进建议）。只评审，不修改。',
          // nodePrompt：节点提示词（{{input}}/{{node:key}} 由 Echo 引擎在运行时渲染）
          nodePrompt: '请评审以下内容，给出 3-5 条按优先级排列的具体意见：\n\n{{input}}',
        },
        {
          seedKey: 'review-security',
          name: '评审·安全',
          description: '内置：应用安全评审',
          agentPersona: '你是应用安全专家。你从安全角度评审用户提供的内容：漏洞、注入、敏感信息泄露、权限与依赖风险，输出 3-5 条具体安全意见，按风险从高到低排序。',
          nodePrompt: '请从安全角度评审以下内容，输出 3-5 条按风险排序的意见：\n\n{{input}}',
        },
        {
          seedKey: 'review-docs',
          name: '评审·文档',
          description: '内置：技术文档评审',
          agentPersona: '你是技术文档评审员。你评审用户提供的文档内容的完整性、准确性、可读性与结构，输出 3-5 条具体改进意见。',
          nodePrompt: '请评审以下文档内容，输出 3-5 条具体改进意见：\n\n{{input}}',
        },
        {
          seedKey: 'review-summary',
          name: '评审·汇总',
          description: '内置：评审意见汇总成最终报告',
          agentPersona: '你是评审汇总员。你把多份评审意见去重、合并、按主题归类，输出结构化最终评审报告（markdown）：总体结论、问题清单（按严重程度分级）、优点。',
          nodePrompt: '请把以下三份评审意见汇总成最终评审报告（markdown）：\n\n代码评审：\n{{node:review_code}}\n\n安全评审：\n{{node:review_security}}\n\n文档评审：\n{{node:review_docs}}',
        },
      ]

      // 1. 找或建内置 agent（params.seedKey 标记）
      const agentBySeed = {}
      const existingAgents = db.all('SELECT * FROM agents')
      for (const row of existingAgents) {
        const seedKey = safeJson(row.params_json, {})?.seedKey
        if (seedKey) agentBySeed[seedKey] = row
      }
      for (const spec of specs) {
        if (!agentBySeed[spec.seedKey]) {
          const agent = await agents.create({
            name: spec.name,
            description: spec.description,
            systemPrompt: spec.agentPersona,
            toolset: 'none',
            params: { seedKey: spec.seedKey },
          })
          agentBySeed[spec.seedKey] = { id: agent.id }
        }
      }

      // 2. 建模板：3 评审（并行入口）→ 汇总
      const nodes = [
        { key: 'review_code', agentId: agentBySeed['review-code'].id, prompt: specs[0].nodePrompt, position: { x: 80, y: 80 } },
        { key: 'review_security', agentId: agentBySeed['review-security'].id, prompt: specs[1].nodePrompt, position: { x: 80, y: 240 } },
        { key: 'review_docs', agentId: agentBySeed['review-docs'].id, prompt: specs[2].nodePrompt, position: { x: 80, y: 400 } },
        { key: 'summary', agentId: agentBySeed['review-summary'].id, prompt: specs[3].nodePrompt, position: { x: 460, y: 240 } },
      ]
      const edges = [
        { source: 'review_code', target: 'summary' },
        { source: 'review_security', target: 'summary' },
        { source: 'review_docs', target: 'summary' },
      ]
      return this.create({ name: NAME, description: '三个评审 agent 并行评审同一输入，汇总 agent 合并输出最终报告（M2 验收模板）', nodes, edges })
    },
  }
}

/** 全量写 nodes/edges（事务内删除旧行 + 插入新行） */
function writeDefinition(db, templateId, nodes, edges) {
  db.exec(({ run, all }) => {
    run('DELETE FROM workflow_nodes WHERE template_id = ?', [templateId])
    run('DELETE FROM workflow_edges WHERE template_id = ?', [templateId])
    const now = Date.now()
    for (const node of nodes) {
      run(
        `INSERT INTO workflow_nodes (id, template_id, node_key, agent_id, params_json, position_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [newId(), templateId, node.key, node.agentId ?? null,
          JSON.stringify({ prompt: node.prompt ?? '', requiresApproval: node.requiresApproval ?? false }),
          JSON.stringify(node.position ?? {}), now],
      )
    }
    for (const edge of edges) {
      run(
        'INSERT INTO workflow_edges (id, template_id, source_node, target_node, condition_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [newId(), templateId, edge.source, edge.target, edge.condition !== undefined ? JSON.stringify(edge.condition) : null, now],
      )
    }
  })
}

module.exports = { createWorkflowService, validateDefinition, upstreamKeysOf }
