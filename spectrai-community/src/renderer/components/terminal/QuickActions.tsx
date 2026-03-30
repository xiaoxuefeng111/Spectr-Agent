/**
 * 终端快捷操作浮层
 * 用于确认操作（接受/拒绝）
 * @author weibin
 */

import React from 'react'
import { Check, X } from 'lucide-react'

interface QuickActionsProps {
  sessionId: string
  visible: boolean
  onConfirm: (accept: boolean) => void
}

const QuickActions: React.FC<QuickActionsProps> = ({ visible, onConfirm }) => {
  if (!visible) return null

  return (
    <div className="absolute bottom-0 left-0 right-0 bg-black/80 backdrop-blur-sm p-3 flex items-center justify-center gap-3 animate-fade-in">
      <button
        onClick={() => onConfirm(true)}
        className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-md transition-colors font-medium"
      >
        <Check size={16} />
        <span>确认 (Y)</span>
      </button>
      <button
        onClick={() => onConfirm(false)}
        className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-md transition-colors font-medium"
      >
        <X size={16} />
        <span>拒绝 (N)</span>
      </button>
    </div>
  )
}

export default QuickActions
