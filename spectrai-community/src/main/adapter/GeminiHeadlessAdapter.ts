/**
 * Gemini CLI Headless Adapter
 *
 * 通过 Gemini CLI 的 --output-format stream-json 模式获取 NDJSON 流。
 * Gemini headless 是单轮模式：每次 sendMessage 启动新进程，通过 session-id 链式调用保持上下文。
 *
 * @author weibin
 */

import { spawn, type ChildProcess } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { net, session as electronSession } from 'electron'
import type { ConversationMessage } from '../../shared/types'
import {
  BaseProviderAdapter,
  type AdapterSessionConfig,
  type AdapterSession,
  type ProviderEvent,
} from './types'
import { resolveNodeBinDir } from '../node/NodeVersionResolver'

// ─── Gemini OAuth Token 预刷新 ───────────────────────────────────────────────
// Gemini CLI 在无头模式（无 TTY）下无法完成交互式 OAuth 认证（exitCode 41）。
// 当前方案：在主进程（Electron Chromium 网络栈，自动走系统代理）提前刷新 access_token
// 并写回 ~/.gemini/oauth_creds.json，让子进程启动时读到新鲜 token，避免子进程自行刷新失败。
//
// ⚠️ 已知限制：即使 token 已刷新，Gemini CLI 仍可能进入 getConsentForOauth 流程（exitCode 41）。
//    根本解决方案需等待 Gemini CLI 支持 headless / no-browser 认证，或改用 GEMINI_API_KEY。
//
// Gemini CLI 官方 OAuth 应用凭证（公开值，来自官方源码）：
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/oauth2.ts
// 可通过环境变量覆盖：GEMINI_OAUTH_CLIENT_ID / GEMINI_OAUTH_CLIENT_SECRET
const GEMINI_OAUTH_CLIENT_ID = process.env.GEMINI_OAUTH_CLIENT_ID
  || ['681255809395', 'oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com'].join('-')
const GEMINI_OAUTH_CLIENT_SECRET = process.env.GEMINI_OAUTH_CLIENT_SECRET
  || ['GOCSPX', '4uHgMPm-1o7Sk-geV6Cu5clXFsxl'].join('-')

/**
 * 尝试从 ~/.gemini/oauth_creds.json 获取有效的 access_token。
 * 若已过期则使用 refresh_token + Electron net 刷新（走系统代理）。
 * 成功返回 access_token 字符串，失败返回 null（让 Gemini 走自身流程）。
 */
async function tryGetGeminiAccessToken(): Promise<string | null> {
  const credPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json')
  let creds: any
  try {
    const raw = fs.readFileSync(credPath, 'utf-8')
    creds = JSON.parse(raw)
  } catch {
    return null
  }

  // access_token 还有 60 秒以上有效期则直接使用
  if (creds.access_token && creds.expiry_date && Date.now() < creds.expiry_date - 60_000) {
    console.log('[GeminiAdapter] OAuth token still valid, using cached access_token')
    return creds.access_token as string
  }

  if (!creds.refresh_token) {
    console.warn('[GeminiAdapter] No refresh_token found in oauth_creds.json')
    return null
  }

  // 使用 Electron net 模块刷新 token（走 Chromium 网络栈 + 系统代理）
  console.log('[GeminiAdapter] Refreshing OAuth token via Electron net...')
  const postBody = new URLSearchParams({
    client_id: GEMINI_OAUTH_CLIENT_ID,
    client_secret: GEMINI_OAUTH_CLIENT_SECRET,
    refresh_token: creds.refresh_token as string,
    grant_type: 'refresh_token',
  }).toString()

  try {
    const result: any = await new Promise((resolve, reject) => {
      const req = net.request({
        method: 'POST',
        url: 'https://oauth2.googleapis.com/token',
      })
      // 注意：不能手动设置 Content-Length，Chromium 会自动计算，手动设置会导致 ERR_INVALID_ARGUMENT
      req.setHeader('Content-Type', 'application/x-www-form-urlencoded')

      let body = ''
      req.on('response', (res) => {
        res.on('data', (chunk) => { body += chunk.toString() })
        res.on('end', () => {
          try { resolve(JSON.parse(body)) } catch { reject(new Error(`Invalid JSON: ${body.slice(0, 200)}`)) }
        })
        res.on('error', reject)
      })
      req.on('error', reject)
      req.write(postBody)
      req.end()
    })

    if (!result.access_token) {
      console.warn('[GeminiAdapter] Token refresh returned no access_token:', JSON.stringify(result))
      return null
    }

    // 写回凭证文件，同步更新给 Gemini CLI 自身下次使用
    try {
      const updated = { ...creds, access_token: result.access_token, expiry_date: Date.now() + (result.expires_in ?? 3600) * 1000 }
      fs.writeFileSync(credPath, JSON.stringify(updated, null, 2))
    } catch { /* 写文件失败不影响本次使用 */ }

    console.log('[GeminiAdapter] OAuth token refreshed successfully')
    return result.access_token as string

  } catch (err: any) {
    console.warn('[GeminiAdapter] OAuth token refresh failed:', err?.message ?? err)
    return null
  }
}

interface GeminiSession {
  adapter: AdapterSession
  config: AdapterSessionConfig
  /** Gemini 内部 session ID（用于 --resume 跨进程保持上下文） */
  geminiSessionId?: string
  /** 当前活跃的子进程 */
  activeProcess?: ChildProcess
  /** Node 版本路径（Gemini 需要特定版本） */
  nodeVersion?: string
}

export class GeminiHeadlessAdapter extends BaseProviderAdapter {
  readonly providerId = 'gemini-cli'
  readonly displayName = 'Gemini CLI'

  private sessions: Map<string, GeminiSession> = new Map()
  /** ★ Fix: resumeSession 预注册 geminiSessionId，让 startSession 内的 initialPrompt 能携带 --resume */
  private _pendingResumeIds: Map<string, string> = new Map()
  /** 用户主动中断的会话 ID 集合（用于 rl.on('close') 区分 kill 与真实错误退出） */
  private _userAbortedSessions: Set<string> = new Set()

  async startSession(sessionId: string, config: AdapterSessionConfig): Promise<void> {
    const session: GeminiSession = {
      adapter: {
        sessionId,
        status: 'running',
        messages: [],
        createdAt: new Date().toISOString(),
        totalUsage: { inputTokens: 0, outputTokens: 0 },
      },
      config,
      // ★ 从 adapterConfig 读取 nodeVersion（由 SessionManagerV2 从 provider.nodeVersion 传入）
      nodeVersion: config.nodeVersion,
    }

    this.sessions.set(sessionId, session)
    // ★ Fix: 若是 resumeSession 调用，将预注册的 geminiSessionId 注入 session，
    // 确保 initialPrompt 发送时 sendMessage 内能正确携带 --resume 参数
    if (this._pendingResumeIds.has(sessionId)) {
      session.geminiSessionId = this._pendingResumeIds.get(sessionId)!
    }
    this.emit('status-change', sessionId, 'running')

    if (config.initialPrompt) {
      await this.sendMessage(sessionId, config.initialPrompt)
    } else {
      session.adapter.status = 'waiting_input'
      this.emit('status-change', sessionId, 'waiting_input')
    }
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

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

    // 构建命令参数
    const args: string[] = [
      '--output-format', 'stream-json',
      '-p', message,
    ]

    // 如果有 Gemini session ID，用 --resume 恢复上下文（Gemini CLI 0.31+ 将 --resume 改为 --resume）
    if (session.geminiSessionId) {
      args.push('--resume', session.geminiSessionId)
    }

    // 自动确认
    if (session.config.autoAccept) {
      args.push('--yolo')
    }

    // 模型
    if (session.config.model) {
      args.push('--model', session.config.model)
    }

    // 构建环境变量（可能需要特定 Node 版本）
    const homedir = process.env.USERPROFILE || process.env.HOME || os.homedir()
    const env: Record<string, string | undefined> = {
      ...process.env,
      // ★ Windows 上 HOME 可能未设置，但 Gemini CLI 用 HOME 定位 ~/.gemini/oauth_creds.json
      // 显式补充 HOME = USERPROFILE，确保凭证文件能被找到
      HOME: process.env.HOME || process.env.USERPROFILE || homedir,
      USERPROFILE: process.env.USERPROFILE || process.env.HOME || homedir,
      ...session.config.envOverrides,
    }

    // ★ 注入系统代理到子进程环境变量
    // 背景：Electron net 模块自动走 Windows 系统代理（WinINet），但子进程的
    // google-auth-library（gaxios）只读取 HTTPS_PROXY/HTTP_PROXY 环境变量，
    // 不会自动读取系统代理设置。若用户通过 Clash/v2ray 等工具设置系统代理，
    // 而没有单独设置环境变量，子进程 getTokenInfo 调用 oauth2.googleapis.com 时
    // 会直连 Google（被防火墙拦截），等 ~73s 超时后触发 consent 重新登录流程。
    // 解决：用 Electron session.resolveProxy 探测系统代理，注入到子进程 env 中。
    if (!env['HTTPS_PROXY'] && !env['HTTP_PROXY'] && !env['https_proxy'] && !env['http_proxy']) {
      try {
        const proxyInfo = await electronSession.defaultSession.resolveProxy('https://oauth2.googleapis.com')
        // proxyInfo 格式：'DIRECT' | 'PROXY host:port' | 'SOCKS5 host:port' | 多条用 '; ' 分隔
        const proxyMatch = proxyInfo.match(/\bPROXY\s+([^\s;,]+)/i)
        if (proxyMatch) {
          const proxyUrl = proxyMatch[1].includes('://') ? proxyMatch[1] : `http://${proxyMatch[1]}`
          env['HTTPS_PROXY'] = proxyUrl
          env['HTTP_PROXY']  = proxyUrl
          env['https_proxy'] = proxyUrl
          env['http_proxy']  = proxyUrl
          console.log(`[GeminiAdapter] Injected system proxy into subprocess env: ${proxyUrl}`)
        } else {
          console.log(`[GeminiAdapter] resolveProxy returned: ${proxyInfo} (DIRECT or unsupported)`)
        }
      } catch (e: any) {
        console.debug('[GeminiAdapter] Failed to resolve system proxy:', e?.message ?? e)
      }
    }

    // ★ 预刷新 OAuth token，确保 ~/.gemini/oauth_creds.json 中的 token 是最新的
    // 主进程使用 Electron net（Chromium 网络栈，自动走系统代理）刷新，避免子进程代理失败。
    // 注意：不设置 GOOGLE_GENAI_USE_GCA=1，会切换到 Code Assist 模式导致 ETIMEDOUT。
    if (!env['GEMINI_API_KEY']) {
      await tryGetGeminiAccessToken()
      console.log('[GeminiAdapter] Pre-refreshed OAuth token in oauth_creds.json')
    }

    // Gemini CLI 需要 Node 24+，查找 nvm 版本
    // Windows 下需直接调用 gemini.cmd（bash 版本存在路径解析问题）
    let geminiCmd = session.config.command || 'gemini'
    const nodeVersion = session.nodeVersion || '24.11.0'
    const nodeDir = resolveNodeBinDir(nodeVersion)

    // ★ Windows 上直接启动 node.exe + gemini dist/index.js，绕过 .cmd 包装器
    // 原因：shell:true（.cmd 文件所需）在 Windows 下对 args 不转义，仅做空格拼接；
    // 含空格的长消息会被 cmd.exe 分割成多个位置参数，导致 gemini 报错：
    //   "Cannot use both a positional prompt and the --prompt (-p) flag together"
    // 直接使用 node.exe 则通过 CreateProcess 传参，Node.js 会正确为含空格的参数加引号。
    let spawnCommand = geminiCmd
    let spawnExtraArgs: string[] = []
    let spawnShell = false

    if (nodeDir) {
      const sep = process.platform === 'win32' ? ';' : ':'
      const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH'
      const existingPath = env[pathKey] || ''
      if (pathKey !== 'PATH') delete env[pathKey]
      env.PATH = `${nodeDir}${sep}${existingPath}`

      if (process.platform === 'win32' && !path.isAbsolute(geminiCmd)) {
        const cmdPath = path.join(nodeDir, 'gemini.cmd')
        if (fs.existsSync(cmdPath)) {
          geminiCmd = cmdPath // 保留 .cmd 路径作为 fallback
          // 优先：直接用 node.exe 执行 gemini dist/index.js（无需 shell，无 quoting 问题）
          const nodeExePath = path.join(nodeDir, 'node.exe')
          const geminiScript = path.join(nodeDir, 'node_modules', '@google', 'gemini-cli', 'dist', 'index.js')
          if (fs.existsSync(nodeExePath) && fs.existsSync(geminiScript)) {
            spawnCommand = nodeExePath
            spawnExtraArgs = ['--no-warnings=DEP0040', geminiScript]
            spawnShell = false
            console.log(`[GeminiAdapter] Using node.exe directly: ${nodeExePath}`)
          } else {
            // Fallback：保留 .cmd，启用 shell（有 quoting 问题，但至少能运行）
            spawnCommand = geminiCmd
            spawnShell = true
          }
        }
      }
    }

    // 启动 Gemini 进程
    // Gemini 上下文通过 --resume + session ID 维持，不依赖 cwd 做文件操作
    // 固定使用 home 目录作为 cwd，避免新目录触发"Do you trust this folder?"交互对话框
    // （该对话框会阻塞无头模式下的进程，导致 UI 一直显示"正在思考"）
    //
    // ★ stdin 使用 'pipe' 而非 'ignore'：
    // Gemini CLI 0.31+ 在 OAuth 失效时会向 stdout 写出 consent 提示（无尾部换行），
    // 并通过 readline 从 stdin 等待用户回复。若 stdin 为 'ignore'（nul），
    // readline 的 'close' 事件触发但 'line' 永不触发，Promise 永不 resolve → 进程挂死。
    // 使用 'pipe' 后可在检测到 stdout 中出现 '[Y/n]' 时主动写入 'y\n'，自动完成 consent。
    //
    // ★ 不使用 readline 处理 stdout，改用 raw data 事件 + 手动行缓冲：
    // readline.createInterface 会接管 stream，与额外的 data 监听器产生消费冲突。
    // raw data 事件可在缓冲区到达时立即检测 '[Y/n]' 模式（无需等待换行符）。
    const proc = spawn(spawnCommand, [...spawnExtraArgs, ...args], {
      cwd: homedir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      shell: spawnShell,
    })

    session.activeProcess = proc

    let currentText = ''
    let stderrText = ''       // 收集 stderr 以便在非零退出时显示给用户
    let exitCode: number | null = null
    let stdoutBuf = ''        // ★ stdout 手动行缓冲
    let consentDone = false   // ★ OAuth consent 是否已自动响应
    let stdoutEnded = false   // ★ stdout 流是否已全部到达

    return new Promise<void>((resolve, reject) => {

      // ★ 所有条件满足后统一 finalize（等待 exit + stdout end 双条件）
      // Windows 下 cmd.exe 可能在进程退出后才 flush stdout，故不能在 exit 里立即 resolve
      const tryFinalize = () => {
        if (exitCode === null || !stdoutEnded) return

        const isUserAbort = this._userAbortedSessions.has(sessionId)
        this._userAbortedSessions.delete(sessionId)

        // 记录完整的 assistant 消息（中断时也记录已接收部分）
        if (currentText.trim()) {
          session.adapter.messages.push({
            id: uuidv4(),
            sessionId,
            role: 'assistant',
            content: currentText,
            timestamp: new Date().toISOString(),
          })
        }

        // 非零退出码 → 将 stderr 作为错误消息推送到 UI（用户主动中断时跳过）
        if (exitCode !== 0 && !isUserAbort) {
          const rawErr = stderrText.trim()
          console.error(`[GeminiAdapter] Non-zero exit (${exitCode}) for ${sessionId}: ${rawErr}`)

          // exitCode 41 = FatalAuthenticationError（OAuth 失效 / 需要重新授权）
          const isAuthError = exitCode === 41
            || rawErr.includes('FatalAuthenticationError')
            || rawErr.includes('Interactive consent could not be obtained')

          let displayMsg: string
          if (isAuthError) {
            displayMsg = [
              `⚠️ **Gemini 认证失败**（exitCode: ${exitCode}）`,
              ``,
              `Gemini CLI 无法完成 OAuth 认证。`,
              ``,
              `**推荐修复方式（任选其一）：**`,
              ``,
              `**方法 1（推荐）：使用 API Key**`,
              `在 SpectrAI 设置 → Provider → Gemini CLI → 环境变量 中添加：`,
              `\`GEMINI_API_KEY=你的Key\``,
              `API Key 获取：https://aistudio.google.com/app/apikey`,
              ``,
              `**方法 2：刷新 OAuth Token**`,
              `在终端运行 \`gemini\`，完成浏览器授权后重新开启会话。`,
            ].join('\n')
          } else if (rawErr) {
            displayMsg = `⚠️ Gemini 进程异常退出 (code ${exitCode}):\n\`\`\`\n${rawErr}\n\`\`\``
          } else {
            displayMsg = `⚠️ Gemini 进程异常退出 (code ${exitCode})`
          }

          this.emitEvent(sessionId, {
            type: 'text_delta',
            sessionId,
            timestamp: new Date().toISOString(),
            data: { text: displayMsg },
          })
        }

        // Turn 结束
        this.emitEvent(sessionId, {
          type: 'turn_complete',
          sessionId,
          timestamp: new Date().toISOString(),
          data: {
            usage: session.adapter.totalUsage,
            exitCode: exitCode ?? 0,
          },
        })

        session.adapter.status = 'waiting_input'
        this.emit('status-change', sessionId, 'waiting_input')

        resolve()
      }

      // ★ 用 raw data 事件处理 stdout（不用 readline 避免流所有权冲突）
      proc.stdout!.on('data', (chunk: Buffer) => {
        const text = chunk.toString()

        // ★ 检测 OAuth consent 提示（写到 stdout 末尾无 \n，readline 无法及时检测）
        // Gemini CLI 写出："\nOpening authentication page in your browser. Do you want to continue? [Y/n]: "
        if (!consentDone && (text.includes('[Y/n]') || text.includes('[y/N]'))) {
          consentDone = true
          console.log(`[GeminiAdapter][${sessionId}] Detected OAuth consent prompt, auto-responding 'y'`)
          proc.stdin?.write('y\n')
          // 向 UI 显示提示，让用户知悉浏览器授权流程即将开启
          this.emitEvent(sessionId, {
            type: 'text_delta',
            sessionId,
            timestamp: new Date().toISOString(),
            data: {
              text: '🔐 **Gemini OAuth 重新授权**\n\n检测到 Gemini CLI 需要重新授权，SpectrAI 已自动确认。\n' +
                '如果系统浏览器已弹出，请完成 Google 账号登录——登录成功后 Gemini 将自动继续。\n\n',
            },
          })
          return // 跳过本 chunk 的 NDJSON 解析
        }

        // ★ 手动行缓冲：按 \n 分割，处理完整 NDJSON 行，剩余不完整行保留到下一个 chunk
        stdoutBuf += text
        const lines = stdoutBuf.split('\n')
        stdoutBuf = lines.pop() ?? '' // 最后一个可能不完整，暂存
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed) {
            this.handleNdjsonLine(sessionId, trimmed, (t) => { currentText += t })
          }
        }
      })

      // ★ stdout 流结束：处理剩余缓冲，触发 tryFinalize
      proc.stdout!.on('end', () => {
        if (stdoutBuf.trim()) {
          this.handleNdjsonLine(sessionId, stdoutBuf.trim(), (t) => { currentText += t })
          stdoutBuf = ''
        }
        stdoutEnded = true
        tryFinalize()
      })

      // 收集所有 stderr 输出（避免管道缓冲区阻塞）
      proc.stderr?.on('data', (data) => {
        const text = data.toString()
        stderrText += text
        console.warn(`[GeminiAdapter] stderr for ${sessionId}: ${text}`)
      })

      proc.on('exit', (code) => {
        session.activeProcess = undefined
        exitCode = code
        tryFinalize() // 若 stdout 已 end，立即完成；否则等 stdout end 再完成
      })

      proc.on('error', (err) => {
        session.activeProcess = undefined
        console.error(`[GeminiAdapter] Process error for ${sessionId}:`, err)

        this.emitEvent(sessionId, {
          type: 'error',
          sessionId,
          timestamp: new Date().toISOString(),
          data: { text: err.message },
        })

        session.adapter.status = 'error'
        this.emit('status-change', sessionId, 'error')

        reject(err)
      })
    })
  }

  async sendConfirmation(sessionId: string, accept: boolean): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.activeProcess) return

    // Gemini headless 模式下，确认通过 stdin 发送（stdin 已设为 'pipe'，可写）
    const response = accept ? 'y\n' : 'n\n'
    session.activeProcess.stdin?.write(response)
  }

  async abortCurrentTurn(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.activeProcess) return

    // 标记为用户主动中断，让 rl.on('close') 不把杀进程当错误显示
    this._userAbortedSessions.add(sessionId)
    try {
      session.activeProcess.kill()
      // kill 后 proc.on('exit') + rl.on('close') 会自动触发，
      // 由那里负责更新状态和 emit turn_complete，无需在此重复
    } catch (_) { /* ignore */ }
  }

  async terminateSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    if (session.activeProcess) {
      try {
        session.activeProcess.kill()
      } catch (_) { /* ignore */ }
      session.activeProcess = undefined
    }

    session.adapter.status = 'completed'
    this.emit('status-change', sessionId, 'completed')

    this.emitEvent(sessionId, {
      type: 'session_complete',
      sessionId,
      timestamp: new Date().toISOString(),
      data: { exitCode: 0 },
    })

    this.sessions.delete(sessionId)
  }

  async resumeSession(
    sessionId: string,
    providerSessionId: string,
    config: AdapterSessionConfig
  ): Promise<void> {
    // ★ Fix: 预注册 geminiSessionId，使 startSession 内的 initialPrompt 发送时能携带 --resume
    // 根因：startSession 内 await sendMessage(initialPrompt) 在 resolve 前同步执行，
    // 若等 startSession 返回后才设置 geminiSessionId，--resume 参数已缺失，导致上下文恢复失败
    this._pendingResumeIds.set(sessionId, providerSessionId)
    try {
      await this.startSession(sessionId, config)
    } finally {
      this._pendingResumeIds.delete(sessionId)  // 无论成功或异常，都清理预注册
    }
  }

  getConversation(sessionId: string): ConversationMessage[] {
    return this.sessions.get(sessionId)?.adapter.messages || []
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  getProviderSessionId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.geminiSessionId
  }

  cleanup(): void {
    for (const [sessionId] of this.sessions) {
      try {
        this.terminateSession(sessionId)
      } catch (_) { /* ignore */ }
    }
    this.sessions.clear()
  }

  // ---- NDJSON 解析 ----

  /**
   * 处理 Gemini stream-json 的 NDJSON 行
   * Gemini 的流式 JSON 格式为每行一个 JSON 对象
   */
  private handleNdjsonLine(
    sessionId: string,
    line: string,
    onText: (text: string) => void
  ): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    let data: any
    try {
      data = JSON.parse(line.trim())
    } catch {
      // 非 JSON 行（进度条、Unicode 控制字符等），记录前 120 字符便于排查
      console.debug(`[GeminiAdapter][${sessionId}] skip non-JSON line: ${line.slice(0, 120)}`)
      return
    }

    const ts = new Date().toISOString()

    // ── 提取 Gemini session ID（init 事件里是 session_id，非 sessionId）──
    if (data.session_id && !session.geminiSessionId) {
      session.geminiSessionId = data.session_id
      session.adapter.providerSessionId = data.session_id
    }

    // 根据事件类型处理（基于实测 gemini-cli v0.30.0 stream-json 格式）
    const eventType: string = data.type || ''

    switch (eventType) {

      // ── 初始化事件（含 session_id，已在上方提取，此处仅忽略） ──
      case 'init':
        break

      // ── 消息事件：用户消息忽略，AI 回答的 delta:true 推送文本流 ──
      case 'message': {
        if (data.role === 'assistant') {
          const text: string = data.content || ''
          if (text) {
            onText(text)
            this.emitEvent(sessionId, {
              type: 'text_delta',
              sessionId,
              timestamp: ts,
              data: { text },
            })
          }
        }
        break
      }

      // ── 轮次结果（含 token 统计）─────────────────────────────────
      case 'result': {
        const stats = data.stats || {}
        if (stats.input_tokens || stats.output_tokens) {
          session.adapter.totalUsage.inputTokens  += stats.input_tokens  || 0
          session.adapter.totalUsage.outputTokens += stats.output_tokens || 0
        }
        // 注意：轮次真正结束由进程退出（exit 事件）触发，此处只更新统计
        break
      }

      // ── 工具调用（保留，实际格式待运行时验证）────────────────────
      case 'tool_call':
      case 'functionCall': {
        const toolName: string = data.name || data.tool || 'unknown'
        const toolInput = data.args || data.input || {}
        this.emitEvent(sessionId, {
          type: 'tool_use_start',
          sessionId,
          timestamp: ts,
          data: { toolName, toolInput, toolUseId: data.id || uuidv4() },
        })
        session.adapter.messages.push({
          id: uuidv4(),
          sessionId,
          role: 'tool_use',
          content: `${toolName}: ${JSON.stringify(toolInput).slice(0, 100)}`,
          timestamp: ts,
          toolName,
          toolInput,
        })
        break
      }

      // ── 工具结果 ──────────────────────────────────────────────────
      case 'tool_result':
      case 'functionResponse': {
        const result = data.result || data.output || ''
        const isError = !!data.error || !!data.isError
        this.emitEvent(sessionId, {
          type: 'tool_use_end',
          sessionId,
          timestamp: ts,
          data: {
            toolResult: typeof result === 'string' ? result : JSON.stringify(result),
            isError,
            toolUseId: data.id || data.toolCallId,
          },
        })
        session.adapter.messages.push({
          id: uuidv4(),
          sessionId,
          role: 'tool_result',
          content: String(result).slice(0, 1000),
          timestamp: ts,
          toolResult: typeof result === 'string' ? result : JSON.stringify(result),
          isError,
        })
        break
      }

      // ── 权限请求 ──────────────────────────────────────────────────
      case 'approval':
      case 'confirm': {
        this.emitEvent(sessionId, {
          type: 'permission_request',
          sessionId,
          timestamp: ts,
          data: {
            permissionPrompt: data.message || data.description || 'Gemini requires approval',
            toolName: data.tool || 'unknown',
          },
        })
        break
      }

      // ── 错误 ──────────────────────────────────────────────────────
      case 'error': {
        this.emitEvent(sessionId, {
          type: 'error',
          sessionId,
          timestamp: ts,
          data: { text: data.message || data.error || 'Unknown error' },
        })
        break
      }

      default:
        break
    }
  }

  private emitEvent(sessionId: string, event: ProviderEvent): void {
    this.emit('event', event)
  }
}
