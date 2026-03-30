/**
 * LogRepository - Session Logs 相关数据库操作
 */
import type { SessionLog } from '../types'
import { parseDbTimestamp } from '../types'

export class LogRepository {
  private memLogs: any[] = []

  constructor(private db: any, private usingSqlite: boolean) {}

  appendLog(sessionId: string, chunk: string): void {
    if (this.usingSqlite) {
      try {
        this.db.prepare('INSERT INTO session_logs (session_id, chunk) VALUES (?, ?)').run(sessionId, chunk)
      } catch (_err) { /* ignore */ }
    }

    this.memLogs.push({ sessionId, chunk, timestamp: new Date() })
    if (this.memLogs.length > 50000) {
      this.memLogs = this.memLogs.slice(-25000)
    }
  }

  /**
   * 获取指定会话的所有日志（按时间正序）
   */
  getSessionLogs(sessionId: string): string[] {
    if (this.usingSqlite) {
      try {
        const rows = this.db.prepare(
          'SELECT chunk FROM session_logs WHERE session_id = ? ORDER BY id ASC'
        ).all(sessionId) as any[]
        return rows.map((row: any) => row.chunk)
      } catch (_err) {
        console.error('[Database] getSessionLogs error:', _err)
      }
    }
    return this.memLogs
      .filter(log => log.sessionId === sessionId)
      .map(log => log.chunk)
  }

  searchLogs(query: string, sessionId?: string, limit: number = 100): SessionLog[] {
    if (this.usingSqlite) {
      try {
        // 尝试使用 FTS5 全文搜索（快得多）
        const ftsQuery = query
          .replace(/[^\w\u4e00-\u9fff\s]/g, ' ')  // 移除特殊字符
          .trim()
          .split(/\s+/)
          .filter(w => w.length > 0)
          .map(w => `"${w}"`)
          .join(' ')

        if (ftsQuery) {
          let sql: string
          let params: any[]

          if (sessionId) {
            sql = `
              SELECT sl.id, sl.session_id, sl.timestamp, sl.chunk,
                     s.name AS session_name,
                     snippet(session_logs_fts, 1, '<<', '>>', '...', 40) AS highlight
              FROM session_logs_fts fts
              JOIN session_logs sl ON sl.id = fts.rowid
              LEFT JOIN sessions s ON s.id = sl.session_id
              WHERE session_logs_fts MATCH ? AND fts.session_id = ?
              ORDER BY fts.rank
              LIMIT ?
            `
            params = [ftsQuery, sessionId, limit]
          } else {
            sql = `
              SELECT sl.id, sl.session_id, sl.timestamp, sl.chunk,
                     s.name AS session_name,
                     snippet(session_logs_fts, 1, '<<', '>>', '...', 40) AS highlight
              FROM session_logs_fts fts
              JOIN session_logs sl ON sl.id = fts.rowid
              LEFT JOIN sessions s ON s.id = sl.session_id
              WHERE session_logs_fts MATCH ?
              ORDER BY fts.rank
              LIMIT ?
            `
            params = [ftsQuery, limit]
          }

          const rows = this.db.prepare(sql).all(...params) as any[]
          return rows.map((row: any) => ({
            id: row.id,
            sessionId: row.session_id,
            sessionName: row.session_name || '',
            timestamp: parseDbTimestamp(row.timestamp),
            chunk: row.chunk,
            highlight: row.highlight || ''
          }))
        }
      } catch (_err) {
        // FTS5 不可用，降级到 LIKE 搜索
      }

      // LIKE 降级搜索
      try {
        let sql: string
        let params: any[]

        if (sessionId) {
          sql = `
            SELECT sl.*, s.name AS session_name
            FROM session_logs sl
            LEFT JOIN sessions s ON s.id = sl.session_id
            WHERE sl.chunk LIKE ? AND sl.session_id = ?
            ORDER BY sl.timestamp DESC LIMIT ?
          `
          params = [`%${query}%`, sessionId, limit]
        } else {
          sql = `
            SELECT sl.*, s.name AS session_name
            FROM session_logs sl
            LEFT JOIN sessions s ON s.id = sl.session_id
            WHERE sl.chunk LIKE ?
            ORDER BY sl.timestamp DESC LIMIT ?
          `
          params = [`%${query}%`, limit]
        }

        const rows = this.db.prepare(sql).all(...params) as any[]
        return rows.map((row: any) => ({
          id: row.id,
          sessionId: row.session_id,
          sessionName: row.session_name || '',
          timestamp: parseDbTimestamp(row.timestamp),
          chunk: row.chunk,
          highlight: ''
        }))
      } catch (_err) { /* fall through to memory search */ }
    }

    const lowerQuery = query.toLowerCase()
    return this.memLogs
      .filter(log => {
        if (!log.chunk.toLowerCase().includes(lowerQuery)) return false
        if (sessionId && log.sessionId !== sessionId) return false
        return true
      })
      .slice(-limit)
      .map((log, i) => ({
        id: i,
        sessionId: log.sessionId,
        sessionName: '',
        timestamp: log.timestamp,
        chunk: log.chunk,
        highlight: ''
      }))
  }

  /**
   * 搜索指定会话的日志（searchSessionLogs 别名，兼容旧调用方）
   */
  searchSessionLogs(query: string, sessionId?: string, limit: number = 100): SessionLog[] {
    return this.searchLogs(query, sessionId, limit)
  }

  /**
   * 清理过期日志（按保留天数）
   */
  cleanupOldLogs(retentionDays: number): number {
    if (!this.db) return 0
    try {
      const result = this.db.prepare(
        "DELETE FROM session_logs WHERE timestamp < datetime('now', ? || ' days')"
      ).run(`-${retentionDays}`)
      const count = result.changes || 0
      if (count > 0) {
        // 重建 FTS 索引以释放空间
        try {
          this.db.exec("INSERT INTO session_logs_fts(session_logs_fts) VALUES('rebuild')")
        } catch (_ftsErr) { /* FTS rebuild optional */ }
        console.log(`[Database] Cleaned up ${count} log entries older than ${retentionDays} days`)
      }
      return count
    } catch (err) {
      console.warn('[Database] Failed to cleanup old logs:', err)
      return 0
    }
  }
}
