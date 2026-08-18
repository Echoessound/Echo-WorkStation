# 基于 DeepSeek Harness 的 Echo Workstation 改造方案

> 本方案回应《Echo Workstation 软件开发规划》。核心结论：**角色反转**——
> DeepSeek Harness 本身就是你规划里要花 13-14 周自建的"内置 LLM 引擎 + 结构化事件流"运行时。
> 正确策略不是"用 DeepSeek API 自建引擎"，而是"**复用 Harness 引擎 + 新建产品层**"。

---

## 0. 前提修正（最重要的部分）

原方案 §0 假设："直接使用 DeepSeek API 自建 agent 运行时"。这是对 Harness 的误解——
以下能力**均已存在且在本会话中实测验证**：

| 你计划自建的能力 | Harness 现状（实测/代码确认） |
|---|---|
| LLM Provider 层（OpenAI 兼容 + SSE 流式） | `ctx.llm` 服务 + `llm-deepseek` 适配器（`translate.ts` 已处理 `reasoning_content`） |
| Agent 执行循环（LLM→CoT→工具→结果） | `agentLoop` 服务：`create()` / `createAgent()` / `resume()`（持久化恢复） |
| 结构化事件流 | `SessionEvent`（turn/start、user/message、assistant/message、tool/call、tool/result、assistant/chunk…）持久化 + `/api/events.mux` 实时流 |
| CoT 实时报道 | reasoning 块原生存在——**实测导出过 66+ 条完整思维链**（`--thinking`） |
| 工具系统 | `tools` 服务，内置工具远超 8 个（文件/命令/grep/web/子代理/工作流脚本…） |
| 会话持久化/中断恢复 | `sessionPersistence`（jsonl.zstd 追加日志）+ `agentLoop.resume()` |
| 上下文管理 | `compaction`（摘要压缩）+ `toolResultPruner`（结果截断）+ `tokenMeter`（预算）三层已存在 |
| 外部程序接口 | `/api` RPC（session.list/history/prompt/cancel/models/export…）+ WebSocket 事件流 |
| CLI / 无头模式 | `dsh --profile headless`；本机已配好 `dsh` 命令（方案 A） |
| Electron 内嵌预留 | `webserver` 源码注释明确写了 "Electron loads dist over file:// and carries fetch over an IPC bridge" |

**结论：改造 = "复用引擎 + 新建产品层"，而不是"重写引擎"。**

---

## 1. 总体架构（替代原 §2）

```text
┌──────────────────────── Renderer (Echo UI, React) ────────────────────────┐
│ Workspace │ Workflow设计器 │ Agent管理 │ 运行中心(CoT/时间线/预览) │ Chat   │
└──────────────────────────────┬────────────────────────────────────────────┘
          preload: 封装 /api RPC(fetch) + /api/events.mux(WebSocket)
┌──────────────────────────────┼────────────────────────────────────────────┐
│                           Electron Main                                   │
│  ┌ 产品域服务（新建）──────────────────────────────────────────────┐      │
│  │ WorkspaceService / AgentService / WorkflowDAG引擎 /            │      │
│  │ ArtifactRegistry / ApprovalBridge / CostDashboard              │      │
│  └──────────────────────┬─────────────────────────────────────────┘      │
│  SQLite(产品域): workspaces/agents/workflows/runs/artifacts/llm_usage     │
│  进程管理: 启动 harness 子进程（loopback 随机端口，复用 dsh boot 逻辑）      │
└──────────────────────────────┬────────────────────────────────────────────┘
                      spawn 子进程 (Node，非 Electron ABI)
                ┌───────────────┴────────────────┐
                │   Harness 运行时（引擎，不改核心）   │
                │ agentLoop / llm / tools /        │
                │ sessionQuery / sessionPersistence│
                │ 会话日志 jsonl.zstd（轨迹+思维链）   │
                └────────────────────────────────┘
```

三个关键点：
1. **Harness 以独立 Node 子进程运行**（避开 koffi/node-pty 的 Electron ABI rebuild；此前分析已确认）
2. **轨迹数据留在 Harness 会话日志**，Echo SQLite 只存产品域（workspace/agent/workflow 定义、run 关联、用量缓存）——不复制消息/思维链，避免双写漂移
3. **Renderer 通过 loopback `/api` + WebSocket 对接**（信任围栏天然放行 127.0.0.1；后期可换 webserver 注释预留的 file:// + IPC bridge 路线）

---

## 2. 能力映射表（原计划 ↔ Harness 现状 ↔ 改造动作）

| 原方案章节 | Harness 现状 | 改造动作 |
|---|---|---|
| §3.1 接入协议/多端点 | `ctx.llm` 适配器注册制；providers 配置化 | **复用**。自定义端点 = 注册一个 OpenAI 兼容适配器 |
| §3.2 reasoning_content | `llm-deepseek` 已转成 `{type:'reasoning',text}` 块 | **复用**（实测：轨迹含完整思维链） |
| §3.3 重试/降级/用量 | `providerRetryPolicy`；`tokenMeter` 投影 | **复用** + Echo 侧做用量看板（读投影） |
| §4.1 Agent 实体 | `agentLoop.create(id, options, meta)`、`agentLoop.resume()` | Echo `agents` 表 → 映射为 `CreateAgentOptions`（systemPrompt/model/tools/params） |
| §4.2 执行循环 | `agentLoop` 已实现（循环/流式/工具/恢复） | **复用**，不写 AgentRunner |
| §4.3 内置 agent 库 | agent presets（可组合、可挂载） | 把 presets 展示为"内置 agent"；论文流程 = preset 组合 |
| §4.4 工具系统 | `tools` 服务（内置 + 注册制 + restrict/guard） | **复用**；自定义工具 = 注册进 preset 的工具集 |
| §5 Workflow DAG 引擎 | `workflowEngine` 是**脚本式**编排（JS 脚本 fan-out），非可视化 DAG | **Echo 自建 DAG 调度器**；节点执行 = `agentLoop.createAgent()` 一次会话；可用 harness `subagents` 做并行 |
| §6.1 统一事件契约 | `SessionEvent` + jsonl.zstd + mux 流（`session/event`、`session/projection` 帧） | **复用**。映射：turn/start→node.started 等由 Echo 调度层派生；harness 事件原样透传 |
| §6.2 CoT 实时报道 | reasoning 块随 assistant/message 事件流 | **复用**。`cotVisibility: hidden/live/summary` 变成 Echo 展示层过滤（数据都在，只是选择渲染粒度） |
| §6.3 输出契约→预览 | 无（`attachments` 仅管图片类附件） | **新建** ArtifactRegistry + 产物注册管线 + 预览面板 |
| §7 数据模型 | 会话轨迹=jsonl.zstd（不可、也不应复制到 SQLite） | 轨迹留在 harness；Echo SQLite 只建产品域 8 张表 |
| §8 IPC/preload | `/api` RPC 端点表 + `/api/events.mux` + `/api/session.export` | preload 封装 fetch/WS；`onEvent(filter)` = mux 帧按 kind 过滤 |
| §9 前端 UI | `ui-trajectory`（时间线/工具卡/token/耗时）、`ui-conversation`（Chat/CoT 折叠）**已实现** | 全新 UI 可**借鉴/移植组件**（轨迹表、工具卡、CoT 折叠均已写好，含中文 locale） |
| §10 里程碑 | 引擎已就绪 | 从 13-14 周压缩到约 **8 周**（见 §5） |
| §11 风险 | 多数已有对策 | 见 §6 对照表 |

---

## 3. 改造工作清单

### A. 复用（不动 Harness 核心）
- `llm`（含 deepseek 适配器）、`agentLoop`、`tools`、`sessionPersistence`、`sessionQuery`、
  `sessionProjections`、`compaction`、`tokenMeter`、`subagents`、`webServer` + `/api` 全部端点、
  `credentials`（API key 存储）、`dsh` boot 逻辑。

### B. 新建（Echo 侧，产品层）
1. **Electron 外壳**：主进程生命周期、单实例、harness 子进程管理（随机 loopback 端口、崩溃重启、优雅关闭）
2. **产品域存储**（SQLite）：`workspaces / agents / workflow_templates / workflow_nodes / workflow_edges / runs / artifacts / llm_usage`
3. **产品域服务**：
   - `WorkspaceService`、`AgentService`（表单 → `CreateAgentOptions` 映射）
   - `WorkflowDAGEngine`：拓扑排序、并行分支、审批挂起、断点恢复（恢复 = `agentLoop.resume(sessionId)`，会话已在 harness 持久化）
   - `ArtifactRegistry`：输出契约 → 扫描/解析 → 注册 → `artifact.created` 事件
   - `ApprovalBridge`：Echo 审批 UI ↔ harness `approval` 服务（或工具审批策略）
   - `CostDashboard`：读 harness `tokenMeter` 投影 + 用量缓存
4. **preload 层**：封装 `/api` RPC 客户端 + mux WebSocket 订阅
5. **Echo UI**：Workspace 首页、Agent 管理（试跑区）、Workflow 设计器、运行中心三栏、Chat 面板、Git/设置页

### C. 少量修改（可选，Harness 侧配置级）
- 自定义 LLM 端点注册（设置项，不写代码）
- （后期可选）实现 webserver 注释预留的 `file:// + IPC bridge` 传输层，替代 loopback HTTP
- （可选）工具白名单/审批策略与 Echo 工作流审批点联动（配置级）

---

## 4. 关键决策点（需要拍板）

| # | 决策 | 选项 | 建议 |
|---|---|---|---|
| Q1 | Harness 部署形态 | a) 独立 Node 子进程  b) Electron 主进程内嵌 | **a**：避开 koffi/node-pty ABI rebuild，崩溃隔离 |
| Q2 | 前端策略 | a) 全新 React UI，只调 `/api`  b) fork Harness web UI | **a** 起步，移植 `ui-trajectory`/`ui-conversation` 的轨迹表、工具卡、CoT 折叠组件 |
| Q3 | Agent 定义落点 | a) Echo `agents` 表 → 运行时构造 `CreateAgentOptions`  b) 生成 cordis agent preset 文件 | **a**（灵活、可视化表单友好）；内置 agent 库用 b（preset 组合） |
| Q4 | DAG 调度 | a) Echo 自建调度器 + agentLoop 会话  b) 用 harness workflow 脚本工具 | **a**（可视化 DAG 是产品核心）；脚本式 workflow 可作为"高级模式"保留 |
| Q5 | Renderer 传输 | a) loopback HTTP `/api`  b) file:// + IPC bridge | **a** 起步（零改动）；产品化时评估 b |
| Q6 | 思维链策略 | 明文渲染 / 默认折叠 / 落盘开关 | 默认折叠 + 设置页全局开关（数据都在，只控制渲染） |

---

## 5. 里程碑重排（约 8 周，原 13-14 周）

| 里程碑 | 内容 | 验收标准 | 工期 |
|---|---|---|---|
| **M0 引擎对接** | Electron 壳 + harness 子进程 + 随机端口 + `/api` + mux 流打通；把 `fetch-trajectory.mjs` 的能力搬进窗口 | Electron 窗口里实时看到 CoT 流、工具调用、消息正文（即本会话已验证的数据流） | 1-2 周 | ✅ 已完成（echo-electron/：窗口跑通 harness GUI；M0.5 已加 UI 代理层 serve 自研页面，test-proxy.js 三关验证） |
| **M1 产品域 + Chat** | SQLite 8 表、Workspace/Agent CRUD、agent 试跑（= `session.prompt` + 事件订阅）、Chat 面板 | 在 UI 里新建 agent（系统提示词/模型/工具）→ 试跑 → 实时 CoT + 工具调用 + 结果 | 2 周 | ✅ 已完成（echo-electron/product/ + renderer/：sql.js 8 表、/prod/* CRUD、agent preset 生成注入 persona、React Chat 面板；test-m1.js 19 断言全过） |
| **M2 Workflow + 运行中心** | DAG 设计器（ReactFlow 已有基础）、DAG 调度器（并行/审批/恢复=agentLoop.resume）、三栏运行中心 | 多 agent 并行评审模板跑通，节点状态实时点亮 | 2-3 周 |
| **M3 产物管线 + 预览** | 输出契约、ArtifactRegistry、预览面板（md/代码/JSON/表格） | 自定义 agent+workflow 产出结构化 JSON 自动注册并在运行中心/产物库预览渲染 | 2 周 | ✅ 已完成（echo-electron/product/artifact-service.js + renderer/src/ArtifactPreview.jsx + 产物库页；test-m3.js 23 断言全过，含真实 LLM 自动产物注册） |
| **M4 打包发布** | `pnpm dist` 出包、崩溃恢复、用量页、文档 | 断网/限流/杀进程可恢复；安装包可分发 | 1-2 周 |

---

## 6. 风险对照（原 §11 逐条）

| 原风险 | 对策（改造后） |
|---|---|
| 1. CoT 模型依赖 | harness 已统一：chat 模型无 reasoning 块 → UI 自然降级（无需 agent 声明） |
| 2. SSE 解析健壮性 | **已解决**：llm 层自带流解析/组装（无需自建缓冲区解析器） |
| 3. 上下文爆炸 | **已解决**：compaction + toolResultPruner + tokenMeter 三层 |
| 4. 成本失控 | max_turns/预算已有；Echo 侧加成本预估看板（读 tokenMeter） |
| 5. 旧功能回归 | 论文工作流 = preset 组合，M3 为回归验收点（`QUALITY_BUDGETS` → agent 系统提示词约束） |
| 6. API key 安全 | `credentials` 服务已存；Echo 侧桥接 `safeStorage`，事件流 redact |
| 7.（新增）契约漂移 | **本会话实测**：线上 `session.history` 语义与仓库源码不一致 → Echo 侧封装层做防御式分页（`fetch-trajectory.mjs` 已验证的模式）+ 锁定 harness 版本 |
| 8.（新增）无鉴权 | `/api` 只有 DNS-rebinding 围栏 → 产品绑定 127.0.0.1，绝不绑 0.0.0.0 |
| 9.（新增）思维链明文 | 轨迹含完整思维链（实测）→ 默认折叠渲染 + 导出开关 + 分享前脱敏 |

---

## 7. 建议的下一步

1. **M0 原型**：我可以直接搭一个最小 Electron 骨架（主进程 spawn `dsh --profile headless`/web 无头版 + BrowserWindow 加载 loopback + preload 订阅 mux），作为改造的起点
2. **Agent 试跑 demo**：先做一个纯 Node 脚本验证 `session.prompt → 事件流 → 产物` 闭环（不依赖 UI），确认 CreateAgentOptions 的字段
3. **契约锁定**：把 Echo 依赖的 `/api` 端点列成兼容清单，封装成 `echo-api` 层（参考 `fetch-trajectory.mjs` 的防御式写法）

需要我先做哪一个？
