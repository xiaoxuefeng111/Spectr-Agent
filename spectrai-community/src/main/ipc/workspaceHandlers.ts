/**
 * Workspace IPC 处理器 - 工作区管理
 * 支持多仓库 git worktree 隔离、VS Code .code-workspace 导入、目录扫描
 * @author weibin
 */

import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { IPC } from '../../shared/constants'
import { GitWorktreeService } from '../git/GitWorktreeService'
import type { IpcDependencies } from './index'

function normalizePrimaryFlags<T extends { isPrimary: boolean }>(repos: T[]): T[] {
  let primaryFound = false
  return repos.map(repo => {
    if (!repo.isPrimary) return repo
    if (!primaryFound) {
      primaryFound = true
      return repo
    }
    return { ...repo, isPrimary: false }
  })
}

export function registerWorkspaceHandlers(deps: IpcDependencies): void {
  const { database } = deps
  const gitService = new GitWorktreeService()

  // ---- 查询所有工作区 ----
  ipcMain.handle(IPC.WORKSPACE_LIST, async () => {
    try {
      return database.getAllWorkspaces()
    } catch (error: any) {
      console.error('[IPC] WORKSPACE_LIST error:', error)
      return []
    }
  })

  // ---- 查询单个工作区 ----
  ipcMain.handle(IPC.WORKSPACE_GET, async (_event, workspaceId: string) => {
    try {
      return database.getWorkspace(workspaceId) ?? null
    } catch (error: any) {
      console.error('[IPC] WORKSPACE_GET error:', error)
      return null
    }
  })

  // ---- 创建工作区 ----
  ipcMain.handle(IPC.WORKSPACE_CREATE, async (_event, data: {
    name: string
    description?: string
    rootPath?: string
    repos: Array<{ repoPath: string; name: string; isPrimary: boolean }>
  }) => {
    try {
      if (!data.name?.trim()) {
        return { success: false, error: '工作区名称不能为空' }
      }
      if (!data.repos || data.repos.length === 0) {
        return { success: false, error: '至少需要添加一个仓库' }
      }

      // 验证所有仓库路径均为有效 git 仓库
      for (const repo of data.repos) {
        const valid = await gitService.isGitRepo(repo.repoPath)
        if (!valid) {
          return { success: false, error: `路径不是 git 仓库: ${repo.repoPath}` }
        }
      }

      const normalizedRepos = normalizePrimaryFlags(data.repos)

      const workspaceId = uuidv4()
      const repos = normalizedRepos.map((r, i) => ({
        id: uuidv4(),
        repoPath: r.repoPath,
        name: r.name || path.basename(r.repoPath),
        isPrimary: r.isPrimary,
        sortOrder: i,
      }))

      database.createWorkspace(
        {
          id: workspaceId,
          name: data.name.trim(),
          description: data.description?.trim(),
          rootPath: data.rootPath,
        },
        repos
      )

      console.log(`[IPC] Workspace created: ${workspaceId} (${data.repos.length} repos)`)
      return { success: true, workspaceId }
    } catch (error: any) {
      console.error('[IPC] WORKSPACE_CREATE error:', error)
      return { success: false, error: error.message }
    }
  })

  // ---- 更新工作区 ----
  ipcMain.handle(IPC.WORKSPACE_UPDATE, async (_event, workspaceId: string, data: {
    name?: string
    description?: string
    rootPath?: string
    repos?: Array<{ id?: string; repoPath: string; name: string; isPrimary: boolean; sortOrder?: number }>
  }) => {
    try {
      const existing = database.getWorkspace(workspaceId)
      if (!existing) {
        return { success: false, error: '工作区不存在' }
      }

      // 若有仓库更新，验证路径合法性
      const normalizedRepos = data.repos ? normalizePrimaryFlags(data.repos) : undefined
      if (normalizedRepos) {
        for (const repo of normalizedRepos) {
          const valid = await gitService.isGitRepo(repo.repoPath)
          if (!valid) {
            return { success: false, error: `路径不是 git 仓库: ${repo.repoPath}` }
          }
        }
      }

      const reposForUpdate = normalizedRepos?.map((r, i) => ({
        id: r.id || uuidv4(),
        repoPath: r.repoPath,
        name: r.name || path.basename(r.repoPath),
        isPrimary: r.isPrimary,
        sortOrder: r.sortOrder ?? i,
      }))

      database.updateWorkspace(workspaceId, {
        name: data.name,
        description: data.description,
        rootPath: data.rootPath,
      }, reposForUpdate)

      return { success: true }
    } catch (error: any) {
      console.error('[IPC] WORKSPACE_UPDATE error:', error)
      return { success: false, error: error.message }
    }
  })

  // ---- 删除工作区 ----
  ipcMain.handle(IPC.WORKSPACE_DELETE, async (_event, workspaceId: string) => {
    try {
      const existing = database.getWorkspace(workspaceId)
      if (!existing) {
        return { success: false, error: '工作区不存在' }
      }
      database.deleteWorkspace(workspaceId)
      return { success: true }
    } catch (error: any) {
      console.error('[IPC] WORKSPACE_DELETE error:', error)
      return { success: false, error: error.message }
    }
  })

  // ---- 扫描目录，发现子 git 仓库 ----
  ipcMain.handle(IPC.WORKSPACE_SCAN_REPOS, async (_event, dirPath: string) => {
    try {
      if (!fs.existsSync(dirPath)) {
        return { success: false, error: '目录不存在', repos: [] }
      }

      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      const results: Array<{ repoPath: string; name: string }> = []

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const subPath = path.join(dirPath, entry.name)
        // 跳过隐藏目录
        if (entry.name.startsWith('.')) continue
        try {
          const isRepo = await gitService.isGitRepo(subPath)
          if (isRepo) {
            results.push({ repoPath: subPath, name: entry.name })
          }
        } catch {
          // 跳过无法访问的目录
        }
      }

      return { success: true, repos: results }
    } catch (error: any) {
      console.error('[IPC] WORKSPACE_SCAN_REPOS error:', error)
      return { success: false, error: error.message, repos: [] }
    }
  })

  // ---- 导入 VS Code .code-workspace 文件 ----
  ipcMain.handle(IPC.WORKSPACE_IMPORT_VSCODE, async (_event, filePath: string) => {
    try {
      if (!fs.existsSync(filePath)) {
        return { success: false, error: '文件不存在', repos: [] }
      }

      const raw = fs.readFileSync(filePath, 'utf-8')
      // .code-workspace 文件可能有 JSON 注释（JSONC 格式），需要容错
      // 使用逐字符解析，避免盲目正则误删字符串内的 //（如 URL）
      let parsed: any
      try {
        // 先尝试标准 JSON
        parsed = JSON.parse(raw)
      } catch {
        // JSONC 注释剥离：逐行处理行注释，跳过字符串内的 //
        const stripped = raw
          .split('\n')
          .map(line => {
            let inString = false
            let escape = false
            for (let i = 0; i < line.length; i++) {
              const ch = line[i]
              if (escape) { escape = false; continue }
              if (ch === '\\' && inString) { escape = true; continue }
              if (ch === '"') { inString = !inString; continue }
              if (!inString && ch === '/' && line[i + 1] === '/') {
                return line.substring(0, i) // 行注释开始，截断
              }
            }
            return line
          })
          .join('\n')
          // 块注释（/*...*/），.code-workspace 中较少见但兼容处理
          .replace(/\/\*[\s\S]*?\*\//g, '')
        parsed = JSON.parse(stripped)
      }

      if (!parsed.folders || !Array.isArray(parsed.folders)) {
        return { success: false, error: '无效的 .code-workspace 文件（缺少 folders 字段）', repos: [] }
      }

      const workspaceDir = path.dirname(filePath)
      const repos: Array<{ repoPath: string; name: string }> = []

      for (const folder of parsed.folders) {
        if (!folder.path) continue
        // 解析相对/绝对路径
        const resolvedPath = path.isAbsolute(folder.path)
          ? folder.path
          : path.resolve(workspaceDir, folder.path)

        const name = folder.name || path.basename(resolvedPath)
        if (fs.existsSync(resolvedPath)) {
          repos.push({ repoPath: resolvedPath, name })
        }
      }

      if (repos.length === 0) {
        return { success: false, error: '未找到有效的仓库路径', repos: [] }
      }

      // 推荐工作区名称（取文件名去后缀）
      const suggestedName = path.basename(filePath, '.code-workspace')
      return { success: true, repos, suggestedName }
    } catch (error: any) {
      console.error('[IPC] WORKSPACE_IMPORT_VSCODE error:', error)
      return { success: false, error: error.message, repos: [] }
    }
  })
}
