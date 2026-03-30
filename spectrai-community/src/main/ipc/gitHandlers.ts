/**
 * Git / Worktree IPC 处理器
 */
import { ipcMain } from 'electron'
import { IPC } from '../../shared/constants'
import { GitWorktreeService } from '../git/GitWorktreeService'
import type { IpcDependencies } from './index'
import type { FileChangeTracker } from '../tracker/FileChangeTracker'

export function registerGitHandlers(deps: IpcDependencies, fileChangeTracker?: FileChangeTracker): void {
  // ==================== Git / Worktree ====================

  const gitService = new GitWorktreeService()

  ipcMain.handle(IPC.GIT_IS_REPO, async (_event, dirPath: string) => {
    try {
      return await gitService.isGitRepo(dirPath)
    } catch { return false }
  })

  ipcMain.handle(IPC.GIT_GET_BRANCHES, async (_event, repoPath: string) => {
    try {
      return await gitService.getBranches(repoPath)
    } catch (error) {
      console.error('[IPC] GIT_GET_BRANCHES error:', error)
      return []
    }
  })

  ipcMain.handle(IPC.GIT_GET_CURRENT_BRANCH, async (_event, repoPath: string) => {
    try {
      return await gitService.getCurrentBranch(repoPath)
    } catch (error) {
      console.error('[IPC] GIT_GET_CURRENT_BRANCH error:', error)
      return null
    }
  })

  ipcMain.handle(IPC.GIT_DETECT_MAIN_BRANCH, async (_event, repoPath: string) => {
    try {
      return await gitService.detectMainBranch(repoPath)
    } catch (error) {
      console.error('[IPC] GIT_DETECT_MAIN_BRANCH error:', error)
      return null
    }
  })

  ipcMain.handle(IPC.GIT_GET_REPO_ROOT, async (_event, dirPath: string) => {
    try {
      return await gitService.getRepoRoot(dirPath)
    } catch (error: any) {
      const msg = String(error?.message || error)
      // "not a git repository" 和 "not a git repo" 是正常情况（非 git 目录），降级为 debug
      // "ENOENT" (spawn git failed) 仅在首次出现时 warn，后续由 getGitCommand 缓存解决
      if (msg.includes('not a git repo') || msg.includes('fatal:')) {
        console.debug('[IPC] GIT_GET_REPO_ROOT: not a git repo at', dirPath)
      } else {
        console.warn('[IPC] GIT_GET_REPO_ROOT error:', error)
      }
      return null
    }
  })

  ipcMain.handle(IPC.GIT_IS_DIRTY, async (_event, dirPath: string) => {
    try {
      return await gitService.isDirty(dirPath)
    } catch (error: any) {
      const msg = String(error?.message || error)
      if (!msg.includes('not a git repo') && !msg.includes('fatal:')) {
        console.warn('[IPC] GIT_IS_DIRTY error:', error)
      }
      return false
    }
  })

  ipcMain.handle(IPC.GIT_GET_STATUS, async (_event, repoPath: string) => {
    try {
      return await gitService.getStatus(repoPath)
    } catch (error: any) {
      const msg = String(error?.message || error)
      if (!msg.includes('not a git repo') && !msg.includes('fatal:')) {
        console.warn('[IPC] GIT_GET_STATUS error:', error)
      }
      return { staged: [], unstaged: [], untracked: [] }
    }
  })

  ipcMain.handle(IPC.GIT_GET_FILE_DIFF, async (_event, repoPath: string, filePath: string, staged?: boolean, commitHash?: string) => {
    try {
      return await gitService.getFileDiff(repoPath, filePath, staged, commitHash)
    } catch (error) {
      console.error('[IPC] GIT_GET_FILE_DIFF error:', error)
      return ''
    }
  })

  ipcMain.handle(IPC.GIT_STAGE, async (_event, repoPath: string, filePaths: string[]) => {
    try {
      await gitService.stageFiles(repoPath, filePaths)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(IPC.GIT_UNSTAGE, async (_event, repoPath: string, filePaths: string[]) => {
    try {
      await gitService.unstageFiles(repoPath, filePaths)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(IPC.GIT_DISCARD, async (_event, repoPath: string, filePaths: string[]) => {
    try {
      await gitService.discardChanges(repoPath, filePaths)
      return { success: true }
    } catch (error: any) {
      console.error('[IPC] GIT_DISCARD error:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(IPC.GIT_STAGE_ALL, async (_event, repoPath: string) => {
    try {
      await gitService.stageAll(repoPath)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(IPC.GIT_COMMIT, async (_event, repoPath: string, message: string) => {
    try {
      await gitService.commit(repoPath, message)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(IPC.GIT_PULL, async (_event, repoPath: string) => {
    return await gitService.pull(repoPath)
  })

  ipcMain.handle(IPC.GIT_PUSH, async (_event, repoPath: string) => {
    return await gitService.push(repoPath)
  })

  ipcMain.handle(IPC.GIT_GET_LOG, async (_event, repoPath: string, limit?: number) => {
    try {
      return await gitService.getLog(repoPath, limit)
    } catch (error) {
      console.error('[IPC] GIT_GET_LOG error:', error)
      return []
    }
  })

  ipcMain.handle(IPC.GIT_GET_REMOTE_STATUS, async (_event, repoPath: string) => {
    try {
      return await gitService.getRemoteStatus(repoPath)
    } catch (error) {
      console.error('[IPC] GIT_GET_REMOTE_STATUS error:', error)
      return { hasUpstream: false, upstream: null, ahead: 0, behind: 0 }
    }
  })

  ipcMain.handle(IPC.GIT_GET_COMMIT_FILES, async (_event, repoPath: string, hash: string) => {
    try {
      return await gitService.getCommitFiles(repoPath, hash)
    } catch (error) {
      console.error('[IPC] GIT_GET_COMMIT_FILES error:', error)
      return []
    }
  })

  ipcMain.handle(IPC.WORKTREE_CREATE, async (_event, repoPath: string, branch: string, taskId: string) => {
    try {
      const result = await gitService.createWorktree(repoPath, branch, taskId)
      return { success: true, ...result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(IPC.WORKTREE_REMOVE, async (_event, repoPath: string, worktreePath: string, deleteBranch?: boolean, branchName?: string) => {
    try {
      await gitService.removeWorktree(repoPath, worktreePath, { deleteBranch, branchName })
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(IPC.WORKTREE_LIST, async (_event, repoPath: string) => {
    try {
      return await gitService.listWorktrees(repoPath)
    } catch (error) {
      console.error('[IPC] WORKTREE_LIST error:', error)
      return []
    }
  })

  ipcMain.handle(IPC.WORKTREE_CHECK_MERGE, async (_event, repoPath: string, worktreePath: string) => {
    try {
      return await gitService.checkMerge(repoPath, worktreePath)
    } catch (error: any) {
      return { canMerge: false, conflictingFiles: [], mainBranch: '', mainAheadCount: 0, error: error.message }
    }
  })

  ipcMain.handle(IPC.WORKTREE_MERGE, async (_event, repoPath: string, branchName: string, options?: { squash?: boolean; message?: string; cleanup?: boolean }) => {
    try {
      const result = await gitService.mergeToMain(repoPath, branchName, options)

      // ★ 记录 worktree 改动文件（在 cleanup 之前，确保 worktreePath 还有效）
      let worktreeToRemove: { path: string } | undefined
      if (options?.cleanup) {
        const worktrees = await gitService.listWorktrees(repoPath)
        const wt = worktrees.find(w => w.branch.endsWith(branchName))
        if (wt && !wt.isMain) {
          worktreeToRemove = wt
        }
      }

      if (fileChangeTracker) {
        try {
          const commitFiles = await gitService.getCommitFiles(repoPath, 'HEAD')
          const statusMap: Record<string, 'create' | 'modify' | 'delete'> = {
            A: 'create', M: 'modify', D: 'delete', R: 'modify', C: 'modify', T: 'modify'
          }
          const changedFiles = commitFiles
            .filter(f => f.path)
            .map(f => ({ path: f.path, changeType: (statusMap[f.statusCode[0]] ?? 'modify') as 'create' | 'modify' | 'delete' }))
          const worktreePath = worktreeToRemove?.path ?? ''
          const sessionId = fileChangeTracker.findSessionIdByWorkingDir(worktreePath)
          if (sessionId && changedFiles.length > 0) {
            fileChangeTracker.recordWorktreeChanges(sessionId, repoPath, changedFiles)
          }
        } catch (e) {
          console.warn('[gitHandlers] Failed to record worktree file changes:', e)
        }
      }

      // 执行 cleanup
      if (worktreeToRemove) {
        await gitService.removeWorktree(repoPath, worktreeToRemove.path, { deleteBranch: true, branchName })
      }

      return { success: true, ...result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(IPC.WORKTREE_DIFF_SUMMARY, async (_event, repoPath: string, worktreePath: string, baseCommit?: string, baseBranch?: string, worktreeBranchHint?: string) => {
    try {
      return await gitService.getDiffSummary(repoPath, worktreePath, baseCommit, baseBranch, worktreeBranchHint)
    } catch (error: any) {
      console.error('[IPC] WORKTREE_DIFF_SUMMARY error:', error)
      return { mainBranch: '', worktreeBranch: '', files: [], added: 0, modified: 0, deleted: 0, aheadCount: 0 }
    }
  })

  ipcMain.handle(IPC.WORKTREE_FILE_DIFF, async (_event, repoPath: string, worktreeBranch: string, filePath: string, baseCommit?: string, baseBranch?: string) => {
    try {
      return await gitService.getWorktreeFileDiff(repoPath, worktreeBranch, filePath, baseCommit, baseBranch)
    } catch (error: any) {
      console.error('[IPC] WORKTREE_FILE_DIFF error:', error)
      return ''
    }
  })

}
