/**
 * 中间主面板 - 根据视图模式切换显示，支持单/双窗格布局
 *
 * 关键设计：单窗格模式下，会话视图和文件视图【始终保持挂载】，
 * 通过 CSS display 切换可见性，而非条件渲染。
 * 原因：xterm.js 终端组件重新挂载需要重新 attach DOM，
 * 若卸载后再挂载会出现短暂空白，用户误以为点击无效。
 * @author weibin
 */

import { Allotment } from 'allotment'
// allotment/dist/style.css 已在 AppLayout.tsx 中全局引入，此处无需重复
import { useUIStore } from '../../stores/uiStore'
import { useSessionStore } from '../../stores/sessionStore'
import type { PaneContent } from '../../../shared/types'
import TerminalGrid from '../terminal/TerminalGrid'
import WelcomeTab from '../terminal/WelcomeTab'
import TerminalTabs from '../terminal/TerminalTabs'
import DashboardView from '../dashboard/DashboardView'
import KanbanBoard from '../kanban/KanbanBoard'
import { FilePane } from '../file-manager'
import MainPanelHeader from './MainPanelHeader'

// ─────────────────────────────────────────────────────────
// 会话内容视图（不含 files，仅用于始终挂载场景）
// ─────────────────────────────────────────────────────────

function SessionsView({ viewMode, hasSessions }: { viewMode: string; hasSessions: boolean }) {
  if (!hasSessions && viewMode !== 'dashboard' && viewMode !== 'kanban') {
    return <WelcomeTab />
  }

  switch (viewMode) {
    case 'grid':
      return <div className="h-full bg-bg-primary"><TerminalGrid /></div>
    case 'tabs':
      return <div className="h-full bg-bg-primary"><TerminalTabs /></div>
    case 'dashboard':
      return <div className="h-full bg-bg-primary"><DashboardView /></div>
    case 'kanban':
      return <div className="h-full bg-bg-primary"><KanbanBoard /></div>
    default:
      return null
  }
}

// ─────────────────────────────────────────────────────────
// 分栏模式用：按 content 渲染对应视图（允许卸载，分栏切换频率低）
// ─────────────────────────────────────────────────────────

function PaneView({ content, viewMode, hasSessions }: {
  content: PaneContent
  viewMode: string
  hasSessions: boolean
}) {
  if (content === 'files') {
    return <FilePane />
  }
  return <SessionsView viewMode={viewMode} hasSessions={hasSessions} />
}

// ─────────────────────────────────────────────────────────
// 主组件
// ─────────────────────────────────────────────────────────

export default function MainPanel() {
  const { viewMode, layoutMode, primaryPane, secondaryPane } = useUIStore()
  const { sessions } = useSessionStore()
  const hasSessions = sessions.length > 0

  // ── 单窗格模式：两个视图始终保持挂载，CSS 控制显示 ──
  if (layoutMode === 'single') {
    return (
      <div className="h-full flex flex-col">
        <MainPanelHeader />
        <div className="flex-1 min-h-0 relative">
          {/* 会话视图 - 始终挂载，切到文件时隐藏 */}
          <div
            className="absolute inset-0"
            style={{ display: primaryPane === 'sessions' ? 'flex' : 'none', flexDirection: 'column' }}
          >
            <SessionsView viewMode={viewMode} hasSessions={hasSessions} />
          </div>

          {/* 文件视图 - 始终挂载，切到会话时隐藏 */}
          <div
            className="absolute inset-0"
            style={{ display: primaryPane === 'files' ? 'flex' : 'none', flexDirection: 'column' }}
          >
            <FilePane />
          </div>
        </div>
      </div>
    )
  }

  // ── 分栏模式（左右 或 上下）──
  return (
    <div className="h-full flex flex-col">
      <MainPanelHeader />
      <div className="flex-1 min-h-0">
        <Allotment vertical={layoutMode === 'split-v'}>
          <Allotment.Pane minSize={150}>
            <PaneView content={primaryPane} viewMode={viewMode} hasSessions={hasSessions} />
          </Allotment.Pane>
          <Allotment.Pane minSize={150}>
            <PaneView content={secondaryPane} viewMode={viewMode} hasSessions={hasSessions} />
          </Allotment.Pane>
        </Allotment>
      </div>
    </div>
  )
}
