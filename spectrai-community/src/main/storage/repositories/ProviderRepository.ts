/**
 * ProviderRepository - AI Providers CRUD 相关数据库操作
 */
import type { AIProvider } from '../../../shared/types'
import { BUILTIN_PROVIDERS } from '../../../shared/types'

export class ProviderRepository {
  constructor(private db: any, private usingSqlite: boolean) {}

  getAllProviders(): AIProvider[] {
    if (this.usingSqlite) {
      try {
        const rows = this.db.prepare('SELECT * FROM ai_providers ORDER BY sort_order ASC, created_at ASC').all() as any[]
        return rows.map((row: any) => {
          const mapped = this.mapProvider(row)
          // 内置 Provider：与硬编码预设合并，确保 adapterType 等关键字段不丢失
          if (mapped.isBuiltin) {
            const builtinPreset = BUILTIN_PROVIDERS.find(bp => bp.id === mapped.id)
            if (builtinPreset) {
              return {
                ...builtinPreset,
                ...mapped,
                sessionIdDetection: mapped.sessionIdDetection && mapped.sessionIdDetection !== 'none'
                  ? mapped.sessionIdDetection
                  : builtinPreset.sessionIdDetection,
                resumeArg: mapped.resumeArg || builtinPreset.resumeArg,
                // 以下字段 DB 不存储，始终用硬编码值
                adapterType: builtinPreset.adapterType,
                confirmationConfig: builtinPreset.confirmationConfig,
                stateConfig: builtinPreset.stateConfig,
                promptMarkerPatterns: builtinPreset.promptMarkerPatterns,
                printModeArgs: builtinPreset.printModeArgs,
              }
            }
          }
          return mapped
        })
      } catch (err) {
        console.error('[Database] getAllProviders error:', err)
      }
    }
    return [...BUILTIN_PROVIDERS]
  }

  getProvider(id: string): AIProvider | undefined {
    if (this.usingSqlite) {
      try {
        const row = this.db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(id) as any
        if (row) {
          const mapped = this.mapProvider(row)
          // 内置 Provider：用 DB 值（支持用户自定义 command 等），但关键基础设施字段用硬编码兜底
          if (mapped.isBuiltin) {
            const builtinPreset = BUILTIN_PROVIDERS.find(bp => bp.id === id)
            if (builtinPreset) {
              return {
                ...builtinPreset,   // 硬编码默认值打底
                ...mapped,          // DB 自定义覆盖
                sessionIdDetection: mapped.sessionIdDetection && mapped.sessionIdDetection !== 'none'
                  ? mapped.sessionIdDetection
                  : builtinPreset.sessionIdDetection,
                resumeArg: mapped.resumeArg || builtinPreset.resumeArg,
                // 以下字段 DB 不存储，始终用硬编码值
                adapterType: builtinPreset.adapterType,
                confirmationConfig: builtinPreset.confirmationConfig,
                stateConfig: builtinPreset.stateConfig,
                promptMarkerPatterns: builtinPreset.promptMarkerPatterns,
                printModeArgs: builtinPreset.printModeArgs,
              }
            }
          }
          return mapped
        }
      } catch (err) {
        console.error('[Database] getProvider error:', err)
      }
    }
    return BUILTIN_PROVIDERS.find(bp => bp.id === id)
  }

  createProvider(provider: Omit<AIProvider, 'isBuiltin' | 'createdAt' | 'updatedAt'>): AIProvider {
    const full: AIProvider = {
      ...provider,
      isBuiltin: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    if (this.usingSqlite) {
      this.db.prepare(`
        INSERT INTO ai_providers (id, name, command, is_builtin, icon, default_args, auto_accept_arg, resume_arg, resume_format, prompt_pass_mode, session_id_detection, session_id_pattern, node_version, env_overrides, executable_path, git_bash_path, default_model)
        VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        full.id, full.name, full.command,
        full.icon || null,
        JSON.stringify(full.defaultArgs || []),
        full.autoAcceptArg || null,
        full.resumeArg || null,
        full.resumeFormat || 'flag',
        full.promptPassMode || 'none',
        full.sessionIdDetection || 'none',
        full.sessionIdPattern || null,
        full.nodeVersion || null,
        full.envOverrides ? JSON.stringify(full.envOverrides) : null,
        full.executablePath || null,
        full.gitBashPath || null,
        full.defaultModel || null,
      )
    }

    return full
  }

  updateProvider(id: string, updates: Partial<AIProvider>): void {
    if (!this.usingSqlite) return
    const fields: string[] = []
    const values: any[] = []

    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name) }
    if (updates.command !== undefined) { fields.push('command = ?'); values.push(updates.command) }
    if (updates.icon !== undefined) { fields.push('icon = ?'); values.push(updates.icon) }
    if (updates.defaultArgs !== undefined) { fields.push('default_args = ?'); values.push(JSON.stringify(updates.defaultArgs)) }
    if (updates.autoAcceptArg !== undefined) { fields.push('auto_accept_arg = ?'); values.push(updates.autoAcceptArg) }
    if (updates.resumeArg !== undefined) { fields.push('resume_arg = ?'); values.push(updates.resumeArg) }
    if (updates.resumeFormat !== undefined) { fields.push('resume_format = ?'); values.push(updates.resumeFormat) }
    if (updates.promptPassMode !== undefined) { fields.push('prompt_pass_mode = ?'); values.push(updates.promptPassMode) }
    if (updates.sessionIdDetection !== undefined) { fields.push('session_id_detection = ?'); values.push(updates.sessionIdDetection) }
    if (updates.sessionIdPattern !== undefined) { fields.push('session_id_pattern = ?'); values.push(updates.sessionIdPattern || null) }
    if (updates.nodeVersion !== undefined) { fields.push('node_version = ?'); values.push(updates.nodeVersion || null) }
    if (updates.envOverrides !== undefined) { fields.push('env_overrides = ?'); values.push(updates.envOverrides ? JSON.stringify(updates.envOverrides) : null) }
    if (updates.executablePath !== undefined) { fields.push('executable_path = ?'); values.push(updates.executablePath || null) }
    if (updates.gitBashPath !== undefined) { fields.push('git_bash_path = ?'); values.push(updates.gitBashPath || null) }
    if (updates.defaultModel !== undefined) { fields.push('default_model = ?'); values.push(updates.defaultModel || null) }

    if (fields.length > 0) {
      fields.push('updated_at = CURRENT_TIMESTAMP')
      values.push(id)
      this.db.prepare(`UPDATE ai_providers SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    }
  }

  deleteProvider(id: string): boolean {
    if (!this.usingSqlite) return false
    // 禁止删除内置 provider
    const provider = this.getProvider(id)
    if (!provider || provider.isBuiltin) return false

    this.db.prepare('DELETE FROM ai_providers WHERE id = ? AND is_builtin = 0').run(id)
    return true
  }

  /** 批量更新 provider 排序（传入有序 id 数组，依次设置 sort_order） */
  reorderProviders(orderedIds: string[]): void {
    if (!this.usingSqlite) return
    const stmt = this.db.prepare('UPDATE ai_providers SET sort_order = ? WHERE id = ?')
    const update = this.db.transaction(() => {
      orderedIds.forEach((id, idx) => {
        stmt.run(idx * 10, id)
      })
    })
    update()
  }

  private mapProvider(row: any): AIProvider {
    return {
      id: row.id,
      name: row.name,
      command: row.command,
      isBuiltin: row.is_builtin === 1,
      icon: row.icon || undefined,
      defaultArgs: row.default_args ? JSON.parse(row.default_args) : [],
      autoAcceptArg: row.auto_accept_arg || undefined,
      resumeArg: row.resume_arg || undefined,
      resumeFormat: row.resume_format || 'flag',
      promptPassMode: row.prompt_pass_mode || 'positional',
      sessionIdDetection: row.session_id_detection || 'none',
      sessionIdPattern: row.session_id_pattern || undefined,
      nodeVersion: row.node_version || undefined,
      envOverrides: row.env_overrides ? JSON.parse(row.env_overrides) : undefined,
      executablePath: row.executable_path || undefined,
      gitBashPath: row.git_bash_path || undefined,
      defaultModel: row.default_model || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
