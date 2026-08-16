/**
 * product/services.js — Echo Workstation 产品域服务（M1）
 *
 * WorkspaceService：workspace 产品域 CRUD（用户目录集合）。
 * AgentService：agent 产品域 CRUD + **agent preset 生成**。
 *
 * preset 机制（与 harness 契约一致，勿改）：
 *  - harness 的 `session.prompt` 没有 systemPrompt 字段，系统提示词只能通过
 *    `session.create({ agentPreset })` 注入 → agent 定义必须落盘为 preset。
 *  - 一个 preset = `<dshHome>/.agent-presets/<id>/agent.cordis.yml`
 *    （组合文件）+ 可选 `preset.yml`（显示名/描述）。
 *  - `<dshHome>` 默认 `~/.dsh`，可用环境变量 DSH_HOME 覆盖（测试隔离用）。
 *  - discovery 每次调用实时扫描目录，运行时写入立即可见，无需重启 harness。
 *  - preset id 必须匹配 /^[a-z0-9][a-z0-9-]*$/（目录名即 id）。
 *
 * 工具集（toolset）→ 组合模板：
 *  - none  仅 persona（无工具，纯对话）
 *  - basic 轻量编码 agent（persistent shell + 本地文件系统，复制 shipped minimal）
 *  - full  完整编码 agent（fs/search/shell/web/subagent/workflow/plan/compaction…，复制 shipped standard）
 *
 * 模板文件位于 product/presets/<toolset>/agent.cordis.yml，persona 文本用
 * 占位符 __ECHO_SYSTEM_PROMPT__ 标记，生成时替换为用户输入。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { newId } = require('./db.js')

/** 解析 harness 主目录（DSH_HOME 环境变量优先，便于测试隔离） */
function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 用户 preset 根目录（与 harness discovery 的 USER_PRESET_DIR 一致） */
function userPresetRoot() {
  return path.join(resolveDshHome(), '.agent-presets')
}

/** agent 对应的 preset 目录（目录名即 preset id） */
function presetDirFor(agentId) {
  return path.join(userPresetRoot(), `echo-${agentId}`)
}

/** 工具集模板清单（供 UI 下拉展示） */
const TOOLSETS = [
  { id: 'none', label: '无工具（纯对话）', description: '仅 persona，模型直接对话，不挂任何工具' },
  { id: 'basic', label: '基础（Shell + 文件系统）', description: '持久 Shell + 本地文件读写，适合轻量编码任务' },
  { id: 'full', label: '完整（编码 Agent）', description: '文件/搜索/Shell/Web/子代理/Workflow/计划/压缩，对标 standard' },
]

/** 读取工具集模板文本 */
function readToolsetTemplate(toolset) {
  const file = path.join(__dirname, 'presets', toolset, 'agent.cordis.yml')
  return fs.readFileSync(file, 'utf8')
}

/**
 * 把用户系统提示词渲染进模板（YAML 字面块，保留换行）。
 * 每行按 persona.config.text 的缩进（6 空格）写入。
 */
function renderComposition(template, systemPrompt) {
  const lines = String(systemPrompt ?? '').split('\n')
  const indented = lines.map((line) => `      ${line}`).join('\n')
  return template.replace('__ECHO_SYSTEM_PROMPT__', indented)
}

/** 渲染 preset.yml（显示名 + 描述） */
function renderPresetYml(agent) {
  const lines = [`name: ${yamlScalar(agent.name)}`]
  if (agent.description) lines.push(`description: ${yamlScalar(agent.description)}`)
  return lines.join('\n') + '\n'
}

/** 简单 YAML 标量转义（双引号包裹，转义内部双引号与反斜杠） */
function yamlScalar(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** 生成（或覆盖）一个 agent 的 preset 目录 */
function writeAgentPreset(agent) {
  const dir = presetDirFor(agent.id)
  fs.mkdirSync(dir, { recursive: true })
  const template = readToolsetTemplate(agent.toolset)
  fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), renderComposition(template, agent.systemPrompt), 'utf8')
  fs.writeFileSync(path.join(dir, 'preset.yml'), renderPresetYml(agent), 'utf8')
}

/** 删除一个 agent 的 preset 目录（幂等） */
function removeAgentPreset(agentId) {
  const dir = presetDirFor(agentId)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch { /* 已不存在 */ }
}

// ── 行 → 对象 / 对象 → 行 映射 ──────────────────────────────────────────────

function workspaceRow(row) {
  if (!row) return undefined
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function agentRow(row) {
  if (!row) return undefined
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    systemPrompt: row.system_prompt,
    model: safeJson(row.model_json, {}),
    toolset: row.toolset,
    workspaceId: row.workspace_id ?? null,
    params: safeJson(row.params_json, {}),
    presetId: row.preset_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function runRow(row) {
  if (!row) return undefined
  return {
    id: row.id,
    kind: row.kind,
    agentId: row.agent_id ?? null,
    workspaceId: row.workspace_id ?? null,
    sessionId: row.session_id ?? null,
    status: row.status,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    input: safeJson(row.input_json, null),
    error: row.error ?? null,
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

// ── WorkspaceService ────────────────────────────────────────────────────────

function createWorkspaceService(db) {
  return {
    async list() {
      return db.all('SELECT * FROM workspaces ORDER BY updated_at DESC').map(workspaceRow)
    },

    async get(id) {
      return workspaceRow(db.get('SELECT * FROM workspaces WHERE id = ?', [id]))
    },

    async create({ name, path: wsPath }) {
      if (!name || !wsPath) throw new Error('workspace 需要 name 与 path')
      const now = Date.now()
      const id = newId()
      db.run(
        'INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [id, name, wsPath, now, now],
      )
      return this.get(id)
    },

    async update(id, { name, path: wsPath }) {
      const existing = db.get('SELECT * FROM workspaces WHERE id = ?', [id])
      if (!existing) throw new Error('workspace 不存在')
      const now = Date.now()
      db.run(
        'UPDATE workspaces SET name = ?, path = ?, updated_at = ? WHERE id = ?',
        [name ?? existing.name, wsPath ?? existing.path, now, id],
      )
      return this.get(id)
    },

    async remove(id) {
      db.run('DELETE FROM workspaces WHERE id = ?', [id])
    },
  }
}

// ── AgentService ────────────────────────────────────────────────────────────

function createAgentService(db) {
  return {
    TOOLSETS,

    async list({ workspaceId } = {}) {
      const rows = workspaceId
        ? db.all('SELECT * FROM agents WHERE workspace_id = ? ORDER BY updated_at DESC', [workspaceId])
        : db.all('SELECT * FROM agents ORDER BY updated_at DESC')
      return rows.map(agentRow)
    },

    async get(id) {
      return agentRow(db.get('SELECT * FROM agents WHERE id = ?', [id]))
    },

    /**
     * 新建 agent：写 agents 表 + 生成 preset 文件。
     * @param {{ name, description?, systemPrompt?, model?, toolset?, workspaceId?, params? }} input
     */
    async create(input) {
      const { name, description = '', systemPrompt = '', toolset = 'basic' } = input
      if (!name) throw new Error('agent 需要 name')
      if (!TOOLSETS.some((t) => t.id === toolset)) throw new Error(`未知工具集: ${toolset}`)
      const now = Date.now()
      const id = newId()
      const presetId = `echo-${id}`
      const agent = {
        id,
        name,
        description,
        systemPrompt,
        model: input.model ?? {},
        toolset,
        workspaceId: input.workspaceId ?? null,
        params: input.params ?? {},
        presetId,
        createdAt: now,
        updatedAt: now,
      }
      db.run(
        `INSERT INTO agents (id, name, description, system_prompt, model_json, toolset, workspace_id, params_json, preset_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [agent.id, agent.name, agent.description, agent.systemPrompt,
          JSON.stringify(agent.model), agent.toolset, agent.workspaceId,
          JSON.stringify(agent.params), agent.presetId, now, now],
      )
      writeAgentPreset(agent)
      return this.get(id)
    },

    /** 更新 agent：写表 + 重写 preset 文件（composition 变化由 harness 按文件 stamp 感知） */
    async update(id, input) {
      const existing = db.get('SELECT * FROM agents WHERE id = ?', [id])
      if (!existing) throw new Error('agent 不存在')
      const now = Date.now()
      const merged = {
        id,
        name: input.name ?? existing.name,
        description: input.description !== undefined ? input.description : existing.description,
        systemPrompt: input.systemPrompt !== undefined ? input.systemPrompt : existing.system_prompt,
        model: input.model !== undefined ? input.model : safeJson(existing.model_json, {}),
        toolset: input.toolset ?? existing.toolset,
        workspaceId: input.workspaceId !== undefined ? input.workspaceId : existing.workspace_id,
        params: input.params !== undefined ? input.params : safeJson(existing.params_json, {}),
        presetId: existing.preset_id,
        createdAt: existing.created_at,
        updatedAt: now,
      }
      if (!TOOLSETS.some((t) => t.id === merged.toolset)) throw new Error(`未知工具集: ${merged.toolset}`)
      db.run(
        `UPDATE agents SET name = ?, description = ?, system_prompt = ?, model_json = ?, toolset = ?,
           workspace_id = ?, params_json = ?, updated_at = ? WHERE id = ?`,
        [merged.name, merged.description, merged.systemPrompt, JSON.stringify(merged.model),
          merged.toolset, merged.workspaceId, JSON.stringify(merged.params), now, id],
      )
      writeAgentPreset(merged)
      return this.get(id)
    },

    /** 删除 agent：删表行 + 删 preset 目录 */
    async remove(id) {
      db.run('DELETE FROM agents WHERE id = ?', [id])
      removeAgentPreset(id)
    },

    /** 确保 preset 文件存在（应用重启后若文件丢失则重建） */
    async ensurePresets() {
      const rows = db.all('SELECT * FROM agents')
      for (const row of rows) {
        const agent = agentRow(row)
        const dir = presetDirFor(agent.id)
        const composition = path.join(dir, 'agent.cordis.yml')
        if (!fs.existsSync(composition)) writeAgentPreset(agent)
      }
      return rows.length
    },
  }
}

// ── RunService（agent → harness 会话映射，支撑 Chat 历史恢复）──────────────

function createRunService(db) {
  return {
    /** 列出 run（可选按 agentId 过滤），created_at 倒序 */
    async list({ agentId } = {}) {
      const rows = agentId
        ? db.all('SELECT * FROM runs WHERE agent_id = ? ORDER BY created_at DESC', [agentId])
        : db.all('SELECT * FROM runs ORDER BY created_at DESC')
      return rows.map(runRow)
    },

    async get(id) {
      return runRow(db.get('SELECT * FROM runs WHERE id = ?', [id]))
    },

    /** 新建 run（status=running，记录 agent→session 映射与工作区） */
    async create({ kind = 'chat', agentId, workspaceId, sessionId, input } = {}) {
      const now = Date.now()
      const id = newId()
      db.run(
        `INSERT INTO runs (id, kind, agent_id, workspace_id, session_id, status, started_at, input_json, created_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
        [id, kind, agentId ?? null, workspaceId ?? null, sessionId ?? null, now,
          input !== undefined ? JSON.stringify(input) : null, now],
      )
      return this.get(id)
    },

    /** 更新 run 状态（running → success / failed / cancelled） */
    async update(id, { status, finishedAt, error, sessionId } = {}) {
      const existing = db.get('SELECT * FROM runs WHERE id = ?', [id])
      if (!existing) throw new Error('run 不存在')
      db.run(
        `UPDATE runs SET status = ?, finished_at = ?, error = ?, session_id = ? WHERE id = ?`,
        [status ?? existing.status, finishedAt ?? existing.finished_at,
          error ?? existing.error, sessionId ?? existing.session_id, id],
      )
      return this.get(id)
    },

    async remove(id) {
      db.run('DELETE FROM runs WHERE id = ?', [id])
    },
  }
}

module.exports = {
  createWorkspaceService, createAgentService, createRunService,
  resolveDshHome, userPresetRoot, TOOLSETS,
}
