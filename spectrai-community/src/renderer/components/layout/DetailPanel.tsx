/**
 * 右侧详情面板
 * 通过面板位置系统决定渲染哪个面板（默认 timeline / stats，
 * 也可展示从左侧拖过来的任何面板）
 * @author weibin
 */

import { FolderTree } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import TimelinePanel from '../panels/TimelinePanel'
import StatsPanel from '../panels/StatsPanel'
import { SessionsContent } from './Sidebar'
import DashboardSidebarView from '../sidebar/DashboardSidebarView'
import ComingSoonView from '../sidebar/ComingSoonView'
import GitPanel from '../panels/GitPanel'


export default function DetailPanel() {
  const activePanelRight = useUIStore(s => s.activePanelRight)

  /** 根据 activePanelRight 渲染对应面板内容 */
  const renderContent = () => {
    switch (activePanelRight) {
      case 'timeline':  return <TimelinePanel />
      case 'stats':     return <StatsPanel />
      // 左侧面板移到右侧时渲染
      case 'sessions':  return <SessionsContent />
      case 'dashboard': return <DashboardSidebarView />
      case 'explorer':  return <ComingSoonView icon={FolderTree} label="文件资源管理器" />
      case 'git':       return <GitPanel />
      default:          return <TimelinePanel />
    }
  }

  return (
    <div className="flex flex-col h-full bg-bg-secondary border-l border-border">
      {/* 内容区（由面板位置系统控制） */}
      <div className="flex-1 overflow-hidden">
        {renderContent()}
      </div>
    </div>
  )
}
