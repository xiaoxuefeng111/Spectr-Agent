/**
 * SkillRepository - Skill 技能模板的 CRUD 操作
 */
import type { Skill } from '../../../shared/types'

export class SkillRepository {
  private memSkills: Map<string, Skill> = new Map()

  constructor(private db: any, private usingSqlite: boolean) {}

  getAll(): Skill[] {
    if (this.usingSqlite) {
      try {
        const rows = this.db.prepare('SELECT * FROM skills ORDER BY created_at ASC').all()
        return rows.map((r: any) => this.mapRow(r))
      } catch (err) {
        console.error('[SkillRepository] getAll error:', err)
      }
    }
    return Array.from(this.memSkills.values())
  }

  get(id: string): Skill | undefined {
    if (this.usingSqlite) {
      try {
        const row = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id)
        return row ? this.mapRow(row) : undefined
      } catch (err) {
        console.error('[SkillRepository] get error:', err)
      }
    }
    return this.memSkills.get(id)
  }

  /**
   * 根据 slash 命令获取启用的 Skill（拦截器核心方法）
   */
  getBySlashCommand(command: string): Skill | undefined {
    if (this.usingSqlite) {
      try {
        const row = this.db.prepare(
          'SELECT * FROM skills WHERE slash_command = ? AND is_enabled = 1'
        ).get(command)
        return row ? this.mapRow(row) : undefined
      } catch (err) {
        console.error('[SkillRepository] getBySlashCommand error:', err)
      }
    }
    return Array.from(this.memSkills.values()).find(
      s => s.slashCommand === command && s.isEnabled
    )
  }

  /**
   * 获取与指定 Provider 兼容的所有启用 Skill
   */
  getCompatibleWith(providerId: string): Skill[] {
    if (this.usingSqlite) {
      try {
        const rows = this.db.prepare('SELECT * FROM skills WHERE is_enabled = 1').all()
        return rows.map((r: any) => this.mapRow(r)).filter((skill: Skill) => {
          const compat = skill.compatibleProviders
          if (compat === 'all') return true
          return Array.isArray(compat) && compat.includes(providerId)
        })
      } catch (err) {
        console.error('[SkillRepository] getCompatibleWith error:', err)
      }
    }
    return Array.from(this.memSkills.values()).filter(s => {
      if (!s.isEnabled) return false
      if (s.compatibleProviders === 'all') return true
      return Array.isArray(s.compatibleProviders) && s.compatibleProviders.includes(providerId)
    })
  }

  create(skill: Omit<Skill, 'createdAt' | 'updatedAt'>): Skill {
    const now = new Date().toISOString()
    const full: Skill = { ...skill, createdAt: now, updatedAt: now }

    // 防御：拒绝 name 中包含 session-前缀（疑似自动化程序误写）的 skill
    if (full.name && /^session-\d+/.test(full.name)) {
      console.warn('[SkillRepository] 拒绝写入 session-ID 格式的 skill name:', full.name)
      return full
    }
    // 防御：拒绝 slashCommand 为 ISO 时间戳格式（如 2026-03-02T08:43:23.155Z）
    if (full.slashCommand && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(full.slashCommand)) {
      console.warn('[SkillRepository] 拒绝写入时间戳格式的 slashCommand:', full.slashCommand)
      return full
    }

    if (this.usingSqlite) {
      try {
        this.db.prepare(`
          INSERT INTO skills (
            id, name, description, category, slash_command,
            type, compatible_providers,
            prompt_template, system_prompt_addition, input_variables,
            native_config, orchestration_config, required_mcps,
            is_installed, is_enabled, source,
            version, author, tags, created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?,
            ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?, ?
          )
        `).run(
          full.id,
          full.name,
          full.description || '',
          full.category || 'general',
          full.slashCommand || null,
          full.type,
          JSON.stringify(full.compatibleProviders),
          full.promptTemplate || null,
          full.systemPromptAddition || null,
          full.inputVariables ? JSON.stringify(full.inputVariables) : null,
          full.nativeConfig ? JSON.stringify(full.nativeConfig) : null,
          full.orchestrationConfig ? JSON.stringify(full.orchestrationConfig) : null,
          full.requiredMcps ? JSON.stringify(full.requiredMcps) : null,
          full.isInstalled ? 1 : 0,
          full.isEnabled ? 1 : 0,
          full.source,
          full.version || null,
          full.author || null,
          full.tags ? JSON.stringify(full.tags) : null,
          full.createdAt,
          full.updatedAt
        )
      } catch (err) {
        console.error('[SkillRepository] create error:', err)
      }
    } else {
      this.memSkills.set(full.id, full)
    }

    return full
  }

  update(id: string, updates: Partial<Omit<Skill, 'id' | 'createdAt'>>): void {
    if (this.usingSqlite) {
      try {
        const fields: string[] = []
        const values: any[] = []

        if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name) }
        if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description) }
        if (updates.category !== undefined) { fields.push('category = ?'); values.push(updates.category) }
        if (updates.slashCommand !== undefined) { fields.push('slash_command = ?'); values.push(updates.slashCommand || null) }
        if (updates.type !== undefined) { fields.push('type = ?'); values.push(updates.type) }
        if (updates.compatibleProviders !== undefined) { fields.push('compatible_providers = ?'); values.push(JSON.stringify(updates.compatibleProviders)) }
        if (updates.promptTemplate !== undefined) { fields.push('prompt_template = ?'); values.push(updates.promptTemplate || null) }
        if (updates.systemPromptAddition !== undefined) { fields.push('system_prompt_addition = ?'); values.push(updates.systemPromptAddition || null) }
        if (updates.inputVariables !== undefined) { fields.push('input_variables = ?'); values.push(updates.inputVariables ? JSON.stringify(updates.inputVariables) : null) }
        if (updates.nativeConfig !== undefined) { fields.push('native_config = ?'); values.push(updates.nativeConfig ? JSON.stringify(updates.nativeConfig) : null) }
        if (updates.orchestrationConfig !== undefined) { fields.push('orchestration_config = ?'); values.push(updates.orchestrationConfig ? JSON.stringify(updates.orchestrationConfig) : null) }
        if (updates.requiredMcps !== undefined) { fields.push('required_mcps = ?'); values.push(updates.requiredMcps ? JSON.stringify(updates.requiredMcps) : null) }
        if (updates.isInstalled !== undefined) { fields.push('is_installed = ?'); values.push(updates.isInstalled ? 1 : 0) }
        if (updates.isEnabled !== undefined) { fields.push('is_enabled = ?'); values.push(updates.isEnabled ? 1 : 0) }
        if (updates.source !== undefined) { fields.push('source = ?'); values.push(updates.source) }
        if (updates.version !== undefined) { fields.push('version = ?'); values.push(updates.version || null) }
        if (updates.author !== undefined) { fields.push('author = ?'); values.push(updates.author || null) }
        if (updates.tags !== undefined) { fields.push('tags = ?'); values.push(updates.tags ? JSON.stringify(updates.tags) : null) }

        if (fields.length > 0) {
          fields.push('updated_at = ?')
          values.push(new Date().toISOString())
          values.push(id)
          this.db.prepare(`UPDATE skills SET ${fields.join(', ')} WHERE id = ?`).run(...values)
        }
      } catch (err) {
        console.error('[SkillRepository] update error:', err)
      }
    } else {
      const existing = this.memSkills.get(id)
      if (existing) {
        this.memSkills.set(id, { ...existing, ...updates, updatedAt: new Date().toISOString() })
      }
    }
  }

  delete(id: string): boolean {
    if (this.usingSqlite) {
      try {
        const result = this.db.prepare('DELETE FROM skills WHERE id = ?').run(id)
        return result.changes > 0
      } catch (err) {
        console.error('[SkillRepository] delete error:', err)
        return false
      }
    }
    return this.memSkills.delete(id)
  }

  /**
   * 启动时清理：删除 name 为 session-<数字> 格式的脏数据 skill
   * 这类记录是自动化程序误写入的，不应出现在技能库中
   */
  cleanupSessionSkills(): number {
    if (this.usingSqlite) {
      try {
        const result = this.db.prepare(
          "DELETE FROM skills WHERE name LIKE 'session-%' AND name REGEXP '^session-[0-9]+'"
        ).run()
        if (result.changes > 0) {
          console.log(`[SkillRepository] 清理 session-ID 格式 skill ${result.changes} 条`)
        }
        return result.changes
      } catch (_regexpErr) {
        // better-sqlite3 默认不支持 REGEXP，降级用 LIKE + 手动过滤
        try {
          const rows: any[] = this.db.prepare(
            "SELECT id, name FROM skills WHERE name LIKE 'session-%'"
          ).all()
          const toDelete = rows.filter((r: any) => /^session-\d+/.test(r.name))
          for (const r of toDelete) {
            this.db.prepare('DELETE FROM skills WHERE id = ?').run(r.id)
          }
          if (toDelete.length > 0) {
            console.log(`[SkillRepository] 清理 session-ID 格式 skill ${toDelete.length} 条:`, toDelete.map((r: any) => r.name))
          }
          return toDelete.length
        } catch (err) {
          console.error('[SkillRepository] cleanupSessionSkills error:', err)
          return 0
        }
      }
    }
    // 内存模式
    let count = 0
    for (const [id, skill] of this.memSkills) {
      if (/^session-\d+/.test(skill.name)) {
        this.memSkills.delete(id)
        count++
      }
    }
    return count
  }

  /**
   * 幂等写入（用于内置数据初始化，主键已存在则跳过）
   */
  insertOrIgnore(skill: Skill): void {
    if (this.usingSqlite) {
      try {
        this.db.prepare(`
          INSERT OR IGNORE INTO skills (
            id, name, description, category, slash_command,
            type, compatible_providers,
            prompt_template, system_prompt_addition, input_variables,
            native_config, orchestration_config, required_mcps,
            is_installed, is_enabled, source,
            version, author, tags, created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?,
            ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?, ?
          )
        `).run(
          skill.id,
          skill.name,
          skill.description || '',
          skill.category || 'general',
          skill.slashCommand || null,
          skill.type,
          JSON.stringify(skill.compatibleProviders),
          skill.promptTemplate || null,
          skill.systemPromptAddition || null,
          skill.inputVariables ? JSON.stringify(skill.inputVariables) : null,
          skill.nativeConfig ? JSON.stringify(skill.nativeConfig) : null,
          skill.orchestrationConfig ? JSON.stringify(skill.orchestrationConfig) : null,
          skill.requiredMcps ? JSON.stringify(skill.requiredMcps) : null,
          skill.isInstalled ? 1 : 0,
          skill.isEnabled ? 1 : 0,
          skill.source,
          skill.version || null,
          skill.author || null,
          skill.tags ? JSON.stringify(skill.tags) : null,
          skill.createdAt,
          skill.updatedAt
        )
      } catch (err) {
        console.error('[SkillRepository] insertOrIgnore error:', err)
      }
    } else {
      // 内存模式：已存在则跳过
      if (!this.memSkills.has(skill.id)) {
        this.memSkills.set(skill.id, skill)
      }
    }
  }

  toggleEnabled(id: string, enabled: boolean): void {
    if (this.usingSqlite) {
      try {
        this.db.prepare('UPDATE skills SET is_enabled = ?, updated_at = ? WHERE id = ?')
          .run(enabled ? 1 : 0, new Date().toISOString(), id)
      } catch (err) {
        console.error('[SkillRepository] toggleEnabled error:', err)
      }
    } else {
      const existing = this.memSkills.get(id)
      if (existing) {
        this.memSkills.set(id, { ...existing, isEnabled: enabled, updatedAt: new Date().toISOString() })
      }
    }
  }

  private mapRow(row: any): Skill {
    // 安全解析 JSON 字段：解析失败时返回 fallback，避免单行脏数据导致整批读取崩溃
    const safeParse = <T>(val: any, fallback: T): T => {
      if (!val) return fallback
      try { return JSON.parse(val) as T } catch (e) {
        console.warn('[SkillRepository] JSON.parse failed for field, value:', String(val).slice(0, 80), e)
        return fallback
      }
    }

    // compatible_providers 可能是 '"all"'（JSON字符串）或 '["claude-code"]'（JSON数组）
    // 额外防御：safeParse 成功但值既不是 'all' 也不是数组时（脏数据），回退到 'all'
    const rawParsed = safeParse(row.compatible_providers, 'all' as const)
    const compatibleProviders: string[] | 'all' =
      rawParsed === 'all' || Array.isArray(rawParsed) ? rawParsed : 'all'

    return {
      id: row.id,
      name: row.name,
      description: row.description || '',
      category: row.category || 'general',
      slashCommand: row.slash_command || undefined,
      type: row.type || 'prompt',
      compatibleProviders,
      promptTemplate: row.prompt_template || undefined,
      systemPromptAddition: row.system_prompt_addition || undefined,
      inputVariables: safeParse(row.input_variables, undefined),
      nativeConfig: safeParse(row.native_config, undefined),
      orchestrationConfig: safeParse(row.orchestration_config, undefined),
      requiredMcps: safeParse(row.required_mcps, undefined),
      isInstalled: row.is_installed === 1,
      isEnabled: row.is_enabled === 1,
      source: row.source || 'custom',
      version: row.version || undefined,
      author: row.author || undefined,
      tags: safeParse(row.tags, undefined),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
