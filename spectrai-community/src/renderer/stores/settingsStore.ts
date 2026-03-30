/**
 * 全局应用设置 Zustand Store
 *
 * 持久化存储在 SQLite app_settings 表中，通过 IPC 读写。
 * 渲染进程启动时调用 fetchSettings() 初始化。
 *
 * @author weibin
 */

import { create } from 'zustand'

/** 代理类型 */
export type ProxyType = 'none' | 'http' | 'socks5'

/** 全局应用设置接口 */
export interface AppSettings {
  /** 任务看板：新建任务时是否默认启用 Git Worktree 隔离 */
  autoWorktree: boolean
  /** 全局代理类型：none | http | socks5 */
  proxyType: ProxyType
  /** 代理主机地址（如 127.0.0.1） */
  proxyHost: string
  /** 代理端口（如 7890） */
  proxyPort: string
  /** 代理认证用户名（可选） */
  proxyUsername: string
  /** 代理认证密码（可选） */
  proxyPassword: string
  /** 系统通知：会话完成时是否发送 OS 系统通知 */
  notificationEnabled: boolean
  /** 开机自启：系统登录后是否自动启动应用 */
  autoLaunch: boolean
}

/** 默认设置值（与 Database.ts 中的 defaults 保持一致） */
const DEFAULT_SETTINGS: AppSettings = {
  autoWorktree: false,
  proxyType: 'none',
  proxyHost: '',
  proxyPort: '',
  proxyUsername: '',
  proxyPassword: '',
  notificationEnabled: true,
  autoLaunch: false,
}

interface SettingsState {
  settings: AppSettings
  loaded: boolean
  /** 从主进程加载设置 */
  fetchSettings: () => Promise<void>
  /** 更新单个设置项（乐观更新 + 持久化） */
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>
  /** 批量更新多个设置项 */
  updateSettings: (updates: Partial<AppSettings>) => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: { ...DEFAULT_SETTINGS },
  loaded: false,

  fetchSettings: async () => {
    try {
      const raw = await window.spectrAI.settings.getAll()
      const settings: AppSettings = {
        ...DEFAULT_SETTINGS,
        ...(raw as Partial<AppSettings>),
      }
      set({ settings, loaded: true })
    } catch (err) {
      console.warn('[settingsStore] fetchSettings error:', err)
      set({ loaded: true }) // 即使失败也标记 loaded，使用默认值
    }
  },

  updateSetting: async (key, value) => {
    // 乐观更新 UI
    set((s) => ({ settings: { ...s.settings, [key]: value } }))
    try {
      await window.spectrAI.settings.update(key, value)
    } catch (err) {
      console.warn('[settingsStore] updateSetting error:', err)
      // 回滚
      const prev = get().settings
      set({ settings: { ...prev, [key]: DEFAULT_SETTINGS[key] } })
    }
  },

  updateSettings: async (updates) => {
    // 乐观更新 UI
    set((s) => ({ settings: { ...s.settings, ...updates } }))
    try {
      for (const [key, value] of Object.entries(updates)) {
        await window.spectrAI.settings.update(key, value)
      }
    } catch (err) {
      console.warn('[settingsStore] updateSettings error:', err)
    }
  },
}))
