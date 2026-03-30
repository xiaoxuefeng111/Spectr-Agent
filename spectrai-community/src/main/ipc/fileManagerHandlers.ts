/**
 * 文件管理器 IPC 处理器
 * 提供目录列表、文件读取、系统打开、目录监听等能力
 * @author weibin
 */

import { ipcMain, shell } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import type { FileEntry, DirListing, FileWatchEvent } from '../../shared/fileManagerTypes'
import { sendToRenderer } from './shared'
import type { IpcDependencies } from './index'
import type { FileChangeTracker } from '../tracker/FileChangeTracker'

/** 最大可读取文件大小：5MB */
const MAX_READ_SIZE = 5 * 1024 * 1024

/** 活跃的目录监听器，key 为规范化的目录绝对路径 */
const watchers = new Map<string, fs.FSWatcher>()

export function registerFileManagerHandlers(
  _deps: IpcDependencies,
  fileChangeTracker?: FileChangeTracker
): void {

  // ==================== list-dir：列出目录内容 ====================

  ipcMain.handle('file-manager:list-dir', async (_event, { path: dirPath }: { path: string }) => {
    try {
      const normalizedPath = path.normalize(dirPath)
      const dirents = await fs.promises.readdir(normalizedPath, { withFileTypes: true })

      const entries: FileEntry[] = []

      for (const dirent of dirents) {
        const entryPath = path.join(normalizedPath, dirent.name)
        const isDir = dirent.isDirectory()
        const isHidden = dirent.name.startsWith('.')

        const entry: FileEntry = {
          name: dirent.name,
          path: entryPath,
          type: isDir ? 'directory' : 'file',
          isHidden,
        }

        // 获取 stat 信息（size / modified）
        try {
          const stat = await fs.promises.stat(entryPath)
          entry.modified = stat.mtimeMs
          if (!isDir) {
            entry.size = stat.size
            const ext = path.extname(dirent.name)
            if (ext) entry.extension = ext
          }
        } catch {
          // stat 失败（权限不足等）时跳过，保留基本信息
        }

        entries.push(entry)
      }

      // 排序规则：
      //   1. 目录在前，文件在后
      //   2. 各组内隐藏项（以 '.' 开头）排在末尾
      //   3. 组内按名称字母序（大小写不敏感）
      entries.sort((a, b) => {
        // 目录 vs 文件
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : 1
        }
        // 隐藏 vs 非隐藏（同类型内部）
        if (a.isHidden !== b.isHidden) {
          return a.isHidden ? 1 : -1
        }
        // 字母序（大小写不敏感）
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      })

      const result: DirListing = { path: normalizedPath, entries }
      return result
    } catch (error: any) {
      console.error('[IPC] file-manager:list-dir error:', error)
      return { path: dirPath, entries: [], error: error.message } as DirListing & { error: string }
    }
  })

  // ==================== open-path：用系统程序打开 ====================

  ipcMain.handle('file-manager:open-path', async (_event, filePath: string) => {
    try {
      const normalizedPath = path.normalize(filePath)
      const errorMsg = await shell.openPath(normalizedPath)
      // shell.openPath 返回空字符串表示成功，否则返回错误描述
      if (errorMsg) {
        return { success: false, error: errorMsg }
      }
      return { success: true }
    } catch (error: any) {
      console.error('[IPC] file-manager:open-path error:', error)
      return { success: false, error: error.message }
    }
  })

  // ==================== read-file：读取文本文件内容 ====================

  ipcMain.handle('file-manager:read-file', async (_event, filePath: string) => {
    try {
      const normalizedPath = path.normalize(filePath)

      // 先检查文件大小，超出 5MB 拒绝读取
      const stat = await fs.promises.stat(normalizedPath)
      if (stat.size > MAX_READ_SIZE) {
        return {
          error: `文件过大（${Math.round(stat.size / 1024 / 1024 * 10) / 10}MB），超出 5MB 限制，无法读取`
        }
      }

      const content = await fs.promises.readFile(normalizedPath, 'utf-8')
      return { content }
    } catch (error: any) {
      console.error('[IPC] file-manager:read-file error:', error)
      return { error: error.message }
    }
  })

  // ==================== watch-dir：开始监听目录变化 ====================

  ipcMain.handle('file-manager:watch-dir', (_event, dirPath: string) => {
    try {
      const normalizedPath = path.normalize(dirPath)

      // 若已有监听器，先关闭旧的（幂等操作）
      if (watchers.has(normalizedPath)) {
        watchers.get(normalizedPath)!.close()
        watchers.delete(normalizedPath)
      }

      const watcher = fs.watch(
        normalizedPath,
        { recursive: false },
        (eventType: 'rename' | 'change', filename: string | null) => {
          const event: FileWatchEvent = {
            eventType,
            // Windows 上 filename 有时为 null，保持原样传递
            filename: filename ?? null,
            dirPath: normalizedPath,
          }
          sendToRenderer('file-manager:watch-change', event)
        }
      )

      watcher.on('error', (err) => {
        console.error(`[IPC] file-manager watcher error (${normalizedPath}):`, err)
        watchers.delete(normalizedPath)
      })

      watchers.set(normalizedPath, watcher)
      console.log(`[IPC] file-manager: watching ${normalizedPath}`)
      return { success: true }
    } catch (error: any) {
      console.error('[IPC] file-manager:watch-dir error:', error)
      return { success: false, error: error.message }
    }
  })

  // ==================== unwatch-dir：停止监听目录 ====================

  ipcMain.handle('file-manager:unwatch-dir', (_event, dirPath: string) => {
    try {
      const normalizedPath = path.normalize(dirPath)

      if (watchers.has(normalizedPath)) {
        watchers.get(normalizedPath)!.close()
        watchers.delete(normalizedPath)
        console.log(`[IPC] file-manager: unwatched ${normalizedPath}`)
      }

      return { success: true }
    } catch (error: any) {
      console.error('[IPC] file-manager:unwatch-dir error:', error)
      return { success: false, error: error.message }
    }
  })

  // ==================== write-file：写入文本文件内容 ====================

  ipcMain.handle(
    'file-manager:write-file',
    async (_event, { path: filePath, content }: { path: string; content: string }) => {
      try {
        // 安全检查：内容大小限制 5MB
        if (content.length > 5 * 1024 * 1024) {
          return { error: '文件内容超过 5MB 限制，无法保存' }
        }
        const normalizedPath = path.normalize(filePath)
        await fs.promises.writeFile(normalizedPath, content, 'utf-8')
        return { success: true }
      } catch (error: any) {
        console.error('[IPC] file-manager:write-file error:', error)
        return { error: error.message ?? String(error) }
      }
    }
  )

  // ==================== get-session-files：查询会话改动的文件列表 ====================

  ipcMain.handle('file-manager:get-session-files', (_event, sessionId: string) => {
    if (!fileChangeTracker) return []
    return fileChangeTracker.getSessionChanges(sessionId)
  })

  // ==================== list-project-files：递归列举项目文件（用于 @ 符号引用） ====================

  ipcMain.handle('file-manager:list-project-files', async (
    _event,
    dirPath: string,
    maxResults = 800
  ) => {
    try {
      const normalizedPath = path.normalize(dirPath)

      // 检查是否是目录
      let dirStat: fs.Stats
      try {
        dirStat = await fs.promises.stat(normalizedPath)
      } catch {
        return { files: [], total: 0, truncated: false, error: '路径不存在' }
      }
      if (!dirStat.isDirectory()) {
        return { files: [], total: 0, truncated: false, error: '路径不是目录' }
      }

      /** 递归忽略的目录名 */
      const IGNORE_DIRS = new Set([
        'node_modules', '.git', '.svn', '.hg',
        'dist', 'build', 'out', '.next', '.nuxt', '.turbo',
        '.cache', '__pycache__', '.venv', 'venv', 'env',
        '.claude', 'target', 'vendor',
        '.idea', '.vscode', 'coverage', '.nyc_output',
        'tmp', 'temp', 'logs',
      ])

      const results: Array<{
        name: string
        path: string
        relativePath: string
        ext: string
      }> = []

      async function walk(dir: string, depth: number): Promise<void> {
        if (depth > 10 || results.length >= maxResults) return

        let entries: fs.Dirent[]
        try {
          entries = await fs.promises.readdir(dir, { withFileTypes: true })
        } catch {
          return  // 权限不足等情况跳过
        }

        for (const entry of entries) {
          if (results.length >= maxResults) return

          // 深度 > 0 时跳过隐藏文件/目录（以 '.' 开头）
          if (depth > 0 && entry.name.startsWith('.')) continue

          const entryPath = path.join(dir, entry.name)

          if (entry.isDirectory()) {
            if (!IGNORE_DIRS.has(entry.name)) {
              await walk(entryPath, depth + 1)
            }
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name)
            const relativePath = path.relative(normalizedPath, entryPath).replace(/\\/g, '/')
            results.push({ name: entry.name, path: entryPath, relativePath, ext })
          }
        }
      }

      await walk(normalizedPath, 0)

      return {
        files: results,
        total: results.length,
        truncated: results.length >= maxResults,
      }
    } catch (error: any) {
      console.error('[IPC] file-manager:list-project-files error:', error)
      return { files: [], total: 0, truncated: false, error: error.message }
    }
  })

  // ==================== create-file：创建空文件 ====================

  ipcMain.handle(
    'file-manager:create-file',
    async (_event, filePath: string) => {
      try {
        const normalizedPath = path.normalize(filePath)
        // 检查是否已存在
        try {
          await fs.promises.access(normalizedPath)
          return { success: false, error: '文件已存在' }
        } catch {
          // 不存在，正常继续
        }
        // 确保父目录存在
        const dir = path.dirname(normalizedPath)
        await fs.promises.mkdir(dir, { recursive: true })
        await fs.promises.writeFile(normalizedPath, '', 'utf-8')
        return { success: true }
      } catch (error: any) {
        console.error('[IPC] file-manager:create-file error:', error)
        return { success: false, error: error.message }
      }
    }
  )

  // ==================== create-dir：创建目录 ====================

  ipcMain.handle(
    'file-manager:create-dir',
    async (_event, dirPath: string) => {
      try {
        const normalizedPath = path.normalize(dirPath)
        // 检查是否已存在
        try {
          await fs.promises.access(normalizedPath)
          return { success: false, error: '目录已存在' }
        } catch {
          // 不存在，正常继续
        }
        await fs.promises.mkdir(normalizedPath, { recursive: true })
        return { success: true }
      } catch (error: any) {
        console.error('[IPC] file-manager:create-dir error:', error)
        return { success: false, error: error.message }
      }
    }
  )

  // ==================== rename：重命名文件/目录 ====================

  ipcMain.handle(
    'file-manager:rename',
    async (_event, { oldPath, newPath }: { oldPath: string; newPath: string }) => {
      try {
        const normalizedOld = path.normalize(oldPath)
        const normalizedNew = path.normalize(newPath)
        // 检查目标是否已存在
        try {
          await fs.promises.access(normalizedNew)
          return { success: false, error: '目标名称已存在' }
        } catch {
          // 不存在，正常继续
        }
        await fs.promises.rename(normalizedOld, normalizedNew)
        return { success: true }
      } catch (error: any) {
        console.error('[IPC] file-manager:rename error:', error)
        return { success: false, error: error.message }
      }
    }
  )

  // ==================== delete：删除文件/目录 ====================

  ipcMain.handle(
    'file-manager:delete',
    async (_event, targetPath: string) => {
      try {
        const normalizedPath = path.normalize(targetPath)
        const stat = await fs.promises.stat(normalizedPath)

        if (stat.isDirectory()) {
          // 移动到回收站（更安全），失败则递归删除
          try {
            await shell.trashItem(normalizedPath)
          } catch {
            await fs.promises.rm(normalizedPath, { recursive: true, force: true })
          }
        } else {
          try {
            await shell.trashItem(normalizedPath)
          } catch {
            await fs.promises.unlink(normalizedPath)
          }
        }

        return { success: true }
      } catch (error: any) {
        console.error('[IPC] file-manager:delete error:', error)
        return { success: false, error: error.message }
      }
    }
  )

  // ==================== show-in-folder：在系统文件管理器中显示 ====================

  ipcMain.handle(
    'file-manager:show-in-folder',
    (_event, filePath: string) => {
      try {
        const normalizedPath = path.normalize(filePath)
        shell.showItemInFolder(normalizedPath)
        return { success: true }
      } catch (error: any) {
        console.error('[IPC] file-manager:show-in-folder error:', error)
        return { success: false, error: error.message }
      }
    }
  )

  // ==================== 监听 tracker flush 事件，推送给渲染进程 ====================

  if (fileChangeTracker) {
    fileChangeTracker.on('files-updated', (sessionId: string, files: any[]) => {
      sendToRenderer('file-manager:session-files-updated', { sessionId, files })
    })
  }

  // ==================== get-file-diff：获取文件 git diff ====================

  ipcMain.handle('file-manager:get-file-diff', async (_event, filePath: string) => {
    try {
      const normalizedPath = path.normalize(filePath)
      const dir = path.dirname(normalizedPath)

      // 执行 git diff HEAD -- <file>，获取未提交改动
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const execFileAsync = promisify(execFile)

      let rawDiff = ''
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['diff', 'HEAD', '--', normalizedPath],
          { cwd: dir, encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024 }
        )
        rawDiff = stdout
      } catch {
        // git diff 失败（可能是新建文件未被 git 追踪），尝试 git diff --cached
        try {
          const { execFile: execFile2 } = await import('child_process')
          const execFile2Async = promisify(execFile2)
          const { stdout } = await execFile2Async(
            'git',
            ['diff', '--cached', '--', normalizedPath],
            { cwd: dir, encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024 }
          )
          rawDiff = stdout
        } catch {
          rawDiff = ''
        }
      }

      // 解析 diff 输出为结构化数据
      const hunks = parseDiff(rawDiff)
      return { hunks, raw: rawDiff }
    } catch (error: any) {
      console.error('[IPC] file-manager:get-file-diff error:', error)
      return { hunks: [], raw: '', error: error.message }
    }
  })
}

// ─────────────────────────────────────────────────────────
// diff 解析工具
// ─────────────────────────────────────────────────────────

export interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'hunk-header'
  content: string
  oldLineNo?: number
  newLineNo?: number
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

function parseDiff(raw: string): DiffHunk[] {
  if (!raw.trim()) return []

  const hunks: DiffHunk[] = []
  let currentHunk: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0

  for (const line of raw.split('\n')) {
    // hunk 头：@@ -old,count +new,count @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunkMatch) {
      if (currentHunk) hunks.push(currentHunk)
      oldLine = parseInt(hunkMatch[1], 10)
      newLine = parseInt(hunkMatch[2], 10)
      currentHunk = { header: line, lines: [] }
      continue
    }

    // 跳过 diff --git / index / --- / +++ 头部信息
    if (!currentHunk) continue
    if (line.startsWith('diff ') || line.startsWith('index ') ||
        line.startsWith('--- ') || line.startsWith('+++ ')) continue

    if (line.startsWith('+')) {
      currentHunk.lines.push({ type: 'add', content: line.slice(1), newLineNo: newLine++ })
    } else if (line.startsWith('-')) {
      currentHunk.lines.push({ type: 'remove', content: line.slice(1), oldLineNo: oldLine++ })
    } else if (line.startsWith(' ') || line === '') {
      currentHunk.lines.push({ type: 'context', content: line.slice(1), oldLineNo: oldLine++, newLineNo: newLine++ })
    }
  }

  if (currentHunk) hunks.push(currentHunk)
  return hunks
}
