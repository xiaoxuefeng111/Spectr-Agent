/**
 * 文件树组件
 * 递归渲染目录树结构，集成右键菜单、内联重命名和新建文件/文件夹
 * @author weibin
 */

import { useCallback, useMemo, useState, useRef, useEffect } from 'react'
import {
  Loader2, FilePlus, FolderPlus, Pencil, Trash2,
  Copy, ClipboardCopy, FolderOpen, ExternalLink, RefreshCw, Terminal,
} from 'lucide-react'
import { useFileManagerStore } from '../../stores/fileManagerStore'
import { useSessionStore } from '../../stores/sessionStore'
import FileTreeNode from './FileTreeNode'
import ContextMenu from '../common/ContextMenu'
import type { MenuItem } from '../common/ContextMenu'
import type { FileEntry } from '../../../shared/fileManagerTypes'

// ─────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────

interface FileTreeProps {
  rootPath: string
  className?: string
  scrollable?: boolean
}

/** 右键菜单状态 */
interface CtxMenuState {
  visible: boolean
  x: number
  y: number
  entry: FileEntry | null
}

/** 新建输入状态 */
interface NewEntryState {
  /** 在哪个目录下新建 */
  parentDir: string
  /** 新建类型 */
  type: 'file' | 'directory'
}

const fileManagerApi = () => (window as any).spectrAI?.fileManager

// ─────────────────────────────────────────────────────────
// 新建条目输入框组件
// ─────────────────────────────────────────────────────────

interface NewEntryInputProps {
  depth: number
  type: 'file' | 'directory'
  onConfirm: (name: string) => void
  onCancel: () => void
}

function NewEntryInput({ depth, type, onConfirm, onCancel }: NewEntryInputProps) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const trimmed = value.trim()
      if (trimmed) onConfirm(trimmed)
      else onCancel()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  const handleBlur = () => {
    const trimmed = value.trim()
    if (trimmed) onConfirm(trimmed)
    else onCancel()
  }

  const paddingLeft = depth * 12 + 8
  const IconComp = type === 'directory' ? FolderPlus : FilePlus

  return (
    <div
      className="flex items-center gap-1 py-0.5 px-1"
      style={{ paddingLeft }}
    >
      <span className="w-3 flex-shrink-0" />
      <IconComp className="w-3.5 h-3.5 flex-shrink-0 text-accent-blue" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder={type === 'directory' ? '文件夹名称' : '文件名称'}
        onChange={e => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        className="flex-1 min-w-0 bg-bg-primary border border-accent-blue rounded px-1 py-0 text-xs
                   text-text-primary outline-none focus:ring-1 focus:ring-accent-blue/50"
        style={{ height: 20 }}
      />
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// 工具：递归节点列表渲染
// ─────────────────────────────────────────────────────────

interface RenderNodesOptions {
  entries: FileEntry[]
  depth: number
  expandedDirs: Set<string>
  dirCache: Map<string, FileEntry[]>
  selectedPath: string | null
  changedPaths: Set<string>
  renamingPath: string | null
  newEntry: NewEntryState | null
  onToggle: (path: string) => void
  onSelect: (path: string) => void
  onOpen: (entry: FileEntry) => void
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void
  onRenameConfirm: (entry: FileEntry, newName: string) => void
  onRenameCancel: () => void
  onNewEntryConfirm: (name: string) => void
  onNewEntryCancel: () => void
}

function RenderNodes({
  entries,
  depth,
  expandedDirs,
  dirCache,
  selectedPath,
  changedPaths,
  renamingPath,
  newEntry,
  onToggle,
  onSelect,
  onOpen,
  onContextMenu,
  onRenameConfirm,
  onRenameCancel,
  onNewEntryConfirm,
  onNewEntryCancel,
}: RenderNodesOptions) {
  if (entries.length === 0 && !newEntry) {
    return (
      <div
        className="py-1 text-[11px] text-text-muted italic"
        style={{ paddingLeft: depth * 12 + 20 }}
      >
        空文件夹
      </div>
    )
  }

  return (
    <>
      {/* 新建输入框：放在目录内容顶部 */}
      {newEntry && (
        <NewEntryInput
          depth={depth}
          type={newEntry.type}
          onConfirm={onNewEntryConfirm}
          onCancel={onNewEntryCancel}
        />
      )}

      {entries.map((entry) => {
        const isExpanded = expandedDirs.has(entry.path)
        const isSelected = selectedPath === entry.path
        const isDir = entry.type === 'directory'
        const isRenaming = renamingPath === entry.path

        return (
          <div key={entry.path}>
            <FileTreeNode
              entry={entry}
              depth={depth}
              isExpanded={isExpanded}
              isSelected={isSelected}
              isChangedBySession={changedPaths.has(entry.path)}
              isRenaming={isRenaming}
              onToggle={isDir ? () => onToggle(entry.path) : undefined}
              onSelect={() => onSelect(entry.path)}
              onOpen={() => onOpen(entry)}
              onContextMenu={(e) => onContextMenu(e, entry)}
              onRenameConfirm={(newName) => onRenameConfirm(entry, newName)}
              onRenameCancel={onRenameCancel}
            />

            {/* 目录已展开时递归渲染子项 */}
            {isDir && isExpanded && (() => {
              const children = dirCache.get(entry.path)

              // 尚未加载子目录内容 → 显示加载中
              if (!children) {
                return (
                  <div
                    className="flex items-center gap-1.5 py-1 text-[11px] text-text-muted"
                    style={{ paddingLeft: (depth + 1) * 12 + 8 }}
                  >
                    <Loader2 className="w-3 h-3 animate-spin" />
                    加载中...
                  </div>
                )
              }

              // 判断是否在该目录下新建
              const childNewEntry = newEntry && newEntry.parentDir === entry.path ? newEntry : null

              // 子目录内容已加载 → 递归渲染
              return (
                <RenderNodes
                  entries={children}
                  depth={depth + 1}
                  expandedDirs={expandedDirs}
                  dirCache={dirCache}
                  selectedPath={selectedPath}
                  changedPaths={changedPaths}
                  renamingPath={renamingPath}
                  newEntry={childNewEntry}
                  onToggle={onToggle}
                  onSelect={onSelect}
                  onOpen={onOpen}
                  onContextMenu={onContextMenu}
                  onRenameConfirm={onRenameConfirm}
                  onRenameCancel={onRenameCancel}
                  onNewEntryConfirm={onNewEntryConfirm}
                  onNewEntryCancel={onNewEntryCancel}
                />
              )
            })()}
          </div>
        )
      })}
    </>
  )
}

// ─────────────────────────────────────────────────────────
// 主组件
// ─────────────────────────────────────────────────────────

export default function FileTree({ rootPath, className = '', scrollable = true }: FileTreeProps) {
  const {
    expandedDirs,
    dirCache,
    selectedPath,
    toggleDir,
    setSelectedPath,
    getChangedPathsForSession,
    sessionChangedFiles,
    refreshDir,
    reloadSingleDir,
  } = useFileManagerStore()

  const selectedSessionId = useSessionStore(s => s.selectedSessionId)

  // 计算当前会话改动的文件路径集合（用于文件树高亮）
  const changedPaths = useMemo(
    () => getChangedPathsForSession(selectedSessionId ?? ''),
    [getChangedPathsForSession, selectedSessionId, sessionChangedFiles]
  )

  const rootEntries = dirCache.get(rootPath)

  // ── 右键菜单状态 ────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState>({
    visible: false, x: 0, y: 0, entry: null,
  })

  // ── 内联重命名状态 ──────────────────────────────────────
  const [renamingPath, setRenamingPath] = useState<string | null>(null)

  // ── 新建输入状态 ────────────────────────────────────────
  const [newEntry, setNewEntry] = useState<NewEntryState | null>(null)

  // ── 删除确认弹窗 ───────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null)

  // ─── 回调 ──────────────────────────────────────────────

  const handleToggle = useCallback(
    (path: string) => { toggleDir(path) },
    [toggleDir]
  )

  const handleSelect = useCallback(
    (path: string) => { setSelectedPath(path) },
    [setSelectedPath]
  )

  const handleOpen = useCallback(
    (entry: FileEntry) => {
      if (entry.type === 'directory') {
        toggleDir(entry.path)
      } else {
        fileManagerApi()?.openPath(entry.path)
      }
    },
    [toggleDir]
  )

  // ── 右键菜单触发 ───────────────────────────────────────

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, entry: FileEntry) => {
      setCtxMenu({ visible: true, x: e.clientX, y: e.clientY, entry })
    },
    []
  )

  const closeCtxMenu = useCallback(() => {
    setCtxMenu(s => ({ ...s, visible: false }))
  }, [])

  // ── 背景右键菜单（空白区域） ────────────────────────────
  const handleBgContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      // 只在空白区域触发时处理（不和节点的冲突）
      if (e.target === e.currentTarget || (e.target as HTMLElement).closest('[data-filetree-bg]')) {
        // 构造一个虚拟的"根目录"entry
        const rootEntry: FileEntry = {
          name: rootPath.split(/[\\/]/).pop() || rootPath,
          path: rootPath,
          type: 'directory',
        }
        setCtxMenu({ visible: true, x: e.clientX, y: e.clientY, entry: rootEntry })
      }
    },
    [rootPath]
  )

  // ── 右键菜单操作 ───────────────────────────────────────

  /** 获取目标目录路径：如果选中的是文件，取其父目录 */
  const getTargetDir = (entry: FileEntry): string => {
    if (entry.type === 'directory') return entry.path
    // 文件取父目录
    const sep = entry.path.includes('/') ? '/' : '\\'
    return entry.path.substring(0, entry.path.lastIndexOf(sep))
  }

  const handleNewFile = useCallback((entry: FileEntry) => {
    const parentDir = getTargetDir(entry)
    // 确保目录已展开
    if (!expandedDirs.has(parentDir)) {
      toggleDir(parentDir)
    }
    setNewEntry({ parentDir, type: 'file' })
    closeCtxMenu()
  }, [expandedDirs, toggleDir, closeCtxMenu])

  const handleNewFolder = useCallback((entry: FileEntry) => {
    const parentDir = getTargetDir(entry)
    if (!expandedDirs.has(parentDir)) {
      toggleDir(parentDir)
    }
    setNewEntry({ parentDir, type: 'directory' })
    closeCtxMenu()
  }, [expandedDirs, toggleDir, closeCtxMenu])

  const handleRenameStart = useCallback((entry: FileEntry) => {
    setRenamingPath(entry.path)
    closeCtxMenu()
  }, [closeCtxMenu])

  const handleDeleteRequest = useCallback((entry: FileEntry) => {
    setDeleteTarget(entry)
    closeCtxMenu()
  }, [closeCtxMenu])

  const handleCopyName = useCallback((entry: FileEntry) => {
    navigator.clipboard.writeText(entry.name)
    closeCtxMenu()
  }, [closeCtxMenu])

  const handleCopyPath = useCallback((entry: FileEntry) => {
    navigator.clipboard.writeText(entry.path)
    closeCtxMenu()
  }, [closeCtxMenu])

  const handleCopyRelativePath = useCallback((entry: FileEntry) => {
    // 计算相对于 rootPath 的路径
    let rel = entry.path
    if (entry.path.startsWith(rootPath)) {
      rel = entry.path.substring(rootPath.length)
      if (rel.startsWith('/') || rel.startsWith('\\')) rel = rel.substring(1)
    }
    navigator.clipboard.writeText(rel.replace(/\\/g, '/'))
    closeCtxMenu()
  }, [rootPath, closeCtxMenu])

  const handleShowInFolder = useCallback((entry: FileEntry) => {
    fileManagerApi()?.showInFolder(entry.path)
    closeCtxMenu()
  }, [closeCtxMenu])

  const handleOpenInTerminal = useCallback((entry: FileEntry) => {
    const dir = getTargetDir(entry)
    // 通过 Electron 打开终端
    const isWin = navigator.platform.startsWith('Win')
    if (isWin) {
      ;(window as any).spectrAI?.fileManager?.openPath(dir)
    }
    closeCtxMenu()
  }, [closeCtxMenu])

  const handleRefreshDir = useCallback((entry: FileEntry) => {
    const dir = getTargetDir(entry)
    refreshDir(dir)
    closeCtxMenu()
  }, [refreshDir, closeCtxMenu])

  const handleOpenWithSystem = useCallback((entry: FileEntry) => {
    fileManagerApi()?.openPath(entry.path)
    closeCtxMenu()
  }, [closeCtxMenu])

  // ── 内联重命名确认 ─────────────────────────────────────

  const handleRenameConfirm = useCallback(
    async (entry: FileEntry, newName: string) => {
      const sep = entry.path.includes('/') ? '/' : '\\'
      const parentDir = entry.path.substring(0, entry.path.lastIndexOf(sep))
      const newPath = parentDir + sep + newName

      const result = await fileManagerApi()?.rename(entry.path, newPath)
      if (result?.success) {
        // 仅刷新父目录列表（不清除子目录缓存）
        await reloadSingleDir(parentDir)
      } else {
        console.error('重命名失败:', result?.error)
      }
      setRenamingPath(null)
    },
    [reloadSingleDir]
  )

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(null)
  }, [])

  // ── 新建条目确认 ───────────────────────────────────────

  const handleNewEntryConfirm = useCallback(
    async (name: string) => {
      if (!newEntry) return
      const sep = newEntry.parentDir.includes('/') ? '/' : '\\'
      const fullPath = newEntry.parentDir + sep + name

      const api = fileManagerApi()
      let result: any
      if (newEntry.type === 'directory') {
        result = await api?.createDir(fullPath)
      } else {
        result = await api?.createFile(fullPath)
      }

      if (result?.success) {
        // 仅刷新父目录列表（不清除子目录缓存）
        await reloadSingleDir(newEntry.parentDir)
        // 如果是文件，自动打开
        if (newEntry.type === 'file') {
          const { useFileManagerStore: store } = await import('../../stores/fileManagerStore')
          store.getState().openFileInTab(fullPath)
        }
      } else {
        console.error('新建失败:', result?.error)
      }
      setNewEntry(null)
    },
    [newEntry, reloadSingleDir]
  )

  const handleNewEntryCancel = useCallback(() => {
    setNewEntry(null)
  }, [])

  // ── 删除确认 ───────────────────────────────────────────

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return
    const result = await fileManagerApi()?.delete(deleteTarget.path)
    if (result?.success) {
      const sep = deleteTarget.path.includes('/') ? '/' : '\\'
      const parentDir = deleteTarget.path.substring(0, deleteTarget.path.lastIndexOf(sep))
      // 仅刷新父目录列表，不清除子目录缓存（避免展开的子目录变成"加载中"）
      await reloadSingleDir(parentDir)
      // 如果删除的是当前选中项，清除选中状态
      if (selectedPath === deleteTarget.path || selectedPath?.startsWith(deleteTarget.path + sep)) {
        setSelectedPath(null)
      }
    } else {
      console.error('删除失败:', result?.error)
    }
    setDeleteTarget(null)
  }, [deleteTarget, reloadSingleDir, selectedPath, setSelectedPath])

  const handleDeleteCancel = useCallback(() => {
    setDeleteTarget(null)
  }, [])

  // ── 构建右键菜单项 ────────────────────────────────────

  const ctxMenuItems: MenuItem[] = useMemo(() => {
    const entry = ctxMenu.entry
    if (!entry) return []

    const isDir = entry.type === 'directory'
    const items: MenuItem[] = []

    // 新建操作
    items.push(
      {
        key: 'new-file',
        label: '新建文件',
        icon: <FilePlus className="w-3.5 h-3.5" />,
        onClick: () => handleNewFile(entry),
      },
      {
        key: 'new-folder',
        label: '新建文件夹',
        icon: <FolderPlus className="w-3.5 h-3.5" />,
        onClick: () => handleNewFolder(entry),
      },
    )

    items.push({ key: 'div-1', type: 'divider' })

    // 编辑操作
    items.push(
      {
        key: 'rename',
        label: '重命名',
        icon: <Pencil className="w-3.5 h-3.5" />,
        shortcut: 'F2',
        onClick: () => handleRenameStart(entry),
      },
      {
        key: 'delete',
        label: '删除',
        icon: <Trash2 className="w-3.5 h-3.5" />,
        danger: true,
        onClick: () => handleDeleteRequest(entry),
      },
    )

    items.push({ key: 'div-2', type: 'divider' })

    // 复制操作
    items.push(
      {
        key: 'copy-name',
        label: '复制名称',
        icon: <Copy className="w-3.5 h-3.5" />,
        onClick: () => handleCopyName(entry),
      },
      {
        key: 'copy-rel-path',
        label: '复制相对路径',
        icon: <ClipboardCopy className="w-3.5 h-3.5" />,
        onClick: () => handleCopyRelativePath(entry),
      },
      {
        key: 'copy-abs-path',
        label: '复制绝对路径',
        icon: <ClipboardCopy className="w-3.5 h-3.5" />,
        onClick: () => handleCopyPath(entry),
      },
    )

    items.push({ key: 'div-3', type: 'divider' })

    // 外部操作
    items.push(
      {
        key: 'show-in-folder',
        label: '在资源管理器中显示',
        icon: <FolderOpen className="w-3.5 h-3.5" />,
        onClick: () => handleShowInFolder(entry),
      },
    )

    if (!isDir) {
      items.push({
        key: 'open-with-system',
        label: '用系统程序打开',
        icon: <ExternalLink className="w-3.5 h-3.5" />,
        onClick: () => handleOpenWithSystem(entry),
      })
    }

    items.push({ key: 'div-4', type: 'divider' })

    // 刷新
    items.push({
      key: 'refresh',
      label: '刷新',
      icon: <RefreshCw className="w-3.5 h-3.5" />,
      onClick: () => handleRefreshDir(entry),
    })

    return items
  }, [
    ctxMenu.entry,
    handleNewFile, handleNewFolder, handleRenameStart, handleDeleteRequest,
    handleCopyName, handleCopyRelativePath, handleCopyPath,
    handleShowInFolder, handleOpenWithSystem, handleRefreshDir,
  ])

  // ── 键盘快捷键 ─────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const handleKeyDown = (e: KeyboardEvent) => {
      // F2 → 重命名当前选中项
      if (e.key === 'F2' && selectedPath && !renamingPath && !newEntry) {
        e.preventDefault()
        setRenamingPath(selectedPath)
      }
      // Delete → 删除当前选中项
      if (e.key === 'Delete' && selectedPath && !renamingPath && !newEntry) {
        e.preventDefault()
        const entries = dirCache.get(rootPath)
        // 递归查找选中的 entry
        const findEntry = (list: FileEntry[] | undefined, target: string): FileEntry | null => {
          if (!list) return null
          for (const entry of list) {
            if (entry.path === target) return entry
            if (entry.type === 'directory') {
              const found = findEntry(dirCache.get(entry.path), target)
              if (found) return found
            }
          }
          return null
        }
        const entry = findEntry(entries, selectedPath)
        if (entry) setDeleteTarget(entry)
      }
    }

    el.addEventListener('keydown', handleKeyDown)
    return () => el.removeEventListener('keydown', handleKeyDown)
  }, [selectedPath, renamingPath, newEntry, dirCache, rootPath])

  // ── 加载兜底 ───────────────────────────────────────────

  if (!rootEntries) {
    return (
      <div className={`flex items-center justify-center py-4 text-text-secondary text-xs ${className}`}>
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        加载中...
      </div>
    )
  }

  // 判断新建输入是否在根目录下
  const rootNewEntry = newEntry && newEntry.parentDir === rootPath ? newEntry : null

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className={`${scrollable ? 'overflow-y-auto overflow-x-hidden' : ''} ${className} outline-none`}
      onContextMenu={handleBgContextMenu}
    >
      <RenderNodes
        entries={rootEntries}
        depth={0}
        expandedDirs={expandedDirs}
        dirCache={dirCache}
        selectedPath={selectedPath}
        changedPaths={changedPaths}
        renamingPath={renamingPath}
        newEntry={rootNewEntry}
        onToggle={handleToggle}
        onSelect={handleSelect}
        onOpen={handleOpen}
        onContextMenu={handleContextMenu}
        onRenameConfirm={handleRenameConfirm}
        onRenameCancel={handleRenameCancel}
        onNewEntryConfirm={handleNewEntryConfirm}
        onNewEntryCancel={handleNewEntryCancel}
      />

      {/* 右键菜单 */}
      <ContextMenu
        visible={ctxMenu.visible}
        x={ctxMenu.x}
        y={ctxMenu.y}
        items={ctxMenuItems}
        onClose={closeCtxMenu}
      />

      {/* 删除确认对话框 */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40"
          onClick={handleDeleteCancel}
        >
          <div
            className="bg-bg-secondary border border-border rounded-xl shadow-2xl p-5 max-w-sm mx-4 animate-context-menu"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-sm font-medium text-text-primary mb-2">确认删除</h3>
            <p className="text-xs text-text-secondary mb-4">
              确定要删除{deleteTarget.type === 'directory' ? '文件夹' : '文件'}
              <span className="text-text-primary font-medium"> {deleteTarget.name} </span>
              吗？{deleteTarget.type === 'directory' ? '文件夹及其所有内容将被移至回收站。' : '文件将被移至回收站。'}
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="px-3 py-1.5 text-xs rounded-lg text-text-secondary hover:bg-bg-hover btn-transition"
                onClick={handleDeleteCancel}
              >
                取消
              </button>
              <button
                className="px-3 py-1.5 text-xs rounded-lg bg-accent-red/20 text-accent-red hover:bg-accent-red/30 btn-transition"
                onClick={handleDeleteConfirm}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
