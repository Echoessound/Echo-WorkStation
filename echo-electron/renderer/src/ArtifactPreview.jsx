import React from 'react'

/**
 * ArtifactPreview — 产物预览渲染器（M3）
 * 按 kind 渲染：markdown / json / code / table。
 * 不引入重型解析库，自实现轻量渲染（标题/列表/粗体/代码/表格/分隔线/链接）。
 */

/* ── 简单 markdown 块级渲染 ─────────────────────────────── */

function renderInline(text) {
  // 转义 HTML
  let out = String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // 行内代码
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  // 粗体 **x** / 斜体 *x*
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  // 链接 [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
  return out
}

function parseTable(lines) {
  // | a | b |\n |---|---| \n | 1 | 2 |
  const rows = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!/^\|/.test(line) || !/\|$/.test(line)) continue
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (i + 1 < lines.length && /^\|[\s\-:|]+\|$/.test(lines[i + 1].trim())) {
      i += 1 // 跳过分隔行
    }
    rows.push(cells)
  }
  if (rows.length === 0) return null
  return rows
}

function renderMarkdown(text) {
  const lines = String(text ?? '').split('\n')
  const elements = []
  let listType = null
  let codeBuf = null
  let codeLang = ''
  let tableBuf = null

  const flushCode = () => {
    if (codeBuf !== null) {
      elements.push(<pre key={`c${elements.length}`} className="md-code"><code>{codeBuf.join('\n')}</code></pre>)
      codeBuf = null
    }
  }
  const flushTable = () => {
    if (tableBuf) {
      const rows = parseTable(tableBuf)
      if (rows && rows.length > 0) {
        elements.push(
          <table key={`t${elements.length}`} className="md-table">
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => (ri === 0
                  ? <th key={ci}>{renderInline(c)}</th>
                  : <td key={ci}>{renderInline(c)}</td>))}</tr>
              ))}
            </tbody>
          </table>,
        )
      }
      tableBuf = null
    }
  }
  const closeList = () => { if (listType) { listType = null } }

  for (const raw of lines) {
    // 代码块
    if (/^```/.test(raw)) {
      flushTable(); closeList()
      if (codeBuf === null) { flushCode(); codeBuf = []; codeLang = raw.slice(3).trim() }
      else flushCode()
      continue
    }
    if (codeBuf !== null) { codeBuf.push(raw); continue }

    // 表格块收集（连续 | 行）
    if (/^\s*\|/.test(raw)) {
      closeList()
      tableBuf = tableBuf ? [...tableBuf, raw] : [raw]
      continue
    }
    flushTable()

    const t = raw.trim()

    // 标题
    const h = t.match(/^(#{1,3})\s+(.*)$/)
    if (h) {
      closeList()
      const lv = h[1].length
      const Tag = `h${lv + 2}`
      elements.push(<Tag key={elements.length} className="md-h"><span dangerouslySetInnerHTML={{ __html: renderInline(h[2]) }} /></Tag>)
      continue
    }
    // 分隔线
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      closeList()
      elements.push(<hr key={elements.length} className="md-hr" />)
      continue
    }
    // 无序列表
    const li = t.match(/^[-*]\s+(.*)$/)
    if (li) {
      if (listType !== 'ul') { closeList(); elements.push(<ul key={elements.length} className="md-ul" />); listType = 'ul' }
      const ul = elements[elements.length - 1]
      ul.props.children = [...(ul.props.children ?? []), <li key={ul.props.children?.length ?? 0}><span dangerouslySetInnerHTML={{ __html: renderInline(li[1]) }} /></li>]
      continue
    }
    // 有序列表
    const oli = t.match(/^\d+\.\s+(.*)$/)
    if (oli) {
      if (listType !== 'ol') { closeList(); elements.push(<ol key={elements.length} className="md-ol" />); listType = 'ol' }
      const ol = elements[elements.length - 1]
      ol.props.children = [...(ol.props.children ?? []), <li key={ol.props.children?.length ?? 0}><span dangerouslySetInnerHTML={{ __html: renderInline(oli[1]) }} /></li>]
      continue
    }
    // 引用
    const q = t.match(/^>\s?(.*)$/)
    if (q) {
      closeList()
      elements.push(<blockquote key={elements.length} className="md-q"><span dangerouslySetInnerHTML={{ __html: renderInline(q[1]) }} /></blockquote>)
      continue
    }
    // 空行 & 段落
    if (t === '') { closeList(); continue }
    closeList()
    elements.push(<p key={elements.length} className="md-p"><span dangerouslySetInnerHTML={{ __html: renderInline(t) }} /></p>)
  }
  flushCode()
  flushTable()
  return elements.length ? elements : <div className="empty">（空）</div>
}

/* ── JSON 高亮 ─────────────────────────────────────────── */

function highlightJson(text) {
  const escaped = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return escaped.replace(
    /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?/g,
    (m, str, colon, kw, num) => {
      if (str) return `<span class="jq-key">${str}</span>${colon ? '<span class="jq-colon">:</span>' : ''}`
      if (kw) return `<span class="jq-kw">${kw}</span>`
      return `<span class="jq-num">${m}</span>`
    },
  )
}

/* ── 主组件 ────────────────────────────────────────────── */

export default function ArtifactPreview({ artifact }) {
  if (!artifact) return <div className="empty">（无）</div>
  const { kind, content } = artifact
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? '', null, 2)

  if (kind === 'markdown') {
    return <div className="md-body">{renderMarkdown(text)}</div>
  }
  if (kind === 'json') {
    let pretty = ''
    try { pretty = JSON.stringify(JSON.parse(text), null, 2) } catch { pretty = text }
    return <pre className="arf-json"><span dangerouslySetInnerHTML={{ __html: highlightJson(pretty) }} /></pre>
  }
  if (kind === 'table') {
    const table = parseTable(text.split('\n'))
    if (!table) return <pre className="arf-code">{text}</pre>
    return (
      <table className="md-table">
        <tbody>
          {table.map((r, ri) => (
            <tr key={ri}>{r.map((c, ci) => (ri === 0 ? <th key={ci}>{c}</th> : <td key={ci}>{c}</td>))}</tr>
          ))}
        </tbody>
      </table>
    )
  }
  // code 及其他
  return <pre className="arf-code">{text}</pre>
}
