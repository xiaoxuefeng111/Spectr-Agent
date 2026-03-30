/**
 * Activity Bar - 左侧功能图标条（VSCode 风格）
 *
 * 面板系统：
 *   - 上半区（左侧指示条）→ 控制左侧边栏
 *   - 下半区（右侧指示条）→ 控制右侧面板
 *   - 拖拽图标可在两区之间移动（改变面板所在侧）
 *   - 右键图标弹出快捷菜单（移到另一侧）
 *
 * @author weibin
 */

import { useState, useEffect } from 'react'
import { Bot, FolderTree, GitBranch, BarChart2, Settings, Activity, PieChart, Plug, Zap } from 'lucide-react'
import type { PanelId, PanelSide } from '../../stores/uiStore'
import { useUIStore } from '../../stores/uiStore'

/** 普通面板（不含 team —— team 由独立的固定按钮处理） */
const PANEL_DEFS: {
  id: PanelId
  icon: React.ElementType
  label: string
  disabled?: boolean
}[] = [
  { id: 'sessions',  icon: Bot,        label: '会话管理' },
  { id: 'explorer',  icon: FolderTree, label: '文件资源管理器' },
  { id: 'git',       icon: GitBranch,  label: 'Git 分支' },
  { id: 'dashboard', icon: BarChart2,  label: '监控看板' },
  { id: 'timeline',  icon: Activity,   label: '时间线' },
  { id: 'stats',     icon: PieChart,   label: '统计' },
  { id: 'mcp' as PanelId,    icon: Plug,  label: 'MCP 工具' },
  { id: 'skills' as PanelId, icon: Zap,   label: '技能库' },
]

// ─────────────────────────────────────────────────────────────────────────────
// DropZone 必须定义在组件外部！
// 若定义在 ActivityBar 内部，每次 draggingId 状态变化触发重渲染时，
// React 会将其视为全新组件类型而重新挂载 DOM，导致拖拽事件链断裂。
// ─────────────────────────────────────────────────────────────────────────────
interface DropZoneProps {
  side: PanelSide
  draggingId: PanelId | null
  dropZone: PanelSide | null
  panelSides: Record<PanelId, PanelSide>
  onDragOver: (side: PanelSide) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (side: PanelSide) => void
  children: React.ReactNode
}

function DropZone({ side, draggingId, dropZone, panelSides, onDragOver, onDragLeave, onDrop, children }: DropZoneProps) {
  const isTarget = draggingId !== null && dropZone === side && panelSides[draggingId] !== side
  return (
    <div
      className={[
        'flex flex-col items-center gap-0.5 w-full px-1 rounded-md py-0.5 transition-colors min-h-[2rem]',
        isTarget ? 'bg-accent-blue/10 ring-1 ring-inset ring-accent-blue/40' : '',
      ].join(' ')}
      onDragOver={(e) => { e.preventDefault(); onDragOver(side) }}
      onDragLeave={onDragLeave}
      onDrop={(e) => { e.preventDefault(); onDrop(side) }}
    >
      {children}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

interface ActivityBarProps {
  onOpenSettings: () => void
}

export default function ActivityBar({ onOpenSettings }: ActivityBarProps) {
  const panelSides          = useUIStore(s => s.panelSides)
  const activePanelLeft     = useUIStore(s => s.activePanelLeft)
  const activePanelRight    = useUIStore(s => s.activePanelRight)
  const setPanelSide        = useUIStore(s => s.setPanelSide)
  const setActivePanelLeft  = useUIStore(s => s.setActivePanelLeft)
  const setActivePanelRight = useUIStore(s => s.setActivePanelRight)
  // 拖拽状态
  const [draggingId, setDraggingId] = useState<PanelId | null>(null)
  const [dropZone, setDropZone]     = useState<PanelSide | null>(null)

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{ id: PanelId; x: number; y: number } | null>(null)

  // 点击任意位置关闭右键菜单
  useEffect(() => {
    if (!contextMenu) return
    const handler = () => setContextMenu(null)
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [contextMenu])

  const leftPanels  = PANEL_DEFS.filter(p => panelSides[p.id] === 'left')
  const rightPanels = PANEL_DEFS.filter(p => panelSides[p.id] === 'right')

  /** 处理拖放：将面板移到目标侧 */
  const handleDrop = (targetSide: PanelSide) => {
    if (draggingId && panelSides[draggingId] !== targetSide) {
      setPanelSide(draggingId, targetSide)
    }
    setDraggingId(null)
    setDropZone(null)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropZone(null)
    }
  }

  /** 渲染单个面板图标按钮 */
  const renderButton = (
    { id, icon: Icon, label, disabled }: typeof PANEL_DEFS[0],
    side: PanelSide
  ) => {
    const isActive   = side === 'left' ? activePanelLeft === id : activePanelRight === id
    const isDragging = draggingId === id

    return (
      <button
        key={id}
        title={disabled ? `${label}（即将推出）` : label}
        disabled={disabled}
        draggable={!disabled}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          // setTimeout 0：避免 setState 触发的重渲染干扰 dragstart 事件初始化
          setTimeout(() => setDraggingId(id), 0)
        }}
        onDragEnd={() => {
          setDraggingId(null)
          setDropZone(null)
        }}
        onClick={() => {
          if (disabled) return
          if (side === 'left') setActivePanelLeft(id)
          else setActivePanelRight(id)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          if (!disabled) setContextMenu({ id, x: e.clientX, y: e.clientY })
        }}
        className={[
          'relative w-full h-9 flex items-center justify-center rounded-md transition-colors select-none',
          isDragging ? 'opacity-30' : '',
          isActive
            ? 'text-accent-blue bg-bg-hover'
            : disabled
            ? 'text-text-muted opacity-30 cursor-not-allowed'
            : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover cursor-grab active:cursor-grabbing',
        ].join(' ')}
      >
        {/* 激活指示竖条：左侧区 → 左边；右侧区 → 右边（镜像） */}
        {isActive && (
          <span
            className={[
              'absolute top-1.5 bottom-1.5 w-0.5 bg-accent-blue',
              side === 'left' ? 'left-0 rounded-r' : 'right-0 rounded-l',
            ].join(' ')}
          />
        )}
        <Icon className="w-4 h-4" />
      </button>
    )
  }

  return (
    <div className="flex flex-col items-center w-11 shrink-0 h-full bg-bg-secondary border-r border-border py-2 z-10">

      {/* 上半区：控制左侧边栏 */}
      <DropZone
        side="left"
        draggingId={draggingId}
        dropZone={dropZone}
        panelSides={panelSides}
        onDragOver={setDropZone}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {leftPanels.length > 0
          ? leftPanels.map(p => renderButton(p, 'left'))
          : draggingId
          ? <div className="w-full h-8 flex items-center justify-center text-accent-blue/50 text-[10px]">放这里</div>
          : null
        }
      </DropZone>

      {/* 分隔线：拖拽时高亮，暗示可跨区拖放 */}
      <div className={[
        'w-6 border-t my-2 transition-colors',
        draggingId ? 'border-accent-blue/50' : 'border-border',
      ].join(' ')} />

      {/* 下半区：控制右侧面板 */}
      <DropZone
        side="right"
        draggingId={draggingId}
        dropZone={dropZone}
        panelSides={panelSides}
        onDragOver={setDropZone}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {rightPanels.length > 0
          ? rightPanels.map(p => renderButton(p, 'right'))
          : draggingId
          ? <div className="w-full h-8 flex items-center justify-center text-accent-blue/50 text-[10px]">放这里</div>
          : null
        }
      </DropZone>

      {/* 弹性空间，把设置按钮推到底部 */}
      <div className="flex-1" />

      {/* 分隔线 */}
      <div className="w-6 border-t border-border mb-1" />

      {/* 设置按钮（固定底部，直接触发弹窗） */}
      <div className="px-1 w-full">
        <button
          title="设置"
          onClick={onOpenSettings}
          className="w-full h-9 flex items-center justify-center rounded-md text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>

      {/* 右键上下文菜单 */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-bg-secondary border border-border rounded-md shadow-lg py-1 text-xs min-w-[148px]"
          style={{ top: contextMenu.y, left: contextMenu.x + 4 }}
          onClick={e => e.stopPropagation()}
        >
          <button
            className="w-full px-3 py-1.5 text-left text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
            onClick={() => {
              const cur = panelSides[contextMenu.id]
              setPanelSide(contextMenu.id, cur === 'left' ? 'right' : 'left')
              setContextMenu(null)
            }}
          >
            {panelSides[contextMenu.id] === 'left' ? '移到右侧面板 →' : '← 移到左侧边栏'}
          </button>
          <button
            className="w-full px-3 py-1.5 text-left text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors"
            onClick={() => setContextMenu(null)}
          >
            取消
          </button>
        </div>
      )}
    </div>
  )
}
