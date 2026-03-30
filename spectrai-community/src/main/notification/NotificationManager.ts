/**
 * 通知管理器
 * @author weibin
 */

import { EventEmitter } from 'events'
import { Notification } from 'electron'

/**
 * 通知配置
 */
interface NotificationConfig {
  enabled: boolean
  sound: boolean
  doNotDisturb: {
    enabled: boolean
    start: string
    end: string
  }
  types: {
    confirmation: { enabled: boolean }
    taskComplete: { enabled: boolean }
    error: { enabled: boolean }
    stuck: { enabled: boolean }
  }
}

/** 通知类型 */
type NotificationType = 'confirmation' | 'taskComplete' | 'error' | 'stuck'

/**
 * 通知管理器
 * 负责发送系统通知
 */
export class NotificationManager extends EventEmitter {
  /** 通知配置 */
  private config: NotificationConfig

  /** 活跃通知：sessionId → Set<通知类型>，未确认前不重发 */
  private activeNotifications: Map<string, Set<NotificationType>> = new Map()

  constructor() {
    super()

    // 默认配置：全部启用
    this.config = {
      enabled: true,
      sound: true,
      doNotDisturb: {
        enabled: false,
        start: '22:00',
        end: '08:00'
      },
      types: {
        confirmation: { enabled: true },
        taskComplete: { enabled: true },
        error: { enabled: true },
        stuck: { enabled: true }
      }
    }
  }

  /**
   * 更新通知配置
   */
  updateConfig(config: Partial<NotificationConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /**
   * 检查是否在免打扰时段
   */
  private isDoNotDisturbActive(): boolean {
    if (!this.config.doNotDisturb.enabled) {
      return false
    }

    const now = new Date()
    const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`

    const { start, end } = this.config.doNotDisturb

    if (start > end) {
      return currentTime >= start || currentTime < end
    }

    return currentTime >= start && currentTime < end
  }

  /**
   * 发送通知
   */
  private sendNotification(title: string, body: string): void {
    if (!this.config.enabled || this.isDoNotDisturbActive()) {
      return
    }

    try {
      const notification = new Notification({
        title,
        body,
        silent: !this.config.sound
      })

      notification.show()
    } catch (error) {
      console.error('发送通知失败:', error)
    }
  }

  /**
   * 检查某会话的某类通知是否已经处于活跃状态（未确认）
   */
  private isNotificationActive(sessionId: string, type: NotificationType): boolean {
    const active = this.activeNotifications.get(sessionId)
    return !!active && active.has(type)
  }

  /**
   * 标记某会话的某类通知为活跃
   */
  private markActive(sessionId: string, type: NotificationType): void {
    if (!this.activeNotifications.has(sessionId)) {
      this.activeNotifications.set(sessionId, new Set())
    }
    this.activeNotifications.get(sessionId)!.add(type)
  }

  /**
   * 确认请求通知
   */
  onConfirmationNeeded(sessionId: string, sessionName: string): void {
    if (!this.config.types.confirmation.enabled) return
    if (this.isNotificationActive(sessionId, 'confirmation')) return

    this.markActive(sessionId, 'confirmation')
    this.sendNotification(
      'Claude Code 需要确认',
      `会话 "${sessionName}" 正在等待您的确认`
    )

    this.emit('notification-sent', { type: 'confirmation', sessionId, sessionName })
  }

  /**
   * 任务完成通知
   */
  onTaskCompleted(sessionId: string, sessionName: string): void {
    if (!this.config.types.taskComplete.enabled) return
    if (this.isNotificationActive(sessionId, 'taskComplete')) return

    this.markActive(sessionId, 'taskComplete')
    this.sendNotification(
      '任务已完成',
      `会话 "${sessionName}" 已完成任务`
    )

    this.emit('notification-sent', { type: 'taskComplete', sessionId, sessionName })
  }

  /**
   * 错误通知
   */
  onError(sessionId: string, sessionName: string, errorMsg: string): void {
    if (!this.config.types.error.enabled) return
    if (this.isNotificationActive(sessionId, 'error')) return

    this.markActive(sessionId, 'error')
    this.sendNotification(
      'Claude Code 遇到错误',
      `会话 "${sessionName}": ${errorMsg}`
    )

    this.emit('notification-sent', { type: 'error', sessionId, sessionName, errorMsg })
  }

  /**
   * 会话卡住通知
   */
  onSessionStuck(sessionId: string, sessionName: string): void {
    if (!this.config.types.stuck.enabled) return
    if (this.isNotificationActive(sessionId, 'stuck')) return

    this.markActive(sessionId, 'stuck')
    this.sendNotification(
      'Claude Code 可能卡住',
      `会话 "${sessionName}" 长时间无响应，可能需要干预`
    )

    this.emit('notification-sent', { type: 'stuck', sessionId, sessionName })
  }

  /**
   * 确认（消除）指定会话的某类通知
   * @returns 是否有通知被消除
   */
  acknowledge(sessionId: string, type?: NotificationType): boolean {
    const active = this.activeNotifications.get(sessionId)
    if (!active) return false

    if (type) {
      const had = active.delete(type)
      if (active.size === 0) {
        this.activeNotifications.delete(sessionId)
      }
      return had
    }

    // 未指定类型则清除该会话所有通知
    const had = active.size > 0
    this.activeNotifications.delete(sessionId)
    return had
  }

  /**
   * 获取指定会话的活跃通知数量
   */
  getActiveCount(sessionId?: string): number {
    if (sessionId) {
      return this.activeNotifications.get(sessionId)?.size || 0
    }
    let total = 0
    for (const types of this.activeNotifications.values()) {
      total += types.size
    }
    return total
  }

  /**
   * 清理会话（会话结束时调用）
   */
  clearSession(sessionId: string): void {
    this.activeNotifications.delete(sessionId)
  }
}
