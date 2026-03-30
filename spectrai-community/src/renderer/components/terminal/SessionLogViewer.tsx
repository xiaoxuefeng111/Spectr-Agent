/**
 * 已完成会话的历史日志查看器
 * 用 xterm.js 只读终端回放历史输出
 * @author weibin
 */

import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { Clock, FileText, RotateCcw, X } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import { useSessionStore } from '../../stores/sessionStore'
import { THEMES, DEFAULT_THEME_ID, STATUS_COLORS } from '../../../shared/constants'
import type { SessionStatus } from '../../../shared/types'

/** 根据主题 ID 获取终端配色（与 useTerminal 保持一致） */
function getTerminalTheme(themeId: string) {
  const t = (THEMES[themeId] || THEMES[DEFAULT_THEME_ID]).terminal
  return {
    background: t.bg,
    foreground: t.fg,
    cursor: t.cursor,
    black: t.black,
    red: t.red,
    green: t.green,
    yellow: t.yellow,
    blue: t.blue,
    magenta: t.magenta,
    cyan: t.cyan,
    white: t.white,
    brightBlack: t.brightBlack,
    brightRed: t.brightRed,
    brightGreen: t.brightGreen,
    brightYellow: t.brightYellow,
    brightBlue: t.brightBlue,
    brightMagenta: t.brightMagenta,
    brightCyan: t.brightCyan,
    brightWhite: t.brightWhite,
  }
}

const STATUS_LABELS: Record<SessionStatus, string> = {
  starting: '启动中',
  running: '运行中',
  idle: '空闲',
  waiting_input: '等待输入',
  paused: '已暂停',
  completed: '已完成',
  error: '出错',
  terminated: '已终止',
  interrupted: '已中断'
}

interface SessionLogViewerProps {
  sessionId: string
}

const SessionLogViewer: React.FC<SessionLogViewerProps> = ({ sessionId }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const theme = useUIStore((s) => s.theme)
  const { sessions, resumeSession, selectSession } = useSessionStore()
  const [loading, setLoading] = useState(true)
  const [logCount, setLogCount] = useState(0)

  const session = sessions.find(s => s.id === sessionId)

  // 初始化 xterm 并加载日志
  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      theme: getTerminalTheme(useUIStore.getState().theme),
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 14,
      cursorBlink: false,
      disableStdin: true,
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    term.open(containerRef.current)

    termRef.current = term
    fitRef.current = fitAddon

    // 关键：等 Allotment 布局稳定后再 fit + 写入日志
    // requestAnimationFrame x2 不够等 Allotment 完成分栏计算，
    // 导致 fit() 时容器宽度不对，日志按错误列数换行（"折一半"）。
    // 改用 ResizeObserver + debounce，确保容器尺寸稳定后再加载。
    setLoading(true)
    let logsWritten = false
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    const loadLogs = () => {
      if (logsWritten) return
      logsWritten = true
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }

      try { fitAddon.fit() } catch { /* ignore */ }

      window.spectrAI.session.getLogs(sessionId).then(chunks => {
        setLogCount(chunks.length)
        for (const chunk of chunks) {
          term.write(chunk)
        }
        setLoading(false)
      }).catch(() => {
        setLoading(false)
      })
    }

    const handleResize = () => {
      if (!logsWritten) {
        // 布局还没稳定：每次 resize 重新计时，等 150ms 无变化再加载
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => loadLogs(), 150)
      } else {
        // 日志已写入：仅调整终端尺寸（已写入的文本无法重排）
        try { fitAddon.fit() } catch { /* ignore */ }
      }
    }

    window.addEventListener('resize', handleResize)

    const resizeObserver = new ResizeObserver(() => handleResize())
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current)
    }

    // 兜底：如果 ResizeObserver 未触发（极端情况），最多 500ms 后强制加载
    const fallbackTimer = setTimeout(() => {
      if (!logsWritten) loadLogs()
    }, 500)

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      clearTimeout(fallbackTimer)
      window.removeEventListener('resize', handleResize)
      resizeObserver.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [sessionId])

  // 主题变化
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = getTerminalTheme(theme)
    }
  }, [theme])

  const statusColor = session ? (STATUS_COLORS[session.status] || STATUS_COLORS.idle) : STATUS_COLORS.idle
  const statusLabel = session ? (STATUS_LABELS[session.status] || session.status) : '-'

  return (
    <div className="flex flex-col h-full bg-bg-primary rounded-lg border border-border overflow-hidden shadow-lg">
      {/* 头部信息条 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-bg-secondary">
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="w-4 h-4 text-text-muted flex-shrink-0" />
          <span className="text-xs font-medium text-text-primary truncate">
            {session?.name || session?.config?.name || '会话日志'}
          </span>
          <span
            className="text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0"
            style={{
              backgroundColor: statusColor + '20',
              color: statusColor
            }}
          >
            {statusLabel}
          </span>
          {session?.startedAt && (
            <span className="text-[10px] text-text-muted flex items-center gap-1 flex-shrink-0">
              <Clock className="w-3 h-3" />
              {new Date(session.startedAt).toLocaleString()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {loading && (
            <span className="text-[10px] text-text-muted animate-pulse">加载中...</span>
          )}
          {!loading && logCount === 0 && (
            <span className="text-[10px] text-text-muted">无日志记录</span>
          )}
          {session && (session.status === 'completed' || session.status === 'terminated') && (
            <button
              onClick={() => resumeSession(sessionId)}
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30 btn-transition"
            >
              <RotateCcw className="w-3 h-3" />
              继续会话
            </button>
          )}
          <button
            onClick={() => selectSession(null)}
            className="flex items-center justify-center w-6 h-6 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover btn-transition"
            title="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 终端容器 */}
      <div ref={containerRef} className="flex-1 overflow-hidden p-2" />
    </div>
  )
}

SessionLogViewer.displayName = 'SessionLogViewer'

export default SessionLogViewer
