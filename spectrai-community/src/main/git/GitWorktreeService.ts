/**
 * Git Worktree 服务 — 管理 worktree 的增删查改 & 分支合并
 * 所有 git 操作通过 promise 链锁串行化，防止竞态条件
 * @author weibin
 */

import { execFile, execSync } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import * as fs from 'fs'
import type { WorktreeInfo, MergeCheckResult, MergeResult, WorktreeDiffSummary, WorktreeDiffFile } from './types'

const execFileAsync = promisify(execFile)

/**
 * 解析系统 git 可执行文件的完整路径（缓存结果）。
 * Electron 主进程在 Windows 上不继承完整 shell PATH，直接用 'git' 会 ENOENT。
 */
let _cachedGitCommand: string | null = null
function getGitCommand(): string {
  if (_cachedGitCommand) return _cachedGitCommand
  try {
    const cmd = process.platform === 'win32' ? 'where git' : 'which git'
    const result = execSync(cmd, { encoding: 'utf8', timeout: 5000 })
      .trim().split(/\r?\n/)[0].trim()
    if (result) {
      _cachedGitCommand = result
      return result
    }
  } catch { /* ignore */ }
  _cachedGitCommand = 'git'
  return 'git'
}

/**
 * Promise 链锁：同一仓库的 git 操作自动串行化
 * （参考 parallel-code 的 withWorktreeLock 设计）
 */
const repoLocks = new Map<string, Promise<void>>()

function withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(repoPath) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  repoLocks.set(repoPath, next.then(() => {}, () => {}))
  return next
}

export class GitWorktreeService {
  /**
   * 执行 git 命令
   */
  private async git(cwd: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(getGitCommand(), args, {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      })
      return stdout.trim()
    } catch (err: any) {
      // stderr/stdout 在未指定 encoding 时为 Buffer，需 String() 转换再 trim
      // pre-commit hook 的错误通常在 stderr；部分场景（如 husky）输出在 stdout
      const stderr = err.stderr ? String(err.stderr).trim() : ''
      const stdout = err.stdout ? String(err.stdout).trim() : ''
      const detail = stderr || stdout || err.message
      throw new Error(`git ${args.join(' ')} failed: ${detail}`)
    }
  }

  /**
   * 检查目录是否为 git 仓库
   */
  async isGitRepo(dirPath: string): Promise<boolean> {
    try {
      await this.git(dirPath, ['rev-parse', '--is-inside-work-tree'])
      return true
    } catch {
      return false
    }
  }

  /**
   * 获取仓库根目录
   */
  async getRepoRoot(dirPath: string): Promise<string> {
    return this.git(dirPath, ['rev-parse', '--show-toplevel'])
  }

  /**
   * 检测工作区是否有未提交的改动（包括 staged 和 unstaged，排除 untracked 文件）
   * untracked 文件不影响 checkout/merge 操作，不应阻止 worktree 创建
   */
  async isDirty(dirPath: string): Promise<boolean> {
    try {
      const output = await this.git(dirPath, ['status', '--porcelain', '-uno'])
      return output.length > 0
    } catch {
      return false
    }
  }

  /**
   * 获取工作区文件状态（staged / unstaged / untracked）
   */
  async getStatus(repoPath: string): Promise<{
    staged: Array<{ path: string; statusCode: string }>
    unstaged: Array<{ path: string; statusCode: string }>
    untracked: string[]
  }> {
    try {
      const output = await this.git(repoPath, ['status', '--porcelain=v1'])
      const staged: Array<{ path: string; statusCode: string }> = []
      const unstaged: Array<{ path: string; statusCode: string }> = []
      const untracked: string[] = []

      for (const line of output.split('\n').filter(Boolean)) {
        const x = line[0]  // staged status
        const y = line[1]  // unstaged status
        const rawPath = line.slice(3)
        // 处理重命名：格式为 "old -> new"，取后者
        const filePath = rawPath.includes(' -> ') ? rawPath.split(' -> ')[1] : rawPath

        if (x === '?' && y === '?') {
          untracked.push(filePath)
        } else {
          if (x !== ' ' && x !== '?') staged.push({ path: filePath, statusCode: x })
          if (y !== ' ' && y !== '?') unstaged.push({ path: filePath, statusCode: y })
        }
      }
      return { staged, unstaged, untracked }
    } catch {
      return { staged: [], unstaged: [], untracked: [] }
    }
  }

  /**
   * 获取指定文件的 diff
   * @param staged true=暂存区 diff，false=工作区 diff
   * @param commitHash 若指定，则查看该 commit 中文件的 diff
   */
  async getFileDiff(repoPath: string, filePath: string, staged = false, commitHash?: string): Promise<string> {
    // 查看某个 commit 中特定文件的 diff
    if (commitHash) {
      try {
        return await this.git(repoPath, ['diff', `${commitHash}^`, commitHash, '--', filePath])
      } catch {
        // 首个 commit 没有父节点，fallback 到 show
        return await this.git(repoPath, ['show', commitHash, '--', filePath])
      }
    }
    const args = staged
      ? ['diff', '--staged', '--', filePath]
      : ['diff', '--', filePath]
    try {
      return await this.git(repoPath, args)
    } catch {
      return ''
    }
  }

  /**
   * 暂存指定文件
   */
  async stageFiles(repoPath: string, filePaths: string[]): Promise<void> {
    await this.git(repoPath, ['add', '--', ...filePaths])
  }

  /**
   * 取消暂存指定文件
   * 兼容新仓库（无 HEAD 时用 git rm --cached）
   */
  async unstageFiles(repoPath: string, filePaths: string[]): Promise<void> {
    try {
      await this.git(repoPath, ['reset', 'HEAD', '--', ...filePaths])
    } catch (err: any) {
      // 新仓库没有 HEAD 时 reset 会失败，改用 git rm --cached
      if (err.message?.includes('HEAD') || err.message?.includes('ambiguous')) {
        await this.git(repoPath, ['rm', '--cached', '--', ...filePaths])
      } else {
        throw err
      }
    }
  }

  /**
   * 丢弃工作区改动（还原文件到 HEAD 或 index 版本）
   * 等价于 git restore <file> / git checkout -- <file>
   * 注意：此操作不可逆，会丢失未提交的本地修改
   */
  async discardChanges(repoPath: string, filePaths: string[]): Promise<void> {
    // 优先用 git restore（Git 2.23+），回退到 git checkout --
    try {
      await this.git(repoPath, ['restore', '--', ...filePaths])
    } catch {
      await this.git(repoPath, ['checkout', '--', ...filePaths])
    }
  }

  /**
   * 暂存所有改动（git add -A）
   */
  async stageAll(repoPath: string): Promise<void> {
    await this.git(repoPath, ['add', '-A'])
  }

  /**
   * 提交暂存区（git commit -m）
   */
  async commit(repoPath: string, message: string): Promise<void> {
    await this.git(repoPath, ['commit', '-m', message])
  }

  /**
   * 从远程拉取（git pull）
   */
  async pull(repoPath: string): Promise<{ success: boolean; output: string }> {
    try {
      const output = await this.git(repoPath, ['pull'])
      return { success: true, output }
    } catch (err: any) {
      return { success: false, output: err.message || String(err) }
    }
  }

  /**
   * 推送到远程（git push）
   */
  async push(repoPath: string): Promise<{ success: boolean; output: string }> {
    try {
      const output = await this.git(repoPath, ['push'])
      return { success: true, output }
    } catch (err: any) {
      return { success: false, output: err.message || String(err) }
    }
  }

  /**
   * 获取当前分支与上游分支同步状态
   */
  async getRemoteStatus(repoPath: string): Promise<{
    hasUpstream: boolean
    upstream: string | null
    ahead: number
    behind: number
  }> {
    try {
      const branch = await this.getCurrentBranch(repoPath)
      if (!branch || branch === 'HEAD') {
        return { hasUpstream: false, upstream: null, ahead: 0, behind: 0 }
      }

      let upstream: string
      try {
        upstream = await this.git(repoPath, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`])
      } catch {
        return { hasUpstream: false, upstream: null, ahead: 0, behind: 0 }
      }

      const counts = await this.git(repoPath, ['rev-list', '--left-right', '--count', `${branch}...${upstream}`])
      const [aheadStr, behindStr] = counts.trim().split(/\s+/)

      return {
        hasUpstream: true,
        upstream,
        ahead: parseInt(aheadStr || '0', 10) || 0,
        behind: parseInt(behindStr || '0', 10) || 0,
      }
    } catch {
      return { hasUpstream: false, upstream: null, ahead: 0, behind: 0 }
    }
  }

  // 获取提交历史（带 refs 信息）
  async getLog(repoPath: string, limit = 20): Promise<Array<{
    hash: string
    shortHash: string
    message: string
    author: string
    relativeDate: string
    refs: string[]
  }>> {
    try {
      const fieldSep = '\x1f'
      const recordSep = '\x1e'
      const output = await this.git(repoPath, [
        'log',
        `--max-count=${limit}`,
        `--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar%x1f%D%x1e`,
      ])

      return output
        .split(recordSep)
        .map(item => item.trim())
        .filter(Boolean)
        .map(line => {
          const parts = line.split(fieldSep)
          const refsRaw = parts[5] || ''
          return {
            hash: parts[0] || '',
            shortHash: parts[1] || '',
            message: parts[2] || '',
            author: parts[3] || '',
            relativeDate: parts[4] || '',
            refs: refsRaw.split(',').map(ref => ref.trim()).filter(Boolean),
          }
        })
    } catch {
      return []
    }
  }

  /**
   * 获取某个 commit 修改的文件列表
   */
  async getCommitFiles(repoPath: string, hash: string): Promise<Array<{ path: string; statusCode: string }>> {
    try {
      // -m --first-parent 确保 merge commit 也能正确列出相对第一父节点的变动文件
      const output = await this.git(repoPath, ['diff-tree', '--no-commit-id', '-r', '-m', '--first-parent', '--name-status', hash])
      return output.split('\n').filter(Boolean).map(line => {
        const parts = line.split('\t')
        const raw = parts[0].trim()
        // R100\told\tnew → statusCode='R', path=new
        const statusCode = raw[0]
        const filePath = parts.length >= 3 ? parts[2] : parts[1] || ''
        return { statusCode, path: filePath }
      })
    } catch {
      return []
    }
  }

  /**
   * 获取当前分支名
   */
  async getCurrentBranch(repoPath: string): Promise<string> {
    return this.git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  }

  /**
   * 获取 HEAD 的完整 commit hash
   */
  async getHeadCommit(repoPath: string): Promise<string> {
    return (await this.git(repoPath, ['rev-parse', 'HEAD'])).trim()
  }

  /**
   * 解析任意 ref（分支名、tag、commit hash 等）为完整 commit hash
   */
  async resolveRef(repoPath: string, ref: string): Promise<string> {
    return (await this.git(repoPath, ['rev-parse', ref])).trim()
  }

  /**
   * 检测主分支名（main 或 master）
   */
  async detectMainBranch(repoPath: string): Promise<string> {
    try {
      await this.git(repoPath, ['rev-parse', '--verify', 'refs/heads/main'])
      return 'main'
    } catch {
      try {
        await this.git(repoPath, ['rev-parse', '--verify', 'refs/heads/master'])
        return 'master'
      } catch {
        // 回退到当前分支
        return this.getCurrentBranch(repoPath)
      }
    }
  }

  /**
   * 获取所有本地分支
   */
  async getBranches(repoPath: string): Promise<string[]> {
    const output = await this.git(repoPath, ['branch', '--format=%(refname:short)'])
    return output.split('\n').filter(Boolean)
  }

  /**
   * 检查分支是否存在
   */
  async branchExists(repoPath: string, branch: string): Promise<boolean> {
    try {
      await this.git(repoPath, ['rev-parse', '--verify', `refs/heads/${branch}`])
      return true
    } catch {
      return false
    }
  }

  /**
   * 计算 worktree 目标目录
   * 统一放在 仓库根/.spectrai-worktrees/<taskId>/
   */
  getWorktreeBasePath(repoPath: string, taskId: string): string {
    return path.join(repoPath, '.spectrai-worktrees', taskId)
  }

  /**
   * 创建 worktree（含分支创建 + 锁保护）
   */
  async createWorktree(
    repoPath: string,
    branch: string,
    taskId: string,
  ): Promise<{ worktreePath: string; branch: string }> {
    return withRepoLock(repoPath, async () => {
      const worktreePath = this.getWorktreeBasePath(repoPath, taskId)

      // 安全检查：目标目录不应已存在
      if (fs.existsSync(worktreePath)) {
        // 可能是上次创建失败残留，尝试清理
        try {
          await this.git(repoPath, ['worktree', 'remove', '--force', worktreePath])
        } catch {
          // 忽略，后面 add 会报错
        }
      }

      // 确保父目录存在
      const parentDir = path.dirname(worktreePath)
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true })
      }

      // 如果分支已存在，直接 checkout；否则创建新分支
      const exists = await this.branchExists(repoPath, branch)
      if (exists) {
        await this.git(repoPath, ['worktree', 'add', worktreePath, branch])
      } else {
        await this.git(repoPath, ['worktree', 'add', '-b', branch, worktreePath])
      }

      // 确保 .spectrai-worktrees 被 .gitignore
      await this.ensureGitignore(repoPath)

      console.log(`[GitWorktree] Created worktree: ${worktreePath} (branch: ${branch})`)
      return { worktreePath, branch }
    })
  }

  /**
   * 移除 worktree（含锁保护）
   */
  async removeWorktree(
    repoPath: string,
    worktreePath: string,
    options?: { deleteBranch?: boolean; branchName?: string },
  ): Promise<void> {
    return withRepoLock(repoPath, async () => {
      // 移除 worktree
      if (fs.existsSync(worktreePath)) {
        try {
          await this.git(repoPath, ['worktree', 'remove', '--force', worktreePath])
        } catch (err) {
          // 如果 worktree 目录被外部删除，prune 清理残留引用
          console.warn(`[GitWorktree] worktree remove failed, trying prune:`, err)
          await this.git(repoPath, ['worktree', 'prune'])
        }
      } else {
        // 目录不存在，清理可能的残留
        await this.git(repoPath, ['worktree', 'prune'])
      }

      // 可选删除分支
      if (options?.deleteBranch && options?.branchName) {
        try {
          await this.git(repoPath, ['branch', '-D', options.branchName])
          console.log(`[GitWorktree] Deleted branch: ${options.branchName}`)
        } catch (err) {
          console.warn(`[GitWorktree] Failed to delete branch ${options.branchName}:`, err)
        }
      }

      console.log(`[GitWorktree] Removed worktree: ${worktreePath}`)
    })
  }

  /**
   * 列出所有 worktree
   */
  async listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    const output = await this.git(repoPath, ['worktree', 'list', '--porcelain'])
    const worktrees: WorktreeInfo[] = []
    let current: Partial<WorktreeInfo> = {}

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        current.path = line.slice('worktree '.length)
      } else if (line.startsWith('HEAD ')) {
        current.head = line.slice('HEAD '.length)
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice('branch '.length)
      } else if (line === 'bare') {
        current.isMain = true
      } else if (line === '') {
        if (current.path) {
          worktrees.push({
            path: current.path,
            head: current.head || '',
            branch: current.branch || '(detached)',
            isMain: current.isMain || worktrees.length === 0,
          })
        }
        current = {}
      }
    }

    return worktrees
  }

  /**
   * 验证 worktree 健康状态
   */
  async verifyWorktree(worktreePath: string): Promise<boolean> {
    try {
      if (!fs.existsSync(worktreePath)) return false
      await this.git(worktreePath, ['rev-parse', '--is-inside-work-tree'])
      return true
    } catch {
      return false
    }
  }

  /**
   * 合并前冲突检测（使用 git merge-tree，不修改工作区）
   * @param targetBranch 合并目标分支（优先使用，避免 detectMainBranch 误判）
   */
  async checkMerge(repoPath: string, worktreePath: string, targetBranch?: string): Promise<MergeCheckResult> {
    const mainBranch = targetBranch || await this.detectMainBranch(repoPath)
    const taskBranch = await this.getCurrentBranch(worktreePath)

    const conflictingFiles: string[] = []
    let mainAheadCount = 0

    try {
      // 统计主分支领先的 commit 数
      const aheadOutput = await this.git(repoPath, [
        'rev-list', '--count', `${taskBranch}..${mainBranch}`,
      ])
      mainAheadCount = parseInt(aheadOutput, 10) || 0
    } catch {
      // 忽略
    }

    try {
      // git merge-tree 预测冲突（不修改文件）
      await this.git(repoPath, ['merge-tree', '--write-tree', mainBranch, taskBranch])
    } catch (err: any) {
      const errStr = String(err)
      // 解析冲突文件路径
      for (const line of errStr.split('\n')) {
        // merge-tree 冲突行格式: "CONFLICT (content): ..."
        const match = line.match(/CONFLICT.*?:\s*Merge conflict in (.+)/)
        if (match) {
          conflictingFiles.push(match[1].trim())
        }
      }
    }

    return {
      mainBranch,
      mainAheadCount,
      conflictingFiles,
      canMerge: conflictingFiles.length === 0,
    }
  }

  /**
   * 合并 worktree 分支到主分支（含锁保护）
   * @param options.targetBranch 合并目标分支（优先使用，避免 detectMainBranch 误判）
   */
  async mergeToMain(
    repoPath: string,
    branchName: string,
    options?: { squash?: boolean; message?: string; cleanup?: boolean; targetBranch?: string },
  ): Promise<MergeResult> {
    return withRepoLock(repoPath, async () => {
      const mainBranch = options?.targetBranch || await this.detectMainBranch(repoPath)
      const currentBranch = await this.getCurrentBranch(repoPath)

      // 切到主分支
      if (currentBranch !== mainBranch) {
        await this.git(repoPath, ['checkout', mainBranch])
      }

      // 合并
      const mergeArgs = ['merge']
      if (options?.squash) {
        mergeArgs.push('--squash')
      }
      mergeArgs.push(branchName)
      await this.git(repoPath, mergeArgs)

      // squash 需要额外 commit
      if (options?.squash) {
        const msg = options.message || `Merge task branch ${branchName}`
        await this.git(repoPath, ['commit', '-m', msg])
      }

      // 获取变更统计
      let linesAdded = 0
      let linesRemoved = 0
      try {
        const stat = await this.git(repoPath, ['diff', '--stat', 'HEAD~1'])
        const match = stat.match(/(\d+) insertions?\(\+\)/)
        const match2 = stat.match(/(\d+) deletions?\(-\)/)
        if (match) linesAdded = parseInt(match[1], 10)
        if (match2) linesRemoved = parseInt(match2[1], 10)
      } catch {
        // 忽略统计错误
      }

      return { mainBranch, linesAdded, linesRemoved }
    })
  }

  /**
   * 确保 .spectrai-worktrees 在 .gitignore 中
   */
  private async ensureGitignore(repoPath: string): Promise<void> {
    const gitignorePath = path.join(repoPath, '.gitignore')
    const entry = '.spectrai-worktrees/'

    try {
      if (fs.existsSync(gitignorePath)) {
        const content = fs.readFileSync(gitignorePath, 'utf-8')
        if (content.includes(entry)) return
        // 追加
        fs.appendFileSync(gitignorePath, `\n# SpectrAI worktree isolation\n${entry}\n`)
      } else {
        fs.writeFileSync(gitignorePath, `# SpectrAI worktree isolation\n${entry}\n`, 'utf-8')
      }
    } catch (err) {
      console.warn('[GitWorktree] Failed to update .gitignore:', err)
    }
  }

  /**
   * 获取 worktree 分支与主分支之间的差异文件摘要
   * 用于在会话列表和 Git Panel 中展示 worktree 的改动概览
   */
  /**
   * 获取 worktree 分支与基准的差异摘要
   * @param baseCommit 创建 worktree 时记录的基准 commit hash（最精确）
   * @param baseBranch 创建 worktree 时的源分支名（如 sdk-v2），避免 detectMainBranch 误判
   * @param worktreeBranchHint worktree 分支名或 commit hash（当 worktree 目录已删除时的回退）
   */
  async getDiffSummary(repoPath: string, worktreePath: string, baseCommit?: string, baseBranch?: string, worktreeBranchHint?: string): Promise<WorktreeDiffSummary> {
    const mainBranch = baseBranch || await this.detectMainBranch(repoPath)

    // 获取 worktree 分支名：优先从 worktree 目录读取，失败时用 hint 回退
    let worktreeBranch = ''
    try {
      worktreeBranch = await this.getCurrentBranch(worktreePath)
    } catch {
      // worktree 目录可能已被删除（merge+cleanup 后），使用调用方传入的 hint
      worktreeBranch = worktreeBranchHint || ''
    }

    if (!worktreeBranch && !worktreeBranchHint) {
      // 既无法从目录获取分支，也没有 hint，返回空摘要
      return { mainBranch, worktreeBranch: '', files: [], added: 0, modified: 0, deleted: 0, aheadCount: 0 }
    }

    // 解析 worktree 分支的 commit hash，分支删除后仍可用于 diff
    let worktreeBranchCommit = ''
    try {
      worktreeBranchCommit = (await this.git(repoPath, ['rev-parse', worktreeBranch])).trim()
    } catch {
      // 分支可能已删除，尝试用 hint（可能是 commit hash）
      if (worktreeBranchHint && worktreeBranchHint !== worktreeBranch) {
        try {
          worktreeBranchCommit = (await this.git(repoPath, ['rev-parse', worktreeBranchHint])).trim()
        } catch { /* hint 也无效 */ }
      }
    }

    // 确定比较目标：优先用 commit hash（分支删除后仍有效），否则用分支名
    const target = worktreeBranchCommit || worktreeBranch
    if (!target) {
      return { mainBranch, worktreeBranch: worktreeBranchHint || '', files: [], added: 0, modified: 0, deleted: 0, aheadCount: 0 }
    }
    const base = await this.resolveBaseRef(repoPath, mainBranch, target, baseCommit)

    // 计算领先 commit 数
    let aheadCount = 0
    try {
      const output = await this.git(repoPath, [
        'rev-list', '--count', `${base}..${target}`,
      ])
      aheadCount = parseInt(output, 10) || 0
    } catch { /* 分支不存在或无共同祖先 */ }

    // 获取差异文件列表
    const files = await this.parseDiffNameStatus(repoPath, base, target)

    // 统计
    let added = 0, modified = 0, deleted = 0
    for (const f of files) {
      if (f.status === 'A') added++
      else if (f.status === 'D') deleted++
      else modified++
    }

    return { mainBranch, worktreeBranch, worktreeBranchCommit: worktreeBranchCommit || undefined, files, added, modified, deleted, aheadCount }
  }

  /**
   * 获取 worktree 分支中某个文件与基准的具体差异
   * @param baseCommit 创建 worktree 时记录的基准 commit hash（最精确）
   * @param baseBranch 创建 worktree 时的源分支名
   */
  async getWorktreeFileDiff(repoPath: string, worktreeBranch: string, filePath: string, baseCommit?: string, baseBranch?: string): Promise<string> {
    const mainBranch = baseBranch || await this.detectMainBranch(repoPath)

    // 解析 target：优先用分支名，分支已删除时尝试当作 commit hash 使用
    let target = worktreeBranch
    try {
      await this.git(repoPath, ['rev-parse', '--verify', worktreeBranch])
    } catch {
      // 分支名无效，worktreeBranch 可能本身就是 commit hash（由渲染端传入）
      // 不做额外处理，直接用 worktreeBranch 尝试（如果是 hash 则 git diff 能识别）
    }

    const base = await this.resolveBaseRef(repoPath, mainBranch, target, baseCommit)
    try {
      return await this.git(repoPath, [
        'diff', `${base}..${target}`, '--', filePath,
      ])
    } catch { return '' }
  }

  /**
   * 解析 diff --name-status 输出为文件列表
   */
  private async parseDiffNameStatus(repoPath: string, base: string, target: string): Promise<WorktreeDiffFile[]> {
    const files: WorktreeDiffFile[] = []
    try {
      const output = await this.git(repoPath, [
        'diff', '--name-status', `${base}..${target}`,
      ])
      for (const line of output.split('\n').filter(Boolean)) {
        const parts = line.split('\t')
        const status = parts[0].trim()[0] // R100 → R, C100 → C
        const filePath = parts.length >= 3 ? parts[2] : parts[1] || ''
        if (filePath) files.push({ path: filePath, status })
      }
    } catch { /* 忽略 */ }
    return files
  }

  /**
   * 解析比较基准 ref：
   * 1. 有 baseCommit → 直接用（合并后依然有效）
   * 2. 无 baseCommit → 尝试 merge-base（未合并时有效）
   * 3. merge-base 等于 worktreeBranch HEAD → 说明已合并，
   *    尝试从 merge commit 的第一个 parent 恢复 fork point
   */
  private async resolveBaseRef(
    repoPath: string,
    mainBranch: string,
    worktreeBranch: string,
    baseCommit?: string,
  ): Promise<string> {
    // 有明确的 baseCommit，直接使用
    if (baseCommit) return baseCommit

    // 尝试找 merge-base
    try {
      const mergeBase = (await this.git(repoPath, [
        'merge-base', mainBranch, worktreeBranch,
      ])).trim()
      const worktreeHead = (await this.git(repoPath, [
        'rev-parse', worktreeBranch,
      ])).trim()

      // merge-base 不等于 worktree HEAD → 分支未合并，正常情况
      if (mergeBase !== worktreeHead) return mergeBase

      // merge-base === worktree HEAD → 已合并回主分支
      // 尝试找主分支上合并该分支的 merge commit 的第一个 parent
      try {
        // 找包含 worktree 分支 HEAD 的 merge commit
        const mergeCommits = (await this.git(repoPath, [
          'log', '--merges', '--ancestry-path', `${worktreeHead}..${mainBranch}`,
          '--format=%H %P', '-10',
        ])).trim()
        for (const line of mergeCommits.split('\n').filter(Boolean)) {
          const parts = line.split(' ')
          const parents = parts.slice(1)
          // merge commit 的第二个 parent 是被合并的分支
          if (parents.length >= 2 && parents.some(p => p.startsWith(worktreeHead.slice(0, 8)))) {
            return parents[0] // 第一个 parent = 合并前的主分支位置
          }
        }
        // 如果没找到精确匹配，用第一个 merge commit 的第一个 parent
        if (mergeCommits) {
          const firstLine = mergeCommits.split('\n')[0]
          const parts = firstLine.split(' ')
          if (parts.length >= 2) return parts[1]
        }
      } catch { /* ignore */ }

      return mergeBase // 最终 fallback
    } catch {
      return mainBranch // 无法计算 merge-base，直接用分支名
    }
  }

  /**
   * 将任务标题转为合法的 git 分支名
   */
  static slugifyBranch(title: string, prefix = 'task'): string {
    const slug = title
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5\s-]/g, '')  // 保留中文、字母、数字、空格、连字符
      .replace(/[\s_]+/g, '-')                   // 空格/下划线 → 连字符
      .replace(/-+/g, '-')                       // 多个连字符合并
      .replace(/^-|-$/g, '')                     // 去首尾连字符
      .slice(0, 40)                              // 截断

    return slug ? `${prefix}/${slug}` : `${prefix}/${Date.now()}`
  }
}
