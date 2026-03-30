/**
 * SessionItem — 单个会话项组件（复用于状态分组和目录分组）
 * @author weibin
 */
import React, { useState, useEffect, useRef, useCallback } from 'react'
import { FolderOpen, AlertCircle, RotateCcw, GitBranch, ChevronDown, Cpu, X, FilePlus, FileEdit, FileX, Loader2 } from 'lucide-react'
import { useSessionStore } from '../../../stores/sessionStore'
import { STATUS_COLORS } from '../../../../shared/constants'
import { STATUS_LABELS, AGENT_STATUS_COLORS } from './types'
import type { SessionItemProps } from './types'
import { getShortPath, getProviderColor, getProviderLabel, getActivityPreview } from './utils'

/** 单个会话项 */
export const SessionItem = React.memo(function SessionItem({
  session, isSelected, lastActivity, onSelect, onContextMenu, onResume, onRename,
  showDir, forceEditing, onEditingDone, aiRenaming, providers,
}: SessionItemProps) {
  const stuckType = useSessionStore((s) => s.stuckSessions[session.id])
  const runningAgentCount = useSessionStore(s =>
    (s.agents[session.id] || []).filter((a: any) => a.status === 'running' || a.status === 'pending').length
  )
  const isInterrupted = session.status === 'interrupted'
  const needsAttention = session.status === 'waiting_input' || session.status === 'error'
  const isStuck = !!stuckType
  const statusLabel = STATUS_LABELS[session.status] || session.status
  const statusColor = STATUS_COLORS[session.status] || STATUS_COLORS.idle
  const dirPath = session.config.workingDirectory || ''
  // 分支信息：worktree session 直接用 config.worktreeBranch，普通 session 留空
  const branchName = session.config?.worktreeBranch || null

  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const startEditing = useCallback(() => {
    setEditName(session.name || session.config.name || '')
    setIsEditing(true)
  }, [session.name, session.config.name])

  const commitEdit = useCallback(async () => {
    const trimmed = editName.trim()
    if (trimmed && trimmed !== (session.name || session.config.name)) {
      await onRename(session.id, trimmed)
    }
    setIsEditing(false)
    onEditingDone?.()
  }, [editName, session.id, session.name, session.config.name, onRename, onEditingDone])

  const cancelEdit = useCallback(() => {
    setIsEditing(false)
    onEditingDone?.()
  }, [onEditingDone])

  useEffect(() => {
    if (forceEditing && !isEditing) startEditing()
  }, [forceEditing, isEditing, startEditing])

  useEffect(() => {
    if (isEditing) {
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 0)
    }
  }, [isEditing])

  return (
    <div
      onClick={() => onSelect(session.id)}
      onContextMenu={(e) => onContextMenu(e, session.id, session.status)}
      className={`relative overflow-hidden px-2.5 py-2 rounded cursor-pointer btn-transition border ${
        isSelected
          ? 'bg-accent-blue/10 border-accent-blue/80'
          : isStuck
            ? 'bg-bg-hover border-orange-500/30 hover:border-orange-500/50'
            : needsAttention
              ? 'bg-bg-hover border-accent-yellow/30 hover:border-accent-yellow/50'
              : 'bg-bg-hover border-transparent hover:bg-bg-tertiary'
      }`}
      style={isSelected ? { boxShadow: 'inset 0 0 0 1px rgba(88, 166, 255, 0.25), 0 4px 12px rgba(0, 0, 0, 0.18)' } : undefined}
    >
      {isSelected && <div className="absolute left-0 top-0 h-full w-1 rounded-l bg-accent-blue/90" />}
      <div className="flex items-center justify-between mb-0.5">
        {isEditing ? (
          <input
            ref={inputRef}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEdit()
              if (e.key === 'Escape') cancelEdit()
            }}
            onClick={(e) => e.stopPropagation()}
            className="text-xs font-medium text-text-primary bg-bg-primary border border-accent-blue rounded px-1 py-0.5 flex-1 focus:outline-none min-w-0"
          />
        ) : (
          <span
            className={`text-xs truncate flex-1 ${isSelected ? 'font-semibold' : 'font-medium'} ${aiRenaming ? 'text-accent-purple animate-pulse' : 'text-text-primary'}`}
            onDoubleClick={(e) => { e.stopPropagation(); startEditing() }}
            title="双击重命名"
          >
            {aiRenaming ? 'AI 命名中...' : (session.name || session.config.name)}
          </span>
        )}
        <div className="flex items-center gap-1 ml-2 flex-shrink-0">
          {runningAgentCount > 0 && (
            <span className="px-1 py-0.5 rounded text-[9px] font-medium bg-accent-green/15 text-accent-green leading-none flex-shrink-0">
              ↳{runningAgentCount}运行
            </span>
          )}
          {session.providerId && (() => {
            const color = getProviderColor(session.providerId)
            return (
              <span
                className="px-1 py-0.5 rounded text-[9px] leading-none"
                style={{
                  color,
                  backgroundColor: color + '26',
                  border: `1px solid ${color}40`
                }}
              >
                {getProviderLabel(session.providerId, providers)}
              </span>
            )
          })()}
          {isStuck && (
            <span className="px-1 py-0.5 rounded text-[9px] font-medium bg-orange-500/20 text-orange-400 animate-pulse leading-none">
              {stuckType === 'startup-stuck' ? '启动超时' : '卡住'}
            </span>
          )}
          {!isStuck && needsAttention && (
            <AlertCircle className="w-3 h-3 text-accent-yellow" />
          )}
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: isStuck ? '#f97316' : statusColor }}
          />
          <span className="text-[10px]" style={{ color: isStuck ? '#f97316' : statusColor }}>
            {statusLabel}
          </span>
        </div>
      </div>
      {showDir && dirPath && (
        <div className="flex items-center gap-1 mb-0.5" title={dirPath}>
          <FolderOpen className="w-3 h-3 text-text-muted flex-shrink-0" />
          <span className="text-[10px] text-text-muted truncate">{getShortPath(dirPath)}</span>
        </div>
      )}
      {branchName && (
        <div className="flex items-center gap-1 mb-0.5">
          <GitBranch className="w-3 h-3 text-text-muted flex-shrink-0" />
          <span className="text-[10px] text-text-muted truncate">{branchName}</span>
        </div>
      )}
      {isInterrupted ? (
        <div className="flex items-center justify-between mt-0.5">
          <span className="text-[11px] text-accent-yellow">上次中断</span>
          <button
            onClick={(e) => { e.stopPropagation(); onResume(session.id) }}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30 btn-transition"
          >
            <RotateCcw className="w-3 h-3" />
            恢复
          </button>
        </div>
      ) : (
        <div className={`text-[11px] truncate ${isSelected ? 'text-text-secondary' : 'text-text-muted'}`}>
          {lastActivity
            ? (getActivityPreview(lastActivity) || '等待活动...')
            : '等待活动...'}
        </div>
      )}
    </div>
  )
})

/** 子 Agent 折叠列表 */
export const AgentSubList = React.memo(function AgentSubList({ sessionId, agents, selectSession }: {
  sessionId: string
  agents: Record<string, any[]>
  selectSession: (id: string) => void
}) {
  // Bug 2 fix: 排除团队成员会话（name 含 [Team: 前缀），它们不应出现在普通 Agent 子列表中
  const sessionAgents = (agents[sessionId] || []).filter((a: any) => !a.name?.includes('[Team:'))
  if (sessionAgents.length === 0) return null

  const [expandOverride, setExpandOverride] = useState<boolean | null>(null)
  const hasRunning = sessionAgents.some((a: any) => a.status === 'running' || a.status === 'pending')
  const isExpanded = expandOverride !== null ? expandOverride : hasRunning

  return (
    <div className="ml-4">
      <button
        onClick={(e) => { e.stopPropagation(); setExpandOverride(!isExpanded) }}
        className="flex items-center gap-1 py-0.5 px-1 w-full text-[10px] text-text-muted hover:text-text-secondary btn-transition"
      >
        <ChevronDown className={`w-2.5 h-2.5 flex-shrink-0 transition-transform duration-150 ${isExpanded ? 'rotate-0' : '-rotate-90'}`} />
        <Cpu className="w-2.5 h-2.5 text-accent-purple flex-shrink-0" />
        <span>{sessionAgents.length} 个子任务</span>
        {sessionAgents.some((a: any) => a.status === 'running') && (
          <span className="w-1.5 h-1.5 rounded-full bg-accent-green ml-0.5 flex-shrink-0" />
        )}
      </button>
      {isExpanded && (
        <div className="pl-2 border-l border-border space-y-0.5 mt-0.5">
          {sessionAgents.map((agent: any) => (
            <div
              key={agent.agentId}
              className="group flex items-center gap-1.5 py-1 px-1.5 rounded hover:bg-bg-hover btn-transition cursor-pointer"
              onClick={() => selectSession(agent.childSessionId)}
            >
              <span className="text-[11px] text-text-secondary truncate flex-1">{agent.name}</span>
              <span
                className="text-[10px] font-medium flex-shrink-0"
                style={{ color: AGENT_STATUS_COLORS[agent.status] || '#8B949E' }}
              >
                {agent.status === 'running' ? '运行中' :
                 agent.status === 'completed' ? '完成' :
                 agent.status === 'failed' ? '失败' :
                 agent.status === 'cancelled' ? '已取消' : '等待中'}
              </span>
              {(agent.status === 'running' || agent.status === 'pending') && (
                <button
                  onClick={e => {
                    e.stopPropagation()
                    ;(window as any).spectrAI.agent.cancel(agent.agentId)
                  }}
                  title="强制关闭 Agent"
                  className="w-4 h-4 flex items-center justify-center rounded text-text-muted hover:text-accent-red hover:bg-accent-red/10 btn-transition flex-shrink-0 opacity-0 group-hover:opacity-100"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
})

/** 文件状态图标映射 */
const FILE_STATUS_CONFIG: Record<string, { Icon: any; color: string; label: string }> = {
  A: { Icon: FilePlus, color: 'text-green-400', label: '新增' },
  M: { Icon: FileEdit, color: 'text-blue-400', label: '修改' },
  D: { Icon: FileX, color: 'text-red-400', label: '删除' },
  R: { Icon: FileEdit, color: 'text-yellow-400', label: '重命名' },
}

/** 获取文件名 */
function getFileName(p: string) { return p.replace(/\\/g, '/').split('/').pop() || p }

/** 获取目录部分 */
function getDirPart(p: string) {
  const parts = p.replace(/\\/g, '/').split('/')
  return parts.length <= 1 ? '' : parts.slice(0, -1).join('/') + '/'
}

function normalizePath(p: string) {
  return (p || '').replace(/\\/g, '/')
}

function buildSummaryFromSessionFiles(
  files: any[],
  repoPath: string,
  mainBranch: string,
  worktreeBranch: string,
  worktreeBranchCommit?: string,
) {
  const normalizedRepo = normalizePath(repoPath).replace(/\/+$/, '')
  if (!normalizedRepo) return null

  const fileMap = new Map<string, string>()
  for (const file of files || []) {
    const fullPath = normalizePath(String(file?.filePath || ''))
    if (!fullPath.startsWith(`${normalizedRepo}/`)) continue

    const relativePath = fullPath.slice(normalizedRepo.length + 1)
    if (!relativePath) continue

    const status = file?.changeType === 'create'
      ? 'A'
      : file?.changeType === 'delete'
        ? 'D'
        : 'M'

    fileMap.set(relativePath, status)
  }

  if (fileMap.size === 0) return null

  const summaryFiles = Array.from(fileMap.entries()).map(([path, status]) => ({ path, status }))
  const added = summaryFiles.filter(f => f.status === 'A').length
  const deleted = summaryFiles.filter(f => f.status === 'D').length
  const modified = summaryFiles.length - added - deleted

  return {
    mainBranch,
    worktreeBranch,
    worktreeBranchCommit,
    files: summaryFiles,
    added,
    modified,
    deleted,
    aheadCount: 0,
    fromSessionFiles: true,
  }
}

/** Worktree 子项 — 分支名 + 差异统计 + 可展开文件列表 */
export const WorktreeSubList = React.memo(function WorktreeSubList({
  session,
  onOpenWorktree,
}: {
  session: any
  onOpenWorktree: (sessionId: string) => void
}) {
  const worktreePath = session?.config?.worktreePath
  const repoPath = session?.config?.worktreeSourceRepo
  const baseCommit = session?.config?.worktreeBaseCommit || ''
  const baseBranch = session?.config?.worktreeBaseBranch || ''
  // worktree 分支的 commit hash（合并+cleanup 后分支已删除，但 commit hash 仍在 git 对象库中）
  const worktreeBranchCommit = session?.config?.worktreeBranchCommit || ''
  if (!worktreePath) return null

  const branch = session?.config?.worktreeBranch || 'worktree'
  // 从 worktree/xxx 中提取短名
  const shortBranch = branch.includes('/') ? branch.split('/').slice(-1)[0] : branch
  // worktreeBranchHint: 优先用 commit hash（分支删除后仍有效），其次用分支名
  const worktreeBranchHint = worktreeBranchCommit || branch

  const [expanded, setExpanded] = useState(false)
  const [diffSummary, setDiffSummary] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [diffModal, setDiffModal] = useState<{ filePath: string; worktreeBranch: string } | null>(null)
  const [diffText, setDiffText] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)

  // 展开时加载差异摘要
  useEffect(() => {
    if (!expanded || !repoPath || !worktreePath) return
    if (diffSummary) return // 已加载过

    let cancelled = false

    const enrichWithSessionFiles = async (seed: any) => {
      const sessionFiles = await (window as any).spectrAI?.fileManager?.getSessionFiles?.(session.id) ?? []
      const fallback = buildSummaryFromSessionFiles(
        sessionFiles,
        repoPath,
        seed?.mainBranch || baseBranch || 'main',
        seed?.worktreeBranch || branch,
        seed?.worktreeBranchCommit || worktreeBranchCommit || undefined,
      )
      return fallback ? { ...seed, ...fallback } : seed
    }

    setLoading(true)
    ;(async () => {
      try {
        const result = await (window as any).spectrAI?.worktree?.getDiffSummary?.(
          repoPath,
          worktreePath,
          baseCommit || undefined,
          baseBranch || undefined,
          worktreeBranchHint || undefined,
        )

        const nextSummary = (result?.files?.length || 0) > 0
          ? result
          : await enrichWithSessionFiles(result || { files: [], added: 0, modified: 0, deleted: 0, aheadCount: 0 })

        if (!cancelled) setDiffSummary(nextSummary)
      } catch {
        const fallback = await enrichWithSessionFiles({
          mainBranch: baseBranch || 'main',
          worktreeBranch: branch,
          worktreeBranchCommit: worktreeBranchCommit || undefined,
          files: [],
          added: 0,
          modified: 0,
          deleted: 0,
          aheadCount: 0,
        })
        if (!cancelled) setDiffSummary(fallback)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [expanded, repoPath, worktreePath, baseCommit, baseBranch, worktreeBranchHint, worktreeBranchCommit, branch, session.id, diffSummary])

  // 查看某个文件的 diff
  const handleShowFileDiff = useCallback(async (filePath: string) => {
    if (!repoPath || !diffSummary?.worktreeBranch) return
    setDiffModal({ filePath, worktreeBranch: diffSummary.worktreeBranch })
    setDiffText(null)
    setDiffLoading(true)
    try {
      // 优先用 commit hash（分支删除后仍有效），fallback 到分支名
      const branchOrCommit = diffSummary.worktreeBranchCommit || diffSummary.worktreeBranch
      const text = await (window as any).spectrAI?.worktree?.getFileDiff?.(
        repoPath, branchOrCommit, filePath, baseCommit || undefined, baseBranch || undefined
      )
      setDiffText(text || '（无差异）')
    } catch {
      setDiffText('获取差异失败')
    } finally {
      setDiffLoading(false)
    }
  }, [repoPath, baseCommit, baseBranch, diffSummary])

  const totalFiles = diffSummary ? diffSummary.files?.length || 0 : 0

  return (
    <div className="ml-4 mt-0.5 w-[calc(100%-1rem)]">
      {/* 折叠头：分支名 + 统计 */}
      <button
        onClick={(e) => { e.stopPropagation(); setExpanded(v => !v) }}
        className="w-full flex items-center gap-1 py-1 px-2 rounded text-[10px] text-text-muted hover:text-text-secondary hover:bg-bg-hover btn-transition text-left"
        title={`${branch}\n${worktreePath}\n点击展开查看差异文件`}
      >
        <ChevronDown className={`w-2.5 h-2.5 flex-shrink-0 transition-transform duration-150 ${expanded ? 'rotate-0' : '-rotate-90'}`} />
        <GitBranch className="w-2.5 h-2.5 flex-shrink-0 text-accent-purple" />
        <span className="truncate font-medium text-text-secondary">{shortBranch}</span>
        {/* 差异统计（已加载后显示） */}
        {diffSummary && totalFiles > 0 && (
          <span className="flex items-center gap-1 ml-auto flex-shrink-0">
            {diffSummary.added > 0 && <span className="text-green-400">+{diffSummary.added}</span>}
            {diffSummary.modified > 0 && <span className="text-blue-400">~{diffSummary.modified}</span>}
            {diffSummary.deleted > 0 && <span className="text-red-400">-{diffSummary.deleted}</span>}
          </span>
        )}
        {diffSummary && totalFiles === 0 && (
          <span className="ml-auto text-text-disabled flex-shrink-0">无改动</span>
        )}
        {!diffSummary && !loading && (
          <span className="ml-auto text-text-disabled flex-shrink-0">{totalFiles > 0 ? `${totalFiles} 文件` : ''}</span>
        )}
      </button>

      {/* 展开区：文件列表 */}
      {expanded && (
        <div className="pl-2 border-l border-border/50 ml-1 mt-0.5 mb-0.5">
          {loading && (
            <div className="flex items-center gap-1.5 py-1 px-2 text-text-muted">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span className="text-[10px]">加载差异...</span>
            </div>
          )}
          {!loading && diffSummary && totalFiles === 0 && (
            <div className="py-1 px-2 text-[10px] text-text-muted">
              分支与 {diffSummary.mainBranch || '主分支'} 无差异
            </div>
          )}
          {!loading && diffSummary && totalFiles > 0 && (
            <>
              {/* 领先 commit 数 */}
              {diffSummary.aheadCount > 0 && (
                <div className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-text-muted mb-0.5">
                  <span>领先 {diffSummary.mainBranch} <strong className="text-accent-purple">{diffSummary.aheadCount}</strong> 个提交</span>
                </div>
              )}
              {/* 文件列表 */}
              <div className="max-h-48 overflow-y-auto">
                {diffSummary.files.map((f: any) => {
                  const cfg = FILE_STATUS_CONFIG[f.status] || FILE_STATUS_CONFIG.M
                  return (
                    <button
                      key={f.path}
                      onClick={(e) => { e.stopPropagation(); handleShowFileDiff(f.path) }}
                      className="w-full flex items-center gap-1 px-2 py-0.5 rounded hover:bg-bg-hover text-[10px] text-left group"
                      title={f.path}
                    >
                      <cfg.Icon size={10} className={`flex-shrink-0 ${cfg.color}`} />
                      <span className="text-text-muted truncate">{getDirPart(f.path)}</span>
                      <span className="text-text-secondary truncate">{getFileName(f.path)}</span>
                    </button>
                  )
                })}
              </div>
              {/* 底部操作 */}
              <button
                onClick={(e) => { e.stopPropagation(); onOpenWorktree(session.id) }}
                className="w-full flex items-center justify-center gap-1 mt-0.5 py-1 px-2 rounded text-[10px] text-accent-blue hover:bg-accent-blue/10 btn-transition"
              >
                <GitBranch className="w-2.5 h-2.5" />
                在 Git 面板查看
              </button>
            </>
          )}
        </div>
      )}

      {/* Diff 弹窗 */}
      {diffModal && (
        <WorktreeFileDiffModal
          filePath={diffModal.filePath}
          worktreeBranch={diffModal.worktreeBranch}
          diffText={diffText}
          loading={diffLoading}
          onClose={() => setDiffModal(null)}
        />
      )}
    </div>
  )
})

/** Worktree 文件差异弹窗（轻量版，复用 GitDiffModal 的样式） */
function WorktreeFileDiffModal({ filePath, worktreeBranch, diffText, loading, onClose }: {
  filePath: string; worktreeBranch: string; diffText: string | null; loading: boolean; onClose: () => void
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const lines = (diffText || '').split('\n').map(line => {
    const type = line.startsWith('+') && !line.startsWith('+++') ? 'add'
               : line.startsWith('-') && !line.startsWith('---') ? 'remove'
               : line.startsWith('@@') ? 'hunk'
               : (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) ? 'meta'
               : 'ctx'
    return { type, content: line }
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-bg-secondary border border-border rounded-xl shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col mx-4">
        {/* 标题 */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
          <GitBranch className="w-4 h-4 text-accent-purple flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium text-text-primary">
              {getFileName(filePath)}
            </span>
            <span className="ml-2 text-xs text-text-muted">
              vs {worktreeBranch.includes('/') ? worktreeBranch.split('/').slice(0, -1).join('/') + '/...' : worktreeBranch}
            </span>
          </div>
          <button onClick={onClose}
            className="p-1.5 rounded-lg text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        {/* 差异内容 */}
        <div className="flex-1 overflow-auto font-mono text-xs">
          {loading ? (
            <div className="flex items-center justify-center h-32 text-text-muted">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />加载差异中...
            </div>
          ) : (
            <div>
              {lines.map((line, i) => (
                <div key={i} className={[
                  'px-4 py-0.5 leading-5 whitespace-pre-wrap break-all',
                  line.type === 'add'    ? 'bg-green-500/10 text-green-400' :
                  line.type === 'remove' ? 'bg-red-500/10 text-red-400' :
                  line.type === 'hunk'   ? 'text-blue-400 bg-bg-tertiary' :
                  line.type === 'meta'   ? 'text-text-muted bg-bg-tertiary' :
                                          'text-text-secondary',
                ].join(' ')}>
                  {line.content || '\u00A0'}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
