/**
 * SessionPickerModal — 目录/工作区分组 → 弹框选择会话
 * @author weibin
 */
import React, { useState, useEffect, useRef } from 'react'
import { Search, X, FolderOpen, Layers } from 'lucide-react'
import { ACTIVE_STATUSES } from './types'
import type { SessionPickerModalProps } from './types'
import { SessionItem, AgentSubList, WorktreeSubList } from './SessionItem'

export const SessionPickerModal = React.memo(function SessionPickerModal({
  group, onSelect, onClose, handleContextMenu, lastActivities,
  onOpenWorktree,
  renamingSessionId, setRenamingSessionId, renameSession,
  aiRenamingSessionId, providers, agents, resumeSession,
}: SessionPickerModalProps) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'done'>('all')
  const inputRef = useRef<HTMLInputElement>(null)

  // 自动聚焦搜索框
  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 50) }, [])

  // ESC 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const filtered = group.sessions.filter(s => {
    const nameMatch = !search || s.name.toLowerCase().includes(search.toLowerCase())
    const statusMatch =
      statusFilter === 'all' ||
      (statusFilter === 'active' && ACTIVE_STATUSES.has(s.status)) ||
      (statusFilter === 'done' && !ACTIVE_STATUSES.has(s.status))
    return nameMatch && statusMatch
  })

  const runningCount = group.sessions.filter(s => ACTIVE_STATUSES.has(s.status)).length

  const GroupIcon = group.type === 'workspace'
    ? <Layers className="w-4 h-4 text-accent-purple flex-shrink-0" />
    : <FolderOpen className="w-4 h-4 text-accent-blue flex-shrink-0" />

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-bg-secondary rounded-xl shadow-2xl border border-border w-full max-w-md max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          {GroupIcon}
          <div className="flex flex-col flex-1 min-w-0">
            <span className="text-sm font-semibold text-text-primary truncate">{group.title}</span>
            {group.subtitle && (
              <span className="text-[10px] text-text-muted truncate">{group.subtitle}</span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {runningCount > 0 && (
              <span className="flex items-center gap-1 text-[11px] text-accent-green font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse" />
                {runningCount} 运行中
              </span>
            )}
            <span className="text-[11px] text-text-muted">{group.sessions.length} 个会话</span>
            <button onClick={onClose} className="p-1 rounded hover:bg-bg-hover btn-transition text-text-muted hover:text-text-primary">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Search + filter */}
        <div className="px-3 py-2 border-b border-border space-y-2">
          <div className="flex items-center gap-2 px-2.5 py-1.5 bg-bg-primary rounded border border-border">
            <Search className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜索会话名称..."
              className="flex-1 bg-transparent text-xs text-text-primary placeholder-text-muted outline-none"
            />
            {search && (
              <button onClick={() => setSearch('')} className="text-text-muted hover:text-text-primary">
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          <div className="flex gap-1">
            {([['all', '全部'], ['active', '运行中'], ['done', '已完成']] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setStatusFilter(key)}
                className={`px-2.5 py-0.5 rounded text-[11px] btn-transition ${
                  statusFilter === key
                    ? 'bg-accent-blue/20 text-accent-blue font-medium'
                    : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {filtered.length === 0 ? (
            <div className="text-center text-text-muted text-xs py-8">
              {search ? `未找到匹配"${search}"的会话` : '暂无会话'}
            </div>
          ) : (
            filtered.map(session => (
              <div key={session.id} data-session-id={session.id}>
                <SessionItem
                  session={session}
                  isSelected={false}
                  lastActivity={lastActivities[session.id]}
                  onSelect={(id) => { onSelect(id); onClose() }}
                  onContextMenu={handleContextMenu}
                  onResume={resumeSession}
                  onRename={renameSession}
                  showDir={false}
                  forceEditing={renamingSessionId === session.id}
                  onEditingDone={() => setRenamingSessionId(null)}
                  aiRenaming={aiRenamingSessionId === session.id}
                  providers={providers}
                />
                <AgentSubList sessionId={session.id} agents={agents} selectSession={(id) => { onSelect(id); onClose() }} />
                <WorktreeSubList session={session} onOpenWorktree={onOpenWorktree} />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
})
