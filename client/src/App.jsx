import { useState, useEffect, useRef, useCallback } from 'react'
import { sendQueryStream, ingestUrl, queryDocuments, querySources, fetchStats, fetchSuggestions } from './api.js'
import './App.css'
import MarkdownRenderer from './MarkdownRenderer'

function SourceAccordion({ sources }) {
  const [isOpen, setIsOpen] = useState(true)

  // console.log("[SourceAccordion] Rendering with sources:", sources)

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

function Message({ msg }) {
  const isUser = msg.role === 'user'
  const isStreaming = msg.role === 'assistant' && msg.streaming

  return (
    <div className={`msg ${isUser ? 'msg--user' : 'msg--ai'}`}>
      <div className="msg__avatar">{isUser ? 'U' : 'AI'}</div>
      <div className="msg__body">
        <div className={`msg__bubble ${isStreaming ? 'msg__bubble--streaming' : ''} ${msg.isError ? 'msg__bubble--error' : ''}`}>
          <MarkdownRenderer content={msg.content || ''} />
        </div>
        {!isUser && msg.sources?.length > 0 && (
          <SourceAccordion sources={msg.sources} />
        )}
      </div>
    </div>
  )
}

function PipelineStatus({ logs }) {
  const logRef = useRef(null)
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [logs])

  return (
    <div className="pipeline-status">
      <div className="pipeline-status__header">
        <span className="spinner spinner--small" />
        PIPELINE STATUS
      </div>
      <div className="pipeline-status__logs" ref={logRef}>
        {logs.map((log, i) => (
          <div key={i} className="pipeline-status__log-item">
            <span className="pipeline-status__prompt">{'>'}</span> {log}
          </div>
        ))}
      </div>
    </div>
  )
}

export default function App() {
  // chat state
  const [messages, setMessages] = useState([
    { id: 'welcome', role: 'assistant', content: '### Welcome to DOCGPT\nI am ready to analyze your sources. Scope your query below to begin.' }
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)

  // AI Suggestions
  const [aiSuggestionsEnabled, setAiSuggestionsEnabled] = useState(() => {
    const saved = localStorage.getItem('ai_suggestions_enabled')
    return saved !== null ? JSON.parse(saved) : true
  })
  const [suggestions, setSuggestions] = useState([])
  const [originalInput, setOriginalInput] = useState('')
  const [isFetchingSuggestions, setIsFetchingSuggestions] = useState(false)

  useEffect(() => {
    localStorage.setItem('ai_suggestions_enabled', JSON.stringify(aiSuggestionsEnabled))
  }, [aiSuggestionsEnabled])

  // Clear suggestions if user types something else
  useEffect(() => {
    if (originalInput && input !== originalInput && suggestions.length > 0) {
      setSuggestions([])
      setOriginalInput('')
    }
  }, [input, originalInput, suggestions.length])

  // source selection — null until sources are loaded, then defaults to React (or first source)
  const [sourceScope, setSourceScope] = useState(null) // source_id string
  const [docs, setDocs] = useState([])
  const [sources, setSources] = useState([])

  // embed panel
  const [embedUrl, setEmbedUrl] = useState('')
  const [embedStatus, setEmbedStatus] = useState(null) // null | 'loading' | 'ok' | 'error'
  const [embedMsg, setEmbedMsg] = useState('')
  const [ingestionLog, setIngestionLog] = useState([])

  // stats
  const [stats, setStats] = useState(null)

  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(280)
  const [isResizingLeft, setIsResizingLeft] = useState(false)

  const bottomRef = useRef(null)
  const inputRef = useRef(null)

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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // ── send query ──────────────────────────────────────────────────────────────
  const handleSend = useCallback(async (forcedQuery = null) => {
    // If called via onClick={handleSend}, forcedQuery will be the event object.
    // We only want to use it if it's explicitly passed as a string (e.g. from suggestions list).
    const queryToProcess = (typeof forcedQuery === 'string' ? forcedQuery : input).trim()
    if (!queryToProcess || loading) return

    // AI Suggestions flow
    const isForcedValue = typeof forcedQuery === 'string'
    if (aiSuggestionsEnabled && !isForcedValue && suggestions.length === 0) {
      setIsFetchingSuggestions(true)
      setOriginalInput(queryToProcess)
      try {
        const res = await fetchSuggestions(queryToProcess)
        if (res.suggestions?.length > 0) {
          setSuggestions(res.suggestions)
          return // Pause to show suggestions
        }
      } catch (err) {
        console.error("Suggestions failed:", err)
      } finally {
        setIsFetchingSuggestions(false)
      }
    }

    // Normal query flow
    setSuggestions([])
    const targetQuery = queryToProcess

    const userMsg = { id: Date.now(), role: 'user', content: targetQuery }
    const aiId = Date.now() + 1
    const aiMsg = { id: aiId, role: 'assistant', content: '', streaming: true, sources: [], isError: false }

    setMessages(prev => [...prev, userMsg, aiMsg])
    if (!isForcedValue) setInput('')
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
          setMessages(prev => prev.map(m => {
            if (m.id === aiId) {
              const isEmpty = !m.content || m.content.trim().length === 0
              return { 
                ...m, 
                content: isEmpty ? "It didn't work" : m.content, 
                streaming: false, 
                sources: sources ?? [],
                isError: isEmpty
              }
            }
            return m
          }))
          fetchStats().then(setStats).catch(() => { })
        },
      }

      await sendQueryStream(targetQuery, opts)
    } catch (err) {
      setMessages(prev => prev.map(m =>
        m.id === aiId
          ? { ...m, content: `It didn't work: ${err.message}`, streaming: false, isError: true }
          : m
      ))
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }, [input, loading, sourceScope, aiSuggestionsEnabled, suggestions])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleEmbed = async () => {
    const url = embedUrl.trim()
    if (!url) return
    try { new URL(url) } catch { setEmbedStatus('error'); setEmbedMsg('Invalid URL'); return }

    setEmbedStatus('loading')
    setEmbedMsg('Initializing...')
    setIngestionLog(['Starting ingestion pipeline...'])

    try {
      await ingestUrl(url, {
        onStatus: (status) => {
          setIngestionLog(prev => [...prev.slice(-99), status])
          setEmbedMsg(status)
        },
        onDone: (data) => {
          setEmbedStatus('ok')
          setEmbedMsg(data.message ?? 'Ingestion complete ✓')
          setEmbedUrl('')
          
          Promise.all([queryDocuments(), querySources(), fetchStats()])
          .then(([d, s, st]) => { 
            setDocs(d); 
            setSources(s); 
            setStats(st) 
          })
          .catch(() => { })
        }
      })
    } catch (err) {
      setEmbedStatus('error')
      setEmbedMsg(err.message)
    }

    setTimeout(() => {
      if (embedStatus !== 'loading') {
        setEmbedStatus(null)
      }
    }, 5000)
  }

  const hasScope = sources.length > 0
  const activeScopeName = sources.find(s => s.id === sourceScope)?.name ?? null

  return (
    <div className={`layout ${isResizingLeft ? 'layout--resizing' : ''}`}>
      <aside
        className={`sidebar sidebar--left ${sidebarOpen ? 'sidebar--open' : 'sidebar--closed'}`}
        style={{ width: sidebarOpen ? `${sidebarWidth}px` : undefined }}
      >
        <div className="sidebar__header">
          <div className="logo">
            <span className="logo__icon">{'>_'}</span>
            <span className="logo__text">DOCGPT <span className="logo__beta">BETA</span></span>
          </div>
        </div>

        {sidebarOpen && (
          <div className="sidebar__content">
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

              {embedStatus === 'loading' && (
                <PipelineStatus logs={ingestionLog} />
              )}

              {embedStatus && embedStatus !== 'loading' && (
                <div className={`toast toast--${embedStatus}`}>
                  {embedMsg}
                </div>
              )}
            </div>

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

      {sidebarOpen && (
        <div
          className={`resize-handle resize-handle--left ${isResizingLeft ? 'resize-handle--active' : ''}`}
          onMouseDown={startResizingLeft}
        />
      )}

      <main className="chat">
        <header className="chat__header">
          <div className="chat__title">
            <h1>Ask your docs</h1>
            {activeScopeName && (
              <span className="chat__scope-badge">
                {activeScopeName}
              </span>
            )}
          </div>

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

        {/* Toggle AI Suggestions */}
        <div style={{ padding: '0 32px 10px', display: 'flex', justifyContent: 'flex-end' }}>
          <div
            className={`ai-toggle ${aiSuggestionsEnabled ? 'ai-toggle--active' : ''}`}
            onClick={() => setAiSuggestionsEnabled(!aiSuggestionsEnabled)}
            title={aiSuggestionsEnabled ? "AI suggests better queries" : "AI suggestions disabled"}
          >
            <span className="ai-toggle__label">AI Suggestions</span>
            <div className="ai-toggle__switch">
              <div className="ai-toggle__knob" />
            </div>
          </div>
        </div>

        <div className="chat__messages" role="log" aria-live="polite">
          {messages.map(msg => <Message key={msg.id} msg={msg} />)}
          <div ref={bottomRef} />
        </div>

        {/* AI Suggestions Box */}
        {suggestions.length > 0 && (
          <div className="suggestions-box">
            <div className="suggestions-box__title">
              <span className="panel__icon">✨</span>
              Recommended Queries
            </div>
            <div className="suggestions-list">
              {suggestions.map((s, i) => (
                <button
                  key={i}
                  className="suggestion-btn"
                  onClick={() => handleSend(s)}
                >
                  {s}
                </button>
              ))}
              <button
                className="suggestion-btn suggestion-btn--original"
                onClick={() => handleSend(originalInput)}
              >
                Continue with "{originalInput}"
              </button>
            </div>
          </div>
        )}

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
            {loading || isFetchingSuggestions ? <span className="spinner" /> : (
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
