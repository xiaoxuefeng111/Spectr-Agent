/**
 * migrationRunner.ts — 数据库迁移运行器
 * 使用 schema_version 表跟踪已执行的迁移版本，只执行未执行过的迁移。
 * @author weibin
 */

import type { Migration } from './migrations'

/**
 * 执行数据库迁移
 * @param db better-sqlite3 实例
 * @param migrations 版本化迁移数组（必须按 version 升序）
 */
export function runMigrations(db: any, migrations: Migration[]): void {
  if (!db) return

  // 1) 确保 schema_version 跟踪表存在
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // 2) 读取已执行的最大版本号
  const row = db.prepare('SELECT MAX(version) AS max_ver FROM schema_version').get() as any
  const currentVersion: number = row?.max_ver ?? 0

  // 3) 过滤出需要执行的迁移
  const pending = migrations.filter(m => m.version > currentVersion)
  if (pending.length === 0) return

  // 4) 按版本号升序排序后逐条执行
  pending.sort((a, b) => a.version - b.version)

  const insertStmt = db.prepare(
    'INSERT INTO schema_version (version, description) VALUES (?, ?)'
  )

  for (const m of pending) {
    try {
      m.up(db)
      insertStmt.run(m.version, m.description)
      console.log(`[Migration] v${m.version}: ${m.description}`)
    } catch (err) {
      console.warn(`[Migration] v${m.version} failed:`, err)
      // 继续执行后续迁移，避免单条失败阻塞全部
    }
  }

  console.log(`[Migration] Applied ${pending.length} migration(s), now at v${pending[pending.length - 1].version}`)
}
