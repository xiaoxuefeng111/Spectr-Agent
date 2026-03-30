/**
 * SpectrAI 根组件
 * @author weibin
 */

import { useEffect, useRef } from 'react'
import AppLayout from './components/layout/AppLayout'
import { useSessionStore } from './stores/sessionStore'
import { useTaskStore } from './stores/taskStore'
import { useSkillStore } from './stores/skillStore'
import { useUIStore } from './stores/uiStore'
import { useSettingsStore } from './stores/settingsStore'
import type { ViewMode } from '../shared/types'
import { isPrimaryModifierPressed } from './utils/shortcut'
import './styles/globals.css'

export default function App() {
  const { fetchSessions, initListeners } = useSessionStore()
  const { fetchTasks } = useTaskStore()
  const { fetchSettings } = useSettingsStore()

  const initialized = useRef(false)

  useEffect(() => {
    // React Strict Mode 会在 dev 模式下执行两次 useEffect，用 ref 防止重复初始化
    if (initialized.current) return
    initialized.current = true

    // 初始化监听器
    initListeners()
    useSessionStore.getState().initAgentListeners()
    useSessionStore.getState().initConversationListeners()  // SDK V2 对话事件
    useTaskStore.getState().initTaskListeners()

    // 初始化数据（会话 + 设置）
    Promise.all([fetchSessions(), fetchSettings()]).then(async () => {
      const sessionState = useSessionStore.getState()
      const interruptedCount = sessionState.sessions.filter(
        s => s.status === 'interrupted' && !!s.claudeSessionId
      ).length

      if (interruptedCount === 0) return

      // 有中断会话时自动恢复，无需用户确认
      await sessionState.autoResumeInterrupted()
    })
    fetchTasks()

    // 注册监听器（含快捷键）
    const cleanups: (() => void)[] = []

    // MCP install_skill 通知监听：AI 通过 MCP 安装技能后自动刷新列表
    cleanups.push(useSkillStore.getState().initMcpInstallListener())

    // Ctrl+1/2/3/4: 切换视图模式
    cleanups.push(window.spectrAI.shortcut.onViewMode((mode: string) => {
      const validModes: ViewMode[] = ['grid', 'tabs', 'dashboard', 'kanban']
      if (validModes.includes(mode as ViewMode)) {
        useUIStore.getState().setViewMode(mode as ViewMode)
      }
    }))

    // Ctrl+Tab: 循环切换选中会话
    cleanups.push(window.spectrAI.shortcut.onCycleTerminal(() => {
      const { sessions, selectedSessionId, selectSession } = useSessionStore.getState()
      const activeSessions = sessions.filter(
        s => s.status === 'running' || s.status === 'idle' || s.status === 'waiting_input'
      )
      if (activeSessions.length === 0) return

      const currentIdx = activeSessions.findIndex(s => s.id === selectedSessionId)
      const nextIdx = (currentIdx + 1) % activeSessions.length
      selectSession(activeSessions[nextIdx].id)
    }))

    // Ctrl+N: 新建会话
    cleanups.push(window.spectrAI.shortcut.onNewSession(() => {
      useUIStore.getState().setShowNewSessionDialog(true)
    }))

    // Ctrl+Shift+N: 新建任务
    cleanups.push(window.spectrAI.shortcut.onNewTaskSession(() => {
      useUIStore.getState().toggleNewTaskDialog()
    }))

    // Ctrl+B: 切换侧边栏
    cleanups.push(window.spectrAI.shortcut.onToggleSidebar(() => {
      useUIStore.getState().toggleSidebar()
    }))

    // Ctrl+F: 全文搜索
    cleanups.push(window.spectrAI.shortcut.onSearch(() => {
      useUIStore.getState().toggleSearchPanel()
    }))

    // Ctrl/Cmd+Shift+T: 切换主题
    const handleThemeShortcut = (e: KeyboardEvent) => {
      if (isPrimaryModifierPressed(e) && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        useUIStore.getState().nextTheme()
      }
    }
    window.addEventListener('keydown', handleThemeShortcut)
    cleanups.push(() => window.removeEventListener('keydown', handleThemeShortcut))

    return () => cleanups.forEach(fn => fn())
  }, [])

  return <AppLayout />
}
