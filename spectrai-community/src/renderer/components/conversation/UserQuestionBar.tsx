/**
 * AI 交互式提问栏
 *
 * 当 AI 的回复中检测到问题+选项时，在对话底部展示此组件：
 * - 有选项（2-6个）→ 显示可点击的选项按钮组
 * - 同时提供自定义输入框，允许输入任意答案
 * - 无选项 → 仅显示输入框（带高亮提示）
 *
 * 用户点击按钮或提交输入后，调用 onAnswer() 发送消息给 AI。
 *
 * @author weibin
 */

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { MessageSquare, ChevronRight, CornerDownLeft } from 'lucide-react'

interface UserQuestionBarProps {
  /** 问题文本 */
  question: string
  /** 选项列表，null 表示只显示输入框 */
  options: string[] | null
  /** 用户作出回答时的回调（发送消息给 AI） */
  onAnswer: (answer: string) => void
  /** 是否禁用（AI 正在思考中） */
  disabled?: boolean
}

const UserQuestionBar: React.FC<UserQuestionBarProps> = ({
  question,
  options,
  onAnswer,
  disabled = false,
}) => {
  const [customInput, setCustomInput] = useState('')
  const [answered, setAnswered] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // 组件出现时自动聚焦输入框（无选项时更重要）
  useEffect(() => {
    if (!options || options.length === 0) {
      inputRef.current?.focus()
    }
  }, [options])

  const handleAnswer = useCallback((answer: string) => {
    if (!answer.trim() || disabled || answered) return
    setAnswered(true)
    onAnswer(answer.trim())
  }, [disabled, answered, onAnswer])

  const handleOptionClick = useCallback((option: string) => {
    handleAnswer(option)
  }, [handleAnswer])

  const handleCustomSubmit = useCallback((e?: React.FormEvent) => {
    e?.preventDefault()
    handleAnswer(customInput)
  }, [customInput, handleAnswer])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleCustomSubmit()
    }
  }, [handleCustomSubmit])

  // 已回答后淡出（等待父组件移除）
  if (answered) return null

  return (
    <div className="flex justify-center my-3 px-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div
        className="w-full max-w-2xl rounded-xl border border-accent-blue/30 bg-accent-blue/5 overflow-hidden shadow-sm"
        style={{ backdropFilter: 'blur(8px)' }}
      >
        {/* 标题栏 */}
        <div className="flex items-center gap-2 px-4 py-2.5 bg-accent-blue/10 border-b border-accent-blue/20">
          <MessageSquare className="w-3.5 h-3.5 text-accent-blue flex-shrink-0" />
          <span className="text-xs font-medium text-accent-blue">需要您的选择</span>
          <span className="flex-1 text-xs text-text-secondary truncate ml-1" title={question}>
            {question}
          </span>
        </div>

        <div className="px-4 py-3 space-y-3">
          {/* 选项按钮组 */}
          {options && options.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {options.map((opt, idx) => (
                <button
                  key={idx}
                  onClick={() => handleOptionClick(opt)}
                  disabled={disabled}
                  className={[
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm',
                    'border border-border bg-bg-secondary text-text-primary',
                    'hover:border-accent-blue/60 hover:bg-accent-blue/10 hover:text-accent-blue',
                    'transition-all duration-150 active:scale-95',
                    'disabled:opacity-40 disabled:cursor-not-allowed',
                    'focus:outline-none focus:ring-1 focus:ring-accent-blue/50',
                  ].join(' ')}
                  title={opt}
                >
                  {/* 序号标识 */}
                  <span className="flex-shrink-0 w-4 h-4 rounded text-[10px] font-bold flex items-center justify-center bg-bg-tertiary text-text-muted">
                    {idx + 1}
                  </span>
                  <span className="max-w-[240px] truncate">{opt}</span>
                </button>
              ))}
            </div>
          )}

          {/* 自定义输入框 */}
          <form onSubmit={handleCustomSubmit} className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={customInput}
              onChange={e => setCustomInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              placeholder={options && options.length > 0 ? '或输入自定义答案...' : '请输入您的答案...'}
              className={[
                'flex-1 h-8 px-3 rounded-lg text-sm',
                'bg-bg-secondary border border-border',
                'text-text-primary placeholder:text-text-muted',
                'focus:outline-none focus:border-accent-blue/60 focus:ring-1 focus:ring-accent-blue/30',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                'transition-colors duration-150',
              ].join(' ')}
            />
            <button
              type="submit"
              disabled={!customInput.trim() || disabled}
              className={[
                'flex items-center gap-1 px-3 h-8 rounded-lg text-xs font-medium',
                'bg-accent-blue/20 text-accent-blue border border-accent-blue/30',
                'hover:bg-accent-blue/30 hover:border-accent-blue/50',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                'transition-all duration-150 active:scale-95',
                'focus:outline-none focus:ring-1 focus:ring-accent-blue/50',
              ].join(' ')}
              title="发送 (Enter)"
            >
              <span>发送</span>
              <div className="flex items-center gap-0.5 opacity-60">
                <CornerDownLeft className="w-3 h-3" />
              </div>
            </button>
          </form>
        </div>

        {/* 底部提示 */}
        {options && options.length > 0 && (
          <div className="px-4 pb-2.5 flex items-center gap-1 text-[10px] text-text-muted">
            <ChevronRight className="w-3 h-3 opacity-50" />
            <span>点击选项按钮快速回复，或在输入框中自定义答案</span>
          </div>
        )}
      </div>
    </div>
  )
}

UserQuestionBar.displayName = 'UserQuestionBar'
export default UserQuestionBar
