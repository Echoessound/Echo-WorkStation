/**
 * preload — 最小桥接层
 *
 * 现状：渲染页由 harness 自己的 web 服务器 serve，fetch/WebSocket 到 /api 是「同源」，
 * 不需要任何 IPC 桥接。这里暴露版本元信息与少量需要主进程能力的操作
 * （M2：系统目录选择对话框，运行中心「定位文件夹」用）。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('echo', {
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
  },
  /** 打开系统目录选择对话框 → 返回绝对路径（取消返回 null） */
  pickDirectory: () => ipcRenderer.invoke('echo:pick-directory'),
})
