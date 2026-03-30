/**
 * 文件变更卡片组件
 *
 * 在对话流中展示 AI 对文件的改动，支持 diff 语法高亮。
 * 类似 Cursor 的文件改动内联展示效果。
 *
 * @author weibin
 */

import React, { useState, useMemo } from 'react'
import {
  ChevronDown, ChevronRight, FileEdit, FilePlus, FileX, File,
  Copy, ExternalLink, FolderOpen, Plus, Minus,
} from 'lucide-react'
import type { ConversationMessage } from '../../../shared/types'
import ContextMenu from '../common/ContextMenu'
import type { MenuItem } from '../common/ContextMenu'
import { useFileManagerStore } from '../../stores/fileManagerStore'

/** 改动类型到样式的映射 */
const CHANGE_TYPE_STYLES = {
  edit:   { icon: FileEdit, color: 'text-accent-yellow', label: '编辑', bgColor: 'bg-accent-yellow/10' },
  create: { icon: FilePlus, color: 'text-accent-green',  label: '创建', bgColor: 'bg-accent-green/10' },
  write:  { icon: File,     color: 'text-accent-blue',   label: '写入', bgColor: 'bg-accent-blue/10' },
  delete: { icon: FileX,    color: 'text-accent-red',    label: '删除', bgColor: 'bg-accent-red/10' },
}

interface FileChangeCardProps {
  message: ConversationMessage
}

const FileChangeCard: React.FC<FileChangeCardProps> = ({ message }) => {
  const [expanded, setExpanded] = useState(false)
  const [activeTab, setActiveTab] = useState<'operation' | 'cumulative'>('operation')
  const [ctxMenu, setCtxMenu] = useState({ visible: false, x: 0, y: 0 })

  const openFileInTab = useFileManagerStore(s => s.openFileInTab)

  const fc = message.fileChange
  if (!fc) return null

  const style = CHANGE_TYPE_STYLES[fc.changeType] || CHANGE_TYPE_STYLES.edit
  const Icon = style.icon
  const fileName = fc.filePath.split(/[/\\]/).pop() || fc.filePath
  const dirPath = fc.filePath.split(/[/\\]/).slice(0, -1).join('/')

  // 解析 diff 行
  const diffLines = useMemo(() => {
    const diffText = activeTab === 'cumulative' && fc.cumulativeDiff
      ? fc.cumulativeDiff
      : fc.operationDiff
    return parseDiffLines(diffText)
  }, [fc, activeTab])

  // 右键菜单
  const menuItems = useMemo<MenuItem[]>(() => [
    {
      key: 'toggle',
      label: expanded ? '折叠' : '展开 Diff',
      icon: expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />,
      onClick: () => setExpanded(v => !v),
    },
    { key: 'div1', type: 'divider' },
    {
      key: 'open-file',
      label: '在编辑器中打开',
      icon: <ExternalLink size={14} />,
      onClick: () => openFileInTab(fc.filePath),
    },
    {
      key: 'copy-path',
      label: '复制文件路径',
      icon: <FolderOpen size={14} />,
      onClick: () => navigator.clipboard.writeText(fc.filePath),
    },
    {
      key: 'copy-diff',
      label: '复制 Diff',
      icon: <Copy size={14} />,
      onClick: () => navigator.clipboard.writeText(fc.operationDiff),
    },
  ], [expanded, fc, openFileInTab])

  return (
    <div className="my-2 mx-2">
      {/* 卡片头部 */}
      <button
        onClick={() => setExpanded(!expanded)}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setCtxMenu({ visible: true, x: e.clientX, y: e.clientY })
        }}
        className={`w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-mono
          ${style.bgColor} hover:brightness-110 transition-all border border-border/50`}
      >
        <span className="text-[10px] text-text-muted">{expanded ? '▼' : '▶'}</span>
        <Icon size={14} className={style.color} />
        <span className={`font-semibold ${style.color}`}>{style.label}</span>
        <span className="text-text-primary font-medium truncate">{fileName}</span>
        <span className="text-text-muted truncate flex-1 text-[11px]">{dirPath}</span>

        {/* +N / -N 统计 */}
        <span className="flex items-center gap-1.5 flex-shrink-0">
          {fc.additions > 0 && (
            <span className="flex items-center gap-0.5 text-accent-green">
              <Plus size={10} />
              <span>{fc.additions}</span>
            </span>
          )}
          {fc.deletions > 0 && (
            <span className="flex items-center gap-0.5 text-accent-red">
              <Minus size={10} />
              <span>{fc.deletions}</span>
            </span>
          )}
        </span>
      </button>

      {/* 展开的 Diff 区域 */}
      {expanded && (
        <div className="mt-1 mx-0.5 rounded-lg bg-bg-tertiary border border-border overflow-hidden">
          {/* Tab 切换（仅当有累积 diff 时显示） */}
          {fc.cumulativeDiff && (
            <div className="flex border-b border-border">
              <button
                onClick={() => setActiveTab('operation')}
                className={`px-3 py-1.5 text-[11px] font-medium transition-colors ${
                  activeTab === 'operation'
                    ? 'text-text-primary border-b-2 border-accent-blue'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                本次改动
              </button>
              <button
                onClick={() => setActiveTab('cumulative')}
                className={`px-3 py-1.5 text-[11px] font-medium transition-colors ${
                  activeTab === 'cumulative'
                    ? 'text-text-primary border-b-2 border-accent-blue'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                累积改动
              </button>
            </div>
          )}

          {/* Diff 内容 */}
          <div className="overflow-auto max-h-[400px] text-[12px] font-mono leading-[1.6]">
            {diffLines.map((line, i) => (
              <div
                key={i}
                className={`px-3 py-0 whitespace-pre ${getDiffLineClass(line.type)}`}
              >
                <span className="inline-block w-[50px] text-right text-text-muted/50 select-none mr-2 text-[11px]">
                  {line.lineNum || ''}
                </span>
                <span className="text-text-muted/60 select-none mr-1">{line.prefix}</span>
                <span>{line.content}</span>
              </div>
            ))}
            {diffLines.length === 0 && (
              <div className="px-4 py-3 text-text-muted text-center">
                {fc.changeType === 'delete' ? '文件已删除' : '无差异'}
              </div>
            )}
          </div>
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

// ─── Diff 解析工具函数 ───

interface DiffLine {
  type: 'add' | 'delete' | 'context' | 'header' | 'info'
  prefix: string
  content: string
  lineNum?: string
}

/**
 * 解析 unified diff 字符串为结构化行数组
 */
function parseDiffLines(diff: string): DiffLine[] {
  if (!diff) return []

  const lines = diff.split('\n')
  const result: DiffLine[] = []
  let oldLine = 0
  let newLine = 0

  for (const rawLine of lines) {
    // 跳过 diff 头部行（--- +++ ===）
    if (rawLine.startsWith('---') || rawLine.startsWith('+++') || rawLine.startsWith('Index:') || rawLine.startsWith('===')) {
      result.push({ type: 'info', prefix: '', content: rawLine })
      continue
    }

    // @@ hunk header
    if (rawLine.startsWith('@@')) {
      const match = rawLine.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/)
      if (match) {
        oldLine = parseInt(match[1])
        newLine = parseInt(match[2])
      }
      result.push({ type: 'header', prefix: '', content: rawLine })
      continue
    }

    // diff --git header
    if (rawLine.startsWith('diff ')) {
      result.push({ type: 'info', prefix: '', content: rawLine })
      continue
    }

    // 添加行
    if (rawLine.startsWith('+')) {
      result.push({
        type: 'add',
        prefix: '+',
        content: rawLine.slice(1),
        lineNum: String(newLine++),
      })
      continue
    }

    // 删除行
    if (rawLine.startsWith('-')) {
      result.push({
        type: 'delete',
        prefix: '-',
        content: rawLine.slice(1),
        lineNum: String(oldLine++),
      })
      continue
    }

    // 上下文行
    if (rawLine.startsWith(' ') || rawLine === '') {
      result.push({
        type: 'context',
        prefix: ' ',
        content: rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine,
        lineNum: String(newLine++),
      })
      oldLine++
      continue
    }

    // 其他（如 "\ No newline at end of file"）
    result.push({ type: 'info', prefix: '', content: rawLine })
  }

  return result
}

/**
 * 根据行类型返回 CSS 类名
 */
function getDiffLineClass(type: DiffLine['type']): string {
  switch (type) {
    case 'add':     return 'bg-accent-green/10 text-accent-green'
    case 'delete':  return 'bg-accent-red/10 text-accent-red'
    case 'header':  return 'bg-accent-blue/5 text-accent-blue'
    case 'info':    return 'text-text-muted'
    case 'context': return 'text-text-secondary'
    default:        return ''
  }
}

FileChangeCard.displayName = 'FileChangeCard'
export default React.memo(FileChangeCard)
