/**
 * 解析器状态类型定义
 * @author weibin
 */

import type { ActivityEventType } from '../../shared/types'

/**
 * 解析器会话状态
 */
export interface ParserState {
  /** 会话ID */
  sessionId: string
  /** 最后一次事件类型 */
  lastEventType: ActivityEventType | null
  /** 最后一次输出时间戳 */
  lastOutputTime: number
  /** 是否处于思考状态 */
  isThinking: boolean
  /** AI 文本输出累积缓冲 */
  textBufferLines: string[]
  /** 缓冲开始时间 */
  textBufferStartTime: number
  /** flush 定时器 */
  flushTimer: ReturnType<typeof setTimeout> | null
}
