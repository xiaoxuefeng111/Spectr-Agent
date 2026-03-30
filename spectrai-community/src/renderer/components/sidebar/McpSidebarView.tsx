/**
 * MCP 工具侧边栏视图 - 展示 MCP 服务器列表并支持快速开关
 * @author weibin
 */

import { useState, useEffect } from 'react'
import { Settings, Plug } from 'lucide-react'
import { useMcpStore } from '../../stores/mcpStore'

export default function McpSidebarView() {
  const servers = useMcpStore(s => s.servers)
  const fetchAll = useMcpStore(s => s.fetchAll)
  const toggle = useMcpStore(s => s.toggle)
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  const openSettings = () =>
    window.dispatchEvent(new CustomEvent('open-settings-tab', { detail: 'mcp' }))

  const filtered = servers.filter(
    (m) =>
      m.name.toLowerCase().includes(search.toLowerCase()) ||
      m.category.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="flex flex-col h-full overflow-hidden select-none">
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-1.5">
          <Plug className="w-3.5 h-3.5 text-text-muted" />
          <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
            MCP 工具
          </span>
        </div>
        <button
          onClick={openSettings}
          title="打开 MCP 管理"
          className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-text-secondary transition-colors"
        >
          <Settings className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 搜索框 */}
      <div className="px-2 py-1.5 shrink-0">
        <input
          type="text"
          placeholder="搜索 MCP..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-2 py-1 text-xs rounded border border-border bg-bg-secondary text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-blue"
        />
      </div>

      {/* 列表区域 */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-text-muted">
            {search ? '未找到匹配的 MCP' : '暂无 MCP 工具'}
          </div>
        ) : (
          <div className="space-y-0.5 py-1">
            {filtered.map((mcp) => (
              <div
                key={mcp.id}
                className="flex items-center gap-2 px-3 py-1.5 hover:bg-bg-hover transition-colors"
              >
                {/* 开关 */}
                <button
                  onClick={() => toggle(mcp.id, !mcp.isGlobalEnabled)}
                  disabled={!mcp.isInstalled}
                  title={
                    !mcp.isInstalled
                      ? '未安装，无法启用'
                      : mcp.isGlobalEnabled
                        ? '点击禁用'
                        : '点击启用'
                  }
                  className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                    mcp.isGlobalEnabled
                      ? 'bg-accent-blue'
                      : 'bg-bg-tertiary'
                  }`}
                >
                  <span
                    className={`inline-block h-3 w-3 rounded-full bg-white shadow transition-transform ${
                      mcp.isGlobalEnabled ? 'translate-x-3.5' : 'translate-x-0.5'
                    }`}
                  />
                </button>

                {/* 信息 */}
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-text-primary truncate">
                    {mcp.name}
                  </div>
                  <div className="text-[10px] text-text-muted truncate">{mcp.category}</div>
                </div>

                {/* 未安装标记 */}
                {!mcp.isInstalled && (
                  <span className="text-[10px] text-accent-yellow shrink-0">未安装</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 底部操作 */}
      <div className="shrink-0 px-2 pb-2 border-t border-border pt-2">
        <button
          onClick={openSettings}
          className="w-full py-1.5 text-xs rounded border border-border hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
        >
          管理所有 MCP →
        </button>
      </div>
    </div>
  )
}
