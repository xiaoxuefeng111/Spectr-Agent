/**
 * Storage types - 数据库层共用类型和工具函数
 */

/**
 * 解析 SQLite UTC 时间戳为 Date 对象
 * SQLite CURRENT_TIMESTAMP 格式: 'YYYY-MM-DD HH:MM:SS' (UTC，无时区标记)
 * V8 的 new Date() 会将此格式当作本地时间，导致 UTC+8 差 8 小时
 * 解决：替换空格为 T 并追加 Z 后缀，标记为 UTC
 */
export function parseDbTimestamp(ts: string): Date {
  if (!ts) return new Date()
  if (ts.includes('T')) return new Date(ts)
  return new Date(ts.replace(' ', 'T') + 'Z')
}

export interface SessionLog {
  id: number
  sessionId: string
  sessionName: string
  timestamp: Date
  chunk: string
  highlight: string
}

export interface DbUsageSummary {
  totalSessions: number
  totalTokens: number
  totalMinutes: number
  todayTokens: number    // ★ 今日 token 消耗（含 SDK V2）
  todayMinutes: number   // ★ 今日活跃分钟数（含 SDK V2）
  avgTokensPerSession: number
  dailyStats: Array<{
    date: string
    tokens: number
    minutes: number
    sessions: number
  }>
}

// 数据库层使用的类型接口
export interface Task {
  id: string
  title: string
  description?: string
  status: string
  priority?: string
  tags?: string[]
  parentTaskId?: string
  createdAt?: Date
  updatedAt?: Date
  completedAt?: Date
  /** Git Worktree 隔离 */
  worktreeEnabled?: boolean
  gitRepoPath?: string
  gitBranch?: string
  worktreePath?: string
  /** Workspace 多仓库支持（优先于 gitRepoPath） */
  workspaceId?: string
  /** 多仓库 worktree 路径映射 JSON: Record<repoId, worktreePath> */
  worktreePaths?: Record<string, string>
}

// ---- Workspace 数据层类型 ----

export interface WorkspaceRepoRow {
  id: string
  workspaceId: string
  repoPath: string
  name: string
  isPrimary: boolean
  sortOrder: number
}

export interface WorkspaceRow {
  id: string
  name: string
  description?: string
  rootPath?: string
  repos: WorkspaceRepoRow[]
  createdAt?: Date
  updatedAt?: Date
}

export interface Session {
  id: string
  taskId?: string
  name: string
  workingDirectory: string
  status: string
  startedAt?: Date
  endedAt?: Date
  exitCode?: number
  estimatedTokens?: number
  config: any
  claudeSessionId?: string
  providerId?: string
  nameLocked?: boolean
}

export interface Workflow {
  id: string
  name: string
  description?: string
  definition: any
  isTemplate?: boolean
  createdAt?: Date
  updatedAt?: Date
}

export interface WorkflowExecution {
  id: string
  workflowId: string
  status: string
  variables?: any
  stepStatuses?: any
  stepOutputs?: any
  startedAt?: Date
  completedAt?: Date
}
