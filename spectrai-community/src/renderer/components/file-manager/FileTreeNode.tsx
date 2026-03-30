/**
 * 文件树单节点组件
 * 渲染单个文件或目录条目，支持展开/折叠、选中、双击打开、右键菜单、内联重命名
 * @author weibin
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { ChevronRight, ChevronDown, Folder, FolderOpen, File, FileText, FileCode } from 'lucide-react'
import type { FileEntry } from '../../../shared/fileManagerTypes'
import { useFileManagerStore } from '../../stores/fileManagerStore'

// ─────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────

/** 根据文件扩展名返回对应图标组件和颜色 */
function getFileIcon(extension?: string): {
  Icon: typeof File
  color: string
} {
  const ext = extension?.toLowerCase()

  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return { Icon: FileCode, color: 'var(--color-accent-blue)' }    // 蓝色 — 脚本/代码

    case '.json':
    case '.jsonc':
      return { Icon: FileCode, color: 'var(--color-accent-yellow)' }  // 黄色 — 配置

    case '.md':
    case '.mdx':
    case '.txt':
      return { Icon: FileText, color: 'var(--color-text-secondary)' } // 次要色 — 文档

    case '.css':
    case '.scss':
    case '.less':
      return { Icon: FileCode, color: 'var(--color-accent-purple)' }  // 紫色 — 样式

    case '.html':
    case '.htm':
    case '.vue':
    case '.svelte':
      return { Icon: FileCode, color: 'var(--color-accent-green)' }   // 绿色 — 模板

    case '.py':
    case '.rb':
    case '.go':
    case '.rs':
    case '.java':
    case '.c':
    case '.cpp':
    case '.h':
      return { Icon: FileCode, color: 'var(--color-accent-blue)' }    // 蓝色 — 后端语言

    default:
      return { Icon: File, color: 'var(--color-text-secondary)' }     // 默认次要色
  }
}

// ─────────────────────────────────────────────────────────
// 组件
// ─────────────────────────────────────────────────────────

export interface FileTreeNodeProps {
  entry: FileEntry
  /** 缩进层级（0 = 根目录下一级，每级 12px） */
  depth: number
  /** 目录是否已展开 */
  isExpanded?: boolean
  /** 是否被选中 */
  isSelected?: boolean
  /** 是否被当前会话 AI 改动过 */
  isChangedBySession?: boolean
  /** 是否处于内联重命名模式 */
  isRenaming?: boolean
  /** 点击展开/折叠箭头时触发（仅目录） */
  onToggle?: () => void
  /** 单击节点时触发（选中） */
  onSelect: () => void
  /** 双击节点时触发（文件：系统打开；目录：进入该目录） */
  onOpen: () => void
  /** 右键菜单触发 */
  onContextMenu?: (e: React.MouseEvent) => void
  /** 内联重命名完成回调 */
  onRenameConfirm?: (newName: string) => void
  /** 取消重命名回调 */
  onRenameCancel?: () => void
}

export default function FileTreeNode({
  entry,
  depth,
  isExpanded = false,
  isSelected = false,
  isChangedBySession = false,
  isRenaming = false,
  onToggle,
  onSelect,
  onOpen,
  onContextMenu,
  onRenameConfirm,
  onRenameCancel,
}: FileTreeNodeProps) {
  const isDir = entry.type === 'directory'
  const openFileInTab = useFileManagerStore(s => s.openFileInTab)

  // ── 内联重命名状态 ─────────────────────────────────────
  const [renameValue, setRenameValue] = useState(entry.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      setRenameValue(entry.name)
      inputRef.current.focus()
      // 选中文件名（不含扩展名）
      const dotIdx = entry.name.lastIndexOf('.')
      if (dotIdx > 0 && !isDir) {
        inputRef.current.setSelectionRange(0, dotIdx)
      } else {
        inputRef.current.select()
      }
    }
  }, [isRenaming, entry.name, isDir])

  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const trimmed = renameValue.trim()
      if (trimmed && trimmed !== entry.name) {
        onRenameConfirm?.(trimmed)
      } else {
        onRenameCancel?.()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onRenameCancel?.()
    }
  }, [renameValue, entry.name, onRenameConfirm, onRenameCancel])

  const handleRenameBlur = useCallback(() => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== entry.name) {
      onRenameConfirm?.(trimmed)
    } else {
      onRenameCancel?.()
    }
  }, [renameValue, entry.name, onRenameConfirm, onRenameCancel])

  // ── 样式计算 ──────────────────────────────────────────
  const rowClass = [
    'flex items-center gap-1 py-0.5 px-1 rounded cursor-pointer text-sm select-none',
    'hover:bg-bg-hover btn-transition',
    isSelected
      ? 'bg-bg-tertiary text-accent-blue'
      : entry.isHidden
        ? 'text-text-muted'
        : 'text-text-primary',
  ].join(' ')

  // 每层 12px 缩进，加上基础 8px 的左边距
  const paddingLeft = depth * 12 + 8

  // ── 图标 ─────────────────────────────────────────────
  const ArrowIcon = isExpanded ? ChevronDown : ChevronRight

  const dirIcon = isExpanded
    ? <FolderOpen className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--color-accent-yellow)' }} />
    : <Folder    className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--color-accent-yellow)' }} />

  const { Icon: FileIcon, color: fileColor } = getFileIcon(entry.extension)

  // ── 事件处理 ──────────────────────────────────────────

  const handleClick = () => {
    if (isRenaming) return
    onSelect()
    if (isDir) {
      // 目录整行点击 = 展开/收缩
      onToggle?.()
    } else {
      // 文件单击 → 在 Tab 窗格中打开
      openFileInTab(entry.path)
    }
  }

  const handleDoubleClick = () => {
    if (isRenaming) return
    onOpen()
  }

  const handleArrowClick = (e: React.MouseEvent) => {
    e.stopPropagation()   // 不触发行的 onSelect
    onToggle?.()
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onSelect()
    onContextMenu?.(e)
  }

  /**
   * 拖拽开始：将文件/目录路径写入 dataTransfer
   * - text/x-spectrai-filepath  →  MessageInput 优先识别，生成文件引用卡片
   * - text/plain                 →  兼容其他拖放目标
   */
  const handleDragStart = (e: React.DragEvent) => {
    if (isRenaming) {
      e.preventDefault()
      return
    }
    e.stopPropagation()
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData('text/x-spectrai-filepath', entry.path)
    e.dataTransfer.setData('text/plain', entry.path)
  }

  // ── 渲染 ─────────────────────────────────────────────
  return (
    <div
      className={rowClass}
      style={{ paddingLeft }}
      draggable={!isRenaming}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onDragStart={handleDragStart}
      onContextMenu={handleContextMenu}
      title={isRenaming ? undefined : `${entry.path}\n拖拽到对话框可引用此${isDir ? '目录' : '文件'}`}
    >
      {/* 展开/折叠箭头（目录专用，文件占位保持对齐） */}
      {isDir ? (
        <span
          className="flex-shrink-0 hover:text-text-primary text-text-secondary"
          onClick={handleArrowClick}
        >
          <ArrowIcon className="w-3 h-3" />
        </span>
      ) : (
        // 文件：占位 12px，使文件名与目录文件名对齐
        <span className="w-3 flex-shrink-0" />
      )}

      {/* 文件/目录图标 */}
      {isDir ? dirIcon : (
        <FileIcon
          className="w-3.5 h-3.5 flex-shrink-0"
          style={{ color: fileColor }}
        />
      )}

      {/* 文件名 / 重命名输入框 */}
      {isRenaming ? (
        <input
          ref={inputRef}
          type="text"
          value={renameValue}
          onChange={e => setRenameValue(e.target.value)}
          onKeyDown={handleRenameKeyDown}
          onBlur={handleRenameBlur}
          onClick={e => e.stopPropagation()}
          className="flex-1 min-w-0 bg-bg-primary border border-accent-blue rounded px-1 py-0 text-xs
                     text-text-primary outline-none focus:ring-1 focus:ring-accent-blue/50"
          style={{ height: 20 }}
        />
      ) : (
        <span className="truncate text-xs leading-5">
          {entry.name}
        </span>
      )}

      {/* AI 改动指示圆点 */}
      {isChangedBySession && !isRenaming && (
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0 ml-auto" title="AI 已改动" />
      )}

      {/* 文件大小（仅文件，鼠标悬停时隐藏名称溢出） */}
      {!isDir && entry.size !== undefined && !isRenaming && (
        <span className="ml-auto text-[10px] text-text-muted flex-shrink-0 pr-1">
          {formatSize(entry.size)}
        </span>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// 辅助：文件大小格式化
// ─────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}
