/**
 * TaskRepository - Tasks 相关数据库操作
 */
import type { Task } from '../types'
import { parseDbTimestamp } from '../types'

export class TaskRepository {
  private memTasks: Map<string, Task> = new Map()

  constructor(private db: any, private usingSqlite: boolean) {}

  createTask(task: Partial<Task> & { id: string; title: string }): Task {
    const now = new Date()
    const fullTask: Task = {
      id: task.id,
      title: task.title,
      description: task.description || '',
      status: task.status || 'todo',
      priority: task.priority || 'medium',
      tags: task.tags || [],
      parentTaskId: task.parentTaskId,
      worktreeEnabled: task.worktreeEnabled || false,
      gitRepoPath: task.gitRepoPath,
      gitBranch: task.gitBranch,
      worktreePath: task.worktreePath,
      workspaceId: task.workspaceId,
      worktreePaths: task.worktreePaths,
      createdAt: now,
      updatedAt: now
    }

    if (this.usingSqlite) {
      this.db.prepare(`
        INSERT INTO tasks (id, title, description, status, priority, tags, parent_task_id, worktree_enabled, git_repo_path, git_branch, worktree_path, workspace_id, worktree_paths)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        fullTask.id, fullTask.title, fullTask.description,
        fullTask.status, fullTask.priority,
        fullTask.tags ? JSON.stringify(fullTask.tags) : null,
        fullTask.parentTaskId || null,
        fullTask.worktreeEnabled ? 1 : 0,
        fullTask.gitRepoPath || null,
        fullTask.gitBranch || null,
        fullTask.worktreePath || null,
        fullTask.workspaceId || null,
        fullTask.worktreePaths ? JSON.stringify(fullTask.worktreePaths) : null
      )
    }

    this.memTasks.set(fullTask.id, fullTask)
    return fullTask
  }

  getTask(id: string): Task | undefined {
    if (this.usingSqlite) {
      const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any
      return row ? this.mapTask(row) : undefined
    }
    return this.memTasks.get(id)
  }

  getAllTasks(): Task[] {
    if (this.usingSqlite) {
      const rows = this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as any[]
      return rows.map(row => this.mapTask(row))
    }
    return Array.from(this.memTasks.values())
  }

  updateTask(id: string, updates: Partial<Task>): void {
    if (this.usingSqlite) {
      const fields: string[] = []
      const values: any[] = []

      if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title) }
      if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description) }
      if (updates.status !== undefined) {
        fields.push('status = ?'); values.push(updates.status)
        if (updates.status === 'done') {
          fields.push('completed_at = ?'); values.push(new Date().toISOString())
        }
      }
      if (updates.priority !== undefined) { fields.push('priority = ?'); values.push(updates.priority) }
      if (updates.tags !== undefined) { fields.push('tags = ?'); values.push(JSON.stringify(updates.tags)) }
      if (updates.worktreeEnabled !== undefined) { fields.push('worktree_enabled = ?'); values.push(updates.worktreeEnabled ? 1 : 0) }
      if (updates.gitRepoPath !== undefined) { fields.push('git_repo_path = ?'); values.push(updates.gitRepoPath || null) }
      if (updates.gitBranch !== undefined) { fields.push('git_branch = ?'); values.push(updates.gitBranch || null) }
      if (updates.worktreePath !== undefined) { fields.push('worktree_path = ?'); values.push(updates.worktreePath || null) }
      if (updates.workspaceId !== undefined) { fields.push('workspace_id = ?'); values.push(updates.workspaceId || null) }
      if (updates.worktreePaths !== undefined) { fields.push('worktree_paths = ?'); values.push(updates.worktreePaths ? JSON.stringify(updates.worktreePaths) : null) }

      if (fields.length > 0) {
        values.push(id)
        this.db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values)
      }
    }

    const existing = this.memTasks.get(id)
    if (existing) {
      this.memTasks.set(id, { ...existing, ...updates, updatedAt: new Date() })
    }
  }

  deleteTask(id: string): void {
    if (this.usingSqlite) {
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
    }
    this.memTasks.delete(id)
  }

  private mapTask(row: any): Task {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      tags: row.tags ? JSON.parse(row.tags) : [],
      parentTaskId: row.parent_task_id,
      worktreeEnabled: row.worktree_enabled === 1,
      gitRepoPath: row.git_repo_path || undefined,
      gitBranch: row.git_branch || undefined,
      worktreePath: row.worktree_path || undefined,
      workspaceId: row.workspace_id || undefined,
      worktreePaths: row.worktree_paths ? JSON.parse(row.worktree_paths) : undefined,
      createdAt: parseDbTimestamp(row.created_at),
      updatedAt: parseDbTimestamp(row.updated_at),
      completedAt: row.completed_at ? parseDbTimestamp(row.completed_at) : undefined
    }
  }
}
