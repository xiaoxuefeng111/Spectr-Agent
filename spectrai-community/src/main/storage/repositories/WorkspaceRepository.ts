/**
 * WorkspaceRepository - 工作区 CRUD 操作
 * 工作区是多个 git 仓库的命名集合，用于多仓库 worktree 隔离场景
 * @author weibin
 */

import { v4 as uuidv4 } from 'uuid'
import type { WorkspaceRow, WorkspaceRepoRow } from '../types'
import { parseDbTimestamp } from '../types'

export class WorkspaceRepository {
  /** 内存降级存储 */
  private memWorkspaces: Map<string, WorkspaceRow> = new Map()

  constructor(private db: any, private usingSqlite: boolean) {}

  // ---- 查询 ----

  getAllWorkspaces(): WorkspaceRow[] {
    if (this.usingSqlite) {
      const rows = this.db.prepare(
        'SELECT * FROM workspaces ORDER BY created_at DESC'
      ).all() as any[]
      return rows.map(row => this.mapWorkspace(row))
    }
    return Array.from(this.memWorkspaces.values())
  }

  getWorkspace(id: string): WorkspaceRow | undefined {
    if (this.usingSqlite) {
      const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as any
      return row ? this.mapWorkspace(row) : undefined
    }
    return this.memWorkspaces.get(id)
  }

  // ---- 创建 ----

  createWorkspace(
    workspace: Omit<WorkspaceRow, 'repos' | 'createdAt' | 'updatedAt'>,
    repos: Omit<WorkspaceRepoRow, 'workspaceId'>[]
  ): WorkspaceRow {
    const now = new Date()
    const fullWorkspace: WorkspaceRow = {
      ...workspace,
      repos: repos.map((r, i) => ({
        ...r,
        workspaceId: workspace.id,
        sortOrder: r.sortOrder ?? i,
      })),
      createdAt: now,
      updatedAt: now,
    }

    if (this.usingSqlite) {
      // 使用 transaction 保证原子性
      const insertWorkspace = this.db.prepare(`
        INSERT INTO workspaces (id, name, description, root_path, created_at, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `)
      const insertRepo = this.db.prepare(`
        INSERT INTO workspace_repos (id, workspace_id, repo_path, name, is_primary, sort_order)
        VALUES (?, ?, ?, ?, ?, ?)
      `)

      const doInsert = this.db.transaction(() => {
        insertWorkspace.run(
          workspace.id,
          workspace.name,
          workspace.description || null,
          workspace.rootPath || null
        )
        for (const repo of fullWorkspace.repos) {
          insertRepo.run(
            repo.id,
            workspace.id,
            repo.repoPath,
            repo.name,
            repo.isPrimary ? 1 : 0,
            repo.sortOrder
          )
        }
      })
      doInsert()
    }

    this.memWorkspaces.set(fullWorkspace.id, fullWorkspace)
    return fullWorkspace
  }

  // ---- 更新 ----

  updateWorkspace(
    id: string,
    updates: Partial<Pick<WorkspaceRow, 'name' | 'description' | 'rootPath'>>,
    repos?: Omit<WorkspaceRepoRow, 'workspaceId'>[]
  ): void {
    if (this.usingSqlite) {
      const fields: string[] = []
      const values: any[] = []

      if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name) }
      if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description || null) }
      if (updates.rootPath !== undefined) { fields.push('root_path = ?'); values.push(updates.rootPath || null) }
      fields.push('updated_at = CURRENT_TIMESTAMP')

      if (fields.length > 1 || repos !== undefined) {
        const doUpdate = this.db.transaction(() => {
          if (fields.length > 1) {
            values.push(id)
            this.db.prepare(`UPDATE workspaces SET ${fields.join(', ')} WHERE id = ?`).run(...values)
          }
          if (repos !== undefined) {
            // 全量替换仓库列表（DELETE + INSERT）
            this.db.prepare('DELETE FROM workspace_repos WHERE workspace_id = ?').run(id)
            const insertRepo = this.db.prepare(`
              INSERT INTO workspace_repos (id, workspace_id, repo_path, name, is_primary, sort_order)
              VALUES (?, ?, ?, ?, ?, ?)
            `)
            repos.forEach((repo, i) => {
              insertRepo.run(
                repo.id || uuidv4(),
                id,
                repo.repoPath,
                repo.name,
                repo.isPrimary ? 1 : 0,
                repo.sortOrder ?? i
              )
            })
          }
        })
        doUpdate()
      }
    }

    // 更新内存缓存
    const existing = this.memWorkspaces.get(id)
    if (existing) {
      const updated: WorkspaceRow = {
        ...existing,
        ...updates,
        updatedAt: new Date(),
      }
      if (repos !== undefined) {
        updated.repos = repos.map((r, i) => ({
          ...r,
          workspaceId: id,
          sortOrder: r.sortOrder ?? i,
        }))
      }
      this.memWorkspaces.set(id, updated)
    }
  }

  // ---- 删除 ----

  deleteWorkspace(id: string): void {
    if (this.usingSqlite) {
      // ON DELETE CASCADE 自动清理 workspace_repos
      this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
    }
    this.memWorkspaces.delete(id)
  }

  // ---- 私有：行映射 ----

  private mapWorkspace(row: any): WorkspaceRow {
    const repoRows = this.usingSqlite
      ? (this.db.prepare(
          'SELECT * FROM workspace_repos WHERE workspace_id = ? ORDER BY sort_order ASC'
        ).all(row.id) as any[])
      : []

    return {
      id: row.id,
      name: row.name,
      description: row.description || undefined,
      rootPath: row.root_path || undefined,
      repos: repoRows.map(r => this.mapRepo(r)),
      createdAt: parseDbTimestamp(row.created_at),
      updatedAt: parseDbTimestamp(row.updated_at),
    }
  }

  private mapRepo(row: any): WorkspaceRepoRow {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      repoPath: row.repo_path,
      name: row.name,
      isPrimary: row.is_primary === 1,
      sortOrder: row.sort_order,
    }
  }
}
