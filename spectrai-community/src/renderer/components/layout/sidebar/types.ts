/**
 * Sidebar 子组件共享类型定义
 * @author weibin
 */
import type { Session, SessionStatus, AIProvider, ActivityEvent, Workspace } from '../../../../shared/types'

// ─────────────────────────────────────────────────────────
// 状态 / 分组 基础定义
// ─────────────────────────────────────────────────────────

/** 状态中文映射 */
export const STATUS_LABELS: Record<SessionStatus, string> = {
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

/** 运行中的状态集合 */
export const ACTIVE_STATUSES: Set<SessionStatus> = new Set(['running', 'starting', 'waiting_input', 'idle'])
export const EXECUTING_STATUSES: Set<SessionStatus> = new Set(['running', 'starting'])

/** 已结束/异常的状态 — 这些不在目录卡片里直接展示 */
export const DONE_STATUSES = new Set(['completed', 'terminated', 'error'])

/** Agent 状态颜色映射 */
export const AGENT_STATUS_COLORS: Record<string, string> = {
  pending: '#D29922',
  running: '#3FB950',
  completed: '#58A6FF',
  failed: '#F85149',
  cancelled: '#484F58',
}

/** 分组方式 */
export type GroupByMode = 'time' | 'directory' | 'workspace'

/** 时间分组 */
export interface TimeGroup {
  key: string
  title: string
  sessions: Session[]
  color: string
}

/** 目录 / 工作区分组 */
export interface DirGroup {
  key: string          // 唯一 key
  title: string        // 显示名称
  subtitle?: string    // 副标题 / tooltip
  sessions: Session[]
  type: 'directory' | 'workspace' | 'unassigned'
}

/** SessionItem 组件 Props */
export interface SessionItemProps {
  session: Session
  isSelected: boolean
  lastActivity?: ActivityEvent
  onSelect: (id: string) => void
  onContextMenu: (e: React.MouseEvent, id: string, status: SessionStatus) => void
  onResume: (id: string) => void
  onRename: (id: string, newName: string) => Promise<boolean>
  showDir?: boolean
  forceEditing?: boolean
  onEditingDone?: () => void
  aiRenaming?: boolean
  providers?: AIProvider[]
}

/** 时间分组卡片 Props */
export interface TimeGroupCardProps {
  group: TimeGroup
  selectedSessionId: string | null
  lastActivities: Record<string, any>
  selectSession: (id: string) => void
  onOpenWorktree: (id: string) => void
  handleContextMenu: (e: React.MouseEvent, id: string, status: SessionStatus) => void
  resumeSession: (id: string) => void
  renameSession: (id: string, newName: string) => Promise<boolean>
  renamingSessionId: string | null
  setRenamingSessionId: (id: string | null) => void
  aiRenamingSessionId: string | null
  providers: AIProvider[]
  agents: Record<string, any[]>
}

/** 目录分组卡片 Props */
export interface DirGroupCardProps extends TimeGroupCardProps {
  group: DirGroup
  onOpenPicker: () => void
  onDirContextMenu: (e: React.MouseEvent, workDir: string) => void
}

/** SessionPickerModal Props */
export interface SessionPickerModalProps {
  group: DirGroup
  onSelect: (id: string) => void
  onClose: () => void
  onOpenWorktree: (id: string) => void
  handleContextMenu: (e: React.MouseEvent, id: string, status: SessionStatus) => void
  lastActivities: Record<string, any>
  renamingSessionId: string | null
  setRenamingSessionId: (id: string | null) => void
  renameSession: (id: string, newName: string) => Promise<boolean>
  aiRenamingSessionId: string | null
  providers: AIProvider[]
  agents: Record<string, any[]>
  resumeSession: (id: string) => void
}
