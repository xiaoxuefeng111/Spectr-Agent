/**
 * DirectoryRepository - Favorite Directories 相关数据库操作
 */

export class DirectoryRepository {
  constructor(private db: any, private usingSqlite: boolean) {}

  /**
   * 记录工作目录使用（upsert：已存在则更新计数和时间）
   */
  recordDirectoryUsage(dirPath: string): void {
    if (!this.db) return
    try {
      const existing = this.db.prepare(
        'SELECT id, use_count FROM favorite_directories WHERE path = ?'
      ).get(dirPath) as any

      if (existing) {
        this.db.prepare(
          'UPDATE favorite_directories SET use_count = use_count + 1, last_used_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run(existing.id)
      } else {
        this.db.prepare(
          'INSERT INTO favorite_directories (path) VALUES (?)'
        ).run(dirPath)
      }
    } catch (err) {
      console.warn('[Database] recordDirectoryUsage error:', err)
    }
  }

  /**
   * 获取最近使用的目录列表（收藏优先，按最近使用排序）
   */
  getRecentDirectories(limit: number = 8): Array<{ path: string; isPinned: boolean; useCount: number; lastUsedAt: string }> {
    if (!this.db) return []
    try {
      const rows = this.db.prepare(
        'SELECT path, is_pinned, use_count, last_used_at FROM favorite_directories ORDER BY is_pinned DESC, last_used_at DESC LIMIT ?'
      ).all(limit) as any[]
      return rows.map((row: any) => ({
        path: row.path,
        isPinned: row.is_pinned === 1,
        useCount: row.use_count,
        lastUsedAt: row.last_used_at
      }))
    } catch (err) {
      console.warn('[Database] getRecentDirectories error:', err)
      return []
    }
  }

  /**
   * 切换目录收藏状态（若目录不存在则新增并收藏）
   */
  toggleDirectoryPin(dirPath: string): boolean {
    if (!this.db) return false
    try {
      const existing = this.db.prepare(
        'SELECT id, is_pinned FROM favorite_directories WHERE path = ?'
      ).get(dirPath) as any

      if (existing) {
        const newPinned = existing.is_pinned === 1 ? 0 : 1
        this.db.prepare(
          'UPDATE favorite_directories SET is_pinned = ? WHERE id = ?'
        ).run(newPinned, existing.id)
        return newPinned === 1
      } else {
        // 目录不存在，直接添加为收藏
        this.db.prepare(
          'INSERT INTO favorite_directories (path, is_pinned, use_count) VALUES (?, 1, 0)'
        ).run(dirPath)
        return true
      }
    } catch (err) {
      console.warn('[Database] toggleDirectoryPin error:', err)
      return false
    }
  }

  /**
   * 删除目录记录
   */
  removeDirectory(dirPath: string): void {
    if (!this.db) return
    try {
      this.db.prepare('DELETE FROM favorite_directories WHERE path = ?').run(dirPath)
    } catch (err) {
      console.warn('[Database] removeDirectory error:', err)
    }
  }
}
