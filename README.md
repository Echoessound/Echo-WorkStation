# Echo WorkStation

基于 **DeepSeek Harness 引擎**的通用 AI 工作站桌面应用（Electron 壳 + 独立 Node 引擎进程）。

目标不是重写一个 agent 运行时，而是**复用 DeepSeek Harness 现成的 LLM 引擎、Agent 循环、结构化事件流、会话持久化与思维链能力**，在其上构建产品层：通用工作站（论文 / 代码 / 数据分析 / 文档 / 评审）、可视化 Workflow 编排、实时 CoT 报道与产物预览。

> 详细设计与改造方案见 [`echo-workstation-改造方案.md`](./echo-workstation-改造方案.md)。

## 当前状态（M0 已完成 ✅）

- ✅ Electron 壳：主进程 spawn DeepSeek Harness（`dsh --profile web`）子进程，loopback 随机端口，就绪探测，退出回收
- ✅ UI 代理层：静态 serve 自研渲染页 + `/api`（HTTP + WebSocket）同源代理，绕过 CORS 且通过 harness 信任围栏
- ✅ 试跑闭环：`session.create → session.prompt → CoT 实时流 → 工具调用 → 最终回复 → token 用量`
- ✅ 契约层 `echo-api.mjs`：harness 官方端点封装，供渲染层复用
- ✅ 轨迹工具 `fetch-trajectory.mjs`：会话历史翻页导出（Markdown / JSON，可选含思维链 `--thinking`）

## 架构

```
┌─ Electron 窗口 ─────────────────────────────────────────────┐
│  renderer/（自研 Echo 界面）                                  │
│    同源 fetch('/api/…') + WS('/api/events.mux')               │
└──────────────┬───────────────────────────────────────────────┘
               │  proxy-server.js（同源代理：静态 + HTTP/WS 转发）
┌──────────────┴───────────────────────────────────────────────┐
│ Electron Main：窗口 / 生命周期 / harness 子进程管理            │
└──────────────┬───────────────────────────────────────────────┘
               │  spawn（独立 Node 进程，避开 Electron ABI 问题）
┌──────────────┴───────────────────────────────────────────────┐
│ DeepSeek Harness 引擎（不改核心）                              │
│  agentLoop / llm / tools / sessionPersistence / sessionQuery  │
│  会话日志 jsonl.zstd（轨迹 + 思维链）                           │
└──────────────────────────────────────────────────────────────┘
```

## 快速开始

前置：Node.js ≥ 22（推荐 24）、本机有 DeepSeek Harness 仓库（`dsh` 构建产物 `apps/cli/lib/bin.js`）。

```powershell
# 1. 安装依赖（首次，下载 Electron 约 100MB）
cd echo-electron
npm install

# 2. 启动
npm start
```

窗口打开后输入提示词点「试跑」，即可看到 CoT 实时流与工具调用。

无 GPU / 受限沙箱环境（虚拟机、远程桌面）下 Electron 子进程会崩溃，已内置启动参数
`--disable-gpu --no-sandbox`（详见下文「踩坑记录」）。

### 独立验证（无需 Electron）

```powershell
cd echo-electron
node test-proxy.js    # 起隔离 harness → 验证静态页 / RPC / WebSocket 代理三关
```

### 终端试跑闭环

```bash
node echo-agent-demo.mjs "你的提示词"                 # 试跑 + 实时 CoT
node echo-agent-demo.mjs --artifact out.json "…以 JSON 输出…"   # 产物注册最小版
node fetch-trajectory.mjs <sessionId> --thinking     # 导出含思维链的轨迹
```

## 目录结构

| 路径 | 说明 |
|---|---|
| `echo-electron/` | Electron 应用（主进程 / 代理 / 渲染页 / 集成测试） |
| `echo-api.mjs` | harness 官方端点契约层 |
| `echo-agent-demo.mjs` | M0 试跑闭环（WS 实时流 + 产物注册） |
| `fetch-trajectory.mjs` | 会话轨迹导出工具 |
| `echo-workstation-改造方案.md` | 改造方案（角色反转：Harness 当引擎，Echo 当壳） |

## 里程碑

| 里程碑 | 状态 |
|---|---|
| M0 引擎对接（Electron 壳 + 代理 + 试跑闭环） | ✅ |
| M1 产品域（workspace/agent CRUD + SQLite + Chat 面板） | 计划中 |
| M2 Workflow 设计器 + DAG 调度 + 运行中心 | 计划中 |
| M3 产物管线 + 预览 + 论文工作流迁移 | 计划中 |
| M4 打包发布 | 计划中 |

## 踩坑记录（对后续开发有价值）

1. **信任围栏 Origin 归一化**：harness `/api` 要求 `Origin` 与 `Host` 端口精确一致；代理改写 `Host` 时必须同步改写 `Origin`，否则浏览器式请求 403。
2. **`/api/events.mux` 只走 WebSocket**：`GET` 被 client-connection 拦截返回 426（本部署）；实时事件流必须用 WS（下行单向，客户端发消息会被 1008 关闭）。
3. **分页语义随版本漂移**：`session.history` 在不同部署版本行为不同（有的一次返回整份日志）。消费端必须按 seq 去重 + 防御式翻页（`fetch-trajectory.mjs` 已验证）。
4. **无 GPU 环境**：GPU/渲染进程死于 `0xC0000135`（LPAC AppContainer 沙箱权限不全）→ `--disable-gpu --no-sandbox`。
5. **沙箱与 GCM**：受限执行环境会拦截 Git Credential Manager 的提示进程，推送 GitHub 时需在完整权限下执行一次。

## License

见 [LICENSE](https://github.com/Echoessound/Echo-WorkStation/blob/main/LICENSE)。
