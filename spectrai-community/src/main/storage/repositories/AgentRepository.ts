/**
 * AgentRepository - Agent Sessions CRUD 及 Session Summary 相关数据库操作
 */
import type { AgentInfo, AgentResult } from '../../agent/types'

export class AgentRepository {
  constructor(private db: any, private usingSqlite: boolean) {}

  createAgentSession(info: AgentInfo): void {
    if (this.usingSqlite) {
      try {
        this.db.prepare(`
          INSERT INTO agent_sessions (agent_id, parent_session_id, child_session_id, name, prompt, work_dir, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          info.agentId, info.parentSessionId, info.childSessionId,
          info.name, info.prompt, info.workDir, info.status, info.createdAt
        )
      } catch (err) {
        console.warn('[Database] createAgentSession error:', err)
      }
    }
  }

  updateAgentStatus(agentId: string, status: string): void {
    if (this.usingSqlite) {
      try {
        const updates: string[] = ['status = ?']
        const values: any[] = [status]
        if (status === 'completed' || status === 'failed' || status === 'cancelled') {
          updates.push('completed_at = ?')
          values.push(new Date().toISOString())
        }
        values.push(agentId)
        this.db.prepare(`UPDATE agent_sessions SET ${updates.join(', ')} WHERE agent_id = ?`).run(...values)
      } catch (err) {
        console.warn('[Database] updateAgentStatus error:', err)
      }
    }
  }

  saveAgentResult(agentId: string, result: AgentResult): void {
    if (this.usingSqlite) {
      try {
        this.db.prepare(`
          INSERT OR REPLACE INTO agent_results (agent_id, success, exit_code, output, error, artifacts, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          agentId,
          result.success ? 1 : 0,
          result.exitCode,
          result.output || null,
          result.error || null,
          result.artifacts ? JSON.stringify(result.artifacts) : null,
          new Date().toISOString()
        )
      } catch (err) {
        console.warn('[Database] saveAgentResult error:', err)
      }
    }
  }

  getAgentsByParent(parentSessionId: string): AgentInfo[] {
    if (this.usingSqlite) {
      try {
        const rows = this.db.prepare(
          'SELECT * FROM agent_sessions WHERE parent_session_id = ? ORDER BY created_at ASC'
        ).all(parentSessionId) as any[]
        return rows.map((row: any) => this.mapAgentInfo(row))
      } catch (err) {
        console.warn('[Database] getAgentsByParent error:', err)
      }
    }
    return []
  }

  getAgentInfo(agentId: string): AgentInfo | undefined {
    if (this.usingSqlite) {
      try {
        const row = this.db.prepare('SELECT * FROM agent_sessions WHERE agent_id = ?').get(agentId) as any
        if (!row) return undefined
        return this.mapAgentInfo(row)
      } catch (err) {
        console.warn('[Database] getAgentInfo error:', err)
      }
    }
    return undefined
  }

  /**
   * 添加会话摘要（AI 回答内容）
   */
  addSessionSummary(sessionId: string, type: string, content: string, metadata?: any): void {
    if (!this.db) return
    try {
      this.db.prepare(`
        INSERT INTO session_summaries (session_id, type, content, metadata)
        VALUES (?, ?, ?, ?)
      `).run(sessionId, type, content, metadata ? JSON.stringify(metadata) : null)
    } catch (err) {
      console.warn('[Database] Failed to add session summary:', err)
    }
  }

  /**
   * 获取会话最新摘要
   */
  getLatestSummary(sessionId: string): any | null {
    if (!this.db) return null
    try {
      const row = this.db.prepare(`
        SELECT id, session_id, type, content, metadata, created_at
        FROM session_summaries
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT 1
      `).get(sessionId) as any
      if (!row) return null
      return {
        id: row.id,
        sessionId: row.session_id,
        type: row.type,
        content: row.content,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
        createdAt: row.created_at
      }
    } catch (err) {
      console.warn('[Database] Failed to get latest summary:', err)
      return null
    }
  }

  /**
   * 获取会话的所有摘要
   */
  getSessionSummaries(sessionId: string, limit: number = 20): any[] {
    if (!this.db) return []
    try {
      const rows = this.db.prepare(`
        SELECT id, session_id, type, content, metadata, created_at
        FROM session_summaries
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT ?
      `).all(sessionId, limit) as any[]
      return rows.map((row: any) => ({
        id: row.id,
        sessionId: row.session_id,
        type: row.type,
        content: row.content,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
        createdAt: row.created_at
      }))
    } catch (err) {
      console.warn('[Database] Failed to get session summaries:', err)
      return []
    }
  }

  /**
   * 获取所有活跃会话的最新摘要（跨会话引用）
   */
  getAllSessionLatestSummaries(): any[] {
    if (!this.db) return []
    try {
      const rows = this.db.prepare(`
        SELECT ss.id, ss.session_id, ss.type, ss.content, ss.metadata, ss.created_at,
               s.name as session_name, s.status as session_status
        FROM session_summaries ss
        INNER JOIN sessions s ON ss.session_id = s.id
        WHERE ss.id IN (
          SELECT MAX(id) FROM session_summaries GROUP BY session_id
        )
        ORDER BY ss.created_at DESC
        LIMIT 50
      `).all() as any[]
      return rows.map((row: any) => ({
        id: row.id,
        sessionId: row.session_id,
        sessionName: row.session_name,
        sessionStatus: row.session_status,
        type: row.type,
        content: row.content,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
        createdAt: row.created_at
      }))
    } catch (err) {
      console.warn('[Database] Failed to get all session summaries:', err)
      return []
    }
  }

  logAICall(log: {
    caller: string
    providerId?: string
    providerName?: string
    model?: string
    endpoint?: string
    requestMessages?: any[]
    responseBody?: string
    inputTokens?: number
    outputTokens?: number
    durationMs?: number
    success: boolean
    error?: string
  }): void {
    if (!this.db) return
    try {
      this.db.prepare(`
        INSERT INTO ai_call_logs (caller, provider_id, provider_name, model, endpoint, request_messages, response_body, input_tokens, output_tokens, duration_ms, success, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        log.caller,
        log.providerId || null,
        log.providerName || null,
        log.model || null,
        log.endpoint || null,
        log.requestMessages ? JSON.stringify(log.requestMessages) : null,
        log.responseBody || null,
        log.inputTokens || 0,
        log.outputTokens || 0,
        log.durationMs || 0,
        log.success ? 1 : 0,
        log.error || null
      )
    } catch (err) {
      console.warn('[Database] logAICall error:', err)
    }
  }

  getAICallLogs(options: { caller?: string; limit?: number } = {}): any[] {
    if (!this.db) return []
    try {
      const { caller, limit = 50 } = options
      if (caller) {
        return this.db.prepare('SELECT * FROM ai_call_logs WHERE caller = ? ORDER BY created_at DESC LIMIT ?').all(caller, limit)
      }
      return this.db.prepare('SELECT * FROM ai_call_logs ORDER BY created_at DESC LIMIT ?').all(limit)
    } catch (err) {
      console.warn('[Database] getAICallLogs error:', err)
      return []
    }
  }

  private mapAgentInfo(row: any): AgentInfo {
    // 尝试加载结果
    let result: AgentResult | undefined
    try {
      const resultRow = this.db.prepare('SELECT * FROM agent_results WHERE agent_id = ?').get(row.agent_id) as any
      if (resultRow) {
        result = {
          success: resultRow.success === 1,
          exitCode: resultRow.exit_code,
          output: resultRow.output || undefined,
          error: resultRow.error || undefined,
          artifacts: resultRow.artifacts ? JSON.parse(resultRow.artifacts) : undefined
        }
      }
    } catch (_) { /* ignore */ }

    return {
      agentId: row.agent_id,
      name: row.name,
      parentSessionId: row.parent_session_id,
      childSessionId: row.child_session_id,
      status: row.status,
      prompt: row.prompt || '',
      workDir: row.work_dir || '',
      createdAt: row.created_at,
      completedAt: row.completed_at || undefined,
      result
    }
  }
}
