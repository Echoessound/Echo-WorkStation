/**
 * renderer/src/api.js — 同源 API 客户端
 *
 * 两条通道：
 *  1. harness 官方 RPC：POST /api/<method>，信封 {type:'client-request', rpcId, method, payload}
 *     → {type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error}}
 *  2. Echo 产品域：/prod/* 简单 REST，{ok:true,value}|{ok:false,error:{message}}
 *
 * 关键契约事实（实测，勿改）：
 *  - 路径必须精确等于方法名，且 body.method 与路径一致（否则 404 / bad-request）
 *  - session.history 分页语义随版本漂移，消费端按 seq 去重 + 防御式翻页
 */

let rpcSeq = 0

/** harness 官方 RPC 信封 */
export async function rpc(method, payload) {
  const res = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `echo-${++rpcSeq}`, method, payload }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  const msg = await res.json()
  if (!msg.result?.ok) {
    const err = msg.result?.error ?? {}
    throw new Error(`rpc ${method} 失败 [${err.code}]: ${err.message}`)
  }
  return msg.result.value
}

/** 产品域 REST（/prod/*） */
export async function prod(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/prod/${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const msg = await res.json().catch(() => ({ ok: false, error: { message: `HTTP ${res.status}` } }))
  if (!msg.ok) throw new Error(msg.error?.message ?? `HTTP ${res.status}`)
  return msg.value
}

// ── harness 会话域 ──────────────────────────────────────────────────────────

export const sessions = {
  create: (payload) => rpc('session.create', payload),
  list: () => rpc('session.list', {}),
  history: (sessionId, opts = {}) => rpc('session.history', { sessionId, ...opts }),
  prompt: (sessionId, text, { mode = 'queue' } = {}) =>
    rpc('session.prompt', { sessionId, mode, content: [{ type: 'text', text }] }),
  cancel: (sessionId) => rpc('session.cancel', { sessionId }),
  models: (sessionId) => rpc('session.models', { sessionId }),
  selectModel: (sessionId, selection) => rpc('session.selectModel', { sessionId, ...selection }),
}

// ── 产品域 ──────────────────────────────────────────────────────────────────

export const product = {
  health: () => prod('health'),
  toolsets: () => prod('toolsets'),

  listWorkspaces: () => prod('workspaces'),
  createWorkspace: (body) => prod('workspaces', { method: 'POST', body }),
  updateWorkspace: (id, body) => prod(`workspaces/${id}`, { method: 'PUT', body }),
  deleteWorkspace: (id) => prod(`workspaces/${id}`, { method: 'DELETE' }),

  listAgents: (workspaceId) => prod(`agents${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`),
  getAgent: (id) => prod(`agents/${id}`),
  createAgent: (body) => prod('agents', { method: 'POST', body }),
  updateAgent: (id, body) => prod(`agents/${id}`, { method: 'PUT', body }),
  deleteAgent: (id) => prod(`agents/${id}`, { method: 'DELETE' }),

  listRuns: (agentId) => prod(`runs${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`),
  createRun: (body) => prod('runs', { method: 'POST', body }),
  updateRun: (id, body) => prod(`runs/${id}`, { method: 'PUT', body }),

  listWorkflows: () => prod('workflows'),
  getWorkflow: (id) => prod(`workflows/${id}`),
  createWorkflow: (body) => prod('workflows', { method: 'POST', body }),
  updateWorkflow: (id, body) => prod(`workflows/${id}`, { method: 'PUT', body }),
  deleteWorkflow: (id) => prod(`workflows/${id}`, { method: 'DELETE' }),
  seedReviewWorkflow: () => prod('workflows/seed/review', { method: 'POST' }),
  startWorkflowRun: (id, input) => prod(`workflows/${id}/run`, { method: 'POST', body: { input } }),
  listWorkflowRuns: (id) => prod(`workflows/${id}/runs`),
  getWorkflowRun: (runId) => prod(`workflows/runs/${runId}`),
  cancelWorkflowRun: (runId) => prod(`workflows/runs/${runId}/cancel`, { method: 'POST' }),
  resumeWorkflowRun: (runId) => prod(`workflows/runs/${runId}/resume`, { method: 'POST' }),
  approveWorkflowNode: (runId, nodeKey) => prod(`workflows/runs/${runId}/nodes/${nodeKey}/approve`, { method: 'POST' }),
}
