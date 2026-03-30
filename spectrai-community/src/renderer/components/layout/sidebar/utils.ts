/**
 * Sidebar 工具函数 — 分组、排序、格式化
 * @author weibin
 */
import type { Session, AIProvider, ActivityEvent, Workspace } from '../../../../shared/types'
import type { TimeGroup, DirGroup } from './types'
import { ACTIVE_STATUSES } from './types'

// ─────────────────────────────────────────────────────────
// 路径工具
// ─────────────────────────────────────────────────────────

/** 从完整路径提取短路径（最后两级） */
export function getShortPath(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length > 2 ? parts.slice(-2).join('/') : parts.join('/')
}

// ─────────────────────────────────────────────────────────
// Provider 工具
// ─────────────────────────────────────────────────────────

/** Provider 颜色映射 */
export function getProviderColor(providerId: string): string {
  switch (providerId) {
    case 'claude-code': return '#58A6FF'
    case 'iflow':
    case 'iflow-cli': return '#A78BFA'
    case 'codex': return '#F97316'
    case 'gemini-cli': return '#34D399'

    default: return '#6B7280'
  }
}

/** Provider 显示名称 */
export function getProviderLabel(providerId: string, providers?: AIProvider[]): string {
  switch (providerId) {
    case 'claude-code': return 'Claude'
    case 'iflow':
    case 'iflow-cli': return 'iFlow'
    case 'codex': return 'Codex'
    case 'gemini-cli': return 'Gemini'

    default: return providers?.find(p => p.id === providerId)?.name?.slice(0, 6) || providerId.slice(0, 6)
  }
}

/** 活动事件预览文本（过滤技术噪音，只显示有意义的内容） */
export function getActivityPreview(activity: ActivityEvent): string {
  switch (activity.type) {
    case 'assistant_message':
      return activity.detail
    case 'error':
      return activity.detail
    case 'user_input':
      return '↩ 已发送消息'
    case 'file_read':
      return '📄 读取文件'
    case 'file_write':
    case 'file_edit':
    case 'file_create':
      return '✏️ 修改文件'
    case 'file_delete':
      return '🗑️ 删除文件'
    case 'command_execute':
      return '⚡ 执行命令'
    case 'tool_use':
      return '🔧 使用工具'
    case 'waiting_confirmation':
      return '❓ 等待确认'
    case 'turn_complete':
      return '🔄 本轮完成（等待下一步）'
    case 'task_complete':
      return '✅ 任务完成'
    case 'session_start':
    case 'session_end':
      return ''
    default:
      return activity.detail ? activity.detail.slice(0, 40) : ''
  }
}

// ─────────────────────────────────────────────────────────
// 分组工具
// ─────────────────────────────────────────────────────────

/** 组内会话排序：运行中置顶，再按时间倒序 */
export function sortSessionsInGroup(sessions: Session[]): void {
  sessions.sort((a, b) => {
    const aR = ACTIVE_STATUSES.has(a.status) ? 1 : 0
    const bR = ACTIVE_STATUSES.has(b.status) ? 1 : 0
    if (aR !== bR) return bR - aR
    return new Date(b.endedAt || b.startedAt).getTime() - new Date(a.endedAt || a.startedAt).getTime()
  })
}

/** 按时间分组 */
export function groupSessionsByTime(sessions: Session[]): TimeGroup[] {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const weekAgo = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000)

  const running: Session[] = []
  const today: Session[] = []
  const week: Session[] = []
  const older: Session[] = []

  for (const s of sessions) {
    if (ACTIVE_STATUSES.has(s.status)) {
      running.push(s)
    } else {
      const ts = new Date(s.endedAt || s.startedAt)
      if (ts >= todayStart) today.push(s)
      else if (ts >= weekAgo) week.push(s)
      else older.push(s)
    }
  }

  const byTimeDesc = (a: Session, b: Session) => {
    const ta = new Date(a.endedAt || a.startedAt).getTime()
    const tb = new Date(b.endedAt || b.startedAt).getTime()
    return tb - ta
  }
  today.sort(byTimeDesc)
  week.sort(byTimeDesc)
  older.sort(byTimeDesc)

  const groups: TimeGroup[] = []
  if (running.length) groups.push({ key: 'running', title: '运行中', sessions: running, color: 'bg-accent-green' })
  if (today.length) groups.push({ key: 'today', title: '今天', sessions: today, color: 'bg-accent-blue' })
  if (week.length) groups.push({ key: 'week', title: '过去 7 天', sessions: week, color: 'bg-text-muted' })
  if (older.length) groups.push({ key: 'older', title: '更早', sessions: older, color: 'bg-text-muted' })
  return groups
}

/** 按工作目录分组 */
export function groupSessionsByDirectory(sessions: Session[]): DirGroup[] {
  const map = new Map<string, DirGroup>()

  for (const s of sessions) {
    const dir = s.config.workingDirectory || ''
    if (!map.has(dir)) {
      map.set(dir, {
        key: dir,
        title: getShortPath(dir) || dir || '未知目录',
        subtitle: dir,
        sessions: [],
        type: 'directory',
      })
    }
    map.get(dir)!.sessions.push(s)
  }

  const groups = Array.from(map.values())

  groups.sort((a, b) => {
    const aRunning = a.sessions.some(s => ACTIVE_STATUSES.has(s.status))
    const bRunning = b.sessions.some(s => ACTIVE_STATUSES.has(s.status))
    if (aRunning && !bRunning) return -1
    if (!aRunning && bRunning) return 1
    const aTime = Math.max(...a.sessions.map(s => new Date(s.endedAt || s.startedAt).getTime()))
    const bTime = Math.max(...b.sessions.map(s => new Date(s.endedAt || s.startedAt).getTime()))
    return bTime - aTime
  })

  groups.forEach(g => sortSessionsInGroup(g.sessions))
  return groups
}

/** 按工作区分组 */
export function groupSessionsByWorkspace(sessions: Session[], workspaces: Workspace[]): DirGroup[] {
  const repoToWs = new Map<string, Workspace>()
  for (const ws of workspaces) {
    for (const repo of ws.repos) {
      repoToWs.set(repo.repoPath.replace(/\\/g, '/').toLowerCase(), ws)
    }
  }

  const wsMap = new Map<string, DirGroup>()
  const unassigned: Session[] = []

  for (const s of sessions) {
    const dirNorm = (s.config.workingDirectory || '').replace(/\\/g, '/').toLowerCase()
    let matched: Workspace | undefined

    for (const [repoPath, ws] of repoToWs) {
      if (dirNorm === repoPath || dirNorm.startsWith(repoPath + '/')) {
        matched = ws
        break
      }
    }

    if (matched) {
      if (!wsMap.has(matched.id)) {
        const repoNames = matched.repos
          .map(r => r.repoPath.replace(/\\/g, '/').split('/').pop() || r.repoPath)
          .join(' · ')
        wsMap.set(matched.id, {
          key: matched.id,
          title: matched.name,
          subtitle: repoNames,
          sessions: [],
          type: 'workspace',
        })
      }
      wsMap.get(matched.id)!.sessions.push(s)
    } else {
      unassigned.push(s)
    }
  }

  const groups = Array.from(wsMap.values())
  if (unassigned.length > 0) {
    groups.push({
      key: '__unassigned__',
      title: '未分配工作区',
      subtitle: '未关联任何工作区的会话',
      sessions: unassigned,
      type: 'unassigned',
    })
  }

  groups.sort((a, b) => {
    if (a.type === 'unassigned') return 1
    if (b.type === 'unassigned') return -1
    const aRunning = a.sessions.some(s => ACTIVE_STATUSES.has(s.status))
    const bRunning = b.sessions.some(s => ACTIVE_STATUSES.has(s.status))
    if (aRunning && !bRunning) return -1
    if (!aRunning && bRunning) return 1
    return b.sessions.length - a.sessions.length
  })

  groups.forEach(g => sortSessionsInGroup(g.sessions))
  return groups
}
