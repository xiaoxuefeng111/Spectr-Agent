/**
 * UI 状态管理 Store
 * @author weibin
 */

import { create } from 'zustand'
import type { ViewMode, LayoutMode, PaneContent } from '../../shared/types'
import { THEMES, THEME_IDS, DEFAULT_THEME_ID } from '../../shared/constants'

/** 统一面板 ID（左侧边栏和右侧面板均使用此类型） */
export type PanelId = 'sessions' | 'explorer' | 'git' | 'dashboard' | 'timeline' | 'stats' | 'mcp' | 'skills'

/** 面板所在侧 */
export type PanelSide = 'left' | 'right'

/** 向后兼容的类型别名 */
export type ActivityType = PanelId
export type RightPanelView = PanelId

/** 所有面板 ID（用于校验） */
const ALL_PANEL_IDS: PanelId[] = ['sessions', 'explorer', 'git', 'dashboard', 'timeline', 'stats', 'mcp', 'skills']

/** 默认面板分配（left = 左侧边栏，right = 右侧面板） */
const DEFAULT_PANEL_SIDES: Record<PanelId, PanelSide> = {
  sessions:  'left',
  explorer:  'left',
  git:       'left',
  dashboard: 'left',
  timeline:  'right',
  stats:     'right',
  mcp:       'left',
  skills:    'left',
}

/** 从 localStorage 读取面板分配 */
function getInitialPanelSides(): Record<PanelId, PanelSide> {
  try {
    const stored = localStorage.getItem('claudeops-panel-sides')
    if (stored) {
      const parsed = JSON.parse(stored)
      const result = { ...DEFAULT_PANEL_SIDES }
      for (const id of ALL_PANEL_IDS) {
        if (parsed[id] === 'left' || parsed[id] === 'right') {
          result[id] = parsed[id]
        }
      }
      return result
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_PANEL_SIDES }
}

/** 保存面板分配到 localStorage */
function savePanelSides(sides: Record<PanelId, PanelSide>): void {
  try {
    localStorage.setItem('claudeops-panel-sides', JSON.stringify(sides))
  } catch {
    // ignore
  }
}

/** 从 localStorage 读取左侧活动面板偏好 */
function getInitialActivePanelLeft(panelSides: Record<PanelId, PanelSide>): PanelId {
  try {
    const stored = localStorage.getItem('claudeops-active-activity')
    if (stored && ALL_PANEL_IDS.includes(stored as PanelId)) {
      const id = stored as PanelId
      if (panelSides[id] === 'left') return id
    }
  } catch {
    // ignore
  }
  return ALL_PANEL_IDS.find(id => panelSides[id] === 'left') ?? 'sessions'
}

/** 从 localStorage 读取主题偏好 */
function getInitialTheme(): string {
  try {
    const stored = localStorage.getItem('claudeops-theme')
    if (stored && THEMES[stored]) return stored
  } catch {
    // ignore
  }
  return DEFAULT_THEME_ID
}

/** 从 localStorage 读取布局状态 */
function getInitialLayout(): { viewMode: ViewMode; detailPanelCollapsed: boolean; sidebarCollapsed: boolean } {
  const VALID_MODES: ViewMode[] = ['grid', 'tabs', 'dashboard', 'kanban']
  let viewMode: ViewMode = 'grid'
  let detailPanelCollapsed = false
  let sidebarCollapsed = false
  try {
    const storedMode = localStorage.getItem('claudeops-layout-view-mode')
    if (storedMode && VALID_MODES.includes(storedMode as ViewMode)) {
      viewMode = storedMode as ViewMode
    }
    detailPanelCollapsed = localStorage.getItem('claudeops-layout-detail-collapsed') === 'true'
    sidebarCollapsed = localStorage.getItem('claudeops-layout-sidebar-collapsed') === 'true'
  } catch {
    // ignore
  }
  return { viewMode, detailPanelCollapsed, sidebarCollapsed }
}

/** 保存布局状态到 localStorage */
function saveLayout(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // ignore
  }
}

/** 应用主题到 HTML 根元素（切换 .theme-xxx class） */
function applyTheme(themeId: string): void {
  const html = document.documentElement
  html.classList.forEach((cls) => {
    if (cls.startsWith('theme-')) html.classList.remove(cls)
  })
  html.classList.add(`theme-${themeId}`)
  try {
    localStorage.setItem('claudeops-theme', themeId)
  } catch {
    // ignore
  }
  window.spectrAI?.theme?.updateTitleBar(themeId)
}

interface UIState {
  // 状态
  theme: string
  viewMode: ViewMode
  /** 各会话的草稿输入文本（key = sessionId），用于视图切换时保留未发送内容 */
  draftInputs: Record<string, string>
  /** 临时标签页会话 ID（用于在标签页视图中查看已完成会话），同时只能有一个 */
  temporaryTabId: string | null
  sidebarWidth: number
  detailPanelWidth: number
  selectedTaskId: string | null
  showNewTaskDialog: boolean
  showNewSessionDialog: boolean
  sidebarCollapsed: boolean
  detailPanelCollapsed: boolean
  showSearchPanel: boolean
  showHistoryPanel: boolean
  showLogViewer: boolean
  /** 面板位置分配（left = 左侧边栏，right = 右侧面板） */
  panelSides: Record<PanelId, PanelSide>
  /** 当前左侧边栏激活的面板 */
  activePanelLeft: PanelId
  /** 当前右侧面板激活的面板 */
  activePanelRight: PanelId

  /** 中间区域布局模式 */
  layoutMode: LayoutMode
  /** 主窗格内容（single 模式下唯一；split 模式下左/上） */
  primaryPane: PaneContent
  /** 副窗格内容（split 模式下右/下） */
  secondaryPane: PaneContent

  /** 设置/清除某个会话的草稿输入文本 */
  setDraftInput: (sessionId: string, text: string) => void

  // 方法
  setTheme: (themeId: string) => void
  nextTheme: () => void
  setViewMode: (mode: ViewMode) => void
  setTemporaryTab: (id: string | null) => void
  setSidebarWidth: (width: number) => void
  setDetailPanelWidth: (width: number) => void
  setSelectedTaskId: (id: string | null) => void
  toggleNewTaskDialog: () => void
  setShowNewSessionDialog: (show: boolean) => void
  toggleSidebar: () => void
  toggleDetailPanel: () => void
  toggleSearchPanel: () => void
  toggleHistoryPanel: () => void
  toggleLogViewer: () => void
  /** 将面板移到指定侧（自动激活 + 自动展开目标侧） */
  setPanelSide: (panelId: PanelId, side: PanelSide) => void
  /** 激活左侧边栏某面板 */
  setActivePanelLeft: (panelId: PanelId) => void
  /** 激活右侧面板某面板 */
  setActivePanelRight: (panelId: PanelId) => void
  /** 切换中间区域布局模式 */
  setLayoutMode: (mode: LayoutMode) => void
  /** 设置窗格内容 */
  setPaneContent: (pane: 'primary' | 'secondary', content: PaneContent) => void
  /** 交换两个窗格的内容 */
  swapPanes: () => void
}

const initialPanelSides = getInitialPanelSides()
const initialLayout = getInitialLayout()

export const useUIStore = create<UIState>((set) => ({
  // 初始状态
  theme: getInitialTheme(),
  viewMode: initialLayout.viewMode,
  draftInputs: {},
  temporaryTabId: null,
  sidebarWidth: 280,
  detailPanelWidth: 300,
  selectedTaskId: null,
  showNewTaskDialog: false,
  showNewSessionDialog: false,
  sidebarCollapsed: initialLayout.sidebarCollapsed,
  detailPanelCollapsed: initialLayout.detailPanelCollapsed,
  showSearchPanel: false,
  showHistoryPanel: false,
  showLogViewer: false,
  panelSides: initialPanelSides,
  activePanelLeft: getInitialActivePanelLeft(initialPanelSides),
  activePanelRight: ALL_PANEL_IDS.find(id => initialPanelSides[id] === 'right') ?? 'timeline',
  layoutMode: (localStorage.getItem('claudeops-layout-mode') as LayoutMode) || 'single',
  primaryPane: (localStorage.getItem('claudeops-pane-primary') as PaneContent) || 'sessions',
  secondaryPane: (localStorage.getItem('claudeops-pane-secondary') as PaneContent) || 'files',

  // 设置主题
  setTheme: (themeId: string) => {
    if (!THEMES[themeId]) return
    applyTheme(themeId)
    set({ theme: themeId })
  },

  // 循环切换到下一个主题
  nextTheme: () => {
    set((state) => {
      const currentIdx = THEME_IDS.indexOf(state.theme)
      const nextIdx = (currentIdx + 1) % THEME_IDS.length
      const nextId = THEME_IDS[nextIdx]
      applyTheme(nextId)
      return { theme: nextId }
    })
  },

  setDraftInput: (sessionId: string, text: string) => {
    set((state) => ({
      draftInputs: { ...state.draftInputs, [sessionId]: text },
    }))
  },

  setViewMode: (mode: ViewMode) => {
    saveLayout('claudeops-layout-view-mode', mode)
    set({ viewMode: mode })
  },

  setTemporaryTab: (id: string | null) => {
    set({ temporaryTabId: id })
  },

  setSidebarWidth: (width: number) => {
    set({ sidebarWidth: width })
  },

  setDetailPanelWidth: (width: number) => {
    set({ detailPanelWidth: width })
  },

  setSelectedTaskId: (id: string | null) => {
    set({ selectedTaskId: id })
  },

  toggleNewTaskDialog: () => {
    set((state) => ({ showNewTaskDialog: !state.showNewTaskDialog }))
  },

  setShowNewSessionDialog: (show: boolean) => {
    set({ showNewSessionDialog: show })
  },

  toggleSidebar: () => {
    set((state) => {
      const next = !state.sidebarCollapsed
      saveLayout('claudeops-layout-sidebar-collapsed', String(next))
      return { sidebarCollapsed: next }
    })
  },

  toggleDetailPanel: () => {
    set((state) => {
      const next = !state.detailPanelCollapsed
      saveLayout('claudeops-layout-detail-collapsed', String(next))
      return { detailPanelCollapsed: next }
    })
  },

  toggleSearchPanel: () => {
    set((state) => ({ showSearchPanel: !state.showSearchPanel }))
  },

  toggleHistoryPanel: () => {
    set((state) => ({ showHistoryPanel: !state.showHistoryPanel }))
  },

  toggleLogViewer: () => {
    set((state) => ({ showLogViewer: !state.showLogViewer }))
  },

  /**
   * 将面板移动到指定侧
   * - 若原侧的 active panel 是它，则从原侧剩余面板中自动选第一个
   * - 移动后自动激活到目标侧，并展开目标侧
   */
  setPanelSide: (panelId: PanelId, newSide: PanelSide) => {
    set((state) => {
      if (state.panelSides[panelId] === newSide) return state

      const newSides = { ...state.panelSides, [panelId]: newSide }
      savePanelSides(newSides)

      let { activePanelLeft, activePanelRight } = state

      // 若该面板是旧侧的 active panel，从旧侧剩余面板中选第一个
      if (newSide === 'right' && activePanelLeft === panelId) {
        activePanelLeft = ALL_PANEL_IDS.find(id => id !== panelId && newSides[id] === 'left') ?? 'sessions'
      }
      if (newSide === 'left' && activePanelRight === panelId) {
        activePanelRight = ALL_PANEL_IDS.find(id => id !== panelId && newSides[id] === 'right') ?? 'timeline'
      }

      // 移动后自动激活到目标侧
      if (newSide === 'left') {
        activePanelLeft = panelId
        try { localStorage.setItem('claudeops-active-activity', panelId) } catch { /* ignore */ }
      } else {
        activePanelRight = panelId
      }

      return {
        panelSides: newSides,
        activePanelLeft,
        activePanelRight,
        // 自动展开目标侧
        ...(newSide === 'right' ? { detailPanelCollapsed: false } : { sidebarCollapsed: false }),
      }
    })
  },

  setActivePanelLeft: (panelId: PanelId) => {
    try { localStorage.setItem('claudeops-active-activity', panelId) } catch { /* ignore */ }
    set({ activePanelLeft: panelId })
  },

  setActivePanelRight: (panelId: PanelId) => {
    set({ activePanelRight: panelId })
  },

  setLayoutMode: (mode: LayoutMode) => {
    saveLayout('claudeops-layout-mode', mode)
    set({ layoutMode: mode })
  },

  setPaneContent: (pane: 'primary' | 'secondary', content: PaneContent) => {
    saveLayout(`claudeops-pane-${pane}`, content)
    set(pane === 'primary' ? { primaryPane: content } : { secondaryPane: content })
  },

  swapPanes: () => {
    set((state) => {
      saveLayout('claudeops-pane-primary', state.secondaryPane)
      saveLayout('claudeops-pane-secondary', state.primaryPane)
      return { primaryPane: state.secondaryPane, secondaryPane: state.primaryPane }
    })
  },
}))

// 初始化时应用主题
applyTheme(useUIStore.getState().theme)

export default useUIStore
