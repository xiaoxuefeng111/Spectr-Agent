/**
 * Claude Code Agent SDK Adapter (V1 query API)
 *
 * 通过 @anthropic-ai/claude-agent-sdk 的 V1 稳定接口 query()
 * 实现与 Claude Code 的结构化交互。V1 API 支持完整的
 * settingSources / mcpServers / plugins 配置加载。
 *
 * @author weibin
 */

import { v4 as uuidv4 } from 'uuid'
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import type { ConversationMessage } from '../../shared/types'
import {
  BaseProviderAdapter,
  type AdapterSessionConfig,
  type AdapterSession,
  type ProviderEvent,
} from './types'
import { mapToolToActivityType, extractToolDetail } from './toolMapping'
import { logger } from '../logger'
import type { DatabaseManager } from '../storage/Database'
import { prependNodeVersionToEnvPath } from '../node/NodeVersionResolver'

// ---- V1 Query 类型（运行时从 SDK 动态加载） ----

type SDKQuery = {
  close(): void
  interrupt(): Promise<void>
  supportedCommands(): Promise<any[]>
  mcpServerStatus(): Promise<any[]>
  setMcpServers(servers: Record<string, any>): Promise<any>
  toggleMcpServer(name: string, enabled: boolean): Promise<void>
  reconnectMcpServer(name: string): Promise<void>
  streamInput(stream: AsyncIterable<any>): Promise<void>
  [Symbol.asyncIterator](): AsyncIterator<any>
}

// ---- AsyncIterable 输入流（用于 V1 多轮对话） ----

/**
 * 可排队的 AsyncIterable，用于向 V1 query() 输入流推送用户消息。
 * sendMessage() 调用 enqueue() 将消息入队，SDK 内部 for-await 消费。
 */
class AsyncIterableQueue<T> {
  private queue: T[] = []
  private resolve: ((value: IteratorResult<T>) => void) | null = null
  private done = false

  enqueue(item: T): void {
    if (this.done) return
    if (this.resolve) {
      // 有等待中的消费者，直接交付
      const r = this.resolve
      this.resolve = null
      r({ value: item, done: false })
    } else {
      this.queue.push(item)
    }
  }

  close(): void {
    this.done = true
    if (this.resolve) {
      const r = this.resolve
      this.resolve = null
      r({ value: undefined as any, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false })
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as any, done: true })
        }
        // 等待新消息入队
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolve = resolve
        })
      },
    }
  }
}

/**
 * Claude Code Agent SDK Adapter (V1 query API)
 *
 * 事件流:
 *   SDK query stream → switch(msg.type) → emit('event', ProviderEvent)
 *   turn 结束 → emit('status-change', sessionId, 'waiting_input')
 */
export class ClaudeSdkAdapter extends BaseProviderAdapter {
  readonly providerId = 'claude-code'
  readonly displayName = 'Claude Code'

  private sessions: Map<string, AdapterSession> = new Map()
  private sdkQueries: Map<string, SDKQuery> = new Map()
  private inputStreams: Map<string, AsyncIterableQueue<any>> = new Map()
  private abortControllers: Map<string, AbortController> = new Map()
  private claudeExecutablePath: string | null = null
  private claudeExecutablePathByCommand: Map<string, string> = new Map()
  /** 软中断标志集合：记录哪些会话正在进行软中断（中止当前轮次但保持会话活跃） */
  private softAbortSessions: Set<string> = new Set()
  /** 会话配置缓存：软中断后重新 resume 时使用 */
  private sessionConfigs: Map<string, AdapterSessionConfig> = new Map()
  /** 每个会话的 stderr 输出缓冲，进程 exit 时用于生成有意义的错误提示 */
  private sessionStderr: Map<string, string[]> = new Map()
  /** 数据库引用，用于读取全局代理设置 */
  private database: DatabaseManager | null = null
  /** AskUserQuestion 挂起队列 */
  private pendingQuestions: Map<string, {
    resolve: (result: any) => void
    toolInput: Record<string, unknown>
  }> = new Map()
  /** ExitPlanMode 挂起队列 */
  private pendingPlanApprovals: Map<string, {
    resolve: (result: any) => void
    toolInput: Record<string, unknown>
  }> = new Map()

  /**
   * 注入数据库引用（在 Adapter 注册后由 main/index.ts 调用）
   */
  setDatabase(db: DatabaseManager): void {
    this.database = db
    // 清除代理缓存，下次启动会话时重新从数据库读取
    this.proxyEnvCache = null
  }

  /**
   * 通过 shell 查找 node 可执行文件所在目录，缓存结果。
   * 用于解决 Electron 打包后 process.env.PATH 可能丢失 NVM/node 路径的问题。
   * spawn('node', ...) 不走 shell，必须显式把 node 目录补进 PATH。
   */
  private nodeBinDir: string | null = null
  private nodeBinDirResolved = false
  private findNodeBinDir(): string | null {
    if (this.nodeBinDirResolved) return this.nodeBinDir
    this.nodeBinDirResolved = true
    try {
      const cmd = process.platform === 'win32' ? 'where node' : 'which node'
      const nodePath = execSync(cmd, { encoding: 'utf8', timeout: 5000 })
        .trim().split(/\r?\n/)[0].trim()
      if (nodePath) {
        this.nodeBinDir = path.dirname(nodePath)
        logger.info(`[ClaudeSdkAdapter] Detected node binary dir: ${this.nodeBinDir}`)
      }
    } catch (err) {
      logger.warn(`[ClaudeSdkAdapter] Could not detect node binary dir:`, err)
    }
    return this.nodeBinDir
  }

  /**
   * 确保 PATH 环境变量中包含 node 二进制目录。
   * 解决 Electron 启动时（非 shell 直接 spawn）找不到 node 的 ENOENT 问题。
   */
  private ensureNodeInPath(currentPath: string): string {
    const nodeDir = this.findNodeBinDir()
    if (!nodeDir) return currentPath
    const sep = process.platform === 'win32' ? ';' : ':'
    const dirs = currentPath.split(sep)
    if (dirs.includes(nodeDir)) return currentPath
    logger.info(`[ClaudeSdkAdapter] Prepending node dir to PATH: ${nodeDir}`)
    return `${nodeDir}${sep}${currentPath}`
  }

  /**
   * 将 Unix/MSYS 风格路径转换为 Windows 合法路径。
   *
   * Claude Code 在 Windows 上运行时（尤其通过 Git Bash/MSYS 启动）会将工作目录
   * 上报为 /d/foo/bar 格式，而非 D:\foo\bar。
   * Node.js child_process.spawn() 不走 shell，无法识别 /d/ 前缀，
   * 导致 cwd 目录不存在 → spawn <command> ENOENT。
   *
   * 例：/d/desk_code/project  →  D:\desk_code\project
   */
  private normalizeWorkingDir(dir: string): string {
    if (process.platform !== 'win32' || !dir) return dir
    // 匹配 /x/... 格式（x 为盘符字母），兼容 MSYS2/Git Bash/Cygwin
    const match = dir.match(/^\/([a-zA-Z])(\/.*)?$/)
    if (match) {
      const drive = match[1].toUpperCase()
      const rest = (match[2] || '').replace(/\//g, '\\')
      const normalized = `${drive}:${rest || '\\'}`
      logger.info(`[ClaudeSdkAdapter] Normalized cwd: ${dir} → ${normalized}`)
      return normalized
    }
    return dir
  }

  /**
   * 查找 git-bash 可执行文件路径（仅 Windows）。
   * Claude Code 在 Windows 上要求 git-bash，需通过 CLAUDE_CODE_GIT_BASH_PATH 指定。
   * undefined = 尚未检测，null = 已检测但未找到，string = 已找到路径
   */
  private gitBashPath: string | null | undefined = undefined

  private findGitBashPath(): string | null {
    if (process.platform !== 'win32') return null
    if (this.gitBashPath !== undefined) return this.gitBashPath

    // 1. 优先使用已有环境变量
    if (process.env.CLAUDE_CODE_GIT_BASH_PATH) {
      this.gitBashPath = process.env.CLAUDE_CODE_GIT_BASH_PATH
      logger.info(`[ClaudeSdkAdapter] Using existing CLAUDE_CODE_GIT_BASH_PATH: ${this.gitBashPath}`)
      return this.gitBashPath
    }

    // 2. 常见安装路径（覆盖各主流安装方式：系统级/用户级/包管理器）
    const userProfile = process.env.USERPROFILE || process.env.HOME
    const candidates: string[] = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      'D:\\Program Files\\Git\\bin\\bash.exe',
      'D:\\Program Files (x86)\\Git\\bin\\bash.exe',
      'E:\\Program Files\\Git\\bin\\bash.exe',
      'E:\\Program Files (x86)\\Git\\bin\\bash.exe',
      'F:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\tools\\Git\\bin\\bash.exe',          // Chocolatey 默认
      // Scoop（用户级）
      ...(userProfile ? [path.join(userProfile, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe')] : []),
    ].filter(Boolean)

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        this.gitBashPath = p
        logger.info(`[ClaudeSdkAdapter] Found git-bash at: ${p}`)
        return this.gitBashPath
      }
    }

    // 3. 通过 cmd /c where git 推断安装目录 → 定位 bin\bash.exe
    // git 通常在 <安装根目录>\cmd\git.exe，bash 在 <安装根目录>\bin\bash.exe
    // 使用 cmd /c 确保读取完整系统 PATH（Electron 可能有受限 PATH）
    try {
      const gitPaths = execSync('cmd /c where git', { encoding: 'utf8', timeout: 3000 })
        .trim().split(/\r?\n/).filter(Boolean)
      for (const gitPath of gitPaths) {
        const gitRoot = path.resolve(path.dirname(gitPath), '..')
        const bashCandidate = path.join(gitRoot, 'bin', 'bash.exe')
        if (fs.existsSync(bashCandidate)) {
          this.gitBashPath = bashCandidate
          logger.info(`[ClaudeSdkAdapter] Found git-bash via 'where git': ${bashCandidate}`)
          return this.gitBashPath
        }
      }
    } catch { /* ignore */ }

    // 4. 通过 where bash 查找（取第一个含 git 的结果）
    try {
      const result = execSync('where bash', { encoding: 'utf8', timeout: 3000 })
        .trim().split(/\r?\n/)
        .find((p) => p.toLowerCase().includes('git'))
      if (result) {
        this.gitBashPath = result.trim()
        logger.info(`[ClaudeSdkAdapter] Found git-bash via where bash: ${this.gitBashPath}`)
        return this.gitBashPath
      }
    } catch { /* ignore */ }

    this.gitBashPath = null
    logger.warn(`[ClaudeSdkAdapter] git-bash not found on Windows, Claude Code may fail to start`)
    return null
  }

  /**
   * 将 CLAUDE_CODE_GIT_BASH_PATH 注入到环境变量中（仅 Windows）。
   * 若已设置则不覆盖（尊重用户自定义）。
   * @param configPath Provider 设置中用户手动指定的 bash.exe 路径（优先于自动探测）
   */
  private ensureGitBashInEnv(env: Record<string, string | undefined>, configPath?: string): void {
    if (process.platform !== 'win32') return
    if (env.CLAUDE_CODE_GIT_BASH_PATH) return // 已设置（系统环境变量），不覆盖

    // 优先使用 Provider 设置中指定的路径
    if (configPath?.trim()) {
      if (fs.existsSync(configPath.trim())) {
        env.CLAUDE_CODE_GIT_BASH_PATH = configPath.trim()
        logger.info(`[ClaudeSdkAdapter] Using config-specified gitBashPath: ${configPath}`)
        return
      }
      logger.warn(`[ClaudeSdkAdapter] Config gitBashPath not found: ${configPath}, falling back to auto-detect`)
    }

    const bashPath = this.findGitBashPath()
    if (bashPath) {
      env.CLAUDE_CODE_GIT_BASH_PATH = bashPath
      logger.info(`[ClaudeSdkAdapter] Injected CLAUDE_CODE_GIT_BASH_PATH: ${bashPath}`)
    }
  }

  private resolveCliJsFromWrapper(wrapperPath: string): string | undefined {
    if (!wrapperPath) return undefined
    if (!fs.existsSync(wrapperPath)) {
      logger.warn(`[ClaudeSdkAdapter] Wrapper path does not exist: ${wrapperPath}`)
      return undefined
    }

    let candidatePath = wrapperPath
    try {
      const realPath = fs.realpathSync(wrapperPath)
      if (realPath !== wrapperPath) {
        logger.info(`[ClaudeSdkAdapter] Resolved wrapper symlink: ${wrapperPath} -> ${realPath}`)
      }
      candidatePath = realPath
    } catch (err: any) {
      logger.warn(
        `[ClaudeSdkAdapter] Failed to resolve realpath for "${wrapperPath}", fallback to original path: ${err?.message || err}`
      )
    }

    const isCliJs = (p: string) => /(^|[\\/])cli\.js$/i.test(p)
    if (isCliJs(candidatePath) && fs.existsSync(candidatePath)) {
      return candidatePath
    }
    if (isCliJs(wrapperPath) && fs.existsSync(wrapperPath)) {
      return wrapperPath
    }

    try {
      const stat = fs.statSync(candidatePath)
      if (!stat.isFile()) {
        logger.warn(`[ClaudeSdkAdapter] Candidate wrapper is not a file: ${candidatePath}`)
        return undefined
      }

      const wrapperContent = fs.readFileSync(candidatePath, 'utf-8')
      const cliJsMatch = wrapperContent.match(/node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]cli\.js/)
      if (!cliJsMatch) {
        logger.warn(`[ClaudeSdkAdapter] Not a Claude wrapper script: ${candidatePath}`)
        return undefined
      }

      const wrapperDir = path.dirname(candidatePath)
      const cliJs = path.resolve(wrapperDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
      if (fs.existsSync(cliJs)) {
        logger.info(`[ClaudeSdkAdapter] Resolved cli.js from wrapper script: ${cliJs}`)
        return cliJs
      }
      logger.warn(`[ClaudeSdkAdapter] Wrapper parsed but cli.js not found: ${cliJs}`)
      return undefined
    } catch (err: any) {
      logger.warn(`[ClaudeSdkAdapter] Failed to parse wrapper "${candidatePath}": ${err?.message || err}`)
      return undefined
    }
  }

  /**
   * 构建增强 PATH 环境，把 node bin 目录和各包管理器全局 bin 目录都加进去。
   * 解决 Electron 打包后 process.env.PATH 比终端窄、找不到 claude/npm 命令的问题。
   * 涵盖：npm / pnpm / bun / Volta / Scoop（Windows），Homebrew / bun / pnpm / Volta / mise（macOS/Linux）。
   */
  private buildEnhancedEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env }
    // 1. 补充 node bin 目录
    env.PATH = this.ensureNodeInPath(env.PATH || '')

    const sep = process.platform === 'win32' ? ';' : ':'
    const existingPaths = new Set((env.PATH || '').split(sep).filter(Boolean))
    const addToPath = (dir: string) => {
      if (!dir || existingPaths.has(dir)) return
      existingPaths.add(dir)
      env.PATH = `${dir}${sep}${env.PATH}`
      logger.info(`[ClaudeSdkAdapter] Prepended to PATH: ${dir}`)
    }

    if (process.platform === 'win32') {
      const appData    = process.env.APPDATA
      const localAppData = process.env.LOCALAPPDATA
      const userProfile  = process.env.USERPROFILE || process.env.HOME
      if (appData)      addToPath(path.join(appData, 'npm'))           // npm global bin
      if (localAppData) addToPath(path.join(localAppData, 'pnpm'))     // pnpm global bin
      if (userProfile) {
        addToPath(path.join(userProfile, '.local', 'bin'))             // 官方安装器 install.ps1 → claude.exe
        addToPath(path.join(userProfile, '.bun', 'bin'))               // bun
        addToPath(path.join(userProfile, 'scoop', 'shims'))            // Scoop
        addToPath(path.join(userProfile, '.volta', 'bin'))             // Volta
      }
    } else {
      // macOS / Linux
      const home = process.env.HOME
      addToPath('/opt/homebrew/bin')                                   // Homebrew Apple Silicon（常被 Electron 丢失）
      addToPath('/usr/local/bin')                                      // Homebrew x86 / 系统
      if (home) {
        addToPath(path.join(home, '.bun', 'bin'))                      // bun
        addToPath(path.join(home, '.local', 'share', 'pnpm'))          // pnpm
        addToPath(path.join(home, '.volta', 'bin'))                    // Volta
        addToPath(path.join(home, '.local', 'bin'))                    // mise / pipx 等
      }
    }

    return env
  }

  /**
   * 从 wrapper script 文件中提取 cli.js 的实际路径。
   * npm 安装 claude 后会在 bin 目录生成一个 shell wrapper，其中引用了 cli.js。
   *
   * Windows 注意：优先尝试 .cmd wrapper（避免 .ps1 被 PowerShell 执行策略拦截）。
   * 若传入 .ps1 路径，会自动尝试同目录下的 .cmd 文件作为备选。
   */
  private extractCliJsFromWrapper(wrapperPath: string): string | undefined {
    // Windows 上优先使用 .cmd wrapper，避免 PowerShell ExecutionPolicy 问题
    const pathsToTry: string[] = [wrapperPath]
    if (process.platform === 'win32' && wrapperPath.toLowerCase().endsWith('.ps1')) {
      const cmdVariant = wrapperPath.slice(0, -4) + '.cmd'
      // 把 .cmd 插到前面，优先尝试
      pathsToTry.unshift(cmdVariant)
    }

    for (const p of pathsToTry) {
      try {
        const wrapperContent = fs.readFileSync(p, 'utf-8')
        if (wrapperContent.match(/node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]cli\.js/)) {
          const wrapperDir = path.dirname(p)
          const cliJs = path.resolve(wrapperDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
          if (fs.existsSync(cliJs)) {
            logger.info(`[ClaudeSdkAdapter] Extracted cli.js from wrapper: ${cliJs}`)
            return cliJs
          }
        }
      } catch { /* ignore, try next */ }
    }
    return undefined
  }

  /**
   * 直接探测常见安装路径，跳过 shell 命令。
   * 适用于 claude 在系统 PATH 中不可见（Electron 受限环境）但已安装的场景。
   *
   * Windows 涵盖：npm global / pnpm global / bun global / Volta / nvm-windows / fnm / Scoop(Node.js)
   * macOS/Linux 涵盖：Homebrew / npm global / bun global / pnpm global / nvm / Volta / fnm / mise / asdf
   */
  private probeCommonCliJsPaths(): string | undefined {
    const CLI_SUBPATH = path.join('@anthropic-ai', 'claude-code', 'cli.js')

    /** 扫描版本号子目录，优先最新版本，找到即返回 */
    const scanVersionDirs = (base: string, suffix: string): string | undefined => {
      if (!fs.existsSync(base)) return undefined
      try {
        for (const v of fs.readdirSync(base).sort().reverse()) {
          const p = path.join(base, v, suffix)
          if (fs.existsSync(p)) {
            logger.info(`[ClaudeSdkAdapter] Probed cli.js via version dir at: ${p}`)
            return p
          }
        }
      } catch { /* ignore */ }
      return undefined
    }

    if (process.platform === 'win32') {
      const appData      = process.env.APPDATA
      const localAppData = process.env.LOCALAPPDATA
      const userProfile  = process.env.USERPROFILE || process.env.HOME

      // ① npm global（最常见）
      if (appData) {
        const p = path.join(appData, 'npm', 'node_modules', CLI_SUBPATH)
        if (fs.existsSync(p)) { logger.info(`[ClaudeSdkAdapter] Probed cli.js at: ${p}`); return p }
      }

      // ② pnpm global（%LOCALAPPDATA%\pnpm\global\<version>\node_modules\...）
      if (localAppData) {
        const r = scanVersionDirs(path.join(localAppData, 'pnpm', 'global'), path.join('node_modules', CLI_SUBPATH))
        if (r) return r
      }

      // ③ bun global
      if (userProfile) {
        const p = path.join(userProfile, '.bun', 'install', 'global', 'node_modules', CLI_SUBPATH)
        if (fs.existsSync(p)) { logger.info(`[ClaudeSdkAdapter] Probed cli.js at: ${p}`); return p }
      }

      // ④ Volta（%USERPROFILE%\.volta\tools\image\node\<version>\node_modules\...）
      if (userProfile) {
        const r = scanVersionDirs(
          path.join(userProfile, '.volta', 'tools', 'image', 'node'),
          path.join('node_modules', CLI_SUBPATH)
        )
        if (r) return r
      }

      // ⑤ nvm-windows
      if (userProfile) {
        const nvmHome = process.env.NVM_HOME || path.join(userProfile, 'AppData', 'Roaming', 'nvm')
        const r = scanVersionDirs(nvmHome, path.join('node_modules', CLI_SUBPATH))
        if (r) return r
      }

      // ⑥ fnm on Windows（%LOCALAPPDATA%\fnm\node-versions\<version>\installation\node_modules\...）
      if (localAppData) {
        const r = scanVersionDirs(
          path.join(localAppData, 'fnm', 'node-versions'),
          path.join('installation', 'node_modules', CLI_SUBPATH)
        )
        if (r) return r
      }

      // ⑦ Scoop 安装的 Node.js（apps\nodejs* 或 apps\nodejs-lts 下）
      if (userProfile) {
        const scoopApps = path.join(userProfile, 'scoop', 'apps')
        if (fs.existsSync(scoopApps)) {
          try {
            for (const appName of fs.readdirSync(scoopApps)) {
              if (!appName.toLowerCase().startsWith('nodejs')) continue
              const p = path.join(scoopApps, appName, 'current', 'node_modules', CLI_SUBPATH)
              if (fs.existsSync(p)) {
                logger.info(`[ClaudeSdkAdapter] Probed cli.js via Scoop nodejs at: ${p}`)
                return p
              }
            }
          } catch { /* ignore */ }
        }
      }

      // ⑧ 官方安装器 (irm https://claude.ai/install.ps1 | iex) → 原生 EXE，非 Node.js wrapper
      //    安装路径：%USERPROFILE%\.local\bin\claude.exe（PowerShell 安装器默认）
      //    或 %LOCALAPPDATA%\Programs\claude-code\claude.exe（installer 变体）
      if (userProfile) {
        const p = path.join(userProfile, '.local', 'bin', 'claude.exe')
        if (fs.existsSync(p)) {
          logger.info(`[ClaudeSdkAdapter] Probed native claude.exe (official installer) at: ${p}`)
          return p
        }
      }
      if (localAppData) {
        const p = path.join(localAppData, 'Programs', 'claude-code', 'claude.exe')
        if (fs.existsSync(p)) {
          logger.info(`[ClaudeSdkAdapter] Probed native claude.exe (official installer) at: ${p}`)
          return p
        }
      }
    } else {
      // macOS / Linux

      // ① 固定路径：Homebrew / npm global / Linux system
      const home = process.env.HOME
      const fixedCandidates = [
        '/opt/homebrew/lib/node_modules/' + CLI_SUBPATH,      // Homebrew Apple Silicon
        '/usr/local/lib/node_modules/' + CLI_SUBPATH,         // Homebrew x86 / global npm
        '/usr/lib/node_modules/' + CLI_SUBPATH,               // Linux global npm
        ...(home ? [
          path.join(home, '.bun', 'install', 'global', 'node_modules', CLI_SUBPATH),  // bun global
        ] : []),
      ]
      for (const p of fixedCandidates) {
        if (fs.existsSync(p)) {
          logger.info(`[ClaudeSdkAdapter] Probed cli.js at: ${p}`)
          return p
        }
      }

      if (home) {
        // ② 版本管理器：nvm / Volta / fnm / mise / asdf
        const versionDirs: Array<{ base: string; suffix: string }> = [
          { base: path.join(home, '.nvm', 'versions', 'node'),                   suffix: path.join('lib', 'node_modules', CLI_SUBPATH) },
          { base: path.join(home, '.volta', 'tools', 'image', 'node'),           suffix: path.join('lib', 'node_modules', CLI_SUBPATH) },
          { base: path.join(home, '.fnm', 'node-versions'),                      suffix: path.join('installation', 'lib', 'node_modules', CLI_SUBPATH) },
          { base: path.join(home, '.local', 'share', 'mise', 'installs', 'node'), suffix: path.join('lib', 'node_modules', CLI_SUBPATH) },  // mise
          { base: path.join(home, '.asdf', 'installs', 'nodejs'),                suffix: path.join('lib', 'node_modules', CLI_SUBPATH) },   // asdf
        ]
        for (const { base, suffix } of versionDirs) {
          const r = scanVersionDirs(base, suffix)
          if (r) return r
        }

        // ③ pnpm global（macOS/Linux：~/.local/share/pnpm/global/<version>/node_modules/...）
        const pnpmBases = [
          path.join(home, '.local', 'share', 'pnpm', 'global'),
          path.join(home, '.pnpm-global'),  // pnpm 旧版
        ]
        for (const pnpmBase of pnpmBases) {
          const r = scanVersionDirs(pnpmBase, path.join('node_modules', CLI_SUBPATH))
          if (r) return r
        }
      }
    }
    return undefined
  }

  /**
   * 查找 Claude Code CLI 可执行文件路径（cli.js），多层降级策略：
   *   0. 用户手动指定路径（customPath，可为 cli.js 或 wrapper）—— 优先级最高
   *   1. where/which claude（增强 PATH：npm/pnpm/bun/Volta/Scoop/Homebrew 等均已补入）→ 解析 wrapper → 定位 cli.js
   *   2. 直接探测常见安装路径（无需 shell，覆盖 npm/pnpm/bun/Volta/nvm/fnm/mise/asdf/Scoop/Homebrew 等）
   *   3. npm root -g（增强 PATH）→ 拼接 cli.js 路径
   * 自动检测结果会按 command 缓存，避免重复探测。
   */
  private findClaudeCodeExecutable(command: string, customPath?: string): string | undefined {
    const normalizedCommand = (command || 'claude').trim() || 'claude'
    const commandName = path.basename(normalizedCommand)
    const cacheKey = customPath ? `${normalizedCommand}::${customPath}` : normalizedCommand
    const cached = this.claudeExecutablePathByCommand.get(cacheKey)
    if (cached) return cached

    // 策略 0：用户手动指定路径
    if (customPath) {
      if (!fs.existsSync(customPath)) {
        logger.warn(`[ClaudeSdkAdapter] User-configured executable not found: ${customPath}`)
        return undefined
      }

      const resolvedFromCustom =
        this.resolveCliJsFromWrapper(customPath) ||
        this.extractCliJsFromWrapper(customPath)
      if (resolvedFromCustom) {
        this.claudeExecutablePath = resolvedFromCustom
        this.claudeExecutablePathByCommand.set(cacheKey, resolvedFromCustom)
        logger.info(`[ClaudeSdkAdapter] Using user-configured executable: ${resolvedFromCustom}`)
        return resolvedFromCustom
      }

      // SDK 支持原生二进制（非 JS 文件，如 .exe）：yq() 函数判断非 .js/.mjs 时直接 spawn
      // 用户指定的若是 claude.exe（官方安装器产物），直接传给 SDK，不需要提取 cli.js
      const JS_EXTS = ['.js', '.mjs', '.ts', '.tsx', '.jsx']
      const isNativeBinary = !JS_EXTS.some(ext => customPath.toLowerCase().endsWith(ext))
      if (isNativeBinary) {
        this.claudeExecutablePath = customPath
        this.claudeExecutablePathByCommand.set(cacheKey, customPath)
        logger.info(`[ClaudeSdkAdapter] Using user-configured native binary directly: ${customPath}`)
        return customPath
      }

      logger.warn(
        `[ClaudeSdkAdapter] User-configured executable is not a valid Claude wrapper/cli.js: ${customPath}`
      )
      return undefined
    }

    if (path.isAbsolute(normalizedCommand)) {
      if (!fs.existsSync(normalizedCommand)) {
        logger.warn(`[ClaudeSdkAdapter] Absolute command path does not exist: ${normalizedCommand}`)
        return undefined
      }
      const resolvedFromAbsolute = this.resolveCliJsFromWrapper(normalizedCommand)
      if (resolvedFromAbsolute) {
        this.claudeExecutablePath = resolvedFromAbsolute
        this.claudeExecutablePathByCommand.set(cacheKey, resolvedFromAbsolute)
        logger.info(`[ClaudeSdkAdapter] Found Claude Code CLI from absolute command: ${resolvedFromAbsolute}`)
        return resolvedFromAbsolute
      }
      logger.warn(
        `[ClaudeSdkAdapter] Absolute command does not point to Claude wrapper/cli.js: ${normalizedCommand}. ` +
        `Please set provider command to an absolute cli.js path.`
      )
      return undefined
    }

    // 自动检测：使用全局缓存
    if (this.claudeExecutablePath) {
      this.claudeExecutablePathByCommand.set(cacheKey, this.claudeExecutablePath)
      return this.claudeExecutablePath
    }

    // 先构建增强 PATH（解决 Electron 受限 PATH 问题）
    const enhancedEnv = this.buildEnhancedEnv()

    // 策略 1：where/which claude（增强 PATH）
    try {
      const checker = process.platform === 'win32' ? 'where' : 'which'
      const cmd = process.platform === 'win32' ? `where "${commandName}"` : `which "${commandName}"`
      const allPaths = execSync(cmd, { encoding: 'utf8', timeout: 5000, env: enhancedEnv })
        .trim().split(/\r?\n/).filter(Boolean)

      // Windows：优先尝试 .cmd wrapper（规避 PowerShell ExecutionPolicy 限制）
      // where.exe 可能同时返回 claude.ps1 和 claude.cmd，.cmd 对 Node.js spawn 更安全
      const ordered = process.platform === 'win32'
        ? [
            ...allPaths.filter(p => p.toLowerCase().endsWith('.cmd')),
            ...allPaths.filter(p => !p.toLowerCase().endsWith('.cmd')),
          ]
        : allPaths

      // 官方安装器（install.ps1）产出的原生 EXE 路径，作为兜底（优先级低于 .cmd wrapper）
      let nativeExeFallback: string | undefined
      for (const claudePath of ordered) {
        const cliJs = this.resolveCliJsFromWrapper(claudePath) || this.extractCliJsFromWrapper(claudePath)
        if (cliJs) {
          this.claudeExecutablePath = cliJs
          this.claudeExecutablePathByCommand.set(cacheKey, cliJs)
          logger.info(`[ClaudeSdkAdapter] Found Claude Code CLI via ${checker}: ${cliJs}`)
          return cliJs
        }
        // 识别原生 EXE（官方安装器不生成 Node.js wrapper）：记录为候选，循环后统一处理
        if (
          process.platform === 'win32' &&
          claudePath.toLowerCase().endsWith('.exe') &&
          fs.existsSync(claudePath) &&
          !nativeExeFallback
        ) {
          nativeExeFallback = claudePath
        }
      }
      // 所有 wrapper 均无法提取 cli.js，但找到了原生 EXE → 直接使用
      if (nativeExeFallback) {
        this.claudeExecutablePath = nativeExeFallback
        this.claudeExecutablePathByCommand.set(cacheKey, nativeExeFallback)
        logger.info(`[ClaudeSdkAdapter] Found Claude Code native binary via ${checker}: ${nativeExeFallback}`)
        return nativeExeFallback
      }
      if (allPaths.length > 0) {
        logger.warn(
          `[ClaudeSdkAdapter] ${checker} resolved "${normalizedCommand}" but none is a Claude wrapper/cli.js/exe. ` +
          `Resolved candidates: ${allPaths.join(', ')}`
        )
      }
    } catch (err) {
      logger.warn(`[ClaudeSdkAdapter] Could not resolve command "${normalizedCommand}" from PATH:`, err)
    }
 
    // 策略 2：直接探测常见路径
    const probed = this.probeCommonCliJsPaths()
    if (probed) {
      this.claudeExecutablePath = probed
      this.claudeExecutablePathByCommand.set(cacheKey, probed)
      return probed
    }

    // 策略 3：npm root -g
    // Windows 上显式使用 npm.cmd，防止系统 PATHEXT 把 .PS1 排在 .CMD 前导致 npm.ps1 被执行策略拦截
    try {
      const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      const npmRoot = execSync(`"${npmBin}" root -g`, { encoding: 'utf8', timeout: 5000, env: enhancedEnv }).trim()
      const globalCliJs = path.join(npmRoot, '@anthropic-ai', 'claude-code', 'cli.js')
      if (fs.existsSync(globalCliJs)) {
        this.claudeExecutablePath = globalCliJs
        this.claudeExecutablePathByCommand.set(cacheKey, globalCliJs)
        logger.info(`[ClaudeSdkAdapter] Found Claude Code CLI via npm root -g: ${globalCliJs}`)
        return globalCliJs
      }
    } catch { /* ignore */ }

    // 策略 4（Windows 专属）：cmd /c where claude.cmd
    // 强制让 cmd.exe 查找 .cmd wrapper，完全绕过 PATHEXT 中 .PS1 优先的问题
    // 即使系统已把 .PS1 排在最前，cmd /c where claude.cmd 也只会返回 .cmd 路径
    if (process.platform === 'win32') {
      try {
        const cmdWrapper = commandName.toLowerCase().endsWith('.cmd') ? commandName : `${commandName}.cmd`
        const cmdPath = execSync(`cmd /c where ${cmdWrapper}`, { encoding: 'utf8', timeout: 5000, env: enhancedEnv })
          .trim().split(/\r?\n/).filter(Boolean)[0]
        if (cmdPath) {
          const cliJs = this.resolveCliJsFromWrapper(cmdPath) || this.extractCliJsFromWrapper(cmdPath)
          if (cliJs) {
            this.claudeExecutablePath = cliJs
            this.claudeExecutablePathByCommand.set(cacheKey, cliJs)
            logger.info(`[ClaudeSdkAdapter] Found Claude Code CLI via cmd where ${cmdWrapper}: ${cliJs}`)
            return cliJs
          }
        }
      } catch { /* ignore */ }
    }

    // 所有策略均失败
    logger.warn(
      `[ClaudeSdkAdapter] Claude Code CLI not found via any strategy.` +
      (process.platform === 'win32'
        ? ' 请确认 claude-code 已通过 npm install -g @anthropic-ai/claude-code 安装，' +
          '或在设置中手动指定 cli.js 路径。'
        : ` Please configure provider command/executablePath manually. command=${normalizedCommand}`)
    )
    return undefined
  }

  /**
   * 获取代理环境变量，优先级：
   *   1. 应用设置中的代理配置（用户在设置面板配置）
   *   2. 当前进程环境变量（系统/用户已设置）
   *   3. Windows PowerShell profile 中的环境变量（仅 Win32 + 未设置时）
   *   4. 均无则返回空对象（并打印警告）
   */
  private proxyEnvCache: Record<string, string> | null = null
  private getProxyEnv(): Record<string, string> {
    // ── 优先级 1：从应用设置读取用户配置的代理 ──
    if (this.database) {
      try {
        const settings = this.database.getAppSettings()
        const proxyType = settings.proxyType as string | undefined
        if (proxyType && proxyType !== 'none') {
          const host = settings.proxyHost as string | undefined
          const port = settings.proxyPort as string | undefined
          if (host && port) {
            const username = settings.proxyUsername as string | undefined
            const password = settings.proxyPassword as string | undefined
            const auth = username
              ? (password ? `${username}:${password}@` : `${username}@`)
              : ''
            const protocol = proxyType === 'socks5' ? 'socks5' : 'http'
            const proxyUrl = `${protocol}://${auth}${host}:${port}`
            logger.info(`[ClaudeSdkAdapter] Using proxy from app settings: ${protocol}://${auth}${host}:${port}`)
            return {
              HTTPS_PROXY: proxyUrl,
              HTTP_PROXY: proxyUrl,
              ALL_PROXY: proxyUrl,
            }
          }
        }
      } catch (err) {
        logger.warn(`[ClaudeSdkAdapter] Failed to read proxy from app settings:`, err)
      }
    }

    // ── 优先级 2：进程环境变量已有代理，直接沿用（不再额外注入） ──
    const existingProxy = process.env.HTTPS_PROXY || process.env.https_proxy
      || process.env.HTTP_PROXY || process.env.http_proxy
      || process.env.ALL_PROXY || process.env.all_proxy
    if (existingProxy) {
      logger.info(`[ClaudeSdkAdapter] Using proxy from process environment: ${existingProxy}`)
      return {}
    }

    // ── 优先级 3：Windows 上尝试从 PowerShell profile 读取 ──
    if (process.platform === 'win32') {
      if (this.proxyEnvCache !== null) return this.proxyEnvCache

      const result: Record<string, string> = {}
      try {
        const psScript = [
          "foreach ($v in @('HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY')) {",
          "  $val = (Get-ChildItem Env: -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $v }).Value",
          "  if ($val) { Write-Output \"$v=$val\" }",
          "}"
        ].join('\n')

        const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
        const output = execSync(`powershell -EncodedCommand ${encoded}`, {
          encoding: 'utf8',
          timeout: 15000,
        }).trim()

        const validKeys = new Set(['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY'])
        if (output) {
          for (const line of output.split(/\r?\n/)) {
            const idx = line.indexOf('=')
            if (idx > 0) {
              const key = line.slice(0, idx).trim()
              const val = line.slice(idx + 1).trim()
              if (val && validKeys.has(key)) result[key] = val
            }
          }
        }

        if (Object.keys(result).length > 0) {
          logger.info(`[ClaudeSdkAdapter] Proxy from PowerShell profile:`,
            Object.entries(result).map(([k, v]) => `${k}=${v}`).join(', '))
        } else {
          logger.warn(
            `[ClaudeSdkAdapter] No proxy detected from any source. ` +
            `If Claude Code cannot connect, please configure a proxy in Settings → 通用 → 代理设置.`
          )
        }

        this.proxyEnvCache = result
        return result
      } catch (err) {
        console.warn(`[ClaudeSdkAdapter] Failed to read proxy env from PowerShell:`, err)
        this.proxyEnvCache = {}
        return this.proxyEnvCache
      }
    }

    // ── 优先级 4（非 Windows）：无代理 ──
    logger.warn(
      `[ClaudeSdkAdapter] No proxy configured. ` +
      `If Claude Code cannot connect, please configure a proxy in Settings → 通用 → 代理设置.`
    )
    return {}
  }


  /** 延迟加载 SDK 模块 */
  private sdkModule: any = null
  private async loadSdk(): Promise<any> {
    if (!this.sdkModule) {
      try {
        this.sdkModule = await import('@anthropic-ai/claude-agent-sdk')
      } catch (err) {
        throw new Error(
          `Failed to load @anthropic-ai/claude-agent-sdk. ` +
          `Please install: npm install @anthropic-ai/claude-agent-sdk\n` +
          `Original error: ${err}`
        )
      }
    }
    return this.sdkModule
  }

  /**
   * 合并 MCP 服务器配置：extraMcpServers 对象 + mcpConfigPath 文件（SDK 不支持文件路径，需手动读取）
   */
  private loadMcpServers(config: AdapterSessionConfig): Record<string, any> {
    const base = config.extraMcpServers || {}

    if (!config.mcpConfigPath) return base

    try {
      const raw = fs.readFileSync(config.mcpConfigPath, 'utf-8')
      const parsed = JSON.parse(raw)
      const fileMcpServers = parsed.mcpServers || {}
      logger.info(`[ClaudeSdkAdapter] Loaded ${Object.keys(fileMcpServers).length} MCP server(s) from ${config.mcpConfigPath}`)
      return { ...base, ...fileMcpServers }
    } catch (err) {
      logger.warn(`[ClaudeSdkAdapter] Failed to read mcpConfigPath "${config.mcpConfigPath}": ${err}`)
      return base
    }
  }

  /**
   * 构建 allowedTools 列表
   */
  private buildAllowedTools(config: AdapterSessionConfig): string[] {
    // 用户显式指定时直接使用
    if (config.allowedTools && config.allowedTools.length > 0) {
      return config.allowedTools
    }

    const base = [
      'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
      'WebSearch', 'WebFetch', 'Task', 'NotebookEdit', 'LSP', 'Skill',
    ]

    if (config.autoAccept) {
      // autoAccept 模式：额外允许所有 MCP 工具
      return [...base, 'mcp__*']
    }

    return base
  }

  /**
   * 将 systemPrompt 配置应用到 SDK options。
   *
   * ★ 关键修复（2026-03-04）：
   * cli.js v2.0.35 的 IPC initialize 处理器（J9I）完全忽略 appendSystemPrompt 字段。
   * --append-system-prompt CLI 参数才是唯一有效路径（cli.js 将其读入 J.appendSystemPrompt，
   * 再传入 query loop）。SDK 的 Ay() 提取了 Y.append 但 B4.initialize() 从不把它转为 CLI 参数。
   * 正确做法：通过 extraArgs 传递，B4.initialize() 会将其展开为 --append-system-prompt <text>。
   *
   * 同时：cli.js 的 DF() 函数只加载 CLAUDE.md / .claude/CLAUDE.md，
   * 从不加载 .claude/rules/ 目录，因此写入 rules/ 文件对注入无效。
   */
  private applySystemPromptToOptions(options: Record<string, any>, systemPrompt: AdapterSessionConfig['systemPrompt']): void {
    if (!systemPrompt) return
    if (typeof systemPrompt === 'object' && systemPrompt.type === 'preset' && systemPrompt.append) {
      // 通过 extraArgs 强制注入 --append-system-prompt CLI 参数
      options.extraArgs = {
        ...(options.extraArgs || {}),
        'append-system-prompt': systemPrompt.append,
      }
      // 保留 systemPrompt preset 以保持 SDK 内部语义一致（不影响实际注入）
      options.systemPrompt = systemPrompt
    } else {
      options.systemPrompt = systemPrompt
    }
  }

  /**
   * 构建公共 V1 query options（startSession / resumeSession 共用）。
   *
   * 包含：环境变量合并、PATH 补全、git-bash 注入、代理设置、
   * MCP servers、allowedTools、权限模式、stderr 捕获等。
   *
   * @param sessionId       会话 ID（用于 stderr 收集和权限回调）
   * @param config          Adapter 会话配置
   * @param abortController 中止控制器
   * @param extraOptions    额外字段（如 resume: providerSessionId）
   */
  private buildQueryOptions(
    sessionId: string,
    config: AdapterSessionConfig,
    abortController: AbortController,
    extraOptions?: Record<string, any>,
  ): Record<string, any> {
    const cwd = this.normalizeWorkingDir(config.workingDirectory)
    const execPath = this.findClaudeCodeExecutable(config.command, config.executablePath)

    // ── 环境变量 ──
    const cleanEnv = { ...process.env }
    delete cleanEnv.CLAUDECODE
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT
    cleanEnv.PATH = this.ensureNodeInPath(cleanEnv.PATH || '')
    const mergedEnv = prependNodeVersionToEnvPath(cleanEnv, config.nodeVersion)
    this.ensureGitBashInEnv(mergedEnv, config.gitBashPath)
    const proxyEnv = this.getProxyEnv()

    // ── 额外目录（工作区多仓库） ──
    const additionalDirs = config.additionalDirectories?.map(d => this.normalizeWorkingDir(d)).filter(Boolean)

    // ── 基础 options ──
    const options: Record<string, any> = {
      cwd,
      ...(additionalDirs && additionalDirs.length > 0 ? { additionalDirectories: additionalDirs } : {}),
      ...(config.model ? { model: config.model } : {}),
      env: { ...mergedEnv, ...proxyEnv, ...(config.envOverrides || {}) },
      settingSources: ['user', 'project', 'local'],
      mcpServers: this.loadMcpServers(config),
      allowedTools: this.buildAllowedTools(config),
      includePartialMessages: true,
      abortController,
      // ★ 捕获 stderr，用于诊断启动/恢复失败
      stderr: (data: string) => {
        const trimmed = data.trim()
        logger.warn(`[ClaudeSdkAdapter] CLI stderr [${sessionId}]: ${trimmed}`)
        if (!this.sessionStderr.has(sessionId)) this.sessionStderr.set(sessionId, [])
        this.sessionStderr.get(sessionId)!.push(trimmed)
      },
      ...extraOptions,
    }

    if (execPath) {
      options.pathToClaudeCodeExecutable = execPath
    }

    this.applySystemPromptToOptions(options, config.systemPrompt)

    if (config.maxTurns && config.maxTurns > 0) {
      options.maxTurns = config.maxTurns
    }

    // ── 权限模式 ──
    // autoAccept → bypassPermissions + canUseTool（拦截 ExitPlanMode / AskUserQuestion）
    // 非 autoAccept → 仅 canUseTool，弹框等待用户确认
    if (config.autoAccept) {
      options.permissionMode = 'bypassPermissions'
      options.allowDangerouslySkipPermissions = true
    }
    options.canUseTool = this.createPermissionHandler(sessionId, !!config.autoAccept)

    return options
  }

  /**
   * 公共会话初始化流程（startSession / resumeSession 共用）。
   *
   * 创建 AdapterSession + AsyncIterableQueue + SDKQuery，
   * 启动流消费循环和 initData 获取。
   *
   * @returns {{ session, inputStream, sdkQuery }}
   */
  private async initSessionPipeline(
    sessionId: string,
    options: Record<string, any>,
    overrides?: { providerSessionId?: string; initialStatus?: AdapterSession['status'] },
  ): Promise<{ session: AdapterSession; inputStream: AsyncIterableQueue<any>; sdkQuery: SDKQuery }> {
    const sdk = await this.loadSdk()

    const session: AdapterSession = {
      sessionId,
      providerSessionId: overrides?.providerSessionId,
      status: overrides?.initialStatus ?? 'running',
      messages: [],
      createdAt: new Date().toISOString(),
      totalUsage: { inputTokens: 0, outputTokens: 0 },
    }
    this.sessions.set(sessionId, session)

    // ★ AsyncIterableQueue 保持 ProcessTransport 持续可写，支持多轮交互
    const inputStream = new AsyncIterableQueue<any>()
    this.inputStreams.set(sessionId, inputStream)

    const sdkQuery: SDKQuery = sdk.query({
      prompt: inputStream,
      options,
    })
    this.sdkQueries.set(sessionId, sdkQuery)

    // 启动异步流消费循环 + 主动获取 supportedCommands
    this.consumeStream(sessionId, sdkQuery)
    this.fetchAndEmitInitData(sessionId, sdkQuery)

    return { session, inputStream, sdkQuery }
  }

  async startSession(sessionId: string, config: AdapterSessionConfig): Promise<void> {
    const cwd = this.normalizeWorkingDir(config.workingDirectory)
    logger.info(`[ClaudeSdkAdapter] startSession ${sessionId}: cwd=${cwd}, process.cwd()=${process.cwd()}`)
    this.sessionConfigs.set(sessionId, config)

    const abortController = new AbortController()
    this.abortControllers.set(sessionId, abortController)

    const options = this.buildQueryOptions(sessionId, config, abortController)
    const { session, inputStream } = await this.initSessionPipeline(sessionId, options)

    this.emit('status-change', sessionId, 'running')

    if (config.initialPrompt) {
      const userMsg: ConversationMessage = {
        id: uuidv4(),
        sessionId,
        role: 'user',
        content: config.initialPrompt,
        timestamp: new Date().toISOString(),
      }
      session.messages.push(userMsg)
      this.emit('conversation-message', sessionId, userMsg)

      inputStream.enqueue({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: config.initialPrompt }],
        },
      })
    } else {
      this.emit('status-change', sessionId, 'waiting_input')
    }
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const sdkQuery = this.sdkQueries.get(sessionId)
    const session = this.sessions.get(sessionId)
    if (!sdkQuery || !session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    // 防护：进程已死时不再向 inputStream 写入，避免 SDK 内部抛出
    // "ProcessTransport is not ready for writing" UnhandledPromiseRejection
    if (session.status === 'error') {
      logger.warn(`[ClaudeSdkAdapter] sendMessage: session ${sessionId} is in error state, dropping message`)
      return
    }

    // 记录用户消息 + 通知 UI
    const userMsg: ConversationMessage = {
      id: uuidv4(),
      sessionId,
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    }
    session.messages.push(userMsg)
    this.emit('conversation-message', sessionId, userMsg)

    // 更新状态
    session.status = 'running'
    this.emit('status-change', sessionId, 'running')

    // ★ 检查是否有 inputStream（多轮模式）
    const inputStream = this.inputStreams.get(sessionId)
    if (inputStream) {
      // 向 inputStream 推送 SDKUserMessage
      inputStream.enqueue({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: message }],
        },
      })
    } else {
      // 首轮是 string prompt，后续消息通过 streamInput 发送
      // 创建一个一次性 AsyncIterable 并用 streamInput 注入
      const oneShot = (async function* () {
        yield {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: message }],
          },
        }
      })()

      try {
        await sdkQuery.streamInput(oneShot)
      } catch (err: any) {
        logger.error(`[ClaudeSdkAdapter] streamInput failed for ${sessionId}:`, err)
        this.emitEvent(sessionId, {
          type: 'error',
          sessionId,
          timestamp: new Date().toISOString(),
          data: { text: `streamInput failed: ${err.message}` },
        })
      }
    }
  }

  async sendConfirmation(sessionId: string, accept: boolean): Promise<void> {
    const pending = this.pendingPermissions.get(sessionId)
    if (pending) {
      if (accept) {
        // 普通工具的 allow 格式：{ updatedInput: Record }（原样传回输入）
        // 不能用 { behavior: 'allow' }，否则 SDK Zod 校验失败
        pending.resolve({ updatedInput: pending.toolInput })
      } else {
        pending.resolve({ behavior: 'deny', message: 'User denied' })
      }
      this.pendingPermissions.delete(sessionId)
    }
  }

  /**
   * 发送 AskUserQuestion 的用户答案
   * 将答案格式化后作为 deny message 传递给 Claude（Claude 会从中提取答案继续执行）
   */
  async sendQuestionAnswer(sessionId: string, answers: Record<string, string>): Promise<void> {
    const pending = this.pendingQuestions.get(sessionId)
    if (!pending) return

    const questions = pending.toolInput.questions as Array<{ question: string; header?: string }> | undefined
    let answersText = '用户已通过 SpectrAI UI 回答了您的问题：\n'
    if (Array.isArray(questions)) {
      questions.forEach((q, i) => {
        const key = String(i)
        const answer = answers[key] || answers[q.header || ''] || answers[q.question] || '（未填写）'
        answersText += `• ${q.header || q.question}：${answer}\n`
      })
    } else {
      answersText += JSON.stringify(answers)
    }

    pending.resolve({ behavior: 'deny', message: answersText })
    this.pendingQuestions.delete(sessionId)
  }

  /**
   * 发送 ExitPlanMode 的用户审批结果
   * approved=true 允许退出计划模式；approved=false 保持计划模式
   */
  async sendPlanApproval(sessionId: string, approved: boolean): Promise<void> {
    const pending = this.pendingPlanApprovals.get(sessionId)
    if (!pending) return

    if (approved) {
      pending.resolve({ behavior: 'allow' })
    } else {
      pending.resolve({ behavior: 'deny', message: '用户拒绝了计划，请继续完善计划后再次提交。' })
    }
    this.pendingPlanApprovals.delete(sessionId)
  }

  /**
   * 软中断：中止当前轮次，会话保持活跃，等待用户下一条消息
   */
  async abortCurrentTurn(sessionId: string): Promise<void> {
    const abortController = this.abortControllers.get(sessionId)
    if (!abortController) {
      logger.warn(`[ClaudeSdkAdapter] abortCurrentTurn: no abortController for ${sessionId}`)
      return
    }
    const session = this.sessions.get(sessionId)
    if (!session || session.status !== 'running') {
      logger.warn(`[ClaudeSdkAdapter] abortCurrentTurn: session ${sessionId} not running (status=${session?.status})`)
      return
    }
    logger.info(`[ClaudeSdkAdapter] Soft abort for session ${sessionId}`)
    this.softAbortSessions.add(sessionId)
    abortController.abort()
  }

  /**
   * ★ 软中断公共处理逻辑：清理标记、发送友好提示、触发自动恢复
   * 被 consumeStream 的三个位置复用：
   *   1. case 'result' 检测到软中断时
   *   2. catch 块中捕获到中止异常时
   *   3. for-await 正常退出后检测到待处理软中断时
   */
  private handleSoftAbortCleanup(sessionId: string, session: AdapterSession | undefined): void {
    this.softAbortSessions.delete(sessionId)
    if (!session) return

    logger.info(`[ClaudeSdkAdapter] Soft abort cleanup for ${sessionId}, auto-resuming...`)

    // 发一条友好的系统消息告知用户
    const abortMsg: ConversationMessage = {
      id: uuidv4(),
      sessionId,
      role: 'system',
      content: '⏸ AI 思考已中断，可继续输入新消息。',
      timestamp: new Date().toISOString(),
    }
    session.messages.push(abortMsg)
    this.emit('conversation-message', sessionId, abortMsg)

    // 发 turn_complete 让前端切换回可输入状态
    this.emitEvent(sessionId, {
      type: 'turn_complete',
      sessionId,
      timestamp: new Date().toISOString(),
      data: { usage: { inputTokens: 0, outputTokens: 0 } },
    })

    // 重新 resume 等待用户下一条消息
    const config = this.sessionConfigs.get(sessionId)
    const providerSessionId = session.providerSessionId
    if (config && providerSessionId) {
      // 清理旧资源（sdkQuery 已失效，inputStream 需要重建）
      this.sdkQueries.delete(sessionId)
      const oldInputStream = this.inputStreams.get(sessionId)
      if (oldInputStream) {
        try { oldInputStream.close() } catch { /* ignore */ }
        this.inputStreams.delete(sessionId)
      }
      this.abortControllers.delete(sessionId)

      // 异步重新 resume（不 await，避免阻塞）
      this.resumeSession(sessionId, providerSessionId, config).catch(resumeErr => {
        logger.error(`[ClaudeSdkAdapter] Auto-resume after soft abort failed for ${sessionId}:`, resumeErr)
      })
    } else {
      // 无法 resume 时退化：状态切回 waiting_input，用户至少知道 AI 停了
      session.status = 'waiting_input'
      this.emit('status-change', sessionId, 'waiting_input')
      logger.warn(`[ClaudeSdkAdapter] Cannot auto-resume ${sessionId}: no providerSessionId or config`)
    }
  }

  async terminateSession(sessionId: string): Promise<void> {
    const sdkQuery = this.sdkQueries.get(sessionId)
    const session = this.sessions.get(sessionId)
    const abortController = this.abortControllers.get(sessionId)

    // 关闭 inputStream
    const inputStream = this.inputStreams.get(sessionId)
    if (inputStream) {
      inputStream.close()
      this.inputStreams.delete(sessionId)
    }

    if (abortController) {
      abortController.abort()
      this.abortControllers.delete(sessionId)
    }

    if (sdkQuery) {
      try {
        sdkQuery.close()
      } catch (err) {
        logger.warn(`[ClaudeSdkAdapter] Error closing query ${sessionId}:`, err)
      }
      this.sdkQueries.delete(sessionId)
    }

    if (session) {
      session.status = 'completed'
      this.emit('status-change', sessionId, 'completed')
    }

    // 清理挂起的交互式工具队列
    this.pendingQuestions.delete(sessionId)
    this.pendingPlanApprovals.delete(sessionId)
    this.sessionStderr.delete(sessionId)

    this.emitEvent(sessionId, {
      type: 'session_complete',
      sessionId,
      timestamp: new Date().toISOString(),
      data: { exitCode: 0 },
    })
  }

  async resumeSession(
    sessionId: string,
    providerSessionId: string,
    config: AdapterSessionConfig
  ): Promise<void> {
    const cwd = this.normalizeWorkingDir(config.workingDirectory)
    logger.info(`[ClaudeSdkAdapter] resumeSession ${sessionId}: cwd=${cwd}, resume=${providerSessionId}, process.cwd()=${process.cwd()}`)
    this.sessionConfigs.set(sessionId, config)

    const abortController = new AbortController()
    this.abortControllers.set(sessionId, abortController)

    // ★ 复用 buildQueryOptions —— resume 路径现在也会收集 stderr
    const options = this.buildQueryOptions(sessionId, config, abortController, {
      resume: providerSessionId,
    })

    await this.initSessionPipeline(sessionId, options, {
      providerSessionId,
      initialStatus: 'waiting_input',
    })

    this.emit('status-change', sessionId, 'waiting_input')
  }

  getConversation(sessionId: string): ConversationMessage[] {
    const session = this.sessions.get(sessionId)
    return session?.messages || []
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  getProviderSessionId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.providerSessionId
  }

  cleanup(): void {
    for (const [sessionId] of this.sdkQueries) {
      try {
        this.terminateSession(sessionId)
      } catch (err) {
        logger.error(`[ClaudeSdkAdapter] Error terminating session ${sessionId} during cleanup:`, err)
      }
    }
    this.sessions.clear()
    this.sdkQueries.clear()
    this.inputStreams.clear()
    this.abortControllers.clear()
    this.pendingPermissions.clear()
    this.pendingQuestions.clear()
    this.pendingPlanApprovals.clear()
  }

  // ---- 内部方法 ----

  /** 权限请求挂起队列 */
  private pendingPermissions: Map<string, {
    resolve: (result: any) => void
    toolName: string
    toolInput: Record<string, unknown>
  }> = new Map()

  /**
   * 创建权限回调函数（autoAccept 和非 autoAccept 会话均使用）
   *
   * autoAccept=true：
   *   - ExitPlanMode → 自动批准（不弹面板），同时发出 exit_plan_mode 事件供 UI 展示
   *   - AskUserQuestion → 仍弹面板（需要用户回答才能继续）
   *   - 普通工具 → 立即返回 allow（与 bypassPermissions 行为一致，兜底处理）
   *
   * autoAccept=false：
   *   - ExitPlanMode → 弹计划审批面板，等待用户确认
   *   - AskUserQuestion → 弹问题面板，等待用户回答
   *   - 普通工具 → 弹权限确认对话框
   *
   * @param sessionId 会话 ID
   * @param isAutoAccept 是否为 autoAccept 模式
   */
  private createPermissionHandler(sessionId: string, isAutoAccept: boolean = false) {
    return async (
      toolName: string,
      input: Record<string, unknown>,
      _options: any
    ): Promise<any> => {
      // ★ AskUserQuestion：始终弹面板等待用户回答（autoAccept 也需要用户介入）
      if (toolName === 'AskUserQuestion') {
        return new Promise((resolve) => {
          this.pendingQuestions.set(sessionId, { resolve, toolInput: input })
          this.emitEvent(sessionId, {
            type: 'ask_user_question',
            sessionId,
            timestamp: new Date().toISOString(),
            data: { toolInput: input },
          })
        })
      }

      // ★ ExitPlanMode：
      //   autoAccept → 自动批准（发出事件让 UI 展示，但不等用户点击）
      //   非 autoAccept → 弹计划审批面板，等待用户确认
      if (toolName === 'ExitPlanMode') {
        if (isAutoAccept) {
          // autoAccept 模式：发出事件（UI 可展示），直接返回 allow
          this.emitEvent(sessionId, {
            type: 'exit_plan_mode',
            sessionId,
            timestamp: new Date().toISOString(),
            data: { toolInput: input },
          })
          return { behavior: 'allow' }
        }
        // 非 autoAccept：弹面板等用户审批
        return new Promise((resolve) => {
          this.pendingPlanApprovals.set(sessionId, { resolve, toolInput: input })
          this.emitEvent(sessionId, {
            type: 'exit_plan_mode',
            sessionId,
            timestamp: new Date().toISOString(),
            data: { toolInput: input },
          })
        })
      }

      // 普通工具：
      //   autoAccept → 立即放行（兜底）
      //   非 autoAccept → 弹权限确认对话框
      //
      // ⚠️ 普通工具（包括 MCP 工具 spawn_agent 等）的 "allow" 返回格式不是 { behavior: 'allow' }，
      //    而是 { updatedInput: Record }（将工具输入原样传回），否则 SDK Zod 校验会报
      //    invalid_union 错误。{ behavior: 'allow' } 仅用于 ExitPlanMode 等生命周期工具。
      if (isAutoAccept) {
        return { updatedInput: input }
      }

      return new Promise((resolve) => {
        this.pendingPermissions.set(sessionId, { resolve, toolName, toolInput: input })
        this.emitEvent(sessionId, {
          type: 'permission_request',
          sessionId,
          timestamp: new Date().toISOString(),
          data: {
            toolName,
            toolInput: input,
            permissionPrompt: `Allow ${toolName}?`,
          },
        })
      })
    }
  }

  // ── 流消息可变状态（在各 handler 间共享） ────────────────────
  private streamState = new Map<string, { assistantText: string; thinkingText: string }>()

  /**
   * ★ 异步流消费循环
   * V1 Query 实现了 AsyncGenerator<SDKMessage>，消息类型与 V2 相同。
   * 各 msg.type 分支通过 streamMessageHandlers map 分派到子方法。
   */
  private async consumeStream(sessionId: string, sdkQuery: SDKQuery): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    this.streamState.set(sessionId, { assistantText: '', thinkingText: '' })

    try {
      for await (const msg of sdkQuery) {
        if (!session.providerSessionId && msg.session_id) {
          session.providerSessionId = msg.session_id
          this.emit('provider-session-id', sessionId, msg.session_id)
        }

        const handler = this.streamMessageHandlers[msg.type]
        if (handler) {
          // result handler 可能 return true 表示退出循环
          const shouldReturn = handler(sessionId, session, msg)
          if (shouldReturn) return
        }
      }

      // ★ Fix3: for-await 正常退出后检查是否有待处理的软中断
      if (this.softAbortSessions.has(sessionId)) {
        logger.info(`[ClaudeSdkAdapter] Soft abort detected after normal loop exit for ${sessionId}`)
        this.handleSoftAbortCleanup(sessionId, session)
        return
      }

    } catch (err: any) {
      // ★ Fix2: 扩大 abort 错误检测范围
      // SDK 可能抛出 APIUserAbortError（name="Error"）或 DOMException（name="AbortError"）
      // 同时兼容所有 abort 相关的异常，避免因 name 不匹配而进入错误分支
      const isAbortError = err.name === 'AbortError' ||
        /abort/i.test(err.name || '') ||
        err.constructor?.name?.includes?.('UserAbort') ||
        err.constructor?.name?.includes?.('Abort') ||
        // 兜底：根据错误消息判断（SDK message: "Request was aborted."）
        /\baborted\b/i.test(err.message || '')

      if (isAbortError) {
        const isSoft = this.softAbortSessions.has(sessionId)
        this.softAbortSessions.delete(sessionId)
        if (isSoft && session) {
          logger.info(`[ClaudeSdkAdapter] Soft abort via exception for ${sessionId}, err.name=${err.name}`)
          this.handleSoftAbortCleanup(sessionId, session)
        }
        return
      }
      logger.error(`[ClaudeSdkAdapter] Stream error for ${sessionId}:`, err)

      // ★ 针对进程退出错误，优先用 stderr 内容生成有意义的错误提示
      const isProcessExit = /process exited with code/i.test(err.message)
      let errorText: string
      if (isProcessExit) {
        const stderrLines = this.sessionStderr.get(sessionId) || []
        const stderrText = stderrLines.join('\n')
        this.sessionStderr.delete(sessionId) // 清理缓冲

        if (stderrText.toLowerCase().includes('git-bash') || stderrText.toLowerCase().includes('git bash')) {
          // Claude Code 明确要求 git-bash，给用户清晰的安装指引
          errorText =
            'Claude Code 在 Windows 上需要安装 Git（含 git-bash）才能运行。\n\n' +
            '请前往 https://git-scm.com/downloads/win 下载安装，\n' +
            '安装完成后重启 SpectrAI 即可。\n\n' +
            `（原始错误：${err.message}）`
        } else if (stderrText) {
          // 有 stderr 输出但不是已知错误，把 stderr 内容直接展示给用户
          errorText =
            `Claude Code 进程异常退出 (${err.message})。\n\n` +
            `错误详情：\n${stderrText}`
        } else {
          errorText = `Claude Code 进程异常退出 (${err.message})。请查看日志面板中的 stderr 输出了解详情。`
        }
      } else {
        this.sessionStderr.delete(sessionId)
        // ENOENT：Node.js 无法找到可执行文件（node 二进制或 cli.js 路径不存在）
        // 给用户更直观的提示，而非原始的 "spawn ENOENT"
        const isEnoent = /ENOENT/i.test(err.message || '')
        if (isEnoent) {
          errorText =
            `启动失败：找不到可执行文件（${err.message}）。\n\n` +
            (process.platform === 'win32'
              ? '请确认 Node.js 和 claude-code 已正确安装，或在设置中手动指定 cli.js 路径。\n' +
                '安装命令：npm install -g @anthropic-ai/claude-code'
              : '请确认 Node.js 和 claude-code 已正确安装。\n' +
                '安装命令：npm install -g @anthropic-ai/claude-code')
        } else {
          errorText = err.message || String(err)
        }
      }

      // 推送错误到对话（让用户能看到）
      const errMsg: ConversationMessage = {
        id: uuidv4(),
        sessionId,
        role: 'system',
        content: `错误: ${errorText}`,
        timestamp: new Date().toISOString(),
      }
      session.messages.push(errMsg)
      this.emit('conversation-message', sessionId, errMsg)

      this.emitEvent(sessionId, {
        type: 'error',
        sessionId,
        timestamp: new Date().toISOString(),
        data: { text: errorText },
      })
      session.status = 'error'
      this.emit('status-change', sessionId, 'error')

      // ★ 关闭 inputStream，阻止 SDK 内部继续向已死亡进程写入
      // 不关闭的话，用户在错误状态下发消息会触发 SDK 内部 ProcessTransport 报错，
      // 进而产生 UnhandledPromiseRejectionWarning
      const deadInputStream = this.inputStreams.get(sessionId)
      if (deadInputStream) {
        try { deadInputStream.close() } catch { /* ignore */ }
        this.inputStreams.delete(sessionId)
      }
    }
  }

  // ── Stream Message Handler Map ──────────────────────────────
  // 将 consumeStream 的 switch(msg.type) 分支拆为独立子方法。
  // handler 返回 true 表示退出消费循环。

  private readonly streamMessageHandlers: Record<
    string,
    (sid: string, session: AdapterSession, msg: any) => boolean | void
  > = {
    system: (sid, _session, msg) => { this.onStreamSystem(sid, msg) },
    stream_event: (sid, _session, msg) => { this.onStreamEvent(sid, msg) },
    assistant: (sid, session, msg) => { this.onStreamAssistant(sid, session, msg) },
    user: (sid, session, msg) => { this.onStreamUser(sid, session, msg) },
    result: (sid, session, msg) => { return this.onStreamResult(sid, session, msg) },
  }

  /** system.init → 日志 + 发射 session-init-data */
  private onStreamSystem(sessionId: string, msg: any): void {
    if (msg.subtype !== 'init') return
    const tools = msg.tools || []
    const mcpTools = tools.filter((t: string) => t.startsWith('mcp__'))
    const builtinTools = tools.filter((t: string) => !t.startsWith('mcp__'))
    logger.info(
      `[ClaudeSdkAdapter] Session ${sessionId} init:` +
      ` model=${msg.model}` +
      `, tools=${tools.length} (builtin=${builtinTools.length}, mcp=${mcpTools.length})` +
      (msg.mcp_servers ? `, mcp_servers=${JSON.stringify(msg.mcp_servers.map((s: any) => s.name || s))}` : '') +
      (msg.skills ? `, skills=${msg.skills.length}` : '') +
      (msg.plugins ? `, plugins=${msg.plugins.length}` : '')
    )
    if (msg.skills && msg.skills.length > 0) {
      logger.info(`[ClaudeSdkAdapter] Skills sample: ${JSON.stringify(msg.skills.slice(0, 3))}`)
    }
    this.emit('session-init-data', sessionId, {
      model: msg.model, tools,
      mcpServers: msg.mcp_servers || [], skills: msg.skills || [], plugins: msg.plugins || [],
    })
    const q = this.sdkQueries.get(sessionId)
    if (q) {
      q.supportedCommands().then(commands => {
        if (commands && commands.length > 0) {
          logger.info(`[ClaudeSdkAdapter] supportedCommands: ${commands.length}, sample: ${JSON.stringify(commands.slice(0, 3))}`)
          this.emit('session-init-data', sessionId, {
            model: msg.model, tools,
            mcpServers: msg.mcp_servers || [], skills: commands, plugins: msg.plugins || [],
          })
        }
      }).catch(err => { logger.warn(`[ClaudeSdkAdapter] supportedCommands() failed:`, err) })
    }
  }

  /** stream_event → 增量 delta 推送 + 维护文本缓存 */
  private onStreamEvent(sessionId: string, msg: any): void {
    this.handleStreamEvent(sessionId, msg)
    const state = this.streamState.get(sessionId)
    if (!state) return
    const event = msg.event
    if (event?.delta?.type === 'text_delta') {
      state.assistantText += event.delta.text || ''
    } else if (event?.delta?.type === 'thinking_delta') {
      state.thinkingText += event.delta.thinking || ''
    }
  }

  /** assistant → 完整消息 + 工具调用 */
  private onStreamAssistant(sessionId: string, session: AdapterSession, msg: any): void {
    const { text, thinking, toolUses } = this.parseAssistantMessage(msg)
    const state = this.streamState.get(sessionId)

    if (text) {
      if (state) state.assistantText = text
      const assistantMsg: ConversationMessage = {
        id: msg.uuid || uuidv4(), sessionId, role: 'assistant', content: text,
        timestamp: new Date().toISOString(),
        thinkingText: thinking || undefined,
        usage: msg.message?.usage ? {
          inputTokens: msg.message.usage.input_tokens || 0,
          outputTokens: msg.message.usage.output_tokens || 0,
        } : undefined,
      }
      session.messages.push(assistantMsg)
      this.emit('conversation-message', sessionId, assistantMsg)
      if (msg.message?.usage) {
        session.totalUsage.inputTokens += msg.message.usage.input_tokens || 0
        session.totalUsage.outputTokens += msg.message.usage.output_tokens || 0
      }
    }

    for (const tu of toolUses) {
      this.emitEvent(sessionId, {
        type: 'tool_use_start', sessionId, timestamp: new Date().toISOString(),
        data: { toolName: tu.name, toolInput: tu.input, toolUseId: tu.id },
      })
      const toolMsg: ConversationMessage = {
        id: uuidv4(), sessionId, role: 'tool_use',
        content: extractToolDetail(tu.name, tu.input || {}),
        timestamp: new Date().toISOString(),
        toolName: tu.name, toolInput: tu.input, toolUseId: tu.id,
      }
      session.messages.push(toolMsg)
      this.emit('conversation-message', sessionId, toolMsg)
    }

    if (state) { state.assistantText = ''; state.thinkingText = '' }
  }

  /** user → 工具执行结果 */
  private onStreamUser(sessionId: string, session: AdapterSession, msg: any): void {
    if (msg.tool_use_result === undefined && !msg.isSynthetic) return
    const contentBlocks = msg.message?.content || []
    for (const block of contentBlocks) {
      if (block.type !== 'tool_result') continue
      const resultContent = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content.map((c: any) => c.text || '').join('\n')
          : JSON.stringify(block.content)
      this.emitEvent(sessionId, {
        type: 'tool_use_end', sessionId, timestamp: new Date().toISOString(),
        data: { toolResult: resultContent, isError: block.is_error || false, toolUseId: block.tool_use_id },
      })
      const resultMsg: ConversationMessage = {
        id: uuidv4(), sessionId, role: 'tool_result',
        content: resultContent.slice(0, 1000), timestamp: new Date().toISOString(),
        toolResult: resultContent, isError: block.is_error || false, toolUseId: block.tool_use_id,
      }
      session.messages.push(resultMsg)
      this.emit('conversation-message', sessionId, resultMsg)
    }
  }

  /** result → turn 结束 / 软中断检测。返回 true 表示退出消费循环 */
  private onStreamResult(sessionId: string, session: AdapterSession, msg: any): boolean {
    if (this.softAbortSessions.has(sessionId)) {
      logger.info(`[ClaudeSdkAdapter] Soft abort detected in result message for ${sessionId}`)
      this.handleSoftAbortCleanup(sessionId, session)
      return true
    }

    const isSuccess = msg.subtype === 'success'
    if (msg.usage) {
      session.totalUsage.inputTokens = msg.usage.input_tokens || session.totalUsage.inputTokens
      session.totalUsage.outputTokens = msg.usage.output_tokens || session.totalUsage.outputTokens
    }
    if (!isSuccess && msg.result) {
      logger.error(`[ClaudeSdkAdapter] Session ${sessionId} result failure: ${msg.result}`)
      const errMsg: ConversationMessage = {
        id: uuidv4(), sessionId, role: 'system',
        content: `错误: ${msg.result}`, timestamp: new Date().toISOString(),
      }
      session.messages.push(errMsg)
      this.emit('conversation-message', sessionId, errMsg)
    }
    this.emitEvent(sessionId, {
      type: 'turn_complete', sessionId, timestamp: new Date().toISOString(),
      data: {
        usage: { inputTokens: msg.usage?.input_tokens || 0, outputTokens: msg.usage?.output_tokens || 0 },
        text: isSuccess ? msg.result : undefined, exitCode: isSuccess ? 0 : 1,
      },
    })
    session.status = 'waiting_input'
    this.emit('status-change', sessionId, 'waiting_input')
    this.streamState.delete(sessionId)
    return false
  }

  /**
   * 处理 stream_event（增量流式事件）
   */
  private handleStreamEvent(
    sessionId: string,
    msg: any,
  ): void {
    const event = msg.event
    if (!event) return

    if (event.type === 'content_block_delta') {
      const delta = event.delta
      if (!delta) return

      if (delta.type === 'text_delta' && delta.text) {
        this.emitEvent(sessionId, {
          type: 'text_delta',
          sessionId,
          timestamp: new Date().toISOString(),
          data: { text: delta.text },
        })
      } else if (delta.type === 'thinking_delta' && delta.thinking) {
        this.emitEvent(sessionId, {
          type: 'thinking',
          sessionId,
          timestamp: new Date().toISOString(),
          data: { text: delta.thinking },
        })
      }
    }
  }

  /**
   * 解析完整的 assistant 消息
   */
  private parseAssistantMessage(msg: any): {
    text: string
    thinking: string
    toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>
  } {
    const content = msg.message?.content || []
    let text = ''
    let thinking = ''
    const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = []

    for (const block of content) {
      switch (block.type) {
        case 'text':
          text += block.text || ''
          break
        case 'thinking':
          thinking += block.thinking || ''
          break
        case 'tool_use':
          toolUses.push({
            id: block.id || uuidv4(),
            name: block.name || 'unknown',
            input: block.input || {},
          })
          break
      }
    }

    return { text, thinking, toolUses }
  }

  /**
   * 发射标准化事件
   */
  /**
   * 主动获取 supportedCommands 并发射 session-init-data
   * 不依赖 system.init 消息（空会话未发送消息前不会收到 system.init）
   */
  private fetchAndEmitInitData(sessionId: string, sdkQuery: SDKQuery): void {
    // 延迟 2 秒，等 CLI 进程完成初始化
    setTimeout(() => {
      sdkQuery.supportedCommands().then(commands => {
        if (commands && commands.length > 0) {
          logger.info(`[ClaudeSdkAdapter] Proactive supportedCommands for ${sessionId}: ${commands.length}, sample: ${JSON.stringify(commands.slice(0, 2))}`)
          this.emit('session-init-data', sessionId, {
            model: '',
            tools: [],
            mcpServers: [],
            skills: commands,
            plugins: [],
          })
        }
      }).catch(err => {
        // 首次可能失败（CLI 还没就绪），5 秒后重试一次
        logger.debug(`[ClaudeSdkAdapter] supportedCommands() first attempt failed for ${sessionId}, retrying in 5s...`)
        setTimeout(() => {
          const q = this.sdkQueries.get(sessionId)
          if (!q) return
          q.supportedCommands().then(commands => {
            if (commands && commands.length > 0) {
              logger.info(`[ClaudeSdkAdapter] Retry supportedCommands for ${sessionId}: ${commands.length}`)
              this.emit('session-init-data', sessionId, {
                model: '',
                tools: [],
                mcpServers: [],
                skills: commands,
                plugins: [],
              })
            }
          }).catch(retryErr => {
            logger.warn(`[ClaudeSdkAdapter] supportedCommands() retry failed for ${sessionId}:`, retryErr)
          })
        }, 5000)
      })
    }, 2000)
  }

  private emitEvent(sessionId: string, event: ProviderEvent): void {
    this.emit('event', event)
  }
}
