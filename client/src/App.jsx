import { useState, useEffect, useRef, useCallback } from 'react'
import { sendQueryStream, ingestUrl, queryDocuments, querySources, fetchStats } from './api.js'
import './App.css'
import MarkdownRenderer from './MarkdownRenderer'

// ── Accordion for Sources ────────────────────────────────────────────────────
function SourceAccordion({ sources }) {
  const [isOpen, setIsOpen] = useState(true) // Open by default for better visibility

  console.log("[SourceAccordion] Rendering with sources:", sources)

  if (!sources || sources.length === 0) return null

  return (
    <div className="source-accordion">
      <button
        className={`source-accordion__btn ${isOpen ? 'source-accordion__btn--open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
      >
        <span className="source-accordion__label">Sources ({sources.length})</span>
        <span className="source-accordion__icon">{isOpen ? '−' : '+'}</span>
      </button>

      {isOpen && (
        <div className="source-accordion__list">
          {sources.map((s, i) => {
            const url = typeof s === 'string' ? s : (s?.url || '')
            const rawTitle = typeof s === 'string' ? s : (s?.title || s?.url || 'Untitled Source')
            const title = rawTitle.length > 100 ? rawTitle.substring(0, 97) + '...' : rawTitle

            if (!url && !title) return null;

            return (
              <div key={i} className="source-accordion__item">
                <div className="source-accordion__item-header">
                  <span className="source-accordion__item-title">{title}</span>
                </div>
                <a href={url} target="_blank" rel="noopener noreferrer" className="source-accordion__item-link">
                  {url || 'View Source'}
                </a>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Message bubble component ─────────────────────────────────────────────────
function Message({ msg }) {
  const isUser = msg.role === 'user'
  const isStreaming = msg.role === 'assistant' && msg.streaming

  return (
    <div className={`msg ${isUser ? 'msg--user' : 'msg--ai'}`}>
      <div className="msg__avatar">{isUser ? 'U' : 'AI'}</div>
      <div className="msg__body">
        <div className={`msg__bubble ${isStreaming ? 'msg__bubble--streaming' : ''}`}>
          <MarkdownRenderer content={msg.content || ''} />
        </div>
        {!isUser && msg.sources?.length > 0 && (
          <SourceAccordion sources={msg.sources} />
        )}
      </div>
    </div>
  )
}

// ── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  // chat state
  const [messages, setMessages] = useState([
    { id: 'welcome', role: 'assistant', content: '### Welcome to DOCGPT\nI am ready to analyze your sources. Scope your query below to begin.' }
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)

  // source selection — null until sources are loaded, then defaults to React (or first source)
  const [sourceScope, setSourceScope] = useState(null) // source_id string
  const [docs, setDocs] = useState([])
  const [sources, setSources] = useState([])

  // embed panel
  const [embedUrl, setEmbedUrl] = useState('')
  const [embedStatus, setEmbedStatus] = useState(null) // null | 'loading' | 'ok' | 'error'
  const [embedMsg, setEmbedMsg] = useState('')

  // stats
  const [stats, setStats] = useState(null)

  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(280)
  const [isResizingLeft, setIsResizingLeft] = useState(false)

  const bottomRef = useRef(null)
  const inputRef = useRef(null)

  // ── resizing logic ──────────────────────────────────────────────────────────
  const startResizingLeft = useCallback((e) => {
    e.preventDefault()
    setIsResizingLeft(true)
  }, [])

  const stopResizing = useCallback(() => {
    setIsResizingLeft(false)
  }, [])

  const resize = useCallback((e) => {
    if (isResizingLeft) {
      const newWidth = e.clientX
      if (newWidth > 150 && newWidth < 500) setSidebarWidth(newWidth)
    }
  }, [isResizingLeft])

  useEffect(() => {
    if (isResizingLeft) {
      window.addEventListener('mousemove', resize)
      window.addEventListener('mouseup', stopResizing)
    } else {
      window.removeEventListener('mousemove', resize)
      window.removeEventListener('mouseup', stopResizing)
    }
    return () => {
      window.removeEventListener('mousemove', resize)
      window.removeEventListener('mouseup', stopResizing)
    }
  }, [isResizingLeft, resize, stopResizing])

  // ── load sources, docs, stats on mount ─────────────────────────────────────
  useEffect(() => {
    Promise.all([queryDocuments(), querySources(), fetchStats()])
      .then(([d, s, st]) => {
        setDocs(d)
        setSources(s)
        setStats(st)
        // Default to React source, or the first available source
        if (s.length > 0) {
          const reactSource = s.find(src => src.name?.toLowerCase() === 'react')
          setSourceScope((reactSource ?? s[0]).id)
        }
      })
      .catch(() => {/* server may not have data yet, ok */ })
  }, [])

  // ── auto-scroll to bottom ───────────────────────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // ── send query ──────────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    const q = input.trim()
    if (!q || loading) return

    const userMsg = { id: Date.now(), role: 'user', content: q }
    const aiId = Date.now() + 1
    const aiMsg = { id: aiId, role: 'assistant', content: '', streaming: true, sources: [] }

    setMessages(prev => [...prev, userMsg, aiMsg])
    setInput('')
    setLoading(true)

    try {
      const opts = {
        topK: 5,
        source_id: sourceScope ?? undefined,
        onToken: (token) => {
          setMessages(prev => prev.map(m =>
            m.id === aiId ? { ...m, content: m.content + token } : m
          ))
        },
        onDone: ({ sources }) => {
          setMessages(prev => prev.map(m =>
            m.id === aiId ? { ...m, streaming: false, sources: sources ?? [] } : m
          ))
          // refresh stats
          fetchStats().then(setStats).catch(() => { })
        },
      }

      await sendQueryStream(q, opts)
    } catch (err) {
      setMessages(prev => prev.map(m =>
        m.id === aiId
          ? { ...m, content: `⚠️ Error: ${err.message}`, streaming: false }
          : m
      ))
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }, [input, loading, sourceScope, sources])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // ── embed URL ───────────────────────────────────────────────────────────────
  const handleEmbed = async () => {
    const url = embedUrl.trim()
    if (!url) return
    try { new URL(url) } catch { setEmbedStatus('error'); setEmbedMsg('Invalid URL'); return }

    setEmbedStatus('loading')
    setEmbedMsg('Ingesting…')

    try {
      const data = await ingestUrl(url)
      setEmbedStatus('ok')
      setEmbedMsg(data.message ?? 'Ingestion started ✓')
      setEmbedUrl('')

      // Refresh docs list after a short delay (ingestion is async)
      setTimeout(() => {
        Promise.all([queryDocuments(), querySources()])
          .then(([d, s]) => { setDocs(d); setSources(s) })
          .catch(() => { })
      }, 3000)
    } catch (err) {
      setEmbedStatus('error')
      setEmbedMsg(err.message)
    }

    setTimeout(() => setEmbedStatus(null), 5000)
  }

  // ── dropdown options ────────────────────────────────────────────────────────
  const hasScope = sources.length > 0
  const activeScopeName = sources.find(s => s.id === sourceScope)?.name ?? null

  // ── render ──────────────────────────────────────────────────────────────────
  return (
    <div className={`layout ${isResizingLeft ? 'layout--resizing' : ''}`}>
      {/* ── Left Sidebar ── */}
      <aside
        className={`sidebar sidebar--left ${sidebarOpen ? 'sidebar--open' : 'sidebar--closed'}`}
        style={{ width: sidebarOpen ? `${sidebarWidth}px` : undefined }}
      >
        <div className="sidebar__header">
          <div className="logo">
            <span className="logo__icon">{'>_'}</span>
            <span className="logo__text">DOCGPT</span>
          </div>
        </div>

        {sidebarOpen && (
          <div className="sidebar__content">
            {/* Stats badge */}
            {stats && (
              <div className="stats-card">
                <div className="stats-card__item">
                  <span className="stats-card__val">{stats.documents}</span>
                  <span className="stats-card__label">Docs</span>
                </div>
                <div className="stats-card__divider" />
                <div className="stats-card__item">
                  <span className="stats-card__val">{stats.chunks}</span>
                  <span className="stats-card__label">Chunks</span>
                </div>
                <div className="stats-card__divider" />
                <div className="stats-card__item">
                  <span className="stats-card__val">{stats.sources}</span>
                  <span className="stats-card__label">Sources</span>
                </div>
              </div>
            )}

            {/* Ingestion Panel */}
            <div className="panel">
              <h2 className="panel__title">
                <span className="panel__icon">SOURCE</span>
                INGESTION
              </h2>
              <p className="panel__desc">Paste a URL to index.</p>

              <div className="embed-form">
                <input
                  id="embed-url-input"
                  className="input"
                  type="url"
                  placeholder="https://..."
                  value={embedUrl}
                  onChange={e => setEmbedUrl(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleEmbed()}
                />
                <button
                  id="embed-btn"
                  className={`btn btn--primary ${embedStatus === 'loading' ? 'btn--loading' : ''}`}
                  onClick={handleEmbed}
                  disabled={embedStatus === 'loading'}
                >
                  {embedStatus === 'loading' ? <span className="spinner" /> : 'Index'}
                </button>
              </div>

              {embedStatus && embedStatus !== 'loading' && (
                <div className={`toast toast--${embedStatus}`}>
                  {embedMsg}
                </div>
              )}
            </div>

            {/* Knowledge Panel (Moved from right) */}
            {sources.length > 0 && (
              <div className="panel panel--docs">
                <h2 className="panel__title">
                  <span className="panel__icon">📚</span>
                  KNOWLEDGE
                </h2>
                <ul className="doc-list">
                  {sources.map(s => (
                    <li
                      key={s.id}
                      className={`doc-list__item ${sourceScope === s.id ? 'doc-list__item--active' : ''}`}
                      onClick={() => setSourceScope(s.id)}
                    >
                      <span className="doc-list__dot" />
                      <span className="doc-list__title">{s.name || s.base_url}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </aside>

      {/* Left Resize Handle */}
      {sidebarOpen && (
        <div
          className={`resize-handle resize-handle--left ${isResizingLeft ? 'resize-handle--active' : ''}`}
          onMouseDown={startResizingLeft}
        />
      )}

      {/* ── Chat Panel ── */}
      <main className="chat">
        {/* Chat header */}
        <header className="chat__header">
          <div className="chat__title">
            <h1>Ask your docs</h1>
            {activeScopeName && (
              <span className="chat__scope-badge">
                {activeScopeName}
              </span>
            )}
          </div>

          {/* Source scope dropdown — fetched from /sources, no "All" option */}
          {sources.length > 0 && (
            <div className="scope-select-wrap">
              <label htmlFor="source-scope" className="scope-select-wrap__label">Source</label>
              <select
                id="source-scope"
                className="select"
                value={sourceScope ?? ''}
                onChange={e => setSourceScope(e.target.value)}
              >
                {sources.map(s => (
                  <option key={s.id} value={s.id}>{s.name || s.base_url}</option>
                ))}
              </select>
            </div>
          )}
        </header>

        {/* Messages */}
        <div className="chat__messages" role="log" aria-live="polite">
          {messages.map(msg => <Message key={msg.id} msg={msg} />)}
          <div ref={bottomRef} />
        </div>

        {/* Input bar */}
        <div className="chat__inputbar">
          <textarea
            id="chat-input"
            ref={inputRef}
            className="chat__input"
            placeholder={hasScope || true ? 'Ask a question…' : 'Embed a document first, then ask…'}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <button
            id="chat-send-btn"
            className={`btn btn--send ${loading ? 'btn--loading' : ''}`}
            onClick={handleSend}
            disabled={loading || !input.trim()}
            aria-label="Send"
          >
            {loading ? <span className="spinner" /> : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="20" height="20">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            )}
          </button>
        </div>
      </main>
    </div>
  )
}
