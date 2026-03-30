/**
 * 单个终端面板组件
 *
 * 使用结构化对话视图（SDK V2 Chat 模式）
 *
 * @author weibin
 */

import React, { useState } from 'react'
import TerminalHeader from './TerminalHeader'
import ConfirmDialog from '../common/ConfirmDialog'
import { ConversationView } from '../conversation'
import { useSessionStore } from '../../stores/sessionStore'

interface TerminalPanelProps {
  sessionId: string
  onMaximize?: () => void
  /** 会话关闭/终止后的回调，用于退出 focus 模式等视图切换 */
  onAfterClose?: () => void
}

const TerminalPanel: React.FC<TerminalPanelProps> = ({ sessionId, onMaximize, onAfterClose }) => {
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)

  const session = useSessionStore(state => state.sessions.find(s => s.id === sessionId))

  // 从 Zustand store 精确订阅需要的方法（避免订阅整个 store 导致无关更新触发重渲染）
  const terminateSession = useSessionStore(state => state.terminateSession)
  const selectSession = useSessionStore(state => state.selectSession)

  // 已结束状态（无需确认可直接关闭）
  const INACTIVE_STATUSES = new Set(['completed', 'terminated', 'interrupted', 'error'])

  // 处理关闭
  const handleClose = () => {
    if (session && INACTIVE_STATUSES.has(session.status)) {
      // 已完成/已终止的会话无需确认，直接执行
      handleConfirmClose()
    } else {
      setShowCloseConfirm(true)
    }
  }

  const handleConfirmClose = async () => {
    setShowCloseConfirm(false)
    await terminateSession(sessionId)
    // 关闭后通知父层（如 focus 模式退回到原视图）
    onAfterClose?.()
  }

  return (
    <div
      className="flex flex-col h-full bg-bg-primary rounded-lg border border-border overflow-hidden shadow-lg relative"
      onClick={() => selectSession(sessionId)}
    >
      {/* 终端头部 */}
      <TerminalHeader
        sessionId={sessionId}
        onMaximize={onMaximize}
        onClose={handleClose}
      />

      {/* 对话视图 */}
      <ConversationView sessionId={sessionId} />

      {/* 关闭确认对话框 */}
      <ConfirmDialog
        open={showCloseConfirm}
        title="关闭会话"
        message="确定要关闭此终端会话吗？正在运行的任务将被终止。"
        confirmText="关闭"
        danger
        onConfirm={handleConfirmClose}
        onCancel={() => setShowCloseConfirm(false)}
      />
    </div>
  )
}

TerminalPanel.displayName = 'TerminalPanel'

export default TerminalPanel
