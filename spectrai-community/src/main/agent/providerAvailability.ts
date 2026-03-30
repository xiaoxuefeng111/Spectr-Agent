/**
 * Provider 可用性检测
 * 检测本地是否安装了对应的 CLI 工具
 * ★ 支持 nodeVersion 切换后的 PATH 检测
 * @author weibin
 */

import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import type { AIProvider } from '../../shared/types'
import { prependNodeVersionToEnvPath } from '../node/NodeVersionResolver'

/** 可用性检测结果 */
export interface ProviderAvailability {
  id: string
  name: string
  command: string
  available: boolean
}

/** 缓存：cacheKey → available（避免频繁 spawn 进程） */
const cache = new Map<string, { available: boolean; checkedAt: number }>()
const CACHE_TTL_MS = 60_000  // 缓存 1 分钟

/**
 * 检测单个命令是否在 PATH 中可用
 * @param nodeVersion 如果指定，会在对应 nvm 版本的 PATH 下检测
 */
function checkCommand(command: string, nodeVersion?: string): Promise<boolean> {
  const cacheKey = nodeVersion ? `${command}@node${nodeVersion}` : command

  // 先查缓存
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return Promise.resolve(cached.available)
  }

  return new Promise((resolve) => {
    if (path.isAbsolute(command)) {
      let available = fs.existsSync(command)
      if (available && process.platform !== 'win32') {
        try {
          fs.accessSync(command, fs.constants.X_OK)
        } catch {
          available = false
        }
      }
      cache.set(cacheKey, { available, checkedAt: Date.now() })
      resolve(available)
      return
    }

    // Windows 用 where，Unix 用 which
    const checker = process.platform === 'win32' ? 'where' : 'which'

    // ★ 如果指定了 nodeVersion，在对应版本的 PATH 下检测
    const opts: { timeout: number; windowsHide: boolean; env?: NodeJS.ProcessEnv } = {
      timeout: 5000,
      windowsHide: true,
    }

    opts.env = prependNodeVersionToEnvPath({ ...process.env }, nodeVersion)

    execFile(checker, [command], opts, (error) => {
      const available = !error
      cache.set(cacheKey, { available, checkedAt: Date.now() })
      resolve(available)
    })
  })
}

/**
 * 批量检测所有 provider 的可用性
 */
export async function checkProviderAvailability(providers: AIProvider[]): Promise<ProviderAvailability[]> {
  const results = await Promise.all(
    providers.map(async (p) => ({
      id: p.id,
      name: p.name,
      command: p.command,
      available: await checkCommand(p.command, p.nodeVersion),
    }))
  )
  return results
}

/**
 * 过滤出可用的 provider 列表
 */
export async function getAvailableProviders(providers: AIProvider[]): Promise<AIProvider[]> {
  const results = await checkProviderAvailability(providers)
  const availableIds = new Set(results.filter(r => r.available).map(r => r.id))
  return providers.filter(p => availableIds.has(p.id))
}

/**
 * 检测单个 provider 是否可用
 */
export async function isProviderAvailable(provider: AIProvider): Promise<boolean> {
  return checkCommand(provider.command, provider.nodeVersion)
}

/**
 * 清除缓存（用于手动刷新）
 */
export function clearAvailabilityCache(): void {
  cache.clear()
}
