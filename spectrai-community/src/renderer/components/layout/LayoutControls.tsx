/**
 * 中间区域布局切换按钮组
 * @author weibin
 */

import { Square, PanelsLeftRight, PanelsTopBottom, ArrowLeftRight, ArrowUpDown } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import type { LayoutMode } from '../../../shared/types'

export default function LayoutControls() {
  const { layoutMode, setLayoutMode, swapPanes } = useUIStore()

  const buttons: Array<{ mode: LayoutMode; icon: React.ElementType; title: string }> = [
    { mode: 'single',  icon: Square,          title: '单窗格' },
    { mode: 'split-h', icon: PanelsLeftRight,  title: '左右分栏' },
    { mode: 'split-v', icon: PanelsTopBottom,  title: '上下分栏' },
  ]

  const isSplit = layoutMode !== 'single'
  const SwapIcon = layoutMode === 'split-v' ? ArrowUpDown : ArrowLeftRight

  return (
    <div className="flex items-center gap-0.5">
      {isSplit && (
        <button
          onClick={swapPanes}
          title={layoutMode === 'split-v' ? '交换上下内容' : '交换左右内容'}
          className="p-1 rounded transition-colors text-gray-500 hover:text-gray-300 hover:bg-gray-700/50"
        >
          <SwapIcon size={13} />
        </button>
      )}
      {buttons.map(({ mode, icon: Icon, title }) => (
        <button
          key={mode}
          onClick={() => setLayoutMode(mode)}
          title={title}
          className={`p-1 rounded transition-colors ${
            layoutMode === mode
              ? 'text-blue-400 bg-blue-400/10'
              : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700/50'
          }`}
        >
          <Icon size={13} />
        </button>
      ))}
    </div>
  )
}
