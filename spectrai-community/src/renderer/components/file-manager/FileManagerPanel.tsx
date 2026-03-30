/**
 * 文件管理器主面板
 * - 普通会话：显示单项目文件树
 * - 工作区会话：显示工作区内全部仓库文件树
 */

import { useEffect, useMemo, useState } from 'react'
import { Folder, RefreshCw, Link, Link2Off, Loader2, AlertCircle } from 'lucide-react'
import { useFileManagerStore } from '../../stores/fileManagerStore'
import { useSessionStore } from '../../stores/sessionStore'
import FileTree from './FileTree'
import SessionChangedFiles from './SessionChangedFiles'

function getDirName(fullPath: string): string {
  const normalized = fullPath.replace(/\\/g, '/')
  const parts = normalized.split('/')
  const lastPart = parts.filter(Boolean).pop()
  return lastPart || fullPath
}

export default function FileManagerPanel() {
  const {
    currentDir,
    autoFollowSession,
    isLoading,
    error,
    setCurrentDir,
    refreshCurrentDir,
    refreshDir,
    ensureDirLoaded,
    setAutoFollowSession,
    handleWatchChange,
    sessionChangedFiles,
    fetchSessionFiles,
    openFileInTab,
  } = useFileManagerStore()

  const { selectedSessionId, sessions } = useSessionStore()
  const [workspaceName, setWorkspaceName] = useState<string | null>(null)
  const [workspaceRoots, setWorkspaceRoots] = useState<Array<{ path: string; name: string; isPrimary: boolean }>>([])

  const changedFiles = selectedSessionId ? (sessionChangedFiles.get(selectedSessionId) ?? []) : []

  const activeRoots = useMemo(
    () => (workspaceRoots.length > 0 ? workspaceRoots.map(r => r.path) : (currentDir ? [currentDir] : [])),
    [workspaceRoots, currentDir]
  )

  // 自动跟随当前会话工作目录
  useEffect(() => {
    if (!autoFollowSession || !selectedSessionId) return
    const session = sessions.find((s) => s.id === selectedSessionId)
    const workDir = session?.config?.workingDirectory
    if (workDir && workDir !== currentDir) {
      setCurrentDir(workDir)
    }
  }, [selectedSessionId, sessions, autoFollowSession, currentDir, setCurrentDir])

  // 工作区模式：加载 workspace 下所有 repo 作为根节点
  useEffect(() => {
    let cancelled = false

    const loadWorkspaceRoots = async () => {
      if (!selectedSessionId) {
        setWorkspaceName(null)
        setWorkspaceRoots([])
        return
      }

      const session = sessions.find((s) => s.id === selectedSessionId)
      const workspaceId = session?.config?.workspaceId
      if (!workspaceId) {
        setWorkspaceName(null)
        setWorkspaceRoots([])
        return
      }

      try {
        const ws = await window.spectrAI.workspace.get(workspaceId)
        if (cancelled || !ws) return
        const repos = Array.isArray(ws.repos) ? ws.repos : []
        const roots: Array<{ path: string; name: string; isPrimary: boolean }> = repos.map((r: any) => ({
          path: r.repoPath,
          name: r.name || getDirName(r.repoPath),
          isPrimary: !!r.isPrimary,
        }))
        setWorkspaceName(ws.name || null)
        setWorkspaceRoots(roots)
        await Promise.all(roots.map((r) => ensureDirLoaded(r.path)))
      } catch {
        if (!cancelled) {
          setWorkspaceName(null)
          setWorkspaceRoots([])
        }
      }
    }

    loadWorkspaceRoots()
    return () => { cancelled = true }
  }, [selectedSessionId, sessions, ensureDirLoaded])

  // 监听目录变化（workspace 下监听多个根）
  useEffect(() => {
    if (activeRoots.length === 0) return

    activeRoots.forEach((root) => (window as any).spectrAI?.fileManager?.watchDir(root))
    const cleanup = (window as any).spectrAI?.fileManager?.onWatchChange(
      (event: { dirPath: string }) => {
        handleWatchChange(event)
      }
    )

    return () => {
      activeRoots.forEach((root) => (window as any).spectrAI?.fileManager?.unwatchDir(root))
      if (typeof cleanup === 'function') cleanup()
    }
  }, [activeRoots, handleWatchChange])

  // 监听会话文件变更推送
  useEffect(() => {
    const cleanup = (window as any).spectrAI?.fileManager?.onSessionFilesUpdated?.(
      (data: { sessionId: string; files: any[] }) => {
        useFileManagerStore.setState(state => {
          const newMap = new Map(state.sessionChangedFiles)
          const existing = state.sessionChangedFiles.get(data.sessionId) ?? []
          // 用 filePath 作为 key 去重合并，新改动覆盖旧记录
          const merged = new Map(existing.map((f: any) => [f.filePath, f]))
          for (const f of data.files) {
            merged.set(f.filePath, f)
          }
          newMap.set(data.sessionId, Array.from(merged.values()))
          return { sessionChangedFiles: newMap }
        })
      }
    )
    return () => cleanup?.()
  }, [])

  useEffect(() => {
    if (selectedSessionId) fetchSessionFiles(selectedSessionId)
  }, [selectedSessionId, fetchSessionFiles])

  const title = workspaceName || (currentDir ? getDirName(currentDir) : null)

  return (
    <div className="flex flex-col h-full bg-bg-primary">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-1.5 min-w-0 flex-1" title={currentDir ?? '未选择目录'}>
          <Folder className="w-3.5 h-3.5 text-accent-yellow flex-shrink-0" />
          <div className="flex flex-col min-w-0">
            <span className="text-xs font-medium text-text-secondary uppercase tracking-wide truncate">
              {title ?? '文件管理器'}
            </span>
            {currentDir && (
              <span className="text-[10px] text-text-muted truncate leading-tight" title={currentDir}>
                {currentDir}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={() => setAutoFollowSession(!autoFollowSession)}
            title={autoFollowSession ? '已跟随会话目录（点击关闭）' : '点击跟随当前会话目录'}
            className={[
              'p-1 rounded btn-transition',
              autoFollowSession
                ? 'text-accent-blue hover:bg-bg-hover'
                : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover',
            ].join(' ')}
          >
            {autoFollowSession ? <Link className="w-3.5 h-3.5" /> : <Link2Off className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={async () => {
              if (workspaceRoots.length > 0) {
                await Promise.all(workspaceRoots.map((r) => refreshDir(r.path)))
              } else {
                await refreshCurrentDir()
              }
            }}
            disabled={activeRoots.length === 0 || isLoading}
            title="刷新目录"
            className={[
              'p-1 rounded btn-transition',
              activeRoots.length > 0 && !isLoading
                ? 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                : 'text-text-muted cursor-not-allowed',
            ].join(' ')}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <SessionChangedFiles files={changedFiles as any} onOpenFile={openFileInTab} />

      <div className="flex-1 min-h-0 overflow-hidden">
        {activeRoots.length === 0 && (
          <div className="flex items-center justify-center h-full p-6 text-center">
            <div>
              <Folder className="w-8 h-8 text-text-muted mx-auto mb-2" />
              <p className="text-xs text-text-secondary">选择一个会话以浏览其工作目录</p>
            </div>
          </div>
        )}

        {activeRoots.length > 0 && error && (
          <div className="flex items-start gap-2 m-3 p-2.5 rounded-lg bg-red-500/10 border border-red-500/30">
            <AlertCircle className="w-4 h-4 text-accent-red flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-xs text-accent-red font-medium">加载失败</p>
              <p className="text-[11px] text-accent-red opacity-75 mt-0.5 break-all">{error}</p>
            </div>
          </div>
        )}

        {activeRoots.length > 0 && isLoading && !error && (
          <div className="flex items-center justify-center h-full gap-2 text-text-secondary">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-xs">加载中...</span>
          </div>
        )}

        {activeRoots.length > 0 && !isLoading && !error && (
          workspaceRoots.length > 0 ? (
            <div className="h-full overflow-y-auto px-1 py-1">
              {workspaceRoots.map((repo) => (
                <div key={repo.path} className="mb-2 border border-border rounded">
                  <div className="px-2 py-1 text-[11px] text-text-secondary border-b border-border flex items-center gap-1">
                    {repo.isPrimary && <span className="text-accent-blue">★</span>}
                    <span className="truncate" title={repo.path}>{repo.name}</span>
                  </div>
                  <FileTree rootPath={repo.path} className="py-1" scrollable={false} />
                </div>
              ))}
            </div>
          ) : (
            <FileTree rootPath={currentDir!} className="h-full py-1" scrollable />
          )
        )}
      </div>
    </div>
  )
}
