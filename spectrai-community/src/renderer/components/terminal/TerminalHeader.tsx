/**
 * 终端面板顶部信息栏
 * 显示会话名称（主标识）、Provider 徽章、工作目录、运行时长、当前活动
 * @author weibin
 */

import React, { useState, useEffect } from 'react'
import { Maximize2, X, AlertTriangle, Copy, Hash, FolderOpen, ExternalLink } from 'lucide-react'
import { useSessionStore } from '../../stores/sessionStore'
import { useUIStore } from '../../stores/uiStore'
import { STATUS_COLORS } from '../../../shared/constants'
import type { SessionStatus } from '../../../shared/types'
import ContextMenu from '../common/ContextMenu'
import type { MenuItem } from '../common/ContextMenu'


interface TerminalHeaderProps {
  sessionId: string
  onMaximize?: () => void
  onClose?: () => void
  children?: React.ReactNode
}

/** 状态中文标签（仅用于 title 提示，徽章已移至 Tab） */
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

/** 卡住类型中文标签 */
const STUCK_LABELS: Record<string, string> = {
  'startup-stuck': '启动超时',
  'possible-stuck': '可能卡住',
  'stuck': '已卡住',
}

/** 根据 providerId 返回显示标签和品牌颜色 */
function getProviderInfo(providerId?: string): { label: string; color: string } {
  switch (providerId) {
    case 'claude-code':
      return { label: 'Claude Code', color: '#58A6FF' }
    case 'iflow':
    case 'iflow-cli':
      return { label: 'iFlow CLI', color: '#A78BFA' }
    case 'codex':
      return { label: 'Codex', color: '#F97316' }
    case 'gemini-cli':
      return { label: 'Gemini', color: '#34D399' }

    default:
      return { label: providerId?.slice(0, 8) || 'Unknown', color: '#6B7280' }
  }
}

/** 截断路径，只显示最后两段，如 desk_code/spectrai */
function getShortPath(fullPath: string): string {
  if (!fullPath) return ''
  const parts = fullPath.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length <= 2) return parts.join('/')
  return parts.slice(-2).join('/')
}

function formatDuration(startTimeISO: string): string {
  const seconds = Math.floor((Date.now() - new Date(startTimeISO).getTime()) / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`
}

/** 过滤掉会话生命周期噪音，只显示有意义的活动文本 */
function getFilteredActivity(detail?: string): string | null {
  if (!detail) return null
  if (detail.includes('Session started') || detail.includes('Session ended')) return null
  return detail
}

const TerminalHeader: React.FC<TerminalHeaderProps> = ({ sessionId, onMaximize, onClose, children }) => {
  const { sessions, lastActivities, stuckSessions, terminateSession } = useSessionStore()
  const session = sessions.find((s) => s.id === sessionId)
  const lastActivity = lastActivities[sessionId]
  const [duration, setDuration] = useState('')
  // 右键菜单显示状态
  const [ctxMenu, setCtxMenu] = useState({ visible: false, x: 0, y: 0 })

  // 更新运行时长
  useEffect(() => {
    if (!session?.startedAt) return
    if (session.status === 'completed' || session.status === 'terminated') {
      setDuration(formatDuration(session.startedAt))
      return
    }

    const update = () => setDuration(formatDuration(session.startedAt))
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [session?.status, session?.startedAt])

  if (!session) {
    return (
      <div className="h-9 bg-bg-secondary border-b border-border px-3 flex items-center">
        <span className="text-gray-500 text-sm">会话未找到</span>
      </div>
    )
  }

  const statusColor = STATUS_COLORS[session.status] || STATUS_COLORS.idle
  const statusLabel = STATUS_LABELS[session.status] || session.status
  const needsAttention = session.status === 'waiting_input' || session.status === 'error'
  const stuckType = stuckSessions[sessionId]
  const isStuck = !!stuckType

  const { label: providerLabel, color: providerColor } = getProviderInfo(session.providerId)
  const shortPath = getShortPath(session.config?.workingDirectory || '')
  const activityText = getFilteredActivity(lastActivity?.detail)

  // 右键菜单项
  const menuItems: MenuItem[] = [
    {
      key: 'copy-name',
      label: '复制会话名称',
      icon: <Copy size={13} />,
      onClick: () => navigator.clipboard.writeText(session.name || session.config?.name || '未命名'),
    },
    {
      key: 'copy-id',
      label: '复制会话 ID',
      icon: <Hash size={13} />,
      onClick: () => navigator.clipboard.writeText(session.id),
    },
    { key: 'div1', type: 'divider' },
    {
      key: 'copy-dir',
      label: '复制工作目录路径',
      icon: <FolderOpen size={13} />,
      disabled: !session.config?.workingDirectory,
      onClick: () => navigator.clipboard.writeText(session.config?.workingDirectory || ''),
    },
    {
      key: 'open-explorer',
      label: '在资源管理器中打开',
      icon: <ExternalLink size={13} />,
      disabled: !session.config?.workingDirectory,
      onClick: () => (window as any).spectrAI?.shell?.openPath(session.config?.workingDirectory),
    },
    { key: 'div2', type: 'divider' },
    {
      key: 'terminate',
      label: '终止会话',
      icon: <X size={13} />,
      danger: true,
      disabled: session.status === 'completed' || session.status === 'terminated',
      onClick: () => terminateSession(sessionId),
    },
  ]

  return (
    <div
      className={`h-10 bg-bg-secondary border-b px-3 flex items-center justify-between ${
        isStuck ? 'border-orange-500/50' : needsAttention ? 'border-yellow-600/50' : 'border-border'
      }`}
      onContextMenu={(e) => {
        e.preventDefault()
        setCtxMenu({ visible: true, x: e.clientX, y: e.clientY })
      }}
    >
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {/* 会话名称 — 主标识，放最左边最显眼 */}
        <span className="text-sm text-gray-300 font-medium truncate max-w-[160px] flex-shrink-0">
          {session.name || session.config.name || '未命名'}
        </span>

        {/* Provider 徽章 — 次要信息 */}
        <div
          className="px-1.5 py-0.5 rounded text-[10px] font-semibold flex-shrink-0"
          style={{
            backgroundColor: providerColor + '22',
            color: providerColor,
            border: `1px solid ${providerColor}44`
          }}
        >
          {providerLabel}
        </div>

        {/* 状态小圆点 */}
        <div
          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${session.status === 'running' ? 'animate-pulse' : ''}`}
          style={{ backgroundColor: statusColor }}
          title={statusLabel}
        />

        {/* 工作目录 */}
        {shortPath && (
          <span
            className="text-[11px] text-gray-400 font-mono truncate max-w-[180px] flex-shrink-0"
            title={session.config?.workingDirectory}
          >
            {shortPath}
          </span>
        )}

        {/* 分隔符 */}
        {shortPath && (duration || activityText) && (
          <span className="text-gray-600 text-[10px] flex-shrink-0">·</span>
        )}

        {/* 运行时长 */}
        {duration && (
          <span className="text-[11px] text-gray-500 font-mono flex-shrink-0">{duration}</span>
        )}

        {/* 卡住警告 */}
        {isStuck && (
          <div className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 bg-orange-500/20 text-orange-400 animate-pulse">
            <AlertTriangle size={10} />
            {STUCK_LABELS[stuckType] || '异常'}
          </div>
        )}

        {/* 当前活动（过滤掉 Session started/ended 噪音） */}
        {activityText && (
          <span className="text-[11px] text-gray-500 truncate">{activityText}</span>
        )}
      </div>

      {/* 自定义插槽（如视图切换按钮） */}
      {children}

      {/* 操作按钮 */}
      <div className="flex items-center gap-1 flex-shrink-0 ml-2">
        <button
          onClick={onMaximize}
          className="text-gray-500 hover:text-gray-300 transition-colors p-1 rounded hover:bg-bg-hover"
          title="最大化"
        >
          <Maximize2 size={13} />
        </button>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-red-400 transition-colors p-1 rounded hover:bg-bg-hover"
          title="关闭"
        >
          <X size={13} />
        </button>
      </div>
      {/* 右键菜单 */}
      <ContextMenu
        visible={ctxMenu.visible}
        x={ctxMenu.x}
        y={ctxMenu.y}
        items={menuItems}
        onClose={() => setCtxMenu(m => ({ ...m, visible: false }))}
      />
    </div>
  )
}

TerminalHeader.displayName = 'TerminalHeader'

export default TerminalHeader
