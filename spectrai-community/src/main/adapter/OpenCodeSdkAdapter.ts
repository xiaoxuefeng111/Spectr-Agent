/**
 * OpenCode SDK Adapter
 *
 * 通过 @opencode-ai/sdk 与 OpenCode HTTP server 通信。
 * 生命周期：
 *   1. spawn `opencode serve --port <port>` 进程
 *   2. 创建 SDK 客户端连接到该端口
 *   3. 通过 client.session.create() 创建 OpenCode 会话
 *   4. 订阅 SSE 事件流（client.event.subscribe()）并映射到统一 ProviderEvent
 *   5. 通过 client.session.prompt() 发送用户消息
 *
 * @author weibin
 */

import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { v4 as uuidv4 } from 'uuid'
import {
  createOpencodeClient,
  type OpencodeClient,
  type Event as OpenCodeEvent,
  type Part,
  type Permission,
} from '@opencode-ai/sdk'
import type { ConversationMessage } from '../../shared/types'
import {
  BaseProviderAdapter,
  type AdapterSessionConfig,
  type AdapterSession,
  type ProviderEvent,
} from './types'
import { prependNodeVersionToEnvPath } from '../node/NodeVersionResolver'

// ─── 可执行文件查找 ───────────────────────────────────────────────────────────

/**
 * 查找 opencode 可执行文件，优先级：
 * 1. 用户配置的绝对路径
 * 2. Windows npm 全局安装目录（%APPDATA%\npm\opencode.cmd）
 * 3. 回退到配置命令或 'opencode'（依赖 PATH）
 */
function findOpenCodeExecutable(configCommand?: string): string {
  if (configCommand && path.isAbsolute(configCommand) && fs.existsSync(configCommand)) {
    return configCommand
  }

  const fallback = configCommand?.trim() || 'opencode'

  // Windows 下 npm 全局安装的 opencode 是 .cmd 包装器
  if (process.platform === 'win32') {
    const home = process.env.USERPROFILE || process.env.HOME || os.homedir()
    const npmGlobalDirs = [path.join(home, 'AppData', 'Roaming', 'npm')]
    const npmPrefix = process.env.NPM_PREFIX
    if (npmPrefix) npmGlobalDirs.push(npmPrefix)

    for (const dir of npmGlobalDirs) {
      for (const name of ['opencode.cmd', 'opencode.exe', 'opencode']) {
        const candidate = path.join(dir, name)
        if (fs.existsSync(candidate)) return candidate
      }
    }
  }

  return fallback
}

// ─── 端口检测 ─────────────────────────────────────────────────────────────────

/**
 * 找到可用的本地端口（从 startPort 开始，最多尝试 100 个）
 */
async function findAvailablePort(startPort = 14096): Promise<number> {
  for (let port = startPort; port < startPort + 100; port++) {
    const available = await new Promise<boolean>((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => {
        server.close(() => resolve(true))
      })
      server.listen(port, '127.0.0.1')
    })
    if (available) return port
  }
  throw new Error(`No available port found in range ${startPort}–${startPort + 99}`)
}

// ─── 会话状态 ─────────────────────────────────────────────────────────────────

interface OpenCodeSession {
  /** SpectrAI 统一会话状态 */
  adapter: AdapterSession
  /** 配置 */
  config: AdapterSessionConfig
  /** opencode serve 子进程 */
  serverProcess?: ChildProcess
  /** SDK 客户端 */
  client?: OpencodeClient
  /** OpenCode 内部会话 ID（用于恢复） */
  opencodeSessionId?: string
  /** serve 进程监听的端口 */
  port?: number
  /** SSE AbortController（用于主动停止订阅） */
  sseAbortController?: AbortController
  /** SSE 订阅是否活跃 */
  sseActive: boolean
  /** 待确认的权限请求 Map：permissionID → Permission */
  pendingPermissions: Map<string, Permission>
  /** 已发出 tool_use_start 的 callID 集合（避免 pending→running 重复发送） */
  emittedToolStarts: Set<string>
  /** 工作目录（对应 opencode 的 project directory） */
  workingDirectory: string
  /**
   * 用户消息 ID 集合（role=user 的 Message.id）
   * 用于在 message.part.updated 中过滤掉用户输入对应的 Part，
   * 避免用户文本被当作 AI 输出重复渲染。
   */
  userMessageIds: Set<string>
  /**
   * 当前轮次积累的 AI 回答文本。
   * 每条 text_delta 都追加到此处，session.idle 时整合为一条
   * assistant ConversationMessage 存入 adapter.messages，
   * 供 SessionManagerV2 在 turn_complete 时正确固化草稿。
   */
  currentAssistantText: string
  /**
   * 已处理过初始内容的 TextPart ID 集合。
   * 当 delta 为 undefined 时只在首次使用 part.text，
   * 后续同一 part 的无 delta 事件（快照更新）直接跳过，避免重复发射。
   */
  seenTextPartIds: Set<string>
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class OpenCodeSdkAdapter extends BaseProviderAdapter {
  readonly providerId = 'opencode'
  readonly displayName = 'OpenCode'

  private sessions: Map<string, OpenCodeSession> = new Map()

  // ── 公共接口 ────────────────────────────────────────────────────────────────

  async startSession(sessionId: string, config: AdapterSessionConfig): Promise<void> {
    const session: OpenCodeSession = {
      adapter: {
        sessionId,
        status: 'starting',
        messages: [],
        createdAt: new Date().toISOString(),
        totalUsage: { inputTokens: 0, outputTokens: 0 },
      },
      config,
      sseActive: false,
      pendingPermissions: new Map(),
      emittedToolStarts: new Set(),
      workingDirectory: config.workingDirectory,
      userMessageIds: new Set(),
      currentAssistantText: '',
      seenTextPartIds: new Set(),
    }

    this.sessions.set(sessionId, session)
    this.emit('status-change', sessionId, 'starting')

    try {
      // ── 步骤 1：找空闲端口，启动 opencode serve 进程 ─────────────
      const port = await findAvailablePort()
      session.port = port

      const openCodeCommand = findOpenCodeExecutable(config.command)
      const env = prependNodeVersionToEnvPath(
        { ...process.env, ...config.envOverrides },
        config.nodeVersion
      )
      // .cmd 包装器必须通过 shell 执行，否则 Node.js spawn 会报 ENOENT
      const useShell = openCodeCommand.endsWith('.cmd') || openCodeCommand.endsWith('.CMD')
        || (process.platform === 'win32' && !path.isAbsolute(openCodeCommand))
      const proc = spawn(openCodeCommand, ['serve', '--port', String(port)], {
        cwd: config.workingDirectory,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        shell: useShell,
      })
      session.serverProcess = proc

      // 消耗 stdout/stderr 防止管道缓冲区阻塞
      proc.stdout?.on('data', (d: Buffer) => {
        console.debug(`[OpenCodeAdapter][${sessionId}] serve stdout: ${d.toString().slice(0, 300)}`)
      })
      proc.stderr?.on('data', (d: Buffer) => {
        console.debug(`[OpenCodeAdapter][${sessionId}] serve stderr: ${d.toString().slice(0, 300)}`)
      })

      proc.on('error', (err) => {
        console.error(`[OpenCodeAdapter] Server process error for ${sessionId}:`, err)
        if (session.adapter.status !== 'completed' && session.adapter.status !== 'terminated') {
          session.adapter.status = 'error'
          this.emit('status-change', sessionId, 'error')
          this.emitEvent({
            type: 'error',
            sessionId,
            timestamp: new Date().toISOString(),
            data: { text: `OpenCode server error: ${err.message}` },
          })
        }
      })

      proc.on('exit', (code) => {
        console.log(`[OpenCodeAdapter] Server exited for ${sessionId} with code ${code}`)
        session.sseActive = false
        if (session.adapter.status !== 'completed' && session.adapter.status !== 'terminated') {
          session.adapter.status = 'completed'
          this.emit('status-change', sessionId, 'completed')
          this.emitEvent({
            type: 'session_complete',
            sessionId,
            timestamp: new Date().toISOString(),
            data: { exitCode: code ?? 0 },
          })
        }
      })

      // ── 步骤 2：创建 SDK 客户端 ──────────────────────────────────
      const client = createOpencodeClient({
        baseUrl: `http://127.0.0.1:${port}`,
      })
      session.client = client

      // ── 步骤 3：等待服务器就绪（轮询，最多 10 秒）──────────────
      await this.waitForServer(client, config.workingDirectory, 10_000, port)

      // ── 步骤 4：创建 OpenCode 会话 ─────────────────────────────
      const createResult = await client.session.create({
        body: { title: `SpectrAI-${sessionId.slice(0, 8)}` },
        query: { directory: config.workingDirectory },
      })
      const ocSession = createResult.data
      if (!ocSession?.id) {
        throw new Error('OpenCode session.create() did not return an ID')
      }
      session.opencodeSessionId = ocSession.id
      session.adapter.providerSessionId = ocSession.id
      this.emit('provider-session-id', sessionId, ocSession.id)

      // ── 步骤 5：后台启动 SSE 事件订阅循环 ─────────────────────
      this.startSseLoop(sessionId, session)

      session.adapter.status = 'running'
      this.emit('status-change', sessionId, 'running')

      // ── 步骤 6：发送初始 Prompt ────────────────────────────────
      if (config.initialPrompt) {
        await this.sendMessage(sessionId, config.initialPrompt)
      } else {
        session.adapter.status = 'waiting_input'
        this.emit('status-change', sessionId, 'waiting_input')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[OpenCodeAdapter] startSession failed for ${sessionId}:`, err)
      session.adapter.status = 'error'
      this.emit('status-change', sessionId, 'error')
      this.emitEvent({
        type: 'error',
        sessionId,
        timestamp: new Date().toISOString(),
        data: { text: `OpenCode start failed: ${msg}` },
      })
    }
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)
    if (!session.client || !session.opencodeSessionId) {
      throw new Error(`Session ${sessionId} not ready (client or opencodeSessionId missing)`)
    }

    // 记录用户消息到会话历史
    const userMsg: ConversationMessage = {
      id: uuidv4(),
      sessionId,
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    }
    session.adapter.messages.push(userMsg)
    this.emit('conversation-message', sessionId, userMsg)

    session.adapter.status = 'running'
    this.emit('status-change', sessionId, 'running')

    try {
      await session.client.session.prompt({
        path: { id: session.opencodeSessionId },
        body: {
          // parts 数组：文本消息以 TextPartInput 格式传递
          parts: [{ type: 'text', text: message }],
        },
        query: { directory: session.workingDirectory },
      })
      // prompt() 是同步提交：消息提交后 AI 响应通过 SSE 流式到达
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[OpenCodeAdapter] prompt failed for ${sessionId}:`, err)
      this.emitEvent({
        type: 'error',
        sessionId,
        timestamp: new Date().toISOString(),
        data: { text: msg },
      })
    }
  }

  async sendConfirmation(sessionId: string, accept: boolean): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.client || !session.opencodeSessionId) return

    const response = accept ? ('once' as const) : ('reject' as const)
    const ocId = session.opencodeSessionId

    for (const [permissionId] of session.pendingPermissions) {
      try {
        await session.client.postSessionIdPermissionsPermissionId({
          path: { id: ocId, permissionID: permissionId },
          body: { response },
          query: { directory: session.workingDirectory },
        })
      } catch (err) {
        console.warn(`[OpenCodeAdapter] Permission response failed for ${permissionId}:`, err)
      }
    }
    session.pendingPermissions.clear()
  }

  async abortCurrentTurn(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.client || !session.opencodeSessionId) return

    try {
      await session.client.session.abort({
        path: { id: session.opencodeSessionId },
        query: { directory: session.workingDirectory },
      })
    } catch (err) {
      console.warn(`[OpenCodeAdapter] Abort failed for ${sessionId}:`, err)
    }
  }

  async terminateSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    // 停止 SSE 循环
    session.sseActive = false
    session.sseAbortController?.abort()

    // 终止 opencode serve 进程
    if (session.serverProcess) {
      try { session.serverProcess.kill() } catch (_) { /* ignore */ }
      session.serverProcess = undefined
    }

    session.adapter.status = 'completed'
    this.emit('status-change', sessionId, 'completed')
    this.emitEvent({
      type: 'session_complete',
      sessionId,
      timestamp: new Date().toISOString(),
      data: { exitCode: 0 },
    })

    this.sessions.delete(sessionId)
  }

  async resumeSession(
    sessionId: string,
    _providerSessionId: string,
    config: AdapterSessionConfig
  ): Promise<void> {
    // OpenCode 会话恢复：重新 spawn serve + 用相同 directory 创建新会话
    // （OpenCode 会话历史通过 directory 持久化，重新创建即可恢复上下文）
    await this.startSession(sessionId, config)
  }

  getConversation(sessionId: string): ConversationMessage[] {
    return this.sessions.get(sessionId)?.adapter.messages ?? []
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  getProviderSessionId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.opencodeSessionId
  }

  cleanup(): void {
    for (const [id] of this.sessions) {
      try { this.terminateSession(id) } catch (_) { /* ignore */ }
    }
    this.sessions.clear()
  }

  // ── 私有辅助方法 ────────────────────────────────────────────────────────────

  /**
   * 轮询直到 opencode serve 就绪（能正常响应 API 请求）
   */
  private async waitForServer(
    client: OpencodeClient,
    directory: string,
    timeoutMs: number,
    port: number
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const result = await client.session.list({ query: { directory } })
        if (result.data !== undefined) return // 服务器已就绪
      } catch {
        // 服务器尚未就绪，继续轮询
      }
      await new Promise<void>((r) => setTimeout(r, 300))
    }
    throw new Error(`OpenCode server (port ${port}) did not start within ${timeoutMs}ms`)
  }

  /**
   * 后台启动 SSE 事件循环（不阻塞调用方）
   */
  private startSseLoop(sessionId: string, session: OpenCodeSession): void {
    session.sseActive = true
    const ac = new AbortController()
    session.sseAbortController = ac

    this.runSseLoop(sessionId, session, ac).catch((err: unknown) => {
      if (!ac.signal.aborted) {
        console.error(`[OpenCodeAdapter] SSE loop error for ${sessionId}:`, err)
      }
    })
  }

  /**
   * SSE 事件循环主体（后台运行，订阅并处理 OpenCode 事件流）
   */
  private async runSseLoop(
    sessionId: string,
    session: OpenCodeSession,
    ac: AbortController
  ): Promise<void> {
    if (!session.client) return

    try {
      const sseResult = await session.client.event.subscribe({
        query: { directory: session.workingDirectory },
        signal: ac.signal,
      })

      for await (const event of sseResult.stream) {
        if (!session.sseActive || ac.signal.aborted) break
        this.handleOpenCodeEvent(sessionId, session, event)
      }
    } catch (err: unknown) {
      if (ac.signal.aborted) return // 主动中止，正常结束
      console.error(`[OpenCodeAdapter] SSE stream ended for ${sessionId}:`, err)
      // SSE 意外断流 → 会话结束
      if (session.adapter.status !== 'completed' && session.adapter.status !== 'terminated') {
        session.adapter.status = 'completed'
        this.emit('status-change', sessionId, 'completed')
        this.emitEvent({
          type: 'session_complete',
          sessionId,
          timestamp: new Date().toISOString(),
          data: { exitCode: 1 },
        })
      }
    }
  }

  /**
   * 将 OpenCode SSE 事件映射为统一的 ProviderEvent 并发出
   */
  private handleOpenCodeEvent(
    sessionId: string,
    session: OpenCodeSession,
    event: OpenCodeEvent
  ): void {
    const ts = new Date().toISOString()
    const ocId = session.opencodeSessionId

    switch (event.type) {
      // ── 消息整体更新（主要用于累计 Token 用量 + 记录用户消息 ID）──
      case 'message.updated': {
        const msg = event.properties.info
        if (msg.sessionID !== ocId) break
        if (msg.role === 'user') {
          // 记录用户消息 ID，后续 message.part.updated 过滤时使用
          session.userMessageIds.add(msg.id)
        } else if (msg.role === 'assistant') {
          // 累加 Token 用量（每次 message.updated 都包含最新累计值）
          // 简单策略：每次直接覆盖（OpenCode 返回的是累计值）
          const tokens = msg.tokens
          if (tokens) {
            session.adapter.totalUsage.inputTokens  = Math.max(session.adapter.totalUsage.inputTokens,  tokens.input)
            session.adapter.totalUsage.outputTokens = Math.max(session.adapter.totalUsage.outputTokens, tokens.output)
          }
        }
        break
      }

      // ── 消息 Part 更新（文本流 / 思考 / 工具调用）────────────────
      case 'message.part.updated': {
        const { part, delta } = event.properties
        // 只处理属于本 OpenCode 会话的事件
        if (part.sessionID !== ocId) break
        // 跳过用户消息的 Part（避免将用户输入当作 AI 输出重复渲染）
        if (session.userMessageIds.has(part.messageID)) break
        this.handlePartUpdate(sessionId, session, part, delta, ts)
        break
      }

      // ── 会话转为 idle（一轮对话结束，AI 停止响应）────────────────
      case 'session.idle': {
        if (event.properties.sessionID !== ocId) break

        // 将本轮积累的 AI 文本整合为一条 assistant ConversationMessage，
        // 存入 adapter.messages，以便 SessionManagerV2 在 turn_complete 时
        // 能通过 adapter.getConversation() 取到完整内容并固化渲染层草稿。
        if (session.currentAssistantText) {
          const assistantMsg: import('../../shared/types').ConversationMessage = {
            id: uuidv4(),
            sessionId,
            role: 'assistant',
            content: session.currentAssistantText,
            timestamp: ts,
          }
          session.adapter.messages.push(assistantMsg)
          session.currentAssistantText = ''
        }
        // 清理 part 追踪集合，为下一轮做准备
        session.seenTextPartIds.clear()

        this.emitEvent({
          type: 'turn_complete',
          sessionId,
          timestamp: ts,
          data: { usage: session.adapter.totalUsage },
        })
        session.adapter.status = 'waiting_input'
        this.emit('status-change', sessionId, 'waiting_input')
        break
      }

      // ── 权限请求（工具执行前需要用户确认）───────────────────────
      case 'permission.updated': {
        const perm = event.properties
        if (perm.sessionID !== ocId) break

        const permId = perm.id
        session.pendingPermissions.set(permId, perm)

        if (session.config.autoAccept && session.client && ocId) {
          // 自动接受：立即响应，不向 UI 发出 permission_request
          session.client
            .postSessionIdPermissionsPermissionId({
              path: { id: ocId, permissionID: permId },
              body: { response: 'once' },
              query: { directory: session.workingDirectory },
            })
            .then(() => {
              session.pendingPermissions.delete(permId)
            })
            .catch((err: unknown) => {
              console.warn(`[OpenCodeAdapter] Auto-accept permission ${permId} failed:`, err)
            })
        } else {
          // 人工确认：发出 permission_request 事件，等待前端 sendConfirmation()
          this.emitEvent({
            type: 'permission_request',
            sessionId,
            timestamp: ts,
            data: {
              permissionPrompt: perm.title,
              toolName: perm.type,
            },
          })
        }
        break
      }

      // ── 会话错误 ─────────────────────────────────────────────────
      case 'session.error': {
        const { sessionID, error } = event.properties
        if (sessionID && sessionID !== ocId) break

        let errMsg = 'OpenCode session error'
        if (error) {
          const data = error.data as Record<string, unknown> | undefined
          if (typeof data?.message === 'string') {
            errMsg = `${error.name}: ${data.message}`
          } else {
            errMsg = error.name
          }
        }

        this.emitEvent({
          type: 'error',
          sessionId,
          timestamp: ts,
          data: { text: errMsg },
        })
        break
      }

      // ── 其他事件忽略（session.created / file.edited 等）──────────
      default:
        break
    }
  }

  /**
   * 处理具体的消息 Part 更新，转换为 ProviderEvent
   */
  private handlePartUpdate(
    sessionId: string,
    session: OpenCodeSession,
    part: Part,
    delta: string | undefined,
    ts: string
  ): void {
    switch (part.type) {
      // ── 文本流（增量输出）────────────────────────────────────────
      case 'text': {
        let text: string
        if (delta !== undefined) {
          // 有增量：直接使用 delta，并标记该 part 为已处理（防止后续快照重复追加）
          text = delta
          session.seenTextPartIds.add(part.id)
        } else if (!session.seenTextPartIds.has(part.id)) {
          // 首次见到该 part 且无 delta：用 part.text 作为初始内容
          text = part.text
          // ★ Bug fix：只有在 text 非空时才标记为已处理。
          // 若 OpenCode 先发出一条 part.text="" 的初始化事件（无 delta），
          // 不应把 part.id 标记为 seen，否则后续包含实际内容的快照事件会被跳过，
          // 导致 currentAssistantText 始终为空 → TG 报告缺失 + 消息无法转 Markdown。
          if (text) session.seenTextPartIds.add(part.id)
        } else {
          // 已见过该 part 且 delta 为 undefined：快照更新，无新内容，跳过
          // （防止把全量 part.text 重复发射导致内容翻倍）
          break
        }

        if (!text) break
        // 追加到本轮积累文本（session.idle 时存为完整 assistant 消息）
        session.currentAssistantText += text
        this.emitEvent({
          type: 'text_delta',
          sessionId,
          timestamp: ts,
          data: { text },
        })
        break
      }

      // ── 推理/思考内容 ─────────────────────────────────────────────
      case 'reasoning': {
        const text = delta ?? part.text
        if (!text) break
        this.emitEvent({
          type: 'thinking',
          sessionId,
          timestamp: ts,
          data: { text },
        })
        break
      }

      // ── 工具调用（状态机：pending → running → completed/error）──
      case 'tool': {
        const toolUseId = part.callID
        const toolName = part.tool
        const state = part.state

        // 内部辅助：发出 tool_use_start 并记录到历史（仅在首次调用）
        const emitToolStart = (toolInput: Record<string, unknown>) => {
          if (session.emittedToolStarts.has(toolUseId)) return
          session.emittedToolStarts.add(toolUseId)
          this.emitEvent({
            type: 'tool_use_start',
            sessionId,
            timestamp: ts,
            data: { toolName, toolInput, toolUseId },
          })
          session.adapter.messages.push({
            id: uuidv4(),
            sessionId,
            role: 'tool_use',
            content: `${toolName}: ${JSON.stringify(toolInput).slice(0, 100)}`,
            timestamp: ts,
            toolName,
            toolInput,
            toolUseId,
          })
        }

        if (state.status === 'pending') {
          // pending 阶段 input 可能尚未完整解析，暂不发出 tool_use_start，
          // 等待 running 状态（input 已完整、title 已生成）再触发。
          // 若工具执行极快（pending 直接到 completed），在 completed 分支兜底。
        } else if (state.status === 'running') {
          // running：input 已完整，title 已生成，是发出 tool_use_start 的最佳时机
          emitToolStart(state.input)
        } else if (state.status === 'completed') {
          // 兜底：若未经过 running 直接完成，在此补发 tool_use_start
          emitToolStart(state.input)
          const output = state.output
          this.emitEvent({
            type: 'tool_use_end',
            sessionId,
            timestamp: ts,
            data: { toolName, toolResult: output, isError: false, toolUseId },
          })
          session.adapter.messages.push({
            id: uuidv4(),
            sessionId,
            role: 'tool_result',
            content: output.slice(0, 500),
            timestamp: ts,
            toolResult: output,
            isError: false,
            toolUseId,
          })
          session.emittedToolStarts.delete(toolUseId)
        } else if (state.status === 'error') {
          emitToolStart(state.input)
          const errorStr = state.error
          this.emitEvent({
            type: 'tool_use_end',
            sessionId,
            timestamp: ts,
            data: { toolName, toolResult: errorStr, isError: true, toolUseId },
          })
          session.adapter.messages.push({
            id: uuidv4(),
            sessionId,
            role: 'tool_result',
            content: errorStr.slice(0, 500),
            timestamp: ts,
            toolResult: errorStr,
            isError: true,
            toolUseId,
          })
          session.emittedToolStarts.delete(toolUseId)
        }
        break
      }

      // ── 其他 Part 类型忽略（file / step-start / step-finish 等）─
      default:
        break
    }
  }

  private emitEvent(event: ProviderEvent): void {
    this.emit('event', event)
  }
}
