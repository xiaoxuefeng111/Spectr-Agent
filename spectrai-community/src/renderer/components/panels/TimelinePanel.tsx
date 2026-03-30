/**
 * 时间线面板 - 展示当前选中会话的活动事件流
 * 可放置在左侧边栏或右侧面板（通过面板位置系统控制）
 * @author weibin
 */

import { useState, useEffect, useMemo } from 'react'
import {
  Activity, Clock, Zap,
  FileText, FileEdit, Terminal, Search, Eye, PenTool, Wrench,
  AlertTriangle, MessageSquare, PlayCircle, Filter, ChevronDown,
  ChevronRight, HelpCircle, Sparkles, SquareCheck
} from 'lucide-react'
import { useSessionStore } from '../../stores/sessionStore'
import { STATUS_COLORS } from '../../../shared/constants'
import type { ActivityEvent, ActivityEventType, SessionStatus } from '../../../shared/types'

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

/** 活动类型样式配置（含图标） */
const ACTIVITY_CONFIG: Record<string, {
  color: string
  label: string
  icon: typeof FileText
}> = {
  session_start:        { color: STATUS_COLORS.running, label: '启动',  icon: PlayCircle },
  thinking:             { color: '#BC8CFF',              label: '思考',  icon: Sparkles },
  file_read:            { color: '#58A6FF',              label: '读取',  icon: FileText },
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

function cleanDisplayText(text: string): string {
  return text
    .replace(/\x1B\[[?>=!]*[0-9;]*[a-zA-Z~@`]/g, '')
    .replace(/\x9B[?>=!]*[0-9;]*[a-zA-Z~@`]/g, '')
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[\x20-\x3F]*[\x40-\x7E]/g, '')
    .replace(/\x1B/g, '')
    .replace(/\[[\?>=!]?\d{1,5}[a-zA-Z]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .trim()
}

function formatTime(isoString: string): string {
  try {
    return new Date(isoString).toLocaleTimeString()
  } catch {
    return '--:--:--'
  }
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

interface EventGroup {
  type: 'single' | 'group'
  events: ActivityEvent[]
}

function groupConsecutiveEvents(events: ActivityEvent[]): EventGroup[] {
  if (events.length === 0) return []
  const groups: EventGroup[] = []
  let currentGroup: ActivityEvent[] = [events[0]]
  for (let i = 1; i < events.length; i++) {
    if (events[i].type === currentGroup[0].type) {
      currentGroup.push(events[i])
    } else {
      groups.push({ type: currentGroup.length > 2 ? 'group' : 'single', events: currentGroup })
      currentGroup = [events[i]]
    }
  }
  groups.push({ type: currentGroup.length > 2 ? 'group' : 'single', events: currentGroup })
  return groups
}

export default function TimelinePanel() {
  const { selectedSessionId, sessions, activities, selectSession } = useSessionStore()
  const [duration, setDuration] = useState('-')
  const [searchQuery, setSearchQuery] = useState('')
  const [activeFilters, setActiveFilters] = useState<Set<ActivityEventType>>(new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set())

  // 自动选中第一个活跃会话
  useEffect(() => {
    if (selectedSessionId) return
    const activeSession = sessions.find(
      s => s.status === 'running' || s.status === 'idle' || s.status === 'waiting_input'
    )
    if (activeSession) selectSession(activeSession.id)
  }, [sessions, selectedSessionId, selectSession])

  const selectedSession = sessions.find(s => s.id === selectedSessionId)
  const sessionActivities = selectedSessionId ? (activities[selectedSessionId] || []) : []

  const filteredActivities = useMemo(() => {
    let result = sessionActivities
    if (activeFilters.size > 0) result = result.filter(e => activeFilters.has(e.type))
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(e =>
        cleanDisplayText(e.detail).toLowerCase().includes(q) || e.type.toLowerCase().includes(q)
      )
    }
    return result
  }, [sessionActivities, activeFilters, searchQuery])

  const groupedEvents = useMemo(() => {
    const reversed = [...filteredActivities].reverse()
    return groupConsecutiveEvents(reversed)
  }, [filteredActivities])

  const availableTypes = useMemo(() => {
    const types = new Set<ActivityEventType>()
    sessionActivities.forEach(e => types.add(e.type))
    return Array.from(types)
  }, [sessionActivities])

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

  const toggleFilter = (type: ActivityEventType) => {
    setActiveFilters(prev => {
      const next = new Set(prev)
      next.has(type) ? next.delete(type) : next.add(type)
      return next
    })
  }

  const toggleGroup = (index: number) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      next.has(index) ? next.delete(index) : next.add(index)
      return next
    })
  }

  const renderEventRow = (event: ActivityEvent) => {
    const config = getActivityConfig(event.type)
    const Icon = config.icon
    return (
      <div key={event.id} className="flex items-start gap-2 p-2 rounded bg-bg-primary hover:bg-bg-hover btn-transition">
        <div className="mt-0.5 flex-shrink-0">
          <Icon className="w-3.5 h-3.5" style={{ color: config.color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-text-muted">{formatTime(event.timestamp)}</span>
            <span
              className="text-[10px] px-1 py-0.5 rounded font-medium"
              style={{ backgroundColor: config.color + '20', color: config.color }}
            >
              {config.label}
            </span>
          </div>
          <div className="text-xs text-text-primary mt-0.5 break-words">
            {cleanDisplayText(event.detail)}
          </div>
        </div>
      </div>
    )
  }

  if (!selectedSessionId) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center text-text-muted text-sm">
          <p>未选择会话</p>
          <p className="mt-2 text-xs">点击终端窗口或侧边栏会话查看详情</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto p-3">
      {/* 当前会话信息条 */}
      {selectedSession && (
        <div className="mb-3 p-2.5 rounded-lg bg-bg-primary border border-border">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium text-text-primary truncate">
              {selectedSession.name || selectedSession.config.name}
            </span>
            <div
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
              style={{
                backgroundColor: (STATUS_COLORS[selectedSession.status] || STATUS_COLORS.idle) + '20',
                color: STATUS_COLORS[selectedSession.status] || STATUS_COLORS.idle
              }}
            >
              <div
                className={`w-1.5 h-1.5 rounded-full ${selectedSession.status === 'running' ? 'animate-pulse' : ''}`}
                style={{ backgroundColor: STATUS_COLORS[selectedSession.status] || STATUS_COLORS.idle }}
              />
              {STATUS_LABELS[selectedSession.status] || selectedSession.status}
            </div>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-text-muted">
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" /> {duration}
            </span>
            <span className="flex items-center gap-1">
              <Zap className="w-3 h-3" /> {sessionActivities.length} 事件
            </span>
          </div>
        </div>
      )}

      {/* 搜索框 */}
      <div className="mb-2 relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-text-muted" />
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="搜索事件..."
          className="w-full pl-7 pr-3 py-1.5 text-xs bg-bg-primary border border-border rounded text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-blue/50"
        />
      </div>

      {/* 类型过滤器 */}
      {availableTypes.length > 1 && (
        <div className="mb-2 flex items-center gap-1 flex-wrap">
          <Filter className="w-3 h-3 text-text-muted flex-shrink-0" />
          {availableTypes.map(type => {
            const config = getActivityConfig(type)
            const isActive = activeFilters.has(type)
            return (
              <button
                key={type}
                onClick={() => toggleFilter(type)}
                className={`text-[10px] px-1.5 py-0.5 rounded font-medium btn-transition ${
                  isActive ? 'ring-1 ring-offset-1 ring-offset-bg-secondary' : 'opacity-60 hover:opacity-100'
                }`}
                style={{
                  backgroundColor: config.color + (isActive ? '30' : '15'),
                  color: config.color,
                }}
              >
                {config.label}
              </button>
            )
          })}
          {activeFilters.size > 0 && (
            <button
              onClick={() => setActiveFilters(new Set())}
              className="text-[10px] px-1.5 py-0.5 text-text-muted hover:text-text-primary btn-transition"
            >
              清除
            </button>
          )}
        </div>
      )}

      {/* 时间线列表 */}
      <h3 className="text-xs font-medium mb-2 text-text-secondary">
        活动时间线
        {filteredActivities.length !== sessionActivities.length && (
          <span className="text-text-muted ml-1">
            ({filteredActivities.length}/{sessionActivities.length})
          </span>
        )}
      </h3>

      {groupedEvents.length === 0 ? (
        <p className="text-xs text-text-muted">
          {sessionActivities.length === 0 ? '等待活动事件...' : '无匹配事件'}
        </p>
      ) : (
        <div className="space-y-1">
          {groupedEvents.map((group, groupIdx) => {
            if (group.type === 'single') {
              return group.events.map(event => renderEventRow(event))
            }
            const isExpanded = expandedGroups.has(groupIdx)
            const config = getActivityConfig(group.events[0].type)
            const Icon = config.icon
            const firstEvent = group.events[0]
            const lastEvent = group.events[group.events.length - 1]
            return (
              <div key={`group-${groupIdx}`}>
                {renderEventRow(firstEvent)}
                <button
                  onClick={() => toggleGroup(groupIdx)}
                  className="w-full flex items-center gap-2 px-2 py-1 text-[10px] text-text-muted hover:text-text-secondary btn-transition"
                >
                  {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  <Icon className="w-3 h-3" style={{ color: config.color }} />
                  <span>{isExpanded ? '收起' : `展开 ${group.events.length - 2} 个相似事件`}</span>
                </button>
                {isExpanded && group.events.slice(1, -1).map(event => renderEventRow(event))}
                {renderEventRow(lastEvent)}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
