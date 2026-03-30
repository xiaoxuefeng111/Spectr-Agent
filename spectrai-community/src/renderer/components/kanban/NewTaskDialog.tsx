/**
 * 新建任务对话框组件
 * @author weibin
 */

import { useState } from 'react'
import { X, FolderOpen } from 'lucide-react'
import { useTaskStore } from '../../stores/taskStore'
import { useUIStore } from '../../stores/uiStore'
import type { TaskPriority } from '../../../shared/types'

export default function NewTaskDialog() {
  const { createTask } = useTaskStore()
  const { showNewTaskDialog, toggleNewTaskDialog } = useUIStore()

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [tags, setTags] = useState('')

  if (!showNewTaskDialog) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!title.trim()) return

    const tagList = tags
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean)

    try {
      await createTask({
        title: title.trim(),
        description: description.trim(),
        priority,
        tags: tagList,
        status: 'todo'
      })
      handleClose()
    } catch (error) {
      console.error('Failed to create task:', error)
    }
  }

  const handleClose = () => {
    setTitle('')
    setDescription('')
    setPriority('medium')
    setTags('')
    toggleNewTaskDialog()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-bg-secondary rounded-lg shadow-2xl w-full max-w-md border border-border">
        {/* 标题 */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">新建任务</h2>
          <button
            onClick={handleClose}
            className="text-text-muted hover:text-text-primary btn-transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 表单 */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              标题 <span className="text-accent-red">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="输入任务标题"
              className="w-full px-3 py-2 bg-bg-primary border border-border rounded text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-blue"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">描述</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="输入任务描述（可选）"
              rows={3}
              className="w-full px-3 py-2 bg-bg-primary border border-border rounded text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-blue resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">优先级</label>
            <select
              value={priority}
              onChange={e => setPriority(e.target.value as TaskPriority)}
              className="w-full px-3 py-2 bg-bg-primary border border-border rounded text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-blue"
            >
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">标签</label>
            <input
              type="text"
              value={tags}
              onChange={e => setTags(e.target.value)}
              placeholder="用逗号分隔（如: bug, frontend, urgent）"
              className="w-full px-3 py-2 bg-bg-primary border border-border rounded text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-blue"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={!title.trim()}
              className="flex-1 px-4 py-2 bg-accent-blue text-white rounded font-medium btn-transition hover:bg-opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              创建
            </button>
            <button
              type="button"
              onClick={handleClose}
              className="px-4 py-2 bg-bg-hover hover:bg-bg-tertiary text-text-secondary rounded font-medium btn-transition"
            >
              取消
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
