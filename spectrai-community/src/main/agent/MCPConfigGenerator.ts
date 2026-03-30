/**
 * MCPConfigGenerator - 为每个启用 Agent 编排的会话生成临时 MCP 配置文件
 * @author weibin
 */

import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { execSync } from 'child_process'
import type { DatabaseManager } from '../storage/Database'

/** MCP 配置目录（Claude Code 用） */
const MCP_CONFIG_DIR = path.join(os.homedir(), '.claudeops', 'mcp')

/** Codex 临时 CODEX_HOME 目录基础路径 */
const CODEX_TEMP_BASE_DIR = path.join(os.tmpdir(), 'spectrai-codex')

/** OpenCode 临时配置文件目录基础路径 */
const OPENCODE_TEMP_BASE_DIR = path.join(os.tmpdir(), 'spectrai-opencode')

/**
 * 获取 AgentMCPServer 的脚本路径
 * 开发模式：out/main/agent/AgentMCPServer.js（__dirname 在 asar 外）
 * 生产模式：resources/app.asar.unpacked/out/main/agent/AgentMCPServer.js
 *
 * 关键：AgentMCPServer 作为独立 Node.js 子进程运行（非 Electron 进程），
 * 因此不能指向 app.asar 内的路径，必须指向 app.asar.unpacked。
 */
function getMCPServerPath(): string {
  // electron-vite 构建输出到 out/main/
  const devPath = path.join(__dirname, 'agent', 'AgentMCPServer.js')

  // 生产模式下 __dirname 可能指向 app.asar/out/main，
  // 需要替换为 app.asar.unpacked 以便 Node.js 子进程可以读取
  const unpackedPath = devPath.replace(/app\.asar([\\\/])/, 'app.asar.unpacked$1')

  // 优先使用 unpacked 路径（生产模式）
  if (unpackedPath !== devPath && fs.existsSync(unpackedPath)) {
    return unpackedPath
  }

  // 开发模式：文件直接在 out/main/agent/ 下
  if (fs.existsSync(devPath)) return devPath

  // 同目录（多入口构建后平铺）
  const sameDirPath = path.join(__dirname, 'AgentMCPServer.js')
  const sameDirUnpacked = sameDirPath.replace(/app\.asar([\\\/])/, 'app.asar.unpacked$1')
  if (sameDirUnpacked !== sameDirPath && fs.existsSync(sameDirUnpacked)) {
    return sameDirUnpacked
  }
  if (fs.existsSync(sameDirPath)) return sameDirPath

  // 兜底：返回 unpacked 路径
  return unpackedPath
}

/** 追踪各会话创建的 Codex 临时目录，用于精确清理 */
const codexTempDirs = new Map<string, string>()

/** 追踪各会话创建的 OpenCode 临时配置文件路径，用于精确清理 */
const opencodeTempConfigs = new Map<string, string>()

/**
 * 获取 node 可执行文件的完整路径（通过 shell 查找，缓存结果）。
 * 直接写 'node' 会因 Electron 不继承完整 shell PATH（如 NVM 路径）而 ENOENT。
 */
let _cachedNodeCommand: string | null = null
function getNodeCommand(): string {
  if (_cachedNodeCommand) return _cachedNodeCommand
  try {
    const cmd = process.platform === 'win32' ? 'where node' : 'which node'
    const result = execSync(cmd, { encoding: 'utf8', timeout: 5000 })
      .trim().split(/\r?\n/)[0].trim()
    if (result) {
      _cachedNodeCommand = result
      console.log(`[MCPConfig] Resolved node command: ${result}`)
      return result
    }
  } catch { /* ignore */ }
  // 兜底：直接用 'node'，让系统 PATH 处理（开发模式一般可用）
  _cachedNodeCommand = 'node'
  return 'node'
}

export class MCPConfigGenerator {
  /**
   * 为指定会话生成 MCP 配置文件（Claude Code / iFlow 使用 JSON 格式）
   *
   * @param bridgePort - Agent Bridge 端口。
   *   > 0：Supervisor 模式，同时注入 spectrai-agent 系统 MCP + 用户 MCP
   *   = 0：普通会话，仅注入用户 MCP（不含 spectrai-agent）
   * @returns 配置文件路径
   */
  static generate(
    sessionId: string,
    bridgePort: number,
    workDir: string,
    providerId?: string,
    database?: DatabaseManager,
    sessionMode?: 'supervisor' | 'member' | 'awareness'
  ): string {
    // 确保目录存在
    if (!fs.existsSync(MCP_CONFIG_DIR)) {
      fs.mkdirSync(MCP_CONFIG_DIR, { recursive: true })
    }

    const configPath = path.join(MCP_CONFIG_DIR, `mcp-config-${sessionId}.json`)
    const serverPath = getMCPServerPath()

    const config: { mcpServers: Record<string, any> } = { mcpServers: {} }

    // spectrai-agent 系统 MCP：仅 Supervisor/Agent 编排模式（bridgePort > 0）才注入
    // 普通对话不需要跨会话编排能力，跳过可避免无效子进程
    if (bridgePort > 0) {
      config.mcpServers['spectrai-agent'] = {
        command: getNodeCommand(),
        args: [serverPath],
        env: {
          CLAUDEOPS_SESSION_ID: sessionId,
          CLAUDEOPS_BRIDGE_PORT: String(bridgePort),
          CLAUDEOPS_WORK_DIR: workDir,
          CLAUDEOPS_SESSION_MODE: sessionMode || 'supervisor'
        }
      }
    }

    // 注入用户配置的 MCP（所有会话均注入，不依赖 Supervisor 模式）
    // generate() 仅供 claude-code / iflow 调用，无需再做 provider 过滤
    if (providerId && database) {
      try {
        const userMcps = database.getEnabledMcpsForProvider(providerId)
        for (const mcp of userMcps) {
          if (mcp.transport === 'stdio' && mcp.command) {
            config.mcpServers[mcp.id] = {
              command: mcp.command,
              args: mcp.args || [],
              env: {
                ...(mcp.envVars || {}),
                ...(mcp.userConfig ? Object.fromEntries(
                  Object.entries(mcp.userConfig).map(([k, v]) => [k, String(v)])
                ) : {}),
              },
            }
          } else if ((mcp.transport === 'http' || mcp.transport === 'sse') && mcp.url) {
            config.mcpServers[mcp.id] = {
              type: mcp.transport,
              url: mcp.url,
              ...(mcp.headers && Object.keys(mcp.headers).length > 0 ? { headers: mcp.headers } : {}),
            }
          }
        }
        console.log(`[MCPConfig] Injected ${userMcps.length} user MCP(s) for provider '${providerId}'`)
      } catch (err) {
        console.error('[MCPConfigGenerator] Failed to inject user MCPs:', err)
      }
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    console.log(`[MCPConfig] Generated config: ${configPath} (bridgePort=${bridgePort}, mcpServers=${Object.keys(config.mcpServers).length})`)
    return configPath
  }

  /**
   * 为 Codex 会话生成临时 CODEX_HOME 目录，内含 config.toml 和 MCP 配置。
   *
   * 原理：Codex 通过 CODEX_HOME 环境变量重定向整个配置目录（等价于 Claude Code 的 --mcp-config）。
   * 每个会话使用独立临时目录，保证并发隔离。
   *
   * @param bridgePort - Agent Bridge 端口。
   *   > 0：Supervisor 模式，同时注入 spectrai-agent 系统 MCP + 用户 MCP
   *   = 0：普通会话，仅注入用户 MCP（不含 spectrai-agent）
   * @returns 临时 CODEX_HOME 目录路径（调用方需将其注入 CODEX_HOME 环境变量）
   */
  static generateForCodex(
    sessionId: string,
    bridgePort: number,
    workDir: string,
    providerId?: string,
    database?: DatabaseManager,
    sessionMode?: 'supervisor' | 'member' | 'awareness'
  ): string {
    const tempDir = path.join(CODEX_TEMP_BASE_DIR, sessionId)

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }

    const serverPath = getMCPServerPath()

    // 生成 TOML 格式的 config.toml（Codex 使用 TOML，不是 JSON）
    // 注意：Windows 路径中的反斜杠在 TOML 字符串中需要转义
    const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const escapedServerPath = escape(serverPath)

    const tomlLines = [
      '# SpectrAI 自动生成 - MCP 配置',
      '# 此文件由 MCPConfigGenerator 管理，请勿手动编辑',
      '',
    ]

    // ★ 关键：先从全局 config.toml 提取顶层字段（model, model_provider 等）
    // TOML 规范要求顶层 key=value 必须出现在所有 [section] 之前，
    // 否则会被解析为最后一个 section 的子键
    const globalCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
    const globalConfigPath = path.join(globalCodexHome, 'config.toml')
    const modelProviderBlocks: string[] = []
    try {
      if (fs.existsSync(globalConfigPath)) {
        const globalToml = fs.readFileSync(globalConfigPath, 'utf-8')
        const lines = globalToml.split(/\r?\n/)

        // 1. 提取顶层键值对（在第一个 [section] 之前的 key = value 行）
        const topLevelKeys = new Set([
          'model', 'model_provider', 'model_reasoning_effort',
          'disable_response_storage', 'sandbox_mode', 'approval_policy',
        ])
        const inheritedTopLevel: string[] = []
        for (const line of lines) {
          if (/^\[/.test(line)) break
          const match = line.match(/^(\w+)\s*=/)
          if (match && topLevelKeys.has(match[1])) {
            inheritedTopLevel.push(line)
          }
        }
        if (inheritedTopLevel.length > 0) {
          tomlLines.push('# 从全局 config.toml 继承的顶层配置')
          tomlLines.push(...inheritedTopLevel)
          tomlLines.push('')
          console.log(`[MCPConfig] Codex: Inherited top-level keys: ${inheritedTopLevel.map(l => l.split('=')[0].trim()).join(', ')}`)
        }

        // 2. 提取所有 [model_providers.*] 块（稍后在 MCP sections 之后追加）
        let inModelProvider = false
        let currentBlock: string[] = []
        for (const line of lines) {
          const isTopSection = /^\[(?!\[)/.test(line)
          if (isTopSection) {
            if (inModelProvider && currentBlock.length > 0) {
              modelProviderBlocks.push(currentBlock.join('\n'))
              currentBlock = []
            }
            inModelProvider = /^\[model_providers\./.test(line)
          }
          if (inModelProvider) {
            currentBlock.push(line)
          }
        }
        if (inModelProvider && currentBlock.length > 0) {
          modelProviderBlocks.push(currentBlock.join('\n'))
        }
      }
    } catch (err) {
      console.warn(`[MCPConfig] Could not read global config.toml: ${err}`)
    }

    // spectrai-agent 系统 MCP：仅 Supervisor/Agent 编排模式（bridgePort > 0）才注入
    if (bridgePort > 0) {
      tomlLines.push(
        '[mcp_servers.spectrai-agent]',
        'command = "node"',
        `args = ["${escapedServerPath}"]`,
        '',
        '[mcp_servers.spectrai-agent.env]',
        `CLAUDEOPS_SESSION_ID = "${sessionId}"`,
        `CLAUDEOPS_BRIDGE_PORT = "${bridgePort}"`,
        `CLAUDEOPS_WORK_DIR = "${escape(workDir)}"`,
        `CLAUDEOPS_SESSION_MODE = "${sessionMode || 'supervisor'}"`,
      )
    }

    // 注入用户配置的 MCP（Codex 原生支持，TOML 格式）
    if (providerId && database) {
      try {
        const userMcps = database.getEnabledMcpsForProvider(providerId)
        const injected: string[] = []
        for (const mcp of userMcps) {
          if (mcp.transport === 'stdio' && mcp.command) {
            // TOML key 安全：只允许 A-Za-z0-9_- 的裸键，否则加引号
            const safeKey = /^[A-Za-z0-9_-]+$/.test(mcp.id) ? mcp.id : `"${escape(mcp.id)}"`
            tomlLines.push('', `[mcp_servers.${safeKey}]`)
            tomlLines.push(`command = "${escape(mcp.command)}"`)
            if (mcp.args?.length) {
              const argsStr = mcp.args.map(a => `"${escape(a)}"`).join(', ')
              tomlLines.push(`args = [${argsStr}]`)
            }
            const envEntries: Record<string, string> = {
              ...(mcp.envVars || {}),
              ...(mcp.userConfig
                ? Object.fromEntries(Object.entries(mcp.userConfig).map(([k, v]) => [k, String(v)]))
                : {}),
            }
            if (Object.keys(envEntries).length > 0) {
              tomlLines.push('', `[mcp_servers.${safeKey}.env]`)
              for (const [k, v] of Object.entries(envEntries)) {
                tomlLines.push(`${k} = "${escape(v)}"`)
              }
            }
            injected.push(`${mcp.name}(${mcp.command})`)
            console.log(`[MCPConfig] Codex: Injecting MCP "${mcp.name}" id=${mcp.id} command=${mcp.command} args=${JSON.stringify(mcp.args || [])}`)
          }
          // http/sse：Codex 暂不支持 URL 类型 MCP，跳过
        }
        console.log(`[MCPConfig] Codex: Injected ${injected.length}/${userMcps.length} user MCP(s) (bridgePort=${bridgePort}): ${injected.join(', ') || '(none)'}`)
      } catch (err) {
        console.error('[MCPConfigGenerator] Failed to inject user MCPs for Codex:', err)
      }
    }

    // 追加 [model_providers.*] 块（已在顶部提取，这里放在所有 [section] 之后）
    if (modelProviderBlocks.length > 0) {
      tomlLines.push('', '# 从全局 config.toml 继承的 model_providers 配置')
      tomlLines.push(...modelProviderBlocks)
      console.log(`[MCPConfig] Codex: Inherited ${modelProviderBlocks.length} model_provider(s) from global config.toml`)
    }

    const tomlContent = tomlLines.join('\n')
    fs.writeFileSync(path.join(tempDir, 'config.toml'), tomlContent, 'utf-8')
    // 诊断：打印完整 TOML（排查 MCP 配置导致 Codex 挂起问题）
    console.log(`[MCPConfig] Codex config.toml:\n${tomlContent}`)

    // 复制 auth.json（Codex 认证文件，也存放在 CODEX_HOME 下）
    const authSrc = path.join(globalCodexHome, 'auth.json')
    const authDst = path.join(tempDir, 'auth.json')
    try {
      if (fs.existsSync(authSrc)) {
        fs.copyFileSync(authSrc, authDst)
      }
    } catch (err) {
      // auth.json 不存在或无权限时忽略，Codex 会使用 CODEX_API_KEY 环境变量
      console.warn(`[MCPConfig] Could not copy Codex auth.json: ${err}`)
    }

    // 追踪此会话的临时目录
    codexTempDirs.set(sessionId, tempDir)
    console.log(`[MCPConfig] Generated Codex CODEX_HOME: ${tempDir}`)
    return tempDir
  }

  /**
   * 为 OpenCode 会话生成临时配置文件，内含 spectrai-agent MCP 配置。
   *
   * 原理：OpenCode 支持通过 OPENCODE_CONFIG 环境变量指定额外配置文件，
   * 配置文件中可定义 mcp servers（JSON 格式，key 为 "mcp"，而非 "mcpServers"）。
   * 每个会话使用独立临时文件，保证并发隔离。
   *
   * @param bridgePort - Agent Bridge 端口。
   *   > 0：Supervisor 模式，同时注入 spectrai-agent 系统 MCP + 用户 MCP
   *   = 0：普通会话，仅注入用户 MCP（不含 spectrai-agent）
   * @returns 临时配置文件路径（调用方需将其注入 OPENCODE_CONFIG 环境变量）
   */
  static generateForOpenCode(
    sessionId: string,
    bridgePort: number,
    workDir: string,
    providerId?: string,
    database?: DatabaseManager,
    sessionMode?: 'supervisor' | 'member' | 'awareness'
  ): string {
    if (!fs.existsSync(OPENCODE_TEMP_BASE_DIR)) {
      fs.mkdirSync(OPENCODE_TEMP_BASE_DIR, { recursive: true })
    }

    const configPath = path.join(OPENCODE_TEMP_BASE_DIR, `opencode-config-${sessionId}.json`)
    const serverPath = getMCPServerPath()
    const nodeCmd = getNodeCommand()

    // OpenCode 的 MCP 配置格式：
    // { "mcp": { "server-name": { "type": "local", "command": ["node", "path"], "environment": {...} } } }
    const config: { mcp: Record<string, any> } = { mcp: {} }

    // spectrai-agent 系统 MCP：仅 Supervisor/Agent 编排模式（bridgePort > 0）才注入
    if (bridgePort > 0) {
      config.mcp['spectrai-agent'] = {
        type: 'local',
        command: [nodeCmd, serverPath],
        environment: {
          CLAUDEOPS_SESSION_ID: sessionId,
          CLAUDEOPS_BRIDGE_PORT: String(bridgePort),
          CLAUDEOPS_WORK_DIR: workDir,
          CLAUDEOPS_SESSION_MODE: sessionMode || 'supervisor',
        },
        enabled: true,
      }
    }

    // 注入用户配置的 MCP
    if (providerId && database) {
      try {
        const userMcps = database.getEnabledMcpsForProvider(providerId)
        const injected: string[] = []
        for (const mcp of userMcps) {
          if (mcp.transport === 'stdio' && mcp.command) {
            // OpenCode command 字段是数组：[executable, ...args]
            const cmdArray = [mcp.command, ...(mcp.args || [])]
            const envEntries: Record<string, string> = {
              ...(mcp.envVars || {}),
              ...(mcp.userConfig
                ? Object.fromEntries(Object.entries(mcp.userConfig).map(([k, v]) => [k, String(v)]))
                : {}),
            }
            config.mcp[mcp.id] = {
              type: 'local',
              command: cmdArray,
              ...(Object.keys(envEntries).length > 0 ? { environment: envEntries } : {}),
              enabled: true,
            }
            injected.push(`${mcp.name}(${mcp.command})`)
          } else if ((mcp.transport === 'http' || mcp.transport === 'sse') && mcp.url) {
            config.mcp[mcp.id] = {
              type: 'remote',
              url: mcp.url,
              ...(mcp.headers && Object.keys(mcp.headers).length > 0 ? { headers: mcp.headers } : {}),
              enabled: true,
            }
            injected.push(`${mcp.name}(${mcp.url})`)
          }
        }
        console.log(`[MCPConfig] OpenCode: Injected ${injected.length}/${userMcps.length} user MCP(s): ${injected.join(', ') || '(none)'}`)
      } catch (err) {
        console.error('[MCPConfigGenerator] Failed to inject user MCPs for OpenCode:', err)
      }
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    opencodeTempConfigs.set(sessionId, configPath)
    console.log(`[MCPConfig] Generated OpenCode config: ${configPath} (bridgePort=${bridgePort}, mcpServers=${Object.keys(config.mcp).length})`)
    return configPath
  }

  /**
   * 清理指定会话的临时配置文件（Claude Code JSON + Codex 临时目录 + OpenCode 临时文件）
   */
  static cleanup(sessionId: string): void {
    // 清理 Claude Code / iFlow 的 JSON 配置文件
    const configPath = path.join(MCP_CONFIG_DIR, `mcp-config-${sessionId}.json`)
    try {
      if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath)
        console.log(`[MCPConfig] Cleaned up: ${configPath}`)
      }
    } catch (err) {
      console.warn(`[MCPConfig] Failed to cleanup ${configPath}:`, err)
    }

    // 清理 OpenCode 临时配置文件
    const opencodeConfigPath = opencodeTempConfigs.get(sessionId)
    if (opencodeConfigPath) {
      opencodeTempConfigs.delete(sessionId)
      try {
        if (fs.existsSync(opencodeConfigPath)) {
          fs.unlinkSync(opencodeConfigPath)
          console.log(`[MCPConfig] Cleaned up OpenCode config: ${opencodeConfigPath}`)
        }
      } catch (err) {
        console.warn(`[MCPConfig] Failed to cleanup OpenCode config ${opencodeConfigPath}:`, err)
      }
    }

    // 清理 Codex 临时 CODEX_HOME 目录
    // Windows 文件锁：Codex 进程退出时可能仍持有 sessions/ 下的文件句柄，
    // 导致 rmSync 以 ENOTEMPTY 失败。先立即尝试，失败则延迟 2s 重试一次（兜底）。
    const codexTempDir = codexTempDirs.get(sessionId)
    if (codexTempDir) {
      codexTempDirs.delete(sessionId)
      const tryRemove = (isRetry: boolean) => {
        try {
          fs.rmSync(codexTempDir, { recursive: true, force: true })
          console.log(`[MCPConfig] Cleaned up Codex CODEX_HOME: ${codexTempDir}`)
        } catch (err) {
          if (!isRetry) {
            // 第一次失败：Windows 文件锁，2s 后重试
            setTimeout(() => tryRemove(true), 2000)
          } else {
            // 第二次仍失败：仅 warn，残留文件下次 cleanupAll 会处理
            console.warn(`[MCPConfig] Failed to cleanup Codex CODEX_HOME ${codexTempDir}:`, err)
          }
        }
      }
      tryRemove(false)
    }
  }

  /**
   * 清理所有临时配置文件（应用退出时调用）
   */
  static cleanupAll(): void {
    // 清理 Claude Code / iFlow 的 JSON 配置文件
    try {
      if (fs.existsSync(MCP_CONFIG_DIR)) {
        const files = fs.readdirSync(MCP_CONFIG_DIR)
        for (const file of files) {
          if (file.startsWith('mcp-config-') && file.endsWith('.json')) {
            try {
              fs.unlinkSync(path.join(MCP_CONFIG_DIR, file))
            } catch (_) { /* ignore */ }
          }
        }
      }
    } catch (_) { /* ignore */ }

    // 清理所有 OpenCode 临时配置文件
    for (const [sessionId, configPath] of opencodeTempConfigs) {
      try {
        if (fs.existsSync(configPath)) fs.unlinkSync(configPath)
      } catch (_) { /* ignore */ }
      opencodeTempConfigs.delete(sessionId)
    }
    // 顺便清理整个 OPENCODE_TEMP_BASE_DIR（兜底，处理上次异常退出残留）
    try {
      if (fs.existsSync(OPENCODE_TEMP_BASE_DIR)) {
        fs.rmSync(OPENCODE_TEMP_BASE_DIR, { recursive: true, force: true })
      }
    } catch (_) { /* ignore */ }

    // 清理所有 Codex 临时 CODEX_HOME 目录
    for (const [sessionId, tempDir] of codexTempDirs) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true })
      } catch (_) { /* ignore */ }
      codexTempDirs.delete(sessionId)
    }

    // 顺便清理整个 CODEX_TEMP_BASE_DIR（兜底，处理上次异常退出残留）
    try {
      if (fs.existsSync(CODEX_TEMP_BASE_DIR)) {
        fs.rmSync(CODEX_TEMP_BASE_DIR, { recursive: true, force: true })
      }
    } catch (_) { /* ignore */ }

    console.log(`[MCPConfig] Cleaned up all temporary configs`)
  }
}
