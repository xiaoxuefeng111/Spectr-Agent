/**
 * Session IPC 处理器 - Session 生命周期及对话管理
 * ★ 架构说明：仅支持 SDK V2（SessionManagerV2 + Adapter 层）
 *   V1 PTY 路径（SessionManager + node-pty）已弃用
 */
import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/constants'
import { BUILTIN_CLAUDE_PROVIDER } from '../../shared/types'
import type { AIProvider, SessionConfig } from '../../shared/types'
import { extractImageTags, stripImageTags } from '../../shared/utils/messageContent'
import { MCPConfigGenerator } from '../agent/MCPConfigGenerator'
import {
  injectAwarenessPrompt,
  injectSupervisorPrompt,
  injectSupervisorPromptToAgentsMd,
  injectSupervisorPromptToGeminiMd,
  buildSupervisorPrompt,
  injectWorktreeRule,
  injectWorktreeRuleToAgentsMd,
  injectWorktreeRuleToGeminiMd,
  buildWorktreePrompt,
  detectBaseBranch,
  injectWorkspaceSessionSection,
  buildWorkspaceSessionSection,
  injectWorkspaceSessionSectionToAgentsMd,
  injectWorkspaceSessionSectionToGeminiMd,
  injectFileOpsRule,
  buildFileOpsPrompt,
  injectFileOpsRuleToAgentsMd,
  injectFileOpsRuleToGeminiMd,
} from '../agent/supervisorPrompt'
import { checkProviderAvailability } from '../agent/providerAvailability'
import type { IpcDependencies } from './index'
import { sendToRenderer, aiRenamingLocks, performAiRename } from './shared'

const RESUME_PROMPT_TOKEN_BUDGET = 7000
const RESUME_SUMMARY_TOKEN_BUDGET = 2400
const RESUME_RECENT_TOKEN_BUDGET = 3900
const RESUME_TOOL_ERROR_TOKEN_BUDGET = 700
const RESUME_MAX_RECENT_ROUNDS = 12

function normalizeText(text: string): string {
  return (text || '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function estimateTokensApprox(text: string): number {
  if (!text) return 0
  const cjkCount = (text.match(/[\u4E00-\u9FFF]/g) || []).length
  const otherCount = Math.max(0, text.length - cjkCount)
  return Math.ceil(cjkCount / 1.6 + otherCount / 4)
}

function truncateToTokenBudget(text: string, tokenBudget: number): string {
  const normalized = normalizeText(text)
  if (!normalized) return ''
  if (tokenBudget <= 0) return ''
  if (estimateTokensApprox(normalized) <= tokenBudget) return normalized

  let lo = 0
  let hi = normalized.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2)
    const probe = normalized.slice(0, mid)
    if (estimateTokensApprox(probe) <= tokenBudget) lo = mid
    else hi = mid - 1
  }

  const clipped = normalized.slice(0, lo).trimEnd()
  return clipped ? `${clipped}...` : ''
}

function pickKeyLines(text: string, maxLines: number): string {
  const lines = normalizeText(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return ''

  const keyRe = /(error|failed|exception|warning|success|completed|created|updated|deleted|not found|found|exit code|timeout)/i
  const hits = lines.filter((l) => keyRe.test(l))
  const picked = (hits.length > 0 ? hits : [lines[lines.length - 1]]).slice(0, maxLines)
  return picked.join(' | ')
}

function collectImageNames(msg: any): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  const add = (name: string | undefined) => {
    const value = (name || '').trim()
    if (!value || seen.has(value)) return
    seen.add(value)
    names.push(value)
  }

  const fromTags = extractImageTags(String(msg?.content || ''))
  fromTags.forEach((tag) => add(tag.name))

  if (Array.isArray(msg?.attachments)) {
    for (const a of msg.attachments) {
      if (!a) continue
      add(String(a.name || ''))
      if (!a.name && typeof a.path === 'string') {
        const p = a.path.replace(/\\/g, '/')
        const last = p.split('/').filter(Boolean).pop()
        add(last || '')
      }
    }
  }
  return names
}

function formatDialogueMessageForResume(msg: any): string | undefined {
  const role = msg?.role

  const roleLabelMap: Record<string, string> = {
    user: 'User',
    assistant: 'Assistant',
  }
  if (!(role in roleLabelMap)) return undefined
  const label = roleLabelMap[role] || 'Message'
  const raw = String(msg?.content || '')
  const text = stripImageTags(raw)
  const imageNames = collectImageNames(msg)
  let body = text
  if (!body && imageNames.length > 0) {
    body = '[Sent image attachments]'
  }
  if (!body.trim()) return undefined

  const bodyBudget = role === 'assistant' ? 320 : role === 'user' ? 220 : 120
  const base = truncateToTokenBudget(body, bodyBudget)
  if (!base) return undefined
  if (imageNames.length === 0) return `[${label}] ${base}`

  const nameHint = imageNames.slice(0, 3).join(', ')
  const suffix = imageNames.length > 3
    ? ` [Images: ${nameHint}, +${imageNames.length - 3} more]`
    : ` [Images: ${nameHint}]`
  return truncateToTokenBudget(`[${label}] ${base}${suffix}`, bodyBudget + 60)
}

interface ResumeRound {
  lines: string[]
  tokens: number
}

function collectRecentRounds(messages: any[]): ResumeRound[] {
  const rounds: ResumeRound[] = []
  let current: ResumeRound | null = null

  for (const msg of messages || []) {
    const role = msg?.role
    const line = formatDialogueMessageForResume(msg)
    if (!line) continue
    const lineText = `- ${line}`
    const lineTokens = estimateTokensApprox(lineText)

    if (role === 'user') {
      if (current && current.lines.length > 0) {
        rounds.push(current)
      }
      current = { lines: [lineText], tokens: lineTokens }
      continue
    }

    if (!current) {
      current = { lines: [], tokens: 0 }
    }
    current.lines.push(lineText)
    current.tokens += lineTokens
  }

  if (current && current.lines.length > 0) {
    rounds.push(current)
  }
  return rounds
}

function buildRecentToolErrorSection(messages: any[], tokenBudget: number): string | undefined {
  if (!messages || messages.length === 0 || tokenBudget <= 0) return undefined

  const errors = (messages as any[])
    .filter((m) => m?.role === 'tool_result' && !!m?.isError)
    .slice(-10)

  if (errors.length === 0) return undefined

  const picked: string[] = []
  let used = 0
  for (let i = errors.length - 1; i >= 0; i--) {
    const e = errors[i]
    const tool = String(e?.toolName || 'tool')
    const key = pickKeyLines(String(e?.toolResult || e?.content || ''), 2) || 'Tool failed'
    const line = `- [ToolError:${tool}] ${truncateToTokenBudget(key, 110)}`
    const t = estimateTokensApprox(line)
    if (used + t > tokenBudget) break
    picked.push(line)
    used += t
  }

  if (picked.length === 0) return undefined
  return `Recent tool failures (only errors):\n${picked.join('\n')}`
}

function buildSummarySection(summaries: any[], tokenBudget: number): string | undefined {
  if (!summaries || summaries.length === 0 || tokenBudget <= 0) return undefined

  const picked: string[] = []
  let used = 0
  const latestFirst = summaries.slice(0, 24)
  for (const s of latestFirst) {
    const content = truncateToTokenBudget(String(s?.content || ''), 260)
    if (!content) continue
    const line = `- [${String(s?.type || 'summary')}] ${content}`
    const t = estimateTokensApprox(line)
    if (used + t > tokenBudget) {
      if (picked.length === 0) picked.push(truncateToTokenBudget(line, tokenBudget))
      break
    }
    picked.push(line)
    used += t
  }

  if (picked.length === 0) return undefined
  const omitted = Math.max(0, summaries.length - picked.length)
  const header = omitted > 0
    ? `Recent summaries (newest first, ${picked.length} used, ${omitted} omitted):`
    : 'Recent summaries (newest first):'
  return `${header}\n${picked.join('\n')}`
}

function buildRecentWindowSection(messages: any[], tokenBudget: number): string | undefined {
  if (!messages || messages.length === 0 || tokenBudget <= 0) return undefined

  const rounds = collectRecentRounds(messages)
  if (rounds.length === 0) return undefined

  const selected: ResumeRound[] = []
  let used = 0
  for (let i = rounds.length - 1; i >= 0; i--) {
    const round = rounds[i]
    if (selected.length >= RESUME_MAX_RECENT_ROUNDS) break
    const t = round.tokens
    if (used + t > tokenBudget) {
      if (selected.length === 0) {
        const clipped = round.lines
          .map((line) => truncateToTokenBudget(line, 180))
          .filter(Boolean) as string[]
        if (clipped.length > 0) {
          selected.push({
            lines: clipped,
            tokens: clipped.reduce((sum, line) => sum + estimateTokensApprox(line), 0),
          })
        }
      }
      break
    }
    selected.push(round)
    used += t
  }

  if (selected.length === 0) return undefined
  selected.reverse()
  const lines = selected.flatMap((round) => round.lines)
  const omitted = Math.max(0, rounds.length - selected.length)
  const header = omitted > 0
    ? `Recent conversation window (${selected.length} rounds used, ${omitted} older rounds omitted):`
    : 'Recent conversation window:'
  return `${header}\n${lines.join('\n')}`
}

function composeResumePrompt(summarySection?: string, recentSection?: string, toolErrorSection?: string): string {
  const parts: string[] = [
    'Session context recovery (generated by SpectrAI):',
    'You are continuing an existing conversation after app/runtime restart.',
    'Use the context below as authoritative history.',
    'Do not claim missing context unless the user request truly exceeds what is provided.',
    '',
  ]

  if (summarySection) {
    parts.push('=== Layer 1: Historical Summary ===')
    parts.push(summarySection)
    parts.push('')
  }

  if (recentSection) {
    parts.push('=== Layer 2: Recent Conversation Window ===')
    parts.push(recentSection)
    parts.push('')
  }

  if (toolErrorSection) {
    parts.push('=== Layer 3: Recent Tool Error Digest ===')
    parts.push(toolErrorSection)
    parts.push('')
  }

  parts.push('=== Instruction ===')
  parts.push('Continue naturally from this state and answer the next user message directly.')
  return parts.join('\n')
}

function buildResumeBootstrapPrompt(summaries: any[], messages: any[]): string | undefined {
  if ((!summaries || summaries.length === 0) && (!messages || messages.length === 0)) return undefined

  let summaryBudget = RESUME_SUMMARY_TOKEN_BUDGET
  let recentBudget = RESUME_RECENT_TOKEN_BUDGET
  let errorBudget = RESUME_TOOL_ERROR_TOKEN_BUDGET
  let summarySection = buildSummarySection(summaries, summaryBudget)
  let recentSection = buildRecentWindowSection(messages, recentBudget)
  let toolErrorSection = buildRecentToolErrorSection(messages, errorBudget)
  if (!summarySection && !recentSection) return undefined
  let prompt = composeResumePrompt(summarySection, recentSection, toolErrorSection)

  for (let i = 0; i < 8 && estimateTokensApprox(prompt) > RESUME_PROMPT_TOKEN_BUDGET; i++) {
    if (errorBudget > 300) errorBudget = Math.max(300, errorBudget - 120)
    else if (recentBudget > 900) recentBudget = Math.max(900, recentBudget - 450)
    else if (summaryBudget > 500) summaryBudget = Math.max(500, summaryBudget - 250)
    else break
    summarySection = buildSummarySection(summaries, summaryBudget)
    recentSection = buildRecentWindowSection(messages, recentBudget)
    toolErrorSection = buildRecentToolErrorSection(messages, errorBudget)
    prompt = composeResumePrompt(summarySection, recentSection, toolErrorSection)
  }

  if (estimateTokensApprox(prompt) > RESUME_PROMPT_TOKEN_BUDGET) {
    prompt = truncateToTokenBudget(prompt, RESUME_PROMPT_TOKEN_BUDGET)
  }
  return prompt
}

// 防止前端连点“创建”造成重复会话（同参数请求共享同一 Promise）
const createSessionInFlight = new Map<string, Promise<any>>()

function buildCreateSessionDedupeKey(config: SessionConfig): string {
  return [
    config.workingDirectory || '',
    config.providerId || '',
    config.workspaceId || '',
    config.supervisorMode ? '1' : '0',
    (config.initialPrompt || '').trim(),
    (config.name || '').trim(),
  ].join('|')
}

export function registerSessionHandlers(deps: IpcDependencies): void {
  const {
    database, concurrencyGuard, notificationManager, trayManager,
    agentBridgePort,
  } = deps

  // ==================== Dialog 相关 ====================

  ipcMain.handle('dialog:select-directory', async () => {
    const focusedWin = BrowserWindow.getFocusedWindow()
    if (!focusedWin) return null

    const { dialog } = require('electron')
    const result = await dialog.showOpenDialog(focusedWin, {
      properties: ['openDirectory'],
      title: '选择工作目录'
    })

    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.DIALOG_SELECT_FILE, async () => {
    const focusedWin = BrowserWindow.getFocusedWindow()
    if (!focusedWin) return null

    const { dialog } = require('electron')
    const isWindows = process.platform === 'win32'
    const result = await dialog.showOpenDialog(focusedWin, {
      properties: ['openFile'],
      title: '选择 Claude Code CLI 可执行文件',
      filters: isWindows
        ? [
            { name: 'JavaScript 文件', extensions: ['js'] },
            { name: '所有文件', extensions: ['*'] },
          ]
        : [{ name: '所有文件', extensions: ['*'] }],
    })

    return result.canceled ? null : result.filePaths[0]
  })

  // ==================== Session 相关 ====================

  ipcMain.handle(IPC.SESSION_CREATE, async (_event, config: SessionConfig) => {
    const dedupeKey = buildCreateSessionDedupeKey(config)
    const existing = createSessionInFlight.get(dedupeKey)
    if (existing) return await existing

    const task = (async () => {
      try {
      const smV2 = deps.sessionManagerV2
      if (!smV2) {
        return { success: false, error: 'SDK V2 SessionManager 未初始化' }
      }

      // 检查并发限制
      const resourceCheck = concurrencyGuard.checkResources()
      if (!resourceCheck.canCreate) {
        return { success: false, error: resourceCheck.reason }
      }

      // 查询 Provider
      const providerId = config.providerId || 'claude-code'
      const provider: AIProvider = database.getProvider(providerId) || BUILTIN_CLAUDE_PROVIDER

      // ★ 注入引导提示（按 provider 分派）
      if (config.supervisorMode) {
        config.enableAgent = true
        const allProviders = database.getAllProviders()
        const availability = await checkProviderAvailability(allProviders)
        const providerNames = availability.map(a =>
          a.available ? `${a.name}(${a.id})` : `${a.name}(${a.id}) [未安装]`
        )
        if (providerId === 'claude-code') {
          injectSupervisorPrompt(config.workingDirectory, providerNames)
        } else if (providerId === 'codex') {
          injectSupervisorPromptToAgentsMd(config.workingDirectory, providerNames)
        } else if (providerId === 'gemini-cli') {
          injectSupervisorPromptToGeminiMd(config.workingDirectory, providerNames)
        } else {
          // fallback（iflow / opencode 等）：通过 initialPrompt 前缀注入
          const supervisorContent = buildSupervisorPrompt(providerNames)
          config.initialPrompt = config.initialPrompt
            ? `${supervisorContent}\n\n---\n\n${config.initialPrompt}`
            : supervisorContent
        }
      } else if (providerId === 'claude-code') {
        injectAwarenessPrompt(config.workingDirectory)
      }

      // ★ 若选择了工作区，注入多仓库上下文（让 AI 知道所有仓库路径）
      // 注意：此处为普通 session，worktree 未预建，使用专用的 session 文案（非 task 文案）
      let workspaceRepos: Array<{ name: string; repoPath: string; isPrimary: boolean }> = []
      if (config.workspaceId) {
        try {
          const workspace = database.getWorkspace(config.workspaceId)
          if (workspace) {
            // 如果没有手动指定 workingDirectory，使用主仓库路径
            const primaryRepo = workspace.repos.find((r: any) => r.isPrimary) ?? workspace.repos[0]
            if (primaryRepo && !config.workingDirectory) {
              config.workingDirectory = primaryRepo.repoPath
            }
            workspaceRepos = workspace.repos.map((r: any) => ({
              name: r.name,
              repoPath: r.repoPath,
              isPrimary: r.isPrimary,
            }))
            // ★ 收集非主仓库路径，传递给 SDK additionalDirectories，让 AI 可访问工作区内所有目录
            const additionalDirs = workspaceRepos
              .filter(r => !r.isPrimary && r.repoPath !== config.workingDirectory)
              .map(r => r.repoPath)
            if (additionalDirs.length > 0) {
              config.additionalDirectories = additionalDirs
              console.log(`[IPC] Workspace additionalDirectories: ${additionalDirs.join(', ')}`)
            }
            // ★ 注入工作区多仓库上下文（按 provider 分派）
            // 各 provider 有自己的规则文件发现机制：
            //   claude-code  → .claude/rules/ 文件（启动时自动加载）+ systemPromptAppend（双重保险）
            //   codex        → AGENTS.md（Codex 自动发现，WORKSPACE 管理块）
            //   gemini-cli   → GEMINI.md（Gemini CLI 自动加载，WORKSPACE 管理块）
            //   其他          → systemPromptAppend / initialPrompt 前缀
            if (providerId === 'claude-code') {
              injectWorkspaceSessionSection(config.workingDirectory, workspaceRepos)
              // 双重保险：通过 systemPromptAppend 注入
              const wsSection = buildWorkspaceSessionSection(workspaceRepos)
              if (wsSection) {
                config.systemPromptAppend = config.systemPromptAppend
                  ? config.systemPromptAppend + '\n\n' + wsSection
                  : wsSection
              }
            } else if (providerId === 'codex') {
              injectWorkspaceSessionSectionToAgentsMd(config.workingDirectory, workspaceRepos)
            } else if (providerId === 'gemini-cli') {
              injectWorkspaceSessionSectionToGeminiMd(config.workingDirectory, workspaceRepos)
            } else {
              // fallback（iflow / opencode 等）：通过 initialPrompt 前缀注入
              // OpenCode 无 systemPrompt 支持，initialPrompt 是唯一可靠通道
              const wsSection = buildWorkspaceSessionSection(workspaceRepos)
              if (wsSection) {
                config.initialPrompt = config.initialPrompt
                  ? `${wsSection}\n\n---\n\n${config.initialPrompt}`
                  : wsSection
              }
            }
          }
        } catch (wsErr: any) {
          console.warn('[IPC] Failed to load workspace for session:', wsErr.message)
        }
      }

      // ★ autoWorktree 开启时：向 AI 注入 worktree 使用规则
      // 工作区会话：对工作区内每个仓库都注入规则（而非仅主仓库）
      // 各 provider 有自己的规则文件发现机制，写文件比发消息更干净：
      //   claude-code  → .claude/rules/spectrai-worktree.md（启动时自动加载）
      //              + systemPrompt.append（双重保险，确保 SDK 模式下规则生效）
      //   codex        → AGENTS.md（Codex 自动发现，社区标准）
      //   gemini-cli   → GEMINI.md（Gemini CLI 自动加载）
      //   其他未知      → fallback：作为 initialPrompt 前缀发送
      const settings = database.getAppSettings()
      console.log(`[IPC] autoWorktree=${settings.autoWorktree}, providerId=${providerId}, workDir=${config.workingDirectory}`)
      if (settings.autoWorktree) {
        if (providerId === 'claude-code') {
          // 主仓库注入（会话工作目录）
          injectWorktreeRule(config.workingDirectory)
          // 工作区内其他仓库也注入 worktree 规则，让 AI 对每个仓库都有隔离意识
          for (const repo of workspaceRepos) {
            if (!repo.isPrimary) {
              try {
                injectWorktreeRule(repo.repoPath)
              } catch (_) { /* 非 git 仓库则忽略 */ }
            }
          }
          // ★ 双重保险：同时通过 systemPromptAppend 注入规则
          // 原因：Claude Code SDK 在某些情况下可能不会重新加载 .claude/rules/ 文件，
          // 但 systemPromptAppend 通过 SessionManagerV2 直接注入 SDK systemPrompt，100% 生效
          const worktreeRule = buildWorktreePrompt(detectBaseBranch(config.workingDirectory))
          config.systemPromptAppend = config.systemPromptAppend
            ? config.systemPromptAppend + '\n\n' + worktreeRule
            : worktreeRule
          console.log(`[IPC] worktree rule injected via systemPromptAppend, length=${config.systemPromptAppend.length}`)
        } else if (providerId === 'codex') {
          injectWorktreeRuleToAgentsMd(config.workingDirectory)
        } else if (providerId === 'gemini-cli') {
          injectWorktreeRuleToGeminiMd(config.workingDirectory)
        } else {
          const worktreeRule = buildWorktreePrompt(detectBaseBranch(config.workingDirectory))
          config.initialPrompt = config.initialPrompt
            ? `${worktreeRule}\n\n---\n\n${config.initialPrompt}`
            : worktreeRule
        }
      }

      // ★ 注入文件操作规则（让 AI 使用 SpectrAI MCP 工具修改文件，以便追踪 diff）
      // 各 provider 有自己的规则文件发现机制：
      //   claude-code  → .claude/rules/spectrai-fileops.md + systemPromptAppend（双重保险）
      //   codex        → AGENTS.md 的 FILEOPS 管理块
      //   gemini-cli   → GEMINI.md 的 FILEOPS 管理块
      //   其他          → initialPrompt 前缀
      if (config.workingDirectory) {
        try {
          if (providerId === 'claude-code') {
            injectFileOpsRule(config.workingDirectory)
            // 双重保险：通过 systemPromptAppend 注入
            const fileOpsRule = buildFileOpsPrompt()
            config.systemPromptAppend = config.systemPromptAppend
              ? config.systemPromptAppend + '\n\n' + fileOpsRule
              : fileOpsRule
          } else if (providerId === 'codex') {
            injectFileOpsRuleToAgentsMd(config.workingDirectory)
          } else if (providerId === 'gemini-cli') {
            injectFileOpsRuleToGeminiMd(config.workingDirectory)
          } else {
            // fallback: 作为 initialPrompt 前缀注入
            const fileOpsRule = buildFileOpsPrompt()
            config.initialPrompt = config.initialPrompt
              ? `${fileOpsRule}\n\n---\n\n${config.initialPrompt}`
              : fileOpsRule
          }
          console.log(`[IPC] file ops rule injected for session (provider: ${providerId})`)
        } catch (err: any) {
          console.warn('[IPC] Failed to inject file ops rule:', err.message)
        }
      }

      // ★ MCP 注入策略（支持 claude-code / iflow / codex）：
      //   - 用户配置的 MCP：所有会话均注入，无论是否开启 Supervisor 模式
      //   - spectrai-agent 系统 MCP：仅 enableAgent（Supervisor）模式下注入，用于跨会话编排
      //   bridgePort = 0 时 generate* 内部自动跳过 spectrai-agent 段，其余逻辑不变
      {
        const sessionMcpBridgePort = (agentBridgePort && config.enableAgent) ? agentBridgePort : 0
        const mcpSessionId = config.id || `session-${Date.now()}`
        // 确定 MCP 工具分级模式：
        // - supervisor: Supervisor 主会话，拥有完整 Agent 调度 + Leader 团队工具
        // - awareness: 普通会话（非 Supervisor），仅跨会话感知 + worktree + 文件操作
        const mcpSessionMode = config.supervisorMode ? 'supervisor' : 'awareness'
        if (providerId === 'claude-code' || providerId === 'iflow') {
          // Claude Code / iFlow：通过 JSON 文件注入 MCP（--mcp-config / ACP loadMcpServersForAcp）
          const userMcps = database.getEnabledMcpsForProvider(providerId)
          if (userMcps.length > 0 || sessionMcpBridgePort > 0) {
            config.mcpConfigPath = MCPConfigGenerator.generate(
              mcpSessionId, sessionMcpBridgePort, config.workingDirectory, providerId, database, mcpSessionMode
            )
          }
        } else if (providerId === 'codex') {
          // Codex：通过 CODEX_HOME 环境变量重定向配置目录，实现按会话 MCP 隔离
          const userMcps = database.getEnabledMcpsForProvider(providerId)
          if (userMcps.length > 0 || sessionMcpBridgePort > 0) {
            const codexHomeDir = MCPConfigGenerator.generateForCodex(
              mcpSessionId, sessionMcpBridgePort, config.workingDirectory, providerId, database, mcpSessionMode
            )
            config.env = { ...config.env, CODEX_HOME: codexHomeDir }
          }
        }
      }

      config.providerId = provider.id
      config.adapterType = provider.adapterType

      // ★ 创建 SDK V2 会话
      // 数据库记录由 systemHandlers.ts 中的 session_start 事件统一写入，此处不重复写（避免 UNIQUE constraint 冲突）
      const sessionId = smV2.createSession(config, provider)
      concurrencyGuard.registerSession()
      database.recordDirectoryUsage(config.workingDirectory)

      // 等待会话脱离 starting（可交互/失败）再返回，减少“创建成功但仍假性处理中”的体验问题
      const readyTimeoutMs = provider.id === 'codex' ? 12000 : 6000
      const readyInfo = await smV2.waitForSessionReady(sessionId, readyTimeoutMs)

      if (readyInfo.status === 'error') {
        return {
          success: false,
          sessionId,
          ready: true,
          status: readyInfo.status,
          error: readyInfo.error || '会话启动失败',
        }
      }

      return {
        success: true,
        sessionId,
        ready: readyInfo.ready,
        status: readyInfo.status,
      }
      } catch (error: any) {
        console.error('[IPC] SESSION_CREATE error:', error)
        return { success: false, error: error.message }
      }
    })()
    createSessionInFlight.set(dedupeKey, task)
    try {
      return await task
    } finally {
      createSessionInFlight.delete(dedupeKey)
    }
  })

  ipcMain.handle(IPC.SESSION_TERMINATE, async (_event, sessionId: string) => {
    try {
      const smV2 = deps.sessionManagerV2
      if (!smV2) {
        return { success: false, error: 'SDK V2 SessionManager 未初始化' }
      }
      if (smV2.getSession(sessionId)) {
        await smV2.terminateSession(sessionId)
        concurrencyGuard.unregisterSession()
      }
      database.updateSession(sessionId, { status: 'terminated' as any })
      return { success: true }
    } catch (error: any) {
      console.error('[IPC] SESSION_TERMINATE error:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(IPC.SESSION_DELETE, async (_event, sessionId: string) => {
    try {
      const smV2 = deps.sessionManagerV2
      // 若会话仍在运行，先终止
      if (smV2?.getSession(sessionId)) {
        await smV2.terminateSession(sessionId)
        concurrencyGuard.unregisterSession()
      }
      database.deleteSession(sessionId)
      // 从内存 Map 中移除，防止 SESSION_GET_ALL 返回已删除的"幽灵会话"
      // 导致 fetchSessions() 合并后已删会话重新出现在前端列表
      smV2?.removeSession(sessionId)
      return { success: true }
    } catch (error: any) {
      console.error('[IPC] SESSION_DELETE error:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(IPC.SESSION_SEND_INPUT, async (_event, sessionId: string, input: string) => {
    try {
      const smV2 = deps.sessionManagerV2
      if (!smV2) {
        return { success: false, error: 'SDK V2 SessionManager 未初始化' }
      }
      await smV2.sendMessage(sessionId, input)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(IPC.SESSION_CONFIRM, async (_event, sessionId: string, confirmed: boolean) => {
    try {
      const smV2 = deps.sessionManagerV2
      if (!smV2) {
        return { success: false, error: 'SDK V2 SessionManager 未初始化' }
      }
      await smV2.sendConfirmation(sessionId, confirmed)

      if (notificationManager.acknowledge(sessionId, 'confirmation')) {
        trayManager.decrementBadge()
      }

      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(IPC.SESSION_GET_OUTPUT, async (_event, _sessionId: string) => {
    // V1 PTY 输出缓冲区已移除，V2 通过 conversation-message 事件推流，此 IPC 不再使用
    return []
  })

  ipcMain.handle(IPC.SESSION_RESIZE, async (_event, _sessionId: string, _cols: number, _rows: number) => {
    // V2 Adapter 层不需要手动 resize
    return { success: true }
  })

  ipcMain.handle(IPC.SESSION_GET_ALL, async () => {
    try {
      const smV2 = deps.sessionManagerV2
      if (!smV2) return []

      return smV2.getAllSessions().map(s => ({
        config: s.config,
        status: s.status,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        exitCode: s.exitCode,
        estimatedTokens: s.totalUsage.inputTokens + s.totalUsage.outputTokens,
        id: s.id,
        name: s.name,
        claudeSessionId: s.claudeSessionId,
        providerId: s.config.providerId || 'claude-code'
      }))
    } catch (error) {
      console.error('[IPC] SESSION_GET_ALL error:', error)
      return []
    }
  })

  ipcMain.handle(IPC.SESSION_GET_STATS, async (_event, sessionId: string) => {
    try {
      const smV2 = deps.sessionManagerV2
      const v2Session = smV2?.getSession(sessionId)
      if (v2Session) {
        const duration = v2Session.startedAt
          ? Math.floor((Date.now() - new Date(v2Session.startedAt).getTime()) / 1000)
          : 0
        return {
          tokenCount: v2Session.totalUsage.inputTokens + v2Session.totalUsage.outputTokens,
          duration,
          outputLines: 0
        }
      }
      return { tokenCount: 0, duration: 0 }
    } catch (error) {
      return { tokenCount: 0, duration: 0 }
    }
  })

  // ==================== Session 历史查询 ====================

  ipcMain.handle(IPC.SESSION_GET_HISTORY, async () => {
    try {
      const dbSessions = database.getAllSessions()
      return dbSessions.map((s: any) => ({
        id: s.id,
        name: s.name,
        config: s.config,
        status: s.status,
        startedAt: s.startedAt instanceof Date ? s.startedAt.toISOString() : s.startedAt,
        endedAt: s.endedAt instanceof Date ? s.endedAt.toISOString() : s.endedAt,
        exitCode: s.exitCode,
        estimatedTokens: s.estimatedTokens || 0,
        claudeSessionId: s.claudeSessionId,
        providerId: s.providerId || 'claude-code'
      }))
    } catch (error) {
      console.error('[IPC] SESSION_GET_HISTORY error:', error)
      return []
    }
  })

  ipcMain.handle(IPC.SESSION_GET_ACTIVITIES, async (_event, sessionId: string, limit?: number) => {
    try {
      return database.getSessionActivities(sessionId, limit || 500)
    } catch (error) {
      console.error('[IPC] SESSION_GET_ACTIVITIES error:', error)
      return []
    }
  })

  // ==================== Session 日志 ====================

  ipcMain.handle(IPC.SESSION_GET_LOGS, async (_event, sessionId: string) => {
    try {
      return database.getSessionLogs(sessionId)
    } catch (error) {
      console.error('[IPC] SESSION_GET_LOGS error:', error)
      return []
    }
  })

  // ==================== Session 重命名 ====================

  ipcMain.handle(IPC.SESSION_RENAME, async (_event, sessionId: string, newName: string) => {
    try {
      const trimmed = newName.trim()
      if (!trimmed) {
        return { success: false, error: '名称不能为空' }
      }

      database.updateSession(sessionId, { name: trimmed, nameLocked: true })

      const smV2 = deps.sessionManagerV2
      const inMemory = smV2?.renameSession(sessionId, trimmed) ?? false

      if (!inMemory) {
        sendToRenderer(IPC.SESSION_NAME_CHANGE, sessionId, trimmed)
      }

      return { success: true }
    } catch (error: any) {
      console.error('[IPC] SESSION_RENAME error:', error)
      return { success: false, error: error.message }
    }
  })

  // ==================== Session AI 重命名 ====================

  ipcMain.handle(IPC.SESSION_AI_RENAME, async (_event, sessionId: string) => {
    if (aiRenamingLocks.has(sessionId)) {
      return { success: false, error: '正在 AI 重命名中，请稍候' }
    }
    aiRenamingLocks.add(sessionId)
    try {
      const result = await performAiRename(database, sessionId)
      if (!result.success) return result

      database.updateSession(sessionId, { name: result.name!, nameLocked: true })

      const smV2 = deps.sessionManagerV2
      const inMemory = smV2?.renameSession(sessionId, result.name!) ?? false
      if (!inMemory) {
        sendToRenderer(IPC.SESSION_NAME_CHANGE, sessionId, result.name!)
      }

      return { success: true, name: result.name }
    } catch (error: any) {
      console.error('[IPC] SESSION_AI_RENAME error:', error)
      return { success: false, error: error.message }
    } finally {
      aiRenamingLocks.delete(sessionId)
    }
  })

  // ==================== Session 恢复 ====================

  ipcMain.handle(IPC.SESSION_RESUME, async (_event, oldSessionId: string) => {
    try {
      const smV2 = deps.sessionManagerV2
      if (!smV2) {
        return { success: false, error: 'SDK V2 SessionManager 未初始化' }
      }

      const dbSessions = database.getAllSessions()
      const oldSession = dbSessions.find((s: any) => s.id === oldSessionId)
      if (!oldSession) {
        return { success: false, error: '找不到原会话记录' }
      }

      const providerId = oldSession.providerId || oldSession.config?.providerId || 'claude-code'
      const provider: AIProvider = database.getProvider(providerId) || BUILTIN_CLAUDE_PROVIDER

      if (!provider.resumeArg) {
        const resourceCheck = concurrencyGuard.checkResources();
        if (!resourceCheck.canCreate) {
          return { success: false, error: resourceCheck.reason };
        }

        const history = database.getConversationMessages(oldSessionId, 260);
        const summaries = database.getSessionSummaries(oldSessionId, 24);
        const resumeInitialPrompt = buildResumeBootstrapPrompt(summaries, history);
        const continueSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const baseConfig = (oldSession.config || {}) as SessionConfig;
        const resumeName = oldSession.name || baseConfig.name || 'Session';

        const resumeConfig: SessionConfig = {
          ...baseConfig,
          id: continueSessionId,
          name: resumeName,
          workingDirectory: oldSession.workingDirectory || baseConfig.workingDirectory,
          providerId: provider.id,
          adapterType: provider.adapterType,
          initialPrompt: resumeInitialPrompt,
          initialPromptVisibility: resumeInitialPrompt ? 'hidden' : undefined,
        };
        delete (resumeConfig as any).claudeArgs;

        // Resume A：用户 MCP 始终注入；spectrai-agent 仅 enableAgent 时注入
        {
          const resumeMcpBridgePort = (agentBridgePort && resumeConfig.enableAgent) ? agentBridgePort : 0
          const resumeMcpMode = resumeConfig.supervisorMode ? 'supervisor' : 'awareness'
          if (providerId === 'claude-code' || providerId === 'iflow') {
            const userMcps = database.getEnabledMcpsForProvider(providerId)
            if (userMcps.length > 0 || resumeMcpBridgePort > 0) {
              resumeConfig.mcpConfigPath = MCPConfigGenerator.generate(
                continueSessionId, resumeMcpBridgePort, oldSession.workingDirectory, providerId, database, resumeMcpMode
              );
            }
          } else if (providerId === 'codex') {
            const userMcps = database.getEnabledMcpsForProvider(providerId)
            if (userMcps.length > 0 || resumeMcpBridgePort > 0) {
              const codexHomeDir = MCPConfigGenerator.generateForCodex(
                continueSessionId, resumeMcpBridgePort, oldSession.workingDirectory, providerId, database, resumeMcpMode
              );
              resumeConfig.env = { ...resumeConfig.env, CODEX_HOME: codexHomeDir };
            }
          }
        }

        // ★ Resume A：重新注入 awareness/supervisor 提示 + worktree 规则
        // 会话结束时规则文件已被清理，resume 创建新会话时必须重新写入
        if (resumeConfig.supervisorMode) {
          const allProviders = database.getAllProviders()
          const availability = await checkProviderAvailability(allProviders)
          const providerNames = availability.map((a: any) =>
            a.available ? `${a.name}(${a.id})` : `${a.name}(${a.id}) [未安装]`
          )
          if (providerId === 'claude-code') {
            injectSupervisorPrompt(resumeConfig.workingDirectory, providerNames)
          } else if (providerId === 'codex') {
            injectSupervisorPromptToAgentsMd(resumeConfig.workingDirectory, providerNames)
          } else if (providerId === 'gemini-cli') {
            injectSupervisorPromptToGeminiMd(resumeConfig.workingDirectory, providerNames)
          } else {
            const supervisorContent = buildSupervisorPrompt(providerNames)
            resumeConfig.initialPrompt = resumeConfig.initialPrompt
              ? `${supervisorContent}\n\n---\n\n${resumeConfig.initialPrompt}`
              : supervisorContent
          }
        } else if (providerId === 'claude-code') {
          injectAwarenessPrompt(resumeConfig.workingDirectory)
        }
        if (providerId === 'claude-code') {
          const resumeSettings = database.getAppSettings()
          if (resumeSettings.autoWorktree) {
            injectWorktreeRule(resumeConfig.workingDirectory)
            // ★ 双重保险：通过 systemPromptAppend 注入规则
            const worktreeRule = buildWorktreePrompt(detectBaseBranch(resumeConfig.workingDirectory))
            resumeConfig.systemPromptAppend = resumeConfig.systemPromptAppend
              ? resumeConfig.systemPromptAppend + '\n\n' + worktreeRule
              : worktreeRule
          }
        } else if (providerId === 'codex') {
          const resumeSettings = database.getAppSettings()
          if (resumeSettings.autoWorktree) {
            injectWorktreeRuleToAgentsMd(resumeConfig.workingDirectory)
          }
        } else if (providerId === 'gemini-cli') {
          const resumeSettings = database.getAppSettings()
          if (resumeSettings.autoWorktree) {
            injectWorktreeRuleToGeminiMd(resumeConfig.workingDirectory)
          }
        } else {
          const resumeSettings = database.getAppSettings()
          if (resumeSettings.autoWorktree) {
            const worktreeRule = buildWorktreePrompt(detectBaseBranch(resumeConfig.workingDirectory))
            resumeConfig.initialPrompt = resumeConfig.initialPrompt
              ? `${worktreeRule}\n\n---\n\n${resumeConfig.initialPrompt}`
              : worktreeRule
          }
        }

        // ★ 注入文件操作规则（resume 时也需要重新注入）
        if (resumeConfig.workingDirectory) {
          try {
            if (providerId === 'claude-code') {
              injectFileOpsRule(resumeConfig.workingDirectory)
              const fileOpsRule = buildFileOpsPrompt()
              resumeConfig.systemPromptAppend = resumeConfig.systemPromptAppend
                ? resumeConfig.systemPromptAppend + '\n\n' + fileOpsRule
                : fileOpsRule
            } else if (providerId === 'codex') {
              injectFileOpsRuleToAgentsMd(resumeConfig.workingDirectory)
            } else if (providerId === 'gemini-cli') {
              injectFileOpsRuleToGeminiMd(resumeConfig.workingDirectory)
            } else {
              const fileOpsRule = buildFileOpsPrompt()
              resumeConfig.initialPrompt = resumeConfig.initialPrompt
                ? `${fileOpsRule}\n\n---\n\n${resumeConfig.initialPrompt}`
                : fileOpsRule
            }
          } catch (err) { /* ignore */ }
        }

        const newSessionId = smV2.createSession(resumeConfig, provider);
        concurrencyGuard.registerSession();
        database.recordDirectoryUsage(resumeConfig.workingDirectory);

        const readyTimeoutMs = provider.id === 'codex' ? 12000 : 6000;
        await smV2.waitForSessionReady(newSessionId, readyTimeoutMs);

        console.warn(`[IPC] ${provider.name} does not support native resume; created continuation session ${newSessionId} from ${oldSessionId}`);
        return { success: true, sessionId: newSessionId, recreated: true };
      }

      const resourceCheck = concurrencyGuard.checkResources()
      if (!resourceCheck.canCreate) {
        return { success: false, error: resourceCheck.reason }
      }

      const claudeSessionId = (oldSession as any).claudeSessionId
      const resumeArg = provider.resumeArg
      const isSubcommand = provider.resumeFormat === 'subcommand'

      const knownResumeArgs = new Set([resumeArg, '--resume', 'resume'])
      const baseArgs = (oldSession.config?.claudeArgs || []).filter((arg: string, idx: number, arr: string[]) => {
        if (knownResumeArgs.has(arg)) return false
        if (idx > 0 && knownResumeArgs.has(arr[idx - 1])) return false
        return true
      })

      let resumeArgs: string[]

      if (isSubcommand) {
        if (claudeSessionId) {
          resumeArgs = [resumeArg, claudeSessionId]
          console.log(`[IPC] Resuming with ${provider.name} subcommand: ${resumeArg} ${claudeSessionId}`)
        } else {
          resumeArgs = [resumeArg]
          console.warn(`[IPC] No session ID, falling back to ${provider.name}: ${resumeArg}`)
        }
      } else {
        resumeArgs = [...baseArgs]
        if (claudeSessionId) {
          resumeArgs.push(resumeArg, claudeSessionId)
          console.log(`[IPC] Resuming with ${provider.name} flag: ${resumeArg} ${claudeSessionId}`)
        } else {
          resumeArgs.push(resumeArg)
          console.warn(`[IPC] No claudeSessionId in DB, falling back to ${resumeArg} picker`)
        }
      }

      let resumeName = oldSession.name
      if (/\.exe\b/i.test(resumeName) || /^[A-Za-z]:\\Windows\\/i.test(resumeName)) {
        resumeName = oldSession.workingDirectory.split(/[\\\/]/).filter(Boolean).pop() || 'Session'
      }

      let resumeInitialPrompt: string | undefined
      if (provider.adapterType === 'codex-appserver') {
        const history = database.getConversationMessages(oldSessionId, 260)
        const summaries = database.getSessionSummaries(oldSessionId, 24)
        resumeInitialPrompt = buildResumeBootstrapPrompt(summaries, history)
        if (resumeInitialPrompt) {
          const promptTokens = estimateTokensApprox(resumeInitialPrompt)
          console.warn(
            `[IPC] ${provider.name} resume fallback: summaries=${summaries.length}, recentMessages=${history.length}, promptTokens~${promptTokens}`
          )
        }
      }

      const resumeConfig = {
        ...(oldSession.config || {}),
        name: resumeName,
        workingDirectory: oldSession.workingDirectory,
        claudeArgs: resumeArgs,
        providerId: provider.id,
        adapterType: provider.adapterType,
        initialPrompt: resumeInitialPrompt,
        initialPromptVisibility: resumeInitialPrompt ? 'hidden' : undefined,
      }

      // ★ 重新生成 MCP 配置文件（旧文件在上次关闭时已被 cleanupAll 删除）
      // Resume B：重新生成 MCP 配置（旧文件在上次关闭时已被 cleanupAll 删除）
      // 用户 MCP 始终注入；spectrai-agent 仅 enableAgent（Supervisor）模式时注入
      {
        const resumeMcpBridgePort = (agentBridgePort && resumeConfig.enableAgent) ? agentBridgePort : 0
        const resumeMcpMode = resumeConfig.supervisorMode ? 'supervisor' : 'awareness'
        if (providerId === 'claude-code' || providerId === 'iflow') {
          const userMcps = database.getEnabledMcpsForProvider(providerId)
          if (userMcps.length > 0 || resumeMcpBridgePort > 0) {
            resumeConfig.mcpConfigPath = MCPConfigGenerator.generate(
              oldSessionId, resumeMcpBridgePort, oldSession.workingDirectory, providerId, database, resumeMcpMode
            )
          }
        } else if (providerId === 'codex') {
          const userMcps = database.getEnabledMcpsForProvider(providerId)
          if (userMcps.length > 0 || resumeMcpBridgePort > 0) {
            const codexHomeDir = MCPConfigGenerator.generateForCodex(
              oldSessionId, resumeMcpBridgePort, oldSession.workingDirectory, providerId, database, resumeMcpMode
            )
            resumeConfig.env = { ...resumeConfig.env, CODEX_HOME: codexHomeDir }
          }
        }
      }

      // ★ Resume B：重新注入 awareness/supervisor 提示 + worktree 规则
      // 会话结束时规则文件已被清理，resume 重启会话时必须重新写入
      if (resumeConfig.supervisorMode) {
        const allProviders = database.getAllProviders()
        const availability = await checkProviderAvailability(allProviders)
        const providerNames = availability.map((a: any) =>
          a.available ? `${a.name}(${a.id})` : `${a.name}(${a.id}) [未安装]`
        )
        if (providerId === 'claude-code') {
          injectSupervisorPrompt(resumeConfig.workingDirectory, providerNames)
        } else if (providerId === 'codex') {
          injectSupervisorPromptToAgentsMd(resumeConfig.workingDirectory, providerNames)
        } else if (providerId === 'gemini-cli') {
          injectSupervisorPromptToGeminiMd(resumeConfig.workingDirectory, providerNames)
        } else {
          const supervisorContent = buildSupervisorPrompt(providerNames)
          resumeConfig.initialPrompt = resumeConfig.initialPrompt
            ? `${supervisorContent}\n\n---\n\n${resumeConfig.initialPrompt}`
            : supervisorContent
        }
      } else if (providerId === 'claude-code') {
        injectAwarenessPrompt(resumeConfig.workingDirectory)
      }
      if (providerId === 'claude-code') {
        const resumeSettings = database.getAppSettings()
        if (resumeSettings.autoWorktree) {
          injectWorktreeRule(resumeConfig.workingDirectory)
          // ★ 双重保险：通过 systemPromptAppend 注入规则
          const worktreeRule = buildWorktreePrompt(detectBaseBranch(resumeConfig.workingDirectory))
          resumeConfig.systemPromptAppend = resumeConfig.systemPromptAppend
            ? resumeConfig.systemPromptAppend + '\n\n' + worktreeRule
            : worktreeRule
        }
      } else if (providerId === 'codex') {
        const resumeSettings = database.getAppSettings()
        if (resumeSettings.autoWorktree) {
          injectWorktreeRuleToAgentsMd(resumeConfig.workingDirectory)
        }
      } else if (providerId === 'gemini-cli') {
        const resumeSettings = database.getAppSettings()
        if (resumeSettings.autoWorktree) {
          injectWorktreeRuleToGeminiMd(resumeConfig.workingDirectory)
        }
      }

      // ★ 注入文件操作规则（resume 时也需要重新注入）
      if (resumeConfig.workingDirectory) {
        try {
          if (providerId === 'claude-code') {
            injectFileOpsRule(resumeConfig.workingDirectory)
            const fileOpsRule = buildFileOpsPrompt()
            resumeConfig.systemPromptAppend = resumeConfig.systemPromptAppend
              ? resumeConfig.systemPromptAppend + '\n\n' + fileOpsRule
              : fileOpsRule
          } else if (providerId === 'codex') {
            injectFileOpsRuleToAgentsMd(resumeConfig.workingDirectory)
          } else if (providerId === 'gemini-cli') {
            injectFileOpsRuleToGeminiMd(resumeConfig.workingDirectory)
          } else {
            const fileOpsRule = buildFileOpsPrompt()
            resumeConfig.initialPrompt = resumeConfig.initialPrompt
              ? `${fileOpsRule}\n\n---\n\n${resumeConfig.initialPrompt}`
              : fileOpsRule
          }
        } catch (err) { /* ignore */ }
      }

      smV2.createSessionWithId(
        oldSessionId,
        resumeConfig,
        claudeSessionId || undefined,
        provider
      )
      concurrencyGuard.registerSession()
      console.log(`[IPC] SDK V2 resume: ${oldSessionId} via ${provider.name} adapter`)

      database.updateSession(oldSessionId, {
        status: 'running' as any,
        config: resumeConfig,
        name: resumeName
      })

      if (claudeSessionId) {
        const allSessions = database.getAllSessions()
        for (const s of allSessions) {
          if (s.id !== oldSessionId && (s as any).claudeSessionId === claudeSessionId && s.status === 'interrupted') {
            database.updateSession(s.id, { status: 'completed' as any })
            console.log(`[IPC] Cleaned up duplicate interrupted session: ${s.id}`)
          }
        }
      }

      return { success: true, sessionId: oldSessionId }
    } catch (error: any) {
      console.error('[IPC] SESSION_RESUME error:', error)
      return { success: false, error: error.message }
    }
  })

  // ==================== SDK V2: 对话 API ====================

  ipcMain.handle(IPC.SESSION_SEND_MESSAGE, async (_event, sessionId: string, message: string) => {
    try {
      const smV2 = deps.sessionManagerV2
      if (!smV2) {
        return { success: false, error: 'SDK V2 SessionManager 未初始化' }
      }
      const dispatch = await smV2.sendMessage(sessionId, message)
      return { success: true, dispatch }
    } catch (error: any) {
      console.error('[IPC] SESSION_SEND_MESSAGE error:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(IPC.SESSION_ABORT, async (_event, sessionId: string) => {
    try {
      const smV2 = deps.sessionManagerV2
      if (!smV2) {
        return { success: false, error: 'SDK V2 SessionManager 未初始化' }
      }
      await smV2.abortSession(sessionId)
      return { success: true }
    } catch (error: any) {
      console.error('[IPC] SESSION_ABORT error:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(IPC.SESSION_CONVERSATION_HISTORY, async (_event, sessionId: string) => {
    try {
      const smV2 = deps.sessionManagerV2
      if (smV2) {
        const liveMessages = smV2.getConversation(sessionId)
        if (liveMessages.length > 0) return liveMessages
      }
      return database.getConversationMessages(sessionId)
    } catch (error) {
      console.error('[IPC] SESSION_CONVERSATION_HISTORY error:', error)
      return []
    }
  })

  ipcMain.handle(IPC.SESSION_PERMISSION_RESPOND, async (_event, sessionId: string, accept: boolean) => {
    try {
      const smV2 = deps.sessionManagerV2
      if (!smV2) {
        return { success: false, error: 'SDK V2 SessionManager 未初始化' }
      }
      await smV2.sendConfirmation(sessionId, accept)

      if (notificationManager.acknowledge(sessionId, 'confirmation')) {
        trayManager.decrementBadge()
      }

      return { success: true }
    } catch (error: any) {
      console.error('[IPC] SESSION_PERMISSION_RESPOND error:', error)
      return { success: false, error: error.message }
    }
  })

  // SDK V2: AskUserQuestion 答案响应
  ipcMain.handle(IPC.SESSION_ANSWER_QUESTION, async (_event, sessionId: string, answers: Record<string, string>) => {
    try {
      const smV2 = deps.sessionManagerV2
      if (!smV2) return { success: false, error: 'SDK V2 SessionManager 未初始化' }
      await smV2.sendQuestionAnswer(sessionId, answers)
      return { success: true }
    } catch (error: any) {
      console.error('[IPC] SESSION_ANSWER_QUESTION error:', error)
      return { success: false, error: error.message }
    }
  })

  // SDK V2: ExitPlanMode 审批响应
  ipcMain.handle(IPC.SESSION_APPROVE_PLAN, async (_event, sessionId: string, approved: boolean) => {
    try {
      const smV2 = deps.sessionManagerV2
      if (!smV2) return { success: false, error: 'SDK V2 SessionManager 未初始化' }
      await smV2.sendPlanApproval(sessionId, approved)
      return { success: true }
    } catch (error: any) {
      console.error('[IPC] SESSION_APPROVE_PLAN error:', error)
      return { success: false, error: error.message }
    }
  })

  // SDK V2: 获取排队中的消息列表
  ipcMain.handle(IPC.SESSION_GET_QUEUE, async (_event, sessionId: string) => {
    try {
      const smV2 = deps.sessionManagerV2
      if (!smV2) return { success: false, error: 'SDK V2 SessionManager 未初始化' }
      const messages = smV2.getScheduledMessages(sessionId)
      return { success: true, messages }
    } catch (error: any) {
      console.error('[IPC] SESSION_GET_QUEUE error:', error)
      return { success: false, error: error.message }
    }
  })

  // SDK V2: 清空排队中的消息（用户主动取消）
  ipcMain.handle(IPC.SESSION_CLEAR_QUEUE, async (_event, sessionId: string) => {
    try {
      const smV2 = deps.sessionManagerV2
      if (!smV2) return { success: false, error: 'SDK V2 SessionManager 未初始化' }
      const cleared = smV2.clearScheduledMessages(sessionId)
      return { success: true, cleared }
    } catch (error: any) {
      console.error('[IPC] SESSION_CLEAR_QUEUE error:', error)
      return { success: false, error: error.message }
    }
  })
}
