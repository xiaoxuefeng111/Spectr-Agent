/**
 * Electron 主进程入口
 * 初始化所有核心管理器并连接事件流
 * @author weibin
 */

// ★ 必须最先导入，激活 electron-log 并重定向 console.*
import './logger'
import { app, BrowserWindow, ipcMain, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { SessionManager } from './session/SessionManager'
import { ConcurrencyGuard } from './session/ConcurrencyGuard'
import { DatabaseManager } from './storage/Database'
import { OutputParser } from './parser/OutputParser'
import { StateInference } from './parser/StateInference'
import { NotificationManager } from './notification/NotificationManager'
import { TrayManager } from './tray/TrayManager'
import { TaskSessionCoordinator } from './task/TaskSessionCoordinator'
import { AgentBridge } from './agent/AgentBridge'
import { AgentManager } from './agent/AgentManager'
import { MCPConfigGenerator } from './agent/MCPConfigGenerator'
import { OutputReaderManager } from './reader/OutputReaderManager'
import { ClaudeJsonlReader } from './reader/ClaudeJsonlReader'
import { GitWorktreeService } from './git/GitWorktreeService'
import { registerIpcHandlers, wireSessionManagerV2Events, sendToRenderer } from './ipc'
import { FileChangeTracker } from './tracker/FileChangeTracker'
import { migrateFromLegacyUserData, migrateApiKeyEncryption } from './migration'
import { IPC, THEMES } from '../shared/constants'
import { stripAnsi } from './agent/ansiUtils'
// SDK V2 架构
import { AdapterRegistry } from './adapter/AdapterRegistry'
import { SessionManagerV2 } from './session/SessionManagerV2'
import { AgentManagerV2 } from './agent/AgentManagerV2'
import { ClaudeSdkAdapter } from './adapter/ClaudeSdkAdapter'
import { CodexAppServerAdapter } from './adapter/CodexAppServerAdapter'
import { GeminiHeadlessAdapter } from './adapter/GeminiHeadlessAdapter'
import { IFlowAcpAdapter } from './adapter/IFlowAcpAdapter'
import { OpenCodeSdkAdapter } from './adapter/OpenCodeSdkAdapter'
import { bootstrapShellPath } from './bootstrap/shellPath'
import { UpdateManager } from './update/UpdateManager'


let mainWindow: BrowserWindow | null = null
let isQuitting = false

/**
 * 唤起主窗口（用于启动兜底、托盘唤起、二次启动激活）
 */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return

  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show()
  }
  mainWindow.focus()
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
}

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow()
    return
  }

  if (app.isReady()) {
    createWindow()
  }
})

// ---- 窗口状态持久化 ----
interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

/** 读取上次保存的窗口状态 */
function loadWindowState(): WindowState {
  try {
    const stateFile = join(app.getPath('userData'), 'window-state.json')
    if (existsSync(stateFile)) {
      const data = JSON.parse(readFileSync(stateFile, 'utf-8')) as WindowState
      if (data.width >= 800 && data.height >= 500) return data
    }
  } catch {
    // ignore，使用默认值
  }
  return { width: 1400, height: 900 }
}

/** 保存当前窗口状态（防抖，500ms后写入） */
let _saveWindowTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSaveWindowState(win: BrowserWindow): void {
  if (_saveWindowTimer) clearTimeout(_saveWindowTimer)
  _saveWindowTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return
    try {
      const bounds = win.getBounds()
      const state: WindowState = { ...bounds, maximized: win.isMaximized() }
      writeFileSync(join(app.getPath('userData'), 'window-state.json'), JSON.stringify(state))
    } catch {
      // ignore
    }
  }, 500)
}

// ---- 核心管理器实例 ----
let sessionManager: SessionManager
let concurrencyGuard: ConcurrencyGuard
let database: DatabaseManager
let outputParser: OutputParser
let stateInference: StateInference
let notificationManager: NotificationManager
let trayManager: TrayManager
let taskCoordinator: TaskSessionCoordinator
let agentBridge: AgentBridge
let agentManager: AgentManager
let outputReaderManager: OutputReaderManager
let updateManager: UpdateManager
// SDK V2 架构
let adapterRegistry: AdapterRegistry
let sessionManagerV2: SessionManagerV2
let agentManagerV2: AgentManagerV2
// 文件改动追踪
let fileChangeTracker: FileChangeTracker

/**
 * 创建主窗口
 */
function createWindow(): void {
  const winState = loadWindowState()
  const supportsTitleBarOverlay = process.platform !== 'darwin'
  let startupShown = false
  let startupFallbackTimer: ReturnType<typeof setTimeout> | null = null

  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: winState.width,
    height: winState.height,
    x: winState.x,
    y: winState.y,
    minWidth: 1000,
    minHeight: 600,
    show: false,
    titleBarStyle: supportsTitleBarOverlay ? 'hidden' : 'hiddenInset',
    backgroundColor: '#0D1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  }
  if (supportsTitleBarOverlay) {
    windowOptions.titleBarOverlay = {
      color: '#161B22',    // bg.secondary of dark theme，与自定义标题栏背景色一致
      symbolColor: '#E6EDF3',
      height: 36           // 与 TitleBar h-9 (36px) 对齐
    }
  }

  mainWindow = new BrowserWindow(windowOptions)

  const ensureStartupVisible = (): void => {
    if (!mainWindow || mainWindow.isDestroyed() || startupShown) return
    startupShown = true
    if (startupFallbackTimer) {
      clearTimeout(startupFallbackTimer)
      startupFallbackTimer = null
    }
    if (winState.maximized) {
      mainWindow.maximize()
    }
    showMainWindow()
  }

  mainWindow.on('ready-to-show', ensureStartupVisible)
  mainWindow.webContents.once('did-finish-load', ensureStartupVisible)
  startupFallbackTimer = setTimeout(ensureStartupVisible, 2000)

  // 监听 resize / move，防抖保存窗口状态
  mainWindow.on('resize', () => { if (mainWindow) scheduleSaveWindowState(mainWindow) })
  mainWindow.on('move', () => { if (mainWindow) scheduleSaveWindowState(mainWindow) })

  // 点击关闭按钮时最小化到托盘，而非退出应用
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    if (startupFallbackTimer) {
      clearTimeout(startupFallbackTimer)
      startupFallbackTimer = null
    }
    mainWindow = null
  })

  // 监听主题切换，更新标题栏按钮颜色（使用 bg.secondary 与自定义 TitleBar 背景色一致）
  ipcMain.on(IPC.THEME_UPDATE_TITLE_BAR, (_event, themeId: string) => {
    if (!mainWindow) return
    const theme = THEMES[themeId]
    if (!theme) return
    if (typeof (mainWindow as any).setTitleBarOverlay !== 'function') return
    mainWindow.setTitleBarOverlay({
      color: theme.colors.bg.secondary,
      symbolColor: theme.colors.text.primary,
      height: 36
    })
  })

  // 加载渲染进程
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * 初始化所有核心管理器
 */
function initializeManagers(): void {
  // 1. 数据库（最先初始化，其他模块可能依赖）
  const dbPath = join(app.getPath('userData'), 'claudeops.db')
  database = new DatabaseManager(dbPath)

  // 1.5 清理上次残留的孤儿会话（running/starting→interrupted，idle/waiting_input→completed）
  database.cleanupOrphanedSessions()

  // 1.6 清理过期日志（默认保留30天）
  database.cleanupOldLogs(30)

  // 2. 会话管理器
  sessionManager = new SessionManager()

  // 3. 并发控制
  concurrencyGuard = new ConcurrencyGuard({ maxSessions: 9 })

  // 4. 输出解析引擎
  outputParser = new OutputParser()
  outputParser.getUsageEstimator().bindDatabase(database)

  // 5. 状态推断引擎
  stateInference = new StateInference()

  // 6. 通知管理器
  notificationManager = new NotificationManager()
  // 从数据库同步通知配置（用户可能在上次运行时关闭了通知）
  // 同时同步开机自启状态到 OS 登录项，确保重装/迁移后与数据库保持一致
  try {
    const savedSettings = database.getAppSettings()
    if (savedSettings.notificationEnabled === false) {
      notificationManager.updateConfig({ enabled: false })
    }
    if (typeof savedSettings.autoLaunch === 'boolean') {
      app.setLoginItemSettings({ openAtLogin: savedSettings.autoLaunch })
    }
  } catch (_err) {
    // 读取失败时保持默认配置
  }

  // 7. 托盘管理器
  trayManager = new TrayManager()

  // 8. 任务-会话协调器
  taskCoordinator = new TaskSessionCoordinator(database)

  // 10. 结构化输出读取器（提前到 Agent 之前）
  outputReaderManager = new OutputReaderManager()
  outputReaderManager.registerReader(new ClaudeJsonlReader())

  // 11. Agent 编排基础设施
  agentBridge = new AgentBridge()
  agentBridge.start(63721)
  const gitService = new GitWorktreeService()
  agentManager = new AgentManager(sessionManager, database, {
    outputParser,
    stateInference,
    outputReaderManager,
    gitService,
  })
  // 连接 bridge → manager（V1/V2 双模式路由）
  // V2 会话（SDK Adapter 架构）由 agentManagerV2 处理，V1 PTY 会话由 agentManager 处理
  // 注意：sessionManagerV2/agentManagerV2 在后面初始化，闭包延迟求值，运行时调用时已赋值
  agentBridge.on('request', (request: any, respond: any) => {
    const wrappedRespond = (response: any) => {
      respond(response)
      if (request?.method === 'enter_worktree' && !response?.error) {
        try { sendToRenderer('session:refresh') } catch { /* ignore */ }
      }
    }
    if (request.sessionId && sessionManagerV2?.getSession(request.sessionId)) {
      agentManagerV2.handleBridgeRequest(request, wrappedRespond)
    } else {
      agentManager.handleBridgeRequest(request, wrappedRespond)
    }
  })

  // ★ 监听 AgentBridge 的 file-change 事件 → 转为 ConversationMessage 并持久化
  agentBridge.on('file-change', (payload: { sessionId: string; data: any }) => {
    const { sessionId, data } = payload
    const message = {
      id: `fc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      role: 'tool_result' as const,
      content: `文件已${data.changeType === 'edit' ? '编辑' : data.changeType === 'create' ? '创建' : data.changeType === 'delete' ? '删除' : '写入'}: ${data.filePath}`,
      timestamp: new Date().toISOString(),
      toolName: `spectrai_${data.changeType}_file`,
      fileChange: {
        filePath: data.filePath,
        changeType: data.changeType,
        operationDiff: data.operationDiff,
        cumulativeDiff: data.cumulativeDiff,
        additions: data.additions,
        deletions: data.deletions,
      },
    }
    sendToRenderer(IPC.SESSION_CONVERSATION_MESSAGE, sessionId, message)
    try {
      database.insertConversationMessage(message)
    } catch (_err) { /* ignore */ }
  })

  // 11.5 SDK V2 架构初始化
  adapterRegistry = new AdapterRegistry()
  // 静态注册 Adapter（Vite 打包需要静态 import）
  try {
    const claudeSdkAdapter = new ClaudeSdkAdapter()
    claudeSdkAdapter.setDatabase(database)  // ★ 注入 database，使 Adapter 可读取全局代理设置
    adapterRegistry.register(claudeSdkAdapter)
  } catch (err) {
    console.warn('[init] ClaudeSdkAdapter not available:', err)
  }
  try {
    adapterRegistry.register(new CodexAppServerAdapter())
  } catch (err) {
    console.warn('[init] CodexAppServerAdapter not available:', err)
  }
  try {
    adapterRegistry.register(new GeminiHeadlessAdapter())
  } catch (err) {
    console.warn('[init] GeminiHeadlessAdapter not available:', err)
  }
  try {
    adapterRegistry.register(new IFlowAcpAdapter())
  } catch (err) {
    console.warn('[init] IFlowAcpAdapter not available:', err)
  }
  try {
    adapterRegistry.register(new OpenCodeSdkAdapter())
  } catch (err) {
    console.warn('[init] OpenCodeSdkAdapter not available:', err)
  }

  sessionManagerV2 = new SessionManagerV2(adapterRegistry)
  agentManagerV2 = new AgentManagerV2(adapterRegistry, sessionManagerV2, database)

  // ★ 注入 database 到 SessionManagerV2，用于 Skill 拦截
  sessionManagerV2.setDatabase(database)

  // ★ 注入 bridgePort 到 agentManagerV2，使子会话（团队成员、spawn_agent）也能获得 MCP 工具
  // 必须在 spawnAgent() 首次调用前完成注入，否则子会话无法使用 list_sessions 等跨会话感知工具
  agentManagerV2.setBridgePort(63721)


}

/**
 * 连接模块间事件流
 * SessionManager → OutputParser → StateInference → NotificationManager → Renderer
 */
function wireEvents(): void {
  // ---- SessionManager 事件 ----

  // 会话输出 → 转发给解析器和渲染进程
  sessionManager.on('output', (sessionId: string, data: string) => {
    // 退出时跳过所有处理
    if (isQuitting) return

    // 转发到渲染进程（xterm 渲染）
    sendToRenderer(IPC.SESSION_OUTPUT, sessionId, data)

    // 喂入解析器
    outputParser.feed(sessionId, data)

    // 通知状态推断引擎有输出（时间戳更新 + 状态恢复）
    // 传入 data 让 onOutput 判断是否为实质性输出，避免 spinner 等微量数据导致状态闪烁
    stateInference.onOutput(sessionId, data)

    // 传入原始数据用于 prompt marker / 确认提示检测
    stateInference.onOutputData(sessionId, data)

    // 检测 CLI 启动完成标志（按 Provider 配置的 startupPattern 匹配）
    const cleanData = stripAnsi(data)
    stateInference.checkStartupPattern(sessionId, cleanData)

    // 有新输出时，清除该会话的卡住通知（说明已恢复）
    if (notificationManager.acknowledge(sessionId, 'stuck')) {
      trayManager.decrementBadge()
    }

    // 写入数据库日志
    database.appendLog(sessionId, data)
  })

  // 会话状态变化 → 转发给渲染进程
  sessionManager.on('status-change', (sessionId: string, status: string) => {
    // 退出时跳过状态更新，保留 interrupted 状态
    if (isQuitting) return

    sendToRenderer(IPC.SESSION_STATUS_CHANGE, sessionId, status)
    database.updateSession(sessionId, { status: status as any })

    // 会话结束时注销并发计数并清理所有通知状态
    if (status === 'completed' || status === 'error' || status === 'terminated') {
      concurrencyGuard.unregisterSession()
      stateInference.removeSession(sessionId)
      outputParser.markSessionEnded(sessionId)
      outputReaderManager.stopWatching(sessionId)

      // 清除该会话的所有活跃通知并递减 badge
      const clearedCount = notificationManager.getActiveCount(sessionId)
      notificationManager.clearSession(sessionId)
      if (clearedCount > 0) {
        trayManager.decrementBadge(clearedCount)
      }
    }
  })

  // 会话活动 → 转发给渲染进程
  sessionManager.on('activity', (sessionId: string, event: any) => {
    if (isQuitting) return
    if (event?.type === 'user_input') {
      stateInference.markWorkStarted(sessionId)
    }

    sendToRenderer(IPC.SESSION_ACTIVITY, sessionId, event)

    // 持久化活动事件
    try {
      database.addActivityEvent({
        id: event.id,
        sessionId,
        type: event.type,
        detail: event.detail,
        metadata: event.metadata
      })
    } catch (_err) {
      // 忽略数据库写入错误
    }
  })

  // 终端标题变化 → 更新会话名称
  sessionManager.on('title-change', (sessionId: string, title: string) => {
    if (isQuitting) return
    database.updateSession(sessionId, { name: title })
    sendToRenderer(IPC.SESSION_NAME_CHANGE, sessionId, title)
  })

  // 检测到 Claude 内部会话 ID → 存入数据库 + 通知结构化读取器
  sessionManager.on('claude-session-id', (sessionId: string, claudeId: string) => {
    if (isQuitting) return
    database.updateSession(sessionId, { claudeSessionId: claudeId })
    outputReaderManager.onConversationIdDetected(sessionId, claudeId)
  })

  // ★ Reader 目录扫描发现新 conversation → 反向更新 SessionManager + 数据库
  outputReaderManager.on('conversation-discovered', ({ sessionId, conversationId }: { sessionId: string; conversationId: string }) => {
    if (isQuitting) return

    // 通过公共接口设置，已有 ID 时会自动跳过
    if (!sessionManager.setClaudeSessionId(sessionId, conversationId)) return

    // 持久化到数据库
    database.updateSession(sessionId, { claudeSessionId: conversationId })
    // 精确绑定 Reader（停止目录扫描，开始文件读取）
    outputReaderManager.onConversationIdDetected(sessionId, conversationId)
    console.log(`[Main] Reader discovered conversation: ${conversationId} for session ${sessionId}`)
  })

  // ---- OutputParser 事件 ----

  // 解析到的活动事件 → 转发给渲染进程 + 持久化到数据库
  outputParser.on('activity', (sessionId: string, event: any) => {
    // ★ 只有 task_complete 才标记为 waiting_input
    // assistant_message 不再触发 markAwaitingUserInput —— 因为 OutputParser 的 flush 是 2 秒 debounce，
    // AI 还在打字时就会 flush 出 assistant_message，此时标记 waiting_input 会和 onOutput 的 running 冲突，
    // 导致状态在 waiting_input ↔ running 之间频繁闪烁。
    // 真正的"等待输入"由 StateInference 的 prompt marker 稳定性检测来精确判定。
    if (event?.type === 'task_complete') {
      stateInference.markAwaitingUserInput(sessionId)
    }

    sendToRenderer(IPC.SESSION_ACTIVITY, sessionId, event)

    // 持久化活动事件（与 SessionManager 事件一致）
    try {
      database.addActivityEvent({
        id: event.id,
        sessionId,
        type: event.type,
        detail: event.detail,
        metadata: event.metadata
      })
    } catch (_err) {
      // 忽略数据库写入错误
    }

    // 有意义的活动类型 → 动态更新会话名称
    const NAMING_TYPES = new Set([
      'file_read', 'file_write', 'command_execute',
      'search', 'tool_use', 'task_complete'
    ])
    if (NAMING_TYPES.has(event.type) && event.detail) {
      // 用户手动重命名后锁定，不再自动覆盖
      if (!database.isSessionNameLocked(sessionId)) {
        sessionManager.updateSessionName(sessionId, event.detail)
      }
    }
  })

  // AI 回答内容 → 存储到 session_summaries（有结构化读取器时跳过，避免重复存储）
  outputParser.on('ai-response', (sessionId: string, fullText: string) => {
    if (isQuitting) return
    if (outputReaderManager.hasActiveReader(sessionId)) return
    try {
      database.addSessionSummary(sessionId, 'ai_response', fullText, {
        source: 'parser',
        length: fullText.length,
        timestamp: new Date().toISOString()
      })
    } catch (_err) { /* ignore */ }
  })

  // 检测到需要干预（确认请求或错误）
  outputParser.on('intervention-needed', (sessionId: string, type: string) => {
    sendToRenderer(IPC.SESSION_INTERVENTION, sessionId, { type })

    const session = sessionManager.getSession(sessionId)
    const name = session?.name || sessionId

    if (type === 'confirmation') {
      // 同步状态推断引擎：等待用户确认 → 不应判定为卡住
      stateInference.setSessionStatus(sessionId, 'waiting_input')
      notificationManager.onConfirmationNeeded(sessionId, name)
      trayManager.incrementBadge()
    } else if (type === 'error') {
      stateInference.setSessionStatus(sessionId, 'waiting_input')
      notificationManager.onError(sessionId, name, '执行过程中发生错误')
      trayManager.incrementBadge()
    }
  })

  // ---- 结构化输出读取器事件 ----

  outputReaderManager.on('message', (msg: any) => {
    if (isQuitting) return
    if (msg?.type === 'assistant_message' || msg?.type === 'task_complete') {
      stateInference.markAwaitingUserInput(msg.sessionId)
    }

    // AI 回答 → 准确存储到 session_summaries
    if (msg.type === 'assistant_message') {
      try {
        database.addSessionSummary(msg.sessionId, 'ai_response', msg.content, {
          source: 'structured',
          ...msg.metadata,
          timestamp: msg.timestamp
        })
      } catch (_err) { /* ignore */ }
    }

    // 所有事件 → 转发到渲染进程 + 持久化 + 建议引擎
    const activity = {
      id: `sr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: msg.sessionId,
      type: msg.type,
      timestamp: msg.timestamp,
      detail: msg.content,
      metadata: { source: 'structured', ...msg.metadata }
    }

    sendToRenderer(IPC.SESSION_ACTIVITY, msg.sessionId, activity)

    try {
      database.addActivityEvent(activity)
    } catch (_err) { /* ignore */ }

  })

  // ---- StateInference 事件 ----

  // 状态推断变化
  // ★ 守卫：如果会话已 completed/terminated，不再转发推断状态到前端
  // 防止 StateInference 的延迟定时器在会话终止后发射 running/waiting_input 覆盖 completed
  stateInference.on('status-change', (sessionId: string, status: string) => {
    const session = sessionManager.getSession(sessionId)
    if (session && (session.status === 'completed' || session.status === 'terminated')) {
      return
    }
    // ★ V1 会话的状态推断结果同步写入 DB，供 TG Bot 等读取实时状态
    // V2 会话已在 wireSessionManagerV2Events 中写 DB；V1 只通过 sessionManager 的进程事件写 DB，
    // StateInference 的细粒度推断（waiting_input / idle / running）不会写 DB，导致 Bot 看到旧状态。
    database.updateSession(sessionId, { status: status as any })
    sendToRenderer(IPC.SESSION_STATUS_CHANGE, sessionId, status)
  })

  // 启动阶段卡住（30 秒无 banner）
  stateInference.on('startup-stuck', (sessionId: string) => {
    console.warn(`[StateInference] Session ${sessionId} startup stuck`)
    sendToRenderer(IPC.SESSION_INTERVENTION, sessionId, { type: 'startup-stuck' })
  })

  // 启动超时恢复（banner 终于出现了）
  stateInference.on('startup-recovered', (sessionId: string) => {
    sendToRenderer(IPC.SESSION_INTERVENTION, sessionId, { type: 'recovered' })
  })

  // 会话从卡住状态恢复（有新输出到达）
  stateInference.on('output-recovered', (sessionId: string) => {
    sendToRenderer(IPC.SESSION_INTERVENTION, sessionId, { type: 'recovered' })
  })

  // 会话可能卡住（60 秒无输出）
  stateInference.on('possible-stuck', (sessionId: string) => {
    console.warn(`[StateInference] Session ${sessionId} may be stuck`)
    sendToRenderer(IPC.SESSION_INTERVENTION, sessionId, { type: 'possible-stuck' })
  })

  // 会话需要干预（5 分钟无输出）
  stateInference.on('intervention-needed', (sessionId: string, type: string) => {
    const session = sessionManager.getSession(sessionId)
    const name = session?.name || sessionId

    sendToRenderer(IPC.SESSION_INTERVENTION, sessionId, { type })
    notificationManager.onSessionStuck(sessionId, name)
    trayManager.incrementBadge()
  })

  // ---- TaskSessionCoordinator 事件 ----

  // 会话状态变化 → 协调器同步任务状态
  sessionManager.on('status-change', (sessionId: string, status: string) => {
    if (isQuitting) return
    taskCoordinator.onSessionStatusChange(sessionId, status as any)
  })

  // 解析到的活动事件 → 协调器推断任务进度
  outputParser.on('activity', (sessionId: string, event: any) => {
    if (isQuitting) return
    taskCoordinator.onActivityEvent(sessionId, event.type)
  })

  // 协调器更新了任务 → 通知渲染进程
  taskCoordinator.on('task-updated', (taskId: string, updates: any) => {
    sendToRenderer(IPC.TASK_STATUS_CHANGE, taskId, updates)
  })


}

/**
 * 注册窗口级快捷键（仅在应用窗口聚焦时生效，不占用系统全局快捷键）
 */
function registerShortcuts(): void {
  if (!mainWindow) return

  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return

    const ctrl = input.control || input.meta // Windows/Linux: Ctrl, macOS: Cmd

    if (ctrl && !input.shift && !input.alt) {
      switch (input.key) {
        case '1':
          mainWindow?.webContents.send('shortcut:view-mode', 'grid')
          break
        case '2':
          mainWindow?.webContents.send('shortcut:view-mode', 'tabs')
          break
        case '3':
          mainWindow?.webContents.send('shortcut:view-mode', 'dashboard')
          break
        case '4':
          mainWindow?.webContents.send('shortcut:view-mode', 'kanban')
          break
        case 'Tab':
          mainWindow?.webContents.send('shortcut:cycle-terminal')
          break
        case 'n':
          mainWindow?.webContents.send('shortcut:new-session')
          break
        case 'b':
          mainWindow?.webContents.send('shortcut:toggle-sidebar')
          break
        case 'f':
          mainWindow?.webContents.send('shortcut:search')
          break
      }
    }

    // Ctrl+Shift+N: 新建任务+会话
    if (ctrl && input.shift && !input.alt && input.key === 'N') {
      mainWindow?.webContents.send('shortcut:new-task-session')
    }
  })
}

/**
 * App 生命周期管理
 */
app.whenReady().then(() => {
  // Finder 启动时提前修复 PATH，确保后续 Provider 检测和 CLI spawn 可用
  bootstrapShellPath()
  if (!hasSingleInstanceLock) return

  // ★ 数据迁移：从旧 claudeops userData 目录迁移到新 spectrai 目录
  // 必须在 initializeManagers() 之前执行，确保数据库文件就位
  const migration = migrateFromLegacyUserData()
  if (migration.migrated) {
    console.log('[startup] 数据迁移完成:', migration.details.join('; '))
  }

  // 初始化管理器
  initializeManagers()

  // ★ API Key 加密迁移：将旧版 userData 路径派生密钥加密的数据迁移到固定密钥
  // 必须在 initializeManagers() 之后（database 已就绪）、用户操作之前执行
  migrateApiKeyEncryption(database)

  // 初始化文件改动追踪器
  fileChangeTracker = new FileChangeTracker(database)

  // 连接 V1 PTY sessionManager → fileChangeTracker
  if (sessionManager) {
    sessionManager.on('status-change', (sessionId: string, status: string) => {
      const session = sessionManager.getSession(sessionId)
      const workDir = session?.workingDirectory ?? ''
      fileChangeTracker.onSessionStateChange(sessionId, status, workDir)
    })
    sessionManager.on('output', (sessionId: string) => {
      fileChangeTracker.updateSessionActivity(sessionId)
    })
  }

  // 监听 AgentManager worktree 合并事件，记录 worktree 改动文件
  if (agentManager) {
    agentManager.on('worktree:merged', (data: {
      repoPath: string
      worktreePath?: string
      changedFiles: Array<{ path: string; changeType: 'create' | 'modify' | 'delete' }>
    }) => {
      try {
        const sessionId = fileChangeTracker.findSessionIdByWorkingDir(data.worktreePath ?? '')
        if (sessionId && data.changedFiles.length > 0) {
          fileChangeTracker.recordWorktreeChanges(sessionId, data.repoPath, data.changedFiles)
        }
      } catch (e) {
        console.error('[index] worktree:merged handler error:', e)
      }
    })
  }

  // 自动更新管理器
  updateManager = new UpdateManager(
    () => mainWindow,
    () => database.getAppSettings(),
  )

  // 注册 IPC 处理器（仅传 SDK V2 相关字段，V1 PTY 字段已从 IpcDependencies 移除）
  registerIpcHandlers({
    sessionManager,
    outputParser,
    sessionManagerV2,
    database,
    concurrencyGuard,
    notificationManager,
    trayManager,
    taskCoordinator,
    agentManagerV2,
    agentBridgePort: 63721,
    updateManager,
  }, fileChangeTracker)

  // 连接事件流
  wireEvents()

  // SDK V2 event forwarding (with TaskSessionCoordinator integration)
  // ★ 补传 fileChangeTracker，修复 V2 会话文件改动追踪失效 bug
  wireSessionManagerV2Events(sessionManagerV2, database, concurrencyGuard, notificationManager, trayManager, fileChangeTracker)

  // 启动状态推断引擎
  stateInference.start()

  // 设置自定义菜单：
  // - macOS 保留 Edit 菜单，恢复系统级 Cmd+C/Cmd+V 行为
  // - 其余平台维持精简菜单，避免与终端 Ctrl 快捷键冲突
  const menuTemplate: MenuItemConstructorOptions[] = []

  if (process.platform === 'darwin') {
    menuTemplate.push({
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ]
    })
  }

  menuTemplate.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
    ]
  })

  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate))

  // 创建主窗口
  createWindow()

  // 启动自动更新检查
  updateManager.init()

  // 初始化托盘
  if (mainWindow) {
    trayManager.init(mainWindow)
  }

  // 注册快捷键
  registerShortcuts()

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
      return
    }
    showMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  // 全局快捷键已改为窗口级，无需注销
})

app.on('before-quit', () => {
  isQuitting = true

  // 停止状态推断引擎
  stateInference.stop()

  // 停止文件监听
  outputParser.stopWatching()

  // flush 用量数据到数据库
  outputParser.cleanupUsage()

  // 移除所有事件监听，防止 PTY 异步事件触发数据库写入
  sessionManager.removeAllListeners()
  outputParser.removeAllListeners()
  stateInference.removeAllListeners()
  taskCoordinator.removeAllListeners()
  taskCoordinator.cleanup()

  // 清理 Agent 编排资源
  agentManager.removeAllListeners()
  agentManager.cleanup()
  agentBridge.close()
  MCPConfigGenerator.cleanupAll()

  // ★ 在 cleanup 之前提前捕获 SDK V2 会话状态
  // 必须在 sessionManagerV2.cleanup() 之前拿快照，否则 cleanup() 会将所有会话
  // 内存状态变为 terminated，后面的过滤器会把它们全部排除，导致没有会话被标为 interrupted
  const activeV2SessionsSnapshot = sessionManagerV2.getAllSessions().filter(
    s => s.status !== 'completed' && s.status !== 'terminated' && s.status !== 'error'
  ).map(s => ({
    id: s.id,
    status: s.status,
    claudeSessionId: s.claudeSessionId,
  }))

  // 清理 SDK V2 资源
  sessionManagerV2.removeAllListeners()
  sessionManagerV2.cleanup()
  agentManagerV2.removeAllListeners()
  agentManagerV2.cleanup()
  adapterRegistry.cleanup()

  // 清理文件改动追踪器
  fileChangeTracker?.destroy()

  // 清理自动更新资源
  updateManager?.cleanup()

  // 清理结构化输出读取器
  outputReaderManager.removeAllListeners()
  outputReaderManager.cleanup()

  // 先清理历史残留的 interrupted 会话（标记为 completed），防止重启后重复恢复
  try {
    database.resolveAllInterrupted()
  } catch (_err) {
    // 忽略清理错误
  }

  // 获取所有活跃会话（PTY）
  const activeSessions = sessionManager.getAllSessions().filter(
    s => s.status !== 'completed' && s.status !== 'error'
  )

  // 退出时状态落库策略：
  // - 有 claudeSessionId（无论 running/idle）：标为 interrupted → 下次启动可恢复
  // - 无 claudeSessionId（空会话/未连接）：标为 completed → 不恢复
  for (const session of activeSessions) {
    try {
      const canResume = !!session.claudeSessionId
      const updates: Record<string, any> = { status: canResume ? 'interrupted' : 'completed' }
      if (session.claudeSessionId) {
        updates.claudeSessionId = session.claudeSessionId
      }
      database.updateSession(session.id, updates)
    } catch (_err) {
      // 忽略数据库写入错误
    }
  }

  // ★ SDK V2 会话按同样策略落库 + 持久化 claudeSessionId（使用提前捕获的快照）
  for (const v2Session of activeV2SessionsSnapshot) {
    try {
      const canResume = !!v2Session.claudeSessionId
      const updates: Record<string, any> = { status: canResume ? 'interrupted' : 'completed' }
      if (v2Session.claudeSessionId) {
        updates.claudeSessionId = v2Session.claudeSessionId
      }
      database.updateSession(v2Session.id, updates)
    } catch (_err) {
      // 忽略数据库写入错误
    }
  }

  // 然后终止 PTY 进程
  for (const session of activeSessions) {
    try {
      sessionManager.terminateSession(session.id)
    } catch (_err) {
      // 忽略清理错误
    }
  }

  // 销毁托盘
  trayManager.destroy()

  // 关闭数据库（确保所有写入已完成）
  try {
    database.close()
  } catch (_err) {
    // 忽略关闭错误
  }
})
