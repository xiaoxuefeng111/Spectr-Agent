/**
 * 文件窗格主容器
 * 包含 FileTabs + CodeViewer，在中间区域展示文件内容
 * @author weibin
 */

import React from 'react'
import FileTabs from './FileTabs'
import CodeViewer from './CodeViewer'
import { useFileTabStore } from '../../stores/fileTabStore'
import { toPlatformShortcutLabel } from '../../utils/shortcut'

export default function FilePane() {
  const { tabs, activeTabId } = useFileTabStore()

  return (
    <div className="h-full flex flex-col bg-bg-primary">
      {/* Tab 栏 */}
      <FileTabs />

      {/* 编辑器区域 */}
      <div className="flex-1 min-h-0 relative">
        {tabs.length === 0 ? (
          /* 空状态：引导用户从文件树打开文件 */
          <div className="h-full flex flex-col items-center justify-center gap-3 text-text-muted select-none">
            <div className="text-5xl opacity-30">📄</div>
            <div className="text-sm">从左侧文件树单击文件打开</div>
            <div className="text-xs opacity-60">支持查看和编辑，{toPlatformShortcutLabel('Ctrl+S')} 保存</div>
          </div>
        ) : (
          /*
           * 同时渲染所有 Tab 的 Editor，通过 display 切换激活项。
           * 这样可以避免切换 Tab 时 Monaco Editor 重建，保留各 Tab 的滚动位置和撤销栈。
           */
          tabs.map(tab => (
            <div
              key={tab.id}
              className="absolute inset-0"
              style={{ display: tab.id === activeTabId ? 'block' : 'none' }}
            >
              <CodeViewer tabId={tab.id} />
            </div>
          ))
        )}
      </div>
    </div>
  )
}
