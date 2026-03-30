/**
 * Git 面板状态管理 — 增强版
 * 按仓库根目录聚合所有 session 的 git 信息，支持完整 git 操作
 */
import { create } from 'zustand'

export interface GitRemoteStatus {
  hasUpstream: boolean
  upstream: string | null
  ahead: number
  behind: number
}

export interface GitRepoInfo {
  repoRoot: string
  branch: string
  isDirty: boolean
  remoteStatus: GitRemoteStatus
  worktrees: Array<{ path: string; head: string; branch: string; isMain: boolean }>
  sessions: any[]
}

export interface GitStatusResult {
  staged: Array<{ path: string; statusCode: string }>
  unstaged: Array<{ path: string; statusCode: string }>
  untracked: string[]
}

export interface GitCommit {
  hash: string
  shortHash: string
  message: string
  author: string
  relativeDate: string
  refs?: string[]
}

export interface GitOperationResult {
  success: boolean
  output: string
  error?: string
}

export type TabType = 'changes' | 'history' | 'worktrees'

interface GitState {
  repoInfoMap: Record<string, GitRepoInfo>
  dirToRepoCache: Record<string, string | null>
  loading: boolean
  lastRefreshedAt: number
  repoStatusCache: Record<string, GitStatusResult>
  repoLogCache: Record<string, GitCommit[]>
  activeTabMap: Record<string, TabType>
  operationMap: Record<string, string>

  refreshAll: (sessions: any[]) => Promise<void>
  refreshStatus: (repoRoot: string) => Promise<void>
  refreshLog: (repoRoot: string) => Promise<void>
  stageFiles: (repoRoot: string, paths: string[]) => Promise<GitOperationResult>
  unstageFiles: (repoRoot: string, paths: string[]) => Promise<GitOperationResult>
  discardFiles: (repoRoot: string, paths: string[]) => Promise<GitOperationResult>
  stageAll: (repoRoot: string) => Promise<void>
  commit: (repoRoot: string, message: string) => Promise<GitOperationResult>
  pull: (repoRoot: string) => Promise<GitOperationResult>
  push: (repoRoot: string) => Promise<GitOperationResult>
  setActiveTab: (repoRoot: string, tab: TabType) => void
  clearCache: () => void
}

function normPath(p: string): string {
  return p.replace(/\//g, '\\').toLowerCase()
}

const git = () => (window as any).spectrAI.git
const wt  = () => (window as any).spectrAI.worktree

const DEFAULT_REMOTE_STATUS: GitRemoteStatus = {
  hasUpstream: false,
  upstream: null,
  ahead: 0,
  behind: 0,
}

export const useGitStore = create<GitState>((set, get) => ({
  repoInfoMap: {},
  dirToRepoCache: {},
  loading: false,
  lastRefreshedAt: 0,
  repoStatusCache: {},
  repoLogCache: {},
  activeTabMap: {},
  operationMap: {},

  clearCache: () => set({
    repoInfoMap: {}, dirToRepoCache: {}, repoStatusCache: {},
    repoLogCache: {}, lastRefreshedAt: 0,
  }),

  setActiveTab: (repoRoot, tab) =>
    set(s => ({ activeTabMap: { ...s.activeTabMap, [normPath(repoRoot)]: tab } })),

  refreshStatus: async (repoRoot) => {
    try {
      const status = await git().getStatus(repoRoot)
      set(s => ({ repoStatusCache: { ...s.repoStatusCache, [normPath(repoRoot)]: status } }))
    } catch (err) {
      console.error('[GitStore] refreshStatus error:', err)
    }
  },

  refreshLog: async (repoRoot) => {
    try {
      const log = await git().getLog(repoRoot, 30)
      set(s => ({ repoLogCache: { ...s.repoLogCache, [normPath(repoRoot)]: log } }))
    } catch (err) {
      console.error('[GitStore] refreshLog error:', err)
    }
  },

  stageFiles: async (repoRoot, paths) => {
    const result = await git().stage(repoRoot, paths)
    await get().refreshStatus(repoRoot)
    return result ?? { success: true, output: '' }
  },

  unstageFiles: async (repoRoot, paths) => {
    const result = await git().unstage(repoRoot, paths)
    await get().refreshStatus(repoRoot)
    return result ?? { success: true, output: '' }
  },

  discardFiles: async (repoRoot, paths) => {
    const result = await git().discard(repoRoot, paths)
    await get().refreshStatus(repoRoot)
    return result ?? { success: true, output: '' }
  },

  stageAll: async (repoRoot) => {
    await git().stageAll(repoRoot)
    await get().refreshStatus(repoRoot)
  },

  commit: async (repoRoot, message) => {
    try {
      const result = await git().commit(repoRoot, message)
      if (result?.success !== false) {
        await Promise.all([get().refreshStatus(repoRoot), get().refreshLog(repoRoot)])
        // 刷新分支/脏状态/远程同步状态
        const [branch, isDirty, remoteStatus] = await Promise.all([
          git().getCurrentBranch(repoRoot).catch(() => 'unknown'),
          git().isDirty(repoRoot).catch(() => false),
          git().getRemoteStatus(repoRoot).catch(() => DEFAULT_REMOTE_STATUS),
        ])
        set(s => {
          const key = normPath(repoRoot)
          const existing = s.repoInfoMap[key]
          if (!existing) return s
          return {
            repoInfoMap: {
              ...s.repoInfoMap,
              [key]: { ...existing, branch, isDirty, remoteStatus },
            },
          }
        })
      }
      return result ?? { success: true, output: '' }
    } catch (err: any) {
      return { success: false, output: '', error: err.message }
    }
  },

  pull: async (repoRoot) => {
    const key = normPath(repoRoot)
    set(s => ({ operationMap: { ...s.operationMap, [key]: 'pull' } }))
    try {
      const result = await git().pull(repoRoot)
      // 刷新整体信息
      const sessions = Object.values(get().repoInfoMap).flatMap(r => r.sessions)
      await get().refreshAll(sessions)
      return result
    } catch (err: any) {
      return { success: false, output: err.message }
    } finally {
      set(s => { const m = { ...s.operationMap }; delete m[key]; return { operationMap: m } })
    }
  },

  push: async (repoRoot) => {
    const key = normPath(repoRoot)
    set(s => ({ operationMap: { ...s.operationMap, [key]: 'push' } }))
    try {
      const result = await git().push(repoRoot)
      const sessions = Object.values(get().repoInfoMap).flatMap(r => r.sessions)
      await get().refreshAll(sessions)
      return result
    } catch (err: any) {
      return { success: false, output: err.message }
    } finally {
      set(s => { const m = { ...s.operationMap }; delete m[key]; return { operationMap: m } })
    }
  },

  refreshAll: async (sessions) => {
    if (!sessions.length) return
    set({ loading: true })
    try {
      const dirToRepoCache = { ...get().dirToRepoCache }
      const uniqueDirs = [...new Set(
        sessions.map((s: any) => s.config?.workingDirectory).filter(Boolean)
      )] as string[]

      await Promise.all(uniqueDirs.map(async (dir) => {
        if (dir in dirToRepoCache) return
        try {
          const root = await git().getRepoRoot(dir)
          dirToRepoCache[dir] = root ?? null
        } catch {
          dirToRepoCache[dir] = null
        }
      }))

      const repoToSessions: Record<string, any[]> = {}
      for (const session of sessions) {
        const dir = session.config?.workingDirectory
        if (!dir) continue
        const root = dirToRepoCache[dir]
        if (!root) continue
        const key = normPath(root)
        if (!repoToSessions[key]) repoToSessions[key] = []
        repoToSessions[key].push(session)
      }

      const repoInfoMap: Record<string, GitRepoInfo> = {}
      await Promise.all(
        Object.entries(repoToSessions).map(async ([nk, repoSessions]) => {
          const originalRoot = Object.values(dirToRepoCache).find(
            r => r && normPath(r) === nk
          ) as string
          try {
            const [branch, isDirty, remoteStatus, worktrees] = await Promise.all([
              git().getCurrentBranch(originalRoot).catch(() => 'unknown'),
              git().isDirty(originalRoot).catch(() => false),
              git().getRemoteStatus(originalRoot).catch(() => DEFAULT_REMOTE_STATUS),
              wt().list(originalRoot).catch(() => []),
            ])
            repoInfoMap[nk] = {
              repoRoot: originalRoot,
              branch: branch || 'unknown',
              isDirty: !!isDirty,
              remoteStatus,
              worktrees: worktrees || [],
              sessions: repoSessions,
            }
          } catch {}
        })
      )

      set({ repoInfoMap, dirToRepoCache, loading: false, lastRefreshedAt: Date.now() })
    } catch (err) {
      console.error('[GitStore] refreshAll error:', err)
      set({ loading: false })
    }
  },
}))
