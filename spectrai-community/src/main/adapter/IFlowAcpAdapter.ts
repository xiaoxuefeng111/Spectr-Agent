/**
 * iFlow CLI ACP Adapter
 *
 * 通过 iFlow CLI 的 --experimental-acp 模式（无 --port 参数 = stdio 模式）
 * 与 iFlow 进行结构化交互。
 *
 * 协议：JSON-RPC 2.0 over NDJSON on stdin/stdout（类 MCP stdio transport）
 *
 * 握手流程：
 *   initialize → authenticate → session/new → session/prompt (multi-turn)
 *
 * 服务端推送通知（iflow → SpectrAI，stdout）：
 *   session/update        → agent_message_chunk / tool_call / tool_call_update
 *   session/request_permission → 权限确认
 *   _iflow/user/questions → 向用户提问（转为 permission_request）
 *
 * @author weibin
 */

import { spawn, type ChildProcess } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import { createInterface } from 'readline'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ConversationMessage } from '../../shared/types'
import {
  BaseProviderAdapter,
  type AdapterSessionConfig,
  type AdapterSession,
  type ProviderEvent,
} from './types'
import { prependNodeVersionToEnvPath } from '../node/NodeVersionResolver'

// ---- iFlow Node 版本检测 ----
// iFlow CLI 内部使用了 /v 正则标志（Unicode Sets），需要 Node.js 20+
// 当 nvm 当前激活的是 Node 18 或更旧版本时会出现 SyntaxError: Invalid regular expression flags
// 解决方案：通过 NVM_HOME + NVM_SYMLINK 找到 Node >=20 的二进制，直接运行 iFlow 的 entry.js

/**
 * 找到 iFlow CLI 的 spawn 参数：
 * - 优先使用 Provider 配置的 nodeVersion（从 NVM_HOME 中精确定位）
 * - 如果当前 Node < 20：使用 NVM_HOME 中 Node >=20 的二进制 + iFlow entry.js 路径
 * - 否则：直接运行 iflow 命令（shell 模式）
 *
 * @param nodeVersion Provider 配置的 Node 版本（可选，如 "24.11.0"）
 * @returns { command, extraArgs, useShell }
 */
/**
 * 在 NVM_HOME 各版本目录里找到同时包含 node.exe 和 iflow entry.js 的目录。
 * 版本按 major.minor.patch 降序排列，优先取最新版本。
 */
function scanNvmForIFlow(nvmHome: string): { nodeBin: string; iflowEntry: string } | null {
  try {
    const dirs = fs.readdirSync(nvmHome)
      .map(e => {
        const m = e.match(/^v?(\d+)\.(\d+)\.(\d+)$/)
        return m
          ? { dir: path.join(nvmHome, e), v: [+m[1], +m[2], +m[3]] as [number, number, number] }
          : null
      })
      .filter((x): x is NonNullable<typeof x> => x !== null && x.v[0] >= 20)
      .sort((a, b) => a.v[0] !== b.v[0] ? b.v[0] - a.v[0] : a.v[1] !== b.v[1] ? b.v[1] - a.v[1] : b.v[2] - a.v[2])

    for (const { dir } of dirs) {
      const nodeBin    = path.join(dir, 'node.exe')
      const iflowEntry = path.join(dir, 'node_modules', '@iflow-ai', 'iflow-cli', 'bundle', 'entry.js')
      if (fs.existsSync(nodeBin) && fs.existsSync(iflowEntry)) {
        return { nodeBin, iflowEntry }
      }
    }
  } catch (_) { /* ignore */ }
  return null
}

function findIFlowLaunchConfig(configCommand?: string, nodeVersion?: string): { command: string; extraArgs: string[]; useShell: boolean } {
  const normalizedCommand = (configCommand || 'iflow').trim() || 'iflow'
  const fallback = {
    command: normalizedCommand,
    extraArgs: [],
    useShell: process.platform === 'win32' && !path.isAbsolute(normalizedCommand),
  }

  if (process.platform !== 'win32') return fallback
  if (path.isAbsolute(normalizedCommand)) {
    return { command: normalizedCommand, extraArgs: [], useShell: false }
  }

  const nvmHome    = process.env.NVM_HOME    // e.g. D:\Program Files\nvm
  const nvmSymlink = process.env.NVM_SYMLINK // e.g. C:\Program Files\nodejs

  // ── 诊断日志：每次启动都打印，便于排查 ──
  console.log(
    `[IFlowAcpAdapter] findIFlowLaunchConfig:`
    + ` ElectronNode=${process.versions.node}`
    + ` NVM_HOME=${nvmHome ?? '(unset)'}`
    + ` NVM_SYMLINK=${nvmSymlink ?? '(unset)'}`
  )

  if (!nvmHome) {
    console.warn(`[IFlowAcpAdapter] NVM_HOME 未设置，fallback 到 shell iflow（需要 PATH 包含 iflow 才能运行）`)
    return fallback
  }

  // ── 优先使用 Provider 配置的 nodeVersion ──
  if (nodeVersion) {
    const candidates = [
      path.join(nvmHome, `v${nodeVersion}`),
      path.join(nvmHome, nodeVersion),
    ]
    for (const dir of candidates) {
      const nodeBin    = path.join(dir, 'node.exe')
      const iflowEntry = path.join(dir, 'node_modules', '@iflow-ai', 'iflow-cli', 'bundle', 'entry.js')
      if (fs.existsSync(nodeBin) && fs.existsSync(iflowEntry)) {
        console.log(`[IFlowAcpAdapter] Using configured Node v${nodeVersion}: ${nodeBin}`)
        return { command: nodeBin, extraArgs: [iflowEntry], useShell: false }
      }
    }
    console.warn(`[IFlowAcpAdapter] nodeVersion=${nodeVersion} 在 NVM_HOME 中未找到（含 iflow），继续自动检测`)
  }

  // ── 尝试 NVM_SYMLINK 下的 node.exe + entry.js ──
  // 注意：Electron 安装包环境 PATH 不一定含 nvm 的 npm bin，所以即使 Electron Node >= 20，
  // 也不能直接走 shell 模式，必须用绝对路径绕过 PATH 依赖。
  if (nvmSymlink) {
    const symNode    = path.join(nvmSymlink, 'node.exe')
    const symEntry   = path.join(nvmSymlink, 'node_modules', '@iflow-ai', 'iflow-cli', 'bundle', 'entry.js')
    const symNodeOk  = fs.existsSync(symNode)
    const symEntryOk = fs.existsSync(symEntry)
    console.log(
      `[IFlowAcpAdapter] NVM_SYMLINK check:`
      + ` node.exe=${symNodeOk ? '✓' : '✗'}(${symNode})`
      + ` entry.js=${symEntryOk ? '✓' : '✗'}`
    )
    if (symNodeOk && symEntryOk) {
      console.log(`[IFlowAcpAdapter] 使用 NVM_SYMLINK node.exe + entry.js，绕过 PATH 问题`)
      return { command: symNode, extraArgs: [symEntry], useShell: false }
    }
  }

  // ── 扫描 NVM_HOME 各版本目录（当 NVM_SYMLINK 不可用 / 路径不对时） ──
  console.log(`[IFlowAcpAdapter] 扫描 NVM_HOME 版本目录寻找 iflow...`)
  const found = scanNvmForIFlow(nvmHome)
  if (found) {
    console.log(`[IFlowAcpAdapter] 在 NVM_HOME 找到可用 iflow: ${found.nodeBin}`)
    return { command: found.nodeBin, extraArgs: [found.iflowEntry], useShell: false }
  }

  // ── npm 全局安装兜底：搜索 %APPDATA%\npm\iflow.cmd ──
  // iflow 也可能通过 npm install -g 安装，生成的是 .cmd 包装器
  const home = process.env.USERPROFILE || os.homedir()
  const npmGlobalDirs = [path.join(home, 'AppData', 'Roaming', 'npm')]
  const npmPrefix = process.env.NPM_PREFIX
  if (npmPrefix) npmGlobalDirs.push(npmPrefix)
  for (const dir of npmGlobalDirs) {
    for (const name of ['iflow.cmd', 'iflow.exe', 'iflow']) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate)) {
        console.log(`[IFlowAcpAdapter] 在 npm 全局目录找到 iflow: ${candidate}`)
        return { command: candidate, extraArgs: [], useShell: candidate.endsWith('.cmd') }
      }
    }
  }

  // ── 最终 fallback：shell 模式（iflow 必须在 PATH 中） ──
  console.warn(`[IFlowAcpAdapter] 未找到可用 iflow entry.js，fallback 到 shell 模式（iflow 需在 PATH 中）`)
  return fallback
}

// ---- ACP 方法名常量（来自 iflow bundle 逆向） ----

const ACP_METHOD = {
  initialize:        'initialize',
  authenticate:      'authenticate',
  session_new:       'session/new',
  session_prompt:    'session/prompt',
  session_cancel:    'session/cancel',
  session_set_mode:  'session/set_mode',
} as const

const ACP_NOTIFICATION = {
  session_update:             'session/update',
  session_request_permission: 'session/request_permission',
  ask_user_questions:         '_iflow/user/questions',
  exit_plan_mode:             '_iflow/plan/exit',
} as const

// session/update 的 sessionUpdate 子类型
const SESSION_UPDATE_TYPE = {
  agent_message_chunk: 'agent_message_chunk',
  tool_call:           'tool_call',
  tool_call_update:    'tool_call_update',
  // 可能还有其他
} as const

// ---- 内部会话状态 ----

interface IFlowSession {
  adapter: AdapterSession
  config: AdapterSessionConfig
  process: ChildProcess
  /** iFlow 内部的 sessionId（由 session/new 返回） */
  iflowSessionId?: string
  /** JSON-RPC 请求计数器 */
  requestId: number
  /** 待决的 RPC 请求 */
  pendingRequests: Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>
  /** 当前轮次 streaming 文本（用于拼接完整 assistant 消息） */
  currentText: string
  /** 当前工具调用 toolCallId → toolName 映射 */
  activeToolCalls: Map<string, string>
  /** 当前待确认的权限请求 JSON-RPC id（需要 sendConfirmation 回复） */
  pendingPermissionId?: number
}

export class IFlowAcpAdapter extends BaseProviderAdapter {
  readonly providerId = 'iflow'
  readonly displayName = 'iFlow CLI'

  private sessions: Map<string, IFlowSession> = new Map()
  /** resumeSession 传入的 iFlow 会话 ID，startSession 中的 session/new 读取后清除 */
  private pendingResumeIds: Map<string, string> = new Map()

  // ---- 会话生命周期 ----

  async startSession(sessionId: string, config: AdapterSessionConfig): Promise<void> {
    // 启动 iflow --experimental-acp（stdio ACP 模式）
    const args = ['--experimental-acp']

    // yolo 模式
    if (config.autoAccept) {
      args.push('--yolo')
    }

    // 模型
    if (config.model) {
      args.push('--model', config.model)
    }

    // 检测 Node 版本并决定启动方式
    // iFlow 需要 Node 20+（使用了 /v 正则标志），当前 nvm 可能激活了旧版本
    // 优先使用 Provider 配置的 nodeVersion，其次自动检测
    const { command: iflowCmd, extraArgs: iflowPrefix, useShell: iflowShell } = findIFlowLaunchConfig(config.command, config.nodeVersion)
    const finalArgs = [...iflowPrefix, ...args]
    const env = prependNodeVersionToEnvPath(
      { ...process.env, ...config.envOverrides },
      config.nodeVersion
    )
    console.log(`[IFlowAcpAdapter] Spawning iflow:`, iflowCmd, finalArgs, { shell: iflowShell, cwd: config.workingDirectory })
    const proc = spawn(iflowCmd, finalArgs, {
      cwd: config.workingDirectory,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: iflowShell,
      env,
    })

    const session: IFlowSession = {
      adapter: {
        sessionId,
        status: 'starting',
        messages: [],
        createdAt: new Date().toISOString(),
        totalUsage: { inputTokens: 0, outputTokens: 0 },
      },
      config,
      process: proc,
      requestId: 0,
      pendingRequests: new Map(),
      currentText: '',
      activeToolCalls: new Map(),
    }

    this.sessions.set(sessionId, session)

    // ---- 监听 stdout（ACP NDJSON 行） ----
    const rl = createInterface({ input: proc.stdout! })
    rl.on('line', (line) => this.handleLine(sessionId, line.trim()))

    // ---- stderr 转日志（同时缓存用于退出错误提示） ----
    // iflow 在 ACP 模式下会把所有 console.log 重定向到 stderr，属于调试信息
    // 注意：不要过滤 stderr，全量输出以便排查启动失败原因
    let stderrBuffer = ''
    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (!text) return
      stderrBuffer += text + '\n'
      // 超过 2KB 截断，只保留最新内容
      if (stderrBuffer.length > 2048) stderrBuffer = stderrBuffer.slice(-2048)
      // 错误/警告关键词用 error 级别，其余用 debug 级别
      if (text.includes('[ERROR]') || text.includes('Error:') || text.includes('FATAL') || text.includes('error:')) {
        console.error(`[IFlowAcpAdapter][${sessionId}] stderr:`, text)
      } else {
        console.log(`[IFlowAcpAdapter][${sessionId}] stderr:`, text)
      }
    })

    // ---- 进程退出 ----
    proc.on('exit', (code) => {
      const s = this.sessions.get(sessionId)
      if (!s) return
      rl.close()

      // 异常退出时向对话视图推送错误提示，确保用户不会看到空白
      if (code !== 0) {
        const errSnippet = stderrBuffer.trim().slice(0, 800)
        const content = errSnippet
          ? `⚠️ iFlow 进程异常退出 (exit ${code}):\n${errSnippet}`
          : `⚠️ iFlow 进程异常退出 (exit ${code})，无详细错误信息。\n请检查 iFlow CLI 是否正确安装，或尝试重新发送消息。`
        const errMsg = {
          id: uuidv4(),
          sessionId,
          role: 'system' as const,
          content,
          timestamp: new Date().toISOString(),
        }
        s.adapter.messages.push(errMsg)
        this.emit('conversation-message', sessionId, errMsg)
      }

      s.adapter.status = 'completed'
      this.emit('status-change', sessionId, 'completed')
      this.emitEvent(sessionId, {
        type: 'session_complete',
        sessionId,
        timestamp: new Date().toISOString(),
        data: { exitCode: code ?? 0 },
      })
      // 拒绝所有待决请求
      for (const [, p] of s.pendingRequests) {
        p.reject(new Error(`iFlow process exited with code ${code}`))
      }
      s.pendingRequests.clear()
    })

    proc.on('error', (err) => {
      const s = this.sessions.get(sessionId)
      if (!s) return
      console.error(`[IFlowAcpAdapter] Process error for ${sessionId}:`, err)
      s.adapter.status = 'error'
      this.emit('status-change', sessionId, 'error')
      this.emitEvent(sessionId, {
        type: 'error',
        sessionId,
        timestamp: new Date().toISOString(),
        data: {
          text: `iFlow 启动失败: ${err.message}\n请确认 iflow 已安装，或在 Provider 管理中将 command 配置为绝对路径。`,
        },
      })
      for (const [, p] of s.pendingRequests) {
        p.reject(err)
      }
      s.pendingRequests.clear()
    })

    this.emit('status-change', sessionId, 'starting')

    // ---- ACP 握手 ----
    try {
      // 1. initialize
      // clientCapabilities schema（从 iFlow bundle 逆向）：
      //   { fs: { readTextFile: boolean, writeTextFile: boolean } }
      // protocolVersion 是 number 类型
      const initResult = await this.rpc(sessionId, ACP_METHOD.initialize, {
        protocolVersion: 1,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
        },
      })

      // 2. authenticate（用第一个可用的 authMethod，iflow 会检测已登录状态）
      const authMethods: Array<{ id: string; name: string }> = initResult?.authMethods || []
      const methodId = authMethods[0]?.id ?? 'iflow'
      await this.rpc(sessionId, ACP_METHOD.authenticate, { methodId })

      // 3. session/new（恢复模式：传入之前的 iFlow sessionId）
      const resumeSessionId = this.pendingResumeIds.get(sessionId)
      if (resumeSessionId) this.pendingResumeIds.delete(sessionId)

      const sessionResult = await this.rpc(sessionId, ACP_METHOD.session_new, {
        cwd: config.workingDirectory,
        mcpServers: this.loadMcpServersForAcp(config),
        ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
        ...(config.systemPrompt ? { settings: { systemPrompt: config.systemPrompt } } : {}),
      })
      session.iflowSessionId = sessionResult?.sessionId

      session.adapter.status = 'waiting_input'
      session.adapter.providerSessionId = session.iflowSessionId
      this.emit('status-change', sessionId, 'waiting_input')

      // 4. 如果有初始 prompt，立即发送
      if (config.initialPrompt) {
        await this.sendMessage(sessionId, config.initialPrompt)
      }
    } catch (err: any) {
      console.error(`[IFlowAcpAdapter] Init failed for ${sessionId}:`, err)
      session.adapter.status = 'error'
      this.emit('status-change', sessionId, 'error')
      this.emitEvent(sessionId, {
        type: 'error',
        sessionId,
        timestamp: new Date().toISOString(),
        data: { text: `iFlow initialization failed: ${err.message}` },
      })
    }
  }

  /**
   * 读取 MCP 配置文件并转换为 ACP session/new 所需的数组格式。
   *
   * Claude Code 的 MCP 配置格式（JSON）：
   *   { "mcpServers": { "server-name": { "command": "...", "args": [...], "env": {} } } }
   *
   * iFlow ACP session/new 的 mcpServers 格式（数组）：
   *   [{ "name": "server-name", "command": "...", "args": [...], "env": {} }]
   *
   * 两者结构一致，只是外层从 Record 改成 Array。
   */
  private loadMcpServersForAcp(config: AdapterSessionConfig): any[] {
    if (!config.mcpConfigPath) return []

    try {
      const raw = fs.readFileSync(config.mcpConfigPath, 'utf-8')
      const parsed = JSON.parse(raw)
      const mcpServers: Record<string, any> = parsed.mcpServers || {}
      // 将 Record 格式转换为 ACP 期望的数组格式
      // ★ iFlow v24 ACP 协议要求 env 为 [{name, value}] 数组
      // 而 MCP 标准配置（Claude Code 格式）中 env 是 Record<string,string> 对象
      // 需要在此转换，否则 iFlow Zod 校验报 "Expected array, received object"
      return Object.entries(mcpServers).map(([name, cfg]) => {
        const server: any = { name, ...cfg }
        if (cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)) {
          server.env = Object.entries(cfg.env as Record<string, string>)
            .map(([k, v]) => ({ name: k, value: v }))
        }
        return server
      })
    } catch (err) {
      console.warn(`[IFlowAcpAdapter] Failed to load MCP config from ${config.mcpConfigPath}:`, err)
      return []
    }
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)
    if (!session.iflowSessionId) throw new Error(`iFlow session not initialized for ${sessionId}`)

    // 记录用户消息
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
    session.currentText = ''
    this.emit('status-change', sessionId, 'running')

    // session/prompt 是一个 RPC 请求，完成后代表本轮结束
    // prompt 字段是 pDe 内容对象数组（从 iFlow bundle 逆向）：
    //   { type: "text", text: string } | { type: "image", ... } | ...
    // 不能直接传 message: string，否则 Zod 校验会报 Invalid params
    try {
      await this.rpc(sessionId, ACP_METHOD.session_prompt, {
        sessionId: session.iflowSessionId,
        prompt: [{ type: 'text', text: message }],
      })

      // 保存完整的 assistant 消息
      const fullText = session.currentText.trim()
      if (fullText) {
        const assistantMsg: ConversationMessage = {
          id: uuidv4(),
          sessionId,
          role: 'assistant',
          content: fullText,
          timestamp: new Date().toISOString(),
        }
        session.adapter.messages.push(assistantMsg)
        this.emit('conversation-message', sessionId, assistantMsg)
      }

      // 轮次结束
      this.emitEvent(sessionId, {
        type: 'turn_complete',
        sessionId,
        timestamp: new Date().toISOString(),
        data: { usage: session.adapter.totalUsage },
      })
      session.adapter.status = 'waiting_input'
      this.emit('status-change', sessionId, 'waiting_input')
    } catch (err: any) {
      console.error(`[IFlowAcpAdapter] Prompt failed for ${sessionId}:`, err)
      this.emitEvent(sessionId, {
        type: 'error',
        sessionId,
        timestamp: new Date().toISOString(),
        data: { text: err.message },
      })
    }
  }

  async sendConfirmation(sessionId: string, accept: boolean): Promise<void> {
    // iFlow ACP 权限确认：server 发出一个带 id 的 request_permission 请求
    // SpectrAI 需要回复对应的 JSON-RPC 响应
    // 这里的实现：把待决的权限请求 ID 存起来，收到 accept/reject 后回复
    const session = this.sessions.get(sessionId)
    if (!session) return
    const permId = session.pendingPermissionId
    if (permId == null) return
    session.pendingPermissionId = undefined

    const response = {
      jsonrpc: '2.0',
      id: permId,
      result: { allow: accept ? 'allow_once' : 'deny' },
    }
    this.writeLine(sessionId, JSON.stringify(response))
  }

  async abortCurrentTurn(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.iflowSessionId) return
    try {
      await this.rpc(sessionId, ACP_METHOD.session_cancel, {
        sessionId: session.iflowSessionId,
      })
    } catch (_) { /* ignore */ }
  }

  async terminateSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    for (const [, p] of session.pendingRequests) {
      p.reject(new Error('Session terminated'))
    }
    session.pendingRequests.clear()

    try { session.process.kill() } catch (_) { /* ignore */ }

    session.adapter.status = 'completed'
    this.emit('status-change', sessionId, 'completed')
    this.sessions.delete(sessionId)
  }

  async resumeSession(
    sessionId: string,
    providerSessionId: string,
    config: AdapterSessionConfig
  ): Promise<void> {
    // iFlow ACP 模式通过 session/new 传入之前的 sessionId 来恢复会话
    // 将 providerSessionId 暂存，startSession 中的 session/new 会读取并注入
    if (providerSessionId) {
      this.pendingResumeIds.set(sessionId, providerSessionId)
    }
    await this.startSession(sessionId, config)
  }

  getConversation(sessionId: string): ConversationMessage[] {
    return this.sessions.get(sessionId)?.adapter.messages || []
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  getProviderSessionId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.iflowSessionId
  }

  cleanup(): void {
    for (const [sid] of this.sessions) {
      try { this.terminateSession(sid) } catch (_) { /* ignore */ }
    }
    this.sessions.clear()
    this.pendingResumeIds.clear()
  }

  // ---- ACP NDJSON 行处理 ----

  private handleLine(sessionId: string, line: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || !line) return

    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      // 非 JSON 行（stderr 已被分离，stdout 应该是纯 ACP 消息，此处属于异常情况）
      // 记录前 120 字符便于排查格式异常
      console.debug(`[IFlowAcpAdapter][${sessionId}] skip non-JSON line: ${line.slice(0, 120)}`)
      return
    }

    // JSON-RPC 响应（有 id，有 result 或 error）
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = session.pendingRequests.get(msg.id)
      if (pending) {
        session.pendingRequests.delete(msg.id)
        if (msg.error) {
          pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        } else {
          pending.resolve(msg.result)
        }
      }
      return
    }

    // JSON-RPC 通知（有 method，无 id）或 Server→Client 请求（有 method，有 id）
    if (msg.method) {
      // server→client 请求（如 session/request_permission 需要 client 回复）
      if (msg.id !== undefined) {
        this.handleServerRequest(sessionId, msg.id, msg.method, msg.params || {})
      } else {
        this.handleNotification(sessionId, msg.method, msg.params || {})
      }
    }
  }

  /**
   * 处理 server→client 请求（iFlow 需要 SpectrAI 回复的请求）
   */
  private handleServerRequest(sessionId: string, reqId: number, method: string, params: any): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const ts = new Date().toISOString()

    switch (method) {
      case ACP_NOTIFICATION.session_request_permission: {
        // iFlow 请求权限确认，需要 SpectrAI 回复
        const description = params.permission?.description
          || params.description
          || params.message
          || 'iFlow requires approval for this action'
        const toolName = params.permission?.toolName || params.toolName || 'unknown'

        // 暂存请求 ID，等待 sendConfirmation 回复
        session.pendingPermissionId = reqId

        this.emitEvent(sessionId, {
          type: 'permission_request',
          sessionId,
          timestamp: ts,
          data: {
            permissionPrompt: description,
            toolName,
            toolInput: params.permission?.input || {},
          },
        })
        break
      }

      case ACP_NOTIFICATION.ask_user_questions: {
        // iFlow 向用户提问，转为 permission_request
        const question = params.questions?.[0]?.text || params.question || 'iFlow has a question'
        session.pendingPermissionId = reqId
        this.emitEvent(sessionId, {
          type: 'permission_request',
          sessionId,
          timestamp: ts,
          data: {
            permissionPrompt: question,
            toolName: 'ask_user_questions',
          },
        })
        break
      }

      default: {
        // 未知的 server→client 请求，自动拒绝
        const autoReply = { jsonrpc: '2.0', id: reqId, result: {} }
        this.writeLine(sessionId, JSON.stringify(autoReply))
        break
      }
    }
  }

  /**
   * 处理 server→client 通知（无 id）
   */
  private handleNotification(sessionId: string, method: string, params: any): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const ts = new Date().toISOString()

    switch (method) {
      case ACP_NOTIFICATION.session_update: {
        const update = params.update || {}
        const updateType = update.sessionUpdate

        switch (updateType) {
          case SESSION_UPDATE_TYPE.agent_message_chunk: {
            // AI 流式文本块
            const text = update.content?.text || update.content || ''
            if (!text) break

            session.currentText += text

            // 发射增量消息
            const deltaMsg: ConversationMessage = {
              id: uuidv4(),
              sessionId,
              role: 'assistant',
              content: text,
              timestamp: ts,
              isDelta: true,
            }
            this.emit('conversation-message', sessionId, deltaMsg)
            this.emitEvent(sessionId, {
              type: 'text_delta',
              sessionId,
              timestamp: ts,
              data: { text },
            })
            break
          }

          case SESSION_UPDATE_TYPE.tool_call: {
            // 工具调用开始
            const toolName = update.toolName || 'unknown'
            const toolCallId = update.toolCallId || uuidv4()
            session.activeToolCalls.set(toolCallId, toolName)

            const toolInput: Record<string, unknown> = {}
            if (update.title) toolInput.title = update.title

            const toolMsg: ConversationMessage = {
              id: uuidv4(),
              sessionId,
              role: 'tool_use',
              content: `${toolName}: ${update.title || ''}`,
              timestamp: ts,
              toolName,
              toolInput,
            }
            session.adapter.messages.push(toolMsg)
            this.emit('conversation-message', sessionId, toolMsg)
            this.emitEvent(sessionId, {
              type: 'tool_use_start',
              sessionId,
              timestamp: ts,
              data: { toolName, toolInput, toolUseId: toolCallId },
            })
            break
          }

          case SESSION_UPDATE_TYPE.tool_call_update: {
            // 工具调用结果
            const toolCallId = update.toolCallId
            const toolName = update.toolName || session.activeToolCalls.get(toolCallId) || 'unknown'
            const status = update.status // 'in_progress' | 'completed' | 'failed'
            if (status !== 'completed' && status !== 'failed') break

            // 提取结果文本
            const resultContent = update.content || []
            const resultText = Array.isArray(resultContent)
              ? resultContent.map((c: any) => c?.content?.text || c?.text || '').join('\n')
              : String(resultContent)
            const isError = status === 'failed'

            const resultMsg: ConversationMessage = {
              id: uuidv4(),
              sessionId,
              role: 'tool_result',
              content: resultText.slice(0, 2000),
              timestamp: ts,
              toolResult: resultText,
              isError,
            }
            session.adapter.messages.push(resultMsg)
            this.emit('conversation-message', sessionId, resultMsg)
            this.emitEvent(sessionId, {
              type: 'tool_use_end',
              sessionId,
              timestamp: ts,
              data: { toolResult: resultText, isError, toolUseId: toolCallId, toolName },
            })

            if (status === 'completed' || status === 'failed') {
              session.activeToolCalls.delete(toolCallId)
            }
            break
          }

          default: {
            // 其他 sessionUpdate 类型，如果有 content.text 则作为文本处理
            const text = update.content?.text || update.text || ''
            if (text) {
              session.currentText += text
              this.emitEvent(sessionId, {
                type: 'text_delta',
                sessionId,
                timestamp: ts,
                data: { text },
              })
            }
            break
          }
        }
        break
      }

      default:
        // 未知通知，忽略
        break
    }
  }

  // ---- JSON-RPC over stdio ----

  /**
   * 发送 JSON-RPC 请求并等待响应
   */
  private rpc(sessionId: string, method: string, params?: Record<string, unknown>): Promise<any> {
    const session = this.sessions.get(sessionId)
    if (!session) return Promise.reject(new Error(`Session ${sessionId} not found`))

    const id = ++session.requestId
    const req = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })

    return new Promise((resolve, reject) => {
      session.pendingRequests.set(id, { resolve, reject })
      this.writeLine(sessionId, req)

      // 超时（长耗时操作如 session/prompt 设 10 分钟；握手类设 30 秒）
      const isPrompt = method === ACP_METHOD.session_prompt
      const timeoutMs = isPrompt ? 10 * 60 * 1000 : 30_000
      const timer = setTimeout(() => {
        if (session.pendingRequests.has(id)) {
          session.pendingRequests.delete(id)
          reject(new Error(`ACP RPC timeout (${timeoutMs / 1000}s): ${method}`))
        }
      }, timeoutMs)

      // 如果 resolve/reject 先调用，清除 timer（通过装饰 pendingRequests）
      const original = session.pendingRequests.get(id)!
      session.pendingRequests.set(id, {
        resolve: (v) => { clearTimeout(timer); original.resolve(v) },
        reject:  (e) => { clearTimeout(timer); original.reject(e) },
      })
    })
  }

  private writeLine(sessionId: string, line: string): void {
    const session = this.sessions.get(sessionId)
    if (!session?.process.stdin?.writable) return
    session.process.stdin.write(line + '\n', 'utf8')
  }

  private emitEvent(sessionId: string, event: ProviderEvent): void {
    this.emit('event', event)
  }
}
