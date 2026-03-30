/**
 * 看板列组件
 * 显示特定状态的任务列表
 * @author weibin
 */

import React from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Circle, Play, Pause, CheckCircle } from 'lucide-react'
import { KanbanColumn as KanbanColumnType, TaskCard as TaskCardType, Session } from '../../../shared/types'
import TaskCard from './TaskCard'

// 图标名称 → 组件映射
const ICON_MAP: Record<string, typeof Circle> = {
  Circle,
  Play,
  Pause,
  CheckCircle,
}

interface KanbanColumnProps {
  column: KanbanColumnType
  tasks: TaskCardType[]
  sessions?: Session[]
}

const KanbanColumn: React.FC<KanbanColumnProps> = ({ column, tasks, sessions = [] }) => {
  const { setNodeRef, isOver } = useDroppable({
    id: column.id,
  })

  const Icon = ICON_MAP[column.icon] || Circle

  return (
    <div
      ref={setNodeRef}
      className={`
        bg-bg-secondary rounded-lg p-3 flex flex-col h-full min-w-[240px] flex-1
        transition-all duration-200
        ${isOver ? 'ring-2 ring-blue-500 bg-bg-tertiary' : ''}
      `}
    >
      {/* 列标题 */}
      <div className="flex items-center gap-2 mb-3 pb-2 border-b border-border">
        <Icon size={16} className="text-gray-400" />
        <h2 className="text-sm font-semibold text-gray-300">{column.title}</h2>
        <span className="text-xs text-gray-500 bg-bg-tertiary px-2 py-0.5 rounded-full">
          {tasks.length}
        </span>
      </div>

      {/* 任务列表 */}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <SortableContext
          items={tasks.map((task) => task.id)}
          strategy={verticalListSortingStrategy}
        >
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} sessions={sessions} />
          ))}
        </SortableContext>

        {/* 空状态 */}
        {tasks.length === 0 && (
          <div className="flex items-center justify-center h-32 text-gray-600 text-sm">
            暂无任务
          </div>
        )}
      </div>
    </div>
  )
}

export default KanbanColumn
