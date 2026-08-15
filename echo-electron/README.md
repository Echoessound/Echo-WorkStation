# Echo Workstation M0 — Electron 壳（最小骨架）

Electron 壳 + **DeepSeek Harness 引擎（独立 Node 子进程）**，通过 loopback `/api` + WebSocket 对接。
这是《echo-workstation-改造方案.md》里 M0 里程碑的最小实现：把 `echo-agent-demo.mjs` 验证过的闭环搬进窗口。

## 运行

```powershell
cd F:\gaotushixi\echo-electron
npm install      # 下载 Electron（约 100MB，一次）
npm start
```

首次运行会：挑空闲端口 → 以 `node …\apps\cli\lib\bin.js --profile web --port <端口>` 启动 harness → 轮询就绪 → 打开窗口。
窗口内可直接「试跑」：实时显示 CoT / 正文 / 工具调用（与 `echo-agent-demo.mjs` 同款渲染逻辑）。

## 结构

| 文件 | 职责 |
|---|---|
| `main.js` | 空闲端口、spawn harness 子进程、就绪探测、UI 代理、窗口、退出回收 |
| `proxy-server.js` | 静态 serve `renderer/` + `/api`（HTTP + WebSocket 升级）同源代理到 harness |
| `preload.js` | contextBridge 占位（当前同源 fetch 不需要 IPC 桥） |
| `renderer/index.html` | Echo 界面：列出会话 / 试跑（CoT 实时流）/ 停止 |
| `test-proxy.js` | 无 Electron 集成测试（起隔离 harness → 验证静态页/RPC/WS 代理） |

## 运行架构（M0.5）

```
Electron 窗口  ──load──►  http://127.0.0.1:<uiPort>   （proxy-server：serve renderer/）
        renderer 的 fetch('/api/…') 与 WS('/api/events.mux')
                └──同源代理──►  http://127.0.0.1:<harnessPort>  （dsh web 子进程）
```

渲染页与 /api 同源，绕开 CORS；代理保留 `Host: 127.0.0.1:<harness端口>`，天然通过 harness 信任围栏。

## 验证

```powershell
node test-proxy.js     # 无需 Electron：静态页 / RPC / WS 三关集成测试
```

## 已固化的关键决策（对应改造方案 Q1/Q5）

- **子进程模式**（Q1=a）：harness 以普通 Node 运行，`koffi`/`node-pty` 保持 Node ABI，无需为 Electron rebuild
- **loopback HTTP**（Q5=a）：渲染页由 harness 自己 serve → `/api` 是同源调用，信任围栏放行，零改动
- **隔离工作区**：子进程 cwd 是 `echo-electron` 自身目录 → 与用户正在跑的 GUI（工作区 `F:\gaotushixi`）存储隔离

## 已知限制（M0 范围外）

- 退出用 `child.kill()`；harness 若派生子进程需换 `taskkill /T /F` 整树回收
- 依赖本机 `node` 在 PATH、仓库固定在 `F:\deepseek harness\deepseek-harness`（与 dsh.cmd shim 同一前提）
- 发布版应打包 dsh 及其 bundle（profile 解析依赖安装目录），而不是指向开发仓库
- 渲染层尚未引入 `echo-api.mjs`（下一步：把契约层搬进 renderer，去掉内联 rpc）
