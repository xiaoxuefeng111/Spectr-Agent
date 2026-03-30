/**
 * sidebar/index.tsx — Sidebar 子组件统一出口
 * 原 Sidebar.tsx 已拆分为以下子模块，此文件仅做 re-export。
 * @author weibin
 */

// 类型 & 常量
export { STATUS_LABELS, ACTIVE_STATUSES, EXECUTING_STATUSES, DONE_STATUSES, AGENT_STATUS_COLORS } from './types'
export type { GroupByMode, TimeGroup, DirGroup, SessionItemProps, TimeGroupCardProps, DirGroupCardProps, SessionPickerModalProps } from './types'

// 工具函数
export { getShortPath, getProviderColor, getProviderLabel, getActivityPreview } from './utils'
export { groupSessionsByTime, groupSessionsByDirectory, groupSessionsByWorkspace, sortSessionsInGroup } from './utils'

// 组件
export { SessionItem, AgentSubList, WorktreeSubList } from './SessionItem'
export { TimeGroupCard, DirGroupCard } from './SessionGroupCards'
export { SessionPickerModal } from './SessionPickerModal'
export { GroupByToggle } from './GroupByToggle'

// Hooks
export { useGroupCollapsed } from './hooks'
