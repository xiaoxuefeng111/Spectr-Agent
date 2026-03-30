/**
 * TaskSessionCoordinator - 任务与会话状态自动联动协调器
 * 监听会话状态变化和 OutputParser 活动事件，自动更新关联任务状态
 * @author weibin
 */

import { EventEmitter } from 'events'
import type { DatabaseManager } from '../storage/Database'
import type { SessionStatus, ActivityEventType, TaskStatus } from '../../shared/types'

/** 会话状态 → 任务状态映射规则 */
const SESSION_TO_TASK: Partial<Record<SessionStatus, { target: TaskStatus; validFrom: TaskStatus[] }>> = {
  running:       { target: 'in_progress', validFrom: ['todo', 'waiting'] },
  idle:          { target: 'in_progress', validFrom: ['todo', 'waiting'] },
  waiting_input: { target: 'waiting',     validFrom: ['in_progress'] },
  error:         { target: 'waiting',     validFrom: ['in_progress'] },
}

/** 活动事件 → 任务状态映射规则 */
const ACTIVITY_TO_TASK: Partial<Record<ActivityEventType, TaskStatus>> = {
  task_complete:        'done',
  error:               'waiting',
  waiting_confirmation: 'waiting',
}

export class TaskSessionCoordinator extends EventEmitter {
  private database: DatabaseManager
  private debounceTimers = new Map<string, NodeJS.Timeout>()

  constructor(database: DatabaseManager) {
    super()
    this.database = database
  }

  /**
   * 会话状态变化时调用
   */
  onSessionStatusChange(sessionId: string, status: SessionStatus): void {
    const taskId = this.getTaskIdForSession(sessionId)
    if (!taskId) return

    const rule = SESSION_TO_TASK[status]
    if (!rule) {
      // completed/terminated 需要特殊处理：检查是否有其他活跃会话
      if (status === 'completed' || status === 'terminated') {
        this.handleSessionCompleted(taskId, sessionId)
      }
      return
    }

    this.debouncedUpdate(taskId, rule.target, rule.validFrom)
  }

  /**
   * 活动事件（OutputParser）时调用
   */
  onActivityEvent(sessionId: string, activityType: ActivityEventType): void {
    const taskId = this.getTaskIdForSession(sessionId)
    if (!taskId) return

    const targetStatus = ACTIVITY_TO_TASK[activityType]
    if (!targetStatus) return

    if (targetStatus === 'done') {
      // task_complete 仍代表明确任务完成信号（非 turn_complete）
      this.debouncedUpdate(taskId, 'done', ['todo', 'in_progress', 'waiting'])
    } else {
      this.debouncedUpdate(taskId, targetStatus, ['in_progress'])
    }
  }

  /**
   * 会话完成/终止时的多会话边界处理
   */
  private handleSessionCompleted(taskId: string, completedSessionId: string): void {
    const allSessions = this.database.getAllSessions()
    const hasOtherActive = allSessions.some(s =>
      s.id !== completedSessionId &&
      s.taskId === taskId &&
      (s.status === 'running' || s.status === 'idle' || s.status === 'waiting_input' || s.status === 'starting')
    )

    if (!hasOtherActive) {
      this.debouncedUpdate(taskId, 'done', ['in_progress', 'waiting'])
    }
  }

  /**
   * 1 秒防抖更新任务状态
   */
  private debouncedUpdate(taskId: string, targetStatus: TaskStatus, validFromStatuses: TaskStatus[]): void {
    const existing = this.debounceTimers.get(taskId)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.debounceTimers.delete(taskId)
      this.applyTaskUpdate(taskId, targetStatus, validFromStatuses)
    }, 1000)

    this.debounceTimers.set(taskId, timer)
  }

  /**
   * 实际执行任务状态更新
   */
  private applyTaskUpdate(taskId: string, targetStatus: TaskStatus, validFromStatuses: TaskStatus[]): void {
    try {
      const task = this.database.getTask(taskId)
      if (!task) return

      const currentStatus = task.status as TaskStatus
      if (!validFromStatuses.includes(currentStatus)) return
      if (currentStatus === targetStatus) return

      this.database.updateTask(taskId, { status: targetStatus })
      this.emit('task-updated', taskId, { status: targetStatus })
    } catch (err) {
      console.error('[TaskSessionCoordinator] Failed to update task:', err)
    }
  }

  /**
   * 根据 sessionId 查找关联的 taskId
   */
  private getTaskIdForSession(sessionId: string): string | undefined {
    try {
      const allSessions = this.database.getAllSessions()
      const session = allSessions.find(s => s.id === sessionId)
      return session?.taskId
    } catch {
      return undefined
    }
  }

  /**
   * 清理所有防抖定时器
   */
  cleanup(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()
  }
}
