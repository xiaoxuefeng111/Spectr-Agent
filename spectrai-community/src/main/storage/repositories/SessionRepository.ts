/**
 * SessionRepository - Sessions 相关数据库操作
 */
import type { ActivityEvent } from '../../../shared/types'
import type { Session } from '../types'
import { parseDbTimestamp } from '../types'

export class SessionRepository {
  private memSessions: Map<string, Session> = new Map()
  private memEvents: any[] = []

  constructor(private db: any, private usingSqlite: boolean) {}

  createSession(session: Partial<Session> & { id: string; name: string; workingDirectory: string; config: any }): Session {
    const fullSession: Session = {
      id: session.id,
      taskId: session.taskId,
      name: session.name,
      nameLocked: session.nameLocked,
      workingDirectory: session.workingDirectory,
      status: session.status || 'running',
      startedAt: new Date(),
      estimatedTokens: session.estimatedTokens || 0,
      config: session.config,
      providerId: session.providerId
    }

    if (this.usingSqlite) {
      this.db.prepare(`
        INSERT INTO sessions (id, task_id, name, name_locked, working_directory, status, estimated_tokens, config, provider_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        fullSession.id, fullSession.taskId || null,
        fullSession.name, fullSession.nameLocked ? 1 : 0,
        fullSession.workingDirectory,
        fullSession.status, fullSession.estimatedTokens || 0,
        JSON.stringify(fullSession.config),
        fullSession.providerId || 'claude-code'
      )
    }

    this.memSessions.set(fullSession.id, fullSession)
    return fullSession
  }

  updateSession(id: string, updates: Partial<Session> & { claudeSessionId?: string }): void {
    if (this.usingSqlite) {
      const fields: string[] = []
      const values: any[] = []

      if (updates.status !== undefined) {
        fields.push('status = ?'); values.push(updates.status)
        if (updates.status === 'completed' || updates.status === 'error' || updates.status === 'terminated') {
          fields.push('ended_at = ?'); values.push(new Date().toISOString())
        }
        // 恢复会话时清除 ended_at
        if (updates.status === 'running' || updates.status === 'starting') {
          fields.push('ended_at = ?'); values.push(null)
        }
      }
      if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name) }
      if (updates.exitCode !== undefined) { fields.push('exit_code = ?'); values.push(updates.exitCode) }
      if (updates.estimatedTokens !== undefined) { fields.push('estimated_tokens = ?'); values.push(updates.estimatedTokens) }
      if (updates.claudeSessionId !== undefined) { fields.push('claude_session_id = ?'); values.push(updates.claudeSessionId) }
      if (updates.config !== undefined) { fields.push('config = ?'); values.push(JSON.stringify(updates.config)) }
      if (updates.nameLocked !== undefined) { fields.push('name_locked = ?'); values.push(updates.nameLocked ? 1 : 0) }

      if (fields.length > 0) {
        values.push(id)
        this.db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`).run(...values)
      }
    }

    const existing = this.memSessions.get(id)
    if (existing) {
      const merged = { ...existing, ...updates }
      // 与 SQLite 路径保持一致：恢复时清除 endedAt
      if (updates.status === 'running' || updates.status === 'starting') {
        merged.endedAt = undefined
      }
      this.memSessions.set(id, merged)
    }
  }

  /**
   * 删除会话（含相关活动事件）
   */
  deleteSession(id: string): void {
    if (this.usingSqlite) {
      try {
        // 先删除活动事件（外键约束或手动级联）
        this.db.prepare('DELETE FROM activity_events WHERE session_id = ?').run(id)
        this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
      } catch (err) {
        console.error('[Database] deleteSession error:', err)
        throw err
      }
    }
    this.memSessions.delete(id)
  }

  /**
   * 获取单个会话（按 ID 查询）
   */
  getSession(id: string): Session | undefined {
    if (this.usingSqlite) {
      try {
        const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any
        return row ? this.mapSession(row) : undefined
      } catch (_err) {
        console.error('[Database] getSession error:', _err)
      }
    }
    return this.memSessions.get(id)
  }

  /**
   * 快速查询会话名称是否已被用户锁定
   */
  isSessionNameLocked(sessionId: string): boolean {
    if (this.usingSqlite) {
      try {
        const row = this.db.prepare(
          'SELECT name_locked FROM sessions WHERE id = ?'
        ).get(sessionId) as any
        return row?.name_locked === 1
      } catch (_err) { return false }
    }
    const mem = this.memSessions.get(sessionId)
    return mem?.nameLocked === true
  }

  /**
   * 获取所有历史会话（从数据库）
   */
  getAllSessions(): Session[] {
    if (this.usingSqlite) {
      try {
        const rows = this.db.prepare(
          'SELECT * FROM sessions ORDER BY started_at DESC'
        ).all() as any[]
        const result: Session[] = []
        for (const row of rows) {
          try {
            result.push(this.mapSession(row))
          } catch (rowErr) {
            console.error(`[Database] mapSession failed for ${row.id}:`, rowErr)
          }
        }
        return result
      } catch (_err) {
        console.error('[Database] getAllSessions error:', _err)
      }
    }
    return Array.from(this.memSessions.values())
  }

  /**
   * 获取指定会话的活动事件（从数据库，按时间倒序）
   */
  getSessionActivities(sessionId: string, limit: number = 500): ActivityEvent[] {
    if (this.usingSqlite) {
      try {
        const rows = this.db.prepare(
          'SELECT * FROM activity_events WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?'
        ).all(sessionId, limit) as any[]
        return rows.map((row: any) => ({
          id: row.id,
          sessionId: row.session_id,
          timestamp: row.timestamp ? parseDbTimestamp(row.timestamp).toISOString() : new Date().toISOString(),
          type: row.type,
          detail: row.detail,
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined
        })).reverse() // 返回正序（旧→新）
      } catch (_err) {
        console.error('[Database] getSessionActivities error:', _err)
      }
    }
    return this.memEvents
      .filter(e => e.sessionId === sessionId)
      .slice(-limit)
      .map(e => ({
        id: e.id,
        sessionId: e.sessionId,
        timestamp: e.timestamp instanceof Date ? e.timestamp.toISOString() : e.timestamp,
        type: e.type,
        detail: e.detail,
        metadata: e.metadata
      }))
  }

  addActivityEvent(event: { id: string; sessionId: string; type: string; detail: string; metadata?: any }): void {
    if (this.usingSqlite) {
      try {
        this.db.prepare(`
          INSERT INTO activity_events (id, session_id, type, detail, metadata)
          VALUES (?, ?, ?, ?, ?)
        `).run(event.id, event.sessionId, event.type, event.detail,
          event.metadata ? JSON.stringify(event.metadata) : null)
      } catch (_err) {
        // 忽略插入错误（如 type 不匹配）
      }
    }

    this.memEvents.push({ ...event, timestamp: new Date() })
    // 限制内存中事件数量
    if (this.memEvents.length > 10000) {
      this.memEvents = this.memEvents.slice(-5000)
    }
  }

  /**
   * 退出前清理：将所有 interrupted 会话标记为 completed
   * 确保只有本次运行的活跃会话会被标记为 interrupted（防止历史残留导致重复恢复）
   */
  resolveAllInterrupted(): number {
    if (!this.db) return 0
    try {
      const result = this.db.prepare(
        "UPDATE sessions SET status = 'completed' WHERE status = 'interrupted'"
      ).run()
      const count = result.changes || 0
      if (count > 0) {
        console.log(`[Database] Resolved ${count} old interrupted sessions → completed`)
      }
      return count
    } catch (err) {
      console.warn('[Database] Failed to resolve interrupted sessions:', err)
      return 0
    }
  }

  /**
   * 启动时清理孤儿会话（应用崩溃 / 未走 before-quit 的场景）：
   * - running/starting：视为执行中被中断 → interrupted（允许恢复）
   * - idle/waiting_input + 有 claudeSessionId：有上下文可恢复 → interrupted
   * - idle/waiting_input + 无 claudeSessionId：无法恢复的空会话 → completed
   * - 历史 interrupted（旧版本误标）：
   *   - ended_at 已存在，或最后事件为 turn_complete/task_complete/session_end → completed
   *   - 无 claude_session_id 且只有 session_start（空会话）→ completed
   */
  cleanupOrphanedSessions(): number {
    if (!this.db) return 0
    try {
      const interruptedResult = this.db.prepare(
        "UPDATE sessions SET status = 'interrupted' WHERE status IN ('running', 'starting')"
      ).run()
      // idle/waiting_input 有 claudeSessionId 的可以恢复，无则丢弃
      const interruptedFromIdleResult = this.db.prepare(
        "UPDATE sessions SET status = 'interrupted' WHERE status IN ('idle', 'waiting_input') AND claude_session_id IS NOT NULL AND claude_session_id != ''"
      ).run()
      const completedFromIdleResult = this.db.prepare(
        "UPDATE sessions SET status = 'completed' WHERE status IN ('idle', 'waiting_input')"
      ).run()
      const completedFromLegacyInterruptedResult = this.db.prepare(`
        UPDATE sessions
        SET status = 'completed'
        WHERE status = 'interrupted'
          AND (
            ended_at IS NOT NULL
            OR (
              SELECT ae.type
              FROM activity_events ae
              WHERE ae.session_id = sessions.id
              ORDER BY ae.timestamp DESC, ae.id DESC
              LIMIT 1
            ) IN ('turn_complete', 'task_complete', 'session_end')
            OR (
              (claude_session_id IS NULL OR claude_session_id = '')
              AND NOT EXISTS (
                SELECT 1
                FROM activity_events ae
                WHERE ae.session_id = sessions.id
                  AND ae.type <> 'session_start'
              )
            )
          )
      `).run()

      const interruptedCount = interruptedResult.changes || 0
      const interruptedFromIdleCount = interruptedFromIdleResult.changes || 0
      const completedFromIdleCount = completedFromIdleResult.changes || 0
      const completedFromLegacyInterruptedCount = completedFromLegacyInterruptedResult.changes || 0
      const total = interruptedCount + interruptedFromIdleCount + completedFromIdleCount + completedFromLegacyInterruptedCount

      if (total > 0) {
        console.log(
          `[Database] Cleaned up orphaned sessions: ${interruptedCount} running->interrupted, ${interruptedFromIdleCount} idle(resumable)->interrupted, ${completedFromIdleCount} idle(no-id)->completed, ${completedFromLegacyInterruptedCount} legacy->completed`
        )
      }
      return total
    } catch (err) {
      console.warn('[Database] Failed to cleanup orphaned sessions:', err)
      return 0
    }
  }
  private mapSession(row: any): Session {
    let config: any = {}
    if (row.config) {
      try { config = JSON.parse(row.config) } catch { /* 保留空对象 */ }
    }
    return {
      id: row.id,
      taskId: row.task_id || undefined,
      name: row.name,
      workingDirectory: row.working_directory,
      status: row.status,
      startedAt: row.started_at ? parseDbTimestamp(row.started_at) : undefined,
      endedAt: row.ended_at ? parseDbTimestamp(row.ended_at) : undefined,
      exitCode: row.exit_code,
      estimatedTokens: row.estimated_tokens || 0,
      config,
      claudeSessionId: row.claude_session_id || undefined,
      providerId: row.provider_id || 'claude-code',
      nameLocked: row.name_locked === 1
    }
  }
}
