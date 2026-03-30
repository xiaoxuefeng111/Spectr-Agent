/**
 * GroupByToggle — 分组方式切换 Toggle（时间/目录/工作区）
 * @author weibin
 */
import React from 'react'
import { Clock, FolderOpen, Layers } from 'lucide-react'
import type { GroupByMode } from './types'

export const GroupByToggle = React.memo(function GroupByToggle({ value, onChange }: {
  value: GroupByMode
  onChange: (v: GroupByMode) => void
}) {
  const options: { key: GroupByMode; label: string; icon: React.ReactNode }[] = [
    { key: 'time',      label: '时间',   icon: <Clock className="w-3 h-3" /> },
    { key: 'directory', label: '目录',   icon: <FolderOpen className="w-3 h-3" /> },
    { key: 'workspace', label: '工作区', icon: <Layers className="w-3 h-3" /> },
  ]
  return (
    <div className="flex items-center gap-0.5 p-0.5 bg-bg-primary rounded border border-border">
      {options.map(opt => (
        <button
          key={opt.key}
          onClick={() => onChange(opt.key)}
          className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] btn-transition flex-1 justify-center ${
            value === opt.key
              ? 'bg-accent-blue/20 text-accent-blue font-medium'
              : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover'
          }`}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  )
})
