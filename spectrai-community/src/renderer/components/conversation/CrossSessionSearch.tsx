/**
 * 跨会话搜索 & 内容引用面板
 *
 * 功能：
 * 1. 两种搜索模式：
 *    - 当前会话：只搜索当前会话消息（Ctrl/Cmd+F 触发）
 *    - 所有会话：跨会话搜索并引用（Ctrl/Cmd+Shift+F 触发）
 * 2. 关键词过滤（带高亮）
 * 3. 按会话筛选（所有会话模式下）
 * 4. 将搜索结果引用到当前对话（格式化为 [来自会话"xxx"] 引用块）
 * 5. 跳转到源会话
 * 6. 结果按时间降序排列
 *
 * @author weibin
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Search, X, ArrowRight, Copy, MessageSquare, Clock, ChevronDown, Layers, AlignLeft } from 'lucide-react'
import { useSessionStore } from '../../stores/sessionStore'
import type { ConversationMessage } from '../../../../shared/types'
import { isPrimaryModifierPressed, toPlatformShortcutLabel } from '../../utils/shortcut'

// ---- 工具函数 ----

/** 格式化时间戳为相对时间 */
function formatRelativeTime(isoString: string): string {
  if (!isoString) return ''
  const diff = Date.now() - new Date(isoString).getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (hours < 24) return `${hours} 小时前`
  if (days < 7) return `${days} 天前`
  return new Date(isoString).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

/** 截断文本，超长时在末尾加省略号 */
function truncate(text: string, maxLen = 200): string {
  if (!text) return ''
  const clean = text.replace(/\n+/g, ' ').trim()
  return clean.length > maxLen ? clean.slice(0, maxLen) + '...' : clean
}

/** 高亮匹配文本 */
function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <span>{text}</span>
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
  return (
    <span>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase()
          ? <mark key={i} className="bg-accent-yellow/30 text-text-primary rounded-sm px-0.5">{part}</mark>
          : <span key={i}>{part}</span>
      )}
    </span>
  )
}

// ---- 搜索结果类型 ----

interface SearchResultItem {
  sessionId: string
  sessionName: string
  sessionTimestamp: string
  message: ConversationMessage
  contextBefore?: ConversationMessage
  contextAfter?: ConversationMessage
}

/** 搜索模式 */
type SearchMode = 'cross' | 'current'

// ---- Props ----

interface CrossSessionSearchProps {
  /** 当前会话 ID（排除自身；current 模式下作为搜索目标） */
  currentSessionId: string
  /** 用户点击"引用"时的回调，参数为格式化好的引用文本 */
  onInsert: (text: string) => void
  /** 用户点击"跳转"时的回调 */
  onJumpToSession: (sessionId: string) => void
  /** 关闭面板 */
  onClose: () => void
  /** 初始模式：cross（所有会话）| current（当前会话），默认 cross */
  initialMode?: SearchMode
}

// ---- 主组件 ----

const CrossSessionSearch: React.FC<CrossSessionSearchProps> = ({
  currentSessionId,
  onInsert,
  onJumpToSession,
  onClose,
  initialMode = 'cross',
}) => {
  const [mode, setMode] = useState<SearchMode>(initialMode)
  const [query, setQuery] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState<string | 'all'>('all')
  const [showSessionFilter, setShowSessionFilter] = useState(false)
  const [loadedConversations, setLoadedConversations] = useState<Record<string, ConversationMessage[]>>({})
  const [loadingSessionIds, setLoadingSessionIds] = useState<Set<string>>(new Set())
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const filterRef = useRef<HTMLDivElement>(null)

  // 从 store 获取所有会话 + 对话历史
  const allSessions = useSessionStore(state => state.sessions)
  const storeConversations = useSessionStore(state => state.conversations)

  // 跨会话模式：排除当前会话，按时间降序
  const targetSessions = useMemo(() => {
    return allSessions
      .filter(s => s.id !== currentSessionId)
      .sort((a, b) => new Date(b.startedAt || 0).getTime() - new Date(a.startedAt || 0).getTime())
  }, [allSessions, currentSessionId])

  // 合并：store 中已有的 + 本地异步加载的对话
  const allConversations = useMemo(() => ({
    ...storeConversations,
    ...loadedConversations,
  }), [storeConversations, loadedConversations])

  // 当前会话模式：直接使用 store 中的对话
  const currentMessages = useMemo((): ConversationMessage[] => {
    const msgs = allConversations[currentSessionId] || []
    return msgs.filter(m =>
      (m.role === 'user' || m.role === 'assistant') && m.content
    )
  }, [allConversations, currentSessionId])

  // 自动聚焦搜索框
  useEffect(() => {
    searchInputRef.current?.focus()
  }, [])

  // 点击外部关闭会话筛选器
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setShowSessionFilter(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // ESC 关闭面板 / Ctrl/Cmd+F 切换到当前模式 / Ctrl/Cmd+Shift+F 切换到跨会话模式
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      } else if (isPrimaryModifierPressed(e) && e.shiftKey && e.key.toUpperCase() === 'F') {
        e.preventDefault()
        setMode('cross')
        requestAnimationFrame(() => searchInputRef.current?.focus())
      } else if (isPrimaryModifierPressed(e) && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setMode('current')
        requestAnimationFrame(() => searchInputRef.current?.focus())
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  /** 懒加载指定会话的对话历史 */
  const loadConversation = useCallback(async (sessionId: string) => {
    if (allConversations[sessionId] || loadingSessionIds.has(sessionId)) return
    setLoadingSessionIds(prev => new Set([...prev, sessionId]))
    try {
      const msgs = await window.spectrAI.session.getConversation(sessionId)
      if (msgs && msgs.length > 0) {
        setLoadedConversations(prev => ({ ...prev, [sessionId]: msgs }))
      }
    } catch (err) {
      console.warn('[CrossSessionSearch] 加载对话失败:', sessionId, err)
    } finally {
      setLoadingSessionIds(prev => {
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
    }
  }, [allConversations, loadingSessionIds])

  // 跨会话模式：预加载最近 5 个会话 / 按需全量加载
  useEffect(() => {
    if (mode !== 'cross') return
    if (selectedSessionId === 'all') {
      targetSessions.slice(0, 5).forEach(s => loadConversation(s.id))
    } else {
      loadConversation(selectedSessionId)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selectedSessionId])

  // 跨会话模式：搜索时全量加载
  useEffect(() => {
    if (!query.trim() || mode !== 'cross' || selectedSessionId !== 'all') return
    targetSessions.forEach(s => loadConversation(s.id))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, mode])

  /** 执行搜索，返回匹配的消息列表 */
  const searchResults = useMemo((): SearchResultItem[] => {
    const q = query.trim().toLowerCase()

    if (mode === 'current') {
      // 当前会话模式：只搜索当前会话
      const currentSession = allSessions.find(s => s.id === currentSessionId)
      const sessionName = currentSession?.name || `当前会话 #${currentSessionId.slice(0, 6)}`
      const sessionTimestamp = currentSession?.startedAt || ''

      return currentMessages
        .filter(m => !q || (m.content || '').toLowerCase().includes(q))
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, 100)
        .map((msg, i) => ({
          sessionId: currentSessionId,
          sessionName,
          sessionTimestamp,
          message: msg,
          contextBefore: i > 0 ? currentMessages[i - 1] : undefined,
          contextAfter: i < currentMessages.length - 1 ? currentMessages[i + 1] : undefined,
        }))
    }

    // 跨会话模式
    const results: SearchResultItem[] = []
    const sessionsToSearch = selectedSessionId === 'all'
      ? targetSessions
      : targetSessions.filter(s => s.id === selectedSessionId)

    for (const session of sessionsToSearch) {
      const messages = allConversations[session.id] || []
      if (messages.length === 0) continue

      const searchableMessages = messages.filter(m =>
        (m.role === 'user' || m.role === 'assistant') && m.content
      )

      for (let i = 0; i < searchableMessages.length; i++) {
        const msg = searchableMessages[i]
        const content = msg.content || ''
        if (!q || content.toLowerCase().includes(q)) {
          results.push({
            sessionId: session.id,
            sessionName: session.name || `会话 #${session.id.slice(0, 6)}`,
            sessionTimestamp: session.startedAt || msg.timestamp,
            message: msg,
            contextBefore: i > 0 ? searchableMessages[i - 1] : undefined,
            contextAfter: i < searchableMessages.length - 1 ? searchableMessages[i + 1] : undefined,
          })
        }
      }
    }

    return results
      .sort((a, b) => new Date(b.message.timestamp).getTime() - new Date(a.message.timestamp).getTime())
      .slice(0, 50)
  }, [mode, query, selectedSessionId, targetSessions, allConversations, currentMessages, currentSessionId, allSessions])

  const isAllLoaded = mode === 'current'
    ? true  // 当前模式不需要加载
    : selectedSessionId === 'all'
      ? targetSessions.slice(0, 5).every(s => allConversations[s.id])
      : !!allConversations[selectedSessionId]

  /** 构建引用文本 */
  const buildQuoteText = useCallback((item: SearchResultItem): string => {
    const role = item.message.role === 'user' ? '用户' : 'AI'
    const content = truncate(item.message.content || '', 500)
    if (mode === 'current') {
      return `> ${role}: ${content}\n`
    }
    return `[来自会话"${item.sessionName}"]\n> ${role}: ${content}\n`
  }, [mode])

  /** 引用消息到当前输入框 */
  const handleInsert = useCallback((item: SearchResultItem) => {
    onInsert(buildQuoteText(item))
    onClose()
  }, [onInsert, onClose, buildQuoteText])

  /** 复制消息内容 */
  const handleCopy = useCallback((item: SearchResultItem) => {
    navigator.clipboard.writeText(item.message.content || '')
    setCopiedId(item.message.id)
    setTimeout(() => setCopiedId(null), 2000)
  }, [])

  const selectedSession = targetSessions.find(s => s.id === selectedSessionId)

  const panelTitle = mode === 'current' ? '搜索当前会话' : '搜索其他会话内容'
  const placeholderText = mode === 'current' ? '搜索当前会话消息...' : '搜索对话内容...'

  return (
    /* 遮罩层 */
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      {/* 面板主体 */}
      <div
        className="relative w-full max-w-2xl mx-4 bg-bg-primary border border-border rounded-2xl shadow-2xl
          flex flex-col overflow-hidden"
        style={{ maxHeight: '75vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <MessageSquare size={16} className="text-accent-blue" />
            <span className="text-sm font-medium text-text-primary">{panelTitle}</span>
            {mode === 'cross' && targetSessions.length > 0 && (
              <span className="text-xs text-text-muted bg-bg-secondary px-1.5 py-0.5 rounded-full">
                {targetSessions.length} 个会话
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* 模式切换按钮组 */}
            <div className="flex items-center bg-bg-secondary border border-border rounded-lg p-0.5">
              <button
                onClick={() => setMode('current')}
                title={`搜索当前会话 (${toPlatformShortcutLabel('Ctrl+F')})`}
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors
                  ${mode === 'current'
                    ? 'bg-accent-blue text-white'
                    : 'text-text-muted hover:text-text-primary'}`}
              >
                <AlignLeft size={12} />
                <span>当前</span>
              </button>
              <button
                onClick={() => setMode('cross')}
                title={`搜索所有会话 (${toPlatformShortcutLabel('Ctrl+Shift+F')})`}
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors
                  ${mode === 'cross'
                    ? 'bg-accent-blue text-white'
                    : 'text-text-muted hover:text-text-primary'}`}
              >
                <Layers size={12} />
                <span>所有</span>
              </button>
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* 搜索条 + 会话筛选器（所有会话模式时显示筛选器） */}
        <div className="px-4 py-2.5 border-b border-border flex-shrink-0 flex items-center gap-2">
          {/* 搜索框 */}
          <div className="flex-1 flex items-center gap-2 bg-bg-secondary border border-border rounded-lg px-3 py-1.5">
            <Search size={14} className="text-text-muted flex-shrink-0" />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={placeholderText}
              className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
            />
            {query && (
              <button onClick={() => setQuery('')} className="text-text-muted hover:text-text-primary transition-colors">
                <X size={13} />
              </button>
            )}
          </div>

          {/* 会话筛选器（仅跨会话模式） */}
          {mode === 'cross' && (
            <div ref={filterRef} className="relative flex-shrink-0">
              <button
                onClick={() => setShowSessionFilter(v => !v)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-bg-secondary border border-border rounded-lg
                  text-xs text-text-primary hover:border-accent-blue/40 transition-colors whitespace-nowrap"
              >
                <span className="max-w-[120px] truncate">
                  {selectedSessionId === 'all' ? '所有会话' : (selectedSession?.name || '未知会话')}
                </span>
                <ChevronDown size={12} className={`text-text-muted transition-transform ${showSessionFilter ? 'rotate-180' : ''}`} />
              </button>

              {showSessionFilter && (
                <div className="absolute right-0 top-full mt-1 w-56 bg-bg-secondary border border-border rounded-lg shadow-lg z-10 overflow-hidden">
                  <div className="max-h-52 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                    <button
                      onClick={() => { setSelectedSessionId('all'); setShowSessionFilter(false) }}
                      className={`w-full text-left px-3 py-2 text-sm transition-colors
                        ${selectedSessionId === 'all' ? 'bg-accent-blue/10 text-accent-blue' : 'text-text-primary hover:bg-bg-hover'}`}
                    >
                      所有会话
                    </button>
                    {targetSessions.map(s => (
                      <button
                        key={s.id}
                        onClick={() => { setSelectedSessionId(s.id); setShowSessionFilter(false) }}
                        className={`w-full text-left px-3 py-2 text-sm transition-colors
                          ${selectedSessionId === s.id ? 'bg-accent-blue/10 text-accent-blue' : 'text-text-primary hover:bg-bg-hover'}`}
                      >
                        <div className="truncate">{s.name || `会话 #${s.id.slice(0, 6)}`}</div>
                        <div className="text-xs text-text-muted mt-0.5 flex items-center gap-1">
                          <Clock size={10} />
                          {formatRelativeTime(s.startedAt || '')}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* 结果区域 */}
        <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
          {mode === 'cross' && targetSessions.length === 0 ? (
            /* 没有其他会话 */
            <div className="flex flex-col items-center justify-center py-16 text-text-muted">
              <MessageSquare size={32} className="mb-3 opacity-30" />
              <p className="text-sm">暂无其他会话</p>
              <p className="text-xs mt-1 opacity-60">先创建或打开其他 AI 会话</p>
            </div>
          ) : mode === 'cross' && !isAllLoaded && searchResults.length === 0 ? (
            /* 加载中 */
            <div className="flex items-center justify-center py-16 text-text-muted gap-2">
              <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span className="text-sm">加载会话历史...</span>
            </div>
          ) : mode === 'current' && currentMessages.length === 0 ? (
            /* 当前会话无消息 */
            <div className="flex flex-col items-center justify-center py-16 text-text-muted">
              <AlignLeft size={32} className="mb-3 opacity-30" />
              <p className="text-sm">当前会话暂无消息记录</p>
            </div>
          ) : searchResults.length === 0 ? (
            /* 无搜索结果 */
            <div className="flex flex-col items-center justify-center py-16 text-text-muted">
              <Search size={32} className="mb-3 opacity-30" />
              <p className="text-sm">
                {query ? `未找到包含"${query}"的内容` : '暂无可搜索的对话记录'}
              </p>
              {query && (
                <button
                  onClick={() => setQuery('')}
                  className="mt-2 text-xs text-accent-blue hover:underline"
                >
                  清除搜索词查看所有内容
                </button>
              )}
            </div>
          ) : (
            /* 搜索结果列表 */
            <div className="p-3 space-y-2">
              {/* 结果数量提示 */}
              {query && (
                <p className="text-xs text-text-muted px-1">
                  找到 {searchResults.length} 条匹配结果
                  {searchResults.length >= 50 && mode === 'cross' ? '（只显示前 50 条）' : ''}
                </p>
              )}

              {searchResults.map((item) => (
                <SearchResultCard
                  key={`${item.sessionId}-${item.message.id}`}
                  item={item}
                  query={query}
                  mode={mode}
                  isCopied={copiedId === item.message.id}
                  onInsert={() => handleInsert(item)}
                  onCopy={() => handleCopy(item)}
                  onJump={mode === 'cross' ? () => { onJumpToSession(item.sessionId); onClose() } : undefined}
                />
              ))}
            </div>
          )}
        </div>

        {/* 底部提示 */}
        <div className="px-4 py-2 border-t border-border flex-shrink-0 flex items-center justify-between">
          <span className="text-xs text-text-muted">
            {mode === 'current' ? '搜索当前对话历史' : '点击"引用"将内容插入当前输入框'}
          </span>
          <div className="flex items-center gap-3 text-xs text-text-muted">
            <span>
              <kbd className="px-1 py-0.5 bg-bg-secondary border border-border rounded text-[10px] font-mono">{toPlatformShortcutLabel('Ctrl+F')}</kbd>
              {' '}当前
            </span>
            <span>
              <kbd className="px-1 py-0.5 bg-bg-secondary border border-border rounded text-[10px] font-mono">{toPlatformShortcutLabel('Ctrl+⇧+F')}</kbd>
              {' '}所有
            </span>
            <span>
              <kbd className="px-1 py-0.5 bg-bg-secondary border border-border rounded text-[10px] font-mono">ESC</kbd>
              {' '}关闭
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---- 搜索结果卡片子组件 ----

interface SearchResultCardProps {
  item: SearchResultItem
  query: string
  mode: SearchMode
  isCopied: boolean
  onInsert: () => void
  onCopy: () => void
  onJump?: () => void
}

const SearchResultCard: React.FC<SearchResultCardProps> = ({
  item,
  query,
  mode,
  isCopied,
  onInsert,
  onCopy,
  onJump,
}) => {
  const [expanded, setExpanded] = useState(false)
  const role = item.message.role === 'user' ? '用户' : 'AI'
  const roleColor = item.message.role === 'user' ? 'text-accent-blue' : 'text-accent-green'
  const content = item.message.content || ''
  const displayContent = expanded ? content : truncate(content, 200)
  const isLong = content.length > 200

  return (
    <div className="group bg-bg-secondary border border-border rounded-xl p-3 hover:border-border/80 transition-colors">
      {/* 顶部：会话名（跨会话模式）或角色时间（当前模式）*/}
      <div className="flex items-center justify-between mb-2">
        {mode === 'cross' ? (
          <div className="flex items-center gap-1.5 min-w-0">
            <MessageSquare size={12} className="text-accent-blue flex-shrink-0" />
            <span className="text-xs font-medium text-text-secondary truncate">
              {item.sessionName}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={`text-[11px] font-semibold ${roleColor}`}>{role}</span>
          </div>
        )}
        <div className="flex items-center gap-1 text-xs text-text-muted flex-shrink-0 ml-2">
          <Clock size={10} />
          <span>{formatRelativeTime(item.message.timestamp)}</span>
        </div>
      </div>

      {/* 消息内容 */}
      <div className="space-y-1">
        {/* 跨会话模式下补充显示角色标签 */}
        {mode === 'cross' && (
          <span className={`text-[11px] font-semibold ${roleColor}`}>{role}</span>
        )}

        {/* 消息文本（可展开） */}
        <p className="text-sm text-text-primary leading-relaxed whitespace-pre-wrap break-words">
          <HighlightedText text={displayContent} query={query} />
        </p>

        {/* 展开/收起按钮 */}
        {isLong && (
          <button
            onClick={() => setExpanded(v => !v)}
            className="text-xs text-accent-blue hover:underline mt-1"
          >
            {expanded ? '收起' : `展开全文（${content.length} 字）`}
          </button>
        )}
      </div>

      {/* 底部操作按钮（hover 显示） */}
      <div className="flex items-center gap-2 mt-2.5 pt-2 border-t border-border/50
        opacity-0 group-hover:opacity-100 transition-opacity">
        {/* 引用 */}
        <button
          onClick={onInsert}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium
            bg-accent-blue text-white hover:bg-accent-blue/80 transition-colors"
        >
          <ArrowRight size={12} />
          引用到对话
        </button>

        {/* 复制 */}
        <button
          onClick={onCopy}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs
            bg-bg-primary border border-border hover:border-border/80 text-text-secondary transition-colors"
        >
          <Copy size={12} />
          {isCopied ? '已复制' : '复制'}
        </button>

        {/* 跳转（仅跨会话模式） */}
        {onJump && (
          <button
            onClick={onJump}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs
              text-text-muted hover:text-text-primary transition-colors ml-auto"
            title="切换到该会话"
          >
            跳转会话
            <ArrowRight size={12} />
          </button>
        )}
      </div>
    </div>
  )
}

CrossSessionSearch.displayName = 'CrossSessionSearch'
export default CrossSessionSearch
