/**
 * 任务编辑弹窗 - 支持创建/编辑双模式
 * 含 Git Worktree 隔离配置
 * @author weibin
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { X, GitBranch, FolderGit2, ChevronDown, ChevronRight, Layers, Folder } from 'lucide-react'
import type { TaskCard, TaskPriority, TaskStatus, Workspace } from '../../../shared/types'
import { PRIORITY_COLORS, KANBAN_COLUMNS } from '../../../shared/constants'
import { useSettingsStore } from '../../stores/settingsStore'

type WorktreeMode = 'workspace' | 'single'

interface TaskEditDialogProps {
  open: boolean
  mode: 'create' | 'edit'
  task?: TaskCard
  onClose: () => void
  onSave: (data: Partial<TaskCard>) => Promise<void>
}

const PRIORITY_OPTIONS: { value: TaskPriority; label: string }[] = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]

const TaskEditDialog: React.FC<TaskEditDialogProps> = ({
  open,
  mode,
  task,
  onClose,
  onSave,
}) => {
  // 读取全局设置（autoWorktree 决定创建模式的默认值）
  const { settings } = useSettingsStore()

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [status, setStatus] = useState<TaskStatus>('todo')
  const [tags, setTags] = useState('')
  const [estimatedDuration, setEstimatedDuration] = useState('')
  const [saving, setSaving] = useState(false)

  // Worktree 隔离配置
  const [worktreeExpanded, setWorktreeExpanded] = useState(false)
  const [worktreeEnabled, setWorktreeEnabled] = useState(false)
  const [worktreeMode, setWorktreeMode] = useState<WorktreeMode>('workspace')
  const [gitRepoPath, setGitRepoPath] = useState('')
  const [gitBranch, setGitBranch] = useState('')
  const [isGitRepo, setIsGitRepo] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  const [checkingRepo, setCheckingRepo] = useState(false)

  // Workspace 选择
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('')

  const titleRef = useRef<HTMLInputElement>(null)

  // 打开时填充表单数据 + 加载工作区列表
  useEffect(() => {
    if (!open) return

    // 加载工作区列表
    window.spectrAI.workspace.list().then((list: Workspace[]) => {
      setWorkspaces(list || [])
    }).catch(() => setWorkspaces([]))

    if (mode === 'edit' && task) {
      setTitle(task.title)
      setDescription(task.description || '')
      setPriority(task.priority)
      setStatus(task.status)
      setTags(task.tags?.join(', ') || '')
      setEstimatedDuration(task.estimatedDuration?.toString() || '')
      // worktree 字段
      setWorktreeEnabled(task.worktreeEnabled || false)
      setWorktreeExpanded(!!(task.worktreeEnabled))
      // 模式判断：有 workspaceId → workspace 模式；只有 gitRepoPath → single 模式
      if (task.workspaceId) {
        setWorktreeMode('workspace')
        setSelectedWorkspaceId(task.workspaceId)
        setGitRepoPath('')
        setGitBranch(task.gitBranch || '')
      } else {
        setWorktreeMode('single')
        setSelectedWorkspaceId('')
        setGitRepoPath(task.gitRepoPath || '')
        setGitBranch(task.gitBranch || '')
        if (task.gitRepoPath) {
          checkGitRepo(task.gitRepoPath)
        }
      }
    } else {
      setTitle('')
      setDescription('')
      setPriority('medium')
      setStatus('todo')
      setTags('')
      setEstimatedDuration('')
      // 创建模式：读取全局 autoWorktree 设置作为默认值
      const defaultWorktree = settings.autoWorktree
      setWorktreeEnabled(defaultWorktree)
      setWorktreeExpanded(defaultWorktree) // 默认启用时自动展开
      setWorktreeMode('workspace') // 默认工作区模式
      setSelectedWorkspaceId('')
      setGitRepoPath('')
      setGitBranch('')
      setIsGitRepo(false)
      setBranches([])
    }
    // 聚焦标题输入框
    setTimeout(() => titleRef.current?.focus(), 50)
  }, [open, mode, task, settings.autoWorktree])

  // 选择仓库目录后自动检测
  const checkGitRepo = useCallback(async (dirPath: string) => {
    if (!dirPath) {
      setIsGitRepo(false)
      setBranches([])
      return
    }
    setCheckingRepo(true)
    try {
      const valid = await window.spectrAI.git.isRepo(dirPath)
      setIsGitRepo(valid)
      if (valid) {
        const branchList = await window.spectrAI.git.getBranches(dirPath)
        setBranches(branchList)
      } else {
        setBranches([])
      }
    } catch {
      setIsGitRepo(false)
      setBranches([])
    } finally {
      setCheckingRepo(false)
    }
  }, [])

  // 选择仓库目录
  const handleSelectRepo = async () => {
    const selected = await window.spectrAI.app.selectDirectory()
    if (selected) {
      setGitRepoPath(selected)
      await checkGitRepo(selected)
    }
  }

  // 标题变化时自动生成分支名建议
  useEffect(() => {
    if (worktreeEnabled && !gitBranch && title.trim()) {
      const slug = title.trim()
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fa5\s-]/g, '')
        .replace(/[\s_]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40)
      if (slug) {
        setGitBranch(`task/${slug}`)
      }
    }
  }, [title, worktreeEnabled])

  // Escape 关闭
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || saving) return

    const tagList = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)

    const data: Partial<TaskCard> = {
      title: title.trim(),
      description: description.trim(),
      priority,
      tags: tagList,
    }

    // 编辑模式下包含状态和预估时长
    if (mode === 'edit') {
      data.status = status
    }

    const dur = parseInt(estimatedDuration, 10)
    if (!isNaN(dur) && dur > 0) {
      data.estimatedDuration = dur
    }

    if (mode === 'create') {
      data.status = 'todo'
    }

    // Worktree 隔离配置
    if (worktreeEnabled && gitBranch) {
      if (worktreeMode === 'workspace' && selectedWorkspaceId) {
        data.worktreeEnabled = true
        data.workspaceId = selectedWorkspaceId
        data.gitBranch = gitBranch
        data.gitRepoPath = undefined // 工作区模式不使用单仓库路径
      } else if (worktreeMode === 'single' && gitRepoPath && isGitRepo) {
        data.worktreeEnabled = true
        data.gitRepoPath = gitRepoPath
        data.gitBranch = gitBranch
        data.workspaceId = undefined
      } else {
        data.worktreeEnabled = false
      }
    } else {
      data.worktreeEnabled = false
    }

    setSaving(true)
    try {
      await onSave(data)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-bg-secondary rounded-lg shadow-2xl w-full max-w-lg border border-border animate-slide-in max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">
            {mode === 'create' ? '新建任务' : '编辑任务'}
          </h2>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary btn-transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 表单 */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* 标题 */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              标题 <span className="text-accent-red">*</span>
            </label>
            <input
              ref={titleRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="输入任务标题"
              className="w-full px-3 py-2 bg-bg-primary border border-border rounded text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-blue"
            />
          </div>

          {/* 描述 */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              描述
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="输入任务描述（可选）"
              rows={3}
              className="w-full px-3 py-2 bg-bg-primary border border-border rounded text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-blue resize-none"
            />
          </div>

          {/* 优先级 + 状态（同行） */}
          <div className="flex gap-4">
            {/* 优先级 radio group */}
            <div className="flex-1">
              <label className="block text-sm font-medium text-text-secondary mb-2">
                优先级
              </label>
              <div className="flex gap-2">
                {PRIORITY_OPTIONS.map((opt) => {
                  const color = PRIORITY_COLORS[opt.value]
                  const isActive = priority === opt.value
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setPriority(opt.value)}
                      className={`
                        flex-1 px-3 py-1.5 text-sm rounded border btn-transition font-medium
                        ${isActive
                          ? 'border-transparent'
                          : 'border-border bg-bg-primary text-text-secondary hover:bg-bg-hover'
                        }
                      `}
                      style={
                        isActive
                          ? { backgroundColor: `${color}20`, color, borderColor: `${color}40` }
                          : undefined
                      }
                    >
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* 状态（仅编辑模式） */}
            {mode === 'edit' && (
              <div className="flex-1">
                <label className="block text-sm font-medium text-text-secondary mb-2">
                  状态
                </label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as TaskStatus)}
                  className="w-full px-3 py-1.5 bg-bg-primary border border-border rounded text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent-blue"
                >
                  {KANBAN_COLUMNS.map((col) => (
                    <option key={col.id} value={col.id}>
                      {col.title}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* 标签 */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              标签
            </label>
            <input
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="用逗号分隔（如: bug, frontend, urgent）"
              className="w-full px-3 py-2 bg-bg-primary border border-border rounded text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-blue"
            />
          </div>

          {/* 预估时长 */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              预估时长
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                value={estimatedDuration}
                onChange={(e) => setEstimatedDuration(e.target.value)}
                placeholder="可选"
                className="flex-1 px-3 py-2 bg-bg-primary border border-border rounded text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-blue"
              />
              <span className="text-sm text-text-muted">分钟</span>
            </div>
          </div>

          {/* Git Worktree 隔离 */}
          <div className="border border-border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setWorktreeExpanded(!worktreeExpanded)}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-text-secondary hover:bg-bg-hover btn-transition"
            >
              {worktreeExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <FolderGit2 size={14} />
              <span>Git Worktree 隔离</span>
              {worktreeEnabled && (
                <span className="ml-auto text-xs px-1.5 py-0.5 rounded bg-accent-green/15 text-accent-green font-medium">
                  已启用
                </span>
              )}
            </button>

            {worktreeExpanded && (
              <div className="px-3 pb-3 space-y-3 border-t border-border pt-3">
                {/* 启用开关 */}
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={worktreeEnabled}
                    onChange={(e) => setWorktreeEnabled(e.target.checked)}
                    className="rounded border-border accent-accent-blue"
                  />
                  <span className="text-sm text-text-primary">
                    启用独立工作区（每个任务使用独立的 git worktree）
                  </span>
                </label>

                {worktreeEnabled && (
                  <>
                    {/* 模式切换 */}
                    <div className="flex gap-1 p-0.5 bg-bg-primary border border-border rounded-lg">
                      <button
                        type="button"
                        onClick={() => setWorktreeMode('workspace')}
                        className={[
                          'flex items-center gap-1.5 flex-1 justify-center px-2 py-1 rounded text-xs font-medium btn-transition',
                          worktreeMode === 'workspace'
                            ? 'bg-accent-blue text-white'
                            : 'text-text-muted hover:text-text-primary',
                        ].join(' ')}
                      >
                        <Layers size={12} />
                        工作区
                      </button>
                      <button
                        type="button"
                        onClick={() => setWorktreeMode('single')}
                        className={[
                          'flex items-center gap-1.5 flex-1 justify-center px-2 py-1 rounded text-xs font-medium btn-transition',
                          worktreeMode === 'single'
                            ? 'bg-accent-blue text-white'
                            : 'text-text-muted hover:text-text-primary',
                        ].join(' ')}
                      >
                        <Folder size={12} />
                        单仓库
                      </button>
                    </div>

                    {/* 工作区模式 */}
                    {worktreeMode === 'workspace' && (
                      <div>
                        <label className="block text-xs font-medium text-text-secondary mb-1">
                          选择工作区
                        </label>
                        {workspaces.length === 0 ? (
                          <div className="text-xs text-text-muted bg-bg-primary border border-border rounded px-2 py-2">
                            还没有工作区。请先在{' '}
                            <span className="text-accent-blue">设置 → 工作区</span>{' '}
                            中创建工作区，或切换到「单仓库」模式。
                          </div>
                        ) : (
                          <>
                            <select
                              value={selectedWorkspaceId}
                              onChange={(e) => setSelectedWorkspaceId(e.target.value)}
                              className="w-full px-2 py-1.5 text-sm bg-bg-primary border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-blue"
                            >
                              <option value="">-- 选择工作区 --</option>
                              {workspaces.map((ws) => (
                                <option key={ws.id} value={ws.id}>
                                  {ws.name}（{ws.repos.length} 个仓库）
                                </option>
                              ))}
                            </select>
                            {/* 选中工作区后预览仓库 */}
                            {selectedWorkspaceId && (() => {
                              const ws = workspaces.find(w => w.id === selectedWorkspaceId)
                              return ws ? (
                                <div className="mt-1.5 text-xs text-text-muted space-y-0.5">
                                  {ws.repos.map(r => (
                                    <div key={r.id} className="flex items-center gap-1.5">
                                      <span className={r.isPrimary ? 'text-accent-yellow' : ''}>
                                        {r.isPrimary ? '★' : '·'}
                                      </span>
                                      <span className="font-medium text-text-secondary">{r.name}</span>
                                      {r.isPrimary && (
                                        <span className="text-accent-yellow text-[10px]">（主）</span>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              ) : null
                            })()}
                          </>
                        )}
                      </div>
                    )}

                    {/* 单仓库模式 */}
                    {worktreeMode === 'single' && (
                      <div>
                        <label className="block text-xs font-medium text-text-secondary mb-1">
                          Git 仓库
                        </label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={gitRepoPath}
                            onChange={(e) => {
                              setGitRepoPath(e.target.value)
                              checkGitRepo(e.target.value)
                            }}
                            placeholder="选择 git 仓库目录"
                            className="flex-1 px-2 py-1.5 text-sm bg-bg-primary border border-border rounded text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-blue"
                            readOnly
                          />
                          <button
                            type="button"
                            onClick={handleSelectRepo}
                            className="px-3 py-1.5 text-sm bg-bg-hover hover:bg-bg-tertiary text-text-primary border border-border rounded btn-transition"
                          >
                            选择
                          </button>
                        </div>
                        {gitRepoPath && (
                          <div className="mt-1 flex items-center gap-1 text-xs">
                            {checkingRepo ? (
                              <span className="text-text-muted">检查中...</span>
                            ) : isGitRepo ? (
                              <span className="text-accent-green">Git 仓库</span>
                            ) : (
                              <span className="text-accent-red">非 Git 仓库</span>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* 分支名（两种模式共用） */}
                    <div>
                      <label className="block text-xs font-medium text-text-secondary mb-1">
                        <GitBranch size={12} className="inline mr-1" />
                        分支名
                      </label>
                      <input
                        type="text"
                        value={gitBranch}
                        onChange={(e) => setGitBranch(e.target.value)}
                        placeholder="task/feature-name（自动从标题生成）"
                        list="branch-suggestions"
                        className="w-full px-2 py-1.5 text-sm bg-bg-primary border border-border rounded text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-blue"
                      />
                      {branches.length > 0 && (
                        <datalist id="branch-suggestions">
                          {branches.map((b) => (
                            <option key={b} value={b} />
                          ))}
                        </datalist>
                      )}
                      <p className="mt-1 text-xs text-text-muted">
                        新分支将从当前 HEAD 创建；已有分支将直接使用
                      </p>
                    </div>

                    {/* 编辑模式下显示当前 worktree 路径 */}
                    {mode === 'edit' && task?.worktreePath && (
                      <div className="text-xs text-text-muted bg-bg-primary px-2 py-1.5 rounded border border-border">
                        Worktree: {task.worktreePath}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* 按钮 */}
          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={
              !title.trim() || saving ||
              (worktreeEnabled && (
                !gitBranch ||
                (worktreeMode === 'workspace' && !selectedWorkspaceId) ||
                (worktreeMode === 'single' && (!gitRepoPath || !isGitRepo))
              ))
            }
              className="flex-1 px-4 py-2 bg-accent-blue text-white rounded font-medium btn-transition hover:bg-opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? '保存中...' : mode === 'create' ? '创建' : '保存'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-bg-hover hover:bg-bg-tertiary text-text-secondary rounded font-medium btn-transition"
            >
              取消
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

TaskEditDialog.displayName = 'TaskEditDialog'

export default TaskEditDialog
