/**
 * 文件 Tab 栏
 * 展示已打开的文件 Tab，风格与 TerminalTabs 保持一致
 * 支持右键菜单：复制路径、定位文件树、批量关闭等操作
 * @author weibin
 */

import React, { useState } from 'react'
import { X, FileText, Circle, Copy, FolderOpen, XSquare } from 'lucide-react'
import { useFileTabStore } from '../../stores/fileTabStore'
import ContextMenu, { MenuItem } from '../common/ContextMenu'
import { toPlatformShortcutLabel } from '../../utils/shortcut'

// 右键菜单状态类型
interface CtxMenuState {
  visible: boolean
  x: number
  y: number
  tabId: string
}

export default function FileTabs() {
  const {
    tabs,
    activeTabId,
    setActiveTab,
    closeTab,
    closeOtherTabs,
    closeTabsToLeft,
    closeTabsToRight,
    closeSavedTabs,
    closeAllTabs,
  } = useFileTabStore()

  // 右键菜单状态
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState>({
    visible: false,
    x: 0,
    y: 0,
    tabId: '',
  })

  // 关闭右键菜单
  const closeCtxMenu = () => setCtxMenu(m => ({ ...m, visible: false }))

  // 构建右键菜单项
  const buildMenuItems = (tabId: string): MenuItem[] => {
    const tab = tabs.find(t => t.id === tabId)
    if (!tab) return []

    const tabIndex = tabs.findIndex(t => t.id === tabId)
    const isFirst = tabIndex === 0
    const isLast = tabIndex === tabs.length - 1
    const hasSavedTabs = tabs.some(t => !t.isDirty)

    return [
      {
        key: 'copy-path',
        label: '复制文件路径',
        icon: <Copy size={13} />,
        onClick: () => navigator.clipboard.writeText(tab.path),
      },
      {
        key: 'reveal-in-tree',
        label: '在文件树中定位',
        icon: <FolderOpen size={13} />,
        onClick: () => console.log('TODO: reveal in tree', tab.path),
      },
      { key: 'divider-1', type: 'divider' },
      {
        key: 'close',
        label: '关闭',
        icon: <X size={13} />,
        shortcut: toPlatformShortcutLabel('Ctrl+W'),
        onClick: () => closeTab(tabId),
      },
      {
        key: 'close-others',
        label: '关闭其他标签页',
        icon: <XSquare size={13} />,
        disabled: tabs.length <= 1,
        onClick: () => closeOtherTabs(tabId),
      },
      {
        key: 'close-left',
        label: '关闭左侧标签页',
        disabled: isFirst,
        onClick: () => closeTabsToLeft(tabId),
      },
      {
        key: 'close-right',
        label: '关闭右侧标签页',
        disabled: isLast,
        onClick: () => closeTabsToRight(tabId),
      },
      { key: 'divider-2', type: 'divider' },
      {
        key: 'close-saved',
        label: '关闭已保存的标签页',
        disabled: !hasSavedTabs,
        onClick: () => closeSavedTabs(),
      },
      {
        key: 'close-all',
        label: '关闭所有标签页',
        danger: true,
        onClick: () => closeAllTabs(),
      },
    ] as MenuItem[]
  }

  // 无 Tab 时显示提示
  if (tabs.length === 0) {
    return (
      <div className="flex items-center h-9 px-4 bg-bg-secondary border-b border-border flex-shrink-0">
        <span className="text-xs text-text-secondary">← 从左侧文件树单击文件打开</span>
      </div>
    )
  }

  return (
    <>
      <div className="flex items-center bg-bg-secondary border-b border-border overflow-x-auto min-h-[36px] flex-shrink-0">
        {tabs.map(tab => {
          const isActive = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              onContextMenu={e => {
                e.preventDefault()
                setCtxMenu({ visible: true, x: e.clientX, y: e.clientY, tabId: tab.id })
              }}
              className={[
                'group flex items-center gap-1.5 px-3 py-2 cursor-pointer border-b-2',
                'flex-shrink-0 min-w-[100px] max-w-[180px] btn-transition',
                isActive
                  ? 'bg-bg-primary border-accent-blue text-text-primary'
                  : 'border-transparent text-text-secondary hover:text-text-primary hover:bg-bg-hover',
              ].join(' ')}
            >
              <FileText size={12} className="flex-shrink-0 opacity-70" />

              {/* 文件名 */}
              <span className="text-xs truncate flex-1">{tab.name}</span>

              {/* 未保存标记 */}
              {tab.isDirty && (
                <Circle
                  size={6}
                  className="flex-shrink-0 fill-current text-accent-blue"
                />
              )}

              {/* 关闭按钮 */}
              <button
                onClick={e => {
                  e.stopPropagation()
                  closeTab(tab.id)
                }}
                className="flex-shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-bg-tertiary btn-transition"
              >
                <X size={10} />
              </button>
            </div>
          )
        })}
      </div>

      {/* 右键菜单 */}
      <ContextMenu
        visible={ctxMenu.visible}
        x={ctxMenu.x}
        y={ctxMenu.y}
        items={buildMenuItems(ctxMenu.tabId)}
        onClose={closeCtxMenu}
      />
    </>
  )
}
