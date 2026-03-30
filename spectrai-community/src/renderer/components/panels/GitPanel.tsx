/**
 * Git 分支面板 — 完整版
 * 包含变动/历史/Worktree 三个 Tab，支持 stage/unstage/discard/commit/pull/push/diff
 * 支持右键菜单和还原文件功能
 */
import { useEffect, useCallback, useState, useRef } from 'react'
import {
  GitBranch, RefreshCw, FolderGit2, Loader2,
  Plus, Minus, GitCommit as GitCommitIcon, Download, Upload,
  Circle, Check, X, Send, CheckCircle, AlertCircle, ChevronDown,
  RotateCcw,
} from 'lucide-react'
import {
  useGitStore, type GitOperationResult, type TabType, type GitRemoteStatus,
} from '../../stores/gitStore'
import { useSessionStore } from '../../stores/sessionStore'
import { STATUS_COLORS } from '../../../shared/constants'
import { toPlatformShortcutLabel } from '../../utils/shortcut'

// ─── 工具函数 ───────────────────────────────────────────────

function getRepoName(p: string) {
  return p.replace(/\\/g, '/').split('/').filter(Boolean).pop() || p
}
function cleanBranch(b: string) { return b.replace('refs/heads/', '') }
function normPath(p: string) { return p.replace(/\//g, '\\').toLowerCase() }
function getFileName(p: string) { return p.replace(/\\/g, '/').split('/').pop() || p }
function getDirPath(p: string) {
  const parts = p.replace(/\\/g, '/').split('/')
  return parts.length <= 1 ? '' : parts.slice(0, -1).join('/') + '/'
}

function buildSummaryFromSessionFiles(
  files: any[],
  repoPath: string,
  mainBranch: string,
  worktreeBranch: string,
  worktreeBranchCommit?: string,
) {
  const normalizedRepo = (repoPath || '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalizedRepo) return null

  const fileMap = new Map<string, string>()
  for (const file of files || []) {
    const fullPath = String(file?.filePath || '').replace(/\\/g, '/')
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

function statusColor(code: string) {
  return code === 'M' ? '#58A6FF' : code === 'A' ? '#3FB950'
       : code === 'D' ? '#F85149' : code === 'R' ? '#D29922' : '#8B949E'
}

function normalizeRefName(ref: string) {
  return ref
    .replace(/^HEAD -> /, '')
    .replace(/^origin\//, '')
    .replace(/^refs\/heads\//, '')
    .trim()
}

function getCommitBranchLabel(refs: string[] | undefined, fallbackBranch: string) {
  const labels = (refs || []).map(normalizeRefName).filter(Boolean)
  return labels.find(label => !label.startsWith('tag:')) || fallbackBranch
}

// ─── 右键菜单 ────────────────────────────────────────────────

interface ContextMenuItem {
  label: string
  icon?: React.ReactNode
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}

function ContextMenu({ x, y, items, onClose }: {
  x: number; y: number; items: ContextMenuItem[]; onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', handleClick, true)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick, true)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  // 防止菜单超出窗口
  const adjustedX = Math.min(x, window.innerWidth - 180)
  const adjustedY = Math.min(y, window.innerHeight - items.length * 32 - 16)

  return (
    <div
      ref={ref}
      className="fixed z-[100] min-w-[160px] bg-bg-secondary border border-border rounded-lg shadow-xl py-1 overflow-hidden"
      style={{ left: adjustedX, top: adjustedY }}
    >
      {items.map((item, i) => (
        <button
          key={i}
          disabled={item.disabled}
          onClick={() => { item.onClick(); onClose() }}
          className={[
            'w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left transition-colors',
            item.danger
              ? 'text-accent-red hover:bg-accent-red/10'
              : 'text-text-secondary hover:bg-bg-hover',
            item.disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
          ].join(' ')}
        >
          {item.icon && <span className="w-3.5 h-3.5 flex-shrink-0 flex items-center">{item.icon}</span>}
          {item.label}
        </button>
      ))}
    </div>
  )
}

// ─── 确认弹窗 ────────────────────────────────────────────────

function ConfirmModal({ message, onConfirm, onCancel }: {
  message: string; onConfirm: () => void; onCancel: () => void
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter') onConfirm()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onConfirm, onCancel])

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="bg-bg-secondary border border-border rounded-xl shadow-2xl w-80 p-4">
        <div className="flex items-start gap-3 mb-4">
          <AlertCircle className="w-5 h-5 text-accent-red flex-shrink-0 mt-0.5" />
          <p className="text-sm text-text-primary leading-relaxed">{message}</p>
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded-lg text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors">
            取消
          </button>
          <button onClick={onConfirm}
            className="px-3 py-1.5 text-xs rounded-lg bg-accent-red/20 text-accent-red hover:bg-accent-red/30 transition-colors">
            确认还原
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── FileRow ────────────────────────────────────────────────

function FileRow({ filePath, statusCode, onShowDiff, onStage, onUnstage, onDiscard }: {
  filePath: string; statusCode: string
  onShowDiff?: () => void
  onStage?: () => void; onUnstage?: () => void; onDiscard?: () => void
}) {
  const color = statusColor(statusCode)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)

  const menuItems: ContextMenuItem[] = [
    ...(statusCode !== '?' && onShowDiff ? [{
      label: '查看差异',
      icon: <GitBranch className="w-3 h-3" />,
      onClick: () => onShowDiff(),
    }] : []),
    ...(onStage ? [{
      label: '暂存文件',
      icon: <Plus className="w-3 h-3" />,
      onClick: () => onStage(),
    }] : []),
    ...(onUnstage ? [{
      label: '取消暂存',
      icon: <Minus className="w-3 h-3" />,
      onClick: () => onUnstage(),
    }] : []),
    ...(onDiscard ? [{
      label: '还原文件（丢弃修改）',
      icon: <RotateCcw className="w-3 h-3" />,
      danger: true,
      onClick: () => onDiscard(),
    }] : []),
  ]

  return (
    <>
      <div
        className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-bg-hover group cursor-pointer"
        onClick={() => statusCode !== '?' && onShowDiff?.()}
        onContextMenu={e => {
          e.preventDefault()
          e.stopPropagation()
          setCtxMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        <span className="w-4 h-4 flex items-center justify-center text-[10px] font-bold rounded flex-shrink-0"
          style={{ color, backgroundColor: color + '22' }}>
          {statusCode === '?' ? '?' : statusCode}
        </span>
        <div className="flex-1 min-w-0 overflow-hidden">
          <span className="text-[10px] text-text-muted">{getDirPath(filePath)}</span>
          <span className="text-[11px] text-text-secondary">{getFileName(filePath)}</span>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
          {statusCode !== '?' && onShowDiff && (
            <button onClick={e => { e.stopPropagation(); onShowDiff() }}
              className="px-1 py-0.5 rounded text-[10px] text-text-muted hover:text-accent-blue hover:bg-bg-tertiary transition-colors">
              差异
            </button>
          )}
          {onUnstage && (
            <button onClick={e => { e.stopPropagation(); onUnstage() }}
              className="w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-accent-red hover:bg-bg-tertiary transition-colors" title="取消暂存">
              <Minus className="w-3 h-3" />
            </button>
          )}
          {onDiscard && (
            <button onClick={e => { e.stopPropagation(); onDiscard() }}
              className="w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-accent-red hover:bg-bg-tertiary transition-colors" title="还原文件（丢弃修改）">
              <RotateCcw className="w-3 h-3" />
            </button>
          )}
          {onStage && (
            <button onClick={e => { e.stopPropagation(); onStage() }}
              className="w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-accent-green hover:bg-bg-tertiary transition-colors" title="暂存">
              <Plus className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>
      {ctxMenu && menuItems.length > 0 && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={menuItems} onClose={() => setCtxMenu(null)} />
      )}
    </>
  )
}

// ─── ChangesTab ─────────────────────────────────────────────

function ChangesTab({ repoRoot, onShowDiff }: {
  repoRoot: string
  onShowDiff: (filePath: string, staged: boolean) => void
}) {
  const { repoStatusCache, stageFiles, unstageFiles, discardFiles, stageAll, commit, refreshStatus } = useGitStore()
  const [commitMsg, setCommitMsg] = useState('')
  const [committing, setCommitting] = useState(false)
  const [opError, setOpError] = useState<string | null>(null)
  const [commitErr, setCommitErr] = useState<string | null>(null)
  const [confirmState, setConfirmState] = useState<{ msg: string; onOk: () => void } | null>(null)

  const key = normPath(repoRoot)
  const status = repoStatusCache[key]

  useEffect(() => { refreshStatus(repoRoot) }, [repoRoot])

  if (!status) return (
    <div className="flex items-center justify-center h-16 text-text-muted">
      <Loader2 className="w-4 h-4 animate-spin mr-2" /><span className="text-xs">加载中...</span>
    </div>
  )

  const { staged, unstaged, untracked } = status
  const hasChanges = staged.length + unstaged.length + untracked.length > 0

  const handleOp = async (fn: () => Promise<GitOperationResult>) => {
    setOpError(null)
    try {
      const r = await fn()
      if (r?.success === false) setOpError(r.error || '操作失败')
    } catch (err: any) {
      setOpError(err?.message || '操作失败')
    }
  }

  const handleDiscard = (paths: string[], label: string) => {
    setConfirmState({
      msg: `确认还原 ${label}？此操作不可撤销，将丢弃所有本地修改。`,
      onOk: () => {
        setConfirmState(null)
        handleOp(() => discardFiles(repoRoot, paths))
      },
    })
  }

  const handleCommit = async () => {
    if (!commitMsg.trim() || staged.length === 0) return
    setCommitting(true); setCommitErr(null)
    const r = await commit(repoRoot, commitMsg.trim())
    setCommitting(false)
    if (r.success !== false) setCommitMsg('')
    else setCommitErr(r.error || '提交失败')
  }

  if (!hasChanges) return (
    <div className="flex flex-col items-center justify-center h-20 text-text-muted gap-1.5">
      <Check className="w-5 h-5 opacity-40" /><span className="text-xs">工作区干净</span>
    </div>
  )

  return (
    <>
      <div className="flex flex-col gap-0.5 py-1">
        {opError && (
          <div className="mx-2 mb-1 px-2 py-1.5 rounded bg-accent-red/10 border border-accent-red/20 text-[10px] text-accent-red flex items-start gap-1.5">
            <AlertCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
            <span className="flex-1">{opError}</span>
            <button onClick={() => setOpError(null)} className="flex-shrink-0 opacity-60 hover:opacity-100">
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* ── 已暂存（绿色边框，表示可提交） ── */}
        {staged.length > 0 && (
          <div className="border-l-2 border-accent-green/40 ml-1 pl-1">
            <div className="flex items-center justify-between px-2 py-0.5 mb-0.5">
              <span className="text-[10px] text-accent-green font-semibold uppercase tracking-wide flex items-center gap-1">
                <Check className="w-3 h-3" />已暂存 ({staged.length})
              </span>
              <button onClick={() => handleOp(() => unstageFiles(repoRoot, staged.map(f => f.path)))}
                className="text-[10px] text-text-muted hover:text-accent-red transition-colors">全部取消</button>
            </div>
            {staged.map(f => (
              <FileRow key={f.path} filePath={f.path} statusCode={f.statusCode}
                onShowDiff={() => onShowDiff(f.path, true)}
                onUnstage={() => handleOp(() => unstageFiles(repoRoot, [f.path]))} />
            ))}
          </div>
        )}
        {/* ── 未暂存（黄色边框，表示不会被提交） ── */}
        {unstaged.length > 0 && (
          <div className={`border-l-2 border-accent-yellow/30 ml-1 pl-1 ${staged.length > 0 ? 'mt-2' : ''}`}>
            <div className="flex items-center justify-between px-2 py-0.5 mb-0.5">
              <span className="text-[10px] text-accent-yellow font-semibold uppercase tracking-wide flex items-center gap-1">
                <Circle className="w-2.5 h-2.5" />未暂存 ({unstaged.length})
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleDiscard(unstaged.map(f => f.path), `${unstaged.length} 个文件`)}
                  className="text-[10px] text-text-muted hover:text-accent-red transition-colors flex items-center gap-0.5">
                  <RotateCcw className="w-2.5 h-2.5" />全部还原
                </button>
                <button onClick={() => handleOp(() => stageFiles(repoRoot, unstaged.map(f => f.path)))}
                  className="text-[10px] text-text-muted hover:text-accent-green transition-colors">全部暂存</button>
              </div>
            </div>
            {unstaged.map(f => (
              <FileRow key={f.path} filePath={f.path} statusCode={f.statusCode}
                onShowDiff={() => onShowDiff(f.path, false)}
                onStage={() => handleOp(() => stageFiles(repoRoot, [f.path]))}
                onDiscard={() => handleDiscard([f.path], `"${getFileName(f.path)}"`) } />
            ))}
          </div>
        )}
        {/* ── 未跟踪 ── */}
        {untracked.length > 0 && (
          <div className={`border-l-2 border-border ml-1 pl-1 ${staged.length + unstaged.length > 0 ? 'mt-2' : ''}`}>
            <div className="flex items-center justify-between px-2 py-0.5 mb-0.5">
              <span className="text-[10px] text-text-muted font-semibold uppercase tracking-wide">未跟踪 ({untracked.length})</span>
              <button onClick={() => stageAll(repoRoot)}
                className="text-[10px] text-text-muted hover:text-accent-green transition-colors">全部暂存</button>
            </div>
            {untracked.map(p => (
              <FileRow key={p} filePath={p} statusCode="?"
                onStage={() => handleOp(() => stageFiles(repoRoot, [p]))} />
            ))}
          </div>
        )}
        {/* 提交区 */}
        <div className="mt-2 px-2 pb-1">
          <div className="border border-border rounded overflow-hidden mb-1.5">
            <textarea value={commitMsg} onChange={e => setCommitMsg(e.target.value)}
              placeholder={`输入提交信息... (${toPlatformShortcutLabel('Ctrl+Enter')} 提交)`} rows={2}
              className="w-full bg-bg-primary text-xs text-text-primary px-2 py-1.5 resize-none focus:outline-none placeholder:text-text-muted"
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleCommit() }} />
          </div>
          {commitErr && <div className="text-[10px] text-accent-red mb-1">{commitErr}</div>}
          <div className="flex gap-1.5">
            <button onClick={() => stageAll(repoRoot).then(() => {})}
              disabled={unstaged.length === 0 && untracked.length === 0}
              title="将所有未暂存/未跟踪的文件加入暂存区"
              className="flex-1 px-2 py-1 text-[10px] rounded border border-border text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1">
              <Plus className="w-3 h-3" />全部暂存
            </button>
            <button onClick={handleCommit}
              disabled={staged.length === 0 || !commitMsg.trim() || committing}
              title={staged.length === 0 ? '请先暂存文件' : '提交已暂存的文件'}
              className="flex-1 px-2 py-1 text-[10px] rounded bg-accent-green/20 text-accent-green hover:bg-accent-green/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1">
              {committing ? <Loader2 className="w-3 h-3 animate-spin" /> : <GitCommitIcon className="w-3 h-3" />}
              提交 ({staged.length})
            </button>
          </div>
        </div>
      </div>

      {confirmState && (
        <ConfirmModal
          message={confirmState.msg}
          onConfirm={confirmState.onOk}
          onCancel={() => setConfirmState(null)}
        />
      )}
    </>
  )
}

// ─── HistoryTab ─────────────────────────────────────────────

function HistoryTab({ repoRoot, branch, remoteStatus, onShowDiff }: {
  repoRoot: string
  branch: string
  remoteStatus: GitRemoteStatus
  onShowDiff: (filePath: string, staged: boolean, commitHash?: string) => void
}) {
  const { repoLogCache, refreshLog } = useGitStore()
  const key = normPath(repoRoot)
  const log = repoLogCache[key]

  const [expandedHash, setExpandedHash] = useState<string | null>(null)
  const [commitFilesCache, setCommitFilesCache] = useState<Record<string, Array<{ path: string; statusCode: string }>>>({})
  const [loadingHash, setLoadingHash] = useState<string | null>(null)

  const branchLabel = cleanBranch(branch)
  const unpushedCount = Math.max(0, remoteStatus?.ahead || 0)

  useEffect(() => { refreshLog(repoRoot) }, [repoRoot])

  const handleClickCommit = async (hash: string) => {
    if (expandedHash === hash) { setExpandedHash(null); return }
    setExpandedHash(hash)
    if (!commitFilesCache[hash]) {
      setLoadingHash(hash)
      try {
        const files = await (window as any).spectrAI.git.getCommitFiles(repoRoot, hash)
        setCommitFilesCache(prev => ({ ...prev, [hash]: files }))
      } catch { /* ignore */ } finally { setLoadingHash(null) }
    }
  }

  if (!log) return (
    <div className="flex items-center justify-center h-16 text-text-muted">
      <Loader2 className="w-4 h-4 animate-spin mr-2" /><span className="text-xs">加载中...</span>
    </div>
  )
  if (log.length === 0) return (
    <div className="flex items-center justify-center h-16 text-text-muted">
      <span className="text-xs">暂无提交历史</span>
    </div>
  )

  return (
    <div className="py-1">
      {!remoteStatus?.hasUpstream && (
        <div className="mx-2 mb-1 px-2 py-1 rounded border border-accent-yellow/30 bg-accent-yellow/10 text-[10px] text-accent-yellow">
          当前分支未关联上游，暂时无法判断哪些提交已推送。
        </div>
      )}
      {log.map((c, index) => {
        const isExpanded = expandedHash === c.hash
        const files = commitFilesCache[c.hash]
        const isLoadingThis = loadingHash === c.hash
        const isUnpushed = remoteStatus?.hasUpstream && index < unpushedCount
        const commitBranchLabel = getCommitBranchLabel(c.refs, branchLabel)
        return (
          <div key={c.hash}>
            <div
              className={[
                'px-2 py-1.5 rounded cursor-pointer border border-transparent transition-colors',
                isUnpushed
                  ? 'bg-accent-yellow/5 border-accent-yellow/25 hover:bg-accent-yellow/10'
                  : 'hover:bg-bg-hover',
              ].join(' ')}
              onClick={() => handleClickCommit(c.hash)}
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                <ChevronDown className={`w-2.5 h-2.5 text-text-muted flex-shrink-0 transition-transform duration-150 ${isExpanded ? 'rotate-0' : '-rotate-90'}`} />
                <span className="text-[10px] font-mono text-accent-blue flex-shrink-0">{c.shortHash}</span>
                <span className="text-[11px] text-text-primary truncate flex-1">{c.message}</span>
                <span className="px-1 py-0.5 rounded border border-accent-purple/30 bg-accent-purple/10 text-[9px] text-accent-purple flex-shrink-0">
                  {commitBranchLabel}
                </span>
                {remoteStatus?.hasUpstream && (
                  <span
                    className={[
                      'px-1 py-0.5 rounded text-[9px] font-medium flex-shrink-0',
                      isUnpushed
                        ? 'bg-accent-yellow/15 text-accent-yellow border border-accent-yellow/30'
                        : 'bg-accent-green/15 text-accent-green border border-accent-green/30',
                    ].join(' ')}
                  >
                    {isUnpushed ? '未推送' : '已推送'}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-text-muted pl-4">
                <span>{c.author}</span><span>·</span><span>{c.relativeDate}</span>
                {remoteStatus?.hasUpstream && isUnpushed && (
                  <span className="text-accent-yellow">领先远端 {unpushedCount} 提交</span>
                )}
              </div>
            </div>
            {isExpanded && (
              <div className="ml-4 pl-2 border-l border-border mb-1">
                {isLoadingThis ? (
                  <div className="flex items-center gap-1 py-1 px-2 text-text-muted">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    <span className="text-[10px]">加载文件...</span>
                  </div>
                ) : files && files.length > 0 ? (
                  files.map((f: any) => (
                    <div
                      key={f.path}
                      className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-bg-hover cursor-pointer group"
                      onClick={() => onShowDiff(f.path, false, c.hash)}
                    >
                      <span className="w-4 h-4 flex items-center justify-center text-[10px] font-bold rounded flex-shrink-0"
                        style={{ color: statusColor(f.statusCode), backgroundColor: statusColor(f.statusCode) + '22' }}>
                        {f.statusCode}
                      </span>
                      <span className="text-[11px] text-text-secondary truncate flex-1">{getFileName(f.path)}</span>
                      <span className="text-[10px] text-text-muted truncate hidden group-hover:block">{getDirPath(f.path)}</span>
                    </div>
                  ))
                ) : (
                  <div className="px-2 py-1 text-[10px] text-text-muted">无文件变动</div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── WorktreeTab ─────────────────────────────────────────────

/** 单个 Worktree 条目（支持展开差异文件） */
function WorktreeItem({ wt, repoRoot, sessions: wtSessions, onShowDiff }: {
  wt: any; repoRoot: string; sessions: any[]
  onShowDiff: (repoRoot: string, filePath: string, staged: boolean, commitHash?: string) => void
}) {
  const selectSession = useSessionStore(s => s.selectSession)
  const branch = cleanBranch(wt.branch)
  // 从关联 session 中获取 baseCommit 和 baseBranch（合并后仍能查看差异）
  const baseCommit = wtSessions?.[0]?.config?.worktreeBaseCommit || ''
  const baseBranch = wtSessions?.[0]?.config?.worktreeBaseBranch || ''
  const worktreeBranchCommitHint = wtSessions?.[0]?.config?.worktreeBranchCommit || ''
  const primarySessionId = wtSessions?.[0]?.id || ''
  const [expanded, setExpanded] = useState(false)
  const [diffSummary, setDiffSummary] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [diffTarget, setDiffTarget] = useState<{ filePath: string; branch: string } | null>(null)
  const [diffText, setDiffText] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)

  // 展开时加载差异
  useEffect(() => {
    if (!expanded || wt.isMain || diffSummary) return

    let cancelled = false

    const enrichWithSessionFiles = async (seed: any) => {
      if (!primarySessionId) return seed
      const sessionFiles = await (window as any).spectrAI?.fileManager?.getSessionFiles?.(primarySessionId) ?? []
      const fallback = buildSummaryFromSessionFiles(
        sessionFiles,
        repoRoot,
        seed?.mainBranch || baseBranch || 'main',
        seed?.worktreeBranch || branch,
        seed?.worktreeBranchCommit || worktreeBranchCommitHint || undefined,
      )
      return fallback ? { ...seed, ...fallback } : seed
    }

    setLoading(true)
    ;(async () => {
      try {
        const result = await (window as any).spectrAI?.worktree?.getDiffSummary?.(
          repoRoot,
          wt.path,
          baseCommit || undefined,
          baseBranch || undefined,
          worktreeBranchCommitHint || undefined,
        )
        const nextSummary = (result?.files?.length || 0) > 0
          ? result
          : await enrichWithSessionFiles(result || { files: [], added: 0, modified: 0, deleted: 0, aheadCount: 0, mainBranch: '', worktreeBranch: branch })

        if (!cancelled) setDiffSummary(nextSummary)
      } catch {
        const fallback = await enrichWithSessionFiles({ files: [], added: 0, modified: 0, deleted: 0, aheadCount: 0, mainBranch: '', worktreeBranch: branch })
        if (!cancelled) setDiffSummary(fallback)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [expanded, wt.isMain, wt.path, repoRoot, baseCommit, baseBranch, worktreeBranchCommitHint, primarySessionId, diffSummary, branch])

  const handleFileDiff = async (filePath: string) => {
    if (!diffSummary?.worktreeBranch) return
    setDiffTarget({ filePath, branch: diffSummary.worktreeBranch })
    setDiffText(null)
    setDiffLoading(true)
    try {
      // 优先用 commit hash（分支删除后仍有效），fallback 到分支名
      const branchOrCommit = diffSummary.worktreeBranchCommit || diffSummary.worktreeBranch
      const text = await (window as any).spectrAI?.worktree?.getFileDiff?.(repoRoot, branchOrCommit, filePath, baseCommit || undefined, baseBranch || undefined)
      setDiffText(text || '（无差异）')
    } catch { setDiffText('获取差异失败') }
    finally { setDiffLoading(false) }
  }

  const totalFiles = diffSummary?.files?.length || 0

  return (
    <div className="px-2 py-1.5 rounded hover:bg-bg-hover mb-0.5">
      {/* 头部：分支名 + 展开按钮 */}
      <div
        className={`flex items-center gap-1.5 mb-0.5 ${wt.isMain ? '' : 'cursor-pointer'}`}
        onClick={() => !wt.isMain && setExpanded(v => !v)}
      >
        {wt.isMain
          ? <FolderGit2 className="w-3.5 h-3.5 text-accent-blue flex-shrink-0" />
          : <ChevronDown className={`w-3 h-3 text-text-muted flex-shrink-0 transition-transform duration-150 ${expanded ? 'rotate-0' : '-rotate-90'}`} />
        }
        {!wt.isMain && <GitBranch className="w-3 h-3 text-accent-purple flex-shrink-0" />}
        <span className="text-[11px] text-text-secondary font-medium truncate flex-1">{branch}</span>
        {wt.isMain && (
          <span className="text-[9px] text-accent-blue bg-accent-blue/10 px-1 py-0.5 rounded flex-shrink-0">主</span>
        )}
        {/* 差异统计 badge */}
        {!wt.isMain && diffSummary && totalFiles > 0 && (
          <span className="flex items-center gap-1 text-[10px] flex-shrink-0">
            {diffSummary.added > 0 && <span className="text-green-400">+{diffSummary.added}</span>}
            {diffSummary.modified > 0 && <span className="text-blue-400">~{diffSummary.modified}</span>}
            {diffSummary.deleted > 0 && <span className="text-red-400">-{diffSummary.deleted}</span>}
          </span>
        )}
      </div>
      {/* 路径 */}
      <div className="text-[10px] text-text-muted truncate pl-5" title={wt.path}>
        {wt.path.replace(/\\/g, '/').split('/').slice(-2).join('/')}
      </div>
      {/* 关联会话 */}
      {wtSessions.length > 0 && (
        <div className="pl-5 mt-0.5">
          {wtSessions.map((s: any) => (
            <div
              key={s.id}
              className="flex items-center gap-1 mt-0.5 rounded px-1 py-0.5 hover:bg-bg-hover cursor-pointer"
              onClick={() => selectSession(s.id)}
              title="点击切换到该会话"
            >
              <Circle className="w-1.5 h-1.5 flex-shrink-0"
                style={{ color: (STATUS_COLORS as any)[s.status] || STATUS_COLORS.idle }} />
              <span className="text-[10px] text-text-muted truncate">
                {s.name || s.config?.name || s.id.slice(0, 8)}
              </span>
            </div>
          ))}
        </div>
      )}
      {/* 展开区：差异文件列表 */}
      {expanded && !wt.isMain && (
        <div className="mt-1 ml-2 pl-2 border-l border-border">
          {loading && (
            <div className="flex items-center gap-1 py-1 text-text-muted">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span className="text-[10px]">加载差异...</span>
            </div>
          )}
          {!loading && totalFiles === 0 && (
            <div className="py-1 text-[10px] text-text-muted">
              与 {diffSummary?.mainBranch || '主分支'} 无差异
            </div>
          )}
          {!loading && totalFiles > 0 && (
            <>
              {diffSummary.aheadCount > 0 && (
                <div className="text-[10px] text-text-muted mb-0.5">
                  领先 {diffSummary.mainBranch} <strong className="text-accent-purple">{diffSummary.aheadCount}</strong> 个提交，
                  共 <strong className="text-text-secondary">{totalFiles}</strong> 个文件变更
                </div>
              )}
              <div className="max-h-52 overflow-y-auto">
                {diffSummary.files.map((f: any) => {
                  const color = f.status === 'A' ? '#3FB950' : f.status === 'D' ? '#F85149' : f.status === 'R' ? '#D29922' : '#58A6FF'
                  return (
                    <div
                      key={f.path}
                      className="flex items-center gap-1.5 px-1 py-0.5 rounded hover:bg-bg-hover cursor-pointer group"
                      onClick={() => handleFileDiff(f.path)}
                    >
                      <span className="w-4 h-4 flex items-center justify-center text-[10px] font-bold rounded flex-shrink-0"
                        style={{ color, backgroundColor: color + '22' }}>
                        {f.status}
                      </span>
                      <span className="text-[10px] text-text-muted truncate">{getDirPath(f.path)}</span>
                      <span className="text-[11px] text-text-secondary truncate">{getFileName(f.path)}</span>
                      <span className="text-[10px] text-text-muted ml-auto opacity-0 group-hover:opacity-100 flex-shrink-0">差异</span>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}
      {/* Diff 弹窗 */}
      {diffTarget && (
        <WorktreeDiffModal
          filePath={diffTarget.filePath}
          branch={diffTarget.branch}
          diffText={diffText}
          loading={diffLoading}
          onClose={() => setDiffTarget(null)}
        />
      )}
    </div>
  )
}

/** Worktree 文件差异弹窗 */
function WorktreeDiffModal({ filePath, branch, diffText, loading, onClose }: {
  filePath: string; branch: string; diffText: string | null; loading: boolean; onClose: () => void
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
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
          <GitBranch className="w-4 h-4 text-accent-purple flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium text-text-primary">{getFileName(filePath)}</span>
            <span className="ml-2 text-xs text-text-muted">worktree vs 主分支</span>
          </div>
          <button onClick={onClose}
            className="p-1.5 rounded-lg text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
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

function WorktreeTab({ repoInfo, onShowDiff }: {
  repoInfo: any
  onShowDiff: (repoRoot: string, filePath: string, staged: boolean, commitHash?: string) => void
}) {
  const worktrees = repoInfo.worktrees || []
  const sessions = repoInfo.sessions || []

  if (!worktrees.length) return (
    <div className="flex items-center justify-center h-16 text-text-muted">
      <span className="text-xs">无 Worktree</span>
    </div>
  )

  return (
    <div className="py-1">
      {worktrees.map((wt: any) => {
        const wtSessions = sessions.filter((s: any) =>
          s.config?.worktreePath &&
          normPath(s.config.worktreePath) === normPath(wt.path)
        )
        return (
          <WorktreeItem
            key={wt.path}
            wt={wt}
            repoRoot={repoInfo.repoRoot}
            sessions={wtSessions}
            onShowDiff={onShowDiff}
          />
        )
      })}
    </div>
  )
}

// ─── RepoCard ────────────────────────────────────────────────

function RepoCard({ info, onShowDiff, onPull, onPush }: {
  info: any
  onShowDiff: (repoRoot: string, filePath: string, staged: boolean, commitHash?: string) => void
  onPull: (repoRoot: string, repoName: string) => void
  onPush: (repoRoot: string, repoName: string) => void
}) {
  const { repoStatusCache, activeTabMap, setActiveTab, operationMap } = useGitStore()
  const key = normPath(info.repoRoot)
  const activeTab: TabType = activeTabMap[key] || 'changes'
  const status = repoStatusCache[key]
  const isOperating = !!operationMap[key]
  const changesCount = status ? status.staged.length + status.unstaged.length + status.untracked.length : null
  const wtCount = (info.worktrees || []).filter((w: any) => !w.isMain).length
  const remoteStatus = info.remoteStatus || { hasUpstream: false, upstream: null, ahead: 0, behind: 0 }

  const tabs: Array<{ id: TabType; label: string; badge?: number | null }> = [
    { id: 'changes', label: '变动', badge: changesCount },
    { id: 'history', label: '历史' },
    { id: 'worktrees', label: 'Worktree', badge: wtCount || null },
  ]

  return (
    <div className="rounded-lg border border-border overflow-hidden mb-3 bg-bg-primary">
      {/* 仓库标题 */}
      <div className="flex items-center gap-2 px-3 py-2 bg-bg-secondary border-b border-border">
        <FolderGit2 className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
        <span className="text-xs font-semibold text-text-primary truncate flex-1" title={info.repoRoot}>
          {getRepoName(info.repoRoot)}
        </span>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button onClick={() => onPull(info.repoRoot, getRepoName(info.repoRoot))} disabled={isOperating}
            className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-text-muted hover:text-accent-blue hover:bg-accent-blue/10 transition-colors disabled:opacity-40">
            <Download className="w-3 h-3" />Pull
          </button>
          <button onClick={() => onPush(info.repoRoot, getRepoName(info.repoRoot))} disabled={isOperating}
            className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-text-muted hover:text-accent-green hover:bg-accent-green/10 transition-colors disabled:opacity-40">
            <Upload className="w-3 h-3" />Push
          </button>
        </div>
      </div>
      {/* 分支行 */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border">
        <GitBranch className="w-3 h-3 text-accent-blue flex-shrink-0" />
        <span className="text-[11px] font-medium text-accent-blue truncate">{cleanBranch(info.branch)}</span>
        {remoteStatus.hasUpstream ? (
          <>
            {remoteStatus.ahead > 0 && (
              <span className="px-1 py-0.5 rounded border border-accent-yellow/30 bg-accent-yellow/10 text-[9px] text-accent-yellow flex-shrink-0">
                未推送 {remoteStatus.ahead}
              </span>
            )}
            {remoteStatus.ahead === 0 && remoteStatus.behind === 0 && (
              <span className="px-1 py-0.5 rounded border border-accent-green/30 bg-accent-green/10 text-[9px] text-accent-green flex-shrink-0">
                已同步
              </span>
            )}
            {remoteStatus.behind > 0 && (
              <span className="px-1 py-0.5 rounded border border-accent-blue/30 bg-accent-blue/10 text-[9px] text-accent-blue flex-shrink-0">
                落后 {remoteStatus.behind}
              </span>
            )}
          </>
        ) : (
          <span className="px-1 py-0.5 rounded border border-border bg-bg-secondary text-[9px] text-text-muted flex-shrink-0">
            未跟踪远端
          </span>
        )}
        {info.isDirty && <span className="w-1.5 h-1.5 rounded-full bg-accent-yellow flex-shrink-0" title="有未提交改动" />}
        {isOperating && <Loader2 className="w-3 h-3 text-text-muted animate-spin flex-shrink-0 ml-1" />}
      </div>
      {/* Tabs */}
      <div className="flex border-b border-border">
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(info.repoRoot, tab.id)}
            className={[
              'flex-1 py-1.5 text-[11px] transition-colors flex items-center justify-center gap-1',
              activeTab === tab.id
                ? 'text-accent-blue border-b-2 border-accent-blue bg-accent-blue/5'
                : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover',
            ].join(' ')}>
            {tab.label}
            {tab.badge !== null && tab.badge !== undefined && tab.badge > 0 && (
              <span className="text-[9px] bg-bg-tertiary px-1 rounded-full">{tab.badge}</span>
            )}
          </button>
        ))}
      </div>
      {/* 内容区 */}
      <div className="overflow-y-auto">
        {activeTab === 'changes' && (
          <ChangesTab repoRoot={info.repoRoot}
            onShowDiff={(fp, s) => onShowDiff(info.repoRoot, fp, s)} />
        )}
        {activeTab === 'history' && (
          <HistoryTab
            repoRoot={info.repoRoot}
            branch={info.branch}
            remoteStatus={remoteStatus}
            onShowDiff={(fp, s, hash) => onShowDiff(info.repoRoot, fp, s, hash)}
          />
        )}
        {activeTab === 'worktrees' && (
          <WorktreeTab repoInfo={info}
            onShowDiff={(repoRoot, fp, s, hash) => onShowDiff(repoRoot, fp, s, hash)} />
        )}
      </div>
    </div>
  )
}

// ─── Diff Modal ──────────────────────────────────────────────

function GitDiffModal({ repoRoot, filePath, staged, commitHash, onClose }: {
  repoRoot: string; filePath: string; staged: boolean; commitHash?: string; onClose: () => void
}) {
  const [diffText, setDiffText] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const selectedSessionId = useSessionStore(s => s.selectedSessionId)
  const sendMessage = useSessionStore(s => s.sendMessage)

  useEffect(() => {
    setLoading(true)
    ;(window as any).spectrAI.git.getFileDiff(repoRoot, filePath, staged, commitHash)
      .then((t: string) => setDiffText(t || '（无差异）'))
      .catch(() => setDiffText('获取差异失败'))
      .finally(() => setLoading(false))
  }, [repoRoot, filePath, staged, commitHash])

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const handleSendToAI = async () => {
    if (!selectedSessionId || !diffText) return
    setSending(true)
    try {
      const name = filePath.replace(/\\/g, '/').split('/').pop()
      await sendMessage(selectedSessionId,
        `以下是文件 \`${name}\` 的代码差异（${staged ? '已暂存' : '未暂存'}）：\n\n\`\`\`diff\n${diffText}\n\`\`\`\n\n请帮我分析这些改动。`
      )
      onClose()
    } finally { setSending(false) }
  }

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
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
          <GitBranch className="w-4 h-4 text-accent-blue flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium text-text-primary">
              {filePath.replace(/\\/g, '/').split('/').pop()}
            </span>
            <span className="ml-2 text-xs text-text-muted">
              {commitHash ? `commit ${commitHash.slice(0, 7)}` : staged ? '已暂存' : '未暂存'}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {selectedSessionId ? (
              <button onClick={handleSendToAI} disabled={sending || loading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-accent-purple/20 text-accent-purple hover:bg-accent-purple/30 transition-colors disabled:opacity-40">
                {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                发给 AI 分析
              </button>
            ) : (
              <span className="text-xs text-text-muted">（无活跃会话）</span>
            )}
            <button onClick={onClose}
              className="p-1.5 rounded-lg text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
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

// ─── Output Modal ────────────────────────────────────────────

function GitOutputModal({ operation, repoName, result, onClose }: {
  operation: 'pull' | 'push'; repoName: string
  result: GitOperationResult | null; onClose: () => void
}) {
  const isLoading = result === null
  const label = operation === 'pull' ? 'Pull' : 'Push'
  const Icon = operation === 'pull' ? Download : Upload

  useEffect(() => {
    if (isLoading) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [isLoading, onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget && !isLoading) onClose() }}>
      <div className="bg-bg-secondary border border-border rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <Icon className="w-4 h-4 text-accent-blue flex-shrink-0" />
          <span className="flex-1 text-sm font-medium text-text-primary">
            Git {label} — {repoName}
          </span>
          {!isLoading && (
            <button onClick={onClose}
              className="p-1.5 rounded-lg text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="p-4">
          {isLoading ? (
            <div className="flex items-center gap-3 text-text-secondary">
              <Loader2 className="w-5 h-5 animate-spin text-accent-blue flex-shrink-0" />
              <span className="text-sm">正在执行 {label}...</span>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-3">
                {result!.success
                  ? <><CheckCircle className="w-5 h-5 text-accent-green flex-shrink-0" /><span className="text-sm font-medium text-accent-green">{label} 成功</span></>
                  : <><AlertCircle className="w-5 h-5 text-accent-red flex-shrink-0" /><span className="text-sm font-medium text-accent-red">{label} 失败</span></>
                }
              </div>
              {result!.output && (
                <pre className="text-xs text-text-secondary bg-bg-primary border border-border rounded-lg p-3 max-h-48 overflow-y-auto font-mono whitespace-pre-wrap break-words">
                  {result!.output}
                </pre>
              )}
              <div className="flex justify-end mt-3">
                <button onClick={onClose}
                  className="px-4 py-1.5 text-sm rounded-lg bg-bg-hover hover:bg-bg-tertiary text-text-secondary transition-colors">
                  关闭
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── 主面板 ──────────────────────────────────────────────────

interface DiffTarget { repoRoot: string; filePath: string; staged: boolean; commitHash?: string }
interface OutputTarget { operation: 'pull' | 'push'; repoName: string; result: GitOperationResult | null }

export default function GitPanel() {
  const { repoInfoMap, loading, lastRefreshedAt, refreshAll, pull, push } = useGitStore()
  const sessions = useSessionStore(s => s.sessions)
  const selectedSessionId = useSessionStore(s => s.selectedSessionId)
  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(null)
  const [outputTarget, setOutputTarget] = useState<OutputTarget | null>(null)

  const refresh = useCallback(() => refreshAll(sessions), [refreshAll, sessions])

  // Bug fix: sessions.length 变化时（新增/删除会话）自动刷新 git 信息
  // 原来只在 [] mount 时刷新，新会话创建后不触发，导致需要手动切换面板
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (sessions.length > 0) refresh() }, [sessions.length])

  const handlePull = useCallback(async (repoRoot: string, repoName: string) => {
    setOutputTarget({ operation: 'pull', repoName, result: null })
    const result = await pull(repoRoot)
    setOutputTarget(prev => prev ? { ...prev, result } : null)
  }, [pull])

  const handlePush = useCallback(async (repoRoot: string, repoName: string) => {
    setOutputTarget({ operation: 'push', repoName, result: null })
    const result = await push(repoRoot)
    setOutputTarget(prev => prev ? { ...prev, result } : null)
  }, [push])

  const allRepos = Object.values(repoInfoMap)
  // 聚焦当前选中会话对应的仓库，未选中时显示全部
  const repoList = selectedSessionId
    ? allRepos.filter(info => (info.sessions as any[]).some(s => s.id === selectedSessionId))
    : allRepos

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-1.5">
          <GitBranch className="w-3.5 h-3.5 text-text-muted" />
          <span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Git 分支</span>
          {loading && <Loader2 className="w-3 h-3 text-text-muted animate-spin" />}
        </div>
        <button onClick={refresh} disabled={loading} title="刷新"
          className="p-1 rounded text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors disabled:opacity-40">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {loading && repoList.length === 0 ? (
          <div className="flex items-center justify-center h-24 text-text-muted">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /><span className="text-xs">加载中...</span>
          </div>
        ) : repoList.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-28 text-text-muted gap-2">
            <GitBranch className="w-6 h-6 opacity-40" />
            <span className="text-xs">暂无 Git 仓库</span>
            <span className="text-[10px] opacity-60">创建会话并选择 git 仓库目录</span>
          </div>
        ) : (
          repoList.map(info => (
            <RepoCard key={info.repoRoot} info={info}
              onShowDiff={(repoRoot, fp, s, hash) => setDiffTarget({ repoRoot, filePath: fp, staged: s, commitHash: hash })}
              onPull={handlePull} onPush={handlePush} />
          ))
        )}
        {lastRefreshedAt > 0 && !loading && repoList.length > 0 && (
          <div className="text-[10px] text-text-muted text-center mt-1 pb-1">
            {new Date(lastRefreshedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </div>
        )}
      </div>

      {diffTarget && (
        <GitDiffModal repoRoot={diffTarget.repoRoot} filePath={diffTarget.filePath}
          staged={diffTarget.staged} commitHash={diffTarget.commitHash} onClose={() => setDiffTarget(null)} />
      )}
      {outputTarget && (
        <GitOutputModal operation={outputTarget.operation} repoName={outputTarget.repoName}
          result={outputTarget.result} onClose={() => setOutputTarget(null)} />
      )}
    </div>
  )
}
