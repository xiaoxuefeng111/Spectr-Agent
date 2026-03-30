/**
 * 工具调用卡片组件
 *
 * 显示 AI 调用的工具（文件读写、命令执行等）及其结果。
 * 可折叠展开查看详细输入和输出。
 * 支持右键菜单快速复制工具信息或打开相关文件。
 *
 * @author weibin
 */

import React, { useState, useMemo } from 'react'
import {
  ChevronDown, ChevronRight, Copy, FileJson,
  ClipboardList, ExternalLink, FolderOpen, Terminal,
} from 'lucide-react'
import type { ConversationMessage } from '../../../shared/types'
import ContextMenu from '../common/ContextMenu'
import type { MenuItem } from '../common/ContextMenu'
import { useFileManagerStore } from '../../stores/fileManagerStore'

/** 工具名到图标/颜色的映射 */
const TOOL_STYLES: Record<string, { icon: string; color: string; label: string }> = {
  // ── Claude Code ──
  Read:         { icon: '📄', color: 'text-accent-blue',   label: 'Read' },
  Write:        { icon: '✏️', color: 'text-accent-green',  label: 'Write' },
  Edit:         { icon: '📝', color: 'text-accent-yellow', label: 'Edit' },
  Bash:         { icon: '⚡', color: 'text-accent-purple', label: 'Bash' },
  Glob:         { icon: '🔍', color: 'text-accent-blue',   label: 'Glob' },
  Grep:         { icon: '🔎', color: 'text-accent-blue',   label: 'Grep' },
  WebSearch:    { icon: '🌐', color: 'text-accent-blue',   label: 'WebSearch' },
  Task:         { icon: '🤖', color: 'text-accent-purple', label: 'Task' },
  // ── Codex CLI ──
  shell:        { icon: '⚡', color: 'text-accent-purple', label: 'Shell' },
  localShellCall: { icon: '⚡', color: 'text-accent-purple', label: 'Shell' },
  local_shell_call: { icon: '⚡', color: 'text-accent-purple', label: 'Shell' },
  functionCall: { icon: '🔧', color: 'text-accent-yellow', label: 'Function' },
  function_call: { icon: '🔧', color: 'text-accent-yellow', label: 'Function' },
}

const DEFAULT_STYLE = { icon: '🔧', color: 'text-text-secondary', label: 'Tool' }

/** 文件类工具列表，这些工具的 toolInput 中可能包含 file_path */
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep'])

interface ToolUseCardProps {
  message: ConversationMessage
  /** 紧凑模式（在 ToolOperationGroup 内使用，去掉外层 margin） */
  compact?: boolean
}

const ToolUseCard: React.FC<ToolUseCardProps> = ({ message, compact = false }) => {
  const [expanded, setExpanded] = useState(false)
  /** 右键菜单状态 */
  const [ctxMenu, setCtxMenu] = useState({ visible: false, x: 0, y: 0 })

  const { role, toolName, toolInput, toolResult, isError, content } = message

  const isResult = role === 'tool_result'
  const style = TOOL_STYLES[toolName || ''] || DEFAULT_STYLE

  // 从 fileManagerStore 获取"在编辑器中打开文件"的方法
  const openFileInTab = useFileManagerStore(s => s.openFileInTab)

  // 提取文件路径（仅对文件类工具有效）
  const filePath = FILE_TOOLS.has(toolName || '')
    ? (toolInput?.file_path as string | undefined)
    : undefined

  // 提取命令字符串（Bash 等工具）
  const cmdStr = toolInput?.command as string | undefined

  /** 构建右键菜单项数组 */
  const menuItems = useMemo<MenuItem[]>(() => {
    const items: MenuItem[] = [
      // 展开 / 折叠
      {
        key: 'toggle',
        label: expanded ? '折叠详情' : '展开详情',
        icon: expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />,
        onClick: () => setExpanded(v => !v),
      },
      { key: 'div1', type: 'divider' },
      // 复制工具名称
      {
        key: 'copy-name',
        label: '复制工具名称',
        icon: <Copy size={14} />,
        onClick: () => navigator.clipboard.writeText(toolName || ''),
      },
      // 复制输入参数（无 toolInput 时置灰）
      {
        key: 'copy-input',
        label: '复制输入参数（JSON）',
        icon: <FileJson size={14} />,
        disabled: !toolInput,
        onClick: () => navigator.clipboard.writeText(JSON.stringify(toolInput, null, 2)),
      },
      // 复制执行结果（无 toolResult 时置灰）
      {
        key: 'copy-result',
        label: '复制执行结果',
        icon: <ClipboardList size={14} />,
        disabled: !toolResult,
        onClick: () => navigator.clipboard.writeText(toolResult || ''),
      },
    ]

    // 文件路径相关菜单项（仅当 filePath 存在时加入）
    if (filePath) {
      items.push({ key: 'div2', type: 'divider' })
      items.push({
        key: 'open-file',
        label: '在编辑器中打开文件',
        icon: <ExternalLink size={14} />,
        onClick: () => openFileInTab(filePath),
      })
      items.push({
        key: 'copy-path',
        label: '复制文件路径',
        icon: <FolderOpen size={14} />,
        onClick: () => navigator.clipboard.writeText(filePath),
      })
    }

    // 命令字符串菜单项（仅当 cmdStr 存在时加入）
    if (cmdStr) {
      items.push({ key: 'div3', type: 'divider' })
      items.push({
        key: 'copy-cmd',
        label: '复制命令',
        icon: <Terminal size={14} />,
        onClick: () => navigator.clipboard.writeText(cmdStr),
      })
    }

    return items
  }, [expanded, toolName, toolInput, toolResult, filePath, cmdStr, openFileInTab])

  return (
    <div className={compact ? 'my-0.5 mx-1' : 'my-1 mx-2'}>
      <button
        onClick={() => setExpanded(!expanded)}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation() // 阻止冒泡到 ConversationView
          setCtxMenu({ visible: true, x: e.clientX, y: e.clientY })
        }}
        className={`w-full text-left flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-mono
          ${isResult
            ? (isError ? 'bg-accent-red/10 text-accent-red' : 'bg-bg-tertiary text-text-secondary')
            : 'bg-bg-secondary text-text-primary hover:bg-bg-hover'
          } transition-colors`}
      >
        <span className="text-[10px]">{expanded ? '▼' : '▶'}</span>
        <span>{style.icon}</span>
        <span className={`font-semibold ${style.color}`}>
          {toolName || style.label}
        </span>
        <span className="text-text-muted truncate flex-1">
          {content?.slice(0, 80)}
        </span>
        {isResult && isError && (
          <span className="text-accent-red text-[10px] font-bold">ERROR</span>
        )}
      </button>

      {expanded && (
        <div className="mt-1 mx-1 p-2 rounded bg-bg-tertiary text-xs font-mono border border-border overflow-auto max-h-[300px]">
          {/* 工具输入 */}
          {toolInput && !isResult && (
            <div className="mb-2">
              <div className="text-text-muted mb-1">Input:</div>
              <pre className="text-text-secondary whitespace-pre-wrap break-all">
                {formatToolInput(toolInput)}
              </pre>
            </div>
          )}

          {/* 工具结果 */}
          {isResult && toolResult && (
            <div>
              <div className="text-text-muted mb-1">Result:</div>
              <pre className={`whitespace-pre-wrap break-all ${isError ? 'text-accent-red' : 'text-text-secondary'}`}>
                {toolResult.length > 2000 ? toolResult.slice(0, 2000) + '\n... (truncated)' : toolResult}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* 右键菜单 */}
      <ContextMenu
        visible={ctxMenu.visible}
        x={ctxMenu.x}
        y={ctxMenu.y}
        items={menuItems}
        onClose={() => setCtxMenu(m => ({ ...m, visible: false }))}
      />
    </div>
  )
}

/** 格式化工具输入为可读文本 */
function formatToolInput(input: Record<string, unknown>): string {
  // 特殊处理常见工具输入
  if (input.command) return String(input.command)
  if (input.file_path) return String(input.file_path)
  if (input.pattern) return `pattern: ${input.pattern}`

  return JSON.stringify(input, null, 2)
}

ToolUseCard.displayName = 'ToolUseCard'
export default ToolUseCard
