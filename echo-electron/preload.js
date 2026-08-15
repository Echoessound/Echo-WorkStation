/**
 * preload — 最小桥接层
 *
 * 现状：渲染页由 harness 自己的 web 服务器 serve，fetch/WebSocket 到 /api 是「同源」，
 * 不需要任何 IPC 桥接。这里只暴露版本元信息，作为将来 contextBridge 扩展的占位：
 * 后续若走 file:// + IPC bridge 路线（改造方案 Q5 的选项 b），再把 echo-api.mjs
 * 的调用经 ipcRenderer.invoke 转给主进程。
 */
const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('echo', {
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
  },
})
