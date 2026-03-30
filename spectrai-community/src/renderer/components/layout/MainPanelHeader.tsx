/**
 * 中间区域顶部 Header
 * 左侧：[💬 会话] [📁 文件] 大分类 Tab
 * 右侧：布局切换按钮（单窗格 / 左右分栏 / 上下分栏）
 * @author weibin
 */

import React from 'react'
import { MessageSquare, FolderOpen } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import LayoutControls from './LayoutControls'

export default function MainPanelHeader() {
  const { layoutMode, primaryPane, setPaneContent, swapPanes } = useUIStore()

  const isSplit = layoutMode !== 'single'

  const handleSessionsClick = () => {
    if (!isSplit) {
      // 单窗格：直接切换显示内容
      setPaneContent('primary', 'sessions')
    } else if (primaryPane !== 'sessions') {
      // 拆分模式：sessions 在次位置，交换使其成为主位置
      swapPanes()
    }
    // 拆分模式且 sessions 已在主位置：无操作
  }

  const handleFilesClick = () => {
    if (!isSplit) {
      // 单窗格：直接切换显示内容
      setPaneContent('primary', 'files')
    } else if (primaryPane !== 'files') {
      // 拆分模式：files 在次位置，交换使其成为主位置
      swapPanes()
    }
    // 拆分模式且 files 已在主位置：无操作
  }

  // 单窗格：仅高亮当前内容的 Tab
  // 拆分模式：主位置 Tab 全亮，次位置 Tab 淡色下划线（表示存在于副窗格）
  const getTabClass = (content: 'sessions' | 'files') => {
    if (!isSplit) {
      return primaryPane === content
        ? 'border-accent-blue text-text-primary'
        : 'border-transparent text-text-secondary hover:text-text-primary'
    }
    return primaryPane === content
      ? 'border-accent-blue text-text-primary'
      : 'border-accent-blue/30 text-text-secondary hover:text-text-primary hover:border-accent-blue/60'
  }

  return (
    <div className="flex items-center justify-between border-b border-border bg-bg-secondary flex-shrink-0 h-9 px-2">
      {/* 左侧：分类 Tab */}
      <div className="flex items-center">
        <button
          onClick={handleSessionsClick}
          className={`flex items-center gap-1.5 px-3 h-9 text-xs font-medium border-b-2 transition-colors ${getTabClass('sessions')}`}
        >
          <MessageSquare size={13} />
          会话
        </button>
        <button
          onClick={handleFilesClick}
          className={`flex items-center gap-1.5 px-3 h-9 text-xs font-medium border-b-2 transition-colors ${getTabClass('files')}`}
        >
          <FolderOpen size={13} />
          文件
        </button>
      </div>

      {/* 右侧：布局控制 */}
      <LayoutControls />
    </div>
  )
}
