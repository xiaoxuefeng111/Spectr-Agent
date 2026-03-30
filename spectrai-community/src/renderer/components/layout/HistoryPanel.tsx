/**
 * 历史会话面板 - 查看所有已完成/已终止会话
 * @author weibin
 */

import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Search, X, Clock, Play, Pencil, CheckCircle, XCircle, Sparkles } from 'lucide-react'
import { useSessionStore } from '../../stores/sessionStore'
import { useUIStore } from '../../stores/uiStore'
import type { SessionStatus } from '../../../shared/types'

/** 状态标签 */
const STATUS_LABELS: Record<string, string> = {
  completed: '已完成',
  terminated: '已终止'
}

/** 状态颜色 */
const STATUS_ICONS: Record<string, typeof CheckCircle> = {
  completed: CheckCircle,
  terminated: XCircle
}

export default function HistoryPanel() {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const { sessions, renameSession, aiRenameSession, openSessionForChat, resumeSession } = useSessionStore()
  const { toggleHistoryPanel } = useUIStore()

  // 右键菜单
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // 重命名状态
  const [aiRenamingId, setAiRenamingId] = useState<string | null>(null)
  const [aiRenameError, setAiRenameError] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  // 开始重命名
  const startRename = useCallback((sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId)
    if (session) {
      setEditName(session.name || session.config.name)
      setRenamingId(sessionId)
      setContextMenu(null)
    }
  }, [sessions])

  // 提交重命名
  const commitRename = useCallback(async () => {
    if (!renamingId) return
    const trimmed = editName.trim()
    const session = sessions.find((s) => s.id === renamingId)
    if (trimmed && session && trimmed !== (session.name || session.config.name)) {
      await renameSession(renamingId, trimmed)
    }
    setRenamingId(null)
  }, [renamingId, editName, sessions, renameSession])

  // 取消重命名
  const cancelRename = useCallback(() => {
    setRenamingId(null)
  }, [])

  // AI 重命名错误 toast 自动消失
  useEffect(() => {
    if (aiRenameError) {
      const timer = setTimeout(() => setAiRenameError(null), 4000)
      return () => clearTimeout(timer)
    }
  }, [aiRenameError])

  // 自动聚焦搜索框
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // ESC 关闭面板
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (renamingId) {
          cancelRename()
        } else if (contextMenu) {
          setContextMenu(null)
        } else {
          toggleHistoryPanel()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [toggleHistoryPanel, contextMenu, renamingId, cancelRename])

  // 点击外部关闭右键菜单
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    if (contextMenu) {
      window.addEventListener('mousedown', handleClick)
      return () => window.removeEventListener('mousedown', handleClick)
    }
  }, [contextMenu])

  // 筛选已完成/已终止会话，按时间倒序
  const historySessions = useMemo(() => {
    const finished = sessions.filter(
      (s) => s.status === 'completed' || s.status === 'terminated'
    )
    // 按 startedAt 倒序
    finished.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())

    // 搜索过滤
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      return finished.filter(
        (s) =>
          (s.name || s.config.name).toLowerCase().includes(q) ||
          s.config.workingDirectory.toLowerCase().includes(q)
      )
    }
    return finished
  }, [sessions, query])

  const handleContextMenu = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault()
    e.stopPropagation()
    const x = Math.min(e.clientX, window.innerWidth - 160)
    const y = Math.min(e.clientY, window.innerHeight - 80)
    setContextMenu({ x, y, sessionId })
  }

  const handleClick = (sessionId: string) => {
    void openSessionForChat(sessionId)
    toggleHistoryPanel()
  }

  const handleResume = async (sessionId: string) => {
    const result = await resumeSession(sessionId)
    if (result.success) {
      await openSessionForChat(result.sessionId || sessionId)
      toggleHistoryPanel()
    }
    setContextMenu(null)
  }

  // 重命名输入框聚焦
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingId])

  const formatTime = (ts: string) => {
    try {
      const d = new Date(ts)
      return d.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
    } catch {
      return ts
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) toggleHistoryPanel()
      }}
    >
      <div className="bg-bg-secondary rounded-lg shadow-2xl w-full max-w-2xl border border-border max-h-[65vh] flex flex-col">
        {/* 搜索输入区 */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <Search className="w-5 h-5 text-text-muted flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索历史会话..."
            className="flex-1 bg-transparent text-text-primary placeholder-text-muted text-sm focus:outline-none"
          />
          <button
            onClick={toggleHistoryPanel}
            className="p-1 rounded hover:bg-bg-hover btn-transition text-text-muted hover:text-text-primary flex-shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 会话列表 */}
        <div className="flex-1 overflow-y-auto">
          {historySessions.length === 0 ? (
            <div className="text-center py-8 text-text-muted text-sm">
              {query.trim() ? (
                <p>未找到匹配的历史会话</p>
              ) : (
                <p>暂无历史会话</p>
              )}
            </div>
          ) : (
            <div className="py-1">
              <div className="px-4 py-1.5 text-xs text-text-muted">
                共 {historySessions.length} 条历史会话
              </div>
              {historySessions.map((session) => {
                const StatusIcon = STATUS_ICONS[session.status] || CheckCircle
                const statusLabel = STATUS_LABELS[session.status] || session.status
                const isCompleted = session.status === 'completed'

                return (
                  <button
                    key={session.id}
                    onClick={() => handleClick(session.id)}
                    onContextMenu={(e) => handleContextMenu(e, session.id)}
                    className="w-full text-left px-4 py-2.5 hover:bg-bg-hover btn-transition border-b border-border/50 last:border-0"
                  >
                    <div className="flex items-center justify-between mb-0.5">
                      {renamingId === session.id ? (
                        <input
                          ref={renameInputRef}
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                            if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
                            e.stopPropagation()
                          }}
                          onBlur={commitRename}
                          onClick={(e) => e.stopPropagation()}
                          className="flex-1 text-xs font-medium text-text-primary bg-bg-tertiary border border-accent-blue rounded px-1.5 py-0.5 focus:outline-none mr-2"
                        />
                      ) : (
                        <span className={`text-xs font-medium truncate flex-1 ${aiRenamingId === session.id ? 'text-accent-purple animate-pulse' : 'text-text-primary'}`}>
                          {aiRenamingId === session.id ? 'AI 命名中...' : (session.name || session.config.name)}
                        </span>
                      )}
                      <div className="flex items-center gap-2 ml-2 flex-shrink-0">
                        {session.providerId && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] bg-accent-purple/15 text-accent-purple border border-accent-purple/20 leading-none">
                            {session.providerId === 'claude-code' ? 'Claude' :
                             session.providerId === 'codex' ? 'Codex' :
                             session.providerId === 'gemini-cli' ? 'Gemini' :
                             session.providerId.slice(0, 6)}
                          </span>
                        )}
                        <span className="text-[10px] text-text-muted flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatTime(session.startedAt)}
                        </span>
                        <div className="flex items-center gap-1">
                          <StatusIcon
                            className={`w-3 h-3 ${isCompleted ? 'text-accent-green' : 'text-text-muted'}`}
                          />
                          <span
                            className={`text-[10px] ${isCompleted ? 'text-accent-green' : 'text-text-muted'}`}
                          >
                            {statusLabel}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="text-[11px] text-text-muted truncate">
                      {session.config.workingDirectory}
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
          <span>右键可重命名/继续任务</span>
        </div>
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-[60] bg-bg-secondary border border-border rounded-lg shadow-2xl py-1 min-w-[140px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => startRename(contextMenu.sessionId)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-hover btn-transition text-left"
          >
            <Pencil className="w-3.5 h-3.5 text-accent-blue" />
            重命名
          </button>
          <button
            disabled={aiRenamingId === contextMenu.sessionId}
            onClick={async () => {
              const sid = contextMenu.sessionId
              setContextMenu(null)
              setAiRenamingId(sid)
              const result = await aiRenameSession(sid)
              setAiRenamingId(null)
              if (!result.success) {
                setAiRenameError(result.error || 'AI 重命名失败')
              }
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-hover btn-transition text-left disabled:opacity-50"
          >
            <Sparkles className={`w-3.5 h-3.5 text-accent-purple ${aiRenamingId === contextMenu.sessionId ? 'animate-pulse' : ''}`} />
            {aiRenamingId === contextMenu.sessionId ? 'AI 命名中...' : 'AI 重命名'}
          </button>
          <button
            onClick={() => handleResume(contextMenu.sessionId)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text-primary hover:bg-bg-hover btn-transition text-left"
          >
            <Play className="w-3.5 h-3.5 text-accent-green" />
            继续任务
          </button>
        </div>
      )}

      {/* AI 重命名失败 Toast */}
      {aiRenameError && (
        <div className="fixed bottom-4 right-4 z-[100] max-w-sm px-4 py-3 rounded-lg shadow-lg border border-accent-purple/30 bg-bg-secondary text-text-primary text-xs animate-in slide-in-from-bottom-2">
          <div className="flex items-start gap-2">
            <Sparkles className="w-3.5 h-3.5 text-accent-purple shrink-0 mt-0.5" />
            <span className="text-accent-purple font-medium shrink-0">AI 重命名失败</span>
            <span className="text-text-secondary">{aiRenameError}</span>
            <button
              onClick={() => setAiRenameError(null)}
              className="ml-auto shrink-0 text-text-muted hover:text-text-primary"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
