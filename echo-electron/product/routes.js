/**
 * product/routes.js — Echo 产品域 API（/prod/*）
 *
 * 挂在 UI 服务器（proxy-server.js）的同源 HTTP server 上，与 harness 的
 * /api/* 平级。渲染层通过同源 fetch('/prod/...') 调用，无 CORS 问题。
 *
 * 约定：
 *  - 成功：{ ok: true, value: <data> }
 *  - 失败：{ ok: false, error: { message } }，HTTP 200 或 4xx
 *  - 资源路径：/prod/workspaces[/:id]、/prod/agents[/:id]
 */
const { createWorkspaceService, createAgentService, createRunService, resolveDshHome, userPresetRoot } = require('./services.js')
const { createWorkflowService } = require('./workflow-service.js')
const { createWorkflowEngine } = require('./workflow-engine.js')

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function ok(res, value) {
  sendJson(res, 200, { ok: true, value })
}

function fail(res, err, status = 400) {
  sendJson(res, status, { ok: false, error: { message: err?.message ?? String(err) } })
}

/** 读取请求体（JSON 对象） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(new Error(`请求体不是合法 JSON: ${err.message}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 创建产品域路由器。
 * @param {{ db: ProductDb, harnessBase?: string }} deps
 *   harnessBase 形如 http://127.0.0.1:<port>/api（workflow 引擎调 harness 用）
 * @returns {{ handle: (req, res) => Promise<boolean>, workflowEngine: object }}
 *   handle 处理 /prod/* 请求；返回是否已消费
 */
function createProductRouter({ db, harnessBase }) {
  const workspaces = createWorkspaceService(db)
  const agents = createAgentService(db)
  const runs = createRunService(db)
  const workflows = createWorkflowService(db, agents)
  const workflowEngine = harnessBase
    ? createWorkflowEngine({ db, runService: runs, workflowService: workflows, agentService: agents, harnessBase })
    : null

  async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE') {
      return false
    }
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (!url.pathname.startsWith('/prod/')) return false

    const parts = url.pathname.slice('/prod/'.length).split('/').filter(Boolean)
    const [resource, id] = parts

    try {
      // ── 元信息 ─────────────────────────────────────────────
      if (resource === 'health' && req.method === 'GET') {
        return ok(res, { ok: true, dshHome: resolveDshHome(), presetRoot: userPresetRoot() }), true
      }
      if (resource === 'toolsets' && req.method === 'GET') {
        return ok(res, agents.TOOLSETS), true
      }

      // ── workspaces ─────────────────────────────────────────
      if (resource === 'workspaces') {
        if (req.method === 'GET' && !id) {
          return ok(res, { items: await workspaces.list() }), true
        }
        if (req.method === 'POST' && !id) {
          const body = await readBody(req)
          return ok(res, await workspaces.create(body)), true
        }
        if (id) {
          if (req.method === 'GET') return ok(res, await workspaces.get(id)), true
          if (req.method === 'PUT') {
            const body = await readBody(req)
            return ok(res, await workspaces.update(id, body)), true
          }
          if (req.method === 'DELETE') {
            await workspaces.remove(id)
            return ok(res, { removed: id }), true
          }
        }
      }

      // ── agents ─────────────────────────────────────────────
      if (resource === 'agents') {
        if (req.method === 'GET' && !id) {
          const workspaceId = url.searchParams.get('workspaceId') ?? undefined
          return ok(res, { items: await agents.list(workspaceId ? { workspaceId } : {}) }), true
        }
        if (req.method === 'POST' && !id) {
          const body = await readBody(req)
          return ok(res, await agents.create(body)), true
        }
        if (id) {
          if (req.method === 'GET') return ok(res, await agents.get(id)), true
          if (req.method === 'PUT') {
            const body = await readBody(req)
            return ok(res, await agents.update(id, body)), true
          }
          if (req.method === 'DELETE') {
            await agents.remove(id)
            return ok(res, { removed: id }), true
          }
        }
      }

      // ── runs（agent → harness 会话映射，支撑 Chat 历史恢复）────
      if (resource === 'runs') {
        if (req.method === 'GET' && !id) {
          const agentId = url.searchParams.get('agentId') ?? undefined
          return ok(res, { items: await runs.list(agentId ? { agentId } : {}) }), true
        }
        if (req.method === 'POST' && !id) {
          const body = await readBody(req)
          return ok(res, await runs.create(body)), true
        }
        if (id) {
          if (req.method === 'GET') return ok(res, await runs.get(id)), true
          if (req.method === 'PUT') {
            const body = await readBody(req)
            return ok(res, await runs.update(id, body)), true
          }
          if (req.method === 'DELETE') {
            await runs.remove(id)
            return ok(res, { removed: id }), true
          }
        }
      }

      // ── workflows（M2：DAG 模板 + 运行）──────────────────────
      // 路径形态：/workflows | /workflows/:id | /workflows/seed/review
      //   | /workflows/:id/run | /workflows/:id/runs
      //   | /workflows/runs/:runId[ /cancel | /resume | /nodes/:key/approve ]
      if (resource === 'workflows') {
        const [p1, p2, p3, p4, p5] = parts.slice(1)
        if (!workflowEngine) throw new Error('workflow 引擎未配置（缺少 harnessBase）')

        // 列表 / 创建
        if (!p1) {
          if (req.method === 'GET') return ok(res, { items: await workflows.list() }), true
          if (req.method === 'POST') {
            const body = await readBody(req)
            return ok(res, await workflows.create(body)), true
          }
        }
        // 载入内置并行评审模板（幂等）
        if (p1 === 'seed' && p2 === 'review' && req.method === 'POST') {
          return ok(res, await workflows.seedReview()), true
        }
        // run 详情与操作
        if (p1 === 'runs' && p2) {
          if (p3 === 'cancel' && req.method === 'POST') {
            await workflowEngine.cancelRun(p2)
            return ok(res, { cancelled: p2 }), true
          }
          if (p3 === 'resume' && req.method === 'POST') {
            await workflowEngine.resumeRun(p2)
            return ok(res, { resumed: p2 }), true
          }
          if (p3 === 'nodes' && p5 === 'approve' && req.method === 'POST') {
            await workflowEngine.approveNode(p2, p4)
            return ok(res, { approved: p4 }), true
          }
          if (!p3 && req.method === 'GET') {
            return ok(res, await workflowEngine.getRunDetail(p2)), true
          }
        }
        // 模板详情 / 更新 / 删除 / 启动 / 运行历史
        if (p1) {
          if (!p2 && req.method === 'GET') return ok(res, await workflows.get(p1)), true
          if (!p2 && req.method === 'PUT') {
            const body = await readBody(req)
            return ok(res, await workflows.update(p1, body)), true
          }
          if (!p2 && req.method === 'DELETE') {
            await workflows.remove(p1)
            return ok(res, { removed: p1 }), true
          }
          if (p2 === 'run' && req.method === 'POST') {
            const body = await readBody(req)
            return ok(res, await workflowEngine.startRun(p1, body.input ?? '')), true
          }
          if (p2 === 'runs' && req.method === 'GET') {
            return ok(res, { items: await runs.list({ templateId: p1 }) }), true
          }
        }
      }

      fail(res, new Error(`未知资源: /prod/${resource}`), 404)
      return true
    } catch (err) {
      fail(res, err, 400)
      return true
    }
  }

  return { handle, workflowEngine }
}

module.exports = { createProductRouter }
