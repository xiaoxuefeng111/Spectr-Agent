/**
 * 底部状态栏 - 会话统计与视图切换
 * @author weibin
 */

import { useState, useEffect, useCallback } from 'react'
import { Grid3x3, Columns2, BarChart3, Zap, Kanban } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import { useSessionStore } from '../../stores/sessionStore'
import type { ViewMode } from '../../../shared/types'
import { toPlatformShortcutLabel } from '../../utils/shortcut'

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export default function StatusBar() {
  const { viewMode, setViewMode } = useUIStore()
  const { sessions } = useSessionStore()
  const [elapsed, setElapsed] = useState(0)
  const [todayTokens, setTodayTokens] = useState(0)

  const activeSessions = sessions.filter(
    (s) => s.status === 'running' || s.status === 'waiting_input'
  )
  const totalSessions = sessions.length
  const runningSessions = sessions.filter(s => s.status === 'running').length
  const waitingSessions = sessions.filter(s => s.status === 'idle' || s.status === 'waiting_input').length
  const errorSessions = sessions.filter(s => s.status === 'error').length

  // 计算运行时间
  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed(prev => prev + 1)
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  // 定期获取 token 用量
  const fetchUsage = useCallback(async () => {
    try {
      const summary = await window.spectrAI.usage.getSummary()
      setTodayTokens(summary.todayTokens || 0)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    fetchUsage()
    const timer = setInterval(fetchUsage, 10_000)
    return () => clearInterval(timer)
  }, [fetchUsage])

  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode)
  }

  return (
    <div className="h-8 bg-bg-secondary border-t border-border flex items-center justify-between px-4 text-xs text-text-secondary">
      {/* 左侧：活跃会话数 */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${
              activeSessions.length > 0 ? 'bg-accent-green animate-pulse' : 'bg-text-muted'
            }`}
          ></div>
          <span
            title="活跃会话 / 历史总会话"
            className="cursor-default"
          >
            活跃 {activeSessions.length}
            <span className="mx-1 text-text-muted">/</span>
            共 {totalSessions}
          </span>
        </div>
      </div>

      {/* 中间：视图模式切换 + 布局切换 */}
      <div className="flex items-center gap-1.5">
      {/* 视图模式按钮组 */}
      <div className="flex items-center gap-1 bg-bg-tertiary rounded px-1">
        <button
          onClick={() => handleViewModeChange('grid')}
          className={`p-1.5 rounded btn-transition ${
            viewMode === 'grid'
              ? 'bg-accent-blue text-white'
              : 'text-text-secondary hover:text-text-primary'
          }`}
          title={`网格视图 (${toPlatformShortcutLabel('Ctrl+1')})`}
        >
          <Grid3x3 className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => handleViewModeChange('tabs')}
          className={`p-1.5 rounded btn-transition ${
            viewMode === 'tabs'
              ? 'bg-accent-blue text-white'
              : 'text-text-secondary hover:text-text-primary'
          }`}
          title={`标签页视图 (${toPlatformShortcutLabel('Ctrl+2')})`}
        >
          <Columns2 className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => handleViewModeChange('dashboard')}
          className={`p-1.5 rounded btn-transition ${
            viewMode === 'dashboard'
              ? 'bg-accent-blue text-white'
              : 'text-text-secondary hover:text-text-primary'
          }`}
          title={`仪表盘 (${toPlatformShortcutLabel('Ctrl+3')})`}
        >
          <BarChart3 className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => handleViewModeChange('kanban')}
          className={`p-1.5 rounded btn-transition ${
            viewMode === 'kanban'
              ? 'bg-accent-blue text-white'
              : 'text-text-secondary hover:text-text-primary'
          }`}
          title={`任务看板 (${toPlatformShortcutLabel('Ctrl+4')})`}
        >
          <Kanban className="w-3.5 h-3.5" />
        </button>
      </div>
      </div>

      {/* 右侧：会话统计 + Token 用量 + 运行总时间 */}
      <div className="flex items-center gap-4">
        <div
          className="hidden md:flex items-center gap-3 text-[11px] cursor-default"
          title="会话统计：总计 / 运行 / 等待 / 异常"
        >
          <span className="text-text-muted">
            总 <span className="font-semibold text-text-primary">{totalSessions}</span>
          </span>
          <span className="text-text-muted">
            运行 <span className="font-semibold text-accent-green">{runningSessions}</span>
          </span>
          <span className="text-text-muted">
            等待 <span className="font-semibold text-accent-yellow">{waitingSessions}</span>
          </span>
          <span className="text-text-muted">
            异常 <span className="font-semibold text-accent-red">{errorSessions}</span>
          </span>
        </div>
        <div
          className="flex md:hidden items-center gap-2 text-[11px] cursor-default"
          title="会话统计：总计 / 运行 / 等待 / 异常"
        >
          <span className="text-text-muted">总 <span className="font-semibold text-text-primary">{totalSessions}</span></span>
          <span className="text-text-muted">运 <span className="font-semibold text-accent-green">{runningSessions}</span></span>
          <span className="text-text-muted">等 <span className="font-semibold text-accent-yellow">{waitingSessions}</span></span>
          <span className="text-text-muted">异 <span className="font-semibold text-accent-red">{errorSessions}</span></span>
        </div>

        {todayTokens > 0 && (
          <div
            className="flex items-center gap-1 text-accent-yellow cursor-default"
            title="今日 Token 用量"
          >
            <Zap className="w-3 h-3" />
            <span>
              {formatTokens(todayTokens)}
              <span className="text-[10px] opacity-70 ml-0.5">tok</span>
            </span>
          </div>
        )}
        <span
          title="应用本次启动运行时长"
          className="cursor-default"
        >
          运行 {formatDuration(elapsed * 1000)}
        </span>
      </div>
    </div>
  )
}
