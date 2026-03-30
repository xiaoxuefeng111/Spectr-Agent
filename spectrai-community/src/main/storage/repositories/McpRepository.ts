/**
 * McpRepository - MCP 服务器配置的 CRUD 操作
 */
import type { McpServer } from '../../../shared/types'

export class McpRepository {
  private memServers: Map<string, McpServer> = new Map()

  constructor(private db: any, private usingSqlite: boolean) {}

  getAll(): McpServer[] {
    if (this.usingSqlite) {
      try {
        const rows = this.db.prepare('SELECT * FROM mcp_servers ORDER BY created_at ASC').all()
        return rows.map((r: any) => this.mapRow(r))
      } catch (err) {
        console.error('[McpRepository] getAll error:', err)
      }
    }
    return Array.from(this.memServers.values())
  }

  get(id: string): McpServer | undefined {
    if (this.usingSqlite) {
      try {
        const row = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id)
        return row ? this.mapRow(row) : undefined
      } catch (err) {
        console.error('[McpRepository] get error:', err)
      }
    }
    return this.memServers.get(id)
  }

  create(server: Omit<McpServer, 'createdAt' | 'updatedAt'>): McpServer {
    const now = new Date().toISOString()
    const full: McpServer = { ...server, createdAt: now, updatedAt: now }

    if (this.usingSqlite) {
      try {
        this.db.prepare(`
          INSERT INTO mcp_servers (
            id, name, description, category, transport,
            command, args, url, headers, compatible_providers, fallback_mode,
            config_schema, user_config, env_vars,
            is_installed, install_method, install_command,
            source, registry_url, version,
            is_global_enabled, enabled_for_providers,
            tags, author, homepage, created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?,
            ?, ?, ?, ?, ?
          )
        `).run(
          full.id,
          full.name,
          full.description || '',
          full.category,
          full.transport,
          full.command || null,
          full.args ? JSON.stringify(full.args) : null,
          full.url || null,
          full.headers ? JSON.stringify(full.headers) : null,
          JSON.stringify(full.compatibleProviders),
          full.fallbackMode,
          full.configSchema ? JSON.stringify(full.configSchema) : null,
          full.userConfig ? JSON.stringify(full.userConfig) : null,
          full.envVars ? JSON.stringify(full.envVars) : null,
          full.isInstalled ? 1 : 0,
          full.installMethod,
          full.installCommand || null,
          full.source,
          full.registryUrl || null,
          full.version || null,
          full.isGlobalEnabled ? 1 : 0,
          full.enabledForProviders ? JSON.stringify(full.enabledForProviders) : null,
          full.tags ? JSON.stringify(full.tags) : null,
          full.author || null,
          full.homepage || null,
          full.createdAt,
          full.updatedAt
        )
      } catch (err) {
        console.error('[McpRepository] create error:', err)
      }
    } else {
      this.memServers.set(full.id, full)
    }

    return full
  }

  update(id: string, updates: Partial<Omit<McpServer, 'id' | 'createdAt'>>): void {
    if (this.usingSqlite) {
      try {
        const fields: string[] = []
        const values: any[] = []

        if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name) }
        if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description) }
        if (updates.category !== undefined) { fields.push('category = ?'); values.push(updates.category) }
        if (updates.transport !== undefined) { fields.push('transport = ?'); values.push(updates.transport) }
        if (updates.command !== undefined) { fields.push('command = ?'); values.push(updates.command || null) }
        if (updates.args !== undefined) { fields.push('args = ?'); values.push(updates.args ? JSON.stringify(updates.args) : null) }
        if (updates.url !== undefined) { fields.push('url = ?'); values.push(updates.url || null) }
        if (updates.headers !== undefined) { fields.push('headers = ?'); values.push(updates.headers ? JSON.stringify(updates.headers) : null) }
        if (updates.compatibleProviders !== undefined) { fields.push('compatible_providers = ?'); values.push(JSON.stringify(updates.compatibleProviders)) }
        if (updates.fallbackMode !== undefined) { fields.push('fallback_mode = ?'); values.push(updates.fallbackMode) }
        if (updates.configSchema !== undefined) { fields.push('config_schema = ?'); values.push(updates.configSchema ? JSON.stringify(updates.configSchema) : null) }
        if (updates.userConfig !== undefined) { fields.push('user_config = ?'); values.push(updates.userConfig ? JSON.stringify(updates.userConfig) : null) }
        if (updates.envVars !== undefined) { fields.push('env_vars = ?'); values.push(updates.envVars ? JSON.stringify(updates.envVars) : null) }
        if (updates.isInstalled !== undefined) { fields.push('is_installed = ?'); values.push(updates.isInstalled ? 1 : 0) }
        if (updates.installMethod !== undefined) { fields.push('install_method = ?'); values.push(updates.installMethod) }
        if (updates.installCommand !== undefined) { fields.push('install_command = ?'); values.push(updates.installCommand || null) }
        if (updates.source !== undefined) { fields.push('source = ?'); values.push(updates.source) }
        if (updates.registryUrl !== undefined) { fields.push('registry_url = ?'); values.push(updates.registryUrl || null) }
        if (updates.version !== undefined) { fields.push('version = ?'); values.push(updates.version || null) }
        if (updates.isGlobalEnabled !== undefined) { fields.push('is_global_enabled = ?'); values.push(updates.isGlobalEnabled ? 1 : 0) }
        if (updates.enabledForProviders !== undefined) { fields.push('enabled_for_providers = ?'); values.push(updates.enabledForProviders ? JSON.stringify(updates.enabledForProviders) : null) }
        if (updates.tags !== undefined) { fields.push('tags = ?'); values.push(updates.tags ? JSON.stringify(updates.tags) : null) }
        if (updates.author !== undefined) { fields.push('author = ?'); values.push(updates.author || null) }
        if (updates.homepage !== undefined) { fields.push('homepage = ?'); values.push(updates.homepage || null) }

        if (fields.length > 0) {
          fields.push('updated_at = ?')
          values.push(new Date().toISOString())
          values.push(id)
          this.db.prepare(`UPDATE mcp_servers SET ${fields.join(', ')} WHERE id = ?`).run(...values)
        }
      } catch (err) {
        console.error('[McpRepository] update error:', err)
      }
    } else {
      const existing = this.memServers.get(id)
      if (existing) {
        this.memServers.set(id, { ...existing, ...updates, updatedAt: new Date().toISOString() })
      }
    }
  }

  delete(id: string): boolean {
    if (this.usingSqlite) {
      try {
        const result = this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
        return result.changes > 0
      } catch (err) {
        console.error('[McpRepository] delete error:', err)
        return false
      }
    }
    return this.memServers.delete(id)
  }

  /**
   * 获取对指定 Provider 启用的 MCP 服务器列表（核心方法）
   * 过滤规则：
   * 1. is_global_enabled = 1
   * 2. compatible_providers 为 'all' 或包含 providerId
   * 3. enabled_for_providers 为 null（所有 Provider）或包含 providerId
   */
  getEnabledForProvider(providerId: string): McpServer[] {
    if (this.usingSqlite) {
      try {
        const rows = this.db.prepare('SELECT * FROM mcp_servers WHERE is_global_enabled = 1').all()
        return rows.map((r: any) => this.mapRow(r)).filter((server: McpServer) => {
          // 检查 compatibleProviders
          const compatProviders = server.compatibleProviders
          if (compatProviders !== 'all' && !compatProviders.includes(providerId)) return false
          // 检查 enabledForProviders（null=所有，array=仅指定）
          if (server.enabledForProviders && !server.enabledForProviders.includes(providerId)) return false
          return true
        })
      } catch (err) {
        console.error('[McpRepository] getEnabledForProvider error:', err)
      }
    }
    // 内存 fallback
    return Array.from(this.memServers.values()).filter(s => {
      if (!s.isGlobalEnabled) return false
      const compat = s.compatibleProviders
      if (compat !== 'all' && !compat.includes(providerId)) return false
      if (s.enabledForProviders && !s.enabledForProviders.includes(providerId)) return false
      return true
    })
  }

  /**
   * 幂等写入（用于内置数据初始化，主键已存在则跳过）
   */
  insertOrIgnore(server: McpServer): void {
    if (this.usingSqlite) {
      try {
        this.db.prepare(`
          INSERT OR IGNORE INTO mcp_servers (
            id, name, description, category, transport,
            command, args, url, headers, compatible_providers, fallback_mode,
            config_schema, user_config, env_vars,
            is_installed, install_method, install_command,
            source, registry_url, version,
            is_global_enabled, enabled_for_providers,
            tags, author, homepage, created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?,
            ?, ?, ?, ?, ?
          )
        `).run(
          server.id,
          server.name,
          server.description || '',
          server.category,
          server.transport,
          server.command || null,
          server.args ? JSON.stringify(server.args) : null,
          server.url || null,
          server.headers ? JSON.stringify(server.headers) : null,
          JSON.stringify(server.compatibleProviders),
          server.fallbackMode,
          server.configSchema ? JSON.stringify(server.configSchema) : null,
          server.userConfig ? JSON.stringify(server.userConfig) : null,
          server.envVars ? JSON.stringify(server.envVars) : null,
          server.isInstalled ? 1 : 0,
          server.installMethod,
          server.installCommand || null,
          server.source,
          server.registryUrl || null,
          server.version || null,
          server.isGlobalEnabled ? 1 : 0,
          server.enabledForProviders ? JSON.stringify(server.enabledForProviders) : null,
          server.tags ? JSON.stringify(server.tags) : null,
          server.author || null,
          server.homepage || null,
          server.createdAt,
          server.updatedAt
        )
      } catch (err) {
        console.error('[McpRepository] insertOrIgnore error:', err)
      }
    } else {
      // 内存模式：已存在则跳过
      if (!this.memServers.has(server.id)) {
        this.memServers.set(server.id, server)
      }
    }
  }

  toggleGlobal(id: string, enabled: boolean): void {
    if (this.usingSqlite) {
      try {
        this.db.prepare('UPDATE mcp_servers SET is_global_enabled = ?, updated_at = ? WHERE id = ?')
          .run(enabled ? 1 : 0, new Date().toISOString(), id)
      } catch (err) {
        console.error('[McpRepository] toggleGlobal error:', err)
      }
    } else {
      const existing = this.memServers.get(id)
      if (existing) {
        this.memServers.set(id, { ...existing, isGlobalEnabled: enabled, updatedAt: new Date().toISOString() })
      }
    }
  }

  private mapRow(row: any): McpServer {
    // compatible_providers 可能是 '"all"'（JSON字符串）或 '["claude-code","codex"]'（JSON数组）
    let compatibleProviders: string[] | 'all' = 'all'
    try {
      compatibleProviders = JSON.parse(row.compatible_providers)
    } catch { /* 保持默认值 */ }

    // enabled_for_providers 可能为 null（表示所有 Provider）或 JSON 数组
    let enabledForProviders: string[] | undefined = undefined
    if (row.enabled_for_providers) {
      try {
        enabledForProviders = JSON.parse(row.enabled_for_providers)
      } catch { /* 保持 undefined */ }
    }

    return {
      id: row.id,
      name: row.name,
      description: row.description || '',
      category: row.category || 'custom',
      transport: row.transport || 'stdio',
      command: row.command || undefined,
      args: row.args ? JSON.parse(row.args) : undefined,
      url: row.url || undefined,
      headers: row.headers ? JSON.parse(row.headers) : undefined,
      compatibleProviders,
      fallbackMode: row.fallback_mode || 'disabled',
      configSchema: row.config_schema ? JSON.parse(row.config_schema) : undefined,
      userConfig: row.user_config ? JSON.parse(row.user_config) : undefined,
      envVars: row.env_vars ? JSON.parse(row.env_vars) : undefined,
      isInstalled: row.is_installed === 1,
      installMethod: row.install_method || 'builtin',
      installCommand: row.install_command || undefined,
      source: row.source || 'custom',
      registryUrl: row.registry_url || undefined,
      version: row.version || undefined,
      isGlobalEnabled: row.is_global_enabled === 1,
      enabledForProviders,
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      author: row.author || undefined,
      homepage: row.homepage || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
