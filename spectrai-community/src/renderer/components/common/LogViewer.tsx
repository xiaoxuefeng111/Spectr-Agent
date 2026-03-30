/**
 * 日志查看器 - 右侧滑入面板，显示主进程日志
 * @author weibin
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { X, RefreshCw, ExternalLink, ScrollText } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'

type LogLevel = 'all' | 'error' | 'warn' | 'info' | 'debug'

const LEVEL_LABELS: Record<LogLevel, string> = {
  all: '全部',
  error: 'Error',
  warn: 'Warn',
  info: 'Info',
  debug: 'Debug',
}

function getLineLevel(line: string): LogLevel {
  const lower = line.toLowerCase()
  if (lower.includes('[error]')) return 'error'
  if (lower.includes('[warn]')) return 'warn'
  if (lower.includes('[info]')) return 'info'
  if (lower.includes('[debug]')) return 'debug'
  return 'info'
}

function getLineColor(level: LogLevel): string {
  switch (level) {
    case 'error': return 'text-accent-red'
    case 'warn': return 'text-accent-yellow'
    case 'debug': return 'text-text-muted'
    default: return 'text-text-primary'
  }
}

export default function LogViewer() {
  const { toggleLogViewer } = useUIStore()
  const [lines, setLines] = useState<string[]>([])
  const [filter, setFilter] = useState<LogLevel>('all')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.spectrAI.log.getRecent(300)
      setLines(result || [])
    } catch (err) {
      console.error('[LogViewer] Failed to fetch logs:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  // 初次加载 + 定时刷新
  useEffect(() => {
    fetchLogs()
    timerRef.current = setInterval(fetchLogs, 3000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [fetchLogs])

  // 新日志到达时自动滚到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines])

  // ESC 关闭
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') toggleLogViewer()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [toggleLogViewer])

  const filteredLines = filter === 'all'
    ? lines
    : lines.filter(l => getLineLevel(l) === filter)

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-[480px] flex flex-col bg-bg-secondary border-l border-border shadow-2xl">
      {/* 顶部栏 */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
        <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
          <ScrollText className="w-4 h-4 text-accent-blue" />
          <span>应用日志</span>
          {loading && <RefreshCw className="w-3 h-3 animate-spin text-text-muted" />}
        </div>
        <div className="flex items-center gap-2">
          {/* 级别过滤 */}
          <div className="flex items-center gap-0.5 bg-bg-tertiary rounded px-1">
            {(Object.keys(LEVEL_LABELS) as LogLevel[]).map(level => (
              <button
                key={level}
                onClick={() => setFilter(level)}
                className={`px-2 py-1 rounded text-xs btn-transition ${
                  filter === level
                    ? 'bg-accent-blue text-white'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {LEVEL_LABELS[level]}
              </button>
            ))}
          </div>
          {/* 手动刷新 */}
          <button
            onClick={fetchLogs}
            className="p-1.5 rounded btn-transition text-text-secondary hover:text-text-primary"
            title="刷新"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          {/* 在系统编辑器中打开 */}
          <button
            onClick={() => window.spectrAI.log.openFile()}
            className="p-1.5 rounded btn-transition text-text-secondary hover:text-text-primary"
            title="用系统编辑器打开日志文件"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
          {/* 关闭 */}
          <button
            onClick={toggleLogViewer}
            className="p-1.5 rounded btn-transition text-text-secondary hover:text-text-primary"
            title="关闭 (Esc)"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 日志内容 */}
      <div className="flex-1 overflow-y-auto p-3 font-mono text-xs leading-relaxed">
        {filteredLines.length === 0 ? (
          <div className="text-text-muted text-center mt-8">
            {lines.length === 0 ? '暂无日志（启动后将自动刷新）' : '当前过滤器无匹配日志'}
          </div>
        ) : (
          filteredLines.map((line, i) => {
            const level = getLineLevel(line)
            return (
              <div key={i} className={`py-0.5 break-all ${getLineColor(level)}`}>
                {line}
              </div>
            )
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* 底部信息 */}
      <div className="px-4 py-1.5 border-t border-border text-xs text-text-muted shrink-0 flex justify-between">
        <span>共 {filteredLines.length} 条</span>
        <span>每 3 秒自动刷新</span>
      </div>
    </div>
  )
}
