/**
 * 结构化输出读取管理器
 *
 * 按 Provider ID 路由到对应的读取器实现，对外暴露统一接口。
 * 新增 Provider 时只需: new XxxReader() → registerReader()
 *
 * @author weibin
 */

import { EventEmitter } from 'events'
import { BaseOutputReader, NormalizedMessage } from './types'

export class OutputReaderManager extends EventEmitter {
  /** providerId → 读取器实例 */
  private readers: Map<string, BaseOutputReader> = new Map()
  /** sessionId → providerId */
  private sessionProviderMap: Map<string, string> = new Map()

  /**
   * 注册 Provider 对应的读取器
   */
  registerReader(reader: BaseOutputReader): void {
    this.readers.set(reader.providerId, reader)
    // 转发所有读取器的 message 事件
    reader.on('message', (msg: NormalizedMessage) => {
      this.emit('message', msg)
    })
    // 转发 conversation 发现事件（由 ClaudeJsonlReader 目录扫描触发）
    reader.on('conversation-discovered', (data: { sessionId: string; conversationId: string }) => {
      this.emit('conversation-discovered', data)
    })
    console.log(`[OutputReaderManager] 注册读取器: ${reader.providerId}`)
  }

  /**
   * 会话创建时调用
   * 如果该 Provider 没有对应读取器则静默跳过（退回 OutputParser）
   */
  startWatching(sessionId: string, providerId: string, workDir: string): void {
    const reader = this.readers.get(providerId)
    if (!reader) return

    this.sessionProviderMap.set(sessionId, providerId)
    reader.startWatching(sessionId, workDir)
  }

  /**
   * CLI 内部对话 ID 被检测到时调用
   */
  onConversationIdDetected(sessionId: string, conversationId: string): void {
    const providerId = this.sessionProviderMap.get(sessionId)
    if (!providerId) return

    this.readers.get(providerId)?.bindConversationId(sessionId, conversationId)
  }

  /**
   * 判断指定会话是否有结构化读取器在工作
   * 用于让调用方决定是否跳过 OutputParser 的模糊解析
   */
  hasActiveReader(sessionId: string): boolean {
    return this.sessionProviderMap.has(sessionId)
  }

  /**
   * 会话结束时调用
   */
  stopWatching(sessionId: string): void {
    const providerId = this.sessionProviderMap.get(sessionId)
    if (!providerId) return

    this.readers.get(providerId)?.stopWatching(sessionId)
    this.sessionProviderMap.delete(sessionId)
  }

  /**
   * 清理所有资源
   */
  cleanup(): void {
    for (const reader of this.readers.values()) {
      reader.cleanup()
      reader.removeAllListeners()
    }
    this.readers.clear()
    this.sessionProviderMap.clear()
  }
}
