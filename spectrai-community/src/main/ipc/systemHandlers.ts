/**
 * System IPC 处理器 - 全局设置、日志、文件系统
 * 以及 SessionManagerV2 事件接线（wireSessionManagerV2Events）
 */
import { ipcMain, app, shell } from 'electron'
import fs from 'fs'
import { join } from 'path'
import { IPC } from '../../shared/constants'
import type { DatabaseManager } from '../storage/Database'
import type { ConcurrencyGuard } from '../session/ConcurrencyGuard'
import type { NotificationManager } from '../notification/NotificationManager'
import type { TrayManager } from '../tray/TrayManager'
import type { SessionManagerV2 } from '../session/SessionManagerV2'
import type { FileChangeTracker } from '../tracker/FileChangeTracker'
import { sendToRenderer, aiRenamingLocks, performAiRename } from './shared'
import type { IpcDependencies } from './index'

export function registerSystemHandlers(deps: IpcDependencies): void {
  const { database, notificationManager } = deps

  // ==================== 全局应用设置 ====================

  ipcMain.handle(IPC.SETTINGS_GET_ALL, async () => {
    return database.getAppSettings()
  })

  ipcMain.handle(IPC.SETTINGS_UPDATE, async (_event, key: string, value: any) => {
    database.updateAppSetting(key, value)
    // 通知总开关变更时，实时同步给 NotificationManager
    if (key === 'notificationEnabled') {
      notificationManager.updateConfig({ enabled: !!value })
    }
    // 开机自启变更时，更新系统登录项
    if (key === 'autoLaunch') {
      app.setLoginItemSettings({ openAtLogin: !!value })
    }
    return { success: true }
  })

  // ---- 日志 IPC ----

  ipcMain.handle(IPC.LOG_GET_RECENT, async (_event, lines: number = 200) => {
    const logPath = join(app.getPath('userData'), 'logs', 'main.log')
    if (!fs.existsSync(logPath)) return []
    const content = fs.readFileSync(logPath, 'utf-8')
    return content.split('\n').filter(Boolean).slice(-lines)
  })

  ipcMain.handle(IPC.LOG_OPEN_FILE, async () => {
    const logPath = join(app.getPath('userData'), 'logs', 'main.log')
    await shell.openPath(logPath)
  })

  // ---- 文件系统 IPC ----

  ipcMain.handle(IPC.FS_SAVE_IMAGE_TO_TEMP, async (_event, base64Data: string, mimeType: string) => {
    const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
    const now = new Date()
    const yyyy = String(now.getFullYear())
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    const dd = String(now.getDate()).padStart(2, '0')
    const bucketDir = join(app.getPath('userData'), 'attachments', `${yyyy}-${mm}`)
    await fs.promises.mkdir(bucketDir, { recursive: true })
    const filename = `spectrai_img_${yyyy}${mm}${dd}_${Date.now()}.${ext}`
    const filePath = join(bucketDir, filename)
    await fs.promises.writeFile(filePath, Buffer.from(base64Data, 'base64'))
    return filePath
  })
}

/**
 * 为 SessionManagerV2 注册事件转发（SDK V2 架构）
 *
 * 将 SessionManagerV2 的事件转发到渲染进程 + 持久化到数据库。
 * 在 main/index.ts 中初始化 SessionManagerV2 后调用。
 */
export function wireSessionManagerV2Events(
  sessionManagerV2: SessionManagerV2,
  database: DatabaseManager,
  concurrencyGuard: ConcurrencyGuard,
  notificationManager: NotificationManager,
  trayManager: TrayManager,
  fileChangeTracker?: FileChangeTracker,
): void {
  // ── delta 批量发送：将 30ms 内的连续 token 合并为一次 IPC，降低跨进程通信频率 ──
  const deltaBuffers = new Map<string, { text: string; lastMsg: any }>()
  const deltaTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // ── 通知时机判断：只有用户主动发过消息后，AI 回复才触发通知 ──
  // 记录哪些会话经历过 waiting_input → running（即用户发过消息）
  // 避免新建/恢复场景下的误触发
  const sessionHadUserTurn = new Set<string>()
  // 记录每个会话的前一个状态（用于判断 running 是否由用户发消息触发）
  const prevStatus = new Map<string, string>()

  function flushDelta(sessionId: string): void {
    const buf = deltaBuffers.get(sessionId)
    if (!buf) return
    // 用合并后的文本替换 content，其余字段（messageId、role 等）保持不变
    sendToRenderer(IPC.SESSION_CONVERSATION_MESSAGE, sessionId, { ...buf.lastMsg, content: buf.text })
    deltaBuffers.delete(sessionId)
    const timer = deltaTimers.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      deltaTimers.delete(sessionId)
    }
  }

  // 会话状态变化 → 转发给渲染进程 + 更新数据库 + 文件改动追踪
  sessionManagerV2.on('status-change', (sessionId: string, status: string) => {
    sendToRenderer(IPC.SESSION_STATUS_CHANGE, sessionId, status)
    database.updateSession(sessionId, { status: status as any })

    // ★ 通知 FileChangeTracker V2 会话状态变化（与 V1 PTY 追踪保持一致）
    if (fileChangeTracker) {
      const workingDir = sessionManagerV2.getSession(sessionId)?.workingDirectory ?? ''
      fileChangeTracker.onSessionStateChange(sessionId, status, workingDir)
    }

    const prev = prevStatus.get(sessionId)

    // 用户发消息 → running（前一个状态是 waiting_input）：标记该会话已有用户交互
    // 同时重置本轮通知状态，允许 AI 下次回复后再次通知
    if (status === 'running') {
      if (prev === 'waiting_input') {
        sessionHadUserTurn.add(sessionId)
      }
      notificationManager.acknowledge(sessionId, 'taskComplete')
    }

    // ★ AI 完成一轮回复 → waiting_input：仅在用户已交互过的会话中通知
    // 排除场景：新建会话（starting→running→waiting_input）、恢复会话（直接 waiting_input）
    if (status === 'waiting_input' && sessionHadUserTurn.has(sessionId)) {
      const session = sessionManagerV2.getSession(sessionId)
      const isSubAgent = !!(session?.config?.parentSessionId)
      if (!isSubAgent) {
        const name = session?.name || sessionId
        notificationManager.onTaskCompleted(sessionId, name)
      }
    }

    prevStatus.set(sessionId, status)

    if (status === 'completed' || status === 'error' || status === 'terminated') {
      concurrencyGuard.unregisterSession()
      sessionHadUserTurn.delete(sessionId)
      prevStatus.delete(sessionId)

      const clearedCount = notificationManager.getActiveCount(sessionId)
      notificationManager.clearSession(sessionId)
      if (clearedCount > 0) {
        trayManager.decrementBadge(clearedCount)
      }

      if (!database.isSessionNameLocked(sessionId)) {
        setTimeout(async () => {
          if (database.isSessionNameLocked(sessionId) || aiRenamingLocks.has(sessionId)) return

          aiRenamingLocks.add(sessionId)
          try {
            const result = await performAiRename(database, sessionId)
            if (!result.success) return

            database.updateSession(sessionId, { name: result.name!, nameLocked: true })
            sendToRenderer(IPC.SESSION_NAME_CHANGE, sessionId, result.name!)
            console.log(`[IPC] V2 Auto AI rename on terminate: ${sessionId} → "${result.name}"`)
          } catch (err: any) {
            console.warn('[IPC] V2 Auto AI rename on terminate failed:', err.message)
          } finally {
            aiRenamingLocks.delete(sessionId)
          }
        }, 3000)
      }
    }
  })

  // 对话消息 → 转发给渲染进程 + 持久化到数据库 + 更新文件追踪活跃时间
  sessionManagerV2.on('conversation-message', (sessionId: string, message: any) => {
    // ★ 每条消息更新会话活跃时间（用于多会话归因排序，与 V1 output 事件保持一致）
    fileChangeTracker?.updateSessionActivity(sessionId)

    if (message.isDelta) {
      // ── delta token：累积到 buffer，30ms 内合并后统一发送 ──
      const existing = deltaBuffers.get(sessionId)
      if (existing) {
        existing.text += message.content ?? ''
        existing.lastMsg = message
      } else {
        deltaBuffers.set(sessionId, { text: message.content ?? '', lastMsg: message })
      }
      // 重置窗口定时器
      const oldTimer = deltaTimers.get(sessionId)
      if (oldTimer !== undefined) clearTimeout(oldTimer)
      deltaTimers.set(sessionId, setTimeout(() => flushDelta(sessionId), 30))
      return
    }

    // ── 非 delta（完整消息）：先 flush 残留 delta，再发送本条 ──
    flushDelta(sessionId)
    sendToRenderer(IPC.SESSION_CONVERSATION_MESSAGE, sessionId, message)

    try {
      database.insertConversationMessage(message)
    } catch (_err) {
      // 忽略数据库写入错误（重复 ID 等）
    }

    // ★ V2 SDK 会话：AI 完整回复 → 同时写入 session_summaries
    // 解决问题：V2 SDK session 的 AI 内容只进 conversation_messages 表，
    // 但 EventPusher.taskComplete 从 session_summaries 读取（getLatestSummary）→ 返回 null → 不推送
    // 此处同步写入，确保 taskComplete 延迟 3s 后能读到内容
    if (message.role === 'assistant' && message.content) {
      try {
        database.addSessionSummary(sessionId, 'ai_response', message.content, {
          source: 'sdk_conversation',
          messageId: message.id,
          timestamp: new Date().toISOString()
        })
      } catch (_err) { /* ignore */ }
    }
  })

  // 活动事件 → 转发给渲染进程 + 持久化
  sessionManagerV2.on('activity', (sessionId: string, event: any) => {
    sendToRenderer(IPC.SESSION_ACTIVITY, sessionId, event)

    // ★ session_start 时创建数据库记录（所有 V2 会话的唯一写入点，包含普通 session 和 agent 子 session）
    // 注意：sessionHandlers.ts 不再重复写入，避免 UNIQUE constraint 冲突
    if (event.type === 'session_start') {
      try {
        const meta = event.metadata || {}
        const config = meta.config || {}
        const session = sessionManagerV2.getSession(sessionId)
        database.createSession({
          id: sessionId,
          name: session?.name || `Session-${sessionId.slice(0, 8)}`,
          workingDirectory: config.workingDirectory || session?.workingDirectory || '',
          status: 'running',
          estimatedTokens: 0,
          config,
          taskId: config.taskId,
          providerId: meta.providerId || config.providerId || 'claude-code',
          nameLocked: session?.nameLocked || false,
        })
      } catch (_err) {
        // session 可能已存在（resume 场景），忽略重复插入错误
      }
    }

    try {
      database.addActivityEvent({
        id: event.id,
        sessionId,
        type: event.type,
        detail: event.detail,
        metadata: event.metadata,
      })
    } catch (_err) {
      // 忽略数据库写入错误
    }
  })

  // 会话名称变化 → 转发给渲染进程 + 更新数据库
  sessionManagerV2.on('title-change', (sessionId: string, name: string) => {
    database.updateSession(sessionId, { name })
    sendToRenderer(IPC.SESSION_NAME_CHANGE, sessionId, name)
  })

  // 第一轮对话完成后自动 AI 重命名（SDK V2 架构专用）
  sessionManagerV2.on('auto-rename', async (sessionId: string) => {
    try {
      const sessionData = database.getSession(sessionId)
      if (sessionData?.nameLocked) return

      const result = await performAiRename(database, sessionId)
      if (result.success && result.name) {
        // ★ 必须同时更新数据库 AND 内存中的 session.name
        // 若只更新数据库，后续任何 fetchSessions() 调用都会用 getAll()（内存优先）
        // 把旧名称("会话 HH:MM:SS")覆盖回 store，导致重命名"回滚"
        database.updateSession(sessionId, { name: result.name, nameLocked: true })
        // renameSession() 会更新内存名称 + 锁定 + 触发 title-change → sendToRenderer
        sessionManagerV2.renameSession(sessionId, result.name)
      }
    } catch (_err) {
      // 自动重命名失败不影响正常会话功能
    }
  })

  // Provider 会话 ID 检测 → 更新数据库
  sessionManagerV2.on('claude-session-id', (sessionId: string, claudeId: string) => {
    database.updateSession(sessionId, { claudeSessionId: claudeId })
  })

  // 会话初始化数据（tools/skills/mcp） → 转发给渲染进程
  sessionManagerV2.on('session-init-data', (sessionId: string, data: any) => {
    sendToRenderer(IPC.SESSION_INIT_DATA, sessionId, data)
  })

  // ★ SDK V2: Token 用量更新 → 持久化 + 推送给渲染进程
  sessionManagerV2.on('usage-update', (sessionId: string, usage: {
    inputTokens: number
    outputTokens: number
    total: number
    startedAt: string
  }) => {
    try {
      database.updateSession(sessionId, { estimatedTokens: usage.total })
    } catch (_err) { /* ignore */ }

    try {
      const today = new Date().toISOString().slice(0, 10)
      const elapsedMinutes = usage.startedAt
        ? Math.round((Date.now() - new Date(usage.startedAt).getTime()) / 60000)
        : 0
      database.saveUsageStat(sessionId, today, usage.total, elapsedMinutes)
    } catch (_err) { /* ignore */ }

    sendToRenderer(IPC.SESSION_TOKEN_UPDATE, sessionId, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      total: usage.total,
    })
  })
}
