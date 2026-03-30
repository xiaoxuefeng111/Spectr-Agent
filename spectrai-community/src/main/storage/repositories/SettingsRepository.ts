/**
 * SettingsRepository - App Settings 相关数据库操作
 */

export class SettingsRepository {
  constructor(private db: any, private usingSqlite: boolean) {}

  getAppSettings(): Record<string, any> {
    const defaults: Record<string, any> = {
      autoWorktree: false,
      autoLaunch: false,
    }
    if (!this.db) return defaults
    try {
      const rows = this.db.prepare('SELECT key, value FROM app_settings').all() as { key: string; value: string }[]
      const result = { ...defaults }
      for (const row of rows) {
        try {
          result[row.key] = JSON.parse(row.value)
        } catch {
          result[row.key] = row.value
        }
      }
      return result
    } catch (err) {
      console.warn('[Database] getAppSettings error:', err)
      return defaults
    }
  }

  updateAppSetting(key: string, value: any): void {
    if (!this.db) return
    try {
      this.db.prepare(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(key, JSON.stringify(value))
    } catch (err) {
      console.warn('[Database] updateAppSetting error:', err)
    }
  }
}
