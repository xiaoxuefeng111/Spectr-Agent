/**
 * 统计面板 - 展示当前会话的活动统计和全局用量
 * 可放置在左侧边栏或右侧面板（通过面板位置系统控制）
 * @author weibin
 */

import { useState, useEffect } from 'react'
import { Activity, AlertCircle, CheckCircle, Zap } from 'lucide-react'
import { useSessionStore } from '../../stores/sessionStore'
import { STATUS_COLORS } from '../../../shared/constants'
import type { ActivityEventType, SessionStatus } from '../../../shared/types'
import type { FileText } from 'lucide-react'
import {
  FileEdit, Terminal, Search, Eye, PenTool, Wrench,
  AlertTriangle, MessageSquare, PlayCircle,
  HelpCircle, Sparkles, SquareCheck
} from 'lucide-react'
import UsageDashboard from '../usage/UsageDashboard'

/** 状态中文标签 */
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

const ACTIVITY_CONFIG: Record<string, {
  color: string
  label: string
  icon: typeof FileText
}> = {
  session_start:        { color: STATUS_COLORS.running, label: '启动',  icon: PlayCircle },
  thinking:             { color: '#BC8CFF',              label: '思考',  icon: Sparkles },
  file_read:            { color: '#58A6FF',              label: '读取',  icon: Activity },
  file_write:           { color: '#D2A8FF',              label: '写入',  icon: FileEdit },
  file_create:          { color: '#D2A8FF',              label: '创建',  icon: FileEdit },
  file_delete:          { color: STATUS_COLORS.error,    label: '删除',  icon: FileEdit },
  command_execute:      { color: '#D29922',              label: '命令',  icon: Terminal },
  command_output:       { color: STATUS_COLORS.idle,     label: '输出',  icon: Terminal },
  search:               { color: '#58A6FF',              label: '搜索',  icon: Search },
  tool_use:             { color: '#58A6FF',              label: '工具',  icon: Wrench },
  error:                { color: STATUS_COLORS.error,    label: '错误',  icon: AlertTriangle },
  waiting_confirmation: { color: '#D29922',              label: '确认',  icon: HelpCircle },
  user_input:           { color: '#3FB950',              label: '输入',  icon: MessageSquare },
  turn_complete:        { color: '#58A6FF',              label: '回合完成',  icon: SquareCheck },
  task_complete:        { color: '#3FB950',              label: '完成',  icon: SquareCheck },
  context_summary:      { color: STATUS_COLORS.idle,     label: '摘要',  icon: Eye },
  assistant_message:    { color: '#79C0FF',              label: '回复',  icon: MessageSquare },
  idle:                 { color: STATUS_COLORS.idle,     label: '空闲',  icon: PenTool },
  unknown_activity:     { color: STATUS_COLORS.idle,     label: '活动',  icon: Activity },
}

function getActivityConfig(type: ActivityEventType) {
  return ACTIVITY_CONFIG[type] || ACTIVITY_CONFIG.unknown_activity
}

function formatDuration(startedAt: string): string {
  const seconds = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
}

export default function StatsPanel() {
  const { selectedSessionId, sessions, activities } = useSessionStore()
  const [duration, setDuration] = useState('-')

  const selectedSession = sessions.find(s => s.id === selectedSessionId)
  const sessionActivities = selectedSessionId ? (activities[selectedSessionId] || []) : []

  const activityStats = sessionActivities.reduce<Record<string, number>>((acc, evt) => {
    acc[evt.type] = (acc[evt.type] || 0) + 1
    return acc
  }, {})

  // 更新运行时长
  useEffect(() => {
    if (!selectedSession?.startedAt) { setDuration('-'); return }
    if (selectedSession.status === 'completed' || selectedSession.status === 'terminated') {
      setDuration(formatDuration(selectedSession.startedAt)); return
    }
    const update = () => setDuration(formatDuration(selectedSession.startedAt!))
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [selectedSession?.id, selectedSession?.status, selectedSession?.startedAt])

  return (
    <div className="flex flex-col h-full overflow-y-auto p-3 space-y-3">
      {/* 当前会话快速统计 */}
      {selectedSession && (
        <>
          <div className="p-2.5 rounded-lg bg-bg-primary border border-border">
            <div className="text-[10px] text-text-muted mb-1">当前会话</div>
            <div className="flex items-center gap-2">
              {selectedSession.status === 'error' ? (
                <AlertCircle className="w-4 h-4 text-accent-red" />
              ) : selectedSession.status === 'completed' ? (
                <CheckCircle className="w-4 h-4 text-accent-blue" />
              ) : (
                <div
                  className={`w-3 h-3 rounded-full ${selectedSession.status === 'running' ? 'animate-pulse' : ''}`}
                  style={{ backgroundColor: STATUS_COLORS[selectedSession.status || 'idle'] }}
                />
              )}
              <span className="text-sm font-medium text-text-primary">
                {STATUS_LABELS[selectedSession.status as SessionStatus] || '-'}
              </span>
              <span className="text-xs text-text-muted ml-auto">{duration}</span>
            </div>
            <div className="flex items-center gap-4 mt-1.5 text-[11px] text-text-muted">
              <span className="flex items-center gap-1">
                <Zap className="w-3 h-3 text-accent-yellow" />
                {selectedSession.estimatedTokens.toLocaleString()} tokens
              </span>
              <span className="flex items-center gap-1">
                <Activity className="w-3 h-3" />
                {sessionActivities.length} 事件
              </span>
            </div>
          </div>

          {/* 活动类型分布 */}
          {Object.keys(activityStats).length > 0 && (
            <div className="p-2.5 rounded-lg bg-bg-primary border border-border">
              <div className="text-[10px] text-text-muted mb-2">活动类型分布</div>
              <div className="space-y-1.5">
                {Object.entries(activityStats)
                  .sort((a, b) => b[1] - a[1])
                  .map(([type, count]) => {
                    const config = getActivityConfig(type as ActivityEventType)
                    const Icon = config.icon
                    const total = sessionActivities.length
                    const pct = Math.round((count / total) * 100)
                    return (
                      <div key={type}>
                        <div className="flex items-center justify-between mb-0.5">
                          <div className="flex items-center gap-1.5">
                            <Icon className="w-3 h-3" style={{ color: config.color }} />
                            <span className="text-xs text-text-secondary">{config.label}</span>
                          </div>
                          <span className="text-xs font-medium text-text-primary">{count}</span>
                        </div>
                        <div className="h-1 rounded-full bg-bg-hover overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${pct}%`, backgroundColor: config.color }}
                          />
                        </div>
                      </div>
                    )
                  })}
              </div>
            </div>
          )}

          <div className="border-t border-border" />
        </>
      )}

      {/* 全局用量仪表盘 */}
      <UsageDashboard />
    </div>
  )
}
