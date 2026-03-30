/**
 * 数据迁移模块
 *
 * 项目从 ClaudeOps 更名为 SpectrAI 后，Electron 的 userData 路径
 * 从 %APPDATA%/claudeops 变为 %APPDATA%/spectrai。
 * 此模块在应用启动时自动将旧目录中的数据迁移到新目录。
 *
 * @author weibin
 */

import { app } from 'electron'
import { existsSync, copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import type { DatabaseManager } from './storage/Database'

/** 旧项目名（更名前） */
const LEGACY_APP_NAME = 'claudeops'

/** 迁移完成标记文件 */
const MIGRATION_MARKER = '.migrated-from-claudeops'

/**
 * 获取旧 userData 目录路径
 * Windows: %APPDATA%/claudeops
 * macOS: ~/Library/Application Support/claudeops
 * Linux: ~/.config/claudeops
 */
function getLegacyUserDataPath(): string {
  const currentPath = app.getPath('userData')
  const parentDir = dirname(currentPath)
  return join(parentDir, LEGACY_APP_NAME)
}

/**
 * 递归复制目录
 */
function copyDirSync(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  const entries = readdirSync(src)
  for (const entry of entries) {
    const srcPath = join(src, entry)
    const destPath = join(dest, entry)
    const stat = statSync(srcPath)
    if (stat.isDirectory()) {
      copyDirSync(srcPath, destPath)
    } else {
      copyFileSync(srcPath, destPath)
    }
  }
}

/**
 * 需要迁移的文件和目录列表
 */
const MIGRATION_ITEMS = [
  { path: 'claudeops.db', type: 'file' as const },
  { path: 'claudeops.db-wal', type: 'file' as const },
  { path: 'claudeops.db-shm', type: 'file' as const },
  { path: 'window-state.json', type: 'file' as const },
  { path: 'logs', type: 'dir' as const },
  { path: 'attachments', type: 'dir' as const },
]

/**
 * 执行从旧 userData 到新 userData 的数据迁移
 *
 * 调用时机：app.whenReady() 之后、initializeManagers() 之前
 *
 * @returns 迁移结果摘要
 */
export function migrateFromLegacyUserData(): { migrated: boolean; details: string[] } {
  const currentUserData = app.getPath('userData')
  const legacyUserData = getLegacyUserDataPath()
  const details: string[] = []

  // 如果当前 userData 就是旧路径（name 没改或已回退），无需迁移
  if (currentUserData === legacyUserData) {
    return { migrated: false, details: ['当前 userData 路径与旧路径相同，无需迁移'] }
  }

  // 如果旧目录不存在，没有可迁移的数据
  if (!existsSync(legacyUserData)) {
    return { migrated: false, details: ['旧数据目录不存在，跳过迁移'] }
  }

  // 如果已经迁移过，不再重复
  const markerPath = join(currentUserData, MIGRATION_MARKER)
  if (existsSync(markerPath)) {
    return { migrated: false, details: ['已完成迁移，跳过'] }
  }

  // 如果新目录中已有数据库，说明用户已经在新版本中产生了数据，不覆盖
  const newDbPath = join(currentUserData, 'claudeops.db')
  if (existsSync(newDbPath)) {
    // 仍然写标记，避免每次启动都检查
    mkdirSync(currentUserData, { recursive: true })
    writeFileSync(markerPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      skipped: true,
      reason: '新目录已存在数据库，跳过迁移以避免覆盖'
    }))
    details.push('新目录已存在数据库，跳过迁移以避免覆盖用户数据')
    return { migrated: false, details }
  }

  // 执行迁移
  console.log(`[migration] 检测到旧数据目录: ${legacyUserData}`)
  console.log(`[migration] 开始迁移到: ${currentUserData}`)
  mkdirSync(currentUserData, { recursive: true })

  let migratedCount = 0

  for (const item of MIGRATION_ITEMS) {
    const srcPath = join(legacyUserData, item.path)
    const destPath = join(currentUserData, item.path)

    if (!existsSync(srcPath)) {
      continue
    }

    try {
      if (item.type === 'file') {
        mkdirSync(dirname(destPath), { recursive: true })
        copyFileSync(srcPath, destPath)
        details.push(`✓ 已迁移文件: ${item.path}`)
      } else {
        copyDirSync(srcPath, destPath)
        details.push(`✓ 已迁移目录: ${item.path}`)
      }
      migratedCount++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      details.push(`✗ 迁移失败 ${item.path}: ${msg}`)
      console.error(`[migration] 迁移 ${item.path} 失败:`, err)
    }
  }

  // 写入迁移标记
  writeFileSync(markerPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    from: legacyUserData,
    to: currentUserData,
    migratedCount,
    details
  }, null, 2))

  console.log(`[migration] 迁移完成，共迁移 ${migratedCount} 项`)
  return { migrated: migratedCount > 0, details }
}

/**
 * 迁移 AI Provider API Key 加密格式
 *
 * 历史上 API Key 使用 userData 路径派生密钥加密，更名后路径变化导致解密失败。
 * 此函数将数据库中所有 provider 的 api_key_encrypted 字段
 * 用旧密钥解密后以新的固定密钥重新加密，一次性修复。
 *
 * @param database 已初始化的 DatabaseManager
 */
export function migrateApiKeyEncryption(_database: DatabaseManager): void {
  // API key re-encryption migration is no longer needed in community edition.
}
