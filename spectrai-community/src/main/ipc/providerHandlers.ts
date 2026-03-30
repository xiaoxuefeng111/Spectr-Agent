/**
 * Provider, Directory, Usage, Search, Summary, NVM IPC 处理器
 */
import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { IPC } from '../../shared/constants'
import { BUILTIN_PROVIDERS } from '../../shared/types'
import { listInstalledNodeVersions } from '../node/NodeVersionResolver'
import type { IpcDependencies } from './index'


export function registerProviderHandlers(deps: IpcDependencies): void {
  const { database } = deps

  // ==================== Provider 相关 ====================

  ipcMain.handle(IPC.PROVIDER_GET_ALL, async () => {
    try {
      return database.getAllProviders()
    } catch (error) {
      console.error('[IPC] PROVIDER_GET_ALL error:', error)
      return [...BUILTIN_PROVIDERS]
    }
  })

  ipcMain.handle(IPC.PROVIDER_GET, async (_event, id: string) => {
    try {
      return database.getProvider(id) || null
    } catch (error) {
      console.error('[IPC] PROVIDER_GET error:', error)
      return null
    }
  })

  ipcMain.handle(IPC.PROVIDER_CREATE, async (_event, provider: any) => {
    try {
      const created = database.createProvider(provider)
      return { success: true, provider: created }
    } catch (error: any) {
      console.error('[IPC] PROVIDER_CREATE error:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(IPC.PROVIDER_UPDATE, async (_event, id: string, updates: any) => {
    try {
      database.updateProvider(id, updates)
      return { success: true }
    } catch (error: any) {
      console.error('[IPC] PROVIDER_UPDATE error:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(IPC.PROVIDER_DELETE, async (_event, id: string) => {
    try {
      const deleted = database.deleteProvider(id)
      if (!deleted) {
        return { success: false, error: '无法删除内置 Provider' }
      }
      return { success: true }
    } catch (error: any) {
      console.error('[IPC] PROVIDER_DELETE error:', error)
      return { success: false, error: error.message }
    }
  })

  // ==================== CLI 安装检测 ====================

  ipcMain.handle(IPC.PROVIDER_REORDER, async (_event, orderedIds: string[]) => {
    try {
      database.reorderProviders(orderedIds)
      return { success: true }
    } catch (error: any) {
      console.error('[IPC] PROVIDER_REORDER error:', error)
      return { success: false, error: error.message }
    }
  })

  // ==================== CLI 安装检测 ====================

  ipcMain.handle(IPC.PROVIDER_CHECK_CLI, async (_event, command: string) => {
    const normalized = (command || '').trim()
    if (!normalized) {
      return { found: false, path: null, reason: '命令为空' }
    }

    if (path.isAbsolute(normalized)) {
      if (!fs.existsSync(normalized)) {
        return { found: false, path: normalized, reason: '路径不存在' }
      }
      try {
        if (process.platform !== 'win32') {
          fs.accessSync(normalized, fs.constants.X_OK)
        }
        return { found: true, path: normalized }
      } catch {
        return { found: false, path: normalized, reason: '路径不可执行（缺少执行权限）' }
      }
    }

    try {
      const { execFileSync } = await import('child_process')
      const isWindows = process.platform === 'win32'
      // Windows 用 where，Unix/Mac 用 which
      const checker = isWindows ? 'where' : 'which'
      const output = execFileSync(checker, [normalized], { encoding: 'utf8', timeout: 4000 }).trim()
      const firstLine = output.split('\n')[0].trim()
      return { found: true, path: firstLine }
    } catch {
      return { found: false, path: null, reason: '命令未在 PATH 中找到' }
    }
  })

  // ==================== Claude Code 可执行文件检测 ====================

  /**
   * 测试 Claude Code 可执行文件（cli.js）是否可用。
   * - 传入 executablePath：直接校验该文件是否存在
   * - 不传参数：自动检测（增强 PATH + 常见路径探测 + npm root -g）
   * 返回 { found, path, error? }
   */
  ipcMain.handle(IPC.PROVIDER_TEST_EXECUTABLE, async (_event, executablePath?: string) => {
    const { execSync } = await import('child_process')
    const fs = await import('fs')
    const path = await import('path')
    const isWindows = process.platform === 'win32'

    // 模式 1：验证用户指定路径
    if (executablePath?.trim()) {
      const p = executablePath.trim()
      if (fs.existsSync(p)) {
        return { found: true, path: p }
      }
      return { found: false, path: null, error: `文件不存在：${p}` }
    }

    // 模式 2：自动检测 —— 构建增强 PATH
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (isWindows) {
      const appData = process.env.APPDATA
      if (appData) {
        const npmBin = path.join(appData, 'npm')
        const sep = ';'
        if (env.PATH && !env.PATH.split(sep).includes(npmBin)) {
          env.PATH = `${npmBin}${sep}${env.PATH}`
        }
      }
    }

    const CLI_SUBPATH = path.join('@anthropic-ai', 'claude-code', 'cli.js')

    // 2a. where/which claude → 解析 wrapper → cli.js
    try {
      const cmd = isWindows ? 'where claude' : 'which claude'
      const claudePath = execSync(cmd, { encoding: 'utf8', timeout: 5000, env })
        .trim().split(/\r?\n/)[0]
      if (claudePath) {
        try {
          const wrapperContent = fs.readFileSync(claudePath, 'utf-8')
          if (wrapperContent.match(/node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]cli\.js/)) {
            const cliJs = path.resolve(path.dirname(claudePath), 'node_modules', CLI_SUBPATH)
            if (fs.existsSync(cliJs)) return { found: true, path: cliJs }
          }
        } catch { /* ignore */ }
        // wrapper 不含 cli.js 但 claude 命令存在，也算可用
        return { found: true, path: claudePath }
      }
    } catch { /* continue */ }

    // 2b. 常见路径直接探测
    const commonPaths: string[] = isWindows
      ? [
          process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', CLI_SUBPATH) : '',
        ].filter(Boolean)
      : [
          `/opt/homebrew/lib/node_modules/${CLI_SUBPATH}`,
          `/usr/local/lib/node_modules/${CLI_SUBPATH}`,
          `/usr/lib/node_modules/${CLI_SUBPATH}`,
        ]

    for (const p of commonPaths) {
      if (p && fs.existsSync(p)) return { found: true, path: p }
    }

    // 2c. npm root -g
    try {
      const npmRoot = execSync('npm root -g', { encoding: 'utf8', timeout: 5000, env }).trim()
      const globalCliJs = path.join(npmRoot, CLI_SUBPATH)
      if (fs.existsSync(globalCliJs)) return { found: true, path: globalCliJs }
    } catch { /* ignore */ }

    return { found: false, path: null, error: '未找到 Claude Code CLI，请安装后重试或手动指定路径' }
  })

  // ==================== Directory 相关 ====================

  ipcMain.handle(IPC.DIRECTORY_GET_RECENT, async (_event, limit?: number) => {
    try {
      return database.getRecentDirectories(limit || 8)
    } catch (error) {
      console.error('[IPC] DIRECTORY_GET_RECENT error:', error)
      return []
    }
  })

  ipcMain.handle(IPC.DIRECTORY_TOGGLE_PIN, async (_event, dirPath: string) => {
    try {
      database.toggleDirectoryPin(dirPath)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(IPC.DIRECTORY_REMOVE, async (_event, dirPath: string) => {
    try {
      database.removeDirectory(dirPath)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  // ==================== Node 版本管理 ====================

  ipcMain.handle(IPC.NVM_LIST_VERSIONS, async () => {
    try {
      return listInstalledNodeVersions()
    } catch (error) {
      console.error('[IPC] NVM_LIST_VERSIONS error:', error)
      return []
    }
  })

  // ==================== Search 相关 ====================

  ipcMain.handle(IPC.SEARCH_LOGS, async (_event, query: string, sessionId?: string, limit?: number) => {
    try {
      return database.searchLogs(query, sessionId, limit || 100)
    } catch (error) {
      console.error('[IPC] SEARCH_LOGS error:', error)
      return []
    }
  })

  // ==================== Usage 相关 ====================

  ipcMain.handle(IPC.USAGE_GET_SUMMARY, async () => {
    try {
      // SDK V2：outputParser 已移除，仅返回数据库中的持久化统计
      const dbSummary = database.getUsageSummary()
      return {
        totalTokens: dbSummary.totalTokens,
        totalMinutes: dbSummary.totalMinutes,
        todayTokens: dbSummary.todayTokens,
        todayMinutes: dbSummary.todayMinutes,
        activeSessions: 0,
        sessionBreakdown: {}
      }
    } catch (error) {
      console.error('[IPC] USAGE_GET_SUMMARY error:', error)
      return { totalTokens: 0, totalMinutes: 0, todayTokens: 0, todayMinutes: 0, activeSessions: 0, sessionBreakdown: {} }
    }
  })

  ipcMain.handle(IPC.USAGE_GET_HISTORY, async (_event, days?: number) => {
    try {
      return database.getUsageHistory(days || 30)
    } catch (error) {
      console.error('[IPC] USAGE_GET_HISTORY error:', error)
      return { dailyStats: [], sessionStats: [] }
    }
  })

  ipcMain.handle(IPC.USAGE_FLUSH, async () => {
    // SDK V2：outputParser 已移除，直接返回成功（数据已实时写入 DB）
    return { success: true }
  })

  // ==================== Session Summary 相关 ====================

  ipcMain.handle('summary:get-latest', async (_event, sessionId: string) => {
    try {
      return database.getLatestSummary(sessionId)
    } catch (error) {
      console.error('[IPC] summary:get-latest error:', error)
      return null
    }
  })

  ipcMain.handle('summary:get-all', async (_event, sessionId: string, limit?: number) => {
    try {
      return database.getSessionSummaries(sessionId, limit || 20)
    } catch (error) {
      console.error('[IPC] summary:get-all error:', error)
      return []
    }
  })

  ipcMain.handle('summary:get-all-sessions', async () => {
    try {
      return database.getAllSessionLatestSummaries()
    } catch (error) {
      console.error('[IPC] summary:get-all-sessions error:', error)
      return []
    }
  })

}
