/**
 * Skill 技能模板状态管理
 * @author weibin
 */
import { create } from 'zustand'
import type { Skill } from '../../shared/types'

interface SkillState {
  skills: Skill[]
  loading: boolean
  error: string | null

  fetchAll: () => Promise<void>
  create: (skill: Omit<Skill, 'createdAt' | 'updatedAt'>) => Promise<Skill | null>
  update: (id: string, updates: Partial<Skill>) => Promise<void>
  remove: (id: string) => Promise<void>
  toggle: (id: string, enabled: boolean) => Promise<void>
  clearError: () => void
  /** 初始化 MCP install_skill 通知监听器，应在 App 启动时调用一次，返回取消监听函数 */
  initMcpInstallListener: () => () => void
}

export const useSkillStore = create<SkillState>((set, _get) => ({
  skills: [],
  loading: false,
  error: null,

  fetchAll: async () => {
    set({ loading: true, error: null })
    try {
      const result = await (window as any).spectrAI.skill.getAll()
      if (result.success) {
        set({ skills: result.data || [], loading: false })
      } else {
        set({ error: result.error, loading: false })
      }
    } catch (err) {
      set({ error: (err as Error).message, loading: false })
    }
  },

  create: async (skill) => {
    try {
      const result = await (window as any).spectrAI.skill.create(skill)
      if (result.success) {
        set(state => ({ skills: [...state.skills, result.data] }))
        return result.data
      }
      set({ error: result.error })
      return null
    } catch (err) {
      set({ error: (err as Error).message })
      return null
    }
  },

  update: async (id, updates) => {
    try {
      const result = await (window as any).spectrAI.skill.update(id, updates)
      if (result.success) {
        set(state => ({
          skills: state.skills.map(s => s.id === id ? { ...s, ...updates } : s)
        }))
      } else {
        set({ error: result.error })
      }
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  remove: async (id) => {
    try {
      const result = await (window as any).spectrAI.skill.delete(id)
      if (result.success) {
        set(state => ({ skills: state.skills.filter(s => s.id !== id) }))
      } else {
        set({ error: result.error })
      }
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  toggle: async (id, enabled) => {
    try {
      const result = await (window as any).spectrAI.skill.toggle(id, enabled)
      if (result.success) {
        set(state => ({
          skills: state.skills.map(s => s.id === id ? { ...s, isEnabled: enabled } : s)
        }))
      } else {
        set({ error: result.error })
      }
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  clearError: () => set({ error: null }),

  initMcpInstallListener: () => {
    const spectrAI = (window as any).spectrAI
    if (!spectrAI?.skill?.onInstalled) return () => {}

    const unsubscribe = spectrAI.skill.onInstalled((newSkill: Skill) => {
      // 收到 MCP install_skill 通知后，将新技能追加到列表（若已存在则替换）
      set(state => {
        const exists = state.skills.some(s => s.id === newSkill.id)
        if (exists) {
          return { skills: state.skills.map(s => s.id === newSkill.id ? newSkill : s) }
        }
        return { skills: [...state.skills, newSkill] }
      })
    })

    return unsubscribe
  },
}))
