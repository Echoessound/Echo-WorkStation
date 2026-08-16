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
const { createWorkspaceService, createAgentService, resolveDshHome, userPresetRoot } = require('./services.js')

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
 * @param {{ db: ProductDb }} deps openProductDb() 的返回值
 * @returns {(req, res) => Promise<boolean>} 处理 /prod/* 请求；返回是否已消费
 */
function createProductRouter({ db }) {
  const workspaces = createWorkspaceService(db)
  const agents = createAgentService(db)

  return async function handle(req, res) {
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

      fail(res, new Error(`未知资源: /prod/${resource}`), 404)
      return true
    } catch (err) {
      fail(res, err, 400)
      return true
    }
  }
}

module.exports = { createProductRouter }
