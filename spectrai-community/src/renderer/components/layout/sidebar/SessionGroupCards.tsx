/**
 * SessionGroupCards — 时间分组卡片 + 目录/工作区分组卡片
 * @author weibin
 */
import React, { useState, useEffect } from 'react'
import { ChevronDown, FolderOpen, Layers } from 'lucide-react'
import { ACTIVE_STATUSES, EXECUTING_STATUSES, DONE_STATUSES } from './types'
import type { TimeGroupCardProps, DirGroupCardProps } from './types'
import { SessionItem, AgentSubList, WorktreeSubList } from './SessionItem'

/** 时间分组卡片 */
export const TimeGroupCard = React.memo(function TimeGroupCard({
  group, selectedSessionId, lastActivities, selectSession, handleContextMenu,
  resumeSession, renameSession, renamingSessionId, setRenamingSessionId,
  aiRenamingSessionId, providers, agents, onOpenWorktree,
}: TimeGroupCardProps) {
  const MAX_DEFAULT_VISIBLE = 5
  const [expanded, setExpanded] = useState(false)

  // 若选中的会话被"查看更多"遮住，自动展开
  useEffect(() => {
    if (!selectedSessionId) return
    const hiddenIdx = group.sessions.findIndex(s => s.id === selectedSessionId)
    if (hiddenIdx >= MAX_DEFAULT_VISIBLE) setExpanded(true)
  }, [selectedSessionId, group.sessions])

  const displaySessions = expanded ? group.sessions : group.sessions.slice(0, MAX_DEFAULT_VISIBLE)
  const hasMore = group.sessions.length > MAX_DEFAULT_VISIBLE

  return (
    <div className="card p-3">
      <div className="flex items-center gap-2 mb-2">
        <div className={`w-2 h-2 rounded-full ${group.color}`} />
        <h3 className="text-xs font-medium text-text-secondary">{group.title}</h3>
        <span className="text-xs text-text-muted ml-auto">{group.sessions.length}</span>
      </div>
      <div className="space-y-1">
        {displaySessions.map(session => (
          <div key={session.id} data-session-id={session.id}>
            <SessionItem
              session={session}
              isSelected={selectedSessionId === session.id}
              lastActivity={lastActivities[session.id]}
              onSelect={selectSession}
              onContextMenu={handleContextMenu}
              onResume={resumeSession}
              onRename={renameSession}
              showDir
              forceEditing={renamingSessionId === session.id}
              onEditingDone={() => setRenamingSessionId(null)}
              aiRenaming={aiRenamingSessionId === session.id}
              providers={providers}
            />
            <AgentSubList sessionId={session.id} agents={agents} selectSession={selectSession} />
            <WorktreeSubList session={session} onOpenWorktree={onOpenWorktree} />
          </div>
        ))}
      </div>
      {hasMore && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="w-full mt-2 py-1.5 flex items-center justify-center gap-1.5 text-[11px] text-text-muted hover:text-accent-blue hover:bg-bg-hover rounded btn-transition"
        >
          <ChevronDown className="w-3 h-3" />
          查看更多 ({group.sessions.length - MAX_DEFAULT_VISIBLE})
        </button>
      )}
    </div>
  )
})

/** 目录 / 工作区分组卡片（可折叠） */
export const DirGroupCard = React.memo(function DirGroupCard({
  group, selectedSessionId, onOpenPicker, onDirContextMenu, lastActivities,
  selectSession, handleContextMenu, resumeSession, renameSession,
  renamingSessionId, setRenamingSessionId, aiRenamingSessionId, providers, agents, onOpenWorktree,
}: DirGroupCardProps) {
  const runningCount = group.sessions.filter(s => EXECUTING_STATUSES.has(s.status)).length
  const hasRunning = runningCount > 0
  const hasSelected = group.sessions.some(s => s.id === selectedSessionId)

  // 活跃会话（非已完成/非异常）— 直接内联展示
  const activeSessions = group.sessions.filter(s => !DONE_STATUSES.has(s.status))
  const hasActive = activeSessions.length > 0

  const GroupIcon = group.type === 'workspace'
    ? <Layers className="w-3.5 h-3.5 text-accent-purple flex-shrink-0" />
    : group.type === 'unassigned'
      ? <FolderOpen className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
      : <FolderOpen className="w-3.5 h-3.5 text-accent-blue flex-shrink-0" />

  return (
    <div className={`rounded-lg border overflow-hidden ${hasSelected ? 'border-accent-blue/50' : 'border-border'}`}>
      {/* 分组 Header — 左键弹出会话选择器，右键弹出目录菜单 */}
      <button
        onClick={onOpenPicker}
        onContextMenu={(e) => onDirContextMenu(e, group.type === 'directory' ? group.key : '')}
        className="w-full flex items-center gap-1.5 px-2.5 py-2 bg-bg-hover hover:bg-bg-tertiary btn-transition text-left select-none"
      >
        <ChevronDown className={`w-3 h-3 text-text-muted flex-shrink-0 transition-transform ${hasActive ? 'rotate-0' : '-rotate-90'}`} />
        {GroupIcon}

        {/* 名称 + 副标题（完整路径） */}
        <div className="flex flex-col flex-1 min-w-0">
          <span
            className={`text-xs font-medium truncate leading-tight ${
              group.type === 'unassigned' ? 'text-text-muted' : 'text-text-primary'
            }`}
            title={group.subtitle}
          >
            {group.title}
          </span>
          {(group.type === 'workspace' || group.type === 'directory') && group.subtitle && (
            <span className="text-[10px] text-text-muted truncate leading-tight" title={group.subtitle}>
              {group.subtitle}
            </span>
          )}
        </div>

        {/* 统计 + 当前选中标记 */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {hasRunning && (
            <span className="flex items-center gap-0.5 text-[10px] text-accent-green font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse" />
              {runningCount}
            </span>
          )}
          {hasSelected && (
            <span className="text-[10px] text-accent-blue font-medium">●</span>
          )}
          <span className="text-[10px] text-text-muted">{group.sessions.length}</span>
        </div>
      </button>

      {/* 活跃会话直接内联展示 */}
      {hasActive && (
        <div className="px-2 pb-2 pt-1.5 space-y-1 border-t border-border/50">
          {activeSessions.map(session => (
            <div key={session.id} data-session-id={session.id}>
              <SessionItem
                session={session}
                isSelected={session.id === selectedSessionId}
                lastActivity={lastActivities[session.id]}
                onSelect={selectSession}
                onContextMenu={handleContextMenu}
                onResume={resumeSession}
                onRename={renameSession}
                forceEditing={session.id === renamingSessionId}
                onEditingDone={() => setRenamingSessionId(null)}
                aiRenaming={session.id === aiRenamingSessionId}
                providers={providers}
              />
              <AgentSubList sessionId={session.id} agents={agents} selectSession={selectSession} />
              <WorktreeSubList session={session} onOpenWorktree={onOpenWorktree} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
})
