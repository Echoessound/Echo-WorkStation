import React, { useEffect, useMemo, useState, useCallback } from 'react'
import { product, sessions } from './api.js'
import Workspaces from './pages/Workspaces.jsx'
import Agents from './pages/Agents.jsx'
import Chat from './pages/Chat.jsx'

const TABS = [
  { id: 'workspaces', label: '工作区', component: Workspaces },
  { id: 'agents', label: 'Agents', component: Agents },
  { id: 'chat', label: 'Chat', component: Chat },
]

export default function App() {
  const [tab, setTab] = useState('chat')
  const [harnessStatus, setHarnessStatus] = useState('checking') // checking | ok | err
  const [health, setHealth] = useState(null)
  const [workspaces, setWorkspaces] = useState([])
  const [agents, setAgents] = useState([])
  const [toolsets, setToolsets] = useState([])
  const [error, setError] = useState('')
  const [reloadTick, setReloadTick] = useState(0)

  const reload = useCallback(() => setReloadTick((t) => t + 1), [])

  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const [healthVal, ws, ags, ts] = await Promise.all([
          product.health().catch(() => null),
          product.listWorkspaces(),
          product.listAgents(),
          product.toolsets(),
        ])
        if (!alive) return
        setHealth(healthVal)
        setWorkspaces(ws.items ?? [])
        setAgents(ags.items ?? [])
        setToolsets(ts ?? [])
        setError('')
      } catch (err) {
        if (alive) setError(`加载产品域失败：${err.message}`)
      }
    }
    load()
    return () => { alive = false }
  }, [reloadTick])

  // harness 就绪探测（每 5s 一次）
  useEffect(() => {
    let alive = true
    async function ping() {
      try {
        await sessions.list()
        if (alive) setHarnessStatus('ok')
      } catch {
        if (alive) setHarnessStatus('err')
      }
    }
    ping()
    const timer = setInterval(ping, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  const shared = useMemo(() => ({
    health, workspaces, agents, toolsets, error, reload,
  }), [health, workspaces, agents, toolsets, error, reload])

  const Page = TABS.find((t) => t.id === tab).component

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <header className="topbar">
        <div className="brand">Echo WorkStation<small>M1 · DeepSeek Harness 引擎</small></div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="status">
          <span className={`dot ${harnessStatus === 'ok' ? 'ok' : harnessStatus === 'err' ? 'err' : ''}`} />
          {harnessStatus === 'ok' ? '引擎已连接' : harnessStatus === 'err' ? '引擎离线' : '探测中…'}
          {health && <span className="mono" style={{ opacity: .7 }}>· {health.dshHome}</span>}
        </div>
      </header>
      <div className="layout">
        <Page {...shared} />
      </div>
    </div>
  )
}
