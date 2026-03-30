/**
 * AgentManager V2 — SDK Adapter 架构的 Agent 编排器
 *
 * 替代 PTY-based AgentManager，通过 AdapterRegistry 路由到具体的 Provider Adapter。
 * 大幅简化：不需要 HeadlessTerminalBuffer、AgentReadinessDetector、TailBuffer。
 * 使用 Adapter 的 turn_complete 事件做确定性就绪检测。
 *
 * @author weibin
 */

import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type { AdapterRegistry } from '../adapter/AdapterRegistry'
import type { ProviderEvent, AdapterSessionConfig } from '../adapter/types'
import type { DatabaseManager } from '../storage/Database'
import type { SessionManagerV2 } from '../session/SessionManagerV2'
import type { AgentConfig, AgentInfo, AgentResult, BridgeRequest, BridgeResponse } from './types'
import { BUILTIN_PROVIDERS } from '../../shared/types'
import type { AIProvider } from '../../shared/types'
import { isProviderAvailable, checkProviderAvailability } from './providerAvailability'
import { MCPConfigGenerator } from './MCPConfigGenerator'
import { GitWorktreeService } from '../git/GitWorktreeService'

interface ManagedAgent {
  info: AgentInfo
  childSessionId: string
  parentSessionId: string
  oneShot: boolean
  providerId: string
}

const DEFAULT_WAIT_AGENT_TIMEOUT_MS = 600000
const DEFAULT_WAIT_AGENT_IDLE_TIMEOUT_MS = 300000
const DEFAULT_CODEX_TOOL_CALL_TIMEOUT_MS = 120000
const DEFAULT_CODEX_TOOL_CALL_SAFETY_MS = 15000
const DEFAULT_CODEX_WAIT_MAX_MS = 90000

export class AgentManagerV2 extends EventEmitter {
  private adapterRegistry: AdapterRegistry
  private sessionManager: SessionManagerV2
  private database: DatabaseManager
  private gitWorktreeService = new GitWorktreeService()
  /** Agent Bridge WebSocket 端口，用于为子会话生成 MCP 配置（0 = 未初始化） */
  private bridgePort: number = 0

  /** agentId → Agent 信息 */
  private agents: Map<string, ManagedAgent> = new Map()
  /** childSessionId → agentId */
  private childToAgent: Map<string, string> = new Map()
  /** parentSessionId → Set<agentId> */
  private parentToAgents: Map<string, Set<string>> = new Map()
  /** agentId → 等待完成的 resolve */
  private waiters: Map<string, Array<{ resolve: (result: AgentResult) => void; timer?: ReturnType<typeof setTimeout> }>> = new Map()
  /** agentId → 等待空闲的 resolve */
  private idleWaiters: Map<string, Array<{ resolve: (info: { idle: boolean; output: string }) => void; timer?: ReturnType<typeof setTimeout> }>> = new Map()
  /**
   * agentId → 是否处于"空闲等待输入"状态（完成了一轮但尚未终止）
   * 解决竞态：若 task_complete 事件在 wait_agent_idle 注册之前触发，
   * 该 flag 保留已完成状态，下次调用时可立即返回，避免无限等待。
   */
  private agentIdleFlags: Map<string, boolean> = new Map()
  private onSessionStatusChange!: (sessionId: string, status: string) => void
  private onSessionActivity!: (sessionId: string, event: any) => void

  constructor(
    adapterRegistry: AdapterRegistry,
    sessionManager: SessionManagerV2,
    database: DatabaseManager,
  ) {
    super()
    this.adapterRegistry = adapterRegistry
    this.sessionManager = sessionManager
    this.database = database
    this.listenEvents()
  }

  /**
   * 注入 Agent Bridge 端口（延迟注入，用于为子会话生成 MCP 配置）
   * 必须在 spawnAgent() 调用之前设置，否则子会话无法获得 MCP 工具支持。
   */
  setBridgePort(port: number): void {
    this.bridgePort = port
  }

  /**
   * 监听 SessionManagerV2 事件
   */
  private listenEvents(): void {
    // 会话状态变化
    this.onSessionStatusChange = (sessionId: string, status: string) => {
      const agentId = this.childToAgent.get(sessionId)
      if (agentId) {
        if (status === 'completed' || status === 'error' || status === 'terminated') {
          this.onChildSessionEnded(agentId, status)
        } else if (status === 'running') {
          this.updateAgentStatus(agentId, 'running')
        }
        return
      }

      // 父会话结束 → 清理子 Agent
      if ((status === 'completed' || status === 'error' || status === 'terminated') &&
          this.parentToAgents.has(sessionId)) {
        this.cleanupChildAgents(sessionId)
      }
    }
    this.sessionManager.on('status-change', this.onSessionStatusChange)

    // 监听 turn_complete 事件 → Agent 空闲检测
    this.onSessionActivity = (sessionId: string, event: any) => {
      const agentId = this.childToAgent.get(sessionId)
      if (!agentId) return

      if (event.type === 'turn_complete') {
        const agent = this.agents.get(agentId)
        if (!agent) return

        if (agent.oneShot) {
          // oneShot: 第一轮结束即完成
          this.completeAgent(agentId, 0)
        } else {
          // persistent: 设置 idle flag（解决竞态：若无 waiter 也保留状态）
          this.agentIdleFlags.set(agentId, true)
          // 唤醒已注册的 idle waiters
          this.resolveIdleWaiters(agentId)
          // ★ 通知监听器：该持久 Agent 的当前轮次已真正完成
          // 解决 team_report_idle 工具调用与 turn_complete 之间的竞态：
          // 成员调用 team_report_idle 时 AI 尚未完成本轮输出，不能立即将前端状态置为"空闲"，
          // 必须等到 turn_complete 确认后才能更新状态
          this.emit('agent:idle', agentId)
        }
      }
    }
    this.sessionManager.on('activity', this.onSessionActivity)
  }

  /**
   * 创建 Agent 子会话
   */
  spawnAgent(parentSessionId: string, config: AgentConfig): AgentInfo {
    const agentId = uuidv4()
    const childSessionId = `agent-${agentId.slice(0, 8)}`
    const providerId = config.providerId || 'claude-code'
    const workDir = config.workDir || this.getParentWorkDir(parentSessionId)

    const info: AgentInfo = {
      agentId,
      name: config.name,
      parentSessionId,
      childSessionId,
      status: 'pending',
      prompt: config.prompt,
      workDir,
      createdAt: new Date().toISOString(),
    }

    const agent: ManagedAgent = {
      info,
      childSessionId,
      parentSessionId,
      oneShot: config.oneShot !== false,
      providerId,
    }

    // 注册映射
    this.agents.set(agentId, agent)
    this.childToAgent.set(childSessionId, agentId)

    const parentAgents = this.parentToAgents.get(parentSessionId) || new Set()
    parentAgents.add(agentId)
    this.parentToAgents.set(parentSessionId, parentAgents)

    // 持久化到数据库
    try {
      this.database.createAgentSession({
        agentId,
        name: config.name,
        parentSessionId,
        childSessionId,
        prompt: config.prompt,
        workDir,
        status: 'pending',
        providerId,
        createdAt: new Date().toISOString(),
      })
    } catch (err) {
      console.warn(`[AgentManagerV2] DB insert failed:`, err)
    }

    // 通过 Provider 查找
    // ★ 合并策略：内置定义提供默认值，DB 里的用户配置（如 nodeVersion）覆盖内置
    // 不能只取内置 —— 内置的 BUILTIN_IFLOW_PROVIDER 没有 nodeVersion，
    // 会导致 findIFlowLaunchConfig 忽略用户在 UI 里配置的 Node 版本。
    const builtin  = BUILTIN_PROVIDERS.find(p => p.id === providerId)
    const dbConfig = this.database.getProvider(providerId)
    const provider = (builtin && dbConfig)
      ? { ...builtin, ...dbConfig }   // 用户自定义字段（nodeVersion 等）覆盖内置默认
      : (dbConfig || builtin)

    // ★ 为子会话生成 MCP 配置（与 sessionHandlers.ts 对主会话的处理保持一致）
    // 若 bridgePort 未设置，子会话将无法使用 spectrai-agent MCP 工具（list_sessions 等）
    let mcpConfigPath: string | undefined
    let envOverrides: Record<string, string> | undefined
    if (this.bridgePort > 0) {
      const nativeMcpProviders = ['claude-code', 'iflow']
      if (nativeMcpProviders.includes(providerId)) {
        // Claude Code / iFlow：通过 --mcp-config JSON 文件注入 MCP
        mcpConfigPath = MCPConfigGenerator.generate(
          childSessionId,
          this.bridgePort,
          workDir,
          providerId,
          this.database,
          config.sessionMode || 'awareness'
        )
      } else if (providerId === 'codex') {
        // Codex：通过 CODEX_HOME 环境变量重定向配置目录
        const codexHomeDir = MCPConfigGenerator.generateForCodex(
          childSessionId,
          this.bridgePort,
          workDir,
          providerId,
          this.database,
          config.sessionMode || 'awareness'
        )
        envOverrides = { CODEX_HOME: codexHomeDir }
      } else if (providerId === 'opencode') {
        // OpenCode：通过 OPENCODE_CONFIG 环境变量指定额外配置文件注入 MCP
        const opencodeConfigPath = MCPConfigGenerator.generateForOpenCode(
          childSessionId,
          this.bridgePort,
          workDir,
          providerId,
          this.database,
          config.sessionMode || 'awareness'
        )
        envOverrides = { OPENCODE_CONFIG: opencodeConfigPath }
      }
    }

    // 通过 SessionManagerV2 创建子会话
    this.sessionManager.createSessionWithId(
      childSessionId,
      {
        id: childSessionId,
        workingDirectory: workDir,
        initialPrompt: config.prompt,
        autoAccept: config.autoAccept ?? true,
        providerId,
        agentId,            // 标记为 Agent 会话（锁定名称）
        parentSessionId,    // 父会话 ID，用于前端构建父子树
        name: `Agent: ${config.name}`,
        mcpConfigPath,      // ★ 注入 MCP 配置（使子会话可使用 spectrai-agent 工具）
        env: envOverrides,  // ★ Codex 需要 CODEX_HOME 环境变量
      },
      undefined,
      provider || undefined,
    )

    this.updateAgentStatus(agentId, 'running')
    this.emit('agent:created', info)

    return info
  }

  /**
   * 向 Agent 发送消息
   */
  sendToAgent(agentId: string, message: string): { success: boolean; error?: string } {
    const agent = this.agents.get(agentId)
    if (!agent) return { success: false, error: `Agent ${agentId} not found` }

    if (agent.info.status === 'completed' || agent.info.status === 'failed' || agent.info.status === 'cancelled') {
      return { success: false, error: `Agent ${agentId} already ${agent.info.status}` }
    }

    // 发送新消息时清除 idle flag（Agent 进入新一轮处理）
    this.agentIdleFlags.delete(agentId)

    // 通过 SessionManagerV2 发送消息
    this.sessionManager.sendMessage(agent.childSessionId, message).catch(err => {
      console.error(`[AgentManagerV2] sendToAgent failed:`, err)
    })

    return { success: true }
  }

  /**
   * 等待 Agent 空闲（turn_complete 事件）
   * 比 PTY 版本简单得多：不需要 heuristic，直接等待结构化事件
   */
  waitAgentIdle(agentId: string, timeout?: number): Promise<{ idle: boolean; output: string }> {
    const agent = this.agents.get(agentId)
    if (!agent) return Promise.resolve({ idle: false, output: '' })

    // 已完成/失败/取消
    if (agent.info.status === 'completed' || agent.info.status === 'failed' || agent.info.status === 'cancelled') {
      const output = this.getAgentOutput(agentId).output
      return Promise.resolve({ idle: true, output })
    }

    // ★ 竞态修复：若 task_complete 早于 wait_agent_idle 触发（子 Agent 已完成当前轮）
    // agentIdleFlags 保留了该状态，直接返回 idle=true，无需再等待事件
    if (this.agentIdleFlags.get(agentId)) {
      this.agentIdleFlags.delete(agentId)
      const output = this.getAgentOutput(agentId).output
      return Promise.resolve({ idle: true, output })
    }

    return new Promise((resolve) => {
      const timeoutMs = this.getPositiveTimeout(timeout, DEFAULT_WAIT_AGENT_IDLE_TIMEOUT_MS)

      const timer = setTimeout(() => {
        // 超时
        const waiters = this.idleWaiters.get(agentId) || []
        const idx = waiters.findIndex(w => w.resolve === resolve)
        if (idx >= 0) waiters.splice(idx, 1)
        const output = this.getAgentOutput(agentId).output
        resolve({ idle: false, output })
      }, timeoutMs)

      const waiters = this.idleWaiters.get(agentId) || []
      waiters.push({ resolve, timer })
      this.idleWaiters.set(agentId, waiters)
    })
  }

  /**
   * 等待 Agent 完成
   */
  waitAgent(agentId: string, timeout?: number): Promise<AgentResult> {
    const agent = this.agents.get(agentId)
    if (!agent) {
      return Promise.resolve({ success: false, exitCode: -1, error: `Agent ${agentId} not found` })
    }

    // 已完成
    if (agent.info.status === 'completed') {
      return Promise.resolve(agent.info.result || { success: true, exitCode: 0, output: this.getAgentOutput(agentId).output })
    }
    if (agent.info.status === 'failed' || agent.info.status === 'cancelled') {
      return Promise.resolve(agent.info.result || { success: false, exitCode: -1, error: `Agent ${agent.info.status}` })
    }

    return new Promise((resolve) => {
      const timeoutMs = this.getPositiveTimeout(timeout, DEFAULT_WAIT_AGENT_TIMEOUT_MS)

      const timer = setTimeout(() => {
        const waiters = this.waiters.get(agentId) || []
        const idx = waiters.findIndex(w => w.resolve === resolve)
        if (idx >= 0) waiters.splice(idx, 1)
        resolve({ success: false, exitCode: -1, error: `Timeout after ${timeoutMs}ms` })
      }, timeoutMs)

      const waiters = this.waiters.get(agentId) || []
      waiters.push({ resolve, timer })
      this.waiters.set(agentId, waiters)
    })
  }

  /**
   * 获取 Agent 输出（从对话消息提取，不再 scrape 终端缓冲）
   */
  getAgentOutput(agentId: string, lines?: number): { output: string; error?: string } {
    const agent = this.agents.get(agentId)
    if (!agent) return { output: '', error: `Agent ${agentId} not found` }

    try {
      const messages = this.sessionManager.getConversation(agent.childSessionId)
      const assistantMessages = messages
        .filter(m => m.role === 'assistant' && m.content)
        .map(m => m.content)

      let output = assistantMessages.join('\n')

      // 按行数限制
      if (lines && lines > 0) {
        const allLines = output.split('\n')
        if (allLines.length > lines) {
          output = allLines.slice(-lines).join('\n')
        }
      }

      return { output }
    } catch (err) {
      return { output: '', error: String(err) }
    }
  }

  /**
   * 获取 Agent 状态
   */
  getAgentStatus(agentId: string): AgentInfo | null {
    return this.agents.get(agentId)?.info || null
  }

  /**
   * 列出指定父会话的所有 Agent
   */
  listAgents(parentSessionId?: string): AgentInfo[] {
    const allAgents = Array.from(this.agents.values())
    if (parentSessionId) {
      return allAgents.filter(a => a.parentSessionId === parentSessionId).map(a => a.info)
    }
    return allAgents.map(a => a.info)
  }

  /**
   * 取消 Agent
   */
  cancelAgent(agentId: string): boolean {
    const agent = this.agents.get(agentId)
    if (!agent) return false
    if (agent.info.status === 'cancelled') return false

    // 清理 idle flag
    this.agentIdleFlags.delete(agentId)

    // 无论 agent 逻辑状态如何，都终止底层会话（幂等，已终止则无副作用）
    this.sessionManager.terminateSession(agent.childSessionId).catch(() => {})

    // 已完成/失败的 agent 只需确保底层会话终止，不覆盖状态
    if (agent.info.status === 'completed' || agent.info.status === 'failed') return true

    this.updateAgentStatus(agentId, 'cancelled')
    this.resolveAllWaiters(agentId, { success: false, exitCode: -1, error: 'Cancelled' })
    return true
  }

  /**
   * 处理 MCP Bridge 请求
   */
  handleBridgeRequest(request: BridgeRequest, respond: (response: BridgeResponse) => void): void {
    this._handleBridgeRequestAsync(request, respond).catch(err => {
      respond({ id: request.id, error: `Internal error: ${err.message}` })
    })
  }

  /**
   * 清理所有资源
   */
  cleanup(): void {
    for (const [agentId] of this.agents) {
      this.cancelAgent(agentId)
    }
    this.agents.clear()
    this.childToAgent.clear()
    this.parentToAgents.clear()
    this.agentIdleFlags.clear()

    // 移除 sessionManager 上的事件监听器
    this.sessionManager.off('status-change', this.onSessionStatusChange)
    this.sessionManager.off('activity', this.onSessionActivity)
  }

  // ---- 内部方法 ----

  private onChildSessionEnded(agentId: string, status: string): void {
    const exitCode = status === 'completed' ? 0 : (status === 'error' ? 1 : -1)
    this.completeAgent(agentId, exitCode)
  }

  private completeAgent(agentId: string, exitCode: number): void {
    const agent = this.agents.get(agentId)
    if (!agent) return

    const output = this.getAgentOutput(agentId).output
    const result: AgentResult = {
      success: exitCode === 0,
      exitCode,
      output,
    }

    agent.info.status = exitCode === 0 ? 'completed' : 'failed'
    agent.info.completedAt = new Date().toISOString()
    agent.info.result = result

    // 终止底层子会话进程（幂等，若已终止则无副作用）
    // 修复：oneShot 子代理任务完成后，底层会话不会自动退出，
    // 必须主动 terminate，否则会话持续停在"等待输入"状态
    this.sessionManager.terminateSession(agent.childSessionId).catch(() => {})

    this.updateAgentStatus(agentId, agent.info.status)
    this.resolveAllWaiters(agentId, result)
    this.resolveIdleWaiters(agentId)

    this.emit('agent:completed', agentId, result)
  }

  private updateAgentStatus(agentId: string, status: AgentInfo['status']): void {
    const agent = this.agents.get(agentId)
    if (agent) agent.info.status = status

    try {
      this.database.updateAgentStatus(agentId, status)
    } catch { /* ignore */ }

    this.emit('agent:status-change', agentId, status)
  }

  private resolveAllWaiters(agentId: string, result: AgentResult): void {
    const waiters = this.waiters.get(agentId) || []
    for (const w of waiters) {
      if (w.timer) clearTimeout(w.timer)
      w.resolve(result)
    }
    this.waiters.delete(agentId)
  }

  private resolveIdleWaiters(agentId: string): void {
    const waiters = this.idleWaiters.get(agentId) || []
    const output = this.getAgentOutput(agentId).output
    for (const w of waiters) {
      if (w.timer) clearTimeout(w.timer)
      w.resolve({ idle: true, output })
    }
    this.idleWaiters.delete(agentId)
  }

  private cleanupChildAgents(parentSessionId: string): void {
    const agentIds = this.parentToAgents.get(parentSessionId)
    if (!agentIds) return

    for (const agentId of agentIds) {
      this.cancelAgent(agentId)
    }
    this.parentToAgents.delete(parentSessionId)
  }

  private getParentWorkDir(parentSessionId: string): string {
    const session = this.sessionManager.getSession(parentSessionId)
    return session?.workingDirectory || process.cwd()
  }

  private getPositiveTimeout(value: unknown, fallback: number): number {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return fallback
    return n
  }

  private getEnvTimeoutMs(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) return fallback
    return this.getPositiveTimeout(raw, fallback)
  }

  private isCodexParentSession(parentSessionId: string): boolean {
    const session = this.sessionManager.getSession(parentSessionId)
    return session?.provider?.id === 'codex'
  }

  /**
   * Codex MCP tool call has a hard timeout window (commonly 120s).
   * Keep wait_* calls under a safe bound to avoid tool-level timeout errors.
   */
  private getCodexSafeWaitMaxMs(): number {
    const toolCallTimeoutMs = this.getEnvTimeoutMs(
      'SPECTRAI_CODEX_TOOL_CALL_TIMEOUT_MS',
      DEFAULT_CODEX_TOOL_CALL_TIMEOUT_MS,
    )
    const safetyBufferMs = this.getEnvTimeoutMs(
      'SPECTRAI_CODEX_TOOL_CALL_SAFETY_MS',
      DEFAULT_CODEX_TOOL_CALL_SAFETY_MS,
    )
    const configuredWaitMaxMs = this.getEnvTimeoutMs(
      'SPECTRAI_CODEX_WAIT_MAX_MS',
      DEFAULT_CODEX_WAIT_MAX_MS,
    )
    const budgetedMax = Math.max(5000, toolCallTimeoutMs - safetyBufferMs)
    return Math.max(5000, Math.min(configuredWaitMaxMs, budgetedMax))
  }

  private resolveBridgeWaitTimeoutMs(
    parentSessionId: string,
    requestedTimeout: unknown,
    fallbackTimeout: number,
    method: 'wait_agent' | 'wait_agent_idle',
  ): number {
    const requested = this.getPositiveTimeout(requestedTimeout, fallbackTimeout)
    if (!this.isCodexParentSession(parentSessionId)) return requested

    const codexSafeMax = this.getCodexSafeWaitMaxMs()
    if (requested <= codexSafeMax) return requested

    console.warn(
      `[AgentManagerV2] Clamped ${method} timeout for codex parent session ` +
      `(requested=${requested}ms, effective=${codexSafeMax}ms).`,
    )
    return codexSafeMax
  }

  private sanitizeWorktreeToken(value: unknown, fallback: string, maxLength = 64): string {
    const raw = typeof value === 'string' ? value : ''
    const sanitized = raw
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxLength)
    return sanitized || fallback
  }

  private async enterWorktreeForSession(
    sessionId: string,
    params: Record<string, any>,
  ): Promise<{
    repoPath: string
    worktreePath: string
    branch: string
    baseBranch: string
    taskId: string
    alreadyExists?: boolean
  }> {
    const session = this.sessionManager.getSession(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

    // ★ 复用已有 worktree：若 session 已绑定有效的 worktree，直接返回，避免重复创建
    const existingWorktreePath = session.config?.worktreePath as string | undefined
    const existingWorktreeBranch = session.config?.worktreeBranch as string | undefined
    const existingSourceRepo = session.config?.worktreeSourceRepo as string | undefined
    if (existingWorktreePath && existingWorktreeBranch && existingSourceRepo) {
      const stillValid = await this.gitWorktreeService.verifyWorktree(existingWorktreePath)
      if (stillValid) {
        console.log(`[AgentManagerV2] Reusing existing worktree for session ${sessionId}: ${existingWorktreePath}`)
        return {
          repoPath: existingSourceRepo,
          worktreePath: existingWorktreePath,
          branch: existingWorktreeBranch,
          baseBranch: (session.config?.worktreeBaseBranch as string) || '',
          taskId: existingWorktreePath.split(/[\\/]/).pop() || '',
          alreadyExists: true,
        }
      }
    }

    const repoHint = String(
      params.repoPath ||
      session.config?.worktreeSourceRepo ||
      session.workingDirectory ||
      session.config?.workingDirectory ||
      process.cwd()
    )

    const repoPath = await this.gitWorktreeService.getRepoRoot(repoHint)
    const currentBranch = await this.gitWorktreeService.getCurrentBranch(repoPath)
    const expectedBaseBranch = typeof params.baseBranch === 'string' ? params.baseBranch.trim() : ''

    if (expectedBaseBranch && currentBranch !== expectedBaseBranch) {
      throw new Error(`当前分支为 ${currentBranch}，与期望分支 ${expectedBaseBranch} 不一致`)
    }

    const allowDirty = params.allowDirty === true
    if (!allowDirty) {
      const dirty = await this.gitWorktreeService.isDirty(repoPath)
      if (dirty) {
        throw new Error('仓库存在未提交改动，请先 commit/stash，或显式传 allowDirty=true')
      }
    }

    const nowTag = Date.now().toString(36)
    const defaultToken = `${sessionId.slice(0, 8)}-${nowTag}`
    const nameToken = this.sanitizeWorktreeToken(params.worktreeName ?? params.taskId, defaultToken, 48)
    const defaultBranch = `worktree/${nameToken}`
    const branchName = typeof params.branchName === 'string' && params.branchName.trim()
      ? params.branchName.trim()
      : defaultBranch

    const taskId = this.sanitizeWorktreeToken(
      params.taskId,
      `${sessionId.slice(0, 8)}-${nowTag}-${Math.random().toString(36).slice(2, 7)}`,
      72,
    )

    const expectedPath = this.gitWorktreeService.getWorktreeBasePath(repoPath, taskId)
    const alreadyExists = await this.gitWorktreeService.verifyWorktree(expectedPath)
    const created = alreadyExists
      ? {
          worktreePath: expectedPath,
          branch: await this.gitWorktreeService.getCurrentBranch(expectedPath),
        }
      : await this.gitWorktreeService.createWorktree(repoPath, branchName, taskId)

    // 记录 worktree 创建时的 base commit，用于合并后仍能查看差异
    let baseCommit = ''
    try {
      baseCommit = await this.gitWorktreeService.getHeadCommit(repoPath)
    } catch { /* ignore */ }

    const worktreeMeta = {
      worktreePath: created.worktreePath,
      worktreeBranch: created.branch,
      worktreeSourceRepo: repoPath,
      worktreeBaseCommit: baseCommit,
      worktreeBaseBranch: currentBranch,
    }

    session.config = {
      ...session.config,
      ...worktreeMeta,
    }

    const persisted = this.database.getSession(sessionId)
    const persistedConfig = {
      ...(persisted?.config || {}),
      ...session.config,
      ...worktreeMeta,
    }
    this.database.updateSession(sessionId, { config: persistedConfig } as any)

    return {
      repoPath,
      worktreePath: created.worktreePath,
      branch: created.branch,
      baseBranch: currentBranch,
      taskId,
      ...(alreadyExists ? { alreadyExists: true } : {}),
    }
  }

  private async _handleBridgeRequestAsync(
    request: BridgeRequest,
    respond: (response: BridgeResponse) => void,
  ): Promise<void> {
    const { id, sessionId, method, params } = request

    try {
      switch (method) {
        case 'spawn_agent': {
          const config: AgentConfig = {
            name: params.name || 'Unnamed Agent',
            prompt: params.prompt || '',
            workDir: params.workDir,
            autoAccept: params.autoAccept,
            providerId: params.provider,
            oneShot: params.oneShot,
          }

          // 前置检查：provider CLI 是否已安装
          const requestedProviderId = config.providerId || 'claude-code'
          let targetProvider = BUILTIN_PROVIDERS.find(p => p.id === requestedProviderId)
          if (!targetProvider) {
            try { targetProvider = this.database.getProvider(requestedProviderId) } catch { /* ignore */ }
          }
          if (targetProvider) {
            const available = await isProviderAvailable(targetProvider)
            if (!available) {
              const allProviders = this.database.getAllProviders()
              const availabilityList = await checkProviderAvailability(allProviders)
              const alternatives = availabilityList.filter(a => a.available && a.id !== requestedProviderId)
              const altText = alternatives.length > 0
                ? `可用的 provider: ${alternatives.map(a => a.id).join(', ')}。请换一个 provider 重试。`
                : '当前没有其他可用的 provider。请先安装至少一个 AI CLI 工具。'
              respond({ id, error: `Provider "${requestedProviderId}" 未安装。${altText}` })
              break
            }
          }

          const info = this.spawnAgent(sessionId, config)
          respond({ id, result: { agentId: info.agentId, childSessionId: info.childSessionId } })
          break
        }

        case 'wait_agent': {
          const timeout = this.resolveBridgeWaitTimeoutMs(
            sessionId,
            params.timeout,
            DEFAULT_WAIT_AGENT_TIMEOUT_MS,
            'wait_agent',
          )
          const waitResult = await this.waitAgent(params.agentId, timeout)
          respond({ id, result: waitResult })
          break
        }

        case 'send_to_agent': {
          if (!params.agentId || !params.message) { respond({ id, error: '缺少 agentId 或 message' }); break }
          const sendResult = this.sendToAgent(params.agentId, params.message)
          respond({ id, result: sendResult })
          break
        }

        case 'get_agent_output': {
          if (!params.agentId) { respond({ id, error: '缺少 agentId' }); break }
          const outputResult = this.getAgentOutput(params.agentId, params.lines || 50)
          respond({ id, result: outputResult })
          break
        }

        case 'wait_agent_idle': {
          if (!params.agentId) { respond({ id, error: '缺少 agentId' }); break }
          const timeout = this.resolveBridgeWaitTimeoutMs(
            sessionId,
            params.timeout,
            DEFAULT_WAIT_AGENT_IDLE_TIMEOUT_MS,
            'wait_agent_idle',
          )
          const idleResult = await this.waitAgentIdle(params.agentId, timeout)
          respond({ id, result: idleResult })
          break
        }

        case 'get_agent_status': {
          const info = this.getAgentStatus(params.agentId)
          if (info) { respond({ id, result: info }) }
          else { respond({ id, error: `Agent ${params.agentId} not found` }) }
          break
        }

        case 'list_agents': {
          respond({ id, result: this.listAgents(sessionId) })
          break
        }

        case 'cancel_agent': {
          respond({ id, result: { success: this.cancelAgent(params.agentId) } })
          break
        }

        // ---- Git Worktree 工具 ----

        case 'enter_worktree': {
          const result = await this.enterWorktreeForSession(sessionId, params || {})
          respond({ id, result })
          break
        }

        case 'get_task_info': {
          const taskId = params.taskId
          if (!taskId) { respond({ id, error: '缺少 taskId' }); break }
          const task = this.database.getTask(taskId)
          if (!task) { respond({ id, error: `未找到任务: ${taskId}` }); break }
          respond({ id, result: { taskId: task.id, title: task.title, status: task.status, worktreeEnabled: !!task.worktreeEnabled, gitRepoPath: task.gitRepoPath || null, gitBranch: task.gitBranch || null, worktreePath: task.worktreePath || null } })
          break
        }

        case 'check_merge': {
          let repoPath = params.repoPath
          let worktreePath = params.worktreePath
          let targetBranch = params.targetBranch as string | undefined
          if (params.taskId && (!repoPath || !worktreePath)) {
            const task = this.database.getTask(params.taskId)
            if (!task) { respond({ id, error: `未找到任务: ${params.taskId}` }); break }
            if (!task.worktreeEnabled || !task.gitRepoPath || !task.worktreePath) {
              respond({ id, result: { canMerge: false, error: '该任务未启用 Git Worktree 隔离' } }); break
            }
            repoPath = task.gitRepoPath; worktreePath = task.worktreePath
          }
          if (!repoPath || !worktreePath) { respond({ id, error: '缺少 repoPath 和 worktreePath（或提供 taskId）' }); break }
          // 从 session 中读取 baseBranch，避免 detectMainBranch 误判
          if (!targetBranch) {
            const sess = this.sessionManager.getSession(sessionId)
            targetBranch = (sess?.config?.worktreeBaseBranch as string) || undefined
          }
          try {
            const result = await this.gitWorktreeService.checkMerge(repoPath, worktreePath, targetBranch)
            respond({ id, result })
          } catch (err: any) { respond({ id, error: `合并检查失败: ${err.message}` }) }
          break
        }

        case 'merge_worktree': {
          let repoPath = params.repoPath
          let branchName = params.branchName
          let worktreePath = params.worktreePath
          let targetBranch = params.targetBranch as string | undefined
          const taskId = params.taskId
          if (taskId && (!repoPath || !branchName)) {
            const task = this.database.getTask(taskId)
            if (!task) { respond({ id, error: `未找到任务: ${taskId}` }); break }
            if (!task.worktreeEnabled || !task.gitRepoPath || !task.gitBranch) {
              respond({ id, result: { success: false, error: '该任务未启用 Git Worktree 隔离' } }); break
            }
            repoPath = task.gitRepoPath; branchName = task.gitBranch; worktreePath = task.worktreePath || undefined
          }
          if (!repoPath || !branchName) { respond({ id, error: '缺少 repoPath 和 branchName（或提供 taskId）' }); break }
          // 从 session 中读取 baseBranch，避免 detectMainBranch 误判
          if (!targetBranch) {
            const sess = this.sessionManager.getSession(sessionId)
            targetBranch = (sess?.config?.worktreeBaseBranch as string) || undefined
          }
          try {
            // 合并前先记录 worktree 分支的 commit hash（cleanup 后分支会被删除，但 commit 仍在 git 对象库中）
            let worktreeBranchCommit = ''
            try {
              worktreeBranchCommit = (await this.gitWorktreeService.resolveRef(repoPath, branchName)).trim()
            } catch { /* 分支不存在时忽略 */ }

            const mergeResult = await this.gitWorktreeService.mergeToMain(repoPath, branchName, {
              squash: params.squash ?? true,
              message: params.message || `Merge branch ${branchName} via SpectrAI`,
              cleanup: params.cleanup ?? false,
              targetBranch,
            })

            // 合并成功后，记录 worktree 改动文件
            try {
              const commitFiles = await this.gitWorktreeService.getCommitFiles(repoPath, 'HEAD')
              const statusMap: Record<string, 'create' | 'modify' | 'delete'> = {
                A: 'create', M: 'modify', D: 'delete', R: 'modify', C: 'modify', T: 'modify',
              }
              const changedFiles = commitFiles
                .filter(f => f.path)
                .map(f => ({ path: f.path, changeType: (statusMap[f.statusCode[0]] ?? 'modify') as 'create' | 'modify' | 'delete' }))
              this.emit('worktree:merged', { repoPath, worktreePath, changedFiles })
            } catch (e) {
              console.warn('[AgentManagerV2] Failed to record worktree file changes:', e)
            }

            if (params.cleanup && worktreePath) {
              try {
                await this.gitWorktreeService.removeWorktree(repoPath, worktreePath, { deleteBranch: true, branchName })
                if (taskId) this.database.updateTask(taskId, { worktreePath: '', status: 'done' })
              } catch (cleanupErr: any) {
                console.warn('[AgentManagerV2] Worktree cleanup warning:', cleanupErr.message)
              }
            }

            // 将 worktree 分支 commit hash 保存到 session config，使 cleanup 后仍可查看 diff
            if (worktreeBranchCommit) {
              try {
                const sess = this.sessionManager.getSession(sessionId)
                if (sess) {
                  sess.config = { ...sess.config, worktreeBranchCommit }
                  const persisted = this.database.getSession(sessionId)
                  this.database.updateSession(sessionId, {
                    config: { ...(persisted?.config || {}), ...sess.config },
                  } as any)
                }
              } catch (e) {
                console.warn('[AgentManagerV2] Failed to save worktreeBranchCommit to session:', e)
              }
            }

            respond({ id, result: { success: true, mainBranch: mergeResult.mainBranch, linesAdded: mergeResult.linesAdded, linesRemoved: mergeResult.linesRemoved } })
          } catch (err: any) { respond({ id, error: `合并失败: ${err.message}` }) }
          break
        }

        // ---- 跨会话感知工具 ----

        case 'list_sessions': {
          const allSessions = this.database.getAllSessions()
          const statusFilter = params.status || 'all'
          const limit = params.limit || 20
          let filtered = allSessions
          if (statusFilter !== 'all') filtered = filtered.filter((s: any) => s.status === statusFilter)
          respond({
            id,
            result: filtered.slice(0, limit).map((s: any) => ({
              sessionId: s.id, name: s.name, status: s.status,
              providerId: s.providerId || 'claude-code',
              workingDirectory: s.workingDirectory, startedAt: s.startedAt,
              isCurrent: s.id === sessionId,
            })),
          })
          break
        }

        case 'get_session_summary': {
          const allSessions = this.database.getAllSessions()
          let target: any = null
          if (params.sessionId) target = allSessions.find((s: any) => s.id === params.sessionId)
          else if (params.sessionName) {
            const keyword = params.sessionName.toLowerCase()
            target = allSessions.find((s: any) => s.name?.toLowerCase().includes(keyword))
          }
          if (!target) { respond({ id, error: '未找到匹配的会话' }); break }

          const activities = this.database.getSessionActivities(target.id, 100)
          const aiMessages = activities.filter((a: any) => a.type === 'assistant_message').map((a: any) => a.detail)
          const filesModified = activities.filter((a: any) => ['file_write', 'file_create', 'file_read'].includes(a.type)).map((a: any) => `[${a.type}] ${a.detail}`)
          const commands = activities.filter((a: any) => a.type === 'command_execute').map((a: any) => a.detail)

          respond({
            id,
            result: {
              sessionId: target.id, name: target.name, status: target.status,
              startedAt: target.startedAt, endedAt: target.endedAt,
              aiMessages: aiMessages.slice(0, 10),
              filesModified: [...new Set(filesModified)].slice(0, 20),
              commandsExecuted: commands.slice(0, 20),
            },
          })
          break
        }

        case 'search_sessions': {
          const query = params.query || ''
          const limit = params.limit || 10
          const results = this.database.searchSessionLogs(query, undefined, limit)
          respond({ id, result: results })
          break
        }

        // ---- Skill 技能管理工具 ----

        case 'install_skill': {
          const skillType = (params.type || 'prompt') as 'prompt' | 'native' | 'orchestration'

          // 处理 compatibleProviders 字段
          let compatibleProviders: string[] | 'all' = 'all'
          if (params.compatibleProviders && params.compatibleProviders !== 'all') {
            compatibleProviders = (params.compatibleProviders as string).split(',').map((s: string) => s.trim()).filter(Boolean)
          }

          // 处理 tags 字段
          const tags = params.tags
            ? (params.tags as string).split(',').map((s: string) => s.trim()).filter(Boolean)
            : []

          // 构建 nativeConfig（native 类型）
          const nativeConfig = skillType === 'native' && params.nativeContent
            ? { providerId: 'claude-code', rawContent: params.nativeContent as string }
            : undefined

          const skillData = {
            id: `mcp-installed-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: params.name as string,
            description: params.description as string,
            category: (params.category as string) || 'custom',
            slashCommand: params.slashCommand as string | undefined,
            type: skillType,
            compatibleProviders,
            promptTemplate: skillType === 'prompt' ? (params.promptTemplate as string | undefined) : undefined,
            systemPromptAddition: params.systemPromptAddition as string | undefined,
            nativeConfig,
            isInstalled: true,
            isEnabled: true,
            source: 'custom' as const,
            version: '1.0.0',
            author: (params.author as string) || undefined,
            tags,
          }

          const created = this.database.createSkill(skillData)

          // 通知所有渲染进程刷新 Skill 列表
          this.emit('skill-installed', created)

          respond({
            id, result: {
              success: true,
              skill: {
                id: created.id,
                name: created.name,
                slashCommand: created.slashCommand,
                type: created.type,
              },
              message: `技能"${created.name}"已成功安装到 SpectrAI！${created.slashCommand ? `可通过 /${created.slashCommand} 触发` : ''}对话界面技能列表已自动刷新。`,
            }
          })
          break
        }

        case 'list_skills': {
          let skills = this.database.getAllSkills()
          if (params.enabledOnly) skills = skills.filter((s: any) => s.isEnabled)
          if (params.category) skills = skills.filter((s: any) => s.category === params.category)
          respond({
            id, result: skills.map((s: any) => ({
              id: s.id,
              name: s.name,
              description: s.description,
              slashCommand: s.slashCommand,
              type: s.type,
              category: s.category,
              isEnabled: s.isEnabled,
              source: s.source,
              compatibleProviders: s.compatibleProviders,
            }))
          })
          break
        }

        case 'get_skill': {
          let skill: any = undefined
          if (params.slashCommand) {
            skill = this.database.getSkillByCommand(params.slashCommand)
          } else if (params.id) {
            skill = this.database.getSkill(params.id)
          }
          if (!skill) { respond({ id, error: '未找到指定技能' }); break }
          respond({ id, result: skill })
          break
        }

        default: {
          respond({ id, error: `Unknown method: ${method}` })
        }
      }
    } catch (err: any) {
      respond({ id, error: err.message || 'Internal error' })
    }
  }
}
