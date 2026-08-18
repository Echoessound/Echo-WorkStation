/**
 * product/workflow-engine.js — Echo Workstation DAG 调度器（M2）
 *
 * 每个节点 = harness 一次会话（session.create + prompt）；节点输出 =
 * 会话最终回合的 assistant 文本。并行：无入边节点与「上游全部 success」的
 * 节点按批并行启动。
 *
 * 关键设计：
 *  - 主进程（Electron/Node 20）无 WebSocket → 节点完成检测用 session.history
 *    轮询（1.5s），检测最新回合 turn/end 并提取输出。前端实时性由渲染层
 *    自己的 mux 订阅负责（浏览器有 WebSocket）。
 *  - 所有状态持久化在 SQLite：进程重启后 recover() 把进行中的 run 标记
 *    interrupted，用户可 resume（重跑 interrupted + 继续 pending）。
 *  - 运行快照：startRun 时把模板定义（nodes/edges/agentId/prompt）拷进
 *    runs.input_json，模板后续编辑不影响进行中的 run。
 *
 * 节点状态机：
 *   pending → running → success | failed
 *   pending → awaiting_approval → (approve) pending → running …
 *   running → cancelled（run 取消）
 *   running/awaiting_approval → interrupted（进程重启）→ (resume) pending
 */
const { newId } = require('./db.js')
const { parseArtifactOutput } = require('./artifact-service.js')

const NODE_TIMEOUT_MS = 10 * 60 * 1000 // 单节点会话超时
const POLL_INTERVAL_MS = 1500

const NODE_PENDING = 'pending'
const NODE_RUNNING = 'running'
const NODE_SUCCESS = 'success'
const NODE_FAILED = 'failed'
const NODE_AWAITING = 'awaiting_approval'
const NODE_APPROVED = 'approved' // 已批准、待启动（短暂状态，防止 schedule 把审批节点二次挂起）
const NODE_CANCELLED = 'cancelled'
const NODE_INTERRUPTED = 'interrupted'

const RUN_RUNNING = 'running'
const RUN_SUCCESS = 'success'
const RUN_FAILED = 'failed'
const RUN_CANCELLED = 'cancelled'

function safeJson(text, fallback) {
  try {
    const v = JSON.parse(text)
    return v === null || v === undefined ? fallback : v
  } catch {
    return fallback
  }
}

/** 从 history 事件数组提取最后一个回合的 assistant 输出文本 */
function extractOutput(events) {
  // 定位最后一个 turn/start 的索引
  let turnStart = -1
  for (let i = 0; i < events.length; i += 1) {
    if (events[i]?.type === 'turn/start') turnStart = i
  }
  const turnEvents = turnStart >= 0 ? events.slice(turnStart + 1) : events
  // 优先 assistant/message 的完整文本
  for (let i = turnEvents.length - 1; i >= 0; i -= 1) {
    const ev = turnEvents[i]
    if (ev?.type === 'assistant/message') {
      const text = textOf(ev.data?.message)
      if (text) return text
    }
  }
  // 回退：拼接 assistant/chunk 的 text deltas
  let out = ''
  for (const ev of turnEvents) {
    if (ev?.type !== 'assistant/chunk') continue
    const c = ev.data?.chunk ?? {}
    if (c.type === 'text-delta') out += c.text ?? ''
  }
  return out
}

function textOf(msg) {
  if (typeof msg?.text === 'string') return msg.text
  if (Array.isArray(msg?.content)) {
    return msg.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
  }
  return ''
}

/** 提示词模板渲染：{{input}}、{{workspace}}（运行目标目录）与 {{node:<key>}} */
function renderPrompt(template, { input, workspace, nodeOutputs }) {
  let missing = null
  const out = template.replace(/\{\{(input|workspace|node:([a-zA-Z0-9_-]+))\}\}/g, (whole, kind, nodeKey) => {
    if (kind === 'input') return input ?? ''
    if (kind === 'workspace') return workspace ?? ''
    const value = nodeOutputs[nodeKey]
    if (value === undefined || value === null) {
      missing = missing ?? nodeKey
      return ''
    }
    return String(value)
  })
  if (missing !== null) {
    throw new Error(`提示词引用了尚未可用的节点输出: {{node:${missing}}}`)
  }
  return out
}

/** 按 runId 读 run（含 input 快照） */
function readRun(db, runId) {
  const row = db.get('SELECT * FROM runs WHERE id = ?', [runId])
  if (!row) return undefined
  return {
    id: row.id,
    kind: row.kind,
    templateId: row.template_id ?? null,
    status: row.status,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    input: safeJson(row.input_json, {}),
    output: safeJson(row.output_json, null),
    error: row.error ?? null,
    createdAt: row.created_at,
  }
}

function readNodeRuns(db, runId) {
  return db.all('SELECT * FROM workflow_run_nodes WHERE run_id = ? ORDER BY created_at', [runId]).map((row) => ({
    id: row.id,
    runId: row.run_id,
    nodeKey: row.node_key,
    agentId: row.agent_id ?? null,
    sessionId: row.session_id ?? null,
    status: row.status,
    output: safeJson(row.output_json, null),
    error: row.error ?? null,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
  }))
}

function updateNodeRun(db, id, fields) {
  try {
    const existing = db.get('SELECT * FROM workflow_run_nodes WHERE id = ?', [id])
    if (!existing) return
    db.run(
      `UPDATE workflow_run_nodes SET status = ?, session_id = ?, output_json = ?, error = ?, started_at = ?, finished_at = ? WHERE id = ?`,
      [fields.status ?? existing.status,
        fields.sessionId !== undefined ? fields.sessionId : existing.session_id,
        fields.output !== undefined ? JSON.stringify(fields.output) : existing.output_json,
        fields.error !== undefined ? fields.error : existing.error,
        fields.startedAt !== undefined ? fields.startedAt : existing.started_at,
        fields.finishedAt !== undefined ? fields.finishedAt : existing.finished_at,
        id],
    )
  } catch (err) {
    // 进程退出/测试清理时与飞行中的轮询竞争的常见路径；状态丢失好过崩溃
    console.warn('[workflow] updateNodeRun failed:', err.message)
  }
}

function updateRunStatus(db, runId, status, { finishedAt, error, output } = {}) {
  try {
    db.run(
      'UPDATE runs SET status = ?, finished_at = ?, error = ?, output_json = ? WHERE id = ?',
      [status, finishedAt ?? null, error !== undefined ? error : null,
        output !== undefined ? JSON.stringify(output) : null, runId],
    )
  } catch (err) {
    console.warn('[workflow] updateRunStatus failed:', err.message)
  }
}

/**
 * 创建 DAG 调度器。
 * @param {{ db, runService, workflowService, agentService, artifactService, harnessBase }} deps
 *   harnessBase 形如 http://127.0.0.1:<port>/api
 */
function createWorkflowEngine({ db, runService, workflowService, agentService, artifactService, harnessBase }) {
  /** harness RPC 信封（与 echo-api.mjs 一致） */
  async function rpc(method, payload) {
    const res = await fetch(`${harnessBase}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `wf-${Math.random().toString(36).slice(2)}`, method, payload }),
    })
    const msg = await res.json().catch(() => null)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (!msg?.result?.ok) {
      const err = msg?.result?.error ?? {}
      throw new Error(`rpc ${method} [${err.code}]: ${err.message}`)
    }
    return msg.result.value
  }

  /**
   * 启动一次 workflow 运行：快照定义 → 建 run + node runs → 开始调度。
   * @param {string} templateId
   * @param {string} input 运行输入文本（{{input}}）
   * @param {string|null} workspace 目标目录（{{workspace}}；节点会话 cwd 的兜底）
   * @returns {Promise<{runId}>}
   */
  async function startRun(templateId, input, workspace = null) {
    const wf = await workflowService.get(templateId)
    if (!wf) throw new Error('workflow 模板不存在')
    const snapshot = {
      name: wf.name,
      nodes: wf.nodes.map((n) => ({
        key: n.key,
        agentId: n.agentId,
        prompt: n.params?.prompt ?? '',
        requiresApproval: !!n.params?.requiresApproval,
        position: n.position ?? { x: 0, y: 0 },
      })),
      edges: wf.edges.map((e) => ({ source: e.source, target: e.target })),
    }
    const run = await runService.create({
      kind: 'workflow',
      templateId,
      input: { input: input ?? '', workspace: workspace ?? null, template: snapshot },
    })
    const now = Date.now()
    for (const node of snapshot.nodes) {
      db.run(
        `INSERT INTO workflow_run_nodes (id, run_id, node_key, agent_id, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
        [newId(), run.id, node.key, node.agentId ?? null, now],
      )
    }
    await schedule(run.id)
    return { runId: run.id }
  }

  /** 调度一批就绪节点；全部终态时收敛 run 状态。
   *  全程容错：进程退出/DB 关闭后，飞行中的调度链必须静默结束而不是崩溃。 */
  async function schedule(runId) {
    try {
      const run = readRun(db, runId)
      if (!run || run.status !== RUN_RUNNING) return
      const def = run.input?.template ?? { nodes: [], edges: [] }
      const nodeRuns = readNodeRuns(db, runId)
      const outputs = {}
      for (const nr of nodeRuns) if (nr.status === NODE_SUCCESS) outputs[nr.nodeKey] = nr.output

      const ready = nodeRuns.filter((nr) => {
        if (nr.status !== NODE_PENDING && nr.status !== NODE_APPROVED) return false
        const upstream = def.edges.filter((e) => e.target === nr.nodeKey).map((e) => e.source)
        return upstream.every((src) => outputs[src] !== undefined)
      })

      for (const nr of ready) {
        const nodeDef = def.nodes.find((n) => n.key === nr.nodeKey)
        // 审批节点仅在首次就绪（pending）时挂起；approved 表示人工已放行，直接启动
        if (nodeDef?.requiresApproval && nr.status === NODE_PENDING) {
          updateNodeRun(db, nr.id, { status: NODE_AWAITING })
        } else {
          void startNode(runId, nr, nodeDef, outputs).catch((err) => {
            try {
              console.error(`[workflow] 节点 ${nr.nodeKey} 启动异常:`, err.message)
              // 只有仍在 running 才算失败；cancelled/interrupted 是外部状态变更，保留
              const cur = readNodeRuns(db, runId).find((n) => n.id === nr.id)
              if (cur && cur.status === NODE_RUNNING) {
                updateNodeRun(db, nr.id, { status: NODE_FAILED, error: err.message, finishedAt: Date.now() })
              }
            } catch { /* db closed 等，静默 */ }
            try { void schedule(runId) } catch { /* noop */ }
          })
        }
      }

      converge(runId)
    } catch (err) {
      // database closed / 其他清理期竞态：静默结束
      console.warn('[workflow] schedule failed:', err.message)
    }
  }

  /** 收敛 run 终态（无 pending/running 节点时） */
  function converge(runId) {
    try {
      const run = readRun(db, runId)
      if (!run || run.status !== RUN_RUNNING) return
      const nodeRuns = readNodeRuns(db, runId)
      const active = nodeRuns.some((n) => [NODE_PENDING, NODE_RUNNING, NODE_AWAITING, NODE_APPROVED].includes(n.status))
      if (active) return
      const failedNodes = nodeRuns.filter((n) => n.status === NODE_FAILED)
      if (failedNodes.length > 0) {
        updateRunStatus(db, runId, RUN_FAILED, {
          finishedAt: Date.now(),
          error: `节点失败: ${failedNodes.map((n) => `${n.nodeKey}(${n.error ?? '未知错误'})`).join('; ')}`,
        })
      } else {
        const output = {}
        for (const nr of nodeRuns) output[nr.nodeKey] = nr.output
        updateRunStatus(db, runId, RUN_SUCCESS, { finishedAt: Date.now(), output })
      }
    } catch (err) {
      console.warn('[workflow] converge failed:', err.message)
    }
  }

  /** 启动一个节点：建会话 → 选模型 → prompt → 轮询直到回合结束/超时 */
  async function startNode(runId, nodeRun, nodeDef, outputs) {
    // 乐观标记 running（在任何 await 之前）：失败重调度时不会被重复启动
    updateNodeRun(db, nodeRun.id, { status: NODE_RUNNING, startedAt: Date.now(), error: null })
    const agent = await agentService.get(nodeDef.agentId)
    if (!agent) throw new Error(`agent 不存在: ${nodeDef.agentId}`)

    const runInput = readRun(db, runId)?.input ?? {}
    const prompt = renderPrompt(nodeDef.prompt, {
      input: runInput.input ?? '',
      workspace: runInput.workspace ?? '',
      nodeOutputs: outputs,
    })

    const createPayload = { agentPreset: agent.presetId }
    // cwd 优先级：agent 关联的 workspace path → 运行的 target 目录（workspace）→ 省略（harness 默认）
    if (agent.workspaceId) {
      const wsRow = db.get('SELECT * FROM workspaces WHERE id = ?', [agent.workspaceId])
      if (wsRow?.path) createPayload.cwd = wsRow.path
    } else if (runInput.workspace) {
      createPayload.cwd = runInput.workspace
    }

    const created = await rpc('session.create', createPayload)
    const sessionId = created.sessionId
    console.log(`[workflow] 节点 ${nodeRun.nodeKey} 会话已建 ${sessionId.slice(0, 8)}`)

    const model = agent.model ?? {}
    if (model.provider && model.model) {
      try {
        await rpc('session.selectModel', { sessionId, provider: model.provider, model: model.model })
      } catch (err) {
        console.warn(`[workflow] 节点 ${nodeDef.key} 选模型失败（用默认）:`, err.message)
      }
    }

    updateNodeRun(db, nodeRun.id, { sessionId })
    await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] })
    console.log(`[workflow] 节点 ${nodeRun.nodeKey} prompt 已发送，开始轮询`)

    // 轮询直到 turn/end（或超时/取消）
    const deadline = Date.now() + NODE_TIMEOUT_MS
    for (;;) {
      const now = Date.now()
      if (now > deadline) throw new Error(`节点超时（${NODE_TIMEOUT_MS / 60000} 分钟）`)
      const nr = readNodeRuns(db, runId).find((n) => n.id === nodeRun.id)
      if (nr?.status !== NODE_RUNNING) {
        throw new Error(nr?.status === NODE_CANCELLED ? '已取消' : `状态变更: ${nr?.status}`)
      }
      const hist = await rpc('session.history', { sessionId })
      const events = (hist.events ?? []).map((e) => e.event).filter(Boolean)
      // 定位最后一个回合：从末尾找 turn/end，确认它是「成功结束」而不是 error/cancelled
      let lastTurnEnd = null
      for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i].type === 'turn/end') { lastTurnEnd = events[i]; break }
      }
      if (lastTurnEnd) {
        const reason = lastTurnEnd.data?.reason ?? {}
        // 正常结束 = 'completed'（harness TurnEndReasonMap）；其余（error/aborted/blocked/max-tokens/interrupted）按失败处理
        if (reason.kind !== 'completed') {
          const msg = reason.error?.message ?? `回合以 ${reason.kind ?? '未知原因'} 结束`
          throw new Error(msg)
        }
        const output = extractOutput(events)
        updateNodeRun(db, nodeRun.id, { status: NODE_SUCCESS, output, finishedAt: Date.now() })
        console.log(`[workflow] 节点 ${nodeRun.nodeKey} 完成（${output.length} 字符）`)
        // M3：节点输出是结构化 JSON 产物时自动注册（ArtifactRegistry）
        if (artifactService) {
          try {
            const artifact = parseArtifactOutput(output)
            if (artifact) {
              await artifactService.create({
                runId,
                sessionId,
                nodeKey: nodeRun.nodeKey,
                ...artifact,
              })
              console.log(`[workflow] 节点 ${nodeRun.nodeKey} 已注册产物「${artifact.name}」(${artifact.kind})`)
            }
          } catch (err) {
            console.warn(`[workflow] 产物注册失败（节点 ${nodeRun.nodeKey}）:`, err.message)
          }
        }
        void schedule(runId)
        return
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    }
  }

  /** 取消运行：cancel 所有 running 节点会话，全部置 cancelled */
  async function cancelRun(runId) {
    const run = readRun(db, runId)
    if (!run || [RUN_SUCCESS, RUN_FAILED, RUN_CANCELLED].includes(run.status)) return
    for (const nr of readNodeRuns(db, runId)) {
      if (nr.status === NODE_RUNNING && nr.sessionId) {
        try { await rpc('session.cancel', { sessionId: nr.sessionId }) } catch { /* 已结束 */ }
      }
      if ([NODE_PENDING, NODE_RUNNING, NODE_AWAITING].includes(nr.status)) {
        updateNodeRun(db, nr.id, { status: NODE_CANCELLED, finishedAt: Date.now() })
      }
    }
    updateRunStatus(db, runId, RUN_CANCELLED, { finishedAt: Date.now(), error: '已取消' })
  }

  /** 审批放行一个等待节点：AWAITING → APPROVED（已批准待启动）→ 重新调度 */
  async function approveNode(runId, nodeKey) {
    const nr = readNodeRuns(db, runId).find((n) => n.nodeKey === nodeKey)
    if (!nr) throw new Error('节点不存在')
    if (nr.status !== NODE_AWAITING) throw new Error(`节点不在等待审批状态（当前: ${nr.status}）`)
    updateNodeRun(db, nr.id, { status: NODE_APPROVED })
    await schedule(runId)
  }

  /** 恢复中断的 run：interrupted → pending 重跑，pending 继续 */
  async function resumeRun(runId) {
    const run = readRun(db, runId)
    if (!run) throw new Error('run 不存在')
    if (run.status !== RUN_FAILED) throw new Error(`run 不可恢复（当前: ${run.status}）`)
    for (const nr of readNodeRuns(db, runId)) {
      if (nr.status === NODE_INTERRUPTED) {
        updateNodeRun(db, nr.id, { status: NODE_PENDING, error: null, sessionId: null })
      }
    }
    updateRunStatus(db, runId, RUN_RUNNING, { error: null })
    await schedule(runId)
  }

  /** 进程启动恢复：进行中的 run → 节点 interrupted + run failed（可 resume） */
  async function recover() {
    const rows = db.all("SELECT id FROM runs WHERE kind = 'workflow' AND status = ?", [RUN_RUNNING])
    for (const row of rows) {
      for (const nr of readNodeRuns(db, row.id)) {
        if (nr.status === NODE_RUNNING && nr.sessionId) {
          try { await rpc('session.cancel', { sessionId: nr.sessionId }) } catch { /* noop */ }
        }
        if ([NODE_RUNNING, NODE_AWAITING].includes(nr.status)) {
          updateNodeRun(db, nr.id, { status: NODE_INTERRUPTED, finishedAt: Date.now(), error: '应用重启中断' })
        }
      }
      updateRunStatus(db, row.id, RUN_FAILED, { error: '应用重启中断，可恢复（resume）' })
      console.log(`[workflow] run ${row.id} 已因重启中断，可 resume`)
    }
    return rows.length
  }

  /** run 详情快照（运行中心渲染用）：run + nodeRuns + 模板快照在 run.input 里 */
  async function getRunDetail(runId) {
    const run = readRun(db, runId)
    if (!run) throw new Error('run 不存在')
    return { run, nodes: readNodeRuns(db, runId) }
  }

  return { startRun, cancelRun, approveNode, resumeRun, recover, schedule, getRunDetail }
}

module.exports = {
  createWorkflowEngine,
  extractOutput,
  renderPrompt,
  NODE_STATUSES: [NODE_PENDING, NODE_RUNNING, NODE_SUCCESS, NODE_FAILED, NODE_AWAITING, NODE_APPROVED, NODE_CANCELLED, NODE_INTERRUPTED],
}
