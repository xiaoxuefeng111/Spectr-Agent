/**
 * Task IPC 处理器 - 任务管理
 */
import { ipcMain } from 'electron'
import { IPC } from '../../shared/constants'
import { BUILTIN_CLAUDE_PROVIDER } from '../../shared/types'
import type { AIProvider, SessionConfig } from '../../shared/types'
import { GitWorktreeService } from '../git/GitWorktreeService'
import { injectWorkspaceSection } from '../agent/supervisorPrompt'
import { v4 as uuidv4 } from 'uuid'
import type { IpcDependencies } from './index'

export function registerTaskHandlers(deps: IpcDependencies): void {
  const { database, sessionManagerV2, concurrencyGuard, taskCoordinator } = deps

  // ==================== Task 相关 ====================

  ipcMain.handle(IPC.TASK_CREATE, async (_event, task: any) => {
    try {
      const taskId = task.id || uuidv4()
      const taskData: any = {
        id: taskId,
        title: task.title || 'Untitled',
        description: task.description || '',
        status: task.status || 'todo',
        priority: task.priority || 'medium',
        tags: task.tags || [],
        parentTaskId: task.parentTaskId,
        worktreeEnabled: task.worktreeEnabled || false,
        gitRepoPath: task.gitRepoPath,
        gitBranch: task.gitBranch,
        workspaceId: task.workspaceId,
      }

      const gitService = new GitWorktreeService()

      // 路径1：工作区多仓库 worktree 创建
      if (taskData.worktreeEnabled && taskData.workspaceId && taskData.gitBranch) {
        const workspace = database.getWorkspace(taskData.workspaceId)
        if (!workspace) {
          return { success: false, error: '工作区不存在' }
        }

        const worktreePaths: Record<string, string> = {}

        try {
          const results = await Promise.allSettled(
            workspace.repos.map(async (repo: any) => {
              const result = await gitService.createWorktree(repo.repoPath, taskData.gitBranch, taskId)
              return { repoId: repo.id, worktreePath: result.worktreePath, branch: result.branch }
            })
          )

          // 先收集所有成功的 worktree（确保失败时能完整回滚）
          const failures: string[] = []
          for (const result of results) {
            if (result.status === 'fulfilled') {
              worktreePaths[result.value.repoId] = result.value.worktreePath
            } else {
              failures.push(result.reason?.message || '未知错误')
            }
          }

          // 有任意一个失败 → 抛出错误，触发 catch 块统一回滚所有已成功的
          if (failures.length > 0) {
            throw new Error(failures.join('; '))
          }

          taskData.worktreePaths = worktreePaths

          // 分支名以 primary 仓库的实际分支为准
          const primaryRepo = workspace.repos.find((r: any) => r.isPrimary) ?? workspace.repos[0]
          const primaryResult = results.find(
            r => r.status === 'fulfilled' && (r as any).value.repoId === primaryRepo?.id
          )
          if (primaryResult?.status === 'fulfilled') {
            taskData.gitBranch = (primaryResult as any).value.branch
          }
        } catch (wtErr: any) {
          // 回滚：清理已创建的 worktrees
          for (const repo of workspace.repos) {
            const wtp = worktreePaths[(repo as any).id]
            if (wtp) {
              try { await gitService.removeWorktree((repo as any).repoPath, wtp) } catch (_) {}
            }
          }
          console.error('[IPC] Multi-repo worktree creation failed:', wtErr)
          return { success: false, error: `多仓库 Worktree 创建失败: ${wtErr.message}` }
        }
      }
      // 路径2：单仓库 worktree 创建（向后兼容）
      else if (taskData.worktreeEnabled && taskData.gitRepoPath && taskData.gitBranch) {
        try {
          const result = await gitService.createWorktree(
            taskData.gitRepoPath,
            taskData.gitBranch,
            taskId
          )
          taskData.worktreePath = result.worktreePath
          taskData.gitBranch = result.branch
        } catch (wtErr: any) {
          console.error('[IPC] Worktree creation failed:', wtErr)
          return { success: false, error: `Worktree 创建失败: ${wtErr.message}` }
        }
      }

      const created = database.createTask(taskData)
      return { success: true, taskId: created.id }
    } catch (error: any) {
      console.error('[IPC] TASK_CREATE error:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(IPC.TASK_UPDATE, async (_event, taskId: string, updates: any) => {
    try {
      database.updateTask(taskId, updates)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(IPC.TASK_DELETE, async (_event, taskId: string) => {
    try {
      const task = database.getTask(taskId)
      const gitService = new GitWorktreeService()

      // 清理：工作区多仓库 worktree
      if (task?.worktreeEnabled && task.workspaceId && task.worktreePaths) {
        const workspace = database.getWorkspace(task.workspaceId)
        if (workspace) {
          await Promise.allSettled(
            workspace.repos.map(async (repo: any) => {
              const wtp = task.worktreePaths![repo.id]
              if (wtp) {
                try {
                  await gitService.removeWorktree(repo.repoPath, wtp, {
                    deleteBranch: true,
                    branchName: task.gitBranch,
                  })
                } catch (wtErr: any) {
                  console.warn(`[IPC] Multi-repo worktree cleanup failed (${repo.repoPath}):`, wtErr.message)
                }
              }
            })
          )
        }
      }
      // 清理：单仓库 worktree（向后兼容）
      else if (task?.worktreeEnabled && task.worktreePath && task.gitRepoPath) {
        try {
          await gitService.removeWorktree(task.gitRepoPath, task.worktreePath, {
            deleteBranch: true,
            branchName: task.gitBranch,
          })
        } catch (wtErr: any) {
          console.warn('[IPC] Worktree cleanup on delete failed:', wtErr.message)
        }
      }

      database.deleteTask(taskId)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(IPC.TASK_GET_ALL, async () => {
    try {
      return database.getAllTasks()
    } catch (error) {
      console.error('[IPC] TASK_GET_ALL error:', error)
      return []
    }
  })

  ipcMain.handle(IPC.TASK_START_SESSION, async (_event, taskId: string, config?: Partial<SessionConfig>) => {
    try {
      const task = database.getTask(taskId)
      if (!task) {
        return { success: false, error: '任务不存在' }
      }

      const allSessions = database.getAllSessions()
      const existingActive = allSessions.find(s =>
        s.taskId === taskId &&
        (s.status === 'running' || s.status === 'idle' || s.status === 'waiting_input' || s.status === 'starting')
      )
      if (existingActive) {
        return { success: true, sessionId: existingActive.id, reused: true }
      }

      const resourceCheck = concurrencyGuard.checkResources()
      if (!resourceCheck.canCreate) {
        return { success: false, error: resourceCheck.reason }
      }

      let workDir = config?.workingDirectory || process.cwd()
      let activeWorktreePath: string | undefined
      let activeWorktreeSourceRepo: string | undefined
      const gitServiceForSession = new GitWorktreeService()

      // workDir 决策：优先工作区多仓库（取 primary 仓库的 worktree 路径）
      if (task.worktreeEnabled && task.workspaceId && task.worktreePaths) {
        const workspace = database.getWorkspace(task.workspaceId)
        const primaryRepo = workspace?.repos.find((r: any) => r.isPrimary) ?? workspace?.repos[0]
        if (primaryRepo) {
          const primaryWorktreePath = task.worktreePaths[(primaryRepo as any).id]
          if (primaryWorktreePath) {
            const healthy = await gitServiceForSession.verifyWorktree(primaryWorktreePath)
            if (healthy) {
              workDir = primaryWorktreePath
              activeWorktreePath = primaryWorktreePath
              activeWorktreeSourceRepo = (primaryRepo as any).repoPath
            } else {
              console.warn(`[IPC] Primary worktree unhealthy: ${primaryWorktreePath}, falling back to repo`)
              workDir = (primaryRepo as any).repoPath || workDir
            }
          }
        }
      }
      // 回退：单仓库 worktree（向后兼容）
      else if (task.worktreeEnabled && task.worktreePath) {
        const healthy = await gitServiceForSession.verifyWorktree(task.worktreePath)
        if (healthy) {
          workDir = task.worktreePath
          activeWorktreePath = task.worktreePath
          activeWorktreeSourceRepo = task.gitRepoPath || undefined
        } else {
          console.warn(`[IPC] Worktree unhealthy: ${task.worktreePath}, falling back to ${task.gitRepoPath || workDir}`)
          workDir = task.gitRepoPath || workDir
        }
      }

      const sessionId = uuidv4()
      const provider: AIProvider = database.getProvider(config?.providerId || 'claude-code') || BUILTIN_CLAUDE_PROVIDER
      const sessionConfig: SessionConfig = {
        id: sessionId,
        name: task.title || 'Task Session',
        taskId,
        autoAccept: config?.autoAccept,
        claudeArgs: config?.claudeArgs,
        initialPrompt: config?.initialPrompt,
        providerId: provider.id,
        ...config,
        workingDirectory: workDir,
      }
      if (activeWorktreePath) {
        sessionConfig.worktreePath = activeWorktreePath
        sessionConfig.worktreeBranch = task.gitBranch || undefined
        sessionConfig.worktreeSourceRepo = activeWorktreeSourceRepo
      }

      sessionManagerV2?.createSession(sessionConfig, provider)
      concurrencyGuard.registerSession()

      // 注入 Workspace 多仓库上下文（追加到 .claude/rules/spectrai-session.md）
      if (task.workspaceId && task.worktreePaths) {
        try {
          const workspace = database.getWorkspace(task.workspaceId)
          if (workspace) {
            const reposForSection = workspace.repos.map((r: any) => ({
              name: r.name,
              worktreePath: task.worktreePaths![r.id] || r.repoPath,
              isPrimary: r.isPrimary,
            }))
            injectWorkspaceSection(workDir, reposForSection)
          }
        } catch (injectErr: any) {
          console.warn('[IPC] Failed to inject workspace section:', injectErr.message)
        }
      }

      database.createSession({
        id: sessionId,
        name: sessionConfig.name,
        workingDirectory: sessionConfig.workingDirectory,
        status: 'running',
        estimatedTokens: 0,
        config: sessionConfig,
        taskId,
        providerId: provider.id
      })

      database.recordDirectoryUsage(sessionConfig.workingDirectory)

      if (task.status === 'todo' || task.status === 'waiting') {
        database.updateTask(taskId, { status: 'in_progress' })
        if (taskCoordinator) {
          taskCoordinator.emit('task-updated', taskId, { status: 'in_progress' })
        }
      }

      return { success: true, sessionId, reused: false }
    } catch (error: any) {
      console.error('[IPC] TASK_START_SESSION error:', error)
      return { success: false, error: error.message }
    }
  })

}
