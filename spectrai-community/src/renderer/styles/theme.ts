/**
 * 主题配置
 * @author weibin
 */

export { THEMES, THEME_IDS, DEFAULT_THEME_ID } from '../../shared/constants'
export type { ThemeConfig, ThemeTerminalColors } from '../../shared/types'

// 扩展主题工具函数
export const getStatusColor = (status: string): string => {
  const statusColors: Record<string, string> = {
    starting: '#D29922',
    running: '#3FB950',
    idle: '#8B949E',
    waiting_input: '#D29922',
    paused: '#8B949E',
    completed: '#58A6FF',
    error: '#F85149',
    terminated: '#484F58'
  }
  return statusColors[status] || '#8B949E'
}

export const getPriorityColor = (priority: string): string => {
  const priorityColors: Record<string, string> = {
    high: '#F85149',
    medium: '#D29922',
    low: '#8B949E'
  }
  return priorityColors[priority] || '#8B949E'
}
