/**
 * AgentManager - 核心编排器
 * 管理 Agent 子会话的生命周期
 * ★ 交互式模式：Agent 以持久 PTY 运行，支持多轮对话
 * @author weibin
 */

import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type { SessionManager } from '../session/SessionManager'
import type { DatabaseManager } from '../storage/Database'
import type { OutputParser } from '../parser/OutputParser'
import type { StateInference } from '../parser/StateInference'
import type { OutputReaderManager } from '../reader/OutputReaderManager'
import type { AgentConfig, AgentInfo, AgentResult, BridgeRequest, BridgeResponse } from './types'
import { BUILTIN_PROVIDERS } from '../../shared/types'
import type { AIProvider } from '../../shared/types'
import { GitWorktreeService } from '../git/GitWorktreeService'
import { TailBuffer, stripAnsi, compilePromptMarkers, looksLikeThinking } from './ansiUtils'
import { HeadlessTerminalBuffer } from './HeadlessTerminalBuffer'
import { AgentReadinessDetector, type DetectorConfig } from './AgentReadinessDetector'
import { isProviderAvailable, checkProviderAvailability } from './providerAvailability'
import {
  isInsideWorktree,
  detectBaseBranch,
  injectWorktreeAlreadyActiveRule,
  injectWorktreeAlreadyActiveToAgentsMd,
  injectWorktreeAlreadyActiveToGeminiMd,
} from './supervisorPrompt'

/** 可选依赖：让子会话与 UI 创建的会话享有相同的初始化流程 */
export interface AgentManagerDeps {
  outputParser?: OutputParser
  stateInference?: StateInference
  outputReaderManager?: OutputReaderManager
  gitService?: GitWorktreeService
}

const DEFAULT_WAIT_AGENT_TIMEOUT_MS = 600000
const DEFAULT_WAIT_AGENT_IDLE_TIMEOUT_MS = 600000
const DEFAULT_CODEX_TOOL_CALL_TIMEOUT_MS = 120000
const DEFAULT_CODEX_TOOL_CALL_SAFETY_MS = 15000
const DEFAULT_CODEX_WAIT_MAX_MS = 90000

export class AgentManager extends EventEmitter {
  private sessionManager: SessionManager
  private database: DatabaseManager
  private deps: AgentManagerDeps
  private defaultGitWorktreeService = new GitWorktreeService()
  /** agentId → 等待进程退出的 resolve 回调 */
  private waiters: Map<string, Array<{ resolve: (result: AgentResult) => void; timer?: NodeJS.Timeout }>> = new Map()
  /** agentId → 等待空闲(prompt marker)的 resolve 回调 */
  private idleWaiters: Map<string, Array<{ resolve: (info: { idle: boolean; output: string }) => void; timer?: NodeJS.Timeout }>> = new Map()
  /** childSessionId → agentId 映射 */
  private childToAgent: Map<string, string> = new Map()
  /** agentId → childSessionId 映射 */
  private agentToChild: Map<string, string> = new Map()
  /** 收集子会话的文件操作 */
  private agentArtifacts: Map<string, Set<string>> = new Map()
  /** agentId → HeadlessTerminalBuffer（虚拟终端，正确处理 TUI 重绘） */
  private agentTerminals: Map<string, HeadlessTerminalBuffer> = new Map()
  /** agentId → TailBuffer（原始流，供 ReadinessDetector 做 prompt marker 检测） */
  private agentTailBuffers: Map<string, TailBuffer> = new Map()
  /** agentId → AgentReadinessDetector */
  private agentDetectors: Map<string, AgentReadinessDetector> = new Map()
  /** agentId → oneShot 标记（任务完成后自动终止） */
  private agentOneShot: Map<string, boolean> = new Map()
  /** parentSessionId → Set<agentId> （用于父会话结束时清理子 Agent） */
  private parentToAgents: Map<string, Set<string>> = new Map()
  /** agentId → prompt 发出时的输出长度快照（用于判断 Agent 是否产出了有效内容） */
  private agentOutputSnapshots: Map<string, number> = new Map()
  /** ★ agentId → 发送的 prompt 文本长度（用于从输出增长中扣除回显部分） */
  private agentPromptLengths: Map<string, number> = new Map()
  /** ★ Bug 3 Fix: agentId → 退出前的输出快照（Agent 退出后 tailBuffer 被清理，快照用于 get_agent_output fallback） */
  private exitedAgentOutputs: Map<string, string> = new Map()
  /** ★ v9: agentId → 是否需要在下次 waitAgentIdle 时 reset detector
   *  sendToAgent 设为 true，waitAgentIdle else 分支消费。
   *  首次 wait 不 reset（AI 可能已经回答完了） */
  private needsDetectorReset: Map<string, boolean> = new Map()
  /** ★ agentId → prompt 发送生命周期（带状态追踪，父进程能看到每一步） */
  private agentPromptSent: Map<string, {
    promise: Promise<void>
    resolve: () => void
    /** 当前阶段：waiting_cli=等CLI启动, sending=正在发送, sent=已发送, error=失败 */
    stage: 'waiting_cli' | 'sending' | 'sent' | 'error'
    error?: string
    startedAt: number
  }> = new Map()

  constructor(sessionManager: SessionManager, database: DatabaseManager, deps?: AgentManagerDeps) {
    super()
    this.sessionManager = sessionManager
    this.database = database
    this.deps = deps || {}
    this.listenSessionEvents()
  }

  /**
   * 监听 SessionManager 事件，自动更新 Agent 状态
   */
  private listenSessionEvents(): void {
    // 会话状态变化
    this.sessionManager.on('status-change', (sessionId: string, status: string) => {
      // 子 Agent 会话结束
      const agentId = this.childToAgent.get(sessionId)
      if (agentId) {
        if (status === 'completed' || status === 'error' || status === 'terminated') {
          this.onChildSessionEnded(agentId, sessionId, status)
        } else if (status === 'running') {
          this.database.updateAgentStatus(agentId, 'running')
          this.emit('agent:status-change', agentId, 'running')
        }
        return
      }

      // ★ 父会话结束 → 自动清理所有子 Agent
      // 关键守卫：必须确认 sessionId 确实是一个父会话（在 parentToAgents 中有记录），
      // 否则来自未知 session 的 status-change 不应触发 cleanupChildAgents，
      // 防止子会话的延迟 onExit 事件（childToAgent 已被清理后）被误判为父会话结束
      if (status === 'completed' || status === 'error' || status === 'terminated') {
        if (this.parentToAgents.has(sessionId)) {
          this.cleanupChildAgents(sessionId)
        }
      }
    })

    // ★ v3: 监听 PTY 输出 → 转发给 HeadlessTerminal + TailBuffer + ReadinessDetector
    // HeadlessTerminal 的 write callback 会通知 detector 屏幕已更新（准确检测）
    // TailBuffer 保留用于 scheduleOneShotExit 的输出增长检测
    this.sessionManager.on('output', (sessionId: string, data: string) => {
      const agentId = this.childToAgent.get(sessionId)
      if (!agentId) return

      // 追加到 HeadlessTerminalBuffer（虚拟终端 + 屏幕更新回调 → detector）
      const terminal = this.agentTerminals.get(agentId)
      if (terminal) {
        terminal.append(data)
      }

      // 追加到 TailBuffer（原始流，用于 scheduleOneShotExit 的输出增长追踪）
      const tailBuffer = this.agentTailBuffers.get(agentId)
      if (tailBuffer) {
        tailBuffer.append(data)
      }

      // 通知 detector 有新输出（仅标记 outputSeenSinceReset，实际检测由屏幕回调驱动）
      const detector = this.agentDetectors.get(agentId)
      if (detector) {
        detector.onOutput(data)
      }
    })

    // 收集子会话的文件操作
    this.sessionManager.on('activity', (sessionId: string, event: any) => {
      const agentId = this.childToAgent.get(sessionId)
      if (!agentId) return

      if (event.type === 'file_write' || event.type === 'file_create') {
        if (!this.agentArtifacts.has(agentId)) {
          this.agentArtifacts.set(agentId, new Set())
        }
        const match = event.detail?.match(/(?:Writing|Creating|Wrote|Created)\s+(.+)/i)
        if (match) {
          this.agentArtifacts.get(agentId)!.add(match[1].trim())
        }
      }
    })

    // ★ v4: 监听结构化输出的 task_complete 信号（来自 ClaudeJsonlReader 等）
    // 这是比屏幕检测更准确、更及时的"子 Agent 完成通知"
    // Claude Code: JSONL 中 turn_duration 系统消息 → task_complete
    // 其他 CLI: 无结构化读取器 → 不会触发此事件，仍走屏幕检测
    if (this.deps.outputReaderManager) {
      this.deps.outputReaderManager.on('message', (msg: any) => {
        if (msg.type !== 'task_complete') return

        // 找到对应的 agent
        const agentId = this.childToAgent.get(msg.sessionId)
        if (!agentId) return

        const detector = this.agentDetectors.get(agentId)
        if (detector) {
          console.log(`[AgentManager] Structured signal: task_complete for agent ${agentId}`)
          detector.notifyTaskComplete()
        }
      })
    }
  }

  /**
   * 子会话结束处理 — 增强版
   * 注意：terminateSession + pty.onExit 可能导致同一 childSessionId 触发两次 status-change，
   * 通过 childToAgent 映射检查实现幂等：第一次处理后删除映射，第二次直接跳过。
   */
  private onChildSessionEnded(agentId: string, childSessionId: string, status: string): void {
    // 幂等守卫：防止 terminateSession 和 pty.onExit 双重触发导致重复处理
    if (!this.childToAgent.has(childSessionId)) return
    this.childToAgent.delete(childSessionId)

    const session = this.sessionManager.getSession(childSessionId)
    const exitCode = session?.exitCode ?? -1
    const success = status === 'completed' && exitCode === 0

    // ★ 优先从 HeadlessTerminalBuffer 提取输出（虚拟终端，输出与屏幕一致）
    let rawOutput = ''
    const terminal = this.agentTerminals.get(agentId)
    if (terminal && terminal.length > 0) {
      rawOutput = terminal.getText().trim()
    }
    if (!rawOutput) {
      // fallback: TailBuffer
      const tailBuffer = this.agentTailBuffers.get(agentId)
      if (tailBuffer && tailBuffer.length > 0) {
        rawOutput = stripAnsi(tailBuffer.getText()).trim()
      }
    }
    if (!rawOutput) {
      try {
        const recentOutput = this.sessionManager.getSessionOutput(childSessionId, 100)
        rawOutput = stripAnsi(recentOutput.join('')).trim()
      } catch (_) { /* ignore */ }
    }

    // 从 activity_events 提取结构化信息
    let structuredInfo = ''
    try {
      const activities = this.database.getSessionActivities(childSessionId, 200)
      if (activities && activities.length > 0) {
        const aiMessages = activities
          .filter((a: any) => a.type === 'assistant_message')
          .map((a: any) => a.detail)
        const filesModified = activities
          .filter((a: any) => a.type === 'file_write' || a.type === 'file_create')
          .map((a: any) => a.detail)
        const commands = activities
          .filter((a: any) => a.type === 'command_execute')
          .map((a: any) => a.detail)
        const errors = activities
          .filter((a: any) => a.type === 'error')
          .map((a: any) => a.detail)

        const parts: string[] = []
        if (aiMessages.length > 0) parts.push(`## AI 回答\n${aiMessages.join('\n')}`)
        if (filesModified.length > 0) parts.push(`## 修改的文件\n${filesModified.join('\n')}`)
        if (commands.length > 0) parts.push(`## 执行的命令\n${commands.join('\n')}`)
        if (errors.length > 0) parts.push(`## 错误\n${errors.join('\n')}`)
        structuredInfo = parts.join('\n\n')
      }
    } catch (_) { /* ignore */ }

    // ★ v2: 合并两个来源，而非二选一
    // structuredInfo 提供结构化的活动记录（AI 回答 / 文件修改 / 命令 / 错误）
    // rawOutput 提供完整的终端输出（可能包含 structuredInfo 未覆盖的内容）
    let output = ''
    if (structuredInfo) {
      output = structuredInfo
    }
    if (rawOutput && rawOutput.length > 50) {
      // 如果 rawOutput 与 structuredInfo 有显著不同（不只是子集），则附加
      const rawSection = `\n\n## 终端输出\n${rawOutput}`
      output = output ? output + rawSection : rawOutput
    }
    if (!output) output = '(no output captured)'
    if (output.length > 16000) output = output.slice(-16000)

    const artifacts = this.agentArtifacts.has(agentId)
      ? Array.from(this.agentArtifacts.get(agentId)!)
      : undefined

    const agentStatus = success ? 'completed' : 'failed'

    // ★ 获取 Agent 使用的 providerId，用于失败时提示切换
    const usedProviderId = session?.config?.providerId || 'claude-code'

    // ★ 检测常见的额度/认证错误，生成切换建议
    let errorMsg: string | undefined
    if (!success) {
      const lowerOutput = (output || '').toLowerCase()
      const isQuotaError = lowerOutput.includes('rate limit') || lowerOutput.includes('quota')
        || lowerOutput.includes('429') || lowerOutput.includes('exceeded')
        || lowerOutput.includes('billing') || lowerOutput.includes('insufficient')
      const isAuthError = lowerOutput.includes('unauthorized') || lowerOutput.includes('401')
        || lowerOutput.includes('api key') || lowerOutput.includes('authentication')
        || lowerOutput.includes('not authenticated')

      if (isQuotaError || isAuthError) {
        const reason = isQuotaError ? '额度不足/请求限流' : '认证失败'
        errorMsg = `Agent 失败（${reason}，provider: ${usedProviderId}）。建议使用其他 provider 重试，可选：claude-code, codex, gemini-cli, opencode`
      } else {
        errorMsg = `Agent exited with status: ${status}, code: ${exitCode}`
      }
    }

    const result: AgentResult = {
      success,
      exitCode,
      output,
      error: errorMsg,
      failedProvider: !success ? usedProviderId : undefined,
      artifacts
    }

    this.database.updateAgentStatus(agentId, agentStatus)
    this.database.saveAgentResult(agentId, result)
    this.emit('agent:status-change', agentId, agentStatus)
    this.emit('agent:completed', agentId, result)

    // 唤醒 wait_agent 等待者
    const waiters = this.waiters.get(agentId) || []
    for (const w of waiters) {
      if (w.timer) clearTimeout(w.timer)
      w.resolve(result)
    }
    this.waiters.delete(agentId)

    // ★ 唤醒 wait_agent_idle 等待者（Agent 退出也算结束）
    const idleWaiterList = this.idleWaiters.get(agentId) || []
    for (const w of idleWaiterList) {
      if (w.timer) clearTimeout(w.timer)
      w.resolve({ idle: false, output: `Agent exited (${agentStatus})` })
    }
    this.idleWaiters.delete(agentId)

    // ★ Bug 3 Fix: 在清理 tailBuffer 之前保存输出快照
    this.saveOutputSnapshot(agentId)

    // ★ 清理 detector、terminal、tailBuffer、oneShot 标记
    const detector = this.agentDetectors.get(agentId)
    if (detector) { detector.destroy(); this.agentDetectors.delete(agentId) }
    const endedTerminal = this.agentTerminals.get(agentId)
    if (endedTerminal) { endedTerminal.dispose(); this.agentTerminals.delete(agentId) }
    this.agentTailBuffers.delete(agentId)
    this.agentArtifacts.delete(agentId)
    this.agentOneShot.delete(agentId)
    this.agentOutputSnapshots.delete(agentId)
    this.agentPromptLengths.delete(agentId)
    this.agentPromptSent.delete(agentId)
    this.needsDetectorReset.delete(agentId)

    // 从 parentToAgents 中移除
    const childSid = this.agentToChild.get(agentId)
    if (childSid) {
      const info = this.database.getAgentInfo(agentId)
      if (info?.parentSessionId) {
        const siblings = this.parentToAgents.get(info.parentSessionId)
        if (siblings) {
          siblings.delete(agentId)
          if (siblings.size === 0) this.parentToAgents.delete(info.parentSessionId)
        }
      }
    }
    this.agentToChild.delete(agentId)
  }

  /**
   * 创建子 Agent 会话 — 交互式模式
   * ★ spawnAgent 立即返回，prompt 在后台异步发送（等待就绪后通过 stdin 写入）
   */
  spawnAgent(parentSessionId: string, config: AgentConfig): AgentInfo {
    const agentId = uuidv4()
    const childSessionId = `agent-${agentId.slice(0, 8)}`

    const parentSession = this.sessionManager.getSession(parentSessionId)
    const workDir = config.workDir || parentSession?.workingDirectory || process.cwd()

    const providerId = config.providerId || 'claude-code'
    let provider: AIProvider | undefined = undefined
    try { provider = this.database.getProvider(providerId) } catch (_) { /* 使用默认 */ }
    // 如果数据库没有，从内置列表查找
    if (!provider) {
      provider = BUILTIN_PROVIDERS.find(p => p.id === providerId)
    }

    // ★ v3: 构建 Detector 配置
    const detectorConfig: DetectorConfig = {
      promptMarkers: compilePromptMarkers(provider?.promptMarkerPatterns),
      maxWaitMs: provider?.stateConfig?.startupStuckMs
        ? Math.max(provider.stateConfig.startupStuckMs * 4, 180000)
        : 180000,
      quiescenceThresholdMs: 3000,  // ★ v4: 虚拟终端屏幕已稳定，3 秒足够
      postResetCooldownMs: provider?.stateConfig?.idleTimeoutMs
        ? Math.max(provider.stateConfig.idleTimeoutMs, 2000)
        : 2000,  // ★ v4: prompt 回显通常 1 秒内完成，2 秒冷却足够
    }
    // ★ v3: 先创建 detector，再创建 HeadlessTerminalBuffer 并连接回调
    const detector = new AgentReadinessDetector(agentId, detectorConfig)
    // ★ v3: 创建 HeadlessTerminalBuffer，write 完成后通知 detector 屏幕已更新
    const headlessTerminal = new HeadlessTerminalBuffer({
      onScreenUpdate: (info) => {
        const det = this.agentDetectors.get(agentId)
        if (det) {
          det.onScreenUpdate(info.lastLines, info.totalAppended)
        }
      },
    })
    this.agentTerminals.set(agentId, headlessTerminal)
    // TailBuffer 保留用于 scheduleOneShotExit 的输出增长追踪
    const tailBuffer = new TailBuffer(32768)
    this.agentTailBuffers.set(agentId, tailBuffer)
    this.agentDetectors.set(agentId, detector)

    // 先绑定映射，避免竞态
    this.childToAgent.set(childSessionId, agentId)
    this.agentToChild.set(agentId, childSessionId)

    // ★ 记录 oneShot 标记（默认 true）— 提前到 args 构建前，因为 isNonInteractive 依赖它
    const isOneShot = config.oneShot !== false

    // ★ 根据 provider 配置决定 prompt 传递方式
    // ★ 修复：不再 fallback 到 --dangerously-skip-permissions，避免不支持该参数的 provider 报错
    const autoAcceptArg = provider?.autoAcceptArg ?? (providerId === 'claude-code' ? '--dangerously-skip-permissions' : '')
    // ★ v4: oneShot + 有 printModeArgs → 走非交互模式（进程完成后自动退出，无需 heuristic 检测）
    // 优先从 BUILTIN_PROVIDERS 获取 printModeArgs（DB 不存储此字段，provider 合并后可能丢失）
    const builtinProvider = BUILTIN_PROVIDERS.find(p => p.id === providerId)
    const printModeArgs = provider?.printModeArgs || builtinProvider?.printModeArgs
    const hasPrintMode = printModeArgs && printModeArgs.length > 0
    const isNonInteractive = isOneShot && !!hasPrintMode
    const claudeArgs: string[] = []
    if (isNonInteractive && printModeArgs) {
      // 非交互式 print 模式：子命令/flag + prompt + autoAccept
      // 子命令（如 codex exec）需放在最前面
      // 构建顺序：[printModeArgs...] [prompt] [autoAcceptArg]
      claudeArgs.push(...printModeArgs)
      claudeArgs.push(config.prompt)
      if (autoAcceptArg) claudeArgs.push(autoAcceptArg)
    } else {
      // 交互式 TUI 模式：只放 autoAcceptArg
      if (autoAcceptArg) claudeArgs.push(autoAcceptArg)
    }
    const sessionConfig = {
      id: childSessionId,
      name: `[Agent] ${config.name}`,
      workingDirectory: workDir,
      autoAccept: false,
      parentSessionId,
      agentId,
      providerId,
      claudeArgs,
    }

    // ★ 修复时序 Bug：Agent DB 行必须在 createSessionWithId 之前创建
    // createSessionWithId 会同步 emit 'status-change: running'，
    // listener 会调 updateAgentStatus(agentId, 'running')。
    // 如果 DB 行还不存在，update 就是 no-op，之后 createAgentSession
    // 又以 'pending' 状态创建行 → status 永远卡在 pending。
    const agentInfo: AgentInfo = {
      agentId,
      name: config.name,
      parentSessionId,
      childSessionId,
      status: 'pending',
      prompt: config.prompt,
      workDir,
      createdAt: new Date().toISOString()
    }
    this.database.createAgentSession(agentInfo)

    this.sessionManager.createSessionWithId(childSessionId, sessionConfig, undefined, provider)

    try {
      this.database.createSession({
        id: childSessionId,
        name: `[Agent] ${config.name}`,
        nameLocked: true,
        workingDirectory: workDir,
        status: 'running',
        estimatedTokens: 0,
        config: sessionConfig,
        providerId,
      })
    } catch (_) { /* 忽略重复插入 */ }

    if (provider) {
      this.deps.outputParser?.registerSessionProvider(childSessionId, provider)
      this.deps.stateInference?.registerSessionConfig(childSessionId, provider.stateConfig)
    }

    this.deps.outputReaderManager?.startWatching(childSessionId, providerId, workDir)
    if (this.deps.outputReaderManager?.hasActiveReader(childSessionId)) {
      this.deps.outputParser?.setStructuredReaderActive(childSessionId)
    }

    // ★ 子 Agent Worktree 规则注入
    // 若 autoWorktree 开启且 workDir 是一个 git secondary worktree，
    // 告知子 Agent"已在隔离 worktree，直接改文件"，避免子 Agent 再次尝试调用 enter_worktree 而失败。
    // 注意：仅在 workDir 确实是 worktree 时才注入（isInsideWorktree 通过 .git 文件类型判断）。
    try {
      const appSettings = this.database.getAppSettings()
      if (appSettings.autoWorktree && isInsideWorktree(workDir)) {
        const branchName = detectBaseBranch(workDir)
        if (providerId === 'claude-code') {
          injectWorktreeAlreadyActiveRule(workDir, branchName)
        } else if (providerId === 'codex') {
          injectWorktreeAlreadyActiveToAgentsMd(workDir, branchName)
        } else if (providerId === 'gemini-cli') {
          injectWorktreeAlreadyActiveToGeminiMd(workDir, branchName)
        }
        console.log(`[AgentManager] Injected worktree-already-active rule to ${providerId} agent (workDir: ${workDir})`)
      }
    } catch (wtErr: any) {
      console.warn(`[AgentManager] Failed to inject worktree rule to agent: ${wtErr.message}`)
    }

    this.agentOneShot.set(agentId, isOneShot)

    // ★ 注册父子关系（用于父会话结束时批量清理）
    if (!this.parentToAgents.has(parentSessionId)) {
      this.parentToAgents.set(parentSessionId, new Set())
    }
    this.parentToAgents.get(parentSessionId)!.add(agentId)

    // ★ 后台异步：根据 provider 类型决定 prompt 传递方式
    if (isNonInteractive) {
      // 非交互式 CLI：prompt 已在命令行参数中，进程会自行完成并退出
      // 不需要 sendPromptWhenReady，也不需要 scheduleOneShotExit（进程退出时 onChildSessionEnded 会处理）
      console.log(`[AgentManager] Non-interactive agent ${agentId} started with prompt in args (${config.prompt.length} chars), provider=${providerId}, printModeArgs=${JSON.stringify(printModeArgs)}, claudeArgs=${JSON.stringify(claudeArgs)}`)
    } else {
      // 交互式 TUI：等待就绪后通过 stdin 发送 prompt
      // ★ 创建 promptSent 信号：waitAgentIdle 必须等 prompt 发出后才开始检测
      // 防止 waitAgentIdle 和 sendPromptWhenReady 共享首次 waitReady() Promise
      // 导致 CLI 启动时 waitAgentIdle 误判为 idle
      let promptSentResolve: () => void
      const promptSentPromise = new Promise<void>((r) => { promptSentResolve = r })
      this.agentPromptSent.set(agentId, {
        promise: promptSentPromise,
        resolve: promptSentResolve!,
        stage: 'waiting_cli',
        startedAt: Date.now()
      })
      this.sendPromptWhenReady(agentId, childSessionId, config.prompt, isOneShot)
    }

    this.emit('agent:created', agentInfo)
    return agentInfo
  }

  /**
   * ★ 等待 Agent 就绪后发送 prompt（异步后台任务）
   *
   * ★ v4 修复竞态条件：
   * 旧逻辑在 writeTextToPty 之后才 reset detector，导致并行的 waitAgentIdle
   * 可能在 reset 之前拿到已解析的旧 readyPromise → 立即返回 idle=true（误判）。
   * 新逻辑：先 reset → 再写 prompt，确保任何新的 waitReady() 都会创建新 Promise。
   */
  private async sendPromptWhenReady(agentId: string, childSessionId: string, prompt: string, oneShot: boolean): Promise<void> {
    const detector = this.agentDetectors.get(agentId)
    if (!detector) {
      const earlySignal = this.agentPromptSent.get(agentId)
      if (earlySignal) {
        earlySignal.stage = 'error'
        earlySignal.error = 'Detector not found'
        earlySignal.resolve()
      }
      return
    }

    const signal = this.agentPromptSent.get(agentId)

    console.log(`[AgentManager] sendPromptWhenReady: stage=waiting_cli (agent=${agentId}, oneShot=${oneShot})`)
    const t0 = Date.now()
    const ready = await detector.waitReady()
    console.log(`[AgentManager] sendPromptWhenReady: CLI startup ${ready ? 'OK' : 'TIMED OUT'} (${Date.now() - t0}ms)`)

    if (!ready) {
      console.warn(`[AgentManager] Agent ${agentId} readiness timed out, sending prompt anyway`)
    }

    // ★ v6: 额外等待 CLI 输入框完全激活
    // Welcome Banner 显示完毕后，Ink TUI 还需要短暂初始化才能接收 stdin
    const POST_READY_DELAY_MS = 1500
    console.log(`[AgentManager] sendPromptWhenReady: waiting ${POST_READY_DELAY_MS}ms for TUI input activation`)
    await new Promise(r => setTimeout(r, POST_READY_DELAY_MS))

    const session = this.sessionManager.getSession(childSessionId)
    if (!session || session.status === 'completed') {
      console.warn(`[AgentManager] Agent ${agentId} session already ended, skipping prompt send`)
      if (signal) {
        signal.stage = 'error'
        signal.error = 'Session ended before prompt could be sent'
        signal.resolve()
      }
      return
    }

    // ★ v4: 先重置 detector
    detector.reset()

    // ★ v5: 交互式模式关闭 Fast Path
    if (!oneShot) {
      detector.fastPathDisabled = true
    }

    // ★ 更新阶段：正在发送
    if (signal) signal.stage = 'sending'
    console.log(`[AgentManager] sendPromptWhenReady: stage=sending (${prompt.length} chars)`)

    // ★ v8: 发送 prompt 并验证 CLI 是否接收到（带重试 + prompt 文本回显验证）
    // v6 的 bug：只检查屏幕增长量，并发时 Welcome banner 最后几行渲染也会导致增长 → 误判
    // v8 修复：必须在屏幕上看到 prompt 文本的前 N 个字符才算发送成功
    const htbBeforeSend = this.agentTerminals.get(agentId)
    const MAX_SEND_RETRIES = 5
    let sendSuccess = false
    // 取 prompt 的前 15 个字符作为验证标记（去掉空格，避免被 TUI 换行打断）
    const promptFingerprint = prompt.replace(/\s+/g, '').slice(0, 15)

    for (let attempt = 1; attempt <= MAX_SEND_RETRIES; attempt++) {
      console.log(`[AgentManager] sendPromptWhenReady: send attempt ${attempt}/${MAX_SEND_RETRIES}`)

      await this.writeTextToPty(childSessionId, prompt)

      // 等待 CLI 处理输入并更新屏幕（回显或开始处理）
      const VERIFY_DELAY_MS = 3000
      await new Promise(r => setTimeout(r, VERIFY_DELAY_MS))

      // ★ v8: 验证屏幕上是否出现了 prompt 文本（而非仅检查屏幕增长）
      // CLI 会回显 prompt 文本，所以屏幕上一定能找到 prompt 的关键词
      const screenAfterSend = htbBeforeSend ? htbBeforeSend.getText() : ''
      const screenNoSpaces = screenAfterSend.replace(/\s+/g, '')
      const hasPromptEcho = screenNoSpaces.includes(promptFingerprint)

      console.log(`[AgentManager] sendPromptWhenReady: attempt ${attempt} — hasPromptEcho=${hasPromptEcho}, fingerprint="${promptFingerprint}"`)

      if (hasPromptEcho) {
        sendSuccess = true
        break
      }

      if (attempt < MAX_SEND_RETRIES) {
        console.warn(`[AgentManager] sendPromptWhenReady: prompt text not found on screen after attempt ${attempt}, retrying...`)
        // 递增等待：越往后等越久，给 CLI 更多初始化时间
        await new Promise(r => setTimeout(r, 1000 + attempt * 500))
      }
    }

    if (!sendSuccess) {
      console.error(`[AgentManager] sendPromptWhenReady: prompt delivery failed after ${MAX_SEND_RETRIES} attempts! CLI may not have received the input.`)
    }

    // ★ 更新阶段：已发送（不管是否成功，都标记为 sent 以避免 waitAgentIdle 卡死）
    if (signal) {
      signal.stage = sendSuccess ? 'sent' : 'error'
      if (!sendSuccess) signal.error = `Prompt delivery failed after ${MAX_SEND_RETRIES} attempts`
      signal.resolve()
    }
    console.log(`[AgentManager] sendPromptWhenReady: stage=${sendSuccess ? 'sent' : 'error'}, total=${Date.now() - t0}ms`)

    // ★ 记录 prompt 文本长度，用于后续从输出增长中扣除回显部分
    // CLI 会回显 prompt 文本，导致输出增长 ≈ prompt.length，这不是 AI 的回答
    this.agentPromptLengths.set(agentId, prompt.length)

    // ★ v3: 记录 prompt 发出时的屏幕文本长度快照（与 scheduleOneShotExit 用同一数据源）
    const htb = this.agentTerminals.get(agentId)
    if (htb) {
      this.agentOutputSnapshots.set(agentId, htb.getText().length)
    }

    // ★ oneShot 模式：等待 Agent 完成任务后自动退出
    if (oneShot) {
      this.scheduleOneShotExit(agentId, childSessionId)
    }
  }

  /**
   * ★ oneShot 模式：异步等待 Agent 完成当前任务后发送 /exit 退出
   * 关键守卫：即使 detector 判定就绪，也必须确认 Agent 产出了有效内容才允许 exit
   *
   * ★ v2 修复：
   * - detector 超时（ready=false）时不再直接放弃，而是检查会话是否还活着 → 活着就重试
   * - 这修复了"长任务超过 detector 超时导致 oneShot 提前退出"的问题
   *
   * ★ v3: 卡住检测 — 通过 TailBuffer.totalAppended 追踪输出增长率
   * - 每次 detector 超时时对比上次快照，判断 Agent 是否还在产出
   * - 连续 MAX_STALE_CYCLES 个周期无输出增长 → 判定卡住，提前退出
   * - 有输出增长 → Agent 还在工作，无限重试（不设硬上限）
   */
  private async scheduleOneShotExit(agentId: string, childSessionId: string): Promise<void> {
    const MAX_HARD_RETRIES = 20      // 绝对上限（防止无限循环，约 20×180s = 60 分钟）
    const MAX_STALE_CYCLES = 2       // 连续 N 个超时周期无输出增长 → 判定卡住
    const MIN_MEANINGFUL_OUTPUT = 200 // ★ Bug 1 Fix: 从 50 提升到 200，thinking 标记文本通常 50-150 字符

    let staleCycles = 0                // 连续无输出增长的超时周期计数
    let lastTotalAppended = 0          // 上次记录的 totalAppended 快照
    const tailBuffer = this.agentTailBuffers.get(agentId)
    if (tailBuffer) {
      lastTotalAppended = tailBuffer.totalAppended
    }

    for (let attempt = 0; attempt <= MAX_HARD_RETRIES; attempt++) {
      const detector = this.agentDetectors.get(agentId)
      if (!detector) return

      const ready = await detector.waitReady()

      // ★ 先检查会话是否还活着（无论 ready 与否）
      const session = this.sessionManager.getSession(childSessionId)
      if (!session || session.status === 'completed' || session.status === 'error' || session.status === 'terminated') {
        return  // 会话已结束，不需要 oneShot exit
      }

      if (!ready) {
        // Detector 超时但会话还活 → 检查输出增长判断是"还在工作"还是"卡住了"
        const currentTotal = tailBuffer ? tailBuffer.totalAppended : 0
        const growth = currentTotal - lastTotalAppended

        if (growth > 0) {
          // 有输出增长 → Agent 在工作，重置卡住计数
          staleCycles = 0
          lastTotalAppended = currentTotal
          console.log(
            `[AgentManager] OneShot agent ${agentId} detector timed out, but output grew +${growth} bytes. ` +
            `Agent still working, retry ${attempt + 1}.`
          )
        } else {
          // 无输出增长 → 可能卡住
          staleCycles++
          if (staleCycles >= MAX_STALE_CYCLES) {
            console.warn(
              `[AgentManager] OneShot agent ${agentId} STUCK: no output for ${staleCycles} consecutive cycles ` +
              `(~${staleCycles * 180}s). Proceeding with exit.`
            )
            break  // 判定卡住，退出循环
          }
          console.warn(
            `[AgentManager] OneShot agent ${agentId} detector timed out, no output growth. ` +
            `Stale cycle ${staleCycles}/${MAX_STALE_CYCLES}. Retry ${attempt + 1}.`
          )
        }

        detector.reset()
        continue
      }

      // ★ Detector 判定就绪（检测到 prompt marker 或 quiescence）
      // ★ v3: 使用 HeadlessTerminalBuffer 的屏幕内容计算输出增长
      const promptEchoLen = this.agentPromptLengths.get(agentId) || 0
      const snapshotLen = this.agentOutputSnapshots.get(agentId) || 0
      const htb = this.agentTerminals.get(agentId)
      const currentScreenText = htb ? htb.getText() : ''
      const currentLen = currentScreenText.length
      const rawGrowth = currentLen - snapshotLen
      const effectiveGrowth = Math.max(0, rawGrowth - Math.ceil(promptEchoLen * 1.2))

      // ★ v3: 在屏幕内容上检测 thinking（更准确）
      if (effectiveGrowth < MIN_MEANINGFUL_OUTPUT && looksLikeThinking(currentScreenText)) {
        console.warn(
          `[AgentManager] OneShot agent ${agentId} detector says ready, but AI still thinking ` +
          `(rawGrowth=${rawGrowth}, promptEcho≈${promptEchoLen}, effective=${effectiveGrowth}). Retry ${attempt + 1}.`
        )
        detector.reset()
        continue
      }

      // 有效内容守卫：扣除回显后的增长必须 >= MIN_MEANINGFUL_OUTPUT
      if (effectiveGrowth < MIN_MEANINGFUL_OUTPUT && attempt < MAX_HARD_RETRIES) {
        console.warn(
          `[AgentManager] OneShot agent ${agentId} detector says ready, but effective output only ${effectiveGrowth} chars ` +
          `(raw=${rawGrowth}, echo≈${promptEchoLen}, min=${MIN_MEANINGFUL_OUTPUT}). ` +
          `Retry ${attempt + 1} — likely just prompt echo.`
        )
        detector.reset()
        continue  // 重新等待
      }

      if (effectiveGrowth < MIN_MEANINGFUL_OUTPUT) {
        console.warn(
          `[AgentManager] OneShot agent ${agentId} exhausted retries with only ${effectiveGrowth} chars effective output. Proceeding with exit.`
        )
      }

      break  // 有效内容确认，或重试耗尽，跳出循环
    }

    // 再次检查会话状态（循环中可能已变化）
    const session2 = this.sessionManager.getSession(childSessionId)
    if (!session2 || session2.status === 'completed' || session2.status === 'error' || session2.status === 'terminated') {
      return
    }

    // 先唤醒所有 idle waiters（让它们拿到输出结果）
    const idleWaiterList = this.idleWaiters.get(agentId) || []
    for (const w of idleWaiterList) {
      if (w.timer) clearTimeout(w.timer)
      const out = this.getAgentOutput(agentId, 50).output
      w.resolve({ idle: true, output: out })
    }
    this.idleWaiters.delete(agentId)

    // 等一小段时间让 Supervisor 取走结果，然后发 /exit 退出
    await new Promise(r => setTimeout(r, 2000))

    // 再次检查：可能在等待期间 Supervisor 又发了新指令（send_to_agent）
    // 如果 detector 被 reset 了（说明有新交互），则不退出
    const currentDetector = this.agentDetectors.get(agentId)
    if (!currentDetector) return

    const currentSession = this.sessionManager.getSession(childSessionId)
    if (!currentSession || currentSession.status === 'completed') return

    console.log(`[AgentManager] OneShot agent ${agentId} completed, sending /exit`)
    try {
      await this.writeTextToPty(childSessionId, '/exit')
    } catch (_) { /* ignore */ }

    // /exit 只退出 Claude Code 进程，底层 shell（PowerShell/bash）可能仍在运行
    // 等待一段时间后检查 PTY 是否已退出，如果没有则强制终止
    await new Promise(r => setTimeout(r, 5000))
    const afterExitSession = this.sessionManager.getSession(childSessionId)
    if (afterExitSession && afterExitSession.status !== 'completed' && afterExitSession.status !== 'terminated') {
      console.log(`[AgentManager] OneShot agent ${agentId} PTY still alive after /exit, force terminating`)
      try {
        this.sessionManager.terminateSession(childSessionId)
      } catch (_) { /* ignore */ }
    }
  }

  /**
   * ★ 向运行中的 Agent 发送消息（多轮交互核心）
   */
  sendToAgent(agentId: string, message: string): { success: boolean; error?: string } {
    const childSessionId = this.agentToChild.get(agentId)
    if (!childSessionId) return { success: false, error: `Agent ${agentId} not found` }

    const session = this.sessionManager.getSession(childSessionId)
    if (!session || session.status === 'completed') {
      return { success: false, error: `Agent ${agentId} session is not running` }
    }

    // ★ 清除首次 promptSent 信号（后续轮次不需要等待）
    // send_to_agent 说明首次 prompt 已完成，后续 waitAgentIdle 应直接检测
    this.agentPromptSent.delete(agentId)

    // 异步写入（不阻塞返回）
    // ★ v8: 异步写入 + 回显验证重试（与 sendPromptWhenReady 相同逻辑）
    this.writeTextWithRetry(agentId, childSessionId, message).catch(() => { /* ignore */ })

    // ★ v7: 不在这里 reset detector！
    // 原因：sendToAgent 返回后，还有 MCP 网络往返才到 waitAgentIdle。
    // 如果在这里 reset，task_complete 等结构化信号会在 waitAgentIdle 订阅前到达，
    // 被 detector 丢弃（readyResolve=null）。改为在 waitAgentIdle 开始检测时再 reset。

    // ★ 记录 prompt 长度（用于 waitAgentIdle 扣除回显）
    this.agentPromptLengths.set(agentId, message.length)

    // ★ v9: 标记需要在下次 waitAgentIdle 时 reset detector
    this.needsDetectorReset.set(agentId, true)

    console.log(`[AgentManager] Sent message to agent ${agentId} (${message.length} chars)`)
    return { success: true }
  }

  /**
   * ★ v8: 写入文本到 PTY 并验证回显（带重试）
   * 用于 sendToAgent 等场景，确保消息可靠到达 TUI
   */
  private async writeTextWithRetry(agentId: string, childSessionId: string, text: string): Promise<boolean> {
    const htb = this.agentTerminals.get(agentId)
    const fingerprint = text.replace(/\s+/g, '').slice(0, 15)
    const MAX_RETRIES = 5

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      console.log(`[AgentManager] writeTextWithRetry: attempt ${attempt}/${MAX_RETRIES}`)
      await this.writeTextToPty(childSessionId, text)
      await new Promise(r => setTimeout(r, 3000))

      const screen = htb ? htb.getText().replace(/\s+/g, '') : ''
      if (screen.includes(fingerprint)) {
        console.log(`[AgentManager] writeTextWithRetry: prompt echo confirmed on attempt ${attempt}`)
        return true
      }

      if (attempt < MAX_RETRIES) {
        console.warn(`[AgentManager] writeTextWithRetry: no echo after attempt ${attempt}, retrying...`)
        await new Promise(r => setTimeout(r, 1000 + attempt * 500))
      }
    }
    console.error(`[AgentManager] writeTextWithRetry: failed after ${MAX_RETRIES} attempts`)
    return false
  }

  /**
   * ★ 安全地将文本写入 PTY 并按 Enter
   * 对于包含换行符的文本，先将换行替换为空格（避免被 TUI 当成提前提交）。
   */
  private async writeTextToPty(childSessionId: string, text: string): Promise<void> {
    // ★ v6: 减小 chunk 大小以提高 Ink TUI stdin 处理可靠性
    // Ink 在 raw mode 下逐字节处理 stdin，太大的写入可能导致丢弃
    const CHUNK_SIZE = 64

    try {
      const session = this.sessionManager.getSession(childSessionId)
      console.log(`[AgentManager] writeTextToPty: session=${childSessionId}, exists=${!!session}, status=${session?.status}, textLen=${text.length}`)

      if (!session) {
        console.error(`[AgentManager] writeTextToPty: session not found!`)
        return
      }

      // ★ 将换行符替换为空格，避免被 TUI 当成 Enter 提交
      const sanitized = text.replace(/[\r\n]+/g, ' ')

      // 分块写入文本（小 chunk 避免 Ink TUI 处理问题）
      const chunks = Math.ceil(sanitized.length / CHUNK_SIZE)
      console.log(`[AgentManager] writeTextToPty: sending ${chunks} chunk(s), total ${sanitized.length} chars`)
      for (let i = 0; i < sanitized.length; i += CHUNK_SIZE) {
        const chunk = sanitized.slice(i, i + CHUNK_SIZE)
        this.sessionManager.sendInput(childSessionId, chunk)
        // 每个 chunk 之间留 30ms，让 Ink TUI 有时间处理
        if (i + CHUNK_SIZE < sanitized.length) {
          await new Promise(r => setTimeout(r, 30))
        }
      }

      console.log(`[AgentManager] writeTextToPty: text sent, waiting 2000ms before Enter`)
      await new Promise(r => setTimeout(r, 2000))

      // ★ v7: 只发 \r — 与 xterm.js 键盘回车一致
      // \r\n 会被 Ink TUI 当成两个字符嵌入文本，不会触发提交
      console.log(`[AgentManager] writeTextToPty: sending Enter (\\r)`)
      this.sessionManager.sendInput(childSessionId, '\r')
      console.log(`[AgentManager] writeTextToPty: done`)
    } catch (err) {
      console.error(`[AgentManager] writeTextToPty FAILED:`, err)
    }
  }

  /**
   * ★ 获取 Agent 最近的终端输出
   * 优先从 HeadlessTerminalBuffer 读取（虚拟终端，输出与屏幕一致），
   * fallback 到 TailBuffer + stripAnsi（兼容旧逻辑）
   */
  getAgentOutput(agentId: string, lines?: number): { output: string; error?: string } {
    // ★ 优先从 HeadlessTerminalBuffer 读取（正确处理 TUI 重绘）
    const terminal = this.agentTerminals.get(agentId)
    if (terminal) {
      if (lines && lines > 0) {
        return { output: terminal.getLastLines(lines).join('\n') }
      }
      return { output: terminal.getText() }
    }

    // Fallback: HeadlessTerminal 已清理，尝试快照
    const snapshot = this.exitedAgentOutputs.get(agentId)
    if (snapshot) {
      if (lines && lines > 0) {
        const allLines = snapshot.split('\n')
        return { output: allLines.slice(-lines).join('\n') }
      }
      return { output: snapshot }
    }

    // 最后 fallback: TailBuffer（不应走到这里，但保留安全网）
    const tailBuffer = this.agentTailBuffers.get(agentId)
    if (tailBuffer) {
      const cleaned = stripAnsi(tailBuffer.getText())
        .replace(/[\x00-\x1f\x7f]/g, (ch) => ch === '\n' || ch === '\r' || ch === '\t' ? ch : '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
      if (lines && lines > 0) {
        const allLines = cleaned.split('\n')
        return { output: allLines.slice(-lines).join('\n') }
      }
      return { output: cleaned }
    }

    return { output: '', error: `Agent ${agentId} not found or no output` }
  }

  /**
   * ★ Bug 3 Fix: 保存 Agent 的输出快照（在清理 buffer 之前调用）
   * 幂等：已保存过的不再覆写（防止多次触发时最后一次快照是空的）
   */
  private saveOutputSnapshot(agentId: string): void {
    // 防止重复保存
    if (this.exitedAgentOutputs.has(agentId)) return

    // ★ 优先从 HeadlessTerminalBuffer 获取（输出更准确）
    const terminal = this.agentTerminals.get(agentId)
    if (terminal && terminal.length > 0) {
      this.exitedAgentOutputs.set(agentId, terminal.getText())

      // 限制快照总数 + 总大小，防止内存泄漏
      const MAX_SNAPSHOTS = 100
      const MAX_TOTAL_SIZE = 10 * 1024 * 1024  // 10MB 上限
      let totalSize = 0
      for (const [, output] of this.exitedAgentOutputs) {
        totalSize += output.length * 2 // UTF-16 约 2 bytes/char
      }
      while (totalSize > MAX_TOTAL_SIZE && this.exitedAgentOutputs.size > 1) {
        const firstKey = this.exitedAgentOutputs.keys().next().value
        if (firstKey) {
          const removed = this.exitedAgentOutputs.get(firstKey)
          totalSize -= (removed?.length || 0) * 2
          this.exitedAgentOutputs.delete(firstKey)
        } else break
      }
      while (this.exitedAgentOutputs.size > MAX_SNAPSHOTS) {
        const oldestKey = this.exitedAgentOutputs.keys().next().value
        if (oldestKey) this.exitedAgentOutputs.delete(oldestKey)
      }
    }
  }

  /**
   * ★ 等待 Agent 变为空闲（prompt marker 返回，当前任务完成）
   */
  waitAgentIdle(agentId: string, timeout?: number): Promise<{ idle: boolean; output: string }> {
    const childSessionId = this.agentToChild.get(agentId)
    if (!childSessionId) return Promise.resolve({ idle: false, output: `Agent ${agentId} not found` })

    const session = this.sessionManager.getSession(childSessionId)
    if (!session || session.status === 'completed') {
      return Promise.resolve({ idle: false, output: `Agent ${agentId} session is not running` })
    }

    const detector = this.agentDetectors.get(agentId)
    if (!detector) return Promise.resolve({ idle: false, output: `Agent ${agentId} detector not found` })

    const effectiveTimeout = this.getPositiveTimeout(timeout, DEFAULT_WAIT_AGENT_IDLE_TIMEOUT_MS)
    const MIN_RESPONSE_CHARS = 100  // idle 前至少需要看到这么多字符的输出增长

    return new Promise((resolve) => {
      if (!this.idleWaiters.has(agentId)) this.idleWaiters.set(agentId, [])

      const waiter: { resolve: (info: { idle: boolean; output: string }) => void; timer?: NodeJS.Timeout } = { resolve }

      waiter.timer = setTimeout(() => {
        const out = this.getAgentOutput(agentId, 50).output
        resolve({ idle: false, output: `Timeout after ${effectiveTimeout}ms. Recent output:\n${out}` })
        const list = this.idleWaiters.get(agentId) || []
        const idx = list.indexOf(waiter)
        if (idx >= 0) list.splice(idx, 1)
      }, effectiveTimeout)

      this.idleWaiters.get(agentId)!.push(waiter)

      // ★ 记录开始检测时的屏幕快照长度，用于后续校验是否有实际内容产出
      let baselineLength = 0
      const htb = this.agentTerminals.get(agentId)
      if (htb) baselineLength = htb.getText().length

      const promptSentSignal = this.agentPromptSent.get(agentId)

      // ★ v5: 带内容校验的检测循环
      // 检测器报告 idle 后，校验是否有实际的输出增长（AI 回复内容）。
      // 如果屏幕内容没变化（prompt 没发出去、或 AI 没回复），说明是假 idle，重试。
      const MAX_EMPTY_RETRIES = 10  // 最多重试 10 次空 idle
      let emptyRetries = 0

      const startDetectionWithValidation = () => {
        const det = this.agentDetectors.get(agentId)
        if (!det) return

        det.waitReady().then((ready) => {
          // 检查会话是否还在
          const currentSession = this.sessionManager.getSession(childSessionId)
          if (!currentSession || currentSession.status === 'completed' || currentSession.status === 'error') {
            if (waiter.timer) clearTimeout(waiter.timer)
            const out = this.getAgentOutput(agentId, 50).output
            resolve({ idle: false, output: `Agent session ended. Output:\n${out}` })
            return
          }

          // ★ 内容校验：检查是否有实际输出增长
          const currentHtb = this.agentTerminals.get(agentId)
          const currentLength = currentHtb ? currentHtb.getText().length : 0
          const promptLen = this.agentPromptLengths.get(agentId) || 0
          const growth = currentLength - baselineLength
          // 扣除 prompt 回显（CLI 会回显 prompt 文本）
          const effectiveGrowth = Math.max(0, growth - Math.ceil(promptLen * 1.2))

          if (ready && effectiveGrowth < MIN_RESPONSE_CHARS) {
            emptyRetries++
            console.warn(
              `[AgentManager] waitAgentIdle: detector says idle but no meaningful content ` +
              `(growth=${growth}, promptEcho≈${promptLen}, effective=${effectiveGrowth}, min=${MIN_RESPONSE_CHARS}). ` +
              `Empty retry ${emptyRetries}/${MAX_EMPTY_RETRIES}.`
            )

            if (emptyRetries >= MAX_EMPTY_RETRIES) {
              // 重试耗尽，返回当前状态
              if (waiter.timer) clearTimeout(waiter.timer)
              const out = this.getAgentOutput(agentId, 50).output
              resolve({ idle: false, output: `Agent appears stuck (no response after ${emptyRetries} detection cycles). Output:\n${out}` })
              const list = this.idleWaiters.get(agentId) || []
              const idx = list.indexOf(waiter)
              if (idx >= 0) list.splice(idx, 1)
              return
            }

            // 重置 detector 继续等待
            det.reset()
            // ★ 保持 fastPathDisabled 状态（reset 不会清除它）
            startDetectionWithValidation()
            return
          }

          // ★ 有实际内容，真正 idle
          if (waiter.timer) clearTimeout(waiter.timer)
          const out = this.getAgentOutput(agentId, 50).output
          resolve({ idle: ready, output: out })
          const list = this.idleWaiters.get(agentId) || []
          const idx = list.indexOf(waiter)
          if (idx >= 0) list.splice(idx, 1)
        })
      }

      if (promptSentSignal) {
        // ★ 交互式 Agent：主动监控 prompt 发送进度，不再傻等
        // 每 3 秒检查一次 sendPromptWhenReady 的状态，如果卡住就报错
        const PROMPT_SEND_CHECK_INTERVAL = 3000
        const PROMPT_SEND_TIMEOUT = 60000  // 60 秒内 prompt 必须发出

        const checkPromptProgress = setInterval(() => {
          const signal = this.agentPromptSent.get(agentId)
          if (!signal) {
            clearInterval(checkPromptProgress)
            return
          }
          const elapsed = Date.now() - signal.startedAt
          console.log(`[AgentManager] waitAgentIdle: prompt send progress — stage=${signal.stage}, elapsed=${elapsed}ms`)

          if (signal.stage === 'error') {
            clearInterval(checkPromptProgress)
            if (waiter.timer) clearTimeout(waiter.timer)
            const out = this.getAgentOutput(agentId, 50).output
            resolve({ idle: false, output: `Prompt send failed: ${signal.error}. Output:\n${out}` })
            return
          }

          if (elapsed > PROMPT_SEND_TIMEOUT && signal.stage !== 'sent') {
            clearInterval(checkPromptProgress)
            if (waiter.timer) clearTimeout(waiter.timer)
            const out = this.getAgentOutput(agentId, 50).output
            resolve({ idle: false, output: `Prompt send stuck at stage="${signal.stage}" for ${elapsed}ms. Output:\n${out}` })
            return
          }
        }, PROMPT_SEND_CHECK_INTERVAL)

        promptSentSignal.promise.then(() => {
          clearInterval(checkPromptProgress)

          // 检查是否是 error 状态的 resolve
          const signal = this.agentPromptSent.get(agentId)
          if (signal?.stage === 'error') {
            if (waiter.timer) clearTimeout(waiter.timer)
            const out = this.getAgentOutput(agentId, 50).output
            resolve({ idle: false, output: `Prompt send failed: ${signal.error}. Output:\n${out}` })
            return
          }

          // ★ 更新 baseline：prompt 发出后重新快照
          const currentHtb = this.agentTerminals.get(agentId)
          if (currentHtb) baselineLength = currentHtb.getText().length

          // ★ 修复 wait_agent_idle 首次超时 bug：
          // reset() 将 outputSeenSinceReset 置为 false，quiescence 轮询遇到此标志会直接跳过检测。
          // 若 AI 回答比 promptSentSignal 的 .then() 执行更快（竞态），
          // 此时屏幕已稳定但 outputSeenSinceReset 仍为 false，导致轮询永远无法 resolve。
          // prompt 已确认发送到 CLI，此后的任何输出都是合法的 AI 响应，故主动标记已见输出。
          const det = this.agentDetectors.get(agentId)
          if (det) det.onOutput('__seed__')

          startDetectionWithValidation()
        })
      } else {
        // 非交互式 Agent 或 prompt 已发过（send_to_agent 场景）：直接检测
        // ★ v9: 只在 sendToAgent 被调用过后才 reset detector
        // 首次 wait_agent_idle（AI 可能已经回答完）不 reset，避免丢失已完成的输出
        const shouldReset = this.needsDetectorReset.get(agentId) === true
        if (shouldReset) {
          const det2 = this.agentDetectors.get(agentId)
          if (det2) det2.reset()
          this.needsDetectorReset.set(agentId, false)
          console.log(`[AgentManager] waitAgentIdle: detector reset (post-sendToAgent)`)
        } else {
          console.log(`[AgentManager] waitAgentIdle: skipping detector reset (first wait or no sendToAgent)`)
        }
        if (htb) baselineLength = htb.getText().length
        startDetectionWithValidation()
      }
    })
  }

  /**
   * 等待 Agent 进程退出
   */
  waitAgent(agentId: string, timeout?: number): Promise<AgentResult> {
    const info = this.database.getAgentInfo(agentId)
    if (info && (info.status === 'completed' || info.status === 'failed' || info.status === 'cancelled')) {
      return Promise.resolve(info.result || {
        success: info.status === 'completed',
        exitCode: info.status === 'completed' ? 0 : -1,
        error: info.status === 'cancelled' ? 'Agent was cancelled' : undefined
      })
    }

    return new Promise((resolve) => {
      if (!this.waiters.has(agentId)) this.waiters.set(agentId, [])
      const waiter: { resolve: (result: AgentResult) => void; timer?: NodeJS.Timeout } = { resolve }
      if (timeout && timeout > 0) {
        waiter.timer = setTimeout(() => {
          resolve({ success: false, exitCode: -1, error: `Agent timed out after ${timeout}ms` })
          const list = this.waiters.get(agentId) || []
          const idx = list.indexOf(waiter)
          if (idx >= 0) list.splice(idx, 1)
        }, timeout)
      }
      this.waiters.get(agentId)!.push(waiter)
    })
  }

  getAgentStatus(agentId: string): AgentInfo | undefined {
    return this.database.getAgentInfo(agentId)
  }

  listAgents(parentSessionId?: string): AgentInfo[] {
    if (parentSessionId) return this.database.getAgentsByParent(parentSessionId)
    return []
  }

  cancelAgent(agentId: string): boolean {
    const info = this.database.getAgentInfo(agentId)
    if (!info || (info.status !== 'pending' && info.status !== 'running')) return false

    // ★ 关键：先清除 childToAgent 映射，再调 terminateSession
    // terminateSession 会同步 emit status-change，如果 childToAgent 还在，
    // 就会触发 onChildSessionEnded 重入，导致重复清理和状态混乱
    this.childToAgent.delete(info.childSessionId)

    try { this.sessionManager.terminateSession(info.childSessionId) } catch (_) { /* 可能已退出 */ }

    this.database.updateAgentStatus(agentId, 'cancelled')
    this.database.saveAgentResult(agentId, { success: false, exitCode: -1, error: 'Agent cancelled by user' })
    this.emit('agent:status-change', agentId, 'cancelled')

    // 唤醒所有等待者
    for (const w of (this.waiters.get(agentId) || [])) {
      if (w.timer) clearTimeout(w.timer)
      w.resolve({ success: false, exitCode: -1, error: 'Agent cancelled' })
    }
    this.waiters.delete(agentId)

    for (const w of (this.idleWaiters.get(agentId) || [])) {
      if (w.timer) clearTimeout(w.timer)
      w.resolve({ idle: false, output: 'Agent cancelled' })
    }
    this.idleWaiters.delete(agentId)

    // ★ Bug 3 Fix: cancel 时也保存输出快照
    this.saveOutputSnapshot(agentId)

    const detector = this.agentDetectors.get(agentId)
    if (detector) { detector.destroy(); this.agentDetectors.delete(agentId) }
    const cancelTerminal = this.agentTerminals.get(agentId)
    if (cancelTerminal) { cancelTerminal.dispose(); this.agentTerminals.delete(agentId) }
    this.agentTailBuffers.delete(agentId)
    this.agentOneShot.delete(agentId)
    this.agentOutputSnapshots.delete(agentId)
    this.agentPromptLengths.delete(agentId)
    this.agentPromptSent.delete(agentId)
    this.needsDetectorReset.delete(agentId)

    // 从 parentToAgents 中移除
    const info2 = this.database.getAgentInfo(agentId)
    if (info2?.parentSessionId) {
      const siblings = this.parentToAgents.get(info2.parentSessionId)
      if (siblings) {
        siblings.delete(agentId)
        if (siblings.size === 0) this.parentToAgents.delete(info2.parentSessionId)
      }
    }
    this.agentToChild.delete(agentId)

    return true
  }

  /**
   * ★ 父会话结束时，自动清理所有子 Agent
   */
  private cleanupChildAgents(parentSessionId: string): void {
    const childAgents = this.parentToAgents.get(parentSessionId)
    if (!childAgents || childAgents.size === 0) return

    console.log(`[AgentManager] Parent session ${parentSessionId} ended, cleaning up ${childAgents.size} child agents`)

    // 复制一份再遍历，因为 cancelAgent 会修改 parentToAgents
    const agentIds = [...childAgents]
    for (const agentId of agentIds) {
      try {
        const info = this.database.getAgentInfo(agentId)
        if (info && (info.status === 'pending' || info.status === 'running')) {
          this.cancelAgent(agentId)
        }
      } catch (_) { /* ignore */ }
    }

    this.parentToAgents.delete(parentSessionId)
  }

  // ==================== Bridge 请求处理 ====================

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
    const session: any = this.sessionManager.getSession(parentSessionId)
    const providerId = session?.provider?.id || session?.config?.providerId
    return providerId === 'codex'
  }

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
      `[AgentManager] Clamped ${method} timeout for codex parent session ` +
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
      const gitService = this.deps.gitService || this.defaultGitWorktreeService
      const stillValid = await gitService.verifyWorktree(existingWorktreePath)
      if (stillValid) {
        console.log(`[AgentManager] Reusing existing worktree for session ${sessionId}: ${existingWorktreePath}`)
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

    const gitService = this.deps.gitService || this.defaultGitWorktreeService
    const repoHint = String(
      params.repoPath ||
      session.config?.worktreeSourceRepo ||
      session.workingDirectory ||
      session.config?.workingDirectory ||
      process.cwd()
    )

    const repoPath = await gitService.getRepoRoot(repoHint)
    const currentBranch = await gitService.getCurrentBranch(repoPath)
    const expectedBaseBranch = typeof params.baseBranch === 'string' ? params.baseBranch.trim() : ''

    if (expectedBaseBranch && currentBranch !== expectedBaseBranch) {
      throw new Error(`当前分支为 ${currentBranch}，与期望分支 ${expectedBaseBranch} 不一致`)
    }

    const allowDirty = params.allowDirty === true
    if (!allowDirty) {
      const dirty = await gitService.isDirty(repoPath)
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

    const expectedPath = gitService.getWorktreeBasePath(repoPath, taskId)
    const alreadyExists = await gitService.verifyWorktree(expectedPath)
    const created = alreadyExists
      ? {
          worktreePath: expectedPath,
          branch: await gitService.getCurrentBranch(expectedPath),
        }
      : await gitService.createWorktree(repoPath, branchName, taskId)

    // 记录 worktree 创建时的 base commit，用于合并后仍能查看差异
    let baseCommit = ''
    try {
      baseCommit = await gitService.getHeadCommit(repoPath)
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

  handleBridgeRequest(request: BridgeRequest, respond: (response: BridgeResponse) => void): void {
    let responded = false
    const safeRespond = (response: BridgeResponse) => {
      if (responded) return
      responded = true
      respond(response)
    }
    this._handleBridgeRequestAsync(request, safeRespond).catch(err => {
      safeRespond({ id: request.id, error: err.message || 'Internal error' })
    })
  }

  private async _handleBridgeRequestAsync(request: BridgeRequest, respond: (response: BridgeResponse) => void): Promise<void> {
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

          // ★ 前置检查：provider CLI 是否已安装
          const requestedProviderId = config.providerId || 'claude-code'
          let targetProvider = BUILTIN_PROVIDERS.find(p => p.id === requestedProviderId)
          if (!targetProvider) {
            try { targetProvider = this.database.getProvider(requestedProviderId) } catch (_) { /* ignore */ }
          }
          if (targetProvider) {
            const available = await isProviderAvailable(targetProvider)
            if (!available) {
              // 查找可用的替代 provider
              const allProviders = this.database.getAllProviders()
              const availabilityList = await checkProviderAvailability(allProviders)
              const alternatives = availabilityList.filter(a => a.available && a.id !== requestedProviderId)
              const altText = alternatives.length > 0
                ? `可用的 provider: ${alternatives.map(a => a.id).join(', ')}。请换一个 provider 重试。`
                : '当前没有其他可用的 provider。请先安装至少一个 AI CLI 工具。'
              respond({ id, error: `Provider "${requestedProviderId}" 未安装（找不到命令 "${targetProvider.command}"）。${altText}` })
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

        // ★ 新增：向 Agent 发送消息
        case 'send_to_agent': {
          if (!params.agentId || !params.message) { respond({ id, error: '缺少 agentId 或 message' }); break }
          const sendResult = this.sendToAgent(params.agentId, params.message)
          respond({ id, result: sendResult })
          break
        }

        // ★ 新增：获取 Agent 最近输出
        case 'get_agent_output': {
          if (!params.agentId) { respond({ id, error: '缺少 agentId' }); break }
          const outputResult = this.getAgentOutput(params.agentId, params.lines || 50)
          respond({ id, result: outputResult })
          break
        }

        // ★ 新增：等待 Agent 空闲
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
          if (info) { respond({ id, result: info }) } else { respond({ id, error: `Agent ${params.agentId} not found` }) }
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

        // ==================== 跨会话感知工具 ====================

        case 'list_sessions': {
          const allSessions = this.database.getAllSessions()
          const statusFilter = params.status || 'all'
          const limit = params.limit || 20
          let filtered = allSessions
          if (statusFilter !== 'all') filtered = filtered.filter((s: any) => s.status === statusFilter)
          respond({
            id, result: filtered.slice(0, limit).map((s: any) => ({
              sessionId: s.id, name: s.name, status: s.status,
              providerId: s.providerId || 'claude-code',
              workingDirectory: s.workingDirectory, startedAt: s.startedAt,
              isCurrent: s.id === sessionId
            }))
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
          const errors = activities.filter((a: any) => a.type === 'error').map((a: any) => a.detail)

          let latestResponse = ''
          try { const summary = this.database.getLatestSummary(target.id); if (summary) latestResponse = summary.content?.slice(0, 3000) || '' } catch (_) { /* ignore */ }

          respond({
            id, result: {
              sessionId: target.id, name: target.name, status: target.status,
              providerId: target.providerId || 'claude-code', workingDirectory: target.workingDirectory,
              latestAiResponse: latestResponse, recentAiMessages: aiMessages.slice(-5),
              filesModified: [...new Set(filesModified)].slice(-20), commandsRun: commands.slice(-10),
              errors: errors.slice(-5), activityCount: activities.length
            }
          })
          break
        }

        case 'search_sessions': {
          const query = params.query
          if (!query) { respond({ id, error: '缺少搜索关键词' }); break }
          const limit = params.limit || 20
          const logResults = this.database.searchLogs(query, undefined, limit)
          let summaryResults: any[] = []
          try {
            const allSummaries = this.database.getAllSessionLatestSummaries()
            const keyword = query.toLowerCase()
            summaryResults = allSummaries
              .filter((s: any) => s.content?.toLowerCase().includes(keyword))
              .slice(0, limit)
              .map((s: any) => ({
                sessionId: s.sessionId, sessionName: s.sessionName, type: 'ai_response',
                preview: this.extractSearchSnippet(s.content, keyword, 200), createdAt: s.createdAt
              }))
          } catch (_) { /* ignore */ }
          respond({ id, result: { query, logMatches: logResults.slice(0, limit), aiResponseMatches: summaryResults, totalMatches: logResults.length + summaryResults.length } })
          break
        }

        // ==================== Git Worktree 工具 ====================

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
          const gitService = this.deps.gitService
          if (!gitService) { respond({ id, error: 'Git 服务未初始化' }); break }
          let repoPath = params.repoPath
          let worktreePath = params.worktreePath
          if (params.taskId && (!repoPath || !worktreePath)) {
            const task = this.database.getTask(params.taskId)
            if (!task) { respond({ id, error: `未找到任务: ${params.taskId}` }); break }
            if (!task.worktreeEnabled || !task.gitRepoPath || !task.worktreePath) { respond({ id, result: { canMerge: false, error: '该任务未启用 Git Worktree 隔离' } }); break }
            repoPath = task.gitRepoPath; worktreePath = task.worktreePath
          }
          if (!repoPath || !worktreePath) { respond({ id, error: '缺少 repoPath 和 worktreePath（或提供 taskId）' }); break }
          try { const result = await gitService.checkMerge(repoPath, worktreePath); respond({ id, result }) }
          catch (err: any) { respond({ id, error: `合并检查失败: ${err.message}` }) }
          break
        }

        case 'merge_worktree': {
          const gitService = this.deps.gitService
          if (!gitService) { respond({ id, error: 'Git 服务未初始化' }); break }
          let repoPath = params.repoPath; let branchName = params.branchName; let worktreePath = params.worktreePath
          const taskId = params.taskId
          if (taskId && (!repoPath || !branchName)) {
            const task = this.database.getTask(taskId)
            if (!task) { respond({ id, error: `未找到任务: ${taskId}` }); break }
            if (!task.worktreeEnabled || !task.gitRepoPath || !task.gitBranch) { respond({ id, result: { success: false, error: '该任务未启用 Git Worktree 隔离' } }); break }
            repoPath = task.gitRepoPath; branchName = task.gitBranch; worktreePath = task.worktreePath || undefined
          }
          if (!repoPath || !branchName) { respond({ id, error: '缺少 repoPath 和 branchName（或提供 taskId）' }); break }
          try {
            const mergeResult = await gitService.mergeToMain(repoPath, branchName, { squash: params.squash ?? true, message: params.message || `Merge branch ${branchName} via SpectrAI`, cleanup: params.cleanup ?? false })

            // ★ 合并成功后，通知 FileChangeTracker 记录 worktree 改动文件（在 cleanup 之前）
            try {
              const commitFiles = await gitService.getCommitFiles(repoPath, 'HEAD')
              const statusMap: Record<string, 'create' | 'modify' | 'delete'> = {
                A: 'create', M: 'modify', D: 'delete', R: 'modify', C: 'modify', T: 'modify'
              }
              const changedFiles = commitFiles
                .filter(f => f.path)
                .map(f => ({ path: f.path, changeType: (statusMap[f.statusCode[0]] ?? 'modify') as 'create' | 'modify' | 'delete' }))
              ;(this as any).emit('worktree:merged', {
                repoPath,
                worktreePath,
                changedFiles,
              })
            } catch (e) {
              console.warn('[AgentManager] Failed to record worktree file changes:', e)
            }

            if (params.cleanup && worktreePath) {
              try {
                await gitService.removeWorktree(repoPath, worktreePath, { deleteBranch: true, branchName })
                if (taskId) this.database.updateTask(taskId, { worktreePath: '', status: 'done' })
              } catch (cleanupErr: any) { console.warn('[AgentManager] Worktree cleanup warning:', cleanupErr.message) }
            }
            respond({ id, result: { success: true, mainBranch: mergeResult.mainBranch, linesAdded: mergeResult.linesAdded, linesRemoved: mergeResult.linesRemoved } })
          } catch (err: any) { respond({ id, error: `合并失败: ${err.message}` }) }
          break
        }

        default:
          respond({ id, error: `Unknown method: ${method}` })
      }
    } catch (err: any) {
      respond({ id, error: err.message || 'Internal error' })
    }
  }

  private extractSearchSnippet(text: string, keyword: string, maxLen: number): string {
    const idx = text.toLowerCase().indexOf(keyword.toLowerCase())
    if (idx === -1) return text.slice(0, maxLen)
    const start = Math.max(0, idx - 80)
    const end = Math.min(text.length, idx + keyword.length + 80)
    let snippet = text.slice(start, end)
    if (start > 0) snippet = '...' + snippet
    if (end < text.length) snippet += '...'
    return snippet.slice(0, maxLen)
  }

  cleanup(): void {
    for (const [, waiters] of this.waiters) {
      for (const w of waiters) { if (w.timer) clearTimeout(w.timer); w.resolve({ success: false, exitCode: -1, error: 'Agent manager shutting down' }) }
    }
    this.waiters.clear()
    for (const [, waiters] of this.idleWaiters) {
      for (const w of waiters) { if (w.timer) clearTimeout(w.timer); w.resolve({ idle: false, output: 'Agent manager shutting down' }) }
    }
    this.idleWaiters.clear()
    for (const [, detector] of this.agentDetectors) detector.destroy()
    this.agentDetectors.clear()
    for (const [, terminal] of this.agentTerminals) terminal.dispose()
    this.agentTerminals.clear()
    this.agentTailBuffers.clear()
    this.childToAgent.clear()
    this.agentToChild.clear()
    this.agentArtifacts.clear()
    this.agentOneShot.clear()
    this.agentOutputSnapshots.clear()
    this.exitedAgentOutputs.clear()
    this.parentToAgents.clear()
  }
}
