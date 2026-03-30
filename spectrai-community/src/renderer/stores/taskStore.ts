/**
 * 任务看板状态管理 Store
 * @author weibin
 */

import { create } from 'zustand'
import type { TaskCard, TaskStatus } from '../../shared/types'

interface TaskState {
  // 状态
  tasks: TaskCard[]

  // 方法
  fetchTasks: () => Promise<void>
  createTask: (task: Partial<TaskCard>) => Promise<void>
  updateTask: (id: string, updates: Partial<TaskCard>) => Promise<void>
  deleteTask: (id: string) => Promise<void>
  moveTask: (id: string, newStatus: TaskStatus) => Promise<void>
  copyTask: (taskId: string) => Promise<void>
  startSessionForTask: (taskId: string, config?: any) => Promise<{ success: boolean; sessionId?: string; reused?: boolean; error?: string }>
  initTaskListeners: () => void
  getTask: (id: string) => TaskCard | undefined
}

export const useTaskStore = create<TaskState>((set, get) => ({
  // 初始状态
  tasks: [],

  // 获取所有任务
  fetchTasks: async () => {
    try {
      const tasks = await window.spectrAI.task.getAll()
      set({ tasks })
    } catch (error) {
      console.error('Failed to fetch tasks:', error)
    }
  },

  // 创建新任务
  createTask: async (task: Partial<TaskCard>) => {
    try {
      await window.spectrAI.task.create(task)
      await get().fetchTasks()
    } catch (error) {
      console.error('Failed to create task:', error)
      throw error
    }
  },

  // 更新任务
  updateTask: async (id: string, updates: Partial<TaskCard>) => {
    try {
      await window.spectrAI.task.update(id, updates)
      await get().fetchTasks()
    } catch (error) {
      console.error('Failed to update task:', error)
      throw error
    }
  },

  // 删除任务
  deleteTask: async (id: string) => {
    try {
      await window.spectrAI.task.delete(id)
      await get().fetchTasks()
    } catch (error) {
      console.error('Failed to delete task:', error)
      throw error
    }
  },

  // 移动任务到新状态
  moveTask: async (id: string, newStatus: TaskStatus) => {
    try {
      await get().updateTask(id, { status: newStatus, updatedAt: new Date().toISOString() })
    } catch (error) {
      console.error('Failed to move task:', error)
      throw error
    }
  },

  // 复制任务（不复制 worktree 配置，避免分支冲突）
  copyTask: async (taskId: string) => {
    const task = get().tasks.find((t) => t.id === taskId)
    if (!task) return
    await get().createTask({
      title: `${task.title} (副本)`,
      description: task.description,
      priority: task.priority,
      tags: [...task.tags],
      status: 'todo',
      estimatedDuration: task.estimatedDuration,
      parentTaskId: task.parentTaskId,
    })
  },

  // 获取单个任务
  getTask: (id: string) => {
    return get().tasks.find((t) => t.id === id)
  },

  // 为任务启动关联会话
  startSessionForTask: async (taskId: string, config?: any) => {
    try {
      const result = await window.spectrAI.task.startSession(taskId, config)
      if (result.success) {
        // 刷新任务列表以反映状态变化
        await get().fetchTasks()
      }
      return result
    } catch (error: any) {
      console.error('Failed to start session for task:', error)
      return { success: false, error: error.message }
    }
  },

  // 初始化任务状态变更监听（主进程自动推送）
  initTaskListeners: () => {
    window.spectrAI.task.onStatusChange((taskId: string, updates: any) => {
      set((state) => ({
        tasks: state.tasks.map((task) =>
          task.id === taskId ? { ...task, ...updates, updatedAt: new Date().toISOString() } : task
        )
      }))
    })
  }
}))

export default useTaskStore
