/**
 * 监控看板侧边栏视图 - 展示会话统计和最近活跃会话
 * @author weibin
 */

import { Monitor, Activity, HelpCircle, AlertCircle } from 'lucide-react'
import { useSessionStore } from '../../stores/sessionStore'
import { useUIStore } from '../../stores/uiStore'
import { STATUS_COLORS } from '../../../shared/constants'
import type { SessionStatus } from '../../../shared/types'

/** 实际运行中状态集合 */
const RUNNING_STATUSES: SessionStatus[] = ['running', 'starting']

export default function DashboardSidebarView() {
  const sessions = useSessionStore(s => s.sessions)
  const setViewMode = useUIStore(s => s.setViewMode)

  // 统计数据计算
  const totalCount = sessions.length
  const runningCount = sessions.filter(s => RUNNING_STATUSES.includes(s.status)).length
  const waitingInputCount = sessions.filter(s => s.status === 'waiting_input').length
  const errorCount = sessions.filter(s => s.status === 'error').length

  // 最近活跃会话（按 startedAt 倒序，最多5条）
  const recentSessions = [...sessions]
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, 5)

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 标题栏 */}
      <div className="flex items-center px-3 py-2 border-b border-border shrink-0">
        <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
          监控看板
        </span>
      </div>

      {/* 内容区域 */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-3">
        {/* 统计卡片 - 2列网格 */}
        <div className="grid grid-cols-2 gap-1.5">
          {/* 总会话 */}
          <div className="bg-bg-secondary border border-border rounded-lg p-2 flex flex-col gap-0.5">
            <div className="flex items-center gap-1">
              <Monitor className="w-3 h-3 text-text-muted shrink-0" />
              <span className="text-xs text-text-muted truncate">总会话</span>
            </div>
            <span className="text-lg font-bold text-text-primary leading-none">
              {totalCount}
            </span>
          </div>

          {/* 运行中 */}
          <div className="bg-bg-secondary border border-border rounded-lg p-2 flex flex-col gap-0.5">
            <div className="flex items-center gap-1">
              <Activity className="w-3 h-3 text-accent-green shrink-0" />
              <span className="text-xs text-text-muted truncate">运行中</span>
            </div>
            <span className="text-lg font-bold text-accent-green leading-none">
              {runningCount}
            </span>
          </div>

          {/* 等待输入 */}
          <div className="bg-bg-secondary border border-border rounded-lg p-2 flex flex-col gap-0.5">
            <div className="flex items-center gap-1">
              <HelpCircle className="w-3 h-3 text-accent-yellow shrink-0" />
              <span className="text-xs text-text-muted truncate">等待输入</span>
            </div>
            <span className="text-lg font-bold text-accent-yellow leading-none">
              {waitingInputCount}
            </span>
          </div>

          {/* 出错 */}
          <div className="bg-bg-secondary border border-border rounded-lg p-2 flex flex-col gap-0.5">
            <div className="flex items-center gap-1">
              <AlertCircle className="w-3 h-3 text-accent-red shrink-0" />
              <span className="text-xs text-text-muted truncate">出错</span>
            </div>
            <span className="text-lg font-bold text-accent-red leading-none">
              {errorCount}
            </span>
          </div>
        </div>

        {/* 最近活跃会话 */}
        <div>
          <div className="px-1 mb-1">
            <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
              最近活跃
            </span>
          </div>

          {recentSessions.length === 0 ? (
            <p className="text-xs text-text-muted text-center py-3">暂无会话</p>
          ) : (
            <div className="space-y-0.5">
              {recentSessions.map(session => (
                <div
                  key={session.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-bg-hover transition-colors"
                >
                  {/* 状态颜色圆点 */}
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: STATUS_COLORS[session.status] ?? '#8B949E' }}
                  />
                  {/* 会话名称 */}
                  <span className="text-xs text-text-secondary truncate flex-1">
                    {session.name}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 底部按钮 */}
      <div className="shrink-0 px-2 pb-2 border-t border-border pt-2">
        <button
          onClick={() => setViewMode('dashboard')}
          className="w-full mt-2 py-1.5 text-xs rounded border border-border hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
        >
          打开完整看板
        </button>
      </div>
    </div>
  )
}
