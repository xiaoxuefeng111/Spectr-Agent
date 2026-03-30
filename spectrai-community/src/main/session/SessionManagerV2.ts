/**
 * SessionManager V2 —— SDK Adapter 架构的会话管理器
 *
 * 替代原 PTY-based SessionManager，通过 AdapterRegistry 路由到具体的 Provider Adapter。
 * 职责大幅简化：会话生命周期管理 + 事件路由到 IPC/Database，不再涉及 PTY/终端/解析。
 *
 * @author weibin
 */

import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type {
  SessionConfig,
  SessionStatus,
  ActivityEvent,
  AIProvider,
  ConversationMessage,
  UserQuestionMeta,
} from '../../shared/types'
import { BUILTIN_CLAUDE_PROVIDER, BUILTIN_PROVIDERS } from '../../shared/types'
import { extractImageTags } from '../../shared/utils/messageContent'
import type { AdapterRegistry } from '../adapter/AdapterRegistry'
import type { ProviderEvent, AdapterSessionConfig } from '../adapter/types'
import { mapToolToActivityType, extractToolDetail } from '../adapter/toolMapping'
import { SkillEngine } from '../skill/SkillEngine'

// ---- AI 提问检测 ----

/**
 * 从 AI 消息中解析交互式提问（问题 + 选项）
 *
 * 触发条件：
 * 1. 消息中存在问句（含 ? / ？，或以"请选择/请问"等开头）
 * 2. 存在 2-6 个短的有序列表项（数字/字母编号）
 *
 * @param text AI 助手消息内容
 * @returns 解析出的问题和选项，若未检测到则返回 null
 */
function parseInteractiveQuestion(text: string): UserQuestionMeta | null {
  if (!text || text.length < 10) return null

  // Remove fenced code blocks to avoid false positives from code snippets.
  const textWithoutCode = text.replace(/```[\s\S]*?```/g, '')
  const lines = textWithoutCode.split('\n').map(l => l.trim()).filter(l => l.length > 0)

  // Find the last natural-language question line.
  const questionKeywordRe = /^(请选择|请问|你想|您想|哪种|哪个|which|what|how|choose|select|prefer)/i
  const isCodeLikeQuestion = (line: string): boolean => {
    if (/[a-z][A-Z]/.test(line) && /\(.*\)/.test(line)) return true
    if (/[=>{}<]/.test(line) && /[();]/.test(line)) return true
    return false
  }

  let questionIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]
    if (isCodeLikeQuestion(t)) continue
    if (t.includes('?') || t.includes('？') || questionKeywordRe.test(t)) {
      questionIdx = i
      break
    }
  }
  if (questionIdx === -1) return null

  const questionLine = lines[questionIdx]

  const isCodeLikeLine = (line: string): boolean => {
    if (/`[^`]*\/[^`]+`/.test(line)) return true
    if (/\b[\w-]+\/[\w./%-]+\.(ts|tsx|js|jsx|mjs|css|scss|less|json|py|go|rs|vue|md|html)\b/.test(line)) return true
    if (/^```/.test(line)) return true
    return false
  }

  // Yes/No should win over list parsing.
  const isNearEnd = questionIdx >= lines.length - 3
  const isYesNoQuestion =
    /[吗吧呢][?？]\s*$/.test(questionLine) ||
    /(?:是否|要不要|需不需要|能不能|可不可以|行不行).*(?:[?？]|$)/.test(questionLine) ||
    /^(do you|should i|would you like|can i|are you|shall i|will you)/i.test(questionLine)

  if (isYesNoQuestion && isNearEnd) {
    return { question: questionLine, options: ['是的', '不用了'] }
  }

  // Only accept contiguous numbered options right next to the question line.
  const optionRe = /^(?:\d+[.)]\s+|[A-Za-z][.)]\s+|\([A-Za-z\d]\)\s+)(.{1,80})$/
  const collectContiguousNumberedOptions = (start: number, step: 1 | -1): string[] => {
    const result: string[] = []
    let i = start
    while (i >= 0 && i < lines.length && result.length < 6) {
      const line = lines[i]
      if (isCodeLikeLine(line)) break
      const m = line.match(optionRe)
      if (!m) break
      result.push(m[1].trim())
      i += step
    }
    return result
  }

  const beforeOptions = collectContiguousNumberedOptions(questionIdx - 1, -1).reverse()
  const afterOptions = collectContiguousNumberedOptions(questionIdx + 1, 1)
  const beforeValid = beforeOptions.length >= 2 && beforeOptions.length <= 6
  const afterValid = afterOptions.length >= 2 && afterOptions.length <= 6

  if (beforeValid || afterValid) {
    const numberedOptions =
      beforeValid && afterValid
        ? (beforeOptions.length >= afterOptions.length ? beforeOptions : afterOptions)
        : (beforeValid ? beforeOptions : afterOptions)
    return { question: questionLine, options: numberedOptions }
  }

  // Fallback: parse compact markdown table first-column enums near the question.
  const WINDOW = 12
  const winStart = Math.max(0, questionIdx - WINDOW)
  const winEnd = Math.min(lines.length - 1, questionIdx + WINDOW)
  const TABLE_HEADER_RE = /^(主题|风格|主色调|名称|类型|选项|说明|描述|文件|修改内容|路径|阶段|状态|耗时|大小|Theme|Style|Name|Color|Type|Option|Description|File|Content|Path|Change|Stage|Status|Size)$/i
  const tableOptions: string[] = []
  for (let i = winStart; i <= winEnd; i++) {
    const line = lines[i]
    if (!line.startsWith('|')) continue
    if (/^\|[\s\-:|]+\|/.test(line)) continue
    const cells = line.split('|').map(c => c.trim()).filter(c => c.length > 0)
    if (cells.length === 0) continue
    const firstCell = cells[0]
    if (TABLE_HEADER_RE.test(firstCell)) continue
    if (isCodeLikeLine(firstCell)) continue
    if (/[()（）\[\]【】]/.test(firstCell)) continue
    if (firstCell.length >= 1 && firstCell.length <= 20) {
      tableOptions.push(firstCell)
    }
  }

  if (tableOptions.length >= 2 && tableOptions.length <= 6) {
    return { question: questionLine, options: tableOptions }
  }

  return null
}

// ---- 内部会话状态 ----

interface ManagedSession {
  id: string
  name: string
  workingDirectory: string
  status: SessionStatus
  config: SessionConfig
  provider: AIProvider
  nameLocked: boolean
  autoRenameEmitted: boolean   // 是否已触发过 AI 自动重命名（防止重复触发）
  startedAt: string
  endedAt?: string
  exitCode?: number
  claudeSessionId?: string     // Provider 端会话 ID（用于恢复）
  totalUsage: { inputTokens: number; outputTokens: number }
  startupError?: string      // 启动/恢复失败时的错误信息（用于 IPC 透传）
  pendingMessages: string[]    // 启动期间暂存的消息，ready 后自动 flush（修复 Codex/Gemini 启动慢导致首条消息丢失）
  scheduledMessages: ScheduledMessage[] // 运行中插入消息队列（按策略延后发送）
  schedulerAbortInFlight: boolean
  schedulerDispatchInFlight: boolean
  _cleanup?: () => void        // 清理 adapter 事件监听器，防止 resume 后重复注册导致消息翻倍
}

type RuntimeDispatchStrategy = 'interrupt_now' | 'queue_after_turn'

interface ScheduledMessage {
  id: string
  text: string
  queuedAt: string
  strategy: RuntimeDispatchStrategy
}

export interface SendMessageDispatchResult {
  dispatched: boolean
  scheduled: boolean
  strategy?: RuntimeDispatchStrategy
  queueLength?: number
  reason?: 'session_starting' | 'session_running'
}

/**
 * SessionManager V2
 *
 * 事件:
 * - 'status-change'(sessionId, status) — 会话状态变更
 * - 'activity'(sessionId, ActivityEvent) — 活动事件
 * - 'conversation-message'(sessionId, ConversationMessage) — 对话消息
 * - 'title-change'(sessionId, name) — 会话名称变化
 * - 'claude-session-id'(sessionId, claudeId) — Provider 会话 ID 检测到
 */
export class SessionManagerV2 extends EventEmitter {
  private sessions: Map<string, ManagedSession> = new Map()
  private adapterRegistry: AdapterRegistry
  private database?: any   // DatabaseManager（可选，用于 Skill 拦截）

  private thinkingBuffers: Map<string, string> = new Map()
  private thinkingFlushTimers: Map<string, NodeJS.Timeout> = new Map()
  private readonly thinkingFlushIntervalMs = 1200
  private readonly schedulerMaxQueuePerSession = 20

  constructor(adapterRegistry: AdapterRegistry) {
    super()
    this.adapterRegistry = adapterRegistry
  }

  /** 注入数据库实例（用于 Skill 拦截） */
  setDatabase(database: any): void {
    this.database = database
  }

  private queueThinkingActivity(sessionId: string, text: string, timestamp: string): void {
    const incoming = (text || '').trim()
    if (!incoming) return

    const prev = this.thinkingBuffers.get(sessionId) || ''
    const merged = `${prev}${prev ? ' ' : ''}${incoming}`.slice(0, 500)
    this.thinkingBuffers.set(sessionId, merged)

    if (this.thinkingFlushTimers.has(sessionId)) return
    const timer = setTimeout(() => this.flushThinkingActivity(sessionId, timestamp), this.thinkingFlushIntervalMs)
    this.thinkingFlushTimers.set(sessionId, timer)
  }

  private flushThinkingActivity(sessionId: string, timestamp?: string): void {
    const timer = this.thinkingFlushTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.thinkingFlushTimers.delete(sessionId)

    const text = (this.thinkingBuffers.get(sessionId) || '').trim()
    this.thinkingBuffers.delete(sessionId)
    if (!text) return

    this.emit('activity', sessionId, {
      id: uuidv4(),
      sessionId,
      timestamp: timestamp || new Date().toISOString(),
      type: 'thinking',
      detail: text.slice(0, 220),
      metadata: { source: 'sdk' },
    } as ActivityEvent)
  }

  private clearThinkingState(sessionId: string): void {
    const timer = this.thinkingFlushTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.thinkingFlushTimers.delete(sessionId)
    this.thinkingBuffers.delete(sessionId)
  }

  /**
   * 创建新会话
   */
  createSession(config: SessionConfig, provider?: AIProvider): string {
    const id = config.id || uuidv4()
    return this._createSession(id, config, provider)
  }

  /**
   * 使用指定 ID 创建会话（恢复场景）
   */
  createSessionWithId(
    id: string,
    config: SessionConfig,
    claudeSessionId?: string,
    provider?: AIProvider
  ): string {
    const resultId = this._createSession(id, config, provider, claudeSessionId)
    return resultId
  }

  /**
   * 内部创建会话
   */
  private _createSession(
    id: string,
    config: SessionConfig,
    provider?: AIProvider,
    claudeSessionId?: string
  ): string {
    const resolvedProvider = provider || this.resolveProvider(config.providerId)

    // 创建内部状态
    const session: ManagedSession = {
      id,
      name: config.name || `Session-${id.slice(0, 8)}`,
      workingDirectory: config.workingDirectory,
      status: 'starting',
      config,
      provider: resolvedProvider,
      nameLocked: !!config.agentId,
      autoRenameEmitted: false,
      startedAt: new Date().toISOString(),
      claudeSessionId,
      totalUsage: { inputTokens: 0, outputTokens: 0 },
      pendingMessages: [],
      scheduledMessages: [],
      schedulerAbortInFlight: false,
      schedulerDispatchInFlight: false,
    }

    // ★ 若同 ID 会话已存在（resume 场景），先清理旧 adapter 监听器
    // 否则旧监听器与新监听器同时存在，每条消息会被触发两次 → 流式文本翻倍
    const existingSession = this.sessions.get(id)
    if (existingSession?._cleanup) {
      existingSession._cleanup()
    }

    this.sessions.set(id, session)

    // 获取 Adapter
    const adapter = this.adapterRegistry.get(resolvedProvider.id)

    // 注册事件监听
    const onEvent = (event: ProviderEvent) => {
      if (event.sessionId !== id) return
      this.handleProviderEvent(id, event)
    }

    const onStatusChange = (sid: string, status: SessionStatus) => {
      if (sid !== id) return
      this.updateStatus(id, status)
    }

    const hiddenInitialPrompt = config.initialPromptVisibility === 'hidden'
      ? (config.initialPrompt || '').trim()
      : ''
    let hiddenInitialPromptSkipped = false

    // ★ 监听 adapter 直接发射的 conversation-message（用户消息、assistant 完整消息、tool_use/tool_result）
    const onConversationMessage = (sid: string, msg: ConversationMessage) => {
      if (sid !== id) return
      if (
        !hiddenInitialPromptSkipped &&
        hiddenInitialPrompt &&
        msg.role === 'user' &&
        (
          (msg.content || '').trim() === hiddenInitialPrompt ||
          (msg.content || '').includes('Session context recovery (generated by SpectrAI):')
        )
      ) {
        hiddenInitialPromptSkipped = true
        return
      }

      let normalizedMsg = msg
      if (msg.role === 'user' && (!msg.attachments || msg.attachments.length === 0)) {
        const imageTags = extractImageTags(msg.content || '')
        if (imageTags.length > 0) {
          normalizedMsg = {
            ...msg,
            attachments: imageTags.map((tag) => ({
              type: 'image' as const,
              path: tag.path,
              name: tag.name,
            })),
          }
        }
      }
      this.emit('conversation-message', id, normalizedMsg)

      // 同步发射活动事件，使时间线能记录用户输入和 AI 输出
      // isDelta 是流式增量片段，不计入时间线；tool_use/tool_result 已由 tool_use_start 处理
      if (normalizedMsg.isDelta) return

      if (normalizedMsg.role === 'user') {
        const detail = normalizedMsg.content.length > 300
          ? normalizedMsg.content.slice(0, 300) + '…'
          : normalizedMsg.content
        this.emit('activity', id, {
          id: uuidv4(),
          sessionId: id,
          timestamp: normalizedMsg.timestamp,
          type: 'user_input' as const,
          detail,
          metadata: { source: 'sdk' },
        } as ActivityEvent)
      } else if (normalizedMsg.role === 'assistant') {
        const detail = normalizedMsg.content.length > 300
          ? normalizedMsg.content.slice(0, 300) + '…'
          : normalizedMsg.content
        this.emit('activity', id, {
          id: uuidv4(),
          sessionId: id,
          timestamp: normalizedMsg.timestamp,
          type: 'assistant_message' as const,
          detail,
          metadata: { source: 'sdk' },
        } as ActivityEvent)
      }
    }

    // ★ 监听 provider session ID 检测 → 保存到内部状态 + 通知 IPC 层持久化
    const onProviderSessionId = (sid: string, providerSessionId: string) => {
      if (sid !== id) return
      if (!session.claudeSessionId) {
        session.claudeSessionId = providerSessionId
        this.emit('claude-session-id', id, providerSessionId)
        console.log(`[SessionManagerV2] Provider session ID detected for ${id}: ${providerSessionId}`)
      }
    }

    // ★ 监听 session-init-data（tools/skills/mcp 初始化数据） → 转发给 IPC 层
    const onInitData = (sid: string, data: any) => {
      if (sid !== id) return
      this.emit('session-init-data', id, data)
    }

    adapter.on('event', onEvent)
    adapter.on('status-change', onStatusChange)
    adapter.on('conversation-message', onConversationMessage)
    adapter.on('provider-session-id', onProviderSessionId)
    adapter.on('session-init-data', onInitData)

    // 存储清理函数，在 session 结束或 resume 时调用
    session._cleanup = () => {
      adapter.off('event', onEvent)
      adapter.off('status-change', onStatusChange)
      adapter.off('conversation-message', onConversationMessage)
      adapter.off('provider-session-id', onProviderSessionId)
      adapter.off('session-init-data', onInitData)
    }

    // 构建 Adapter 配置
    const adapterConfig: AdapterSessionConfig = {
      command: resolvedProvider.command,
      workingDirectory: config.workingDirectory,
      initialPrompt: config.initialPrompt,
      initialPromptVisibility: config.initialPromptVisibility,
      autoAccept: config.autoAccept ?? false,
      systemPrompt: (() => {
        // ★ Codex / Gemini 的 supervisor prompt 已通过 AGENTS.md / GEMINI.md 文件注入完整版本，
        //   不要再通过 systemPrompt/baseInstructions 重复注入，否则指令过载导致模型跳过中间文本输出。
        const useFileBasedSupervisor = resolvedProvider.adapterType === 'codex-appserver'
          || resolvedProvider.adapterType === 'gemini-headless'
        const base = (config.supervisorMode && !useFileBasedSupervisor)
          ? this.getSupervisorPrompt(config)
          : undefined
        if (config.systemPromptAppend) {
          const appendText = base ? base + '\n\n' + config.systemPromptAppend : config.systemPromptAppend
          console.log(`[SessionManagerV2] systemPromptAppend present, appendText.length=${appendText.length}`)
          // ★ {type:'preset'} 格式仅 claude-sdk 适配器理解（→ --append-system-prompt CLI 参数）
          // 其他 provider（Codex/Gemini 等）的 systemPrompt 必须是纯字符串，否则变成 [object Object]
          if (resolvedProvider.adapterType === 'claude-sdk') {
            return { type: 'preset', preset: 'claude_code', append: appendText }
          }
          return appendText
        }
        console.log(`[SessionManagerV2] no systemPromptAppend, base=${base ? 'supervisor' : 'undefined'}`)
        return base
      })(),
      mcpConfigPath: config.mcpConfigPath,
      envOverrides: config.env,
      // ★ 从 Provider 配置传入 Provider 级参数（nodeVersion / model / providerArgs / executablePath / gitBashPath）
      model: resolvedProvider.defaultModel,
      nodeVersion: resolvedProvider.nodeVersion,
      providerArgs: resolvedProvider.defaultArgs,
      executablePath: resolvedProvider.executablePath,
      gitBashPath: resolvedProvider.gitBashPath,
      additionalDirectories: config.additionalDirectories,
    }

    // 发射启动事件
    this.emit('status-change', id, 'starting')
    this.emit('activity', id, {
      id: uuidv4(),
      sessionId: id,
      timestamp: new Date().toISOString(),
      type: 'session_start',
      detail: `Session started in ${config.workingDirectory} (${resolvedProvider.name})`,
      metadata: { config, providerId: resolvedProvider.id },
    } as ActivityEvent)

    // 异步启动 Adapter 会话
    if (claudeSessionId) {
      // 恢复会话
      adapter.resumeSession(id, claudeSessionId, adapterConfig).catch(err => {
        console.error(`[SessionManagerV2] Resume failed for ${id}:`, err)
        const startupError = err instanceof Error ? err.message : String(err)
        const current = this.sessions.get(id)
        if (current) current.startupError = startupError
        this.emit('activity', id, {
          id: uuidv4(),
          sessionId: id,
          timestamp: new Date().toISOString(),
          type: 'error',
          detail: startupError,
          metadata: { source: 'sdk', phase: 'resume' },
        } as ActivityEvent)
        this.updateStatus(id, 'error')
        // ★ 推送错误到对话，让用户在聊天界面看到失败原因（而非只是状态变为 error）
        this.emit('conversation-message', id, {
          id: uuidv4(),
          sessionId: id,
          role: 'system',
          content: `会话恢复失败：${err.message || String(err)}`,
          timestamp: new Date().toISOString(),
        } as ConversationMessage)
      })
    } else {
      // 新建会话
      adapter.startSession(id, adapterConfig).catch(err => {
        console.error(`[SessionManagerV2] Start failed for ${id}:`, err)
        const startupError = err instanceof Error ? err.message : String(err)
        const current = this.sessions.get(id)
        if (current) current.startupError = startupError
        this.emit('activity', id, {
          id: uuidv4(),
          sessionId: id,
          timestamp: new Date().toISOString(),
          type: 'error',
          detail: startupError,
          metadata: { source: 'sdk', phase: 'start' },
        } as ActivityEvent)
        this.updateStatus(id, 'error')
        // ★ 推送错误到对话，让用户在聊天界面看到失败原因（而非只是状态变为 error）
        this.emit('conversation-message', id, {
          id: uuidv4(),
          sessionId: id,
          role: 'system',
          content: `会话启动失败：${err.message || String(err)}`,
          timestamp: new Date().toISOString(),
        } as ConversationMessage)
      })
    }

    return id
  }

  /**
   * 发送结构化消息（替代 PTY stdin 写入）
   *
   * ★ 启动缓冲：Codex/Gemini 启动较慢（45~180s），若会话仍处于 starting 状态，
   *   消息会暂存到 pendingMessages 队列，待会话 ready 后由 flushPendingMessages() 自动发出。
   *   这样即使 TG bot 在会话启动完成前发送第一条提示词，也不会丢失。
   */
  private decideRunningTurnStrategy(message: string): RuntimeDispatchStrategy {
    const text = (message || '').trim()
    if (!text) return 'queue_after_turn'

    const interruptPatterns: RegExp[] = [
      /(?:先|马上|立刻)?(?:停|暂停|中断|打断|先别|取消|撤回)/i,
      /(?:改一下|更正|纠正|换一个|换下|先回答|先处理)/i,
      /\b(?:stop|pause|interrupt|cancel|hold on|urgent|priority)\b/i,
    ]

    return interruptPatterns.some((re) => re.test(text))
      ? 'interrupt_now'
      : 'queue_after_turn'
  }

  private async requestSchedulerAbort(id: string, session: ManagedSession): Promise<void> {
    if (session.schedulerAbortInFlight) return
    session.schedulerAbortInFlight = true
    try {
      const adapter = this.adapterRegistry.get(session.provider.id)
      await adapter.abortCurrentTurn(id)
    } catch (err) {
      console.warn(`[SessionManagerV2] scheduler abort failed for ${id}:`, err)
    } finally {
      session.schedulerAbortInFlight = false
    }
  }

  /**
   * 获取队列中排队的消息列表（含 pendingMessages + scheduledMessages）
   */
  getScheduledMessages(id: string): Array<{ id: string; text: string; queuedAt: string; strategy?: string }> {
    const session = this.sessions.get(id)
    if (!session) return []
    const result: Array<{ id: string; text: string; queuedAt: string; strategy?: string }> = []
    // 启动期间的 pendingMessages
    for (let i = 0; i < session.pendingMessages.length; i++) {
      result.push({ id: `pending-${i}`, text: session.pendingMessages[i], queuedAt: '', strategy: 'queue_after_turn' })
    }
    // 运行期间的 scheduledMessages
    for (const sm of session.scheduledMessages) {
      result.push({ id: sm.id, text: sm.text, queuedAt: sm.queuedAt, strategy: sm.strategy })
    }
    return result
  }

  /**
   * 清空队列中所有排队的消息（用户主动取消）
   */
  clearScheduledMessages(id: string): number {
    const session = this.sessions.get(id)
    if (!session) return 0
    const count = session.pendingMessages.length + session.scheduledMessages.length
    session.pendingMessages = []
    session.scheduledMessages = []
    if (count > 0) {
      console.log(`[SessionManagerV2] Cleared ${count} queued message(s) for session ${id}`)
    }
    return count
  }

  private async flushScheduledMessages(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    if (session.schedulerDispatchInFlight) return
    if (session.status !== 'waiting_input' && session.status !== 'idle') return
    if (session.scheduledMessages.length === 0) return

    const next = session.scheduledMessages.shift()
    if (!next) return

    session.schedulerDispatchInFlight = true
    try {
      // Reuse normal path so slash commands still work.
      const result = await this.sendMessage(id, next.text)
      if (result.scheduled) {
        // Status raced back to running; keep the message queued for next turn.
        return
      }
      if (session.scheduledMessages.length > 0) {
        this.emit('activity', id, {
          id: uuidv4(),
          sessionId: id,
          timestamp: new Date().toISOString(),
          type: 'thinking',
          detail: `Scheduler: ${session.scheduledMessages.length} queued message(s) remaining`,
          metadata: { source: 'scheduler' },
        } as ActivityEvent)
      }
    } catch (err) {
      console.error(`[SessionManagerV2] Failed to dispatch queued message for session ${id}:`, err)
      // Put it back to the front so users can still retry after transient failures.
      session.scheduledMessages.unshift(next)
    } finally {
      session.schedulerDispatchInFlight = false
    }
  }

  async sendMessage(id: string, message: string): Promise<SendMessageDispatchResult> {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Session ${id} not found`)

    // ★ 会话处于终态时，拒绝发送（防止向已死进程写入导致二次报错）
    if (session.status === 'error' || session.status === 'completed' || session.status === 'terminated') {
      throw new Error(`Session ${id} is in ${session.status} state and cannot accept messages`)
    }

    // ★ 会话仍在启动中，暂存消息，待 ready 后自动 flush
    if (session.status === 'starting') {
      console.log(`[SessionManagerV2] Session ${id} is still starting, buffering message (queue size: ${session.pendingMessages.length + 1})`)
      session.pendingMessages.push(message)
      return {
        dispatched: false,
        scheduled: true,
        strategy: 'queue_after_turn',
        queueLength: session.pendingMessages.length,
        reason: 'session_starting',
      }
    }

    // Session is already running; route new user message through scheduler.
    if (session.status === 'running') {
      const strategy = this.decideRunningTurnStrategy(message)
      if (session.scheduledMessages.length >= this.schedulerMaxQueuePerSession) {
        // Drop oldest to keep memory bounded.
        session.scheduledMessages.shift()
      }
      session.scheduledMessages.push({
        id: uuidv4(),
        text: message,
        queuedAt: new Date().toISOString(),
        strategy,
      })

      const queueLength = session.scheduledMessages.length
      const detail = strategy === 'interrupt_now'
        ? `Scheduler: interrupting current turn; inserted message queued (${queueLength})`
        : `Scheduler: queued inserted message to run after current turn (${queueLength})`
      this.emit('activity', id, {
        id: uuidv4(),
        sessionId: id,
        timestamp: new Date().toISOString(),
        type: 'thinking',
        detail,
        metadata: { source: 'scheduler', strategy, queueLength },
      } as ActivityEvent)

      if (strategy === 'interrupt_now') {
        this.requestSchedulerAbort(id, session).catch(() => {})
      }

      return {
        dispatched: false,
        scheduled: true,
        strategy,
        queueLength,
        reason: 'session_running',
      }
    }

    // ★ /slash 命令拦截（SpectrAI Skill 系统）
    // SpectrAI Skill 优先；未命中则透传给 Provider 自行处理
    if (message.startsWith('/') && this.database) {
      const intercepted = await this.handleSkillCommand(id, message, session.provider.id)
      if (intercepted) {
        return { dispatched: true, scheduled: false }
      }
    }

    const adapter = this.adapterRegistry.get(session.provider.id)
    await adapter.sendMessage(id, message)
    return { dispatched: true, scheduled: false }
  }

  /**
   * 将启动期间缓冲的消息依次发出
   */
  private async flushPendingMessages(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session || session.pendingMessages.length === 0) return

    const messages = [...session.pendingMessages]
    session.pendingMessages = []

    console.log(`[SessionManagerV2] Flushing ${messages.length} buffered message(s) for session ${id}`)
    const adapter = this.adapterRegistry.get(session.provider.id)
    for (const msg of messages) {
      try {
        await adapter.sendMessage(id, msg)
      } catch (err) {
        console.error(`[SessionManagerV2] Failed to flush buffered message for session ${id}:`, err)
      }
    }
  }

  /**
   * 发送确认响应
   */
  async sendConfirmation(id: string, accept: boolean): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Session ${id} not found`)

    const adapter = this.adapterRegistry.get(session.provider.id)
    await adapter.sendConfirmation(id, accept)

    this.emit('activity', id, {
      id: uuidv4(),
      sessionId: id,
      timestamp: new Date().toISOString(),
      type: 'user_input',
      detail: `Confirmation: ${accept ? 'accepted' : 'rejected'}`,
      metadata: { accept },
    } as ActivityEvent)
  }

  /**
   * 发送 AskUserQuestion 的用户答案
   */
  async sendQuestionAnswer(id: string, answers: Record<string, string>): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Session ${id} not found`)

    const adapter = this.adapterRegistry.get(session.provider.id)
    await (adapter as any).sendQuestionAnswer(id, answers)

    // 清除等待状态
    this.emit('activity', id, {
      id: uuidv4(),
      sessionId: id,
      timestamp: new Date().toISOString(),
      type: 'tool_use',
      detail: '用户已回答问题',
    } as ActivityEvent)
  }

  /**
   * 发送 ExitPlanMode 的用户审批结果
   */
  async sendPlanApproval(id: string, approved: boolean): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Session ${id} not found`)

    const adapter = this.adapterRegistry.get(session.provider.id)
    await (adapter as any).sendPlanApproval(id, approved)

    // 清除等待状态
    this.emit('activity', id, {
      id: uuidv4(),
      sessionId: id,
      timestamp: new Date().toISOString(),
      type: 'tool_use',
      detail: approved ? '用户已批准计划' : '用户已拒绝计划',
    } as ActivityEvent)
  }

  /**
   * 软中断：中止当前正在执行的轮次，会话保持活跃可继续使用
   */
  async abortSession(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Session ${id} not found`)
    if (session.status !== 'running') return   // 非运行中无需中断

    const adapter = this.adapterRegistry.get(session.provider.id)
    await adapter.abortCurrentTurn(id)

    this.emit('activity', id, {
      id: uuidv4(),
      sessionId: id,
      timestamp: new Date().toISOString(),
      type: 'user_input',
      detail: 'User interrupted AI',
      metadata: { reason: 'user_abort' },
    } as ActivityEvent)
  }

  /**
   * 终止会话
   */
  async terminateSession(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Session ${id} not found`)
    if (session.status === 'completed' || session.status === 'terminated') return

    const adapter = this.adapterRegistry.get(session.provider.id)
    await adapter.terminateSession(id)

    session.status = 'completed'
    session.endedAt = new Date().toISOString()
    this.flushThinkingActivity(id)

    // 清理 adapter 监听器
    session._cleanup?.()
    session._cleanup = undefined

    this.emit('status-change', id, 'completed')
    this.emit('activity', id, {
      id: uuidv4(),
      sessionId: id,
      timestamp: new Date().toISOString(),
      type: 'session_end',
      detail: 'Session terminated by user',
      metadata: { reason: 'user_termination' },
    } as ActivityEvent)
  }

  /**
   * 获取会话
   */

  getSession(id: string): ManagedSession | undefined {
    return this.sessions.get(id)
  }

  /**
   * 等待会话从 starting 进入可交互状态（running / waiting_input / error / ...）
   * 用于 IPC 创建会话时提供更稳定的 ready 反馈，避免前端过早进入“处理中”假象。
   */
  async waitForSessionReady(
    id: string,
    timeoutMs: number = 8000
  ): Promise<{ ready: boolean; status?: SessionStatus; error?: string }> {
    const current = this.sessions.get(id)
    if (!current) return { ready: false, status: undefined, error: undefined }
    if (current.status !== 'starting') {
      return {
        ready: true,
        status: current.status,
        error: current.status === 'error' ? current.startupError : undefined,
      }
    }

    return await new Promise((resolve) => {
      let settled = false
      const finish = (ready: boolean, status?: SessionStatus, error?: string) => {
        if (settled) return
        settled = true
        this.off('status-change', onStatus)
        clearTimeout(timer)
        resolve({ ready, status, error })
      }

      const onStatus = (sid: string, status: SessionStatus) => {
        if (sid !== id) return
        if (status !== 'starting') {
          const latest = this.sessions.get(id)
          finish(true, status, status === 'error' ? latest?.startupError : undefined)
        }
      }

      const timer = setTimeout(() => {
        const latest = this.sessions.get(id)
        const latestStatus = latest?.status
        finish(
          !!latest && latestStatus !== 'starting',
          latestStatus,
          latestStatus === 'error' ? latest?.startupError : undefined
        )
      }, Math.max(500, timeoutMs))

      this.on('status-change', onStatus)
    })
  }

  /**
   * 获取所有会话
   */
  getAllSessions(): ManagedSession[] {
    return Array.from(this.sessions.values())
  }

  /**
   * 从内存中移除会话（用于永久删除，DATABASE_DELETE 后调用）
   * 不终止进程，仅清理内存 Map，防止 SESSION_GET_ALL 返回"幽灵会话"
   */
  removeSession(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    // 清理 adapter 监听器（如果还存在）
    session._cleanup?.()
    session._cleanup = undefined
    this.sessions.delete(id)
  }

  /**
   * 获取对话历史
   */
  getConversation(id: string): ConversationMessage[] {
    const session = this.sessions.get(id)
    if (!session) return []

    try {
      const adapter = this.adapterRegistry.get(session.provider.id)
      const messages = adapter.getConversation(id)
      const hiddenInitialPrompt = session.config.initialPromptVisibility === 'hidden'
        ? (session.config.initialPrompt || '').trim()
        : ''
      if (!hiddenInitialPrompt) return messages

      let skipped = false
      return messages.filter((msg) => {
        if (
          !skipped &&
          msg.role === 'user' &&
          (
            (msg.content || '').trim() === hiddenInitialPrompt ||
            (msg.content || '').includes('Session context recovery (generated by SpectrAI):')
          )
        ) {
          skipped = true
          return false
        }
        return true
      })
    } catch {
      return []
    }
  }

  /**
   * 获取 Provider 端会话 ID
   */
  getProviderSessionId(id: string): string | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    try {
      const adapter = this.adapterRegistry.get(session.provider.id)
      return adapter.getProviderSessionId(id) || session.claudeSessionId
    } catch {
      return session.claudeSessionId
    }
  }

  /**
   * 更新会话名称
   */
  updateSessionName(id: string, name: string): void {
    const session = this.sessions.get(id)
    if (!session || !name || name === session.name || session.nameLocked) return
    session.name = name
    session.nameLocked = true
    this.emit('title-change', id, name)
  }

  /**
   * 手动重命名会话
   */
  renameSession(id: string, name: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.name = name
    session.nameLocked = true
    this.emit('title-change', id, name)
    return true
  }

  /**
   * 设置 Provider 端会话 ID
   */
  setClaudeSessionId(sessionId: string, claudeId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session || session.claudeSessionId) return false
    session.claudeSessionId = claudeId
    return true
  }

  /**
   * 清理所有资源
   */
  cleanup(): void {
    for (const [id, session] of this.sessions) {
      if (session.status !== 'completed' && session.status !== 'terminated') {
        try {
          const adapter = this.adapterRegistry.get(session.provider.id)
          adapter.terminateSession(id).catch(() => {})
        } catch { /* ignore */ }
      }
    }
  }

  /**
   * 会话名称是否锁定
   */
  isSessionNameLocked(id: string): boolean {
    return this.sessions.get(id)?.nameLocked ?? false
  }

  // ---- 兼容旧接口（渐进迁移） ----

  /**
   * @deprecated 使用 sendMessage 替代
   */
  sendInput(id: string, data: string): void {
    this.sendMessage(id, data).catch(err => {
      console.warn(`[SessionManagerV2] sendInput failed for ${id}:`, err)
    })
  }

  /**
   * @deprecated SDK 模式无需终端大小
   */
  resizeSession(_id: string, _cols: number, _rows: number): void {
    // No-op: SDK 模式没有终端
  }

  /**
   * @deprecated SDK 模式无输出缓冲
   */
  getSessionOutput(_id: string, _recent?: number): string[] {
    return []
  }

  // ---- 内部方法 ----

  /**
   * 处理 Provider 事件，转换为 ActivityEvent 和 ConversationMessage
   */
  private handleProviderEvent(sessionId: string, event: ProviderEvent): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    switch (event.type) {
      case 'text_delta': {
        // 发送增量消息到前端，用固定 ID 标识临时草稿
        this.emit('conversation-message', sessionId, {
          id: `delta-${sessionId}`,
          sessionId,
          role: 'assistant' as const,
          content: event.data.text || '',
          timestamp: event.timestamp,
          isDelta: true,
        } as ConversationMessage)
        break
      }

      case 'thinking': {
        this.queueThinkingActivity(sessionId, event.data.text || '', event.timestamp)
        // thinking 经过缓冲节流后转为 activity，避免前端“长时间无反馈”
        break
      }

      case 'tool_use_start': {
        const toolName = event.data.toolName || 'unknown'
        const toolInput = (event.data.toolInput || {}) as Record<string, unknown>
        const activityType = mapToolToActivityType(toolName, session.provider.id)
        const detail = extractToolDetail(toolName, toolInput)

        this.emit('activity', sessionId, {
          id: uuidv4(),
          sessionId,
          timestamp: event.timestamp,
          type: activityType,
          detail,
          metadata: { toolName, toolInput, source: 'sdk' },
        } as ActivityEvent)
        break
      }

      case 'tool_use_end': {
        // 工具结果不单独发 activity
        break
      }

      case 'permission_request': {
        this.emit('activity', sessionId, {
          id: uuidv4(),
          sessionId,
          timestamp: event.timestamp,
          type: 'waiting_confirmation',
          detail: event.data.permissionPrompt || 'Permission required',
          metadata: { toolName: event.data.toolName, source: 'sdk' },
        } as ActivityEvent)
        break
      }

      case 'ask_user_question': {
        // AskUserQuestion 工具调用：通知渲染进程显示问题对话框
        this.emit('activity', sessionId, {
          id: uuidv4(),
          sessionId,
          timestamp: event.timestamp,
          type: 'waiting_ask_question',
          detail: '等待用户回答问题',
          metadata: {
            questions: (event.data as any)?.toolInput?.questions,
            toolInput: (event.data as any)?.toolInput,
            source: 'sdk',
          },
        } as ActivityEvent)
        break
      }

      case 'exit_plan_mode': {
        // ExitPlanMode 工具调用：通知渲染进程显示计划审批对话框
        this.emit('activity', sessionId, {
          id: uuidv4(),
          sessionId,
          timestamp: event.timestamp,
          type: 'waiting_plan_approval',
          detail: '等待用户审批计划',
          metadata: {
            toolInput: (event.data as any)?.toolInput,
            source: 'sdk',
          },
        } as ActivityEvent)
        break
      }

      case 'turn_complete': {
        this.flushThinkingActivity(sessionId, event.timestamp)
        // 更新 usage
        if (event.data.usage) {
          session.totalUsage.inputTokens += event.data.usage.inputTokens
          session.totalUsage.outputTokens += event.data.usage.outputTokens
        }

        // ★ 通知 IPC 层持久化并推送给前端（SDK V2 token 监控）
        const totalTokens = session.totalUsage.inputTokens + session.totalUsage.outputTokens
        this.emit('usage-update', sessionId, {
          inputTokens: session.totalUsage.inputTokens,
          outputTokens: session.totalUsage.outputTokens,
          total: totalTokens,
          startedAt: session.startedAt,
        })

        this.emit('activity', sessionId, {
          id: uuidv4(),
          sessionId,
          timestamp: event.timestamp,
          type: 'turn_complete',
          detail: `Turn completed (waiting for next input, tokens: ${totalTokens.toLocaleString()})`,
          metadata: { usage: event.data.usage, totalUsage: session.totalUsage, source: 'sdk' },
        } as ActivityEvent)

        // ★ 固化流式草稿 → 完整 assistant 消息
        //
        // CLI adapter（Codex / Gemini / iFlow）通过 text_delta 事件流式推送文本，
        // 渲染层将这些 delta 积累在 id='delta-{sessionId}' 的临时草稿气泡中。
        // 但 CLI adapter 在 turn_complete 时不会主动 emit 'conversation-message'，
        // 草稿永远不会被固化 —— 下次用户发消息时草稿会被删除，导致回复"被吞"。
        //
        // 修复：在 turn_complete 时从 adapter.getConversation() 取出最后一条 assistant
        // 完整消息，以非增量方式广播给渲染层。渲染层的 addConversationMessage 会先删草稿
        // 再插入该完整消息，实现固化。
        // 对于已经自行 emit conversation-message 的 adapter（如 ClaudeSdk），
        // 渲染层的去重逻辑（同 ID 跳过）会防止重复插入。
        try {
          const adapter = this.adapterRegistry.get(session.provider.id)
          const msgs = adapter.getConversation(sessionId)
          const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant')
          if (lastAssistant) {
            this.emit('conversation-message', sessionId, {
              ...lastAssistant,
              isDelta: false,  // 非增量 → 触发渲染层删草稿 + 插完整消息
            } as ConversationMessage)
          }
        } catch (_err) { /* adapter 未注册时安全忽略 */ }

        // 第一轮对话完成后，触发 AI 自动重命名（仅当名称未锁定且未触发过）
        if (!session.nameLocked && !session.autoRenameEmitted) {
          session.autoRenameEmitted = true
          this.emit('auto-rename', sessionId)
        }

        // ★ 交互式提问检测：解析最后一条 assistant 消息，检测问题+选项格式
        // 若检测到，发射 user_question activity，前端将显示按钮/输入栏
        {
          try {
            const adapter = this.adapterRegistry.get(session.provider.id)
            const messages = adapter.getConversation(sessionId)
            const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
            if (lastAssistant?.content) {
              const questionMeta = parseInteractiveQuestion(lastAssistant.content)
              if (questionMeta) {
                this.emit('activity', sessionId, {
                  id: uuidv4(),
                  sessionId,
                  timestamp: event.timestamp,
                  type: 'user_question',
                  detail: questionMeta.question,
                  metadata: { ...questionMeta, source: 'sdk' },
                } as ActivityEvent)
              }
            }
          } catch (_err) { /* ignore */ }
        }
        break
      }

      case 'session_complete': {
        this.flushThinkingActivity(sessionId, event.timestamp)
        session.status = 'completed'
        session.endedAt = new Date().toISOString()
        session.exitCode = event.data.exitCode

        // 清理 adapter 监听器，防止后续 resume 时出现重复监听
        session._cleanup?.()
        session._cleanup = undefined

        this.emit('activity', sessionId, {
          id: uuidv4(),
          sessionId,
          timestamp: event.timestamp,
          type: 'session_end',
          detail: `Session ended with code ${event.data.exitCode}`,
          metadata: { exitCode: event.data.exitCode, source: 'sdk' },
        } as ActivityEvent)
        break
      }

      case 'error': {
        this.emit('activity', sessionId, {
          id: uuidv4(),
          sessionId,
          timestamp: event.timestamp,
          type: 'error',
          detail: event.data.text || 'Unknown error',
          metadata: { source: 'sdk' },
        } as ActivityEvent)
        break
      }
    }

    // ★ 只有 error 事件需要在这里转为 conversation-message
    // 其他消息（user、assistant、tool_use、tool_result）由 adapter 直接通过
    // 'conversation-message' 事件发射，避免重复和 text_delta 碎片化问题
    if (event.type === 'error' && event.data.text) {
      this.emit('conversation-message', sessionId, {
        id: uuidv4(),
        sessionId,
        role: 'system',
        content: event.data.text || 'Error',
        timestamp: event.timestamp,
      } as ConversationMessage)
    }
  }

  /**
   * 更新会话状态
   */
  private updateStatus(id: string, status: SessionStatus): void {
    const session = this.sessions.get(id)
    if (!session) return

    // 防止从终态回到非终态
    if (session.status === 'completed' || session.status === 'terminated') {
      if (status !== 'completed' && status !== 'terminated') return
    }

    const wasStarting = session.status === 'starting'

    session.status = status
    if (status === 'completed' || status === 'terminated' || status === 'error') {
      session.endedAt = new Date().toISOString()
      this.clearThinkingState(id)
      session.scheduledMessages = []
      session.schedulerAbortInFlight = false
      session.schedulerDispatchInFlight = false
    }

    this.emit('status-change', id, status)

    // ★ 启动完成 → flush 暂存消息
    // 从 starting 转为任何活跃状态（idle/running/waiting_input）时，
    // 将启动期间缓冲的消息依次发出，解决 Codex/Gemini 启动慢导致首条消息丢失的问题
    if (wasStarting && status !== 'starting' && status !== 'error' && status !== 'completed' && status !== 'terminated') {
      this.flushPendingMessages(id).catch(err => {
        console.error(`[SessionManagerV2] flushPendingMessages failed for session ${id}:`, err)
      })
    }

    if (status === 'waiting_input' || status === 'idle') {
      this.flushScheduledMessages(id).catch(err => {
        console.error(`[SessionManagerV2] flushScheduledMessages failed for session ${id}:`, err)
      })
    }
  }

  /**
   * 解析 Provider
   */
  private resolveProvider(providerId?: string): AIProvider {
    if (!providerId) return BUILTIN_CLAUDE_PROVIDER
    return BUILTIN_PROVIDERS.find(p => p.id === providerId) || BUILTIN_CLAUDE_PROVIDER
  }

  /**
   * 生成 Supervisor 模式的系统提示
   */
  private getSupervisorPrompt(config: SessionConfig): string {
    return `You are running in Supervisor mode within SpectrAI session ${config.id}. ` +
      `You have access to MCP tools for spawning and managing sub-agents. ` +
      `Use these tools to delegate complex tasks to specialized agents.\n\n` +
      `IMPORTANT: The spectrai-agent MCP tools (spawn_agent, wait_agent_idle, etc.) may be deferred. ` +
      `Before using them, you MUST first call ToolSearch(query: "+spectrai-agent spawn") to load them. ` +
      `Do this proactively at the start of any task that could benefit from sub-agents.`
  }

  /**
   * 处理 /slash 技能命令
   * @returns true 表示已处理（不再透传给 Provider），false 表示未命中（继续正常流程）
   */
  private async handleSkillCommand(sessionId: string, message: string, providerId: string): Promise<boolean> {
    // 解析命令：/code-review some input
    const trimmed = message.slice(1).trim()
    const spaceIdx = trimmed.indexOf(' ')
    const command = spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed
    const userInput = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : ''

    if (!command) return false

    try {
      const skill = this.database?.getSkillByCommand?.(command)
      if (!skill || !skill.isEnabled) {
        // 未命中 SpectrAI Skill，透传给 Provider
        return false
      }

      console.log(`[SessionManagerV2] 拦截 Skill 命令: /${command} (type: ${skill.type})`)

      if (skill.type === 'prompt') {
        // 解析变量（如果 skill 定义了 inputVariables）
        let finalInput = userInput
        let variables: Record<string, string> = {}

        if (skill.inputVariables?.length) {
          const parsed = SkillEngine.parseVariables(userInput, skill.inputVariables)
          variables = parsed.parsedVariables
          finalInput = parsed.remainingInput
        }

        const expandedPrompt = SkillEngine.expand(skill, finalInput, variables)
        const adapter = this.adapterRegistry.get(providerId)
        await adapter.sendMessage(sessionId, expandedPrompt)
        return true

      } else if (skill.type === 'native') {
        // Native Skill：透传给 Provider 原生处理
        return false
      }
    } catch (err) {
      console.error(`[SessionManagerV2] Skill 命令处理错误 /${command}:`, err)
    }

    return false
  }
}
