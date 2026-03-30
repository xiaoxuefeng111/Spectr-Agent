/**
 * Token 用量估算器 - 支持按会话/按日累计和持久化
 * @author weibin
 */

import type { UsageSummary } from '../../shared/types'
import type { DatabaseManager } from '../storage/Database'

/**
 * Token 用量估算器
 * 基于字符数估算 Token 消耗，支持持久化到数据库
 */
export class UsageEstimator {
  /** 每个会话的累计 Token 用量 */
  private sessionUsage: Map<string, number> = new Map()
  /** 每个会话的活跃开始时间 */
  private sessionStartTime: Map<string, number> = new Map()
  /** 每个会话的累计活跃分钟数 */
  private sessionMinutes: Map<string, number> = new Map()
  /** 数据库引用（用于持久化） */
  private database: DatabaseManager | null = null
  /** 定时 flush 定时器 */
  private flushTimer: ReturnType<typeof setInterval> | null = null

  /**
   * 绑定数据库并启动定时 flush
   */
  bindDatabase(database: DatabaseManager): void {
    this.database = database
    // 每 60 秒自动 flush 到数据库
    this.flushTimer = setInterval(() => this.flushToDb(), 60_000)
  }

  /**
   * 估算文本的 Token 数量
   * ASCII 字符: 约 4 字符 = 1 token
   * 非 ASCII 字符: 约 2 字符 = 1 token
   */
  estimateTokens(text: string): number {
    let asciiChars = 0
    let nonAsciiChars = 0

    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (code <= 127) {
        asciiChars++
      } else {
        nonAsciiChars++
      }
    }

    return Math.ceil(asciiChars / 4 + nonAsciiChars / 2)
  }

  /**
   * 累加会话的 Token 用量
   */
  accumulateUsage(sessionId: string, text: string): void {
    const tokens = this.estimateTokens(text)
    const currentUsage = this.sessionUsage.get(sessionId) || 0
    this.sessionUsage.set(sessionId, currentUsage + tokens)

    // 记录活跃开始时间（首次输出时）
    if (!this.sessionStartTime.has(sessionId)) {
      this.sessionStartTime.set(sessionId, Date.now())
    }
  }

  /**
   * 标记会话结束 - 计算活跃时间并 flush
   */
  markSessionEnded(sessionId: string): void {
    this.updateSessionMinutes(sessionId)
    this.flushSessionToDb(sessionId)
    // 清理 startTime（但保留 usage 和 minutes 给 summary 查看）
    this.sessionStartTime.delete(sessionId)
  }

  /**
   * 更新会话的活跃分钟数
   */
  private updateSessionMinutes(sessionId: string): void {
    const startTime = this.sessionStartTime.get(sessionId)
    if (!startTime) return

    const elapsedMs = Date.now() - startTime
    const minutes = Math.round(elapsedMs / 60_000)
    this.sessionMinutes.set(sessionId, minutes)
  }

  /**
   * 获取用量汇总
   */
  getSummary(): UsageSummary {
    let totalTokens = 0
    let totalMinutes = 0
    const sessionBreakdown: Record<string, number> = {}

    for (const [sessionId, tokens] of this.sessionUsage.entries()) {
      totalTokens += tokens
      sessionBreakdown[sessionId] = tokens
    }

    // 更新所有活跃会话的分钟数
    for (const sessionId of this.sessionStartTime.keys()) {
      this.updateSessionMinutes(sessionId)
    }

    for (const minutes of this.sessionMinutes.values()) {
      totalMinutes += minutes
    }

    // 今日数据（只算内存中当前运行的，DB 历史由 getUsageHistory 提供）
    const todayTokens = totalTokens
    const todayMinutes = totalMinutes

    return {
      totalTokens,
      totalMinutes,
      todayTokens,
      todayMinutes,
      activeSessions: this.sessionStartTime.size,
      sessionBreakdown
    }
  }

  /**
   * 获取指定会话的用量
   */
  getSessionUsage(sessionId: string): number {
    return this.sessionUsage.get(sessionId) || 0
  }

  /**
   * 重置会话用量
   */
  resetSessionUsage(sessionId: string): void {
    this.sessionUsage.delete(sessionId)
    this.sessionStartTime.delete(sessionId)
    this.sessionMinutes.delete(sessionId)
  }

  /**
   * 重置所有用量
   */
  resetAll(): void {
    this.sessionUsage.clear()
    this.sessionStartTime.clear()
    this.sessionMinutes.clear()
  }

  /**
   * 将单个会话的用量写入数据库
   */
  private flushSessionToDb(sessionId: string): void {
    if (!this.database) return

    const tokens = this.sessionUsage.get(sessionId) || 0
    if (tokens === 0) return

    this.updateSessionMinutes(sessionId)
    const minutes = this.sessionMinutes.get(sessionId) || 0
    const today = new Date().toISOString().slice(0, 10)

    this.database.saveUsageStat(sessionId, today, tokens, minutes)
  }

  /**
   * 将所有会话的用量 flush 到数据库
   */
  flushToDb(): void {
    if (!this.database) return

    for (const sessionId of this.sessionUsage.keys()) {
      this.flushSessionToDb(sessionId)
    }
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    // 最终 flush
    this.flushToDb()
  }
}
