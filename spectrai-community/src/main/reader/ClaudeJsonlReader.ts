/**
 * Claude Code JSONL 对话文件读取器
 *
 * Claude Code 会将每次对话的完整结构化数据写入:
 *   ~/.claude/projects/<projectHash>/<conversationId>.jsonl
 *
 * 每行一个 JSON，包含 5 种 type:
 *   user / assistant / progress / system / file-history-snapshot
 *
 * 本读取器负责:
 *   1. 自动扫描项目目录，找到新产生的 JSONL 文件
 *   2. 增量读取文件（tail -f 语义），解析每行 JSON
 *   3. 将 Claude 专属格式转换为 NormalizedMessage 并发出 'message' 事件
 *
 * @author weibin
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { BaseOutputReader } from './types'
import type { ActivityEventType } from '../../shared/types'

// ==================== Claude JSONL 内部类型 ====================

interface ClaudeJsonlLine {
  type: 'user' | 'assistant' | 'progress' | 'system' | 'file-history-snapshot'
  message?: {
    role: string
    content: any
  }
  uuid?: string
  timestamp?: string
  sessionId?: string
  // system 专属
  subtype?: string
  durationMs?: number
}

// ==================== 会话监听上下文 ====================

interface SessionWatch {
  sessionId: string
  workDir: string
  projectDir: string
  conversationId?: string
  filePath?: string
  /** 已读取的字节偏移 */
  fileOffset: number
  /** 不完整行缓冲 */
  lineBuffer: string
  /** 文件变更监听器 */
  watcher?: fs.FSWatcher
  /** 目录扫描定时器 */
  scanTimer?: ReturnType<typeof setInterval>
  /** 文件轮询定时器（fs.watch 的备用方案） */
  pollTimer?: ReturnType<typeof setInterval>
  /** 会话开始时间戳 */
  startTime: number
}

// ==================== 工具名 → 活动类型映射 ====================

const TOOL_TYPE_MAP: Record<string, ActivityEventType> = {
  Read: 'file_read',
  Write: 'file_create',
  Edit: 'file_write',
  Bash: 'command_execute',
  Grep: 'search',
  Glob: 'search',
  Task: 'tool_use',
  WebFetch: 'tool_use',
  WebSearch: 'search'
}

// ==================== 实现 ====================

export class ClaudeJsonlReader extends BaseOutputReader {
  readonly providerId = 'claude-code'

  private sessions: Map<string, SessionWatch> = new Map()
  /** 已被某个 session 占用的 conversationId，防止并发会话抢同一个文件 */
  private claimedConversationIds: Set<string> = new Set()

  /** 目录扫描间隔 */
  private readonly SCAN_INTERVAL = 2000
  /** 文件轮询间隔（fs.watch 失败时的备用） */
  private readonly POLL_INTERVAL = 2000
  /** Claude 项目目录基路径 */
  private readonly claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects')

  // ---- 公共接口 ----

  startWatching(sessionId: string, workDir: string): void {
    if (this.sessions.has(sessionId)) return

    const projectHash = this.computeProjectHash(workDir)
    const projectDir = path.join(this.claudeProjectsDir, projectHash)

    const watch: SessionWatch = {
      sessionId,
      workDir,
      projectDir,
      fileOffset: 0,
      lineBuffer: '',
      startTime: Date.now()
    }
    this.sessions.set(sessionId, watch)

    // 开始扫描项目目录，自动发现 JSONL 文件
    this.startDirectoryScan(watch)
    console.log(`[ClaudeJsonlReader] 开始监听 session ${sessionId}, 项目目录: ${projectDir}`)
  }

  bindConversationId(sessionId: string, conversationId: string): void {
    const watch = this.sessions.get(sessionId)
    if (!watch) return
    if (watch.conversationId === conversationId) return

    const newFilePath = path.join(watch.projectDir, `${conversationId}.jsonl`)

    // 已经在读正确的文件了
    if (watch.filePath === newFilePath) {
      watch.conversationId = conversationId
      return
    }

    // 切换到正确的文件
    this.cleanupFileWatcher(watch)
    this.stopDirectoryScan(watch)

    // 释放旧占用，登记新占用
    if (watch.conversationId) {
      this.claimedConversationIds.delete(watch.conversationId)
    }
    this.claimedConversationIds.add(conversationId)

    watch.conversationId = conversationId
    watch.filePath = newFilePath
    watch.fileOffset = 0
    watch.lineBuffer = ''

    console.log(`[ClaudeJsonlReader] 绑定对话 ${conversationId} → ${newFilePath}`)
    this.startFileReading(watch)
  }

  stopWatching(sessionId: string): void {
    const watch = this.sessions.get(sessionId)
    if (!watch) return

    // 释放 conversationId 占用
    if (watch.conversationId) {
      this.claimedConversationIds.delete(watch.conversationId)
    }

    this.cleanupFileWatcher(watch)
    this.stopDirectoryScan(watch)
    this.stopPoll(watch)
    this.sessions.delete(sessionId)
    console.log(`[ClaudeJsonlReader] 停止监听 session ${sessionId}`)
  }

  cleanup(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.stopWatching(sessionId)
    }
  }

  // ---- 目录扫描：自动发现新 JSONL 文件 ----

  /**
   * 定期扫描项目目录，找到会话启动后新增/修改的 JSONL 文件
   */
  private startDirectoryScan(watch: SessionWatch): void {
    // 立即扫一次
    this.scanForNewFile(watch)

    watch.scanTimer = setInterval(() => {
      if (watch.filePath) {
        // 已锁定文件，停止扫描
        this.stopDirectoryScan(watch)
        return
      }
      this.scanForNewFile(watch)
    }, this.SCAN_INTERVAL)
  }

  private scanForNewFile(watch: SessionWatch): void {
    if (!fs.existsSync(watch.projectDir)) return

    try {
      const files = fs.readdirSync(watch.projectDir)
        .filter(f => f.endsWith('.jsonl'))
        // ★ 跳过已被其他 session 占用的 conversationId
        .filter(f => !this.claimedConversationIds.has(f.replace('.jsonl', '')))
        .map(f => {
          const fullPath = path.join(watch.projectDir, f)
          try {
            return { name: f, fullPath, mtime: fs.statSync(fullPath).mtimeMs }
          } catch {
            return null
          }
        })
        .filter((f): f is NonNullable<typeof f> => f !== null)
        // 只关注会话启动后有变动的文件（5 秒容差）
        .filter(f => f.mtime > watch.startTime - 5000)
        .sort((a, b) => b.mtime - a.mtime)

      if (files.length > 0) {
        const target = files[0]
        const conversationId = target.name.replace('.jsonl', '')

        // 原子占用：双重检查防止并发竞争
        if (this.claimedConversationIds.has(conversationId)) return
        this.claimedConversationIds.add(conversationId)

        watch.conversationId = conversationId
        watch.filePath = target.fullPath
        this.stopDirectoryScan(watch)
        console.log(`[ClaudeJsonlReader] 自动发现 JSONL: ${target.name}`)

        // 通知外部：发现了新的 conversation
        this.emit('conversation-discovered', {
          sessionId: watch.sessionId,
          conversationId
        })

        this.startFileReading(watch)
      }
    } catch {
      // 目录读取失败，等下次重试
    }
  }

  private stopDirectoryScan(watch: SessionWatch): void {
    if (watch.scanTimer) {
      clearInterval(watch.scanTimer)
      watch.scanTimer = undefined
    }
  }

  // ---- 文件读取 ----

  private startFileReading(watch: SessionWatch): void {
    if (!watch.filePath) return

    if (!fs.existsSync(watch.filePath)) {
      // 文件还没创建，继续轮询等待
      this.startPoll(watch)
      return
    }

    // 读取全部已有内容（追赶历史）
    this.readNewContent(watch)
    // 启动文件变更监听
    this.startFileWatcher(watch)
  }

  /**
   * 增量读取文件新内容
   */
  private readNewContent(watch: SessionWatch): void {
    if (!watch.filePath) return

    try {
      const stat = fs.statSync(watch.filePath)
      if (stat.size <= watch.fileOffset) return

      const fd = fs.openSync(watch.filePath, 'r')
      try {
        const size = stat.size - watch.fileOffset
        const buffer = Buffer.alloc(size)
        fs.readSync(fd, buffer, 0, size, watch.fileOffset)
        watch.fileOffset = stat.size
        this.processText(watch, buffer.toString('utf-8'))
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      // 文件正在被写入，忽略
    }
  }

  /**
   * 拆分行并解析 JSON
   */
  private processText(watch: SessionWatch, text: string): void {
    const combined = watch.lineBuffer + text
    const lines = combined.split('\n')
    // 最后一段可能不完整
    watch.lineBuffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        this.processJsonLine(watch.sessionId, JSON.parse(trimmed))
      } catch {
        // 非法 JSON，跳过
      }
    }
  }

  // ---- 文件监听（fs.watch + 轮询备用）----

  private startFileWatcher(watch: SessionWatch): void {
    try {
      watch.watcher = fs.watch(watch.filePath!, (eventType) => {
        if (eventType === 'change') {
          this.readNewContent(watch)
        }
      })
      watch.watcher.on('error', () => {
        this.cleanupFileWatcher(watch)
        this.startPoll(watch)
      })
    } catch {
      this.startPoll(watch)
    }
  }

  private startPoll(watch: SessionWatch): void {
    if (watch.pollTimer) return
    watch.pollTimer = setInterval(() => {
      if (!watch.filePath) return
      if (!fs.existsSync(watch.filePath)) return
      this.readNewContent(watch)
      // 文件出现了且还没有 watcher，尝试建立
      if (!watch.watcher) {
        this.stopPoll(watch)
        this.startFileWatcher(watch)
      }
    }, this.POLL_INTERVAL)
  }

  private cleanupFileWatcher(watch: SessionWatch): void {
    if (watch.watcher) {
      watch.watcher.close()
      watch.watcher = undefined
    }
    this.stopPoll(watch)
  }

  private stopPoll(watch: SessionWatch): void {
    if (watch.pollTimer) {
      clearInterval(watch.pollTimer)
      watch.pollTimer = undefined
    }
  }

  // ---- JSONL 行解析 → NormalizedMessage ----

  private processJsonLine(sessionId: string, line: ClaudeJsonlLine): void {
    const timestamp = line.timestamp || new Date().toISOString()

    switch (line.type) {
      case 'assistant':
        this.processAssistant(sessionId, line, timestamp)
        break
      case 'user':
        this.processUser(sessionId, line, timestamp)
        break
      case 'system':
        this.processSystem(sessionId, line, timestamp)
        break
      // progress / file-history-snapshot 暂不处理
    }
  }

  /** 处理 assistant 消息：AI 回答、思考、工具调用 */
  private processAssistant(sessionId: string, line: ClaudeJsonlLine, timestamp: string): void {
    const contents = Array.isArray(line.message?.content) ? line.message!.content : []

    for (const block of contents) {
      if (block.type === 'text' && block.text?.trim().length > 5) {
        this.emitMessage(sessionId, 'assistant_message', block.text.trim(), timestamp, {
          uuid: line.uuid,
          length: block.text.length
        })
      }

      if (block.type === 'thinking' && block.thinking) {
        this.emitMessage(sessionId, 'thinking', block.thinking.slice(0, 200), timestamp, {
          uuid: line.uuid,
          fullLength: block.thinking.length
        })
      }

      if (block.type === 'tool_use') {
        const toolName: string = block.name || 'unknown'
        const eventType = TOOL_TYPE_MAP[toolName] || 'tool_use'
        const detail = this.extractToolDetail(toolName, block.input || {})

        this.emitMessage(sessionId, eventType, detail, timestamp, {
          uuid: line.uuid,
          toolName,
          toolId: block.id,
          input: this.summarizeInput(block.input)
        })
      }
    }
  }

  /** 处理 user 消息：主要关注 tool_result（含错误检测）*/
  private processUser(sessionId: string, line: ClaudeJsonlLine, timestamp: string): void {
    const contents = Array.isArray(line.message?.content) ? line.message!.content : []

    for (const block of contents) {
      if (block.type !== 'tool_result') continue

      const text = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content.map((c: any) => c.text || '').join('\n')
          : ''

      if (block.is_error) {
        this.emitMessage(sessionId, 'error', text.slice(0, 500), timestamp, {
          uuid: line.uuid,
          toolUseId: block.tool_use_id
        })
      }
    }
  }

  /** 处理 system 消息：轮次耗时 */
  private processSystem(sessionId: string, line: ClaudeJsonlLine, timestamp: string): void {
    if (line.subtype === 'turn_duration' && line.durationMs) {
      this.emitMessage(sessionId, 'task_complete',
        `轮次完成，耗时 ${(line.durationMs / 1000).toFixed(1)}s`,
        timestamp,
        { durationMs: line.durationMs }
      )
    }
  }

  // ---- 工具详情提取 ----

  private extractToolDetail(toolName: string, input: Record<string, any>): string {
    switch (toolName) {
      case 'Read':  return input.file_path || ''
      case 'Write': return input.file_path || ''
      case 'Edit':  return input.file_path || ''
      case 'Bash':  return (input.command || '').slice(0, 200)
      case 'Grep':  return `grep "${input.pattern || ''}" ${input.path || ''}`
      case 'Glob':  return `glob "${input.pattern || ''}" ${input.path || ''}`
      case 'Task':  return input.description || (input.prompt || '').slice(0, 100) || 'sub-task'
      case 'WebSearch': return input.query || ''
      default: return toolName
    }
  }

  private summarizeInput(input: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(input || {})) {
      out[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '...' : v
    }
    return out
  }

  // ---- 工具方法 ----

  /**
   * 将工作目录路径转换为 Claude Code 的项目目录哈希名
   * 例如: D:\desk_code\spectrai → D--desk-code-spectrai
   */
  private computeProjectHash(workDir: string): string {
    // 去除末尾分隔符后，将所有非字母数字字符替换为 -
    const normalized = workDir.replace(/[\\/]+$/, '')
    return normalized.replace(/[^a-zA-Z0-9]/g, '-')
  }
}
