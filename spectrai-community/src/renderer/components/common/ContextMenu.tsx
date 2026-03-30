/**
 * 通用右键菜单组件
 * 支持子菜单、视口边界检测、Portal 渲染
 * @author weibin
 */

import React, { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react'

// ========== 类型定义 ==========

export interface MenuItemDef {
  key: string
  label: string
  icon?: React.ReactNode
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  children?: MenuItemDef[]
  onClick?: () => void
}

export interface MenuDivider {
  key: string
  type: 'divider'
}

export type MenuItem = MenuItemDef | MenuDivider

interface ContextMenuProps {
  visible: boolean
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

// ========== 子菜单组件 ==========

interface SubMenuProps {
  items: MenuItemDef[]
  parentRect: DOMRect
  onClose: () => void
}

const SubMenu: React.FC<SubMenuProps> = ({ items, parentRect, onClose }) => {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })

  useEffect(() => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    let left = parentRect.right + 2
    let top = parentRect.top

    // 右侧超出 → 向左展开
    if (left + rect.width > vw) {
      left = parentRect.left - rect.width - 2
    }
    // 底部超出 → 上移
    if (top + rect.height > vh) {
      top = vh - rect.height - 8
    }
    if (top < 8) top = 8

    setPosition({ top, left })
  }, [parentRect])

  return (
    <div
      ref={ref}
      className="fixed z-[10001] bg-bg-secondary border border-border rounded-lg shadow-2xl py-1 min-w-[160px] animate-context-menu"
      style={{ top: position.top, left: position.left }}
    >
      {items.map((item) => (
        <MenuItemRow key={item.key} item={item} onClose={onClose} />
      ))}
    </div>
  )
}

// ========== 菜单项行 ==========

interface MenuItemRowProps {
  item: MenuItemDef
  onClose: () => void
}

const MenuItemRow: React.FC<MenuItemRowProps> = ({ item, onClose }) => {
  const rowRef = useRef<HTMLDivElement>(null)
  const [showSub, setShowSub] = useState(false)
  const enterTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const hasChildren = item.children && item.children.length > 0

  const handleMouseEnter = () => {
    if (!hasChildren) return
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current)
      leaveTimer.current = null
    }
    enterTimer.current = setTimeout(() => setShowSub(true), 100)
  }

  const handleMouseLeave = () => {
    if (!hasChildren) return
    if (enterTimer.current) {
      clearTimeout(enterTimer.current)
      enterTimer.current = null
    }
    leaveTimer.current = setTimeout(() => setShowSub(false), 200)
  }

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (item.disabled) return
    if (hasChildren) return // 有子菜单的项不直接触发
    item.onClick?.()
    onClose()
  }

  useEffect(() => {
    return () => {
      if (enterTimer.current) clearTimeout(enterTimer.current)
      if (leaveTimer.current) clearTimeout(leaveTimer.current)
    }
  }, [])

  return (
    <div
      ref={rowRef}
      className={`
        relative flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer select-none
        transition-colors duration-75
        ${item.disabled
          ? 'opacity-40 cursor-not-allowed'
          : item.danger
            ? 'text-accent-red hover:bg-accent-red/10'
            : 'text-text-primary hover:bg-bg-hover'
        }
      `}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* 图标 */}
      <span className="w-4 h-4 flex items-center justify-center flex-shrink-0 opacity-70">
        {item.icon || null}
      </span>

      {/* 文本 */}
      <span className="flex-1">{item.label}</span>

      {/* 快捷键提示 */}
      {item.shortcut && (
        <span className="text-xs text-text-muted ml-4">{item.shortcut}</span>
      )}

      {/* 子菜单箭头 */}
      {hasChildren && (
        <ChevronRight size={12} className="text-text-muted flex-shrink-0" />
      )}

      {/* 子菜单 */}
      {hasChildren && showSub && rowRef.current && (
        <SubMenu
          items={item.children!}
          parentRect={rowRef.current.getBoundingClientRect()}
          onClose={onClose}
        />
      )}
    </div>
  )
}

// ========== 主菜单组件 ==========

const ContextMenu: React.FC<ContextMenuProps> = ({ visible, x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ top: y, left: x })

  // 视口边界检测
  useEffect(() => {
    if (!visible || !menuRef.current) return

    // 等一帧让 DOM 渲染完成
    requestAnimationFrame(() => {
      if (!menuRef.current) return
      const rect = menuRef.current.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight

      let newLeft = x
      let newTop = y

      if (x + rect.width > vw) newLeft = vw - rect.width - 8
      if (y + rect.height > vh) newTop = vh - rect.height - 8
      if (newLeft < 8) newLeft = 8
      if (newTop < 8) newTop = 8

      setPosition({ top: newTop, left: newLeft })
    })
  }, [visible, x, y])

  // 点击外部 & Escape 关闭
  const handleGlobalEvent = useCallback(
    (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key === 'Escape') {
        onClose()
        return
      }
      if (e instanceof MouseEvent && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    },
    [onClose]
  )

  useEffect(() => {
    if (!visible) return
    // 延迟绑定，避免当前右键事件被立即捕获
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleGlobalEvent as EventListener)
      document.addEventListener('keydown', handleGlobalEvent as EventListener)
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleGlobalEvent as EventListener)
      document.removeEventListener('keydown', handleGlobalEvent as EventListener)
    }
  }, [visible, handleGlobalEvent])

  // 更新初始位置
  useEffect(() => {
    setPosition({ top: y, left: x })
  }, [x, y])

  if (!visible) return null

  const isDivider = (item: MenuItem): item is MenuDivider => {
    return 'type' in item && item.type === 'divider'
  }

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[10000] bg-bg-secondary border border-border rounded-lg shadow-2xl py-1 min-w-[200px] animate-context-menu"
      style={{ top: position.top, left: position.left }}
    >
      {items.map((item) =>
        isDivider(item) ? (
          <div key={item.key} className="border-t border-border my-1" />
        ) : (
          <MenuItemRow key={item.key} item={item} onClose={onClose} />
        )
      )}
    </div>,
    document.body
  )
}

ContextMenu.displayName = 'ContextMenu'

export default ContextMenu
