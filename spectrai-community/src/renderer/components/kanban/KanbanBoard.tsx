/**
 * 看板主组件
 * 管理任务拖拽和状态更新
 * @author weibin
 */

import React, { useEffect } from 'react'
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  DragStartEvent,
  DragEndEvent,
} from '@dnd-kit/core'
import { useTaskStore } from '../../stores/taskStore'
import { useSessionStore } from '../../stores/sessionStore'
import { KANBAN_COLUMNS } from '../../../shared/constants'
import KanbanColumn from './KanbanColumn'
import TaskCard from './TaskCard'
import { TaskStatus } from '../../../shared/types'

export default function KanbanBoard() {
  const { tasks, fetchTasks, updateTask } = useTaskStore()
  const { sessions } = useSessionStore()
  const [activeId, setActiveId] = React.useState<string | null>(null)

  // 加载任务
  useEffect(() => {
    fetchTasks()
  }, [fetchTasks])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  )

  const getTask = (id: string) => tasks.find(t => t.id === id)
  const getTasksByStatus = (status: TaskStatus) => tasks.filter(t => t.status === status)

  // 拖拽开始
  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string)
  }

  // 合法的列 ID 集合
  const validColumnIds = new Set(KANBAN_COLUMNS.map(c => c.id))

  // 拖拽结束
  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event

    if (!over) {
      setActiveId(null)
      return
    }

    const taskId = active.id as string
    let newStatus: TaskStatus

    if (validColumnIds.has(over.id as any)) {
      // 拖到了列上
      newStatus = over.id as TaskStatus
    } else {
      // 拖到了另一个任务卡片上，找出该卡片所在的列
      const overTask = getTask(over.id as string)
      if (!overTask) {
        setActiveId(null)
        return
      }
      newStatus = overTask.status
    }

    const task = getTask(taskId)
    if (!task || task.status === newStatus) {
      setActiveId(null)
      return
    }

    // 直接更新状态
    await updateTask(taskId, { status: newStatus })
    setActiveId(null)
  }

  // 获取正在拖拽的任务
  const activeTask = activeId ? getTask(activeId) : null

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-3 h-full p-3 overflow-x-auto">
        {KANBAN_COLUMNS.map((column) => {
          const columnTasks = getTasksByStatus(column.id as TaskStatus)
          return (
            <KanbanColumn
              key={column.id}
              column={column}
              tasks={columnTasks}
              sessions={sessions}
            />
          )
        })}
      </div>

      {/* 拖拽预览 */}
      <DragOverlay>
        {activeTask ? (
          <div className="opacity-80 rotate-3 scale-105">
            <TaskCard task={activeTask} sessions={sessions} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
