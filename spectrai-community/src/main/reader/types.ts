/**
 * 结构化输出读取器 - 抽象类型定义
 * 为不同 AI CLI 提供统一的输出读取接口，
 * 不同 Provider 各自实现子类（Claude → JSONL、Codex → TBD…）
 * @author weibin
 */

import { EventEmitter } from 'events'
import type { ActivityEventType } from '../../shared/types'

// ==================== 标准化消息 ====================

/** 标准化消息：所有 Provider 读取器产出的统一格式 */
export interface NormalizedMessage {
  sessionId: string
  type: ActivityEventType
  timestamp: string
  /** 主要内容（AI 回答文本 / 文件路径 / 命令内容 等） */
  content: string
  metadata?: Record<string, any>
}

// ==================== 读取器基类 ====================

/**
 * 结构化输出读取器基类
 *
 * 事件:
 *   message(msg: NormalizedMessage) — 解析到一条标准化消息
 *
 * 子类需实现:
 *   providerId  — 对应的 Provider ID
 *   startWatching  — 会话创建时调用
 *   bindConversationId — CLI 内部对话 ID 被检测到后调用
 *   stopWatching  — 会话结束时调用
 *   cleanup — 清理所有资源
 */
export abstract class BaseOutputReader extends EventEmitter {
  abstract readonly providerId: string

  /** 准备监听（会话创建时调用，此时可能还不知道具体的对话文件） */
  abstract startWatching(sessionId: string, workDir: string): void

  /** 绑定 CLI 内部对话 ID，精确定位到输出文件 */
  abstract bindConversationId(sessionId: string, conversationId: string): void

  /** 停止监听 */
  abstract stopWatching(sessionId: string): void

  /** 清理所有资源 */
  abstract cleanup(): void

  /** 便捷方法：发出标准化消息 */
  protected emitMessage(
    sessionId: string,
    type: ActivityEventType,
    content: string,
    timestamp: string,
    metadata?: Record<string, any>
  ): void {
    const msg: NormalizedMessage = { sessionId, type, timestamp, content, metadata }
    this.emit('message', msg)
  }
}
