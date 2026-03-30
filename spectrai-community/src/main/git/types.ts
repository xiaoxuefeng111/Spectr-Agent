/**
 * Git Worktree 类型定义
 * @author weibin
 */

export interface WorktreeInfo {
  /** worktree 所在目录 */
  path: string
  /** HEAD 指向的 commit hash */
  head: string
  /** 分支名（如 refs/heads/task/xxx） */
  branch: string
  /** 是否为裸仓库的主 worktree */
  isMain: boolean
}

export interface MergeCheckResult {
  /** 目标分支（main / master 等） */
  mainBranch: string
  /** 主分支领先的 commit 数 */
  mainAheadCount: number
  /** 存在冲突的文件列表 */
  conflictingFiles: string[]
  /** 是否可安全合并 */
  canMerge: boolean
}

export interface MergeResult {
  mainBranch: string
  linesAdded: number
  linesRemoved: number
}

/** worktree 分支与主分支的差异文件 */
export interface WorktreeDiffFile {
  /** 文件路径（相对仓库根） */
  path: string
  /** 状态码: A=新增, M=修改, D=删除, R=重命名 */
  status: string
}

/** worktree 分支与主分支的差异摘要 */
export interface WorktreeDiffSummary {
  /** 主分支名 */
  mainBranch: string
  /** worktree 分支名 */
  worktreeBranch: string
  /** worktree 分支 HEAD 的 commit hash（分支删除后仍可用于 diff） */
  worktreeBranchCommit?: string
  /** 差异文件列表 */
  files: WorktreeDiffFile[]
  /** 统计: 新增文件数 */
  added: number
  /** 统计: 修改文件数 */
  modified: number
  /** 统计: 删除文件数 */
  deleted: number
  /** worktree 分支领先主分支的 commit 数 */
  aheadCount: number
}
