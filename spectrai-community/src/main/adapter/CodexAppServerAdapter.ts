/**
 * Codex CLI App Server Adapter
 *
 * 通过 JSON-RPC over stdio 协议与 Codex CLI 的 app-server 模式交互。
 * 协议流程: initialize → initialized → thread/start → turn/start → events → turn/end
 *
 * @author weibin
 */

import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import { createInterface, type Interface as ReadlineInterface } from 'readline'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { ConversationMessage } from '../../shared/types'
import {
  BaseProviderAdapter,
  type AdapterSessionConfig,
  type AdapterSession,
  type ProviderEvent,
} from './types'
import { extractToolDetail } from './toolMapping'
import { prependNodeVersionToEnvPath } from '../node/NodeVersionResolver'

function isExecutable(filePath: string): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) return false
    if (process.platform === 'win32') return true
    fs.accessSync(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function preferredCodexBinDirs(): string[] {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64'
  if (process.platform === 'win32') return [`windows-${arch}`]
  if (process.platform === 'darwin') return [`darwin-${arch}`]
  if (process.platform === 'linux') return [`linux-${arch}`, `linux-${process.arch}`]
  return []
}

function scanCodexBinaryInBinDir(binDir: string): string | null {
  const names = process.platform === 'win32' ? ['codex.exe', 'codex'] : ['codex', 'codex.exe']
  for (const subDir of preferredCodexBinDirs()) {
    for (const name of names) {
      const candidate = path.join(binDir, subDir, name)
      if (isExecutable(candidate)) return candidate
    }
  }

  // fallback: 在 bin 目录内递归搜索 codex/codex.exe
  const queue = [binDir]
  while (queue.length > 0) {
    const current = queue.shift()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        queue.push(full)
        continue
      }
      if (names.includes(entry.name) && isExecutable(full)) {
        return full
      }
    }
  }
  return null
}

/**
 * 在 Cursor/Trae 扩展目录中搜索 codex 可执行文件。
 * 找不到时回退到配置 command（支持 PATH 解析）。
 */
function findCodexExecutable(configCommand?: string): string {
  if (configCommand && path.isAbsolute(configCommand) && isExecutable(configCommand)) {
    return configCommand
  }

  const fallback = configCommand?.trim() || 'codex'
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir()
  const searchBases = [
    path.join(home, '.trae', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
  ]

  for (const base of searchBases) {
    try {
      if (!fs.existsSync(base)) continue
      const entries = fs.readdirSync(base, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (!entry.name.startsWith('openai.chatgpt-')) continue
        const binDir = path.join(base, entry.name, 'bin')
        if (!fs.existsSync(binDir)) continue
        const resolved = scanCodexBinaryInBinDir(binDir)
        if (resolved) return resolved
      }
    } catch {
      // ignore and continue scanning other bases
    }
  }

  // Windows 下 npm 全局安装的 codex 是 .cmd 包装器，不在 Cursor/Trae 扩展目录中
  // 需要额外搜索 npm 全局 bin 目录（%APPDATA%\npm）
  if (process.platform === 'win32') {
    const npmGlobalDirs: string[] = [
      path.join(home, 'AppData', 'Roaming', 'npm'),
    ]

    // nvm4w 设置的 NVM_SYMLINK 环境变量指向当前激活的 Node.js 目录
    // 该目录同时也是 npm 全局 bin 目录（npm prefix -g 返回此路径）
    const nvmSymlink = process.env.NVM_SYMLINK
    if (nvmSymlink && !npmGlobalDirs.includes(nvmSymlink)) {
      npmGlobalDirs.push(nvmSymlink)
    }

    // 也尝试通过 NPM_PREFIX 环境变量（用户自定义场景）
    const npmPrefixEnv = process.env.NPM_PREFIX
    if (npmPrefixEnv && !npmGlobalDirs.includes(npmPrefixEnv)) {
      npmGlobalDirs.push(npmPrefixEnv)
    }

    // 动态执行 npm prefix -g 获取真实的全局安装路径
    // 适用于 nvm / volta / fnm 等 Node 版本管理工具
    try {
      const { execFileSync } = require('child_process') as typeof import('child_process')
      const result = execFileSync('npm', ['prefix', '-g'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      }).trim()
      if (result && !npmGlobalDirs.includes(result)) {
        npmGlobalDirs.push(result)
      }
    } catch {
      // npm 不在 PATH 或执行失败，跳过动态查找
    }

    for (const dir of npmGlobalDirs) {
      for (const name of ['codex.cmd', 'codex.exe', 'codex']) {
        const candidate = path.join(dir, name)
        if (isExecutable(candidate)) return candidate
      }
    }
  }

  // 最终回退：使用 where(Windows) / which(Unix) 获取系统 PATH 中的实际路径
  // 解决 codex 安装在非标准目录（如 .covs/node/...）但已加入 PATH 的场景
  try {
    const checker = process.platform === 'win32' ? 'where' : 'which'
    const resolved = execFileSync(checker, [fallback], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    }).trim()
    // where 可能返回多行（多个匹配路径），如：
    //   C:\Users\xxx\.covs\node\node-v24.12.0-win-x64\codex.cmd
    //   C:\Users\xxx\.covs\node\node-v24.12.0-win-x64\codex
    // 无扩展名的文件（npm shim 脚本）无法被 spawn 直接执行（ENOENT），
    // 必须优先选择 .cmd/.exe 后缀的路径
    const lines = resolved.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    if (process.platform === 'win32') {
      // 优先选 .cmd → .exe → 其他
      const cmdLine = lines.find(l => /\.cmd$/i.test(l))
      const exeLine = lines.find(l => /\.exe$/i.test(l))
      const preferred = cmdLine || exeLine || lines[0]
      if (preferred && fs.existsSync(preferred)) {
        return preferred
      }
    } else {
      const firstLine = lines[0]
      if (firstLine && fs.existsSync(firstLine)) {
        return firstLine
      }
    }
  } catch {
    // where/which 未找到，使用原始 fallback
  }

  return fallback
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface CodexSession {
  adapter: AdapterSession
  process: ChildProcess
  readline: ReadlineInterface
  threadId?: string
  requestId: number
  pendingRequests: Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>
  autoAccept: boolean
  /** 已发出 tool_use 消息的工具 ID 集合，用于 created/completed 去重 */
  activeToolUseIds: Set<string>
  /** 待处理的 commandExecution 审批 itemId（非 autoAccept 模式下用于 sendConfirmation） */
  pendingApprovalItemId?: string
  /** 最近一次收到 app-server 任意 JSON 事件/响应的时间 */
  lastServerEventAt: number
  /** 当前 turn 已推送过的心跳提示次数（用于限频） */
  turnHeartbeatHints: number
  /**
   * agentMessage delta 文本缓存。
   * Codex extended reasoning 模式下，item/completed 的 item.text 可能为空，
   * 真正的文本全在前面的 item/agentMessage/delta 事件里。
   * 用此字段在主进程侧积累，item/completed 时作为兜底内容。
   */
  agentMessageBuffer: string
}

export class CodexAppServerAdapter extends BaseProviderAdapter {
  readonly providerId = 'codex'
  readonly displayName = 'Codex CLI'

  private sessions: Map<string, CodexSession> = new Map()
  /** 心跳定时器：长时间无响应时向对话推静默提示 */
  private heartbeatTimers: Map<string, ReturnType<typeof setInterval>> = new Map()
  /** 每次 turn 开始时记录时间，心跳用于计算等待时长 */
  private turnStartTimes: Map<string, number> = new Map()

  async startSession(sessionId: string, config: AdapterSessionConfig): Promise<void> {
    const startTime = Date.now()
    // 启动 codex app-server 进程
    // Windows 下 codex 通常捆绑在 Cursor/Trae 扩展目录中，不在全局 PATH 里
    // 使用 findCodexExecutable() 搜索绝对路径；
    // 若找到的是 .cmd 包装器（npm 全局安装场景），需要 shell:true 才能正常执行
    const codexCommand = findCodexExecutable(config.command)
    const env = prependNodeVersionToEnvPath(
      { ...process.env, ...config.envOverrides },
      config.nodeVersion
    )
    // Windows 下非 .exe 文件（.cmd 包装器、无扩展名的 npm shim 脚本等）
    // 必须通过 shell 执行，否则 Node.js spawn 会报 ENOENT
    const useShell = process.platform === 'win32' && !codexCommand.endsWith('.exe')

    console.log(`[CodexAdapter] Starting session ${sessionId}:`)
    console.log(`[CodexAdapter]   command: ${codexCommand}`)
    console.log(`[CodexAdapter]   shell: ${useShell}`)
    console.log(`[CodexAdapter]   cwd: ${config.workingDirectory}`)
    console.log(`[CodexAdapter]   model: ${config.model || '(default)'}`)
    console.log(`[CodexAdapter]   CODEX_HOME: ${env.CODEX_HOME || '(not set)'}`)
    console.log(`[CodexAdapter]   configCommand: ${config.command || '(not set)'}`)

    // ── 前置检测：codex 命令是否真实存在 ──
    // findCodexExecutable 在搜索所有已知路径后找不到时会 fallback 到裸命令名（如 "codex"），
    // 此时 spawn 会报 ENOENT，后续 rpc 写 stdin 又会报 EPIPE，日志难以排查。
    // 提前检测并给出清晰的安装指引，避免级联错误。
    if (!path.isAbsolute(codexCommand)) {
      // 非绝对路径 → findCodexExecutable 没有找到本地二进制，需要验证 PATH 中是否存在
      const checker = process.platform === 'win32' ? 'where' : 'which'
      let foundInPath = false
      try {
        execFileSync(checker, [codexCommand], { timeout: 5000, windowsHide: true, env })
        foundInPath = true
      } catch {
        // not found in PATH
      }
      if (!foundInPath) {
        const installHint = process.platform === 'win32'
          ? '请通过以下方式之一安装 Codex CLI:\n' +
            '  1. npm install -g @openai/codex\n' +
            '  2. 安装 Cursor 或 Trae 编辑器（内置 Codex）\n' +
            '  3. 在 Provider 管理中将 command 配置为 codex 可执行文件的绝对路径'
          : '请通过以下方式之一安装 Codex CLI:\n' +
            '  1. npm install -g @openai/codex\n' +
            '  2. 在 Provider 管理中将 command 配置为 codex 可执行文件的绝对路径'
        const errMessage = `Codex CLI 未安装或不在 PATH 中（查找命令: ${codexCommand}）。\n${installHint}`
        console.error(`[CodexAdapter] ${errMessage}`)
        this.emitEvent(sessionId, {
          type: 'error',
          sessionId,
          timestamp: new Date().toISOString(),
          data: { text: errMessage },
        })
        throw new Error(errMessage)
      }
    } else if (!isExecutable(codexCommand)) {
      // 绝对路径但文件不存在或不可执行
      const errMessage = `Codex CLI 路径无效: ${codexCommand}\n该文件不存在或无执行权限。请在 Provider 管理中检查 command 配置。`
      console.error(`[CodexAdapter] ${errMessage}`)
      this.emitEvent(sessionId, {
        type: 'error',
        sessionId,
        timestamp: new Date().toISOString(),
        data: { text: errMessage },
      })
      throw new Error(errMessage)
    }

    const proc = spawn(codexCommand, ['app-server'], {
      cwd: config.workingDirectory,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      shell: useShell,
    })
    console.log(`[CodexAdapter] Process spawned for ${sessionId}, pid=${proc.pid}`)

    const rl = createInterface({ input: proc.stdout! })

    const session: CodexSession = {
      adapter: {
        sessionId,
        status: 'running',
        messages: [],
        createdAt: new Date().toISOString(),
        totalUsage: { inputTokens: 0, outputTokens: 0 },
      },
      process: proc,
      readline: rl,
      requestId: 0,
      pendingRequests: new Map(),
      autoAccept: config.autoAccept ?? false,
      activeToolUseIds: new Set(),
      lastServerEventAt: Date.now(),
      turnHeartbeatHints: 0,
      agentMessageBuffer: '',
    }

    this.sessions.set(sessionId, session)

    // 监听 NDJSON 行
    rl.on('line', (line) => {
      this.handleLine(sessionId, line)
    })

    // 消费 stderr（防止管道缓冲区阻塞；将关键错误信息推送到对话视图方便排查）
    let stderrBuffer = ''
    proc.stderr?.on('data', (data) => {
      const text: string = data.toString()
      if (!text.trim()) return
      console.debug(`[CodexAdapter] stderr for ${sessionId}: ${text.slice(0, 300)}`)
      stderrBuffer += text
      // 超过 2KB 截断，只保留最新内容
      if (stderrBuffer.length > 2048) stderrBuffer = stderrBuffer.slice(-2048)
    })

    // 进程退出时，若异常退出（code !== 0），将错误信息推送到对话视图
    // 有 stderr 内容则展示，否则给出通用提示，确保用户不会看到空白
    proc.once('exit', (code) => {
      if (code !== 0) {
        const errSnippet = stderrBuffer.trim().slice(0, 800)
        const content = errSnippet
          ? `⚠️ Codex 异常退出 (exit ${code}):\n${errSnippet}`
          : `⚠️ Codex 异常退出 (exit ${code})，无详细错误信息。\n请检查 Codex CLI 是否正确安装，或尝试重新发送消息。`
        const errMsg = {
          id: uuidv4(),
          sessionId,
          role: 'system' as const,
          content,
          timestamp: new Date().toISOString(),
        }
        session.adapter.messages.push(errMsg)
        this.emit('conversation-message', sessionId, errMsg)
      }
    })

    // 进程退出
    proc.on('exit', (code) => {
      this.stopHeartbeat(sessionId)
      session.adapter.status = 'completed'
      this.emit('status-change', sessionId, 'completed')
      this.emitEvent(sessionId, {
        type: 'session_complete',
        sessionId,
        timestamp: new Date().toISOString(),
        data: { exitCode: code ?? 0 },
      })
    })

    proc.on('error', (err: NodeJS.ErrnoException) => {
      console.error(`[CodexAdapter] Process error for ${sessionId}:`, err)
      session.adapter.status = 'error'
      this.emit('status-change', sessionId, 'error')

      let text: string
      if (err.code === 'ENOENT') {
        text = `Codex CLI 未找到 (${codexCommand})。\n` +
          '请通过以下方式安装:\n' +
          '  1. npm install -g @openai/codex\n' +
          '  2. 安装 Cursor 或 Trae 编辑器（内置 Codex）\n' +
          '  3. 在 Provider 管理中将 command 配置为绝对路径'
      } else {
        text = `Codex 启动失败: ${err.message}\n请确认 codex 已安装，或在 Provider 管理中将 command 配置为绝对路径。`
      }

      this.emitEvent(sessionId, {
        type: 'error',
        sessionId,
        timestamp: new Date().toISOString(),
        data: { text },
      })
    })

    // JSON-RPC 初始化握手
    try {
      console.log(`[CodexAdapter] Sending initialize for ${sessionId} (+${Date.now() - startTime}ms)`)
      const initResult = await this.rpc(sessionId, 'initialize', {
        clientInfo: { name: 'spectrai', version: '2.0.0' },
      })
      console.log(`[CodexAdapter] initialize OK for ${sessionId} (+${Date.now() - startTime}ms):`, JSON.stringify(initResult).slice(0, 300))
      // ⚠️ 注意：Codex v0.98+ 不支持 initialized 通知（会导致 serde untagged enum 错误）
      // 因此这里不发送 initialized 通知

      // 创建 Thread
      // 注意：model 由 adapterConfig.model 传入（来自 provider.defaultModel 或用户配置）
      // Codex CLI 支持的模型：codex-mini-latest, o4-mini 等；不传则由 codex 使用其默认模型
      console.log(`[CodexAdapter] Sending thread/start for ${sessionId} (+${Date.now() - startTime}ms)`)
      const threadResult = await this.rpc(sessionId, 'thread/start', {
        ...(config.model ? { model: config.model } : {}),
        cwd: config.workingDirectory,
        // Supervisor 模式下注入系统指令（来自 SessionManagerV2.getSupervisorPrompt）
        ...(config.systemPrompt ? { baseInstructions: config.systemPrompt } : {}),
        // 有效值：'untrusted' | 'on-failure' | 'on-request' | 'never'
        // autoAccept=true  → 'never'：Codex 直接执行所有操作，完全不发 requestApproval 事件
        //   ⚠️ 注意：'on-failure' 文档说失败时才问，但实测仍会发 requestApproval，
        //            且 approval/respond RPC 在部分版本中不存在，会导致 turn 永久阻塞。
        //            改用 'never' 彻底避免审批请求。
        // autoAccept=false → 'on-request'：每次写文件/执行命令前发 requestApproval，前端弹窗确认
        approvalPolicy: config.autoAccept ? 'never' : 'on-request',
        // ⚠️ 沙箱策略：必须显式传入，否则 Codex 默认用 read-only 沙箱，
        // 导致 git pull/fetch、npm install 等网络命令及写操作全部被拦截。
        // 字段名是 sandbox（非 sandboxPolicy），值为字符串枚举：
        //   'workspace-write'   — 可读写工作目录，无网络（默认）
        //   'danger-full-access' — 完全放开（文件系统 + 网络），适合本地开发工具
        sandbox: 'danger-full-access',
      })
      console.log(`[CodexAdapter] thread/start OK for ${sessionId} (+${Date.now() - startTime}ms):`, JSON.stringify(threadResult).slice(0, 300))
      // 兼容不同 app-server 返回结构，确保 threadId 可用后再允许 turn/start
      const threadId = (threadResult as any)?.thread?.id || (threadResult as any)?.id
      if (!threadId) {
        throw new Error('Codex thread/start did not return thread id')
      }
      session.threadId = threadId
      console.log(`[CodexAdapter] Session ${sessionId} ready, threadId=${threadId}, total startup: ${Date.now() - startTime}ms`)

      // 发送首轮消息
      if (config.initialPrompt) {
        console.log(`[CodexAdapter] Sending initial prompt for ${sessionId} (${config.initialPrompt.length} chars)`)
        await this.sendMessage(sessionId, config.initialPrompt)
      } else {
        session.adapter.status = 'waiting_input'
        this.emit('status-change', sessionId, 'waiting_input')
      }
    } catch (err: any) {
      console.error(`[CodexAdapter] Init failed for ${sessionId} (+${Date.now() - startTime}ms):`, err)
      session.adapter.status = 'error'
      this.emit('status-change', sessionId, 'error')

      // EPIPE 通常是 ENOENT 的连锁反应（进程没启动，写 stdin 失败）
      const isEpipe = err.code === 'EPIPE' || err.message?.includes('EPIPE')
      const text = isEpipe
        ? `Codex 进程未能启动（写入管道失败）。\n请确认 Codex CLI 已正确安装，或在 Provider 管理中配置 command 为绝对路径。`
        : `Initialization failed: ${err.message}`

      this.emitEvent(sessionId, {
        type: 'error',
        sessionId,
        timestamp: new Date().toISOString(),
        data: { text },
      })
    }
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)
    if (!session.threadId) {
      throw new Error(`Session ${sessionId} is not ready: missing threadId`)
    }

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
    this.emit('status-change', sessionId, 'running')
    session.lastServerEventAt = Date.now()
    session.turnHeartbeatHints = 0

    // 启动心跳：每 30 秒检查是否仍在等待，若是则推一条静默进度提示
    this.startHeartbeat(sessionId)

    // 发送 turn
    // 实际格式：input 数组，type='text'（非 userMessage 字段）
    try {
      console.log(`[CodexAdapter] Sending turn/start for ${sessionId}, threadId=${session.threadId}, msgLen=${message.length}`)
      const turnResult = await this.rpc(sessionId, 'turn/start', {
        threadId: session.threadId,
        input: [{ type: 'text', text: message }],
      })
      console.log(`[CodexAdapter] turn/start OK for ${sessionId}:`, JSON.stringify(turnResult).slice(0, 200))
      // turn/start 立即返回 {turn: {status:'inProgress'}}，流式事件异步推送
    } catch (err: any) {
      this.stopHeartbeat(sessionId)
      console.error(`[CodexAdapter] Turn failed for ${sessionId}:`, err)
      this.emitEvent(sessionId, {
        type: 'error',
        sessionId,
        timestamp: new Date().toISOString(),
        data: { text: err.message },
      })
      // 失败时必须退出 running，否则前端会永久显示“处理中”
      session.adapter.status = 'waiting_input'
      this.emit('status-change', sessionId, 'waiting_input')
    }
  }

  async sendConfirmation(sessionId: string, accept: boolean): Promise<void> {
    const session = this.sessions.get(sessionId)
    // 取出并清除待处理 itemId（一次性消费）
    const itemId = session?.pendingApprovalItemId
    if (session) delete session.pendingApprovalItemId

    try {
      await this.rpc(sessionId, 'approval/respond', {
        ...(itemId ? { itemId } : {}),
        approved: accept,
      })
    } catch (err: any) {
      console.warn(`[CodexAdapter] Confirmation failed for ${sessionId}:`, err)
    }
  }

  async abortCurrentTurn(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    // ⚠️ Codex app-server 的 JsonRpcMessage 枚举只有 Request（带 id）和 Response 两种变体，
    // 不接受不带 id 的 Notification（notify 调用会导致 serde untagged enum 反序列化失败）。
    // 目前无可用的取消 RPC，只做 UI 状态强制切换，让按钮消失、输入框恢复可用。
    // Codex 底层会继续跑完当前轮次，turn/completed 事件到达时状态更新是幂等的，不影响正确性。
    const ts = new Date().toISOString()
    session.adapter.status = 'waiting_input'
    this.emit('status-change', sessionId, 'waiting_input')
    this.emitEvent(sessionId, {
      type: 'turn_complete',
      sessionId,
      timestamp: ts,
      data: { usage: session.adapter.totalUsage },
    })
  }

  async terminateSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.adapter.status = 'completed'
    this.emit('status-change', sessionId, 'completed')

    // 清理 pending requests
    for (const [, pending] of session.pendingRequests) {
      pending.reject(new Error('Session terminated'))
    }
    session.pendingRequests.clear()

    // 关闭进程
    this.stopHeartbeat(sessionId)
    try {
      session.readline.close()
      session.process.kill()
    } catch (_) { /* ignore */ }

    this.sessions.delete(sessionId)
  }

  async resumeSession(
    sessionId: string,
    providerSessionId: string,
    config: AdapterSessionConfig
  ): Promise<void> {
    // Codex 暂不支持会话恢复，创建新会话
    await this.startSession(sessionId, config)
  }

  getConversation(sessionId: string): ConversationMessage[] {
    return this.sessions.get(sessionId)?.adapter.messages || []
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  getProviderSessionId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.threadId
  }

  cleanup(): void {
    for (const [sessionId] of this.sessions) {
      try {
        this.terminateSession(sessionId)
      } catch (_) { /* ignore */ }
    }
    this.sessions.clear()
  }

  // ---- 公共去重方法 ----

  /**
   * 统一 turn 结束处理（turn/completed、codex/event/task_complete、裸事件 event_msg.task_complete 共用）。
   *
   * 职责：flush agentMessageBuffer → 清理 activeToolUseIds → 停止心跳 → 发射 turn_complete → 切换状态
   */
  private finalizeTurn(sessionId: string, session: CodexSession, ts: string): void {
    // 若 buffer 还有未提交的文本，立即作为 assistant 消息提交
    if (session.agentMessageBuffer) {
      const fallbackMsg = {
        id: uuidv4(),
        sessionId,
        role: 'assistant' as const,
        content: session.agentMessageBuffer,
        timestamp: ts,
      }
      session.adapter.messages.push(fallbackMsg)
      this.emit('conversation-message', sessionId, fallbackMsg)
    }
    session.agentMessageBuffer = ''
    session.activeToolUseIds.clear()
    session.turnHeartbeatHints = 0
    this.stopHeartbeat(sessionId)
    this.emitEvent(sessionId, {
      type: 'turn_complete',
      sessionId,
      timestamp: ts,
      data: { usage: session.adapter.totalUsage },
    })
    session.adapter.status = 'waiting_input'
    this.emit('status-change', sessionId, 'waiting_input')
  }

  /**
   * 统一审批请求处理（通用 requestApproval、item/commandExecution/requestApproval、
   * 旧版 approval/request 共用）。
   *
   * autoAccept → RPC 自动批准（失败可忽略）
   * 非 autoAccept → 存储 itemId 并发射 permission_request 事件等待用户确认
   */
  private handleApprovalRequest(
    sessionId: string,
    session: CodexSession,
    ts: string,
    opts: { itemId: string; prompt: string; toolName: string; toolInput: Record<string, unknown> },
  ): void {
    if (session.autoAccept) {
      this.rpc(sessionId, 'approval/respond', {
        ...(opts.itemId ? { itemId: opts.itemId } : {}),
        approved: true,
      }).catch(err => {
        console.debug(`[CodexAdapter][${sessionId}] approval/respond not supported (ignored): ${err.message}`)
      })
    } else {
      if (opts.itemId) session.pendingApprovalItemId = opts.itemId
      this.emitEvent(sessionId, {
        type: 'permission_request',
        sessionId,
        timestamp: ts,
        data: {
          permissionPrompt: opts.prompt,
          toolName: opts.toolName,
          toolInput: opts.toolInput,
        },
      })
    }
  }

  // ---- 心跳机制 ----

  /**
   * 启动运行心跳：每 30 秒检查是否仍在等待。
   * 若 AI 超过 60 秒无任何工具调用或文本输出，推一条静默进度消息，
   * 让用户知道 AI 还在运行而非卡死。
   */
  private startHeartbeat(sessionId: string): void {
    this.stopHeartbeat(sessionId) // 先清理旧定时器
    const startAt = Date.now()
    this.turnStartTimes.set(sessionId, startAt)

    const timer = setInterval(() => {
      const session = this.sessions.get(sessionId)
      if (!session || session.adapter.status !== 'running') {
        this.stopHeartbeat(sessionId)
        return
      }

      const now = Date.now()
      const elapsed = Math.round((now - (this.turnStartTimes.get(sessionId) || now)) / 1000)
      const silentSeconds = Math.round((now - (session.lastServerEventAt || startAt)) / 1000)

      // watchdog: 长时间未收到服务端事件时，自动把状态收敛到 waiting_input，避免 UI 假性卡死
      // 若有 MCP 工具调用正在进行（activeToolUseIds 非空），缩短超时到 90s 并给出明确提示
      const hasPendingTool = session.activeToolUseIds.size > 0
      const watchdogSeconds = hasPendingTool ? 90 : 240
      if (silentSeconds >= watchdogSeconds) {
        this.stopHeartbeat(sessionId)
        session.adapter.status = 'waiting_input'
        this.emit('status-change', sessionId, 'waiting_input')
        const pendingTools = Array.from(session.activeToolUseIds).join(', ')
        const hint = hasPendingTool
          ? `MCP/工具调用超过 ${silentSeconds}s 未响应（工具 ID: ${pendingTools || '未知'}）。\n` +
            `请检查：① MCP 服务是否需要填写数据库连接字符串等配置（MCP 设置页 → ⚙ 按钮）\n` +
            `② MCP 程序路径是否正确、能否独立运行`
          : `Codex ${silentSeconds}s 无事件响应，当前轮次可能已中断。`
        this.emitEvent(sessionId, {
          type: 'error',
          sessionId,
          timestamp: new Date().toISOString(),
          data: { text: hint },
        })
        session.activeToolUseIds.clear()
        return
      }

      // 仅在持续静默 >= 60s 后提示，并限频到约每 60s 一条，减少消息污染
      if (silentSeconds < 60) return
      session.turnHeartbeatHints += 1
      if (session.turnHeartbeatHints % 2 === 0) return

      const minutes = Math.floor(elapsed / 60)
      const seconds = elapsed % 60
      const timeStr = minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`

      const heartbeatMsg = {
        id: uuidv4(),
        sessionId,
        role: 'system' as const,
        content: `⏳ Codex 仍在处理中... (已等待 ${timeStr}, 静默 ${silentSeconds}s)`,
        timestamp: new Date().toISOString(),
      }
      session.adapter.messages.push(heartbeatMsg)
      this.emit('conversation-message', sessionId, heartbeatMsg)
    }, 30_000)

    this.heartbeatTimers.set(sessionId, timer)
  }

  /** 停止并清理心跳定时器 */
  private stopHeartbeat(sessionId: string): void {
    const timer = this.heartbeatTimers.get(sessionId)
    if (timer) {
      clearInterval(timer)
      this.heartbeatTimers.delete(sessionId)
    }
    this.turnStartTimes.delete(sessionId)
  }

  // ---- JSON-RPC 通信 ----

  /**
   * 发送 JSON-RPC 请求并等待响应
   */
  private rpc(sessionId: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

    const id = ++session.requestId
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    }

    return new Promise((resolve, reject) => {
      session.pendingRequests.set(id, { resolve, reject })

      const line = JSON.stringify(request) + '\n'
      session.process.stdin!.write(line, (err) => {
        if (err) {
          session.pendingRequests.delete(id)
          reject(err)
        }
      })

      // 超时
      setTimeout(() => {
        if (session.pendingRequests.has(id)) {
          session.pendingRequests.delete(id)
          reject(new Error(`RPC timeout: ${method}`))
        }
      }, 30000)
    })
  }

  /**
   * 发送 JSON-RPC 通知（无 id，不等待响应）
   */
  private notify(sessionId: string, method: string, params?: Record<string, unknown>): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params,
    }

    session.process.stdin!.write(JSON.stringify(request) + '\n')
  }

  /**
   * 处理来自 Codex app-server 的 NDJSON 行
   */
  private handleLine(sessionId: string, line: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    let data: any
    try {
      data = JSON.parse(line)
    } catch {
      // 非 JSON 行（进度信息、控制字符等），记录前 120 字符便于排查
      console.debug(`[CodexAdapter][${sessionId}] skip non-JSON line: ${line.slice(0, 120)}`)
      return
    }

    // 任意有效 JSON 都视为“服务端仍有响应”，用于心跳 watchdog 计算
    session.lastServerEventAt = Date.now()

    // JSON-RPC 响应（有 id）
    if (data.id !== undefined && (data.result !== undefined || data.error !== undefined)) {
      const pending = session.pendingRequests.get(data.id)
      if (pending) {
        session.pendingRequests.delete(data.id)
        if (data.error) {
          pending.reject(new Error(data.error.message || JSON.stringify(data.error)))
        } else {
          pending.resolve(data.result)
        }
      }
      return
    }

    // JSON-RPC 通知（无 id）— 事件流
    if (data.method) {
      this.handleNotification(sessionId, data.method, data.params || {})
      return
    }

    // 裸事件（非标准 JSON-RPC，一些 app-server 版本可能使用）
    if (data.type) {
      this.handleCodexItem(sessionId, data)
    }
  }

  // ── Notification Handler Map ──────────────────────────────────
  // 将 handleNotification 的 switch 分支拆为独立子方法，通过 Record 分派。
  // key = JSON-RPC method，value = handler(sid, session, ts, params)

  private readonly notificationHandlers: Record<
    string,
    (sid: string, s: CodexSession, ts: string, p: any) => void
  > = {
    'item/agentMessage/delta': (sid, s, ts, p) => this.onAgentMessageDelta(sid, s, ts, p),
    'item/reasoning/summaryTextDelta': (sid, _s, ts, p) => this.onReasoningDelta(sid, ts, p),
    'item/reasoning/summaryPartAdded': () => {},
    'item/reasoning/summaryPartCompleted': () => {},
    'item/reasoning/created': () => {},
    'item/reasoning/completed': () => {},
    'item/started': (sid, s, ts, p) => this.onItemStarted(sid, s, ts, p),
    'item/completed': (sid, s, ts, p) => this.onItemCompleted(sid, s, ts, p),
    'item/commandExecution/requestApproval': (sid, s, ts, p) => {
      const command: string = p.command || ''
      this.handleApprovalRequest(sid, s, ts, {
        itemId: String(p.itemId || ''), prompt: `执行命令需要授权:\n${command.slice(0, 300)}`,
        toolName: 'commandExecution', toolInput: { command },
      })
    },
    'turn/completed': (sid, s, ts) => this.finalizeTurn(sid, s, ts),
    'thread/tokenUsage/updated': (_sid, s, _ts, p) => {
      const total = p.tokenUsage?.total
      if (total) {
        s.adapter.totalUsage.inputTokens  = total.inputTokens  || 0
        s.adapter.totalUsage.outputTokens = total.outputTokens || 0
      }
    },
    'approval/request': (sid, s, ts, p) => {
      this.handleApprovalRequest(sid, s, ts, {
        itemId: String(p.itemId || ''), prompt: p.description || 'Codex requires approval',
        toolName: p.tool || 'unknown', toolInput: p.input || {},
      })
    },
    'codex/event/error': (sid, s, ts, p) => this.onCodexError(sid, s, ts, p),
    'codex/event/stream_error': (sid, s, ts, p) => this.onCodexStreamError(sid, s, ts, p),
    'codex/event/task_complete': (sid, s, ts, p) => {
      const msg = p.msg || p
      console.log(`[CodexAdapter][${sid}] codex/event/task_complete, turnId=${msg.turn_id || ''}`)
      this.finalizeTurn(sid, s, ts)
    },
    'codex/event/task_started': () => {},
    'codex/event/mcp_startup_update': (sid, _s, _ts, p) => {
      console.log(`[CodexAdapter][${sid}] MCP startup: ${p.server || p.serverId || ''} → ${p.status || ''}`)
    },
    'codex/event/mcp_startup_complete': (sid, _s, _ts, p) => {
      const ready: string[] = p.ready || []; const failed: string[] = p.failed || []
      console.log(`[CodexAdapter][${sid}] MCP startup complete: ready=[${ready.join(',')}], failed=[${failed.join(',')}]`)
      if (failed.length > 0) console.warn(`[CodexAdapter][${sid}] MCP servers failed to start: ${failed.join(', ')}`)
    },
    'codex/event/item_started': (sid, _s, _ts, p) => {
      const msg = p.msg || p; const item = msg.item || {}
      if (item.id && item.type) this.handleNotification(sid, 'item/started', { item })
    },
    'codex/event/item_completed': (sid, _s, _ts, p) => {
      const msg = p.msg || p; const item = msg.item || {}
      if (item.id && item.type) this.handleNotification(sid, 'item/completed', { item })
    },
    'codex/event/user_message': () => {},
    'codex/event/skills_update_available': () => {},
  }

  /**
   * 处理 Codex 事件通知（基于实测 app-server v0.104.0 协议）
   *
   * 事件分两套：item/* 是精简高层事件；codex/event/* 是详细低层事件。
   * 优先处理 item/* 高层事件；对 codex/event/* 做实时进度兜底。
   * 分派逻辑通过 notificationHandlers map 实现，各事件处理拆为子方法。
   */
  private handleNotification(sessionId: string, method: string, params: any): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const ts = new Date().toISOString()

    // 兼容 Codex 不同版本的审批事件命名（例如 turn/requestApproval）
    if (method.endsWith('/requestApproval') && method !== 'item/commandExecution/requestApproval') {
      const command = String(params.command || params?.input?.command || params?.toolInput?.command || '')
      const approvalItemId = String(params.itemId || params.id || params.approvalId || '')
      this.handleApprovalRequest(sessionId, session, ts, {
        itemId: approvalItemId, prompt: `执行命令需要授权\n${command.slice(0, 300)}`,
        toolName: 'commandExecution', toolInput: { command },
      })
      return
    }

    const handler = this.notificationHandlers[method]
    if (handler) { handler(sessionId, session, ts, params); return }

    // 记录未知事件供调试（过滤噪音）
    if (method.startsWith('item/') || method.startsWith('codex/') || method.startsWith('thread/') || method.startsWith('turn/')) {
      console.debug(`[CodexAdapter][${sessionId}] Unhandled notification: ${method}`, JSON.stringify(params).slice(0, 300))
    }
  }

  // ── 子方法：流增量 ─────────────────────────────────────────────

  private onAgentMessageDelta(sessionId: string, session: CodexSession, ts: string, params: any): void {
    const text: string = params.delta || ''
    if (!text) return
    session.agentMessageBuffer += text
    this.emitEvent(sessionId, { type: 'text_delta', sessionId, timestamp: ts, data: { text } })
  }

  private onReasoningDelta(sessionId: string, ts: string, params: any): void {
    const text: string = params.delta || ''
    if (!text) return
    this.emitEvent(sessionId, { type: 'thinking', sessionId, timestamp: ts, data: { text } })
  }

  // ── 子方法：item 开始 ──────────────────────────────────────────

  private onItemStarted(sessionId: string, session: CodexSession, ts: string, params: any): void {
    const item = params.item || {}
    if (!item.id) return
    const toolUseId: string = item.id

    if (item.type === 'commandExecution' && item.command) {
      const command: string = String(item.command).slice(0, 160)
      session.activeToolUseIds.add(toolUseId)
      const toolMsg = {
        id: uuidv4(), sessionId, role: 'tool_use' as const,
        content: `执行: ${command.slice(0, 120)}`, timestamp: ts,
        toolName: 'shell', toolInput: { command } as Record<string, unknown>, toolUseId,
      }
      session.adapter.messages.push(toolMsg)
      this.emit('conversation-message', sessionId, toolMsg)
    } else if (item.type === 'mcpToolCall' && item.tool) {
      const toolName: string = item.tool || 'mcp'
      const serverLabel: string = item.server ? `[${item.server}] ` : ''
      const toolInput: Record<string, unknown> = item.arguments || {}
      session.activeToolUseIds.add(toolUseId)
      const toolMsg = {
        id: uuidv4(), sessionId, role: 'tool_use' as const,
        content: `${serverLabel}${toolName}${Object.keys(toolInput).length ? ': ' + JSON.stringify(toolInput).slice(0, 80) : ''}`,
        timestamp: ts, toolName, toolInput, toolUseId,
      }
      session.adapter.messages.push(toolMsg)
      this.emit('conversation-message', sessionId, toolMsg)
    }
  }

  // ── 子方法：item 完成（按 item.type 二次分派）─────────────────

  private onItemCompleted(sessionId: string, session: CodexSession, ts: string, params: any): void {
    const item = params.item || {}
    if (item.type === 'agentMessage') { this.onAgentMessageCompleted(sessionId, session, ts, item) }
    else if (item.type === 'commandExecution') { this.onCommandExecutionCompleted(sessionId, session, ts, item) }
    else if (item.type === 'mcpToolCall') { this.onMcpToolCallCompleted(sessionId, session, ts, item) }
  }

  /** agentMessage 完成 → 固化 AI 回复 */
  private onAgentMessageCompleted(sessionId: string, session: CodexSession, ts: string, item: any): void {
    let finalText: string = item.text || ''
    if (!finalText && Array.isArray(item.content)) {
      finalText = item.content
        .filter((c: any) => c.type === 'output_text' || c.type === 'text')
        .map((c: any) => c.text || '').join('')
    }
    if (!finalText) finalText = session.agentMessageBuffer
    session.agentMessageBuffer = ''
    if (!finalText) {
      console.warn(`[CodexAdapter][${sessionId}] agentMessage completed with empty text, skipping emit`)
      return
    }
    const assistantMsg = { id: uuidv4(), sessionId, role: 'assistant' as const, content: finalText, timestamp: ts }
    session.adapter.messages.push(assistantMsg)
    this.emit('conversation-message', sessionId, assistantMsg)
  }

  /** commandExecution 完成 → Shell 命令结果 */
  private onCommandExecutionCompleted(sessionId: string, session: CodexSession, ts: string, item: any): void {
    const toolUseId: string = item.id || uuidv4()
    const alreadyShown = session.activeToolUseIds.has(toolUseId)
    session.activeToolUseIds.delete(toolUseId)

    if (!alreadyShown) {
      const command: string = String(item.command || 'shell command').slice(0, 160)
      const toolMsg = {
        id: uuidv4(), sessionId, role: 'tool_use' as const,
        content: `执行: ${command.slice(0, 120)}`, timestamp: ts,
        toolName: 'shell', toolInput: { command } as Record<string, unknown>, toolUseId,
      }
      session.adapter.messages.push(toolMsg)
      this.emit('conversation-message', sessionId, toolMsg)
    }

    const rawOut = item.output
    const resultText = typeof rawOut === 'string' ? rawOut : (rawOut?.stdout || rawOut?.output || '')
    if (resultText) {
      const exitCode: number = item.exitCode ?? rawOut?.exitCode ?? 0
      const resultMsg = {
        id: uuidv4(), sessionId, role: 'tool_result' as const,
        content: resultText.slice(0, 500), timestamp: ts,
        toolResult: resultText, isError: exitCode !== 0, toolUseId,
      }
      session.adapter.messages.push(resultMsg)
      this.emit('conversation-message', sessionId, resultMsg)
    }
  }

  /** mcpToolCall 完成 → MCP 工具结果 */
  private onMcpToolCallCompleted(sessionId: string, session: CodexSession, ts: string, item: any): void {
    const toolUseId: string = item.id || uuidv4()
    const alreadyShown = session.activeToolUseIds.has(toolUseId)
    session.activeToolUseIds.delete(toolUseId)

    if (!alreadyShown) {
      const toolName: string = item.tool || 'mcp'
      const serverLabel: string = item.server ? `[${item.server}] ` : ''
      const toolInput: Record<string, unknown> = item.arguments || {}
      const toolMsg = {
        id: uuidv4(), sessionId, role: 'tool_use' as const,
        content: `${serverLabel}${toolName}`, timestamp: ts, toolName, toolInput, toolUseId,
      }
      session.adapter.messages.push(toolMsg)
      this.emit('conversation-message', sessionId, toolMsg)
    }

    const mcpResult = item.result
    if (mcpResult !== null && mcpResult !== undefined) {
      const resultText = typeof mcpResult === 'string' ? mcpResult : JSON.stringify(mcpResult)
      const resultMsg = {
        id: uuidv4(), sessionId, role: 'tool_result' as const,
        content: resultText.slice(0, 500), timestamp: ts,
        toolResult: resultText, isError: !!item.error, toolUseId,
      }
      session.adapter.messages.push(resultMsg)
      this.emit('conversation-message', sessionId, resultMsg)
    } else if (item.error) {
      const errorStr = typeof item.error === 'string' ? item.error : (item.error?.message || JSON.stringify(item.error))
      const errMsg = {
        id: uuidv4(), sessionId, role: 'tool_result' as const,
        content: errorStr.slice(0, 500), timestamp: ts,
        toolResult: errorStr, isError: true, toolUseId,
      }
      session.adapter.messages.push(errMsg)
      this.emit('conversation-message', sessionId, errMsg)
    }
  }

  // ── 子方法：codex/event 错误处理 ──────────────────────────────

  private onCodexError(sessionId: string, session: CodexSession, ts: string, params: any): void {
    const msg = params.msg || params
    const errorMessage: string = msg.message || msg.error || JSON.stringify(msg)
    console.error(`[CodexAdapter][${sessionId}] codex/event/error: ${errorMessage.slice(0, 500)}`)
    const errMsg = {
      id: uuidv4(), sessionId, role: 'system' as const,
      content: `Codex 错误: ${errorMessage.slice(0, 500)}`, timestamp: ts,
    }
    session.adapter.messages.push(errMsg)
    this.emit('conversation-message', sessionId, errMsg)
  }

  private onCodexStreamError(sessionId: string, session: CodexSession, ts: string, params: any): void {
    const msg = params.msg || params
    const reconnectMsg: string = msg.message || ''
    const details: string = msg.additional_details || ''
    console.warn(`[CodexAdapter][${sessionId}] stream_error: ${reconnectMsg} ${details.slice(0, 200)}`)
    if (reconnectMsg.includes('1/')) {
      const errMsg = {
        id: uuidv4(), sessionId, role: 'system' as const,
        content: `⚠️ ${reconnectMsg}\n${details.slice(0, 300)}`, timestamp: ts,
      }
      session.adapter.messages.push(errMsg)
      this.emit('conversation-message', sessionId, errMsg)
    }
  }

  /**
   * 处理裸事件（非标准 JSON-RPC，data.type 形式）
   *
   * Trae 扩展内置的 codex（v0.104.x）使用此格式推送事件，每行一个 JSON 对象：
   *   { type: "event_msg",      payload: { type: "task_started"|"task_complete"|"user_message"|... } }
   *   { type: "response_item",  payload: { type: "message", role: "assistant"|"user"|"developer", content: [...] } }
   *   { type: "turn_context",   payload: { ... } }  ← 元信息，忽略
   *
   * npm 安装的 codex（v0.98+）使用标准 JSON-RPC 通知，由 handleNotification 处理。
   */
  private handleCodexItem(sessionId: string, data: any): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const ts = new Date().toISOString()

    const topType: string = data.type || ''

    // ── response_item：包含对话消息（assistant 回复、用户消息等）──────
    if (topType === 'response_item') {
      const payload = data.payload || {}
      // 只处理 assistant 角色的消息
      if (payload.type === 'message' && payload.role === 'assistant') {
        // content 是数组，每个元素可能是 { type: 'output_text', text: '...' }
        const content: any[] = Array.isArray(payload.content) ? payload.content : []
        const text = content
          .filter((c: any) => c.type === 'output_text' || c.type === 'text')
          .map((c: any) => c.text || '')
          .join('')
        if (text) {
          // 同时写入 buffer 供 task_complete 兜底
          session.agentMessageBuffer += text
          // 实时 delta 推送，让前端逐字显示
          this.emitEvent(sessionId, {
            type: 'text_delta',
            sessionId,
            timestamp: ts,
            data: { text },
          })
        }
      }
      return
    }

    // ── event_msg：task 生命周期事件 ────────────────────────────────
    if (topType === 'event_msg') {
      const payload = data.payload || {}
      const eventType: string = payload.type || ''

      if (eventType === 'task_complete') {
        this.finalizeTurn(sessionId, session, ts)
        return
      }

      if (eventType === 'task_started') {
        // turn 开始，无需特殊处理
        return
      }

      console.debug(`[CodexAdapter][${sessionId}] event_msg unhandled: ${eventType}`)
      return
    }

    // ── turn_context：元信息，忽略 ──────────────────────────────────
    if (topType === 'turn_context' || topType === 'session_meta') {
      return
    }

    // ── 兜底：尝试作为 JSON-RPC method 处理（旧路径兼容） ──────────
    const method = topType
    const params = data.params || data.data || {}
    this.handleNotification(sessionId, method, params)
  }

  private emitEvent(sessionId: string, event: ProviderEvent): void {
    this.emit('event', event)
  }
}
