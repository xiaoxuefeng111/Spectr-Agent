/**
 * Adapter 注册表 —— 管理 Provider ID → Adapter 实例的映射
 * @author weibin
 */

import type { BaseProviderAdapter } from './types'

export type AdapterType = 'claude-sdk' | 'codex-appserver' | 'gemini-headless' | 'iflow-acp' | 'opencode-sdk'

export class AdapterRegistry {
  private adapters: Map<string, BaseProviderAdapter> = new Map()

  /**
   * 注册 Adapter 实例
   * @param adapter Adapter 实例（providerId 作为 key）
   */
  register(adapter: BaseProviderAdapter): void {
    if (this.adapters.has(adapter.providerId)) {
      throw new Error(`Adapter already registered for provider: ${adapter.providerId}`)
    }
    this.adapters.set(adapter.providerId, adapter)
  }

  /**
   * 按 Provider ID 获取 Adapter
   * @param providerId Provider 标识
   */
  get(providerId: string): BaseProviderAdapter {
    const adapter = this.adapters.get(providerId)
    if (!adapter) {
      throw new Error(`No adapter registered for provider: ${providerId}. Available: ${[...this.adapters.keys()].join(', ')}`)
    }
    return adapter
  }

  /**
   * 按 AdapterType 获取 Adapter
   * 用于通过配置的 adapterType 字段查找
   */
  getByType(adapterType: AdapterType): BaseProviderAdapter {
    for (const adapter of this.adapters.values()) {
      if (this.matchType(adapter.providerId, adapterType)) {
        return adapter
      }
    }
    throw new Error(`No adapter registered for type: ${adapterType}`)
  }

  /**
   * 检查是否已注册
   */
  has(providerId: string): boolean {
    return this.adapters.has(providerId)
  }

  /**
   * 获取所有已注册的 Provider ID
   */
  getRegisteredIds(): string[] {
    return [...this.adapters.keys()]
  }

  /**
   * 清理所有 Adapter 资源
   */
  cleanup(): void {
    for (const adapter of this.adapters.values()) {
      try {
        adapter.cleanup()
      } catch (err) {
        console.error(`[AdapterRegistry] Error cleaning up ${adapter.providerId}:`, err)
      }
    }
    this.adapters.clear()
  }

  /**
   * Provider ID → AdapterType 匹配
   */
  private matchType(providerId: string, adapterType: AdapterType): boolean {
    switch (adapterType) {
      case 'claude-sdk':
        return providerId === 'claude-code'
      case 'codex-appserver':
        return providerId === 'codex'
      case 'gemini-headless':
        return providerId === 'gemini-cli'
      case 'iflow-acp':
        return providerId === 'iflow'
      case 'opencode-sdk':
        return providerId === 'opencode'
      default:
        return false
    }
  }
}
