/**
 * 全文搜索面板 - 搜索会话日志
 * @author weibin
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { Search, X, Clock, Terminal, ChevronRight } from 'lucide-react'
import { useSessionStore } from '../../stores/sessionStore'
import { useUIStore } from '../../stores/uiStore'

interface SearchResult {
  id: number
  sessionId: string
  sessionName: string
  timestamp: string
  chunk: string
  highlight: string
}

/** 去除 ANSI 转义序列 */
function stripAnsi(str: string): string {
  return str
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/\x1B[()][0-9A-Z]/g, '')
    .replace(/\x1B[=>NOM78HcDEFZ#]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
}

/** 高亮匹配文本 */
function highlightText(text: string, query: string): string {
  if (!query.trim()) return text
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(
    new RegExp(`(${escaped})`, 'gi'),
    '<<$1>>'
  )
}

export default function SearchPanel() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<NodeJS.Timeout | null>(null)

  const { selectSession } = useSessionStore()
  const { toggleSearchPanel } = useUIStore()

  // 自动聚焦搜索框
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // ESC 关闭面板
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') toggleSearchPanel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [toggleSearchPanel])

  const doSearch = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim()) {
      setResults([])
      setHasSearched(false)
      return
    }

    setSearching(true)
    try {
      const raw = await window.spectrAI.search.logs(searchQuery.trim(), undefined, 50)
      const mapped: SearchResult[] = raw.map((r: any) => ({
        id: r.id,
        sessionId: r.sessionId,
        sessionName: r.sessionName || '未知会话',
        timestamp: typeof r.timestamp === 'string' ? r.timestamp : new Date(r.timestamp).toISOString(),
        chunk: stripAnsi(r.chunk || ''),
        highlight: r.highlight ? stripAnsi(r.highlight) : ''
      }))
      setResults(mapped)
      setHasSearched(true)
    } catch (err) {
      console.error('[SearchPanel] Search failed:', err)
      setResults([])
    } finally {
      setSearching(false)
    }
  }, [])

  const handleInputChange = (value: string) => {
    setQuery(value)

    // 防抖搜索
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      doSearch(value)
    }, 300)
  }

  const handleResultClick = (result: SearchResult) => {
    selectSession(result.sessionId)
    toggleSearchPanel()
  }

  const formatTime = (ts: string) => {
    try {
      const d = new Date(ts)
      return d.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
    } catch {
      return ts
    }
  }

  /** 渲染带高亮标记的文本 */
  const renderHighlighted = (text: string) => {
    // 使用 << >> 标记作为高亮边界（FTS5 snippet 输出格式）
    const parts = text.split(/(<<.+?>>)/g)
    return parts.map((part, i) => {
      if (part.startsWith('<<') && part.endsWith('>>')) {
        return (
          <span key={i} className="bg-accent-yellow/30 text-accent-yellow font-medium">
            {part.slice(2, -2)}
          </span>
        )
      }
      return <span key={i}>{part}</span>
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) toggleSearchPanel() }}
    >
      <div className="bg-bg-secondary rounded-lg shadow-2xl w-full max-w-2xl border border-border max-h-[60vh] flex flex-col">
        {/* 搜索输入区 */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <Search className="w-5 h-5 text-text-muted flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleInputChange(e.target.value)}
            placeholder="搜索会话日志..."
            className="flex-1 bg-transparent text-text-primary placeholder-text-muted text-sm focus:outline-none"
          />
          {searching && (
            <div className="w-4 h-4 border-2 border-accent-blue border-t-transparent rounded-full animate-spin flex-shrink-0" />
          )}
          <button
            onClick={toggleSearchPanel}
            className="p-1 rounded hover:bg-bg-hover btn-transition text-text-muted hover:text-text-primary flex-shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 搜索结果 */}
        <div className="flex-1 overflow-y-auto">
          {!hasSearched && !searching && (
            <div className="text-center py-8 text-text-muted text-sm">
              <Search className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>输入关键词搜索所有会话的终端输出</p>
              <p className="text-xs mt-1 text-text-muted/60">支持中文和英文搜索</p>
            </div>
          )}

          {hasSearched && results.length === 0 && (
            <div className="text-center py-8 text-text-muted text-sm">
              <p>未找到匹配结果</p>
              <p className="text-xs mt-1">尝试使用不同的关键词</p>
            </div>
          )}

          {results.length > 0 && (
            <div className="py-1">
              <div className="px-4 py-1.5 text-xs text-text-muted">
                找到 {results.length} 条结果
              </div>
              {results.map((result) => {
                const displayText = result.highlight
                  ? result.highlight
                  : highlightText(result.chunk.slice(0, 200), query)

                return (
                  <button
                    key={`${result.id}-${result.sessionId}`}
                    onClick={() => handleResultClick(result)}
                    className="w-full text-left px-4 py-2.5 hover:bg-bg-hover btn-transition border-b border-border/50 last:border-0"
                  >
                    {/* 会话名和时间 */}
                    <div className="flex items-center gap-2 mb-1">
                      <Terminal className="w-3.5 h-3.5 text-accent-blue flex-shrink-0" />
                      <span className="text-xs font-medium text-accent-blue truncate">
                        {result.sessionName}
                      </span>
                      <ChevronRight className="w-3 h-3 text-text-muted flex-shrink-0" />
                      <span className="text-xs text-text-muted flex-shrink-0 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatTime(result.timestamp)}
                      </span>
                    </div>
                    {/* 匹配内容片段 */}
                    <div className="text-xs text-text-secondary leading-relaxed line-clamp-2 pl-5.5">
                      {renderHighlighted(displayText)}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* 底部提示 */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-border text-[11px] text-text-muted">
          <span>ESC 关闭</span>
          <span>Enter 搜索</span>
        </div>
      </div>
    </div>
  )
}
