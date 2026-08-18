/**
 * product/db.js — Echo Workstation 产品域存储（M1）
 *
 * 轨迹数据留在 harness 会话日志（jsonl.zstd），本库只存产品域：
 * workspaces / agents / workflow_templates / workflow_nodes / workflow_edges
 * / runs / artifacts / llm_usage（M1 只实现 workspaces + agents 的服务层，
 * 其余表先建好，供 M2/M3 使用）。
 *
 * 引擎选择：sql.js（wasm SQLite，纯 JS，零原生编译）。
 *  - 规避 better-sqlite3 在 Electron ABI 下需要 rebuild 的问题（与 harness
 *    子进程同理：能不用原生模块就不用）
 *  - SQL 语法与原生 SQLite 一致，将来可无缝迁移到 node:sqlite / better-sqlite3
 *  - 产品域数据量小、写频率低，每次写后全量导出写盘完全够用
 *
 * 线程模型：Electron 主进程内同步使用（sql.js Database 是同步 API）。
 * 对外统一暴露异步方法，便于将来替换存储引擎。
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

let _init = null // 单例：initSqlJs 的 Promise

/** 惰性加载 sql.js（wasm 路径解析到 node_modules/sql.js/dist/） */
function initSqlJsOnce() {
  if (_init == null) {
    const initSqlJs = require('sql.js')
    // require.resolve('sql.js') 解析 main（./dist/sql-wasm.js）→ dist 目录，wasm 就在那里
    const distDir = path.dirname(require.resolve('sql.js'))
    _init = initSqlJs({ locateFile: (file) => path.join(distDir, file) }).then(
      (SQL) => SQL,
      (err) => {
        _init = null // 失败可重试
        throw err
      },
    )
  }
  return _init
}

/** 建表 SQL（幂等） */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  model_json    TEXT NOT NULL DEFAULT '{}',
  toolset       TEXT NOT NULL DEFAULT 'basic',
  workspace_id  TEXT,
  params_json   TEXT NOT NULL DEFAULT '{}',
  preset_id     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_templates (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  definition_json TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_nodes (
  id            TEXT PRIMARY KEY,
  template_id   TEXT NOT NULL,
  node_key      TEXT NOT NULL,
  agent_id      TEXT,
  params_json   TEXT NOT NULL DEFAULT '{}',
  position_json TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_edges (
  id           TEXT PRIMARY KEY,
  template_id  TEXT NOT NULL,
  source_node  TEXT NOT NULL,
  target_node  TEXT NOT NULL,
  condition_json TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  template_id  TEXT,
  agent_id     TEXT,
  workspace_id TEXT,
  session_id   TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  started_at   INTEGER,
  finished_at  INTEGER,
  input_json   TEXT,
  output_json  TEXT,
  error        TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id           TEXT PRIMARY KEY,
  run_id       TEXT,
  session_id   TEXT,
  node_key     TEXT,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  path         TEXT,
  content_json TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_usage (
  id              TEXT PRIMARY KEY,
  run_id          TEXT,
  session_id      TEXT,
  provider        TEXT,
  model           TEXT,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost            REAL NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_run_nodes (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  node_key    TEXT NOT NULL,
  agent_id    TEXT,
  session_id  TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  output_json TEXT,
  error       TEXT,
  started_at  INTEGER,
  finished_at INTEGER,
  created_at  INTEGER
);
`

/** 默认数据库文件位置（echo-electron/data/echo-product.db） */
function defaultDbPath() {
  return path.join(__dirname, '..', 'data', 'echo-product.db')
}

/**
 * 打开（或创建）产品域数据库。
 * @param {{ dbPath?: string }} opts 默认 data/echo-product.db
 * @returns {Promise<{ run, all, get, exec, persist, close }>}
 */
async function openProductDb({ dbPath = defaultDbPath() } = {}) {
  const SQL = await initSqlJsOnce()
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  const db = fs.existsSync(dbPath)
    ? new SQL.Database(fs.readFileSync(dbPath))
    : new SQL.Database()
  db.run(SCHEMA)
  // 兼容迁移：旧库的 artifacts 表缺 node_key 列（M3 新增），补上
  // （这里不能用下方自定义的 all wrapper，它定义在 openProductDb 后半段）
  {
    const stmt = db.prepare('PRAGMA table_info(artifacts)')
    const cols = []
    while (stmt.step()) cols.push(stmt.getAsObject())
    stmt.free()
    if (!cols.some((c) => c.name === 'node_key')) {
      db.run('ALTER TABLE artifacts ADD COLUMN node_key TEXT')
    }
  }
  let closed = false

  /** 数据库已关闭后的任何访问都会让 sql.js 报 out of memory；统一抛可识别错误 */
  function assertOpen() {
    if (closed) throw new Error('database closed')
  }

  /** 把内存库全量导出写盘（sql.js 是内存数据库，这是唯一的持久化手段） */
  function persist() {
    assertOpen()
    const data = db.export()
    fs.writeFileSync(dbPath, Buffer.from(data))
  }

  /** 执行一条语句（不返回行）；写后自动持久化 */
  function run(sql, params = []) {
    assertOpen()
    const stmt = db.prepare(sql)
    try {
      stmt.bind(params)
      while (stmt.step()) { /* 消费所有行，避免遗留未释放的 stmt */ }
    } finally {
      stmt.free()
    }
    persist()
  }

  /** 查询多行 → 对象数组（sql.js 列名转驼峰由调用方处理，这里原样返回小写列名） */
  function all(sql, params = []) {
    assertOpen()
    const stmt = db.prepare(sql)
    try {
      stmt.bind(params)
      const rows = []
      while (stmt.step()) rows.push(stmt.getAsObject())
      return rows
    } finally {
      stmt.free()
    }
  }

  /** 查询单行 → 对象或 undefined */
  function get(sql, params = []) {
    return all(sql, params)[0]
  }

  /** 事务内的写语句：不 persist（persist → export 会隐式结束事务，见 debug-exec 踩坑） */
  function rawRun(sql, params = []) {
    const stmt = db.prepare(sql)
    try {
      stmt.bind(params)
      while (stmt.step()) { /* 消费所有行 */ }
    } finally {
      stmt.free()
    }
  }

  /** 事务执行一组写操作，最后统一持久化一次（事务内禁止 persist） */
  function exec(fn) {
    db.run('BEGIN')
    try {
      fn({ run: rawRun, all, get })
      db.run('COMMIT')
    } catch (err) {
      try { db.run('ROLLBACK') } catch { /* 事务可能已结束 */ }
      throw err
    }
    persist()
  }

  return {
    run, all, get, exec,
    persist,
    close: () => {
      closed = true
      try { db.close() } catch { /* already closed */ }
    },
    dbPath,
  }
}

/** 生成产品域实体 id（随机 uuid，去掉连字符便于 URL 使用） */
function newId() {
  return crypto.randomUUID().replace(/-/g, '')
}

module.exports = { openProductDb, newId, SCHEMA }
