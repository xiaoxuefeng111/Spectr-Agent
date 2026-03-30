/**
 * Sidebar hooks — 折叠状态管理等
 * @author weibin
 */
import { useState, useCallback } from 'react'

/**
 * 折叠状态管理 Hook（localStorage 持久化）
 * @param storageKey localStorage 键名
 */
export function useGroupCollapsed(storageKey: string) {
  const [state, setState] = useState<Record<string, boolean | null>>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      return raw ? JSON.parse(raw) : {}
    } catch { return {} }
  })

  const isCollapsed = useCallback((key: string, hasRunning: boolean): boolean => {
    const manual = state[key]
    if (manual !== undefined && manual !== null) return manual
    return !hasRunning  // 默认：有运行中则展开，否则折叠
  }, [state])

  const toggle = useCallback((key: string, hasRunning: boolean) => {
    setState(prev => {
      const currentlyCollapsed = (() => {
        const manual = prev[key]
        if (manual !== undefined && manual !== null) return manual
        return !hasRunning
      })()
      const next = { ...prev, [key]: !currentlyCollapsed }
      try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [storageKey])

  // 强制展开某个分组（不影响 localStorage，仅临时展开用于自动定位）
  const forceExpand = useCallback((key: string) => {
    setState(prev => {
      if (prev[key] === false) return prev  // 已展开，无需变更
      const next = { ...prev, [key]: false }
      try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [storageKey])

  return { isCollapsed, toggle, forceExpand }
}
