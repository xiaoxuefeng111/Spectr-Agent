/**
 * 欢迎页 - 无会话时显示于主内容区，提供快速操作入口和最近会话列表
 * @author weibin
 */

import { Bot, Terminal, BarChart2 } from 'lucide-react'
import { useSessionStore } from '../../stores/sessionStore'
import { useUIStore } from '../../stores/uiStore'
import { STATUS_COLORS } from '../../../shared/constants'
import { toPlatformShortcutLabel } from '../../utils/shortcut'

/** 格式化相对时间：今天显示 HH:mm，否则显示日期 */
function formatTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()

  if (isToday) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

export default function WelcomeTab() {
  const sessions = useSessionStore(s => s.sessions)
  const setShowNewSessionDialog = useUIStore(s => s.setShowNewSessionDialog)
  const setViewMode = useUIStore(s => s.setViewMode)

  // 按 startedAt 倒序取前5条历史会话
  const recentSessions = [...sessions]
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, 5)

  return (
    <div className="flex flex-col items-center justify-center h-full bg-bg-primary">
      <div className="max-w-xl w-full px-8">

        {/* Logo 区域 */}
        <div className="flex flex-col items-center mb-10">
          <div className="flex items-center gap-3 mb-2">
            <Bot className="w-10 h-10 text-accent-blue" />
            <span className="text-2xl font-bold text-text-primary">SpectrAI</span>
          </div>
          <span className="text-sm text-text-muted">多 AI 会话编排平台</span>
        </div>

        {/* 快速操作区 */}
        <div className="mb-8">
          <p className="text-xs text-text-muted uppercase tracking-wider mb-3">开始</p>
          <div className="flex gap-3">
            {/* 新建会话 */}
            <button
              className="flex-1 flex flex-col items-center gap-2 p-4 bg-bg-secondary border border-border rounded-xl hover:bg-bg-hover cursor-pointer transition-colors"
              onClick={() => setShowNewSessionDialog(true)}
            >
              <Terminal className="w-6 h-6 text-text-secondary" />
              <span className="text-sm text-text-primary font-medium">新建会话</span>
            </button>

            {/* 查看看板 */}
            <button
              className="flex-1 flex flex-col items-center gap-2 p-4 bg-bg-secondary border border-border rounded-xl hover:bg-bg-hover cursor-pointer transition-colors"
              onClick={() => setViewMode('dashboard')}
            >
              <BarChart2 className="w-6 h-6 text-text-secondary" />
              <span className="text-sm text-text-primary font-medium">查看看板</span>
            </button>
          </div>
        </div>

        {/* 最近会话区（仅在有历史记录时显示） */}
        {recentSessions.length > 0 && (
          <div className="mb-8">
            <p className="text-xs text-text-muted uppercase tracking-wider mb-3">最近会话</p>
            <div className="flex flex-col gap-1">
              {recentSessions.map(session => (
                <div
                  key={session.id}
                  className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-bg-secondary transition-colors"
                >
                  {/* 状态彩色圆点 */}
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: STATUS_COLORS[session.status] ?? '#8B949E' }}
                  />
                  {/* 会话名称 */}
                  <span className="flex-1 text-sm text-text-primary truncate">
                    {session.name || session.id}
                  </span>
                  {/* 状态文字 */}
                  <span className="text-xs text-text-muted flex-shrink-0">
                    {session.status}
                  </span>
                  {/* 时间 */}
                  <span className="text-xs text-text-muted flex-shrink-0">
                    {formatTime(session.startedAt)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 底部快捷键提示 */}
        <div className="flex gap-4 justify-center">
          <span className="text-xs text-text-muted">
            <kbd className="px-1.5 py-0.5 bg-bg-secondary border border-border rounded text-xs">{toPlatformShortcutLabel('Ctrl+N')}</kbd>
            {' '}新建会话
          </span>
          <span className="text-xs text-text-muted">
            <kbd className="px-1.5 py-0.5 bg-bg-secondary border border-border rounded text-xs">{toPlatformShortcutLabel('Ctrl+B')}</kbd>
            {' '}折叠侧边栏
          </span>
        </div>

      </div>
    </div>
  )
}
