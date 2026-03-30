/**
 * UsageRepository - Usage Stats 相关数据库操作
 */
import type { DbUsageSummary } from '../types'

export class UsageRepository {
  constructor(private db: any, private usingSqlite: boolean) {}

  /**
   * 保存或更新用量统计（按 session_id + date 做 upsert）
   */
  saveUsageStat(sessionId: string, date: string, tokens: number, minutes: number): void {
    if (!this.db) return
    try {
      const existing = this.db.prepare(
        'SELECT id, estimated_tokens, active_minutes FROM usage_stats WHERE session_id = ? AND date = ?'
      ).get(sessionId, date) as any

      if (existing) {
        this.db.prepare(
          'UPDATE usage_stats SET estimated_tokens = ?, active_minutes = ? WHERE id = ?'
        ).run(tokens, minutes, existing.id)
      } else {
        this.db.prepare(
          'INSERT INTO usage_stats (session_id, date, estimated_tokens, active_minutes) VALUES (?, ?, ?, ?)'
        ).run(sessionId, date, tokens, minutes)
      }
    } catch (err) {
      console.warn('[Database] saveUsageStat error:', err)
    }
  }

  /**
   * 获取用量汇总（总计 + 今日）
   */
  getUsageSummary(): DbUsageSummary {
    if (!this.db) {
      return { totalSessions: 0, totalTokens: 0, totalMinutes: 0, todayTokens: 0, todayMinutes: 0, avgTokensPerSession: 0, dailyStats: [] }
    }

    try {
      // 总计
      const total = this.db.prepare(
        'SELECT COALESCE(SUM(estimated_tokens), 0) as tokens, COALESCE(SUM(active_minutes), 0) as minutes, COUNT(DISTINCT session_id) as sessions FROM usage_stats'
      ).get() as any

      // ★ 今日（返回给上层，供 USAGE_GET_SUMMARY 中 SDK V2 统计使用）
      const today = new Date().toISOString().slice(0, 10)
      const todayStats = this.db.prepare(
        'SELECT COALESCE(SUM(estimated_tokens), 0) as tokens, COALESCE(SUM(active_minutes), 0) as minutes FROM usage_stats WHERE date = ?'
      ).get(today) as any

      return {
        totalSessions: total.sessions || 0,
        totalTokens: total.tokens || 0,
        totalMinutes: total.minutes || 0,
        avgTokensPerSession: total.sessions > 0 ? Math.round(total.tokens / total.sessions) : 0,
        todayTokens: todayStats?.tokens || 0,
        todayMinutes: todayStats?.minutes || 0,
        dailyStats: []
      }
    } catch (err) {
      console.warn('[Database] getUsageSummary error:', err)
      return { totalSessions: 0, totalTokens: 0, totalMinutes: 0, todayTokens: 0, todayMinutes: 0, avgTokensPerSession: 0, dailyStats: [] }
    }
  }

  /**
   * 获取用量历史（按天聚合 + 按会话聚合）
   */
  getUsageHistory(days: number = 30): { dailyStats: any[]; sessionStats: any[] } {
    if (!this.db) {
      return { dailyStats: [], sessionStats: [] }
    }

    try {
      // 按天聚合
      const dailyStats = this.db.prepare(`
        SELECT date, SUM(estimated_tokens) as tokens, SUM(active_minutes) as minutes, COUNT(DISTINCT session_id) as sessions
        FROM usage_stats
        WHERE date >= date('now', ? || ' days')
        GROUP BY date
        ORDER BY date ASC
      `).all(`-${days}`) as any[]

      // 按会话聚合（最近的）
      const sessionStats = this.db.prepare(`
        SELECT u.session_id, s.name as session_name,
               SUM(u.estimated_tokens) as tokens, SUM(u.active_minutes) as minutes
        FROM usage_stats u
        LEFT JOIN sessions s ON s.id = u.session_id
        WHERE u.date >= date('now', ? || ' days')
        GROUP BY u.session_id
        ORDER BY tokens DESC
        LIMIT 20
      `).all(`-${days}`) as any[]

      return {
        dailyStats: dailyStats.map((r: any) => ({
          date: r.date,
          tokens: r.tokens || 0,
          minutes: r.minutes || 0,
          sessions: r.sessions || 0
        })),
        sessionStats: sessionStats.map((r: any) => ({
          sessionId: r.session_id,
          sessionName: r.session_name || r.session_id?.slice(0, 8) || 'Unknown',
          tokens: r.tokens || 0,
          minutes: r.minutes || 0
        }))
      }
    } catch (err) {
      console.warn('[Database] getUsageHistory error:', err)
      return { dailyStats: [], sessionStats: [] }
    }
  }
}
