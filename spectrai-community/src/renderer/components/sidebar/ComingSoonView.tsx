/**
 * 即将推出占位视图 - 用于 Activity Bar 中尚未实现的功能
 * @author weibin
 */

import type { LucideIcon } from 'lucide-react'
import { Clock } from 'lucide-react'

interface ComingSoonViewProps {
  /** lucide-react 图标组件 */
  icon: LucideIcon
  /** 功能名称 */
  label: string
  /** 预计上线说明 */
  eta?: string
}

export default function ComingSoonView({ icon: Icon, label, eta = '规划中' }: ComingSoonViewProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 px-4 text-center select-none">
      <div className="w-14 h-14 rounded-xl bg-bg-secondary flex items-center justify-center border border-border">
        <Icon className="w-6 h-6 text-text-muted" />
      </div>
      <div>
        <p className="text-sm font-medium text-text-secondary">{label}</p>
        <div className="mt-1.5 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-bg-secondary border border-border">
          <Clock className="w-3 h-3 text-text-muted" />
          <span className="text-xs text-text-muted">{eta}</span>
        </div>
      </div>
    </div>
  )
}
