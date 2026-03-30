/**
 * 消息气泡组件
 *
 * 根据 role 渲染不同样式的消息气泡：
 * - user: 右对齐蓝色气泡（纯文本）
 * - assistant: 左对齐灰色气泡（Markdown 渲染 + 代码高亮）
 * - system: 居中灰色提示
 * - tool_use / tool_result: 工具调用卡片（委托 ToolUseCard）
 *
 * 用户消息和 assistant 消息均支持右键菜单快速复制内容。
 *
 * @author weibin
 */

import React, { useState, useEffect } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { Components } from 'react-markdown'
import { Copy, FileText, Cpu, Zap } from 'lucide-react'
import type { ConversationMessage } from '../../../shared/types'
import { parseMessageContentWithImages } from '../../../shared/utils/messageContent'
import ToolUseCard from './ToolUseCard'
import ContextMenu from '../common/ContextMenu'
import type { MenuItem } from '../common/ContextMenu'

// highlight.js 暗色主题
import 'highlight.js/styles/atom-one-dark.css'

/** Markdown 自定义组件覆盖 */
const markdownComponents: Components = {
  // 代码：区分行内 code 和代码块
  code({ className, children, ...rest }) {
    // 有 language-xxx className 时为代码块（由 rehype-highlight 注入）
    const isCodeBlock = className && /language-/.test(className)
    if (isCodeBlock) {
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      )
    }
    // 行内 code
    return (
      <code className="markdown-inline-code" {...rest}>
        {children}
      </code>
    )
  },

  // 代码块外层 pre：深色背景 + 圆角 + 滚动
  pre({ children, ...rest }) {
    return (
      <pre className="markdown-code-block" {...rest}>
        {children}
      </pre>
    )
  },

  // 外部链接新窗口打开
  a({ href, children, ...rest }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="markdown-link"
        {...rest}
      >
        {children}
      </a>
    )
  },

  // 表格：加 overflow-x-auto 包裹避免撑破
  table({ children, ...rest }) {
    return (
      <div className="markdown-table-wrapper">
        <table className="markdown-table" {...rest}>
          {children}
        </table>
      </div>
    )
  },
}

/**
 * 格式化相对时间（"3分钟前" / "刚刚"）
 * 鼠标 hover 时可显示精确时间
 */
function formatRelativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 10) return '刚刚'
  if (seconds < 60) return `${seconds}秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/** 格式化精确时间（用于 tooltip） */
function formatExactTime(timestamp: string): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  })
}

/** remark 插件列表 */
const remarkPlugins = [remarkGfm]

/** rehype 插件列表 */
const rehypePlugins = [rehypeHighlight]

function resolveImagePaths(message: ConversationMessage): string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  const add = (value: string | undefined) => {
    const path = (value || '').trim()
    if (!path || seen.has(path)) return
    seen.add(path)
    paths.push(path)
  }

  const parsed = parseMessageContentWithImages(message.content || '')
  parsed.imageTags.forEach((tag) => add(tag.path))
  if (Array.isArray(message.attachments)) {
    for (const attachment of message.attachments) {
      if (attachment?.type === 'image') add(attachment.path)
    }
  }
  return paths
}

function toImageSrc(filePath: string): string {
  const value = (filePath || '').trim()
  if (!value) return value
  if (/^(?:https?:|data:|blob:|file:)/i.test(value)) return value
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return encodeURI(`file:///${value.replace(/\\/g, '/')}`)
  }
  if (value.startsWith('/')) {
    return encodeURI(`file://${value}`)
  }
  return encodeURI(value)
}

function getAttachmentName(filePath: string): string {
  const normalized = (filePath || '').replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  return parts[parts.length - 1] || filePath
}

interface MessageBubbleProps {
  message: ConversationMessage
  /** 当前会话是否仍在流式输出中。为 false 时，即使是 delta 草稿也渲染为 Markdown。 */
  isStreaming?: boolean
}

const MessageBubble: React.FC<MessageBubbleProps> = ({ message, isStreaming }) => {
  const { role, content, thinkingText, timestamp } = message
  const [previewImageSrc, setPreviewImageSrc] = useState<string | null>(null)
  const [previewImagePath, setPreviewImagePath] = useState('')
  /** 右键菜单状态（需要在早期 return 之前声明，遵守 Hook 规则） */
  const [ctxMenu, setCtxMenu] = useState({ visible: false, x: 0, y: 0 })

  useEffect(() => {
    if (!previewImageSrc) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPreviewImageSrc(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [previewImageSrc])

  // 工具调用和工具结果使用卡片组件（ToolUseCard 内部自带右键菜单）
  if (role === 'tool_use' || role === 'tool_result') {
    return <ToolUseCard message={message} />
  }

  // system 消息居中
  if (role === 'system') {
    return (
      <div className="flex justify-center my-2">
        <span className="text-xs text-text-muted bg-bg-tertiary px-3 py-1 rounded-full">
          {content}
        </span>
      </div>
    )
  }

  // ★ 只有在「流式输出进行中」时才以等宽纯文本渲染流式草稿，避免 Markdown 频繁重解析闪烁。
  // 当 isStreaming=false（session 已进入 waiting_input）时，即使 id 仍带 delta- 前缀
  // 也应渲染为 Markdown，解决 OpenCode 等 Provider 在 turn_complete 时未能固化草稿的问题。
  const isStreamingDraft = message.id.startsWith('delta-') && !!isStreaming
  const isUser = role === 'user'

  // ★ Skill 静默执行徽章：以 "▶ /" 开头的用户消息为技能执行占位，渲染为紧凑徽章
  if (isUser && content && content.startsWith('\u25B6 /')) {
    const skillCommand = content.slice(2) // 去掉 "▶ " 前缀，保留 /command
    return (
      <div className="flex justify-end mb-2">
        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full
          bg-accent-blue/10 border border-accent-blue/20 text-accent-blue text-xs
          select-none"
        >
          <Zap size={11} className="flex-shrink-0" />
          <span className="font-mono">{skillCommand}</span>
        </div>
      </div>
    )
  }
  const parsedContent = parseMessageContentWithImages(content || '')
  const imagePaths = resolveImagePaths(message)

  /** 根据消息角色构建右键菜单项 */
  const menuItems: MenuItem[] = isUser
    ? [
        // 用户消息：直接复制原始内容
        {
          key: 'copy-content',
          label: '复制消息内容',
          icon: <Copy size={14} />,
          onClick: () => navigator.clipboard.writeText(content || ''),
        },
      ]
    : [
        // assistant 消息：支持纯文本 / Markdown 原文两种复制方式
        {
          key: 'copy-plain',
          label: '复制为纯文本',
          icon: <Copy size={14} />,
          onClick: () => navigator.clipboard.writeText(parsedContent.textContent || ''),
        },
        {
          key: 'copy-markdown',
          label: '复制为 Markdown 原文',
          icon: <FileText size={14} />,
          onClick: () => navigator.clipboard.writeText(content || ''),
        },
        // 仅当有思考内容时才追加该菜单项
        ...(thinkingText
          ? [
              { key: 'div1', type: 'divider' as const },
              {
                key: 'copy-thinking',
                label: '复制思考过程',
                icon: <Cpu size={14} />,
                onClick: () => navigator.clipboard.writeText(thinkingText || ''),
              },
            ]
          : []),
      ]

  return (
    <>
      <div
        className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation() // 阻止冒泡到 ConversationView 背景
          setCtxMenu({ visible: true, x: e.clientX, y: e.clientY })
        }}
      >
        <div
          className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
            isUser
              ? 'bg-accent-blue/20 text-text-primary'
              : 'bg-bg-secondary text-text-primary'
          }`}
        >
          {/* 思考内容（折叠显示） */}
          {thinkingText && <ThinkingBlock text={thinkingText} />}

          {/* 主要内容 */}
          {parsedContent.textContent && (
            isUser ? (
              // user 消息：纯文本渲染
              <div className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed">
                {parsedContent.textContent}
              </div>
            ) : (
              // assistant 消息：流式草稿降级纯文本，完成后 Markdown 渲染
              <div className={isStreamingDraft ? "whitespace-pre-wrap break-words text-[13px] leading-relaxed font-mono" : "markdown-body text-[13px] leading-relaxed"}>
                {isStreamingDraft ? parsedContent.textContent : (
                  <Markdown
                    remarkPlugins={remarkPlugins}
                    rehypePlugins={rehypePlugins}
                    components={markdownComponents}
                  >
                    {parsedContent.textContent}
                  </Markdown>
                )}
              </div>
            )
          )}

          {imagePaths.length > 0 && (
            <div className="mt-2 grid grid-cols-2 gap-2 max-w-[360px]">
              {imagePaths.map((path, idx) => {
                const src = toImageSrc(path)
                const name = getAttachmentName(path)
                return (
                  <button
                    key={`${path}-${idx}`}
                    type="button"
                    className="group relative rounded-lg overflow-hidden border border-border bg-bg-tertiary hover:border-accent-blue/40 btn-transition text-left"
                    onClick={() => {
                      setPreviewImageSrc(src)
                      setPreviewImagePath(path)
                    }}
                    title={path}
                  >
                    <img
                      src={src}
                      alt={name}
                      loading="lazy"
                      className="w-full h-28 object-cover"
                    />
                    <span className="absolute inset-x-0 bottom-0 px-1.5 py-1 text-[10px] text-white bg-black/60 truncate">
                      {name}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {/* 时间戳：嵌入气泡右下角，hover 显示精确时间 */}
          {timestamp && (
            <div className={`flex mt-1 ${isUser ? 'justify-end' : 'justify-end'}`}>
              <span
                className="text-[10px] text-text-muted/40 cursor-default select-none hover:text-text-muted/70 transition-colors"
                title={formatExactTime(timestamp)}
              >
                {formatRelativeTime(timestamp)}
              </span>
            </div>
          )}
        </div>
      </div>

      {previewImageSrc && (
        <div
          className="fixed inset-0 z-[120] bg-black/80 p-4 flex items-center justify-center"
          onClick={() => setPreviewImageSrc(null)}
        >
          <div
            className="relative max-w-[92vw] max-h-[92vh] w-full flex flex-col items-center gap-2"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="self-end px-2 py-1 text-xs rounded bg-bg-primary/80 text-text-primary hover:bg-bg-primary btn-transition"
              onClick={() => setPreviewImageSrc(null)}
            >
              关闭
            </button>
            <img
              src={previewImageSrc}
              alt={getAttachmentName(previewImagePath)}
              className="max-w-full max-h-[82vh] object-contain rounded border border-border bg-black/20"
            />
            <div className="w-full max-w-[92vw] text-[11px] text-white/85 text-center break-all">
              {previewImagePath}
            </div>
          </div>
        </div>
      )}

      {/* 右键菜单（Portal 渲染到 body，不受气泡 overflow 限制） */}
      <ContextMenu
        visible={ctxMenu.visible}
        x={ctxMenu.x}
        y={ctxMenu.y}
        items={menuItems}
        onClose={() => setCtxMenu(m => ({ ...m, visible: false }))}
      />
    </>
  )
}

/** 思考过程折叠区域 */
const ThinkingBlock: React.FC<{ text: string }> = ({ text }) => {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="mb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-xs text-text-muted hover:text-text-secondary flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-bg-hover/50 transition-colors"
      >
        <span className="text-[10px]">{expanded ? '▼' : '▶'}</span>
        <span className="italic">思考过程</span>
        <span className="text-[10px] text-text-muted/40">({Math.ceil(text.length / 100) * 100}字符)</span>
      </button>
      {expanded && (
        <div className="mt-1 text-xs text-text-muted/70 whitespace-pre-wrap border-l-2 border-accent-purple/30 pl-2 bg-bg-tertiary/30 rounded-r py-1">
          {text}
        </div>
      )}
    </div>
  )
}

MessageBubble.displayName = 'MessageBubble'
export default React.memo(MessageBubble)
