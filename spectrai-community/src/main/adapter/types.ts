/**
 * Provider Adapter 抽象层类型定义
 * SDK V2 架构核心 —— 统一事件流接口
 * @author weibin
 */

import { EventEmitter } from 'events'
import type { SessionStatus, ActivityEventType, ConversationMessage } from '../../shared/types'

// ---- 统一事件类型 ----

export type ProviderEventType =
  | 'text_delta'          // AI 文本流（增量）
  | 'thinking'            // 思考/推理内容
  | 'tool_use_start'      // 工具调用开始
  | 'tool_use_end'        // 工具调用结束（含结果）
  | 'permission_request'  // 需要用户确认
  | 'ask_user_question'   // AskUserQuestion 工具调用，等待用户回答
  | 'exit_plan_mode'      // ExitPlanMode 工具调用，等待用户审批计划
  | 'turn_complete'       // 一轮对话结束（AI 停止响应，等待用户输入）
  | 'session_complete'    // 会话结束（进程退出）
  | 'error'               // 错误

export interface ProviderEvent {
  type: ProviderEventType
  sessionId: string
  timestamp: string
  data: {
    /** 文本内容（text_delta / thinking / error） */
    text?: string
    /** 工具名称（tool_use_start / tool_use_end） */
    toolName?: string
    /** 工具输入参数（tool_use_start / ask_user_question / exit_plan_mode） */
    toolInput?: Record<string, unknown>
    /** 工具执行结果（tool_use_end） */
    toolResult?: string
    /** 工具调用是否出错（tool_use_end） */
    isError?: boolean
    /** Token 用量（turn_complete） */
    usage?: { inputTokens: number; outputTokens: number }
    /** 退出码（session_complete） */
    exitCode?: number
    /** 权限请求描述（permission_request） */
    permissionPrompt?: string
    /** 工具调用 ID（关联 start/end） */
    toolUseId?: string
  }
}

// ---- Adapter 会话配置 ----

export interface AdapterSessionConfig {
  /** CLI 命令（支持绝对路径） */
  command: string
  /** 工作目录 */
  workingDirectory: string
  /** 初始 prompt（创建会话后自动发送） */
  initialPrompt?: string
  /** 初始 prompt 是否显示为用户消息 */
  initialPromptVisibility?: 'visible' | 'hidden'
  /** 是否自动确认所有工具调用 */
  autoAccept: boolean
  /** 系统提示注入（supervisor mode 或 worktree 规则追加） */
  systemPrompt?: string | { type: string; preset: string; append: string }
  /** 模型名称覆盖 */
  model?: string
  /** 最大对话轮次（0=无限） */
  maxTurns?: number
  /** 允许的工具列表（空=全部） */
  allowedTools?: string[]
  /** MCP 配置路径（Agent 编排注入） */
  mcpConfigPath?: string
  /** Provider 特定参数 */
  providerArgs?: string[]
  /** 环境变量覆盖 */
  envOverrides?: Record<string, string>
  /** 额外 MCP 服务器（合并到 settingSources 加载的之上） */
  extraMcpServers?: Record<string, any>
  /** Node.js 版本（Gemini CLI 需要 Node 24+，通过 nvm 切换） */
  nodeVersion?: string
  /** Claude Code 可执行文件路径（仅 claude-sdk 使用，留空自动检测） */
  executablePath?: string
  /** git-bash 路径（仅 claude-sdk + Windows，留空自动探测） */
  gitBashPath?: string
  /** 工作区内除主仓库外的其他目录（绝对路径，传递给 SDK additionalDirectories） */
  additionalDirectories?: string[]
}

// ---- Adapter 会话内部状态 ----

export interface AdapterSession {
  /** 内部会话 ID（SpectrAI 管理） */
  sessionId: string
  /** Provider 端的会话 ID（用于恢复） */
  providerSessionId?: string
  /** 当前状态 */
  status: SessionStatus
  /** 对话消息历史 */
  messages: ConversationMessage[]
  /** 创建时间 */
  createdAt: string
  /** 累计 Token 用量 */
  totalUsage: { inputTokens: number; outputTokens: number }
}

// ---- Adapter 基类 ----

/**
 * Provider Adapter 基类
 *
 * 每个 AI CLI 工具对应一个 Adapter 实现，负责：
 * 1. 管理 CLI 进程/SDK 客户端的生命周期
 * 2. 将 Provider 特定的消息格式转换为统一的 ProviderEvent
 * 3. 维护对话消息历史
 *
 * 事件:
 * - 'event'(ProviderEvent) — 统一事件流
 * - 'status-change'(sessionId, SessionStatus) — 会话状态变更
 */
export abstract class BaseProviderAdapter extends EventEmitter {
  /** Provider 唯一标识（如 'claude-code', 'codex', 'gemini-cli'） */
  abstract readonly providerId: string

  /** 友好名称（如 'Claude Code', 'Codex CLI'） */
  abstract readonly displayName: string

  /**
   * 启动新会话
   * @param sessionId SpectrAI 内部会话 ID
   * @param config 会话配置
   */
  abstract startSession(sessionId: string, config: AdapterSessionConfig): Promise<void>

  /**
   * 发送用户消息（触发新一轮对话）
   * @param sessionId 会话 ID
   * @param message 用户消息文本
   */
  abstract sendMessage(sessionId: string, message: string): Promise<void>

  /**
   * 回应权限确认请求
   * @param sessionId 会话 ID
   * @param accept true=允许, false=拒绝
   */
  abstract sendConfirmation(sessionId: string, accept: boolean): Promise<void>

  /**
   * 中止当前正在执行的轮次（软中断）
   * 会话保持活跃，用户可继续发送新消息。
   * 对于不支持软中断的 Adapter，可实现为 no-op。
   * @param sessionId 会话 ID
   */
  abstract abortCurrentTurn(sessionId: string): Promise<void>

  /**
   * 终止会话
   * @param sessionId 会话 ID
   */
  abstract terminateSession(sessionId: string): Promise<void>

  /**
   * 恢复之前的会话
   * @param sessionId SpectrAI 内部会话 ID
   * @param providerSessionId Provider 端的会话 ID
   * @param config 会话配置
   */
  abstract resumeSession(
    sessionId: string,
    providerSessionId: string,
    config: AdapterSessionConfig
  ): Promise<void>

  /**
   * 获取指定会话的对话历史
   * @param sessionId 会话 ID
   */
  abstract getConversation(sessionId: string): ConversationMessage[]

  /**
   * 检查会话是否存在且活跃
   * @param sessionId 会话 ID
   */
  abstract hasSession(sessionId: string): boolean

  /**
   * 获取会话的 Provider 端会话 ID（用于恢复）
   */
  abstract getProviderSessionId(sessionId: string): string | undefined

  /**
   * 清理所有资源（应用退出时调用）
   */
  abstract cleanup(): void
}

// ---- 工具名→活动事件类型映射 ----

export interface ToolEventMapping {
  /** SDK 工具名 → ActivityEventType */
  toolName: string
  activityType: ActivityEventType
  /** 从工具输入中提取 detail 的函数 */
  extractDetail?: (toolInput: Record<string, unknown>) => string
}
