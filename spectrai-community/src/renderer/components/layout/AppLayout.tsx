/**
 * 应用主布局 - 三栏分栏布局
 * @author weibin
 */

import { useState, useEffect } from 'react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import Sidebar from './Sidebar'
import MainPanel from './MainPanel'
import DetailPanel from './DetailPanel'
import StatusBar from './StatusBar'
import SearchPanel from './SearchPanel'
import HistoryPanel from './HistoryPanel'
import LogViewer from '../common/LogViewer'
import NewTaskDialog from '../kanban/NewTaskDialog'
import { useUIStore } from '../../stores/uiStore'
import ActivityBar from './ActivityBar'
import TitleBar from './TitleBar'
import UnifiedSettingsModal from '../settings/UnifiedSettingsModal'

export default function AppLayout() {
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
  const detailPanelCollapsed = useUIStore((s) => s.detailPanelCollapsed)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const toggleDetailPanel = useUIStore((s) => s.toggleDetailPanel)
  const showSearchPanel = useUIStore((s) => s.showSearchPanel)
  const showHistoryPanel = useUIStore((s) => s.showHistoryPanel)
  const showLogViewer = useUIStore((s) => s.showLogViewer)

  const [showSettings, setShowSettings] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<string | undefined>()

  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent<string>).detail
      setSettingsInitialTab(tab)
      setShowSettings(true)
    }
    window.addEventListener('open-settings-tab', handler)
    return () => window.removeEventListener('open-settings-tab', handler)
  }, [])

  return (
    <div className="flex flex-col h-screen bg-bg-primary">
      <TitleBar />
      <div className="flex-1 overflow-hidden flex">
        <ActivityBar onOpenSettings={() => setShowSettings(true)} />

        <div className="flex-1 overflow-hidden relative">
            <Allotment>
              {!sidebarCollapsed && (
                <Allotment.Pane preferredSize={280} minSize={200} maxSize={400}>
                  <Sidebar />
                </Allotment.Pane>
              )}

              <Allotment.Pane>
                <div className="relative h-full">
                  <MainPanel />

                  <button
                    onClick={toggleSidebar}
                    className="panel-toggle-btn left-0 rounded-r-md"
                    title={sidebarCollapsed ? '展开左侧面板' : '收起左侧面板'}
                  >
                    {sidebarCollapsed ? (
                      <ChevronRight className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronLeft className="w-3.5 h-3.5" />
                    )}
                  </button>

                  <button
                    onClick={toggleDetailPanel}
                    className="panel-toggle-btn right-0 rounded-l-md"
                    title={detailPanelCollapsed ? '展开右侧面板' : '收起右侧面板'}
                  >
                    {detailPanelCollapsed ? (
                      <ChevronLeft className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              </Allotment.Pane>

              {!detailPanelCollapsed && (
                <Allotment.Pane preferredSize={300} minSize={200} maxSize={500}>
                  <DetailPanel />
                </Allotment.Pane>
              )}
            </Allotment>
          </div>
      </div>

      <StatusBar />
      {showSearchPanel && <SearchPanel />}
      {showHistoryPanel && <HistoryPanel />}
      {showLogViewer && <LogViewer />}
      <NewTaskDialog />

      {showSettings && (
        <UnifiedSettingsModal
          initialTab={settingsInitialTab}
          onClose={() => {
            setShowSettings(false)
            setSettingsInitialTab(undefined)
          }}
        />
      )}
    </div>
  )
}
