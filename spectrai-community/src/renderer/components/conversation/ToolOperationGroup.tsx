/**
 * 工具操作分组组件
 *
 * 将连续的 tool_use + tool_result 消息折叠为一个可展开的区块，
 * 避免大量工具调用淹没对话流。
 *
 * 折叠时显示摘要（操作数 + 工具分类计数 + 最后一个操作）
 * 展开时显示所有工具操作（复用 ToolUseCard）
 * 活跃状态（末尾分组）显示 spinner + 实时更新摘要
 *
 * @author weibin
 */

import React, { useState, useMemo, useEffect } from 'react'
import type { ConversationMessage } from '../../../shared/types'
import ToolUseCard from './ToolUseCard'

interface ToolOperationGroupProps {
  messages: ConversationMessage[]
  /** 是否为活跃状态（正在执行中的末尾分组） */
  isActive: boolean
}

/** 格式化毫秒耗时为可读字符串 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

/** 工具名到图标的映射（与 ToolUseCard 保持一致） */
const TOOL_ICONS: Record<string, string> = {
  // Claude Code
  Read: '📄', Write: '✏️', Edit: '📝', Bash: '⚡',
  Glob: '🔍', Grep: '🔎', WebSearch: '🌐', Task: '🤖',
  // iFlow CLI
  read_file: '📄', image_read: '🖼️', read_many_files: '📂',
  write_file: '✏️', replace: '📝', multi_edit: '📝',
  run_shell_command: '⚡', search_file_content: '🔎',
  glob: '🔍', list_directory: '📁', web_search: '🌐', web_fetch: '🌐',
  task: '🤖', save_memory: '💾', todo_read: '📋', todo_write: '📋',
  ask_user_questions: '❓', exit_plan_mode: '🚪',
}

const ToolOperationGroup: React.FC<ToolOperationGroupProps> = ({ messages, isActive }) => {
  const [expanded, setExpanded] = useState(false)

  // 合并计算 tool_use 消息、分类计数、最后一个操作
  const { toolUseMessages, toolCounts, lastToolUse } = useMemo(() => {
    const toolUseMessages = messages.filter(m => m.role === 'tool_use')
    const toolCounts: Record<string, number> = {}
    for (const msg of toolUseMessages) {
      const name = msg.toolName || 'Tool'
      toolCounts[name] = (toolCounts[name] || 0) + 1
    }
    const lastToolUse = toolUseMessages[toolUseMessages.length - 1]
    return { toolUseMessages, toolCounts, lastToolUse }
  }, [messages])

  const toolCount = toolUseMessages.length

  // 已完成组：从第一条到最后一条消息的耗时
  const completedDuration = useMemo(() => {
    if (isActive || messages.length < 2) return null
    const start = new Date(messages[0].timestamp).getTime()
    const end = new Date(messages[messages.length - 1].timestamp).getTime()
    const ms = end - start
    if (ms < 100) return null // 太短不显示
    return formatDuration(ms)
  }, [messages, isActive])

  // 活跃组：从第一条消息开始的实时计时
  const [activeDurationSecs, setActiveDurationSecs] = useState(0)
  useEffect(() => {
    if (!isActive || messages.length === 0) return
    const start = new Date(messages[0].timestamp).getTime()
    const update = () => setActiveDurationSecs(Math.floor((Date.now() - start) / 1000))
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [isActive, messages])

  // 最后一个 tool_use 的摘要文本
  const lastSummary = useMemo(() => {
    if (!lastToolUse) return ''
    const name = lastToolUse.toolName || 'Tool'
    const input = lastToolUse.toolInput
    if (!input) return name
    if (input.file_path) return `${name} ${input.file_path}`
    if (input.command) return `${name} ${String(input.command).slice(0, 60)}`
    if (input.pattern) return `${name} pattern: ${input.pattern}`
    return `${name} ${lastToolUse.content?.slice(0, 60) || ''}`
  }, [lastToolUse])

  // 是否有错误
  const hasError = messages.some(m => m.role === 'tool_result' && m.isError)

  // 只有手动展开才显示明细（活跃/非活跃均默认折叠）
  const displayMessages = useMemo(
    () => expanded ? messages : [],
    [messages, expanded]
  )

  return (
    <div
      className={`my-2 mx-2 rounded-lg overflow-hidden border-l-2 transition-colors ${
        isActive
          ? 'border-accent-purple bg-bg-tertiary/50'
          : hasError
            ? 'border-accent-red/40 bg-bg-tertiary/30'
            : 'border-accent-purple/30 bg-bg-tertiary/30'
      }`}
    >
      {/* 摘要头部 */}
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-bg-hover/50 transition-colors"
      >
        {/* 展开/折叠指示 */}
        <span className="text-[10px] text-text-muted flex-shrink-0">
          {expanded ? '▼' : '▶'}
        </span>

        {/* Spinner（活跃状态） */}
        {isActive && (
          <span className="inline-block w-3 h-3 border border-accent-purple border-t-transparent rounded-full animate-spin flex-shrink-0" />
        )}

        {/* 工具图标 */}
        <span className="text-xs flex-shrink-0">🔧</span>

        {/* 操作计数 + 内联耗时 */}
        <span className="text-xs font-medium text-text-primary flex-shrink-0">
          {isActive
            ? <>正在执行<span className="text-text-muted font-normal">（{toolCount} 个操作{activeDurationSecs > 0 && <> · {activeDurationSecs}s</>}）</span></>
            : <>执行了 {toolCount} 个操作{completedDuration && <span className="text-text-muted font-normal"> · {completedDuration}</span>}</>
          }
        </span>

        {/* 工具分类标签 */}
        <span className="flex items-center gap-1.5 flex-shrink-0">
          {Object.entries(toolCounts).map(([name, count]) => (
            <span
              key={name}
              className="text-[10px] text-text-muted bg-bg-secondary px-1.5 py-0.5 rounded font-mono"
            >
              {TOOL_ICONS[name] || '🔧'}{name}({count})
            </span>
          ))}
        </span>

        {/* 错误标记 */}
        {hasError && (
          <span className="text-[10px] text-accent-red font-bold flex-shrink-0">ERROR</span>
        )}
      </button>

      {/* 折叠时显示最后一个操作的摘要 */}
      {!expanded && lastToolUse && lastSummary && (
        <div className="px-3 pb-2 -mt-1">
          <span className="text-[11px] text-text-muted/60 font-mono truncate block">
            最近: {lastSummary}
          </span>
        </div>
      )}

      {/* 展开的工具操作列表 */}
      {displayMessages.length > 0 && (
        <div className="border-t border-border/30">
          {displayMessages.map(msg => (
            <ToolUseCard key={msg.id} message={msg} compact />
          ))}
        </div>
      )}
    </div>
  )
}

ToolOperationGroup.displayName = 'ToolOperationGroup'
export default React.memo(ToolOperationGroup)
