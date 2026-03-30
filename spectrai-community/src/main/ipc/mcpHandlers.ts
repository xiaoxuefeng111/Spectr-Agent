/**
 * MCP 服务器管理 IPC 处理器
 */
import { ipcMain } from 'electron'
import { execFileSync, spawn } from 'child_process'
import { IPC } from '../../shared/constants'
import type { IpcDependencies } from './index'
import { sendToRenderer } from './shared'

interface PythonInfo {
  command: string
  major: number
  minor: number
}

interface ResolvedInstallCommand {
  cmd: string
  args: string[]
  display: string
  error?: string
}

function commandExists(command: string): boolean {
  try {
    const checker = process.platform === 'win32' ? 'where' : 'which'
    execFileSync(checker, [command], { stdio: 'ignore', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

function parsePythonVersion(raw: string): { major: number; minor: number } | null {
  const m = raw.match(/Python\s+(\d+)\.(\d+)/i)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]) }
}

function detectPython(): PythonInfo | null {
  const candidates = process.platform === 'win32'
    ? ['py', 'python', 'python3']
    : ['python3', 'python']

  for (const cmd of candidates) {
    if (!commandExists(cmd)) continue
    try {
      const out = execFileSync(cmd, ['--version'], { encoding: 'utf8', timeout: 3000 }).trim()
      const parsed = parsePythonVersion(out)
      if (!parsed) continue
      return { command: cmd, major: parsed.major, minor: parsed.minor }
    } catch {
      // ignore and probe next candidate
    }
  }
  return null
}

function getUvInstallHint(): string {
  if (process.platform === 'darwin') {
    return '未安装 uv/uvx。请先执行：brew install uv'
  }
  if (process.platform === 'win32') {
    return '未安装 uv/uvx。请先执行：winget install --id=astral-sh.uv -e（或 py -m pip install uv）'
  }
  return '未安装 uv/uvx。请先执行：curl -LsSf https://astral.sh/uv/install.sh | sh（或 python3 -m pip install uv）'
}

function getPipInstallHint(): string {
  if (process.platform === 'win32') {
    return '未检测到 pip。请先执行：py -m ensurepip --upgrade'
  }
  return '未检测到 pip。请先执行：python3 -m ensurepip --upgrade'
}

function ensurePythonAndPip(minMinor?: number): { ok: true; python: PythonInfo } | { ok: false; error: string } {
  const py = detectPython()
  if (!py) {
    return { ok: false, error: '未检测到 Python。请先安装 Python 3.10+。' }
  }
  if (typeof minMinor === 'number' && (py.major < 3 || (py.major === 3 && py.minor < minMinor))) {
    return { ok: false, error: `检测到 Python ${py.major}.${py.minor}，请升级到 Python 3.${minMinor}+。` }
  }
  try {
    execFileSync(py.command, ['-m', 'pip', '--version'], { stdio: 'ignore', timeout: 5000 })
  } catch {
    return { ok: false, error: `${getPipInstallHint()}（当前 Python: ${py.command}）` }
  }
  return { ok: true, python: py }
}

function resolveInstallCommand(installCommand: string): ResolvedInstallCommand {
  const parts = installCommand.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) {
    return { cmd: '', args: [], display: '', error: '安装命令为空' }
  }

  const cmd = parts[0]
  const args = parts.slice(1)

  if ((cmd === 'uv' || cmd === 'uvx') && !commandExists(cmd)) {
    return { cmd, args, display: installCommand, error: getUvInstallHint() }
  }

  if (cmd === 'pip' || cmd === 'pip3') {
    const directPip = cmd === 'pip3' ? 'pip3' : 'pip'
    if (commandExists(directPip)) {
      return { cmd: directPip, args, display: `${directPip} ${args.join(' ')}`.trim() }
    }

    const py = ensurePythonAndPip()
    if (!py.ok) {
      return { cmd, args, display: installCommand, error: py.error }
    }
    return {
      cmd: py.python.command,
      args: ['-m', 'pip', ...args],
      display: `${py.python.command} -m pip ${args.join(' ')}`.trim(),
    }
  }

  return { cmd, args, display: installCommand }
}

export function registerMcpHandlers(deps: IpcDependencies): void {
  const { database } = deps

  // MCP_GET_ALL: 获取所有 MCP 服务器
  ipcMain.handle(IPC.MCP_GET_ALL, async () => {
    try {
      return { success: true, data: database.getAllMcps() }
    } catch (err) {
      console.error('[MCP] getAllMcps error:', err)
      return { success: false, error: (err as Error).message }
    }
  })

  // MCP_GET: 获取单个 MCP 服务器
  ipcMain.handle(IPC.MCP_GET, async (_event, id: string) => {
    try {
      const server = database.getMcp(id)
      if (!server) return { success: false, error: 'MCP 服务器不存在' }
      return { success: true, data: server }
    } catch (err) {
      console.error('[MCP] getMcp error:', err)
      return { success: false, error: (err as Error).message }
    }
  })

  // MCP_CREATE: 创建 MCP 服务器
  ipcMain.handle(IPC.MCP_CREATE, async (_event, server: any) => {
    try {
      const created = database.createMcp(server)
      return { success: true, data: created }
    } catch (err) {
      console.error('[MCP] createMcp error:', err)
      return { success: false, error: (err as Error).message }
    }
  })

  // MCP_UPDATE: 更新 MCP 服务器
  ipcMain.handle(IPC.MCP_UPDATE, async (_event, id: string, updates: any) => {
    try {
      database.updateMcp(id, updates)
      return { success: true }
    } catch (err) {
      console.error('[MCP] updateMcp error:', err)
      return { success: false, error: (err as Error).message }
    }
  })

  // MCP_DELETE: 删除 MCP 服务器
  ipcMain.handle(IPC.MCP_DELETE, async (_event, id: string) => {
    try {
      const deleted = database.deleteMcp(id)
      if (!deleted) return { success: false, error: 'MCP 服务器不存在或删除失败' }
      return { success: true }
    } catch (err) {
      console.error('[MCP] deleteMcp error:', err)
      return { success: false, error: (err as Error).message }
    }
  })

  // MCP_TOGGLE: 切换全局启用状态
  ipcMain.handle(IPC.MCP_TOGGLE, async (_event, id: string, enabled: boolean) => {
    try {
      database.toggleMcp(id, enabled)
      return { success: true }
    } catch (err) {
      console.error('[MCP] toggleMcp error:', err)
      return { success: false, error: (err as Error).message }
    }
  })

  // MCP_GET_FOR_PROVIDER: 获取对指定 Provider 启用的 MCP 列表
  ipcMain.handle(IPC.MCP_GET_FOR_PROVIDER, async (_event, providerId: string) => {
    try {
      return { success: true, data: database.getEnabledMcpsForProvider(providerId) }
    } catch (err) {
      console.error('[MCP] getEnabledMcpsForProvider error:', err)
      return { success: false, error: (err as Error).message }
    }
  })

  // MCP_TEST_CONNECTION: 测试 MCP 连接（检查命令是否存在）
  ipcMain.handle(IPC.MCP_TEST_CONNECTION, async (_event, serverId: string) => {
    try {
      const server = database.getMcp(serverId)
      if (!server) return { success: false, error: 'MCP 服务器不存在' }

      if (server.transport === 'stdio' && server.command) {
        // 绝对路径（exe 文件等）：直接用 fs.existsSync 检测，比 where/which 更可靠
        const isAbsolutePath = /^([A-Za-z]:\\|\/|\\\\)/.test(server.command)
        if (isAbsolutePath) {
          const { existsSync } = await import('fs')
          if (existsSync(server.command)) {
            return { success: true, message: `程序已找到: ${server.command}` }
          } else {
            return { success: false, error: `程序不存在: ${server.command}，请检查路径是否正确` }
          }
        }
        // 普通命令名（npx、uvx 等）：用 where/which 检查
        if (!commandExists(server.command)) {
          if (server.command === 'uvx' || server.command === 'uv') {
            return { success: false, error: getUvInstallHint() }
          }
          if (server.command === 'pip' || server.command === 'pip3') {
            return { success: false, error: getPipInstallHint() }
          }
          return {
            success: false,
            error: `命令 '${server.command}' 未安装，请先运行: ${server.installCommand || ''}`,
          }
        }

        // pip 安装链路预检查（避免 Python 版本/环境不满足时直接失败）
        if (typeof server.installCommand === 'string' && server.installCommand.trim().startsWith('pip ')) {
          const requiresPy310 = /mcp-server-(git|sqlite)\b/i.test(server.installCommand)
          const py = ensurePythonAndPip(requiresPy310 ? 10 : undefined)
          if (!py.ok) return { success: false, error: py.error }
        }

        return { success: true, message: `命令 '${server.command}' 已找到` }
      }

      // HTTP / SSE 类型或无 command 时，视配置有效
      return { success: true, message: '配置有效' }
    } catch (err) {
      console.error('[MCP] testConnection error:', err)
      return { success: false, error: (err as Error).message }
    }
  })

  // MCP_INSTALL: 安装 MCP（执行 installCommand，流式推送进度）
  ipcMain.handle(IPC.MCP_INSTALL, async (_event, id: string) => {
    const server = deps.database.getMcp(id)
    if (!server?.installCommand) return { success: false, error: '无安装命令' }

    return new Promise<{ success: boolean; error?: string }>((resolve) => {
      const resolved = resolveInstallCommand(server.installCommand!)
      if (resolved.error) {
        sendToRenderer(IPC.MCP_INSTALL_PROGRESS, { id, line: `✗ ${resolved.error}`, type: 'error' })
        resolve({ success: false, error: resolved.error })
        return
      }

      sendToRenderer(IPC.MCP_INSTALL_PROGRESS, { id, line: `→ 执行: ${resolved.display}`, type: 'stdout' })
      const proc = spawn(resolved.cmd, resolved.args, { shell: true, windowsHide: true })

      proc.stdout?.on('data', (chunk: Buffer) => {
        sendToRenderer(IPC.MCP_INSTALL_PROGRESS, { id, line: chunk.toString(), type: 'stdout' })
      })
      proc.stderr?.on('data', (chunk: Buffer) => {
        sendToRenderer(IPC.MCP_INSTALL_PROGRESS, { id, line: chunk.toString(), type: 'stderr' })
      })
      proc.on('close', (code: number | null) => {
        if (code === 0) {
          deps.database.updateMcp(id, { isInstalled: true })
          sendToRenderer(IPC.MCP_INSTALL_PROGRESS, { id, line: '✓ 安装完成', type: 'done' })
          resolve({ success: true })
        } else {
          sendToRenderer(IPC.MCP_INSTALL_PROGRESS, { id, line: `✗ 安装失败（退出码 ${code}）`, type: 'error' })
          resolve({ success: false, error: `退出码 ${code}` })
        }
      })
      proc.on('error', (err: Error) => {
        sendToRenderer(IPC.MCP_INSTALL_PROGRESS, { id, line: `✗ ${err.message}`, type: 'error' })
        resolve({ success: false, error: err.message })
      })
    })
  })
}
