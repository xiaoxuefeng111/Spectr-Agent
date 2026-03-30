/**
 * 跨会话上下文引用对话框
 * 允许用户选择其他会话的 AI 回答内容，注入到当前会话输入
 * @author weibin
 */

import { useState, useEffect } from 'react'
import { X, FileText, Check } from 'lucide-react'

interface SessionSummary {
  id: number
  sessionId: string
  sessionName: string
  sessionStatus: string
  type: string
  content: string
  createdAt: string
}

interface Props {
  currentSessionId: string
  onInsert: (text: string) => void
  onClose: () => void
}

export default function ContextRefDialog({ currentSessionId, onInsert, onClose }: Props) {
  const [summaries, setSummaries] = useState<SessionSummary[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadSummaries()
  }, [])

  const loadSummaries = async () => {
    try {
      const data = await window.spectrAI.summary.getAllSessions()
      // 过滤掉当前会话
      setSummaries(data.filter((s: SessionSummary) => s.sessionId !== currentSessionId))
    } catch (err) {
      console.error('Failed to load summaries:', err)
    } finally {
      setLoading(false)
    }
  }

  const toggleSelect = (id: number) => {
    const next = new Set(selected)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    setSelected(next)
  }

  const handleInsert = () => {
    const selectedSummaries = summaries.filter(s => selected.has(s.id))
    if (selectedSummaries.length === 0) return

    const text = selectedSummaries.map(s => {
      const preview = s.content.length > 2000 ? s.content.slice(0, 2000) + '...' : s.content
      return `[引用自: ${s.sessionName}]\n---\n${preview}\n---`
    }).join('\n\n')

    onInsert(text)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-bg-secondary rounded-lg shadow-2xl w-full max-w-lg border border-border max-h-[70vh] flex flex-col">
        {/* 头部 */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-accent-blue" />
            <h3 className="text-sm font-semibold text-text-primary">引用其他会话的 AI 回答</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-bg-hover text-text-muted">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {loading ? (
            <div className="text-xs text-text-muted text-center py-8">加载中...</div>
          ) : summaries.length === 0 ? (
            <div className="text-xs text-text-muted text-center py-8">
              暂无可引用的会话内容
              <br />
              <span className="text-[10px]">其他会话的 AI 回答会自动保存到这里</span>
            </div>
          ) : (
            summaries.map(s => {
              const isSelected = selected.has(s.id)
              const preview = s.content.length > 200 ? s.content.slice(0, 200) + '...' : s.content
              return (
                <button
                  key={s.id}
                  onClick={() => toggleSelect(s.id)}
                  className={`w-full text-left p-3 rounded border btn-transition ${
                    isSelected
                      ? 'bg-accent-blue/10 border-accent-blue/40'
                      : 'bg-bg-primary border-border hover:border-accent-blue/30'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      {isSelected && <Check className="w-3.5 h-3.5 text-accent-blue" />}
                      <span className="text-xs font-medium text-text-primary">{s.sessionName}</span>
                    </div>
                    <span className="text-[10px] text-text-muted">
                      {new Date(s.createdAt).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', month: '2-digit', day: '2-digit' })}
                    </span>
                  </div>
                  <p className="text-[11px] text-text-secondary leading-relaxed line-clamp-3">
                    {preview}
                  </p>
                  <div className="text-[10px] text-text-muted mt-1">
                    {(s.content.length / 1000).toFixed(1)}KB
                  </div>
                </button>
              )
            })
          )}
        </div>

        {/* 底部 */}
        <div className="flex items-center justify-between p-3 border-t border-border">
          <span className="text-[10px] text-text-muted">
            已选 {selected.size} 项
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs bg-bg-hover hover:bg-bg-tertiary text-text-secondary rounded btn-transition"
            >
              取消
            </button>
            <button
              onClick={handleInsert}
              disabled={selected.size === 0}
              className="px-3 py-1.5 text-xs bg-accent-blue text-white rounded btn-transition hover:bg-opacity-90 disabled:opacity-50"
            >
              插入引用
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
