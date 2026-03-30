/**
 * 标签页视图 - Tab 切换模式显示终端会话
 * 支持活跃会话标签 + 已完成会话临时标签页（同时只能有一个）
 * 支持右键菜单：复制名称/ID、关闭其他会话、终止会话等操作
 * @author weibin
 */

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Plus, X, AlertCircle, ChevronLeft, ChevronRight, Clock, Copy, Hash } from 'lucide-react'
import { useSessionStore } from '../../stores/sessionStore'
import { useUIStore } from '../../stores/uiStore'
import { STATUS_COLORS } from '../../../shared/constants'
import type { SessionStatus } from '../../../shared/types'
import TerminalPanel from './TerminalPanel'
import ConfirmDialog from '../common/ConfirmDialog'
import ContextMenu, { MenuItem } from '../common/ContextMenu'


const STATUS_LABELS: Record<SessionStatus, string> = {
  starting: '启动中',
  running: '运行中',
  idle: '空闲',
  waiting_input: '等待输入',
  paused: '已暂停',
  completed: '已完成',
  error: '出错',
  terminated: '已终止',
  interrupted: '已中断'
}

// 右键菜单状态类型
interface CtxMenuState {
  visible: boolean
  x: number
  y: number
  /** 右键目标会话 ID */
  sessionId: string
  /** 是否是临时标签页 */
  isTemporary: boolean
}

const TerminalTabs: React.FC = () => {
  const { sessions, selectedSessionId, selectSession, terminateSession, openSessionForChat } = useSessionStore()
  const { temporaryTabId, setTemporaryTab } = useUIStore()
  const [closingSessionId, setClosingSessionId] = useState<string | null>(null)

  // 批量关闭其他会话确认框状态
  const [closingOtherSessionIds, setClosingOtherSessionIds] = useState<string[]>([])

  // 右键菜单状态
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState>({
    visible: false,
    x: 0,
    y: 0,
    sessionId: '',
    isTemporary: false,
  })

  // 标签滚动状态
  const tabsContainerRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const [isTabsOverflowing, setIsTabsOverflowing] = useState(false)

  // 过滤出活跃会话（不含已完成/已终止）
  const activeSessions = sessions.filter(
    (session) =>
      session.status !== 'completed' &&
      session.status !== 'terminated'
  )

  // 临时标签页会话（已完成/已终止）
  const temporarySession = temporaryTabId
    ? sessions.find((s) => s.id === temporaryTabId) ?? null
    : null

  // 完整展示列表：活跃会话 + 临时标签页（若存在且不重复）
  const displaySessions = [
    ...activeSessions,
    ...(temporarySession && !activeSessions.find((s) => s.id === temporarySession.id)
      ? [temporarySession]
      : [])
  ]

  // 当前选中的 tab
  const currentTabId =
    displaySessions.find((s) => s.id === selectedSessionId)?.id ||
    displaySessions[0]?.id ||
    null

  // 检查标签容器滚动状态
  const checkScrollState = useCallback(() => {
    const el = tabsContainerRef.current
    if (!el) return
    const isOverflowing = el.scrollWidth > el.clientWidth + 2
    setIsTabsOverflowing(isOverflowing)
    setCanScrollLeft(isOverflowing && el.scrollLeft > 2)
    setCanScrollRight(isOverflowing && el.scrollLeft < el.scrollWidth - el.clientWidth - 2)
  }, [])

  // 监听标签容器 resize 和 scroll
  useEffect(() => {
    const el = tabsContainerRef.current
    if (!el) return

    checkScrollState()
    el.addEventListener('scroll', checkScrollState, { passive: true })

    const handleWheel = (event: WheelEvent) => {
      const mostlyVertical = Math.abs(event.deltaY) > Math.abs(event.deltaX)
      if (!mostlyVertical) return
      if (el.scrollWidth <= el.clientWidth + 2) return

      event.preventDefault()
      el.scrollBy({ left: event.deltaY })
    }

    el.addEventListener('wheel', handleWheel, { passive: false })

    const resizeObs = new ResizeObserver(checkScrollState)
    resizeObs.observe(el)

    return () => {
      el.removeEventListener('scroll', checkScrollState)
      el.removeEventListener('wheel', handleWheel)
      resizeObs.disconnect()
    }
  }, [displaySessions.length, checkScrollState])

  // Bug2修复：监听临时会话状态，若恢复为活跃状态则自动关闭临时标签页
  useEffect(() => {
    if (!temporaryTabId || !temporarySession) return
    const isNowActive =
      temporarySession.status !== 'completed' && temporarySession.status !== 'terminated'
    if (isNowActive) {
      setTemporaryTab(null)
    }
  }, [temporarySession?.status, temporaryTabId, temporarySession, setTemporaryTab])

  // 滚动左边
  const handleScrollLeft = () => {
    tabsContainerRef.current?.scrollBy({ left: -200, behavior: 'smooth' })
  }

  // 滚动右边
  const handleScrollRight = () => {
    tabsContainerRef.current?.scrollBy({ left: 200, behavior: 'smooth' })
  }

  // 关闭活跃会话（弹确认框）
  const handleCloseActiveTab = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    setClosingSessionId(sessionId)
  }

  // 关闭临时标签页（直接关闭，无需确认）
  const handleCloseTemporaryTab = (e: React.MouseEvent) => {
    e.stopPropagation()
    const prevTempId = temporaryTabId
    setTemporaryTab(null)
    // 若关闭的正是当前选中 tab，切换到第一个活跃会话
    if (selectedSessionId === prevTempId && activeSessions.length > 0) {
      selectSession(activeSessions[0].id)
    }
  }

  const handleConfirmClose = async () => {
    if (closingSessionId) {
      await terminateSession(closingSessionId)
    }
    setClosingSessionId(null)
  }

  // 确认批量关闭其他会话
  const handleConfirmCloseOthers = async () => {
    for (const sid of closingOtherSessionIds) {
      await terminateSession(sid)
    }
    setClosingOtherSessionIds([])
  }

  // 关闭右键菜单
  const closeCtxMenu = () => setCtxMenu(m => ({ ...m, visible: false }))

  // 构建活跃会话右键菜单项
  const buildActiveSessionMenuItems = (sessionId: string): MenuItem[] => {
    const session = sessions.find(s => s.id === sessionId)
    if (!session) return []

    const sessionName = session.name || session.config?.name || '未命名'
    const otherActiveIds = activeSessions.filter(s => s.id !== sessionId).map(s => s.id)

    return [
      {
        key: 'copy-name',
        label: '复制会话名称',
        icon: <Copy size={13} />,
        onClick: () => navigator.clipboard.writeText(sessionName),
      },
      {
        key: 'copy-id',
        label: '复制会话 ID',
        icon: <Hash size={13} />,
        onClick: () => navigator.clipboard.writeText(session.id),
      },
      { key: 'divider-1', type: 'divider' },
      {
        key: 'close-others',
        label: '关闭其他会话',
        disabled: otherActiveIds.length === 0,
        onClick: () => {
          // 收集要关闭的会话 ID，弹确认框
          setClosingOtherSessionIds(otherActiveIds)
        },
      },
      { key: 'divider-2', type: 'divider' },
      {
        key: 'terminate',
        label: '关闭会话（终止）',
        danger: true,
        onClick: () => setClosingSessionId(sessionId),
      },
    ] as MenuItem[]
  }

  // 构建临时标签页右键菜单项
  const buildTemporarySessionMenuItems = (): MenuItem[] => {
    return [
      {
        key: 'close-temp',
        label: '关闭临时标签页',
        icon: <X size={13} />,
        onClick: () => {
          const prevTempId = temporaryTabId
          setTemporaryTab(null)
          if (selectedSessionId === prevTempId && activeSessions.length > 0) {
            selectSession(activeSessions[0].id)
          }
        },
      },
    ] as MenuItem[]
  }

  if (displaySessions.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 p-8 border-2 border-dashed border-gray-600 rounded-lg">
          <Plus size={48} className="text-gray-600" />
          <span className="text-gray-500 text-lg">暂无活跃会话</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Tab 栏 - 左右箭头 + 滚动容器 */}
      <div className="flex items-center bg-bg-secondary border-b border-border relative min-h-[36px]">

        {/* 左滚动按钮 */}
        {canScrollLeft && (
          <button
            onClick={handleScrollLeft}
            className="flex-shrink-0 h-full px-1.5 flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-hover btn-transition z-10 border-r border-border/40"
            title="向左滚动"
          >
            <ChevronLeft size={14} />
          </button>
        )}

        {/* 标签滚动区域 */}
        <div
          ref={tabsContainerRef}
          className="tabs-scroll-container flex items-center flex-1 overflow-x-auto min-w-0"
          style={{ scrollbarWidth: 'none' }}
        >
          <style>{`
            .tabs-scroll-container::-webkit-scrollbar { display: none; }
          `}</style>

          {/* 活跃会话标签 */}
          {activeSessions.map((session) => {
            const isActive = session.id === currentTabId
            const statusColor = STATUS_COLORS[session.status] || STATUS_COLORS.idle
            const sessionName = session.name || session.config.name || '未命名'
            const statusLabel = STATUS_LABELS[session.status] || session.status
            const needsAttention = session.status === 'waiting_input' || session.status === 'error'

            return (
              <div
                key={session.id}
                onClick={() => selectSession(session.id)}
                onContextMenu={e => {
                  e.preventDefault()
                  setCtxMenu({
                    visible: true,
                    x: e.clientX,
                    y: e.clientY,
                    sessionId: session.id,
                    isTemporary: false,
                  })
                }}
                className={`group flex items-center cursor-pointer btn-transition border-b-2 flex-shrink-0 ${
                  isTabsOverflowing
                    ? 'gap-1 px-2 py-2 min-w-[90px] max-w-[140px]'
                    : 'gap-1.5 px-2.5 py-2 min-w-[100px] max-w-[180px]'
                } ${
                  isActive
                    ? 'bg-bg-primary border-accent-blue text-text-primary'
                    : 'border-transparent text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                }`}
                title={`${sessionName} - ${statusLabel}`}
              >
                {/* 状态指示 */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  {needsAttention && <AlertCircle size={11} className="text-accent-yellow" />}
                  <div
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${session.status === 'running' ? 'animate-pulse' : ''}`}
                    style={{ backgroundColor: statusColor }}
                  />
                </div>

                {/* 名称 */}
                <span className="text-xs font-medium truncate flex-1 min-w-0">
                  {sessionName}
                </span>

                {/* 状态文字 */}
                {(!isTabsOverflowing || isActive) && (
                  <span className="text-[10px] flex-shrink-0" style={{ color: statusColor }}>
                    {statusLabel}
                  </span>
                )}

                {/* 关闭按钮 */}
                <button
                  onClick={(e) => handleCloseActiveTab(e, session.id)}
                  className="flex-shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 text-text-muted hover:text-accent-red hover:bg-bg-tertiary btn-transition"
                  title="关闭会话"
                >
                  <X size={11} />
                </button>
              </div>
            )
          })}

          {/* 临时标签页（已完成/已终止会话，虚线边框 + 斜体标识） */}
          {temporarySession && !activeSessions.find((s) => s.id === temporarySession.id) && (
            <div
              key={temporarySession.id}
              onClick={() => void openSessionForChat(temporarySession.id)}
              onContextMenu={e => {
                e.preventDefault()
                setCtxMenu({
                  visible: true,
                  x: e.clientX,
                  y: e.clientY,
                  sessionId: temporarySession.id,
                  isTemporary: true,
                })
              }}
              className={`group flex items-center cursor-pointer btn-transition border-b-2 flex-shrink-0 ${
                isTabsOverflowing
                  ? 'gap-1 px-2 py-2 min-w-[90px] max-w-[160px]'
                  : 'gap-1.5 px-2.5 py-2 min-w-[100px] max-w-[200px]'
              } ${
                temporarySession.id === currentTabId
                  ? 'bg-bg-primary border-text-muted text-text-primary'
                  : 'border-transparent text-text-muted hover:text-text-primary hover:bg-bg-hover'
              }`}
              title="临时查看（已完成会话）- 同时只能打开一个"
            >
              {/* 时钟图标标识临时标签页 */}
              <Clock size={11} className="flex-shrink-0 text-text-muted opacity-70" />

              {/* 名称（斜体区分） */}
              <span className="text-xs font-medium truncate flex-1 min-w-0 italic">
                {temporarySession.name || temporarySession.config.name || '未命名'}
              </span>

              {/* 状态文字 */}
              {(!isTabsOverflowing || temporarySession.id === currentTabId) && (
                <span
                  className="text-[10px] flex-shrink-0"
                  style={{ color: STATUS_COLORS[temporarySession.status] || STATUS_COLORS.idle }}
                >
                  {STATUS_LABELS[temporarySession.status] || temporarySession.status}
                </span>
              )}

              {/* 关闭按钮（直接关闭，无需确认） */}
              <button
                onClick={handleCloseTemporaryTab}
                className="flex-shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 text-text-muted hover:text-accent-red hover:bg-bg-tertiary btn-transition"
                title="关闭临时标签页"
              >
                <X size={11} />
              </button>
            </div>
          )}
        </div>

        {/* 右滚动按钮 */}
        {canScrollRight && (
          <button
            onClick={handleScrollRight}
            className="flex-shrink-0 h-full px-1.5 flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-hover btn-transition z-10 border-l border-border/40"
            title="向右滚动"
          >
            <ChevronRight size={14} />
          </button>
        )}

        {/* 渐变遮罩 */}
        {canScrollRight && (
          <div className="absolute right-8 top-0 bottom-0 w-8 pointer-events-none bg-gradient-to-l from-bg-secondary to-transparent" />
        )}
        {canScrollLeft && (
          <div className="absolute left-8 top-0 bottom-0 w-8 pointer-events-none bg-gradient-to-r from-bg-secondary to-transparent" />
        )}
      </div>

      {/* 终端内容区 - 所有会话始终挂载，仅通过 display 切换可见性 */}
      {/* 避免 key 切换导致 xterm 实例反复销毁重建，引发滚动失效 */}
      <div className="flex-1 min-h-0 p-4 relative">
        {displaySessions.map((session) => {
          // Bug1修复：临时标签页的 TerminalPanel 需要传入 onAfterClose，
          // 让 TerminalHeader 右上角关闭按钮能正确清除 temporaryTabId
          const isTemp = session.id === temporarySession?.id
          const handleTempPanelClose = isTemp
            ? () => {
                setTemporaryTab(null)
                if (activeSessions.length > 0) {
                  selectSession(activeSessions[0].id)
                }
              }
            : undefined

          return (
            <div
              key={session.id}
              className="absolute inset-0 p-4"
              style={{ display: session.id === currentTabId ? 'block' : 'none' }}
            >
              <TerminalPanel sessionId={session.id} onAfterClose={handleTempPanelClose} />
            </div>
          )
        })}
      </div>

      {/* 关闭确认对话框（仅用于活跃会话） */}
      <ConfirmDialog
        open={closingSessionId !== null}
        title="关闭会话"
        message="确定要关闭此终端会话吗？正在运行的任务将被终止。"
        confirmText="关闭"
        danger
        onConfirm={handleConfirmClose}
        onCancel={() => setClosingSessionId(null)}
      />

      {/* 批量关闭其他会话确认对话框 */}
      <ConfirmDialog
        open={closingOtherSessionIds.length > 0}
        title="关闭其他会话"
        message={`确定要关闭其他 ${closingOtherSessionIds.length} 个终端会话吗？正在运行的任务将被终止。`}
        confirmText="全部关闭"
        danger
        onConfirm={handleConfirmCloseOthers}
        onCancel={() => setClosingOtherSessionIds([])}
      />

      {/* 右键菜单 */}
      <ContextMenu
        visible={ctxMenu.visible}
        x={ctxMenu.x}
        y={ctxMenu.y}
        items={
          ctxMenu.isTemporary
            ? buildTemporarySessionMenuItems()
            : buildActiveSessionMenuItems(ctxMenu.sessionId)
        }
        onClose={closeCtxMenu}
      />
    </div>
  )
}

TerminalTabs.displayName = 'TerminalTabs'

export default TerminalTabs
