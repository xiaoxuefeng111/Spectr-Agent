/**
 * 会话状态管理 Store
 * @author weibin
 */

import { create } from 'zustand'
import type {
  Session,
  SessionConfig,
  SessionStatus,
  ActivityEvent,
  ConversationMessage
} from '../../shared/types'
import { sanitizeDisplayText } from '../utils/textSanitizer'

/** Agent 信息（从主进程同步） */
interface AgentInfo {
  agentId: string
  name: string
  parentSessionId: string
  childSessionId: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  prompt: string
  workDir: string
  createdAt: string
  completedAt?: string
}

interface ResumeSessionResult {
  success: boolean
  sessionId?: string
  error?: string
}

interface SessionState {
  // 状态
  sessions: Session[]
  selectedSessionId: string | null
  activities: Record<string, ActivityEvent[]>  // sessionId → 活动事件列表
  lastActivities: Record<string, ActivityEvent>  // sessionId → 最新活动
  agents: Record<string, AgentInfo[]>  // parentSessionId → Agent 列表
  stuckSessions: Record<string, string>  // sessionId -> stuck type ('startup-stuck' | 'possible-stuck' | 'stuck')
  resumingSessions: Set<string>  // sessionId -> resuming
  resumeError: string | null
  conversations: Record<string, ConversationMessage[]>  // SDK V2: sessionId → 对话消息
  streamingSessions: Set<string>  // SDK V2: 正在流式响应的会话
  conversationLoading: Record<string, boolean>  // SDK V2: 对话历史加载状态
  sessionInitData: Record<string, { model: string; tools: string[]; skills: any[]; mcpServers: any[] }>  // SDK V2: 会话初始化数据
  activityHistoryLoaded: Set<string>  // 已从数据库加载过历史活动的会话 ID（防止 session_start 竞态导致跳过加载）
  suppressNextEcho: Set<string>  // 静默执行 Skill 时，需要屏蔽 SDK 回显的会话 ID 集合

  // 方法
  fetchSessions: () => Promise<void>
  fetchHistorySessions: () => Promise<void>
  fetchSessionActivities: (sessionId: string) => Promise<void>
  createSession: (config: SessionConfig) => Promise<void>
  resumeSession: (oldSessionId: string) => Promise<ResumeSessionResult>
  openSessionForChat: (sessionId: string) => Promise<ResumeSessionResult>
  clearResumeError: () => void
  terminateSession: (id: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  sendInput: (id: string, data: string) => Promise<void>
  sendConfirmation: (id: string, accept: boolean) => Promise<void>
  resizeSession: (id: string, cols: number, rows: number) => Promise<void>
  selectSession: (id: string | null) => void
  updateSessionStatus: (id: string, status: SessionStatus) => void
  updateSessionName: (id: string, name: string) => void
  renameSession: (id: string, newName: string) => Promise<boolean>
  aiRenameSession: (id: string) => Promise<{ success: boolean; name?: string; error?: string }>
  addActivity: (sessionId: string, activity: ActivityEvent) => void
  getActivities: (sessionId: string) => ActivityEvent[]
  getLastActivity: (sessionId: string) => ActivityEvent | undefined
  autoResumeInterrupted: () => Promise<void>
  initListeners: () => void
  initAgentListeners: () => void
  initConversationListeners: () => void  // SDK V2: 对话事件监听
  cleanupListeners: () => void  // 清理所有 IPC 监听器（防泄漏）
  sendMessage: (sessionId: string, text: string) => Promise<void>  // SDK V2: 发送消息
  sendSkillMessage: (sessionId: string, skillName: string, expandedTemplate: string) => Promise<void>  // SDK V2: 静默执行 Skill
  addConversationMessage: (sessionId: string, msg: ConversationMessage) => void  // SDK V2
  bulkAddConversationMessages: (sessionId: string, msgs: ConversationMessage[]) => void
  setConversationLoading: (sessionId: string, loading: boolean) => void  // SDK V2
  setSessionInitData: (sessionId: string, data: any) => void  // SDK V2: 存储初始化数据
  fetchAgents: (parentSessionId: string) => Promise<void>
}

function getSessionStartTime(session: Session): number {
  const ts = new Date(session.startedAt || session.endedAt || 0).getTime()
  return Number.isFinite(ts) ? ts : 0
}

function sortSessionsByLatest(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => getSessionStartTime(b) - getSessionStartTime(a))
}

// 防止创建会话按钮连点导致重复请求
const createSessionInFlightKeys = new Set<string>()
const resumeSessionInFlight = new Map<string, Promise<ResumeSessionResult>>()
const chatViewTerminalStatuses = new Set<SessionStatus>(['completed', 'terminated', 'error', 'interrupted'])

// ── IPC 监听器 unsubscribe 句柄（防止重复注册导致内存泄漏） ──
let _sessionListenerUnsubs: Array<() => void> = []
let _agentListenerUnsubs: Array<() => void> = []
let _conversationListenerUnsubs: Array<() => void> = []

export const useSessionStore = create<SessionState>((set, get) => ({
  // 初始状态
  sessions: [],
  selectedSessionId: null,
  activities: {},
  lastActivities: {},
  agents: {},
  stuckSessions: {},
  resumingSessions: new Set(),
  resumeError: null,
  conversations: {},
  streamingSessions: new Set(),
  conversationLoading: {},
  sessionInitData: {},
  activityHistoryLoaded: new Set(),
  suppressNextEcho: new Set(),

  // 获取所有活跃会话（内存中的）
  fetchSessions: async () => {
    try {
      const activeSessions = await window.spectrAI.session.getAll()
      // 同时加载历史会话并合并
      const historySessions = await window.spectrAI.session.getHistory()

      // 合并：活跃会话优先，历史会话补充（去重）
      const activeIds = new Set(activeSessions.map((s: Session) => s.id))
      const pastSessions = historySessions.filter((s: Session) => !activeIds.has(s.id))
      const allSessions = sortSessionsByLatest([...activeSessions, ...pastSessions])

      // ★ 从 session 列表推导 agents 映射，补充重启后 IPC 事件未覆盖的历史/子 agent 数据
      // session.config.agentId 有值 → 该 session 是某个父 session 的子 agent
      const derivedAgents: Record<string, AgentInfo[]> = {}
      for (const s of allSessions) {
        const agentId = s.config?.agentId
        const parentId = s.config?.parentSessionId
        if (!agentId || !parentId) continue

        // 将 SessionStatus 映射到 AgentInfo['status']
        let agentStatus: AgentInfo['status'] = 'pending'
        if (['running', 'starting', 'waiting_input', 'idle'].includes(s.status)) {
          agentStatus = 'running'
        } else if (s.status === 'completed' || s.status === 'terminated') {
          agentStatus = 'completed'
        } else if (s.status === 'error') {
          agentStatus = 'failed'
        } else if (s.status === 'interrupted') {
          agentStatus = 'cancelled'
        }

        if (!derivedAgents[parentId]) derivedAgents[parentId] = []
        derivedAgents[parentId].push({
          agentId,
          name: s.name,
          parentSessionId: parentId,
          childSessionId: s.id,
          status: agentStatus,
          prompt: '',
          workDir: s.config?.workingDirectory || '',
          createdAt: s.startedAt || new Date().toISOString(),
          completedAt: s.endedAt,
        })
      }

      // 合并：live 数据（IPC 事件实时更新的）比 derived 状态更准确，优先保留
      set((state) => {
        const liveStatusMap: Record<string, AgentInfo['status']> = {}
        for (const list of Object.values(state.agents)) {
          for (const a of list) liveStatusMap[a.agentId] = a.status
        }
        // 用 live 状态覆盖 derived 状态
        for (const list of Object.values(derivedAgents)) {
          for (const a of list) {
            if (a.agentId in liveStatusMap) a.status = liveStatusMap[a.agentId]
          }
        }
        const nextResuming = new Set(state.resumingSessions)
        for (const sid of Array.from(nextResuming)) {
          const s = allSessions.find(x => x.id === sid)
          if (!s || s.status !== 'starting') {
            nextResuming.delete(sid)
          }
        }
        return { sessions: allSessions, agents: derivedAgents, resumingSessions: nextResuming }
      })
    } catch (error) {
      console.error('Failed to fetch sessions:', error)
    }
  },

  // 单独获取历史会话（从数据库）
  fetchHistorySessions: async () => {
    try {
      const historySessions = await window.spectrAI.session.getHistory()
      set((state) => {
        const activeIds = new Set(state.sessions.filter(
          s => s.status === 'running' || s.status === 'idle' || s.status === 'waiting_input' || s.status === 'starting'
        ).map(s => s.id))
        const pastSessions = historySessions.filter((s: Session) => !activeIds.has(s.id))
        const activeSessions = state.sessions.filter(s => activeIds.has(s.id))
        return { sessions: sortSessionsByLatest([...activeSessions, ...pastSessions]) }
      })
    } catch (error) {
      console.error('Failed to fetch history sessions:', error)
    }
  },

  // 从数据库加载指定会话的活动事件
  fetchSessionActivities: async (sessionId: string) => {
    try {
      const dbActivities = await window.spectrAI.session.getActivities(sessionId)
      if (dbActivities && dbActivities.length > 0) {
        const normalizedActivities = dbActivities.map((e: ActivityEvent) => ({
          ...e,
          detail: sanitizeDisplayText(e.detail || '')
        }))
        set((state) => {
          const existing = state.activities[sessionId] || []
          // 如果内存中已有实时事件，和数据库事件合并去重
          // 合并去重：以 ID 为键，内存中的优先
          const seenIds = new Set<string>()
          const all = [...existing, ...normalizedActivities]
          const merged: ActivityEvent[] = []
          for (const e of all) {
            if (!seenIds.has(e.id)) {
              seenIds.add(e.id)
              merged.push(e)
            }
          }
          merged.sort((a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
          )
          // ★ 标记该会话已从 DB 加载过历史，防止 session_start 竞态导致 selectSession 重复跳过
          const loaded = new Set(state.activityHistoryLoaded)
          loaded.add(sessionId)
          return {
            activities: { ...state.activities, [sessionId]: merged },
            activityHistoryLoaded: loaded,
          }
        })
      } else {
        // 无历史也标记为已加载，避免每次 selectSession 都触发无效查询
        set((state) => {
          const loaded = new Set(state.activityHistoryLoaded)
          loaded.add(sessionId)
          return { activityHistoryLoaded: loaded }
        })
      }
    } catch (error) {
      console.error('Failed to fetch session activities:', error)
    }
  },

  // 创建新会话
  createSession: async (config: SessionConfig) => {
    const dedupeKey = [
      config.workingDirectory || '',
      config.providerId || '',
      config.workspaceId || '',
      config.supervisorMode ? '1' : '0',
      (config.initialPrompt || '').trim(),
      (config.name || '').trim(),
    ].join('|')
    if (createSessionInFlightKeys.has(dedupeKey)) return
    createSessionInFlightKeys.add(dedupeKey)
    try {
      const result = await window.spectrAI.session.create(config)
      if (!result?.success) {
        throw new Error(result?.error || '创建会话失败')
      }
      await get().fetchSessions()
      // 自动跳转到新建的会话（标签页模式下立即切换焦点）
      if (result?.sessionId) {
        set({ selectedSessionId: result.sessionId })
      }
    } catch (error) {
      console.error('Failed to create session:', error)
      throw error
    } finally {
      createSessionInFlightKeys.delete(dedupeKey)
    }
  },

  // 恢复中断的会话（使用 claude --resume）
  resumeSession: async (oldSessionId: string) => {
    const inFlight = resumeSessionInFlight.get(oldSessionId)
    if (inFlight) return inFlight

    const task = (async (): Promise<ResumeSessionResult> => {
      set((state) => ({
        resumeError: null,
        resumingSessions: new Set([...state.resumingSessions, oldSessionId])
      }))
      try {
        const result = await window.spectrAI.session.resume(oldSessionId)
        if (result.success) {
          const resumedId = result.sessionId || oldSessionId

          // Fallback: if no status transition arrives within 15s, clear resuming flag and force refresh
          setTimeout(() => {
            set((state) => {
              if (!state.resumingSessions.has(resumedId)) return state
              const next = new Set(state.resumingSessions)
              next.delete(resumedId)
              return { resumingSessions: next }
            })
            get().fetchSessions()
          }, 15000)

          await get().fetchSessions()
          if (result.sessionId) {
            set({ selectedSessionId: result.sessionId })
            get().fetchSessionActivities(result.sessionId)
          }
          return { success: true, sessionId: resumedId }
        }

        const errorMsg = result.error || '恢复会话失败'
        set((state) => {
          const next = new Set(state.resumingSessions)
          next.delete(oldSessionId)
          return { resumeError: errorMsg, resumingSessions: next }
        })
        console.error('Failed to resume session:', result.error)
        return { success: false, error: errorMsg }
      } catch (error: any) {
        const errorMsg = error.message || '恢复会话时发生未知错误'
        set((state) => {
          const next = new Set(state.resumingSessions)
          next.delete(oldSessionId)
          return { resumeError: errorMsg, resumingSessions: next }
        })
        console.error('Failed to resume session:', error)
        return { success: false, error: errorMsg }
      } finally {
        resumeSessionInFlight.delete(oldSessionId)
      }
    })()

    resumeSessionInFlight.set(oldSessionId, task)
    return await task
  },

  openSessionForChat: async (sessionId: string) => {
    const findSession = (id: string) => get().sessions.find((s) => s.id === id)

    let session = findSession(sessionId)
    if (!session) {
      await get().fetchSessions()
      session = findSession(sessionId)
      if (!session) return { success: false, error: 'Session not found' }
    }

    get().selectSession(session.id)
    if (chatViewTerminalStatuses.has(session.status)) {
      console.log(`[SessionStore] Opened terminal session without auto-resume: ${session.id} (${session.status})`)
    }
    return { success: true, sessionId: session.id }
  },

  clearResumeError: () => {
    set({ resumeError: null })
  },

  // 终止会话
  terminateSession: async (id: string) => {
    try {
      await window.spectrAI.session.terminate(id)
      await get().fetchSessions()
    } catch (error) {
      console.error('Failed to terminate session:', error)
      throw error
    }
  },

  // 删除会话（从数据库永久删除）
  deleteSession: async (id: string) => {
    try {
      const result = await window.spectrAI.session.delete(id)
      if (!result.success) throw new Error(result.error || '删除失败')
      // 若当前选中的是被删除会话，清除选中状态
      if (get().selectedSessionId === id) {
        set({ selectedSessionId: null })
      }
      // 从本地 state 中移除
      set((state) => ({
        sessions: state.sessions.filter((s) => s.id !== id),
        activities: Object.fromEntries(
          Object.entries(state.activities).filter(([k]) => k !== id)
        ),
        lastActivities: Object.fromEntries(
          Object.entries(state.lastActivities).filter(([k]) => k !== id)
        ),
      }))
    } catch (error) {
      console.error('Failed to delete session:', error)
      throw error
    }
  },

  // 发送输入
  sendInput: async (id: string, data: string) => {
    try {
      await window.spectrAI.session.sendInput(id, data)
    } catch (error) {
      console.error('Failed to send input:', error)
      throw error
    }
  },

  // 发送确认
  sendConfirmation: async (id: string, accept: boolean) => {
    try {
      await window.spectrAI.session.confirm(id, accept)
    } catch (error) {
      console.error('Failed to send confirmation:', error)
      throw error
    }
  },

  // 调整会话终端大小
  resizeSession: async (id: string, cols: number, rows: number) => {
    try {
      await window.spectrAI.session.resize(id, cols, rows)
    } catch (error) {
      console.error('Failed to resize session:', error)
    }
  },

  // 选择会话（同时从数据库加载该会话的历史事件）
  selectSession: (id: string | null) => {
    set({ selectedSessionId: id })

    if (id) {
      // ★ 用专用 Set 判断是否已从 DB 加载过，而非用 activities.length
      // 旧逻辑 length===0 存在竞态：session_start 事件先于 selectSession 到达时
      // activities[id] 已有 1 条，导致 DB 历史被永久跳过（app 重启后尤为明显）
      if (!get().activityHistoryLoaded.has(id)) {
        get().fetchSessionActivities(id)
      }
    }
  },

  // 更新会话状态（id 为 SessionManager 的 UUID）
  updateSessionStatus: (id: string, status: SessionStatus) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, status } : session
      )
    }))
  },

  // 添加活动事件
  addActivity: (sessionId: string, activity: ActivityEvent) => {
    const normalized: ActivityEvent = {
      ...activity,
      detail: sanitizeDisplayText(activity.detail || '')
    }
    set((state) => {
      const existing = state.activities[sessionId] || []
      // 去重：如果已有相同 ID 的事件则跳过
      if (existing.some(e => e.id === normalized.id)) {
        return { lastActivities: { ...state.lastActivities, [sessionId]: normalized } }
      }
      // 最多保留 200 条
      const updated = [...existing, normalized].slice(-200)
      return {
        activities: { ...state.activities, [sessionId]: updated },
        lastActivities: { ...state.lastActivities, [sessionId]: normalized }
      }
    })
  },

  // 获取指定会话的活动事件
  getActivities: (sessionId: string) => {
    return get().activities[sessionId] || []
  },

  // 获取指定会话的最新活动
  getLastActivity: (sessionId: string) => {
    return get().lastActivities[sessionId]
  },

  // 更新会话名称
  updateSessionName: (id: string, name: string) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, name } : session
      )
    }))
  },

  renameSession: async (id: string, newName: string) => {
    try {
      const result = await window.spectrAI.session.rename(id, newName)
      if (result.success) {
        get().updateSessionName(id, newName.trim())
        return true
      }
      console.error('Failed to rename session:', result.error)
      return false
    } catch (error) {
      console.error('Failed to rename session:', error)
      return false
    }
  },

  aiRenameSession: async (id: string) => {
    try {
      const result = await window.spectrAI.session.aiRename(id)
      if (result.success) {
        get().updateSessionName(id, result.name!)
        return { success: true, name: result.name }
      }
      return { success: false, error: result.error }
    } catch (error: any) {
      console.error('Failed to AI rename session:', error)
      return { success: false, error: error.message }
    }
  },

  // 启动时自动恢复可精确定位的中断会话（仅 claudeSessionId 可用）
  autoResumeInterrupted: async () => {
    const allInterrupted = get().sessions.filter(s => s.status === 'interrupted')
    if (allInterrupted.length === 0) return

    const withClaudeId = allInterrupted.filter(s => !!s.claudeSessionId)
    const skippedNoId = allInterrupted.length - withClaudeId.length

    const uniqueByClaudeId = new Map<string, typeof withClaudeId[0]>()
    for (const session of withClaudeId) {
      const key = session.claudeSessionId!
      const existing = uniqueByClaudeId.get(key)
      if (!existing || (session.startedAt && (!existing.startedAt || session.startedAt > existing.startedAt))) {
        uniqueByClaudeId.set(key, session)
      }
    }

    const toResume = Array.from(uniqueByClaudeId.values())
    const dupeSkipped = withClaudeId.length - toResume.length

    console.log(`[AutoResume] ${allInterrupted.length} interrupted -> ${toResume.length} recoverable by Claude ID (${dupeSkipped} dupes skipped), ${skippedNoId} skipped without Claude ID`)

    set((state) => {
      const next = new Set(state.resumingSessions)
      for (const s of toResume) next.add(s.id)
      return { resumingSessions: next }
    })

    for (const session of toResume) {
      try {
        const result = await window.spectrAI.session.resume(session.id)
        if (result.success) {
          const resumedId = result.sessionId || session.id
          setTimeout(() => {
            set((state) => {
              if (!state.resumingSessions.has(resumedId)) return state
              const next = new Set(state.resumingSessions)
              next.delete(resumedId)
              return { resumingSessions: next }
            })
            get().fetchSessions()
          }, 15000)
          console.log(`[AutoResume] Resumed ${session.name} -> ${result.sessionId}`)
        } else {
          set((state) => {
            const next = new Set(state.resumingSessions)
            next.delete(session.id)
            return { resumingSessions: next }
          })
          console.warn(`[AutoResume] Failed: ${session.name}: ${result.error}`)
        }
      } catch (error) {
        set((state) => {
          const next = new Set(state.resumingSessions)
          next.delete(session.id)
          return { resumingSessions: next }
        })
        console.error(`[AutoResume] Error: ${session.name}:`, error)
      }
    }

    await get().fetchSessions()
  },

  // 初始化事件监听器
  initListeners: () => {
    // 先清理旧监听器，防止重复注册
    _sessionListenerUnsubs.forEach(fn => fn())
    _sessionListenerUnsubs = []

    // 监听状态变化
    _sessionListenerUnsubs.push(window.spectrAI.session.onStatusChange((sessionId: string, status: string) => {
      get().updateSessionStatus(sessionId, status as SessionStatus)
      if (status !== 'starting' && get().resumingSessions.has(sessionId)) {
        set((state) => {
          const next = new Set(state.resumingSessions)
          next.delete(sessionId)
          return { resumingSessions: next }
        })
      }
      // 恢复运行或会话结束时清除卡住标记
      if ((status === 'running' || status === 'completed' || status === 'terminated') && get().stuckSessions[sessionId]) {
        set((state) => {
          const next = { ...state.stuckSessions }
          delete next[sessionId]
          return { stuckSessions: next }
        })
      }
      // ★ SDK V2: 根据状态更新 streamingSessions（只有 running 才算流式）
      if (status === 'running') {
        set((state) => ({
          streamingSessions: new Set([...state.streamingSessions, sessionId])
        }))
      } else {
        set((state) => {
          const next = new Set(state.streamingSessions)
          if (next.has(sessionId)) {
            next.delete(sessionId)
            return { streamingSessions: next }
          }
          return state
        })
      }
    }))

    // 监听活动事件
    _sessionListenerUnsubs.push(window.spectrAI.session.onActivity((sessionId: string, activity: ActivityEvent) => {
      get().addActivity(sessionId, activity)
    }))

    // 监听干预请求（卡住/启动超时/恢复）
    _sessionListenerUnsubs.push(window.spectrAI.session.onIntervention((sessionId: string, intervention: any) => {
      const type = intervention?.type
      if (type === 'startup-stuck' || type === 'possible-stuck' || type === 'stuck') {
        set((state) => ({
          stuckSessions: { ...state.stuckSessions, [sessionId]: type }
        }))
      } else if (type === 'recovered') {
        set((state) => {
          const next = { ...state.stuckSessions }
          delete next[sessionId]
          return { stuckSessions: next }
        })
      }
    }))

    // 监听会话名称变更（终端标题变化）
    _sessionListenerUnsubs.push(window.spectrAI.session.onNameChange((sessionId: string, name: string) => {
      get().updateSessionName(sessionId, name)
    }))

    // 监听外部变更（远程创建/终止会话）
    _sessionListenerUnsubs.push(window.spectrAI.session.onRefresh(() => {
      get().fetchSessions()
    }))

    // ★ SDK V2: 实时 token 用量推送（每轮对话结束后触发）
    const tokenUnsub = window.spectrAI.session.onTokenUpdate?.((sessionId: string, usage: { inputTokens: number; outputTokens: number; total: number }) => {
      set((state) => ({
        sessions: state.sessions.map(s =>
          s.id === sessionId ? { ...s, estimatedTokens: usage.total } : s
        )
      }))
    })
    if (tokenUnsub) _sessionListenerUnsubs.push(tokenUnsub)
  },

  // 初始化 Agent 事件监听
  initAgentListeners: () => {
    // 先清理旧监听器，防止重复注册
    _agentListenerUnsubs.forEach(fn => fn())
    _agentListenerUnsubs = []

    _agentListenerUnsubs.push(window.spectrAI.agent.onCreated((agentInfo: AgentInfo) => {
      set((state) => {
        const parentId = agentInfo.parentSessionId
        const existing = state.agents[parentId] || []
        return {
          agents: { ...state.agents, [parentId]: [...existing, agentInfo] }
        }
      })
      // ★ 刷新会话列表，让 Agent 子会话显示在 Sidebar
      get().fetchSessions()
    }))

    _agentListenerUnsubs.push(window.spectrAI.agent.onStatusChange((agentId: string, status: string) => {
      set((state) => {
        const newAgents = { ...state.agents }
        for (const parentId of Object.keys(newAgents)) {
          newAgents[parentId] = newAgents[parentId].map(a =>
            a.agentId === agentId ? { ...a, status: status as AgentInfo['status'] } : a
          )
        }
        return { agents: newAgents }
      })
    }))

    _agentListenerUnsubs.push(window.spectrAI.agent.onCompleted((agentId: string, _result: any) => {
      set((state) => {
        const newAgents = { ...state.agents }
        for (const parentId of Object.keys(newAgents)) {
          newAgents[parentId] = newAgents[parentId].map(a =>
            a.agentId === agentId
              ? { ...a, status: 'completed' as const, completedAt: new Date().toISOString() }
              : a
          )
        }
        return { agents: newAgents }
      })
    }))
  },

  // SDK V2: 初始化对话事件监听
  initConversationListeners: () => {
    // 先清理旧监听器，防止重复注册
    _conversationListenerUnsubs.forEach(fn => fn())
    _conversationListenerUnsubs = []

    _conversationListenerUnsubs.push(window.spectrAI.session.onConversationMessage(
      (sessionId: string, msg: ConversationMessage) => {
        // Skill 静默执行时，SDK 会回显用户发送的模板文本，此处将其拦截
        // 合成的 "▶ /skillname" 消息已由 sendSkillMessage 提前加入对话，无需 SDK 回显
        if (msg.role === 'user' && get().suppressNextEcho.has(sessionId)) {
          set(state => {
            const next = new Set(state.suppressNextEcho)
            next.delete(sessionId)
            return { suppressNextEcho: next }
          })
          return
        }
        get().addConversationMessage(sessionId, msg)
      }
    ))

    // 监听会话初始化数据（tools/skills/mcp）
    _conversationListenerUnsubs.push(window.spectrAI.session.onInitData(
      (sessionId: string, data: any) => {
        get().setSessionInitData(sessionId, data)
      }
    ))
  },

  // 清理所有 IPC 监听器（防泄漏，可在组件卸载 / HMR 时调用）
  cleanupListeners: () => {
    _sessionListenerUnsubs.forEach(fn => fn())
    _sessionListenerUnsubs = []
    _agentListenerUnsubs.forEach(fn => fn())
    _agentListenerUnsubs = []
    _conversationListenerUnsubs.forEach(fn => fn())
    _conversationListenerUnsubs = []
  },

  // SDK V2: 发送结构化消息
  sendMessage: async (sessionId: string, text: string) => {
    try {
      await window.spectrAI.session.sendMessage(sessionId, text)
    } catch (error) {
      console.error('Failed to send message:', error)
      throw error
    }
  },

  // SDK V2: 静默执行 Skill —— 展开 promptTemplate 并发送，同时在对话中显示干净的 "▶ /skillname" 徽章
  sendSkillMessage: async (sessionId: string, skillName: string, expandedTemplate: string) => {
    // ① 提前插入合成的用户消息（显示命令名，而非模板原文）
    get().addConversationMessage(sessionId, {
      id: `skill-exec-${Date.now()}-${sessionId}`,
      sessionId,
      role: 'user',
      content: `\u25B6 /${skillName}`,  // ▶ /skillname
      timestamp: new Date().toISOString(),
    } as ConversationMessage)

    // ② 标记需要屏蔽下一条 SDK 回显的用户消息（即展开后的模板文本）
    set(state => ({ suppressNextEcho: new Set([...state.suppressNextEcho, sessionId]) }))

    // ③ 发送展开后的模板
    try {
      await window.spectrAI.session.sendMessage(sessionId, expandedTemplate)
    } catch (error) {
      // 发送失败时撤销标记，避免屏蔽后续正常消息
      set(state => {
        const next = new Set(state.suppressNextEcho)
        next.delete(sessionId)
        return { suppressNextEcho: next }
      })
      console.error('sendSkillMessage failed:', error)
      throw error
    }
  },

  // SDK V2: 添加对话消息（支持 text_delta 增量追加）
  addConversationMessage: (sessionId: string, msg: ConversationMessage) => {
    set((state) => {
      const existing = state.conversations[sessionId] || []
      const draftId = `delta-${sessionId}`

      if (msg.isDelta) {
        // 增量消息：找到临时草稿消息，追加 content
        const draftIdx = existing.findIndex(m => m.id === draftId)
        if (draftIdx >= 0) {
          const updated = [...existing]
          updated[draftIdx] = {
            ...updated[draftIdx],
            content: updated[draftIdx].content + msg.content,
            timestamp: msg.timestamp,
          }
          return { conversations: { ...state.conversations, [sessionId]: updated } }
        }
        // 首次 delta，创建草稿
        return {
          conversations: {
            ...state.conversations,
            [sessionId]: [...existing, { ...msg, id: draftId }]
          }
        }
      }

      // 完整消息：先移除同 session 的草稿（delta-xxx），再追加
      const withoutDraft = existing.filter(m => m.id !== draftId)
      // 去重
      if (withoutDraft.some(m => m.id === msg.id)) return state
      return {
        conversations: {
          ...state.conversations,
          [sessionId]: [...withoutDraft, msg]
        }
      }
    })
  },

  // SDK V2: 批量添加对话消息（用于历史加载，避免逐条 set 触发重渲染）
  bulkAddConversationMessages: (sessionId: string, msgs: ConversationMessage[]) => {
    if (!msgs || msgs.length === 0) return
    set((state) => {
      const existing = state.conversations[sessionId] || []
      const existingIds = new Set(existing.map(m => m.id))
      const newMsgs = msgs.filter(m => !existingIds.has(m.id))
      if (newMsgs.length === 0) return state
      return {
        conversations: {
          ...state.conversations,
          [sessionId]: [...existing, ...newMsgs]
        }
      }
    })
  },

  // SDK V2: 设置对话历史加载状态
  setConversationLoading: (sessionId: string, loading: boolean) => {
    set((state) => ({
      conversationLoading: { ...state.conversationLoading, [sessionId]: loading }
    }))
  },

  // SDK V2: 存储会话初始化数据（tools/skills/mcp）
  setSessionInitData: (sessionId: string, data: any) => {
    set((state) => ({
      sessionInitData: {
        ...state.sessionInitData,
        [sessionId]: {
          model: data.model || '',
          tools: data.tools || [],
          skills: data.skills || [],
          mcpServers: data.mcpServers || [],
        }
      }
    }))
  },

  // 加载指定父会话的 Agent 列表
  fetchAgents: async (parentSessionId: string) => {
    try {
      const agents = await window.spectrAI.agent.list(parentSessionId)
      set((state) => ({
        agents: { ...state.agents, [parentSessionId]: agents }
      }))
    } catch (error) {
      console.error('Failed to fetch agents:', error)
    }
  }
}))

export default useSessionStore
