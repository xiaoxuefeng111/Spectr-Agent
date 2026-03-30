/**
 * 终端面板网格布局组件
 * 根据会话数量自动调整网格布局
 * @author weibin
 */

import React from 'react'
import { Plus } from 'lucide-react'
import { useSessionStore } from '../../stores/sessionStore'
import { useUIStore } from '../../stores/uiStore'
import TerminalPanel from './TerminalPanel'

/**
 * 根据会话数量计算网格布局
 * @param count 会话数量
 * @returns [columns, rows]
 */
function calculateGridLayout(count: number): [number, number] {
  if (count === 0) return [1, 1]
  if (count === 1) return [1, 1]
  if (count === 2) return [2, 1]
  if (count <= 4) return [2, 2]
  if (count <= 6) return [3, 2]
  if (count <= 9) return [3, 3]
  return [4, 3]
}

const TerminalGrid: React.FC = () => {
  // 从 Zustand store 获取状态和方法
  const { sessions, selectSession } = useSessionStore()
  const { toggleNewTaskDialog, setViewMode } = useUIStore()

  // 过滤出活跃会话(状态不是 completed 或 terminated)
  const activeSessions = sessions.filter(
    (session) => session.status !== 'completed' && session.status !== 'terminated'
  )

  const [cols, rows] = calculateGridLayout(activeSessions.length)

  // 处理最大化：切换到标签页视图
  const handleMaximize = (sessionId: string) => {
    selectSession(sessionId)
    setViewMode('tabs')
  }

  // 处理新建会话
  const handleNewSession = () => {
    toggleNewTaskDialog()
  }

  // 无会话时显示占位
  if (activeSessions.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <button
          onClick={handleNewSession}
          className="flex flex-col items-center gap-3 p-8 border-2 border-dashed border-gray-600 rounded-lg hover:border-gray-500 hover:bg-bg-secondary transition-colors group"
        >
          <Plus size={48} className="text-gray-600 group-hover:text-gray-500" />
          <span className="text-gray-500 text-lg">创建新会话</span>
        </button>
      </div>
    )
  }

  return (
    <div
      className="w-full h-full p-4 grid gap-4"
      style={{
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`,
      }}
    >
      {activeSessions.map((session) => (
        <TerminalPanel
          key={session.id}
          sessionId={session.id}
          onMaximize={() => handleMaximize(session.id)}
        />
      ))}

      {/* 空格子占位（用于未来扩展） */}
      {Array.from({ length: cols * rows - activeSessions.length }).map((_, index) => (
        <div
          key={`placeholder-${index}`}
          className="border-2 border-dashed border-gray-700 rounded-lg flex items-center justify-center cursor-pointer hover:border-gray-600 hover:bg-bg-secondary transition-colors group"
          onClick={handleNewSession}
        >
          <Plus size={32} className="text-gray-700 group-hover:text-gray-600" />
        </div>
      ))}
    </div>
  )
}

TerminalGrid.displayName = 'TerminalGrid'

export default TerminalGrid
