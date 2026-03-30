/**
 * AgentMCPServer - 独立 Node.js 进程
 * 由 Claude Code 作为 stdio MCP Server 启动
 * 通过 WebSocket 连接 AgentBridge 转发请求
 * @author weibin
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { WebSocket } from 'ws'
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import { createTwoFilesPatch } from 'diff'
// 从环境变量读取配置
const SESSION_ID = process.env.CLAUDEOPS_SESSION_ID || ''
const BRIDGE_PORT = parseInt(process.env.CLAUDEOPS_BRIDGE_PORT || '63721', 10)
const WORK_DIR = process.env.CLAUDEOPS_WORK_DIR || process.cwd()
const SESSION_MODE = (process.env.CLAUDEOPS_SESSION_MODE || 'supervisor') as 'supervisor' | 'member' | 'awareness'

// ==================== 文件操作工具集合 ====================
const FILE_OPS_TOOLS = new Set([
  'spectrai_edit_file', 'spectrai_write_file', 'spectrai_create_file', 'spectrai_delete_file'
])

// ==================== 工具分级：按会话模式控制可见工具 ====================
// supervisor: Supervisor 主会话，拥有 Agent 调度 + Worktree 合并工具
// awareness:  普通感知会话，仅跨会话查看 + worktree + 文件操作

/** Agent 调度工具（仅 supervisor） */
const AGENT_TOOLS = new Set([
  'spawn_agent', 'send_to_agent', 'get_agent_output', 'wait_agent_idle',
  'wait_agent', 'get_agent_status', 'list_agents', 'cancel_agent'
])

/** Supervisor 专属的 Worktree 合并工具 */
const SUPERVISOR_WORKTREE_TOOLS = new Set([
  'merge_worktree', 'get_task_info', 'check_merge'
])

/**
 * 判断指定工具在当前 SESSION_MODE 下是否可见
 */
function isToolVisible(toolName: string): boolean {
  // Agent 调度工具：仅 supervisor
  if (AGENT_TOOLS.has(toolName)) return SESSION_MODE === 'supervisor'
  // Supervisor worktree 合并工具：仅 supervisor
  if (SUPERVISOR_WORKTREE_TOOLS.has(toolName)) return SESSION_MODE === 'supervisor'
  // 其余工具（跨会话感知、enter_worktree、skill、文件操作）：所有模式可见
  return true
}

let ws: WebSocket | null = null
let requestIdCounter = 0
const pendingRequests = new Map<string, { resolve: (value: any) => void; reject: (err: Error) => void }>()

/**
 * 连接到 AgentBridge WebSocket 服务
 */
function connectBridge(): Promise<void> {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}`)

    ws.on('open', () => {
      // 注册 sessionId
      ws!.send(JSON.stringify({ type: 'register', sessionId: SESSION_ID }))
    })

    ws.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString())

        if (msg.type === 'registered') {
          resolve()
          return
        }

        if (msg.type === 'response') {
          const pending = pendingRequests.get(msg.id)
          if (pending) {
            pendingRequests.delete(msg.id)
            if (msg.error) {
              pending.reject(new Error(msg.error))
            } else {
              pending.resolve(msg.result)
            }
          }
        }
      } catch (err) {
        console.error('[AgentMCP] Failed to parse message:', err)
      }
    })

    ws.on('error', (err) => {
      console.error('[AgentMCP] WebSocket error:', err)
      reject(err)
    })

    ws.on('close', () => {
      // 拒绝所有等待中的请求
      for (const [, pending] of pendingRequests) {
        pending.reject(new Error('WebSocket connection closed'))
      }
      pendingRequests.clear()
      ws = null
    })
  })
}

/**
 * 发送请求到 AgentBridge 并等待响应
 */
function sendRequest(method: string, params: Record<string, any>): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('Not connected to AgentBridge'))
      return
    }

    const id = `req-${++requestIdCounter}`
    pendingRequests.set(id, { resolve, reject })

    ws.send(JSON.stringify({
      type: 'request',
      id,
      sessionId: SESSION_ID,
      method,
      params
    }))

    // 请求超时
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id)
        reject(new Error(`Request ${method} timed out`))
      }
    }, 660000) // 11 分钟（比 wait_agent 默认 10 分钟长）
  })
}

// ==================== 文件操作辅助函数 ====================

/**
 * 安全检查：确保文件路径在 WORK_DIR 内，防止路径逃逸
 */
function assertPathSafe(filePath: string): void {
  const resolved = path.resolve(filePath)
  const workDirResolved = path.resolve(WORK_DIR)
  if (!resolved.startsWith(workDirResolved + path.sep) && resolved !== workDirResolved) {
    throw new Error(`路径不在工作目录内: ${filePath} (WORK_DIR: ${WORK_DIR})`)
  }
}

/**
 * 计算单次操作的 diff（旧内容 vs 新内容）
 */
function computeOperationDiff(filePath: string, oldContent: string, newContent: string): string {
  const fileName = path.basename(filePath)
  return createTwoFilesPatch(fileName, fileName, oldContent, newContent, '', '', { context: 3 })
}

/**
 * 计算相对于 git 基准的累积 diff
 */
function computeCumulativeDiff(filePath: string): string | undefined {
  try {
    const dirPath = path.dirname(filePath)
    // 检测是否在 git 仓库中
    const gitRoot = execSync('git rev-parse --show-toplevel', { cwd: dirPath, encoding: 'utf-8' }).trim()

    // 检测是否在 worktree 中（worktree 的 .git 是文件而非目录）
    const gitPath = path.join(gitRoot, '.git')
    const isWorktree = fs.existsSync(gitPath) && fs.statSync(gitPath).isFile()

    if (isWorktree) {
      // worktree: diff against base branch
      const baseBranch = detectBaseBranch(gitRoot)
      if (baseBranch) {
        return execSync(`git diff ${baseBranch}... -- "${filePath}"`, { cwd: gitRoot, encoding: 'utf-8' })
      }
    }

    // 普通仓库: diff against HEAD
    return execSync(`git diff HEAD -- "${filePath}"`, { cwd: gitRoot, encoding: 'utf-8' })
  } catch {
    return undefined
  }
}

/**
 * 检测 worktree 的基准分支（从 .git 文件解析主仓库的 HEAD 分支）
 */
function detectBaseBranch(workDir: string): string | undefined {
  try {
    const gitFile = path.join(workDir, '.git')
    if (fs.existsSync(gitFile) && fs.statSync(gitFile).isFile()) {
      // .git 文件内容: "gitdir: /path/to/.git/worktrees/<name>"
      const gitdir = fs.readFileSync(gitFile, 'utf-8').replace('gitdir: ', '').trim()
      // 从 commondir 获取主仓库路径
      const commondirFile = path.join(gitdir, 'commondir')
      if (fs.existsSync(commondirFile)) {
        const commondir = fs.readFileSync(commondirFile, 'utf-8').trim()
        const mainGitDir = path.resolve(gitdir, commondir)
        // HEAD 分支就是基准分支
        const headRef = fs.readFileSync(path.join(mainGitDir, 'HEAD'), 'utf-8').trim()
        const match = headRef.match(/^ref: refs\/heads\/(.+)$/)
        return match ? match[1] : undefined
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 从 diff 字符串中统计新增和删除行数
 */
function countDiffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0, deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++
    if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  return { additions, deletions }
}

/**
 * 通过 WebSocket 发送 file-change 事件给 AgentBridge
 */
function sendFileChangeEvent(data: {
  filePath: string
  changeType: 'edit' | 'create' | 'write' | 'delete'
  operationDiff: string
  cumulativeDiff?: string
  additions: number
  deletions: number
}): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'file-change',
      sessionId: SESSION_ID,
      data
    }))
  }
}

/**
 * 本地执行文件操作工具，计算 diff，发送 file-change 事件
 */
async function handleFileOperation(
  toolName: string,
  args: Record<string, any>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const filePath = args.file_path as string
    if (!filePath) {
      return { content: [{ type: 'text' as const, text: 'Error: file_path is required' }], isError: true }
    }

    // 安全检查：路径必须在 WORK_DIR 内
    assertPathSafe(filePath)

    switch (toolName) {
      case 'spectrai_edit_file': {
        const oldString = args.old_string as string
        const newString = args.new_string as string
        if (oldString === undefined || newString === undefined) {
          return { content: [{ type: 'text' as const, text: 'Error: old_string and new_string are required' }], isError: true }
        }

        if (!fs.existsSync(filePath)) {
          return { content: [{ type: 'text' as const, text: `Error: File not found: ${filePath}` }], isError: true }
        }

        const oldContent = fs.readFileSync(filePath, 'utf-8')

        // 先尝试精确匹配
        let occurrences = oldContent.split(oldString).length - 1
        let matchOldString = oldString
        let matchNewString = newString

        // 精确匹配失败时，尝试 CRLF/LF 规范化匹配
        if (occurrences === 0) {
          const hasCRLF = oldContent.includes('\r\n')
          const normalizedContent = oldContent.replace(/\r\n/g, '\n')
          const normalizedOldString = oldString.replace(/\r\n/g, '\n')
          occurrences = normalizedContent.split(normalizedOldString).length - 1

          if (occurrences > 0 && hasCRLF) {
            // 文件是 CRLF，将 old_string/new_string 中的 LF 适配为 CRLF
            matchOldString = normalizedOldString.replace(/\n/g, '\r\n')
            matchNewString = newString.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
            occurrences = oldContent.split(matchOldString).length - 1
          } else if (occurrences > 0) {
            // 文件是 LF，将 old_string/new_string 中的 CRLF 适配为 LF
            matchOldString = normalizedOldString
            matchNewString = newString.replace(/\r\n/g, '\n')
            occurrences = oldContent.split(matchOldString).length - 1
          }
        }

        if (occurrences === 0) {
          return { content: [{ type: 'text' as const, text: `Error: old_string not found in file: ${filePath}` }], isError: true }
        }
        if (occurrences > 1) {
          return { content: [{ type: 'text' as const, text: `Error: old_string matches ${occurrences} times in file (must be unique): ${filePath}` }], isError: true }
        }

        const newContent = oldContent.replace(matchOldString, matchNewString)
        fs.writeFileSync(filePath, newContent, 'utf-8')

        const operationDiff = computeOperationDiff(filePath, oldContent, newContent)
        const cumulativeDiff = computeCumulativeDiff(filePath)
        const stats = countDiffStats(operationDiff)

        sendFileChangeEvent({
          filePath,
          changeType: 'edit',
          operationDiff,
          cumulativeDiff,
          additions: stats.additions,
          deletions: stats.deletions,
        })

        return { content: [{ type: 'text' as const, text: `Successfully edited ${filePath} (+${stats.additions} -${stats.deletions})` }] }
      }

      case 'spectrai_write_file': {
        const content = args.content as string
        if (content === undefined) {
          return { content: [{ type: 'text' as const, text: 'Error: content is required' }], isError: true }
        }

        const oldContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : ''
        // 确保父目录存在
        const dir = path.dirname(filePath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
        fs.writeFileSync(filePath, content, 'utf-8')

        const operationDiff = computeOperationDiff(filePath, oldContent, content)
        const cumulativeDiff = computeCumulativeDiff(filePath)
        const stats = countDiffStats(operationDiff)

        sendFileChangeEvent({
          filePath,
          changeType: 'write',
          operationDiff,
          cumulativeDiff,
          additions: stats.additions,
          deletions: stats.deletions,
        })

        return { content: [{ type: 'text' as const, text: `Successfully wrote ${filePath} (+${stats.additions} -${stats.deletions})` }] }
      }

      case 'spectrai_create_file': {
        const content = args.content as string
        if (content === undefined) {
          return { content: [{ type: 'text' as const, text: 'Error: content is required' }], isError: true }
        }

        if (fs.existsSync(filePath)) {
          return { content: [{ type: 'text' as const, text: `Error: File already exists: ${filePath}` }], isError: true }
        }

        // 确保父目录存在
        const dir = path.dirname(filePath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
        fs.writeFileSync(filePath, content, 'utf-8')

        const operationDiff = computeOperationDiff(filePath, '', content)
        const cumulativeDiff = computeCumulativeDiff(filePath)
        const stats = countDiffStats(operationDiff)

        sendFileChangeEvent({
          filePath,
          changeType: 'create',
          operationDiff,
          cumulativeDiff,
          additions: stats.additions,
          deletions: stats.deletions,
        })

        return { content: [{ type: 'text' as const, text: `Successfully created ${filePath} (+${stats.additions} lines)` }] }
      }

      case 'spectrai_delete_file': {
        if (!fs.existsSync(filePath)) {
          return { content: [{ type: 'text' as const, text: `Error: File not found: ${filePath}` }], isError: true }
        }

        const oldContent = fs.readFileSync(filePath, 'utf-8')
        fs.unlinkSync(filePath)

        const operationDiff = computeOperationDiff(filePath, oldContent, '')
        const cumulativeDiff = computeCumulativeDiff(filePath)
        const stats = countDiffStats(operationDiff)

        sendFileChangeEvent({
          filePath,
          changeType: 'delete',
          operationDiff,
          cumulativeDiff,
          additions: stats.additions,
          deletions: stats.deletions,
        })

        return { content: [{ type: 'text' as const, text: `Successfully deleted ${filePath} (-${stats.deletions} lines)` }] }
      }

      default:
        return { content: [{ type: 'text' as const, text: `Error: Unknown file operation tool: ${toolName}` }], isError: true }
    }
  } catch (err: any) {
    return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true }
  }
}

/**
 * 创建并启动 MCP Server
 */
async function main(): Promise<void> {
  // 1. 连接 AgentBridge
  try {
    await connectBridge()
  } catch (err) {
    console.error('[AgentMCP] Failed to connect to AgentBridge:', err)
    process.exit(1)
  }

  // 2. 创建 MCP Server
  const server = new Server(
    {
      name: 'spectrai-agent',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  )

  // 3. 注册工具列表（按 SESSION_MODE 过滤）
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const allTools = [
        {
          name: 'spawn_agent',
          description: `创建子 Agent 会话来处理子任务。支持多种 AI Provider（不只是 Claude），请根据任务特点选择合适的 provider。返回 agentId 用于后续交互、查询或等待。

★ 生命周期管理：
- oneShot=true（默认）：任务完成后自动退出，无需手动管理。
- oneShot=false（交互式）：会话持久存活，你必须在不再需要时调用 cancel_agent 关闭它，否则会一直占用资源。
- 建议：在所有交互式 Agent 的工作全部完成后，逐一调用 cancel_agent 清理。`,
          inputSchema: {
            type: 'object' as const,
            properties: {
              name: {
                type: 'string',
                description: '子任务名称，用于标识和展示'
              },
              prompt: {
                type: 'string',
                description: '要发送给子 Agent 的完整指令（需包含完整上下文，子 Agent 不知道父会话的背景）'
              },
              workDir: {
                type: 'string',
                description: '子会话的工作目录，不传则继承当前会话的工作目录'
              },
              autoAccept: {
                type: 'boolean',
                description: '是否自动接受所有确认请求（--dangerously-skip-permissions），默认 true'
              },
              provider: {
                type: 'string',
                description: `使用的 AI Provider。不要总是用默认的 claude-code，请根据任务特点选择：
- claude-code — Claude Code，综合能力最强，适合复杂推理、架构设计、多文件重构
- codex — OpenAI Codex CLI，擅长代码生成和补全，适合写代码、修 bug、加功能
- gemini-cli — Google Gemini CLI，上下文窗口大，适合大文件分析、代码审查、文档总结
- opencode — OpenCode，适合代码生成和补全，支持多模型切换
建议：并行多个子任务时，混合使用不同 provider 可以获得多样化视角`
              },
              oneShot: {
                type: 'boolean',
                description: '是否为一次性任务（默认 true）。true: 任务完成后自动退出会话释放资源；false: 保持会话存活，支持多轮交互'
              }
            },
            required: ['name', 'prompt']
          }
        },
        {
          name: 'send_to_agent',
          description: '向运行中的子 Agent 发送追加指令或反馈。用于多轮交互：纠正方向、补充信息、催促进度。Agent 收到后会开始处理，配合 wait_agent_idle 等待完成。',
          inputSchema: {
            type: 'object' as const,
            properties: {
              agentId: {
                type: 'string',
                description: 'spawn_agent 返回的 agentId'
              },
              message: {
                type: 'string',
                description: '要发送给子 Agent 的消息内容'
              }
            },
            required: ['agentId', 'message']
          }
        },
        {
          name: 'get_agent_output',
          description: '获取子 Agent 最近的终端输出（已清洗 ANSI 转义序列）。用于查看进度、检查结果、了解 Agent 当前在做什么。',
          inputSchema: {
            type: 'object' as const,
            properties: {
              agentId: {
                type: 'string',
                description: 'spawn_agent 返回的 agentId'
              },
              lines: {
                type: 'number',
                description: '返回最近多少行输出，默认 50'
              }
            },
            required: ['agentId']
          }
        },
        {
          name: 'wait_agent_idle',
          description: '等待子 Agent 完成当前任务变为空闲状态（检测到 prompt marker 返回）。与 wait_agent 不同：wait_agent 等进程退出（永久结束），wait_agent_idle 等当前轮完成（Agent 仍在运行，可以发送下一条指令）。',
          inputSchema: {
            type: 'object' as const,
            properties: {
              agentId: {
                type: 'string',
                description: 'spawn_agent 返回的 agentId'
              },
              timeout: {
                type: 'number',
                description: '超时时间（毫秒），默认 600000（10分钟）'
              }
            },
            required: ['agentId']
          }
        },
        {
          name: 'wait_agent',
          description: '等待子 Agent 进程退出并返回最终结果。包含退出码、输出摘要和修改的文件列表。注意：这会等到进程完全退出，如果只想等当前任务完成，请用 wait_agent_idle。',
          inputSchema: {
            type: 'object' as const,
            properties: {
              agentId: {
                type: 'string',
                description: 'spawn_agent 返回的 agentId'
              },
              timeout: {
                type: 'number',
                description: '超时时间（毫秒），默认 600000（10分钟）'
              }
            },
            required: ['agentId']
          }
        },
        {
          name: 'get_agent_status',
          description: '查询子 Agent 的当前状态（pending/running/completed/failed/cancelled）',
          inputSchema: {
            type: 'object' as const,
            properties: {
              agentId: {
                type: 'string',
                description: '要查询的 agentId'
              }
            },
            required: ['agentId']
          }
        },
        {
          name: 'list_agents',
          description: '列出当前会话创建的所有子 Agent',
          inputSchema: {
            type: 'object' as const,
            properties: {}
          }
        },
        {
          name: 'cancel_agent',
          description: '关闭/取消子 Agent 会话并释放资源。★ 重要：交互式 Agent（oneShot=false）不会自动退出，你必须在用完后主动调用此工具关闭它。忘记关闭会导致资源浪费。',
          inputSchema: {
            type: 'object' as const,
            properties: {
              agentId: {
                type: 'string',
                description: '要取消的 agentId'
              }
            },
            required: ['agentId']
          }
        },

        // ==================== 跨会话感知工具（只读） ====================
        {
          name: 'list_sessions',
          description: '列出 SpectrAI 中所有活跃和最近的会话。可查看其他会话的名称、状态、使用的 AI Provider 和工作目录。用于了解当前有哪些任务在并行运行。',
          inputSchema: {
            type: 'object' as const,
            properties: {
              status: {
                type: 'string',
                description: '按状态过滤：running / completed / error / all（默认 all）'
              },
              limit: {
                type: 'number',
                description: '返回条数上限，默认 20'
              }
            }
          }
        },
        {
          name: 'get_session_summary',
          description: '获取指定会话的详细摘要，包括最近的 AI 回答、修改的文件、执行的命令和错误信息。用于了解另一个会话具体做了什么。',
          inputSchema: {
            type: 'object' as const,
            properties: {
              sessionId: {
                type: 'string',
                description: '目标会话 ID'
              },
              sessionName: {
                type: 'string',
                description: '目标会话名称（模糊匹配，sessionId 和 sessionName 二选一）'
              }
            }
          }
        },
        {
          name: 'search_sessions',
          description: '按关键词搜索所有会话的活动记录和 AI 回答。用于查找哪个会话处理过某个文件、某个错误或某项任务。',
          inputSchema: {
            type: 'object' as const,
            properties: {
              query: {
                type: 'string',
                description: '搜索关键词'
              },
              limit: {
                type: 'number',
                description: '返回条数上限，默认 20'
              }
            },
            required: ['query']
          }
        },

        // ==================== Git Worktree 合并工具 ====================
        {
          name: 'enter_worktree',
          description: '创建/进入当前会话对应仓库的隔离 worktree。成功后会返回 worktree 路径和分支，并自动写回当前会话的 worktree 元数据（用于 UI 展示与后续点击跳转）。',
          inputSchema: {
            type: 'object' as const,
            properties: {
              repoPath: {
                type: 'string',
                description: '目标仓库路径（可选，不传则使用当前会话工作目录自动定位仓库根目录）'
              },
              worktreeName: {
                type: 'string',
                description: 'worktree 名称（用于生成默认分支名/目录名，建议传有语义的短名称）'
              },
              branchName: {
                type: 'string',
                description: 'worktree 分支名（可选，不传则自动生成）'
              },
              taskId: {
                type: 'string',
                description: 'worktree 目录标识（可选，不传则自动生成）'
              },
              baseBranch: {
                type: 'string',
                description: '期望的当前基线分支（可选，传入后会校验当前分支必须一致）'
              },
              allowDirty: {
                type: 'boolean',
                description: '是否允许仓库存在未提交改动时继续（默认 false）'
              }
            }
          }
        },
        {
          name: 'get_task_info',
          description: '获取看板任务的详细信息，包括是否启用了 Git Worktree 隔离、仓库路径、分支名等。用于判断子任务完成后是否需要执行合并操作。如果 worktreeEnabled=false，说明该任务不需要 git 合并，直接汇总结果即可。',
          inputSchema: {
            type: 'object' as const,
            properties: {
              taskId: {
                type: 'string',
                description: '看板任务 ID'
              }
            },
            required: ['taskId']
          }
        },
        {
          name: 'check_merge',
          description: '检查 Git Worktree 分支能否安全合并回主分支。返回冲突文件列表和是否可合并。仅对启用了 Worktree 的任务有意义。支持传 taskId（自动查询仓库信息）或直接传 repoPath + worktreePath。',
          inputSchema: {
            type: 'object' as const,
            properties: {
              taskId: {
                type: 'string',
                description: '看板任务 ID（自动获取仓库和 worktree 信息）'
              },
              repoPath: {
                type: 'string',
                description: '仓库根目录路径（与 worktreePath 配合使用）'
              },
              worktreePath: {
                type: 'string',
                description: 'Worktree 目录路径'
              }
            }
          }
        },
        // ---- Skill 技能管理工具 ----
        {
          name: 'install_skill',
          description: `将一个 Skill（技能）安装到 SpectrAI 软件中，安装后可立即在对话中通过 /slash 命令调用。

当 AI 建议安装某个 Skill 时，优先使用此工具安装到 SpectrAI，而非安装到 Claude Code 插件系统。

支持三种 Skill 类型：
- prompt: 基于提示词模板的技能（最常用）
- native: 原生 Claude Code 技能（SKILL.md 格式内容）
- orchestration: 多 Provider 编排技能

安装成功后，用户界面的技能列表会自动刷新。`,
          inputSchema: {
            type: 'object' as const,
            properties: {
              name: {
                type: 'string',
                description: '技能名称，简短易懂，如"代码审查"'
              },
              description: {
                type: 'string',
                description: '技能描述，说明这个技能能做什么'
              },
              slashCommand: {
                type: 'string',
                description: '触发命令（不含/），如 "code-review"。用户输入 /code-review 时触发此技能'
              },
              type: {
                type: 'string',
                description: '技能类型：prompt（提示词模板）| native（SKILL.md 原生内容）| orchestration（多 Provider 编排）。默认 prompt'
              },
              promptTemplate: {
                type: 'string',
                description: '提示词模板内容，支持 {{user_input}} 等占位符。type=prompt 时必填'
              },
              nativeContent: {
                type: 'string',
                description: 'SKILL.md 原始内容。type=native 时必填'
              },
              systemPromptAddition: {
                type: 'string',
                description: '追加到系统提示词的内容（可选）'
              },
              category: {
                type: 'string',
                description: '技能分类，如 development / writing / analysis / custom（默认 custom）'
              },
              compatibleProviders: {
                type: 'string',
                description: '兼容的 Provider，填 "all" 表示所有，或逗号分隔的 Provider ID 列表（如 "claude-code,codex"）。默认 all'
              },
              author: {
                type: 'string',
                description: '作者名称（可选）'
              },
              tags: {
                type: 'string',
                description: '标签，逗号分隔（可选），如 "review,code,quality"'
              }
            },
            required: ['name', 'description']
          }
        },
        {
          name: 'list_skills',
          description: '列出 SpectrAI 中已安装的所有技能（包含内置和自定义）。用于查看当前有哪些可用的技能、其状态和 slash 命令。',
          inputSchema: {
            type: 'object' as const,
            properties: {
              enabledOnly: {
                type: 'boolean',
                description: '是否只返回已启用的技能，默认 false（返回全部）'
              },
              category: {
                type: 'string',
                description: '按分类过滤（可选），如 development / writing / custom'
              }
            }
          }
        },
        {
          name: 'get_skill',
          description: '获取 SpectrAI 中某个技能的详细信息，包括提示词模板、变量定义等。',
          inputSchema: {
            type: 'object' as const,
            properties: {
              slashCommand: {
                type: 'string',
                description: '按 slash 命令查找（不含/），如 "code-review"'
              },
              id: {
                type: 'string',
                description: '按技能 ID 查找（与 slashCommand 二选一）'
              }
            }
          }
        },
        // ---- Git Worktree 工具 ----
        {
          name: 'merge_worktree',
          description: '将 Git Worktree 分支合并回主分支。默认使用 squash 合并（将所有 commit 压缩为一个）。可选在合并后自动清理 worktree 和分支。仅对启用了 Worktree 的任务有意义，非 worktree 任务无需调用。',
          inputSchema: {
            type: 'object' as const,
            properties: {
              taskId: {
                type: 'string',
                description: '看板任务 ID（自动获取仓库和分支信息）'
              },
              repoPath: {
                type: 'string',
                description: '仓库根目录路径'
              },
              branchName: {
                type: 'string',
                description: '要合并的分支名'
              },
              worktreePath: {
                type: 'string',
                description: 'Worktree 目录路径（cleanup=true 时需要，用于移除 worktree）'
              },
              squash: {
                type: 'boolean',
                description: '是否 squash 合并（默认 true，将所有 commit 压缩为一个）'
              },
              message: {
                type: 'string',
                description: '合并 commit 消息（留空则自动生成）'
              },
              cleanup: {
                type: 'boolean',
                description: '合并后是否自动删除 worktree 和分支（默认 false）'
              }
            }
          }
        },

        // ==================== SpectrAI 文件操作工具 ====================
        {
          name: 'spectrai_edit_file',
          description: '在文件中执行精确的字符串替换。必须提供要替换的精确旧字符串和新字符串。用于修改现有文件的特定部分。',
          inputSchema: {
            type: 'object' as const,
            properties: {
              file_path: { type: 'string', description: '要编辑的文件的绝对路径' },
              old_string: { type: 'string', description: '要被替换的精确原始字符串（必须在文件中唯一匹配）' },
              new_string: { type: 'string', description: '替换后的新字符串' },
            },
            required: ['file_path', 'old_string', 'new_string'],
          },
        },
        {
          name: 'spectrai_write_file',
          description: '将内容写入文件（覆写已有内容或创建新文件）。适用于需要完全重写文件内容的场景。',
          inputSchema: {
            type: 'object' as const,
            properties: {
              file_path: { type: 'string', description: '文件的绝对路径' },
              content: { type: 'string', description: '要写入的完整文件内容' },
            },
            required: ['file_path', 'content'],
          },
        },
        {
          name: 'spectrai_create_file',
          description: '创建新文件并写入内容。如果文件已存在会报错。',
          inputSchema: {
            type: 'object' as const,
            properties: {
              file_path: { type: 'string', description: '新文件的绝对路径' },
              content: { type: 'string', description: '文件内容' },
            },
            required: ['file_path', 'content'],
          },
        },
        {
          name: 'spectrai_delete_file',
          description: '删除指定文件。',
          inputSchema: {
            type: 'object' as const,
            properties: {
              file_path: { type: 'string', description: '要删除的文件的绝对路径' },
            },
            required: ['file_path'],
          },
        },
    ]

    // 按 SESSION_MODE 过滤工具，减少上下文占用
    const visibleTools = allTools.filter(t => isToolVisible(t.name))
    console.error(`[AgentMCP] SESSION_MODE=${SESSION_MODE}, tools: ${allTools.length} total → ${visibleTools.length} visible`)

    return { tools: visibleTools }
  })

  // 4. 注册工具调用处理器
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    // ★ 文件操作工具：本地执行 + 发送 file-change 事件
    if (name.startsWith('spectrai_') && FILE_OPS_TOOLS.has(name)) {
      return await handleFileOperation(name, args || {})
    }

    // 其他工具继续转发到 bridge
    try {
      const result = await sendRequest(name, args || {})
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2)
          }
        ]
      }
    } catch (err: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${err.message}`
          }
        ],
        isError: true
      }
    }
  })

  // 5. 启动 stdio transport
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('[AgentMCP] Fatal error:', err)
  process.exit(1)
})
