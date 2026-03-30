/**
 * 通用确认对话框 - 替代原生 confirm()
 * @author weibin
 */

import React, { useEffect, useRef } from 'react'
import { AlertTriangle } from 'lucide-react'

interface ConfirmDialogProps {
  open: boolean
  title?: string
  message: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title = '确认操作',
  message,
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
  onConfirm,
  onCancel,
}) => {
  const confirmBtnRef = useRef<HTMLButtonElement>(null)

  // 打开时聚焦确认按钮，并监听 Escape
  useEffect(() => {
    if (!open) return
    confirmBtnRef.current?.focus()

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={onCancel}
    >
      <div
        className="bg-bg-secondary rounded-lg shadow-2xl w-full max-w-sm border border-border animate-slide-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center gap-3 p-4 border-b border-border">
          <div className={`p-2 rounded-lg ${danger ? 'bg-accent-red/10' : 'bg-accent-yellow/10'}`}>
            <AlertTriangle
              className={`w-5 h-5 ${danger ? 'text-accent-red' : 'text-accent-yellow'}`}
            />
          </div>
          <h2 className="text-base font-semibold text-text-primary">{title}</h2>
        </div>

        {/* 内容 */}
        <div className="px-4 py-5">
          <p className="text-sm text-text-secondary leading-relaxed">{message}</p>
        </div>

        {/* 按钮 */}
        <div className="flex justify-end gap-3 px-4 pb-4">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium rounded bg-bg-hover hover:bg-bg-tertiary text-text-secondary btn-transition"
          >
            {cancelText}
          </button>
          <button
            ref={confirmBtnRef}
            onClick={onConfirm}
            className={`px-4 py-2 text-sm font-medium rounded text-white btn-transition ${
              danger
                ? 'bg-accent-red hover:bg-red-600'
                : 'bg-accent-blue hover:bg-blue-600'
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

ConfirmDialog.displayName = 'ConfirmDialog'

export default ConfirmDialog
