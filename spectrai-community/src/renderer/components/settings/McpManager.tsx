/**
 * MCP 服务器管理页面
 * 支持添加、编辑、删除、启用/停用 MCP 服务器
 * @author weibin
 */
import React, { useState, useEffect, useRef } from 'react'
import { useMcpStore } from '../../stores/mcpStore'
import type { McpServer } from '../../../shared/types'
import { isMacPlatform } from '../../utils/shortcut'

// 分类标签配置
const CATEGORIES = [
  { id: 'all',          label: '全部'   },
  { id: 'filesystem',   label: '文件系统' },
  { id: 'database',     label: '数据库'  },
  { id: 'web',          label: '网络'   },
  { id: 'code',         label: '代码'   },
  { id: 'productivity', label: '效率'   },
  { id: 'custom',       label: '自定义'  },
  { id: 'marketplace',  label: '🌐 市场' },
]

// Provider 显示映射（完整名称）
const PROVIDER_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'codex':       'Codex CLI',
  'gemini-cli':  'Gemini CLI',
  'iflow':       'iFlow',
  'opencode':    'OpenCode',
}

// Provider 兼容性徽章配置（样式 + Tooltip 说明）
const PROVIDER_BADGE_CONFIG: Record<string, { badgeClass: string; tooltip: string }> = {
  'claude-code': {
    badgeClass: 'bg-green-500/20 text-green-400',
    tooltip:    '原生 MCP 协议，完全支持',
  },
  'codex': {
    badgeClass: 'bg-green-500/20 text-green-400',
    tooltip:    '原生 MCP 协议，完全支持',
  },
  'iflow': {
    badgeClass: 'bg-green-500/20 text-green-400',
    tooltip:    '原生 MCP 协议，完全支持',
  },
  'gemini-cli': {
    badgeClass: 'bg-yellow-500/20 text-yellow-400',
    tooltip:    '通过 Prompt Injection 降级支持，工具调用稳定性受限',
  },
  'opencode': {
    badgeClass: 'bg-gray-500/20 text-gray-500 line-through',
    tooltip:    '此 Provider 暂不支持 MCP',
  },
}

// 全部 Provider 顺序
const ALL_PROVIDER_IDS = ['claude-code', 'codex', 'iflow', 'gemini-cli', 'opencode']

// 分类图标映射
const CATEGORY_ICONS: Record<string, string> = {
  filesystem:   '📁',
  database:     '🗄️',
  web:          '🌐',
  code:         '💻',
  productivity: '⚡',
  custom:       '🔧',
}

function getInstallSuggestionForCommand(command: string): string | null {
  const normalized = (command || '').trim().toLowerCase()
  const isWindows = typeof navigator !== 'undefined' && /Win/i.test(navigator.userAgent)

  if (normalized === 'uv' || normalized === 'uvx') {
    if (isMacPlatform()) return '推荐：brew install uv'
    if (isWindows) return '推荐：winget install --id=astral-sh.uv -e（或 py -m pip install uv）'
    return '推荐：curl -LsSf https://astral.sh/uv/install.sh | sh'
  }
  if (normalized === 'pip' || normalized === 'pip3') {
    return isWindows
      ? '若缺少 pip：py -m ensurepip --upgrade'
      : '若缺少 pip：python3 -m ensurepip --upgrade'
  }
  return null
}

export default function McpManager() {
  const { servers, loading, error, fetchAll, create, update, remove, toggle, testConnection, clearError } = useMcpStore()
  const [activeCategory, setActiveCategory] = useState('all')
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [editingServer, setEditingServer] = useState<McpServer | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message?: string; error?: string }>>({})
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [showInstallModal, setShowInstallModal] = useState<{ id: string; name: string } | null>(null)
  // 说明卡片展开状态（默认折叠）
  const [showMcpInfo, setShowMcpInfo] = useState(false)

  useEffect(() => { fetchAll() }, [])

  // 市场功能建设中，暂不从远端拉取

  const filteredServers = activeCategory === 'all'
    ? servers
    : servers.filter(s => s.category === activeCategory)

  const handleTestConnection = async (server: McpServer) => {
    setTestingId(server.id)
    const result = await testConnection(server.id)
    setTestResults(prev => ({ ...prev, [server.id]: result }))
    // 测试成功且未标记为已安装时，自动标记（适用于 exe/binary 类型）
    if (result.success && !server.isInstalled) {
      await update(server.id, { isInstalled: true })
    }
    setTestingId(null)
  }

  return (
    <div className="flex flex-col h-full">
      {/* 顶部：标题 + 添加按钮 */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-text-primary">MCP 服务</h2>
          <p className="text-xs text-text-muted mt-0.5">管理 Model Context Protocol 扩展工具服务器</p>
        </div>
        <button
          onClick={() => { setEditingServer(null); setShowAddDialog(true) }}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-md transition-colors"
        >
          + 添加 MCP
        </button>
      </div>

      {/* 折叠式说明卡片 */}
      <div className="mb-4 rounded-lg border border-blue-500/20 bg-blue-500/10 overflow-hidden">
        <button
          onClick={() => setShowMcpInfo(!showMcpInfo)}
          className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-blue-500/10 transition-colors"
        >
          <span className="text-sm font-medium text-blue-300">💡 什么是 MCP？</span>
          <span className="text-blue-400 text-xs select-none">{showMcpInfo ? '▲' : '▼'}</span>
        </button>
        {showMcpInfo && (
          <div className="px-4 pb-3 border-t border-blue-500/20">
            <p className="text-xs text-zinc-300 mt-2 leading-relaxed">
              MCP（Model Context Protocol）是 AI 助手的工具扩展系统。安装 MCP 后，AI 可以直接读取文件、查询数据库、搜索网络等。
            </p>
            <div className="mt-2 text-xs text-zinc-400 leading-relaxed">
              <span className="text-zinc-300 font-medium">注意：</span>并非所有 AI 都原生支持 MCP：
              <ul className="mt-1.5 space-y-1 ml-3">
                <li><span className="text-green-400">●</span>{' '}<span className="text-zinc-300">Claude Code / Codex / iFlow</span> → 完全支持</li>
                <li><span className="text-yellow-400">●</span>{' '}<span className="text-zinc-300">Gemini CLI</span> → 降级支持（通过 Prompt 描述工具）</li>
                <li><span className="text-gray-500">●</span>{' '}<span className="text-zinc-500">OpenCode</span> → 暂不支持</li>
              </ul>
            </div>
          </div>
        )}
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="mb-3 px-3 py-2 bg-accent-red/10 border border-accent-red/30 rounded-md text-accent-red text-sm flex items-center justify-between">
          <span>{error}</span>
          <button onClick={clearError} className="text-accent-red hover:text-accent-red">✕</button>
        </div>
      )}

      {/* 分类过滤 Tab */}
      <div className="flex gap-1 mb-4 border-b border-border">
        {CATEGORIES.map(cat => (
          <button
            key={cat.id}
            onClick={() => setActiveCategory(cat.id)}
            className={`px-3 py-1.5 text-xs rounded-t-md transition-colors ${
              activeCategory === cat.id
                ? 'text-blue-400 border-b-2 border-blue-500 -mb-px bg-transparent'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* MCP 列表 */}
      {activeCategory === 'marketplace' ? (
        <div className="flex-1 flex flex-col items-center justify-center text-text-muted gap-3">
          <div className="text-5xl">🚧</div>
          <div className="text-center">
            <div className="text-sm font-medium text-text-secondary mb-1">市场功能建设中</div>
            <div className="text-xs text-text-muted">更多 MCP 正在陆续接入，敬请期待</div>
          </div>
          <div className="mt-2 px-4 py-3 bg-bg-secondary border border-border rounded-lg max-w-xs w-full text-center">
            <div className="text-xs text-text-muted mb-2">现在您可以手动添加任意 MCP 服务器</div>
            <button
              onClick={() => { setEditingServer(null); setShowAddDialog(true) }}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded-md transition-colors"
            >
              + 手动添加 MCP
            </button>
          </div>
        </div>
      ) : (
        loading ? (
          <div className="flex-1 flex items-center justify-center text-text-muted text-sm">加载中...</div>
        ) : filteredServers.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-text-muted">
            <div className="text-4xl mb-3">🔌</div>
            <div className="text-sm">暂无 MCP 服务器</div>
            <div className="text-xs mt-1">点击"添加 MCP"开始配置</div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-2">
            {filteredServers.map(server => (
              <McpCard
                key={server.id}
                server={server}
                testResult={testResults[server.id]}
                testing={testingId === server.id}
                onToggle={(enabled) => toggle(server.id, enabled)}
                onEdit={() => { setEditingServer(server); setShowAddDialog(true) }}
                onDelete={() => remove(server.id)}
                onTest={() => handleTestConnection(server)}
                onInstall={() => setShowInstallModal({ id: server.id, name: server.name })}
                onMarkInstalled={() => update(server.id, { isInstalled: true })}
                onUpdateProviders={(providers) => update(server.id, {
                  enabledForProviders: providers ?? undefined
                })}
              />
            ))}
          </div>
        )
      )}

      {/* 添加/编辑弹窗 */}
      {showAddDialog && (
        <McpFormDialog
          server={editingServer}
          onClose={() => { setShowAddDialog(false); setEditingServer(null) }}
          onSave={async (data) => {
            if (editingServer) {
              await update(editingServer.id, data)
            } else {
              await create(data as any)
            }
            setShowAddDialog(false)
            setEditingServer(null)
          }}
        />
      )}
      {showInstallModal && (
        <InstallProgressModal
          mcpId={showInstallModal.id}
          mcpName={showInstallModal.name}
          onClose={() => { setShowInstallModal(null); fetchAll() }}
        />
      )}
    </div>
  )
}

// ── Provider 兼容性徽章（带 Tooltip） ──
function ProviderBadge({ providerId }: { providerId: string }) {
  const config = PROVIDER_BADGE_CONFIG[providerId]
  const label  = PROVIDER_LABELS[providerId] || providerId
  if (!config) return null

  return (
    <div className="relative group inline-block">
      <span className={`text-xs px-1.5 py-0.5 rounded cursor-default ${config.badgeClass}`}>
        {label}
      </span>
      {/* Tooltip */}
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-20 pointer-events-none shadow-lg">
        {config.tooltip}
        {/* 小三角 */}
        <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-zinc-700" />
      </div>
    </div>
  )
}

// ── MCP 卡片组件 ──
interface McpCardProps {
  server: McpServer
  testResult?: { success: boolean; message?: string; error?: string }
  testing: boolean
  onToggle: (enabled: boolean) => void
  onEdit: () => void
  onDelete: () => void
  onTest: () => void
  onInstall: () => void          // 触发自动安装进度弹窗（installMethod='npm' 时使用）
  onMarkInstalled: () => Promise<void>  // 标记为已安装并刷新状态（exe/binary 自动检测后调用）
  onUpdateProviders: (enabledForProviders: string[] | null) => void  // 按 Provider 单独启用/禁用
}

function McpCard({ server, testResult, testing, onToggle, onEdit, onDelete, onTest, onInstall, onMarkInstalled, onUpdateProviders }: McpCardProps) {
  const [showConfig, setShowConfig] = useState(false)
  // 手动安装提示 toast
  const [installHint, setInstallHint] = useState<string | null>(null)
  const [installChecking, setInstallChecking] = useState(false)
  const installTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleInstallClick = async () => {
    // npm 包：触发自动安装弹窗（仅当 installCommand 有值时，否则降级为检测/提示模式）
    if (server.installMethod === 'npm' && server.installCommand) {
      onInstall()
      return
    }
    if (installTimerRef.current) clearTimeout(installTimerRef.current)

    // 手动安装场景统一做前置检测（命令是否存在、Python/pip 是否可用等）
    setInstallChecking(true)
    setInstallHint('正在检测安装前置条件...')
    try {
      const spectrAI = (window as any).spectrAI
      const result = await spectrAI?.mcp?.testConnection?.(server.id)
      if (!result?.success) {
        setInstallHint(result?.error || `无法访问 '${server.command}'，请检查路径或命令是否正确`)
        installTimerRef.current = setTimeout(() => setInstallHint(null), 7000)
        return
      }

      // uvx/npx 类型可延迟下载依赖，命令可用即可直接启用
      if (server.command === 'uvx' || server.command === 'npx') {
        await onMarkInstalled()
        setInstallHint(`✓ 已检测到 '${server.command}'，可直接启用（首次调用会自动下载工具依赖）`)
        installTimerRef.current = setTimeout(() => setInstallHint(null), 6000)
        return
      }

      // 无 installCommand：检测通过后直接标记可用
      if (!server.installCommand) {
        await onMarkInstalled()
        setInstallHint('✓ 已检测到程序，开关已解锁，可以启用了')
        installTimerRef.current = setTimeout(() => setInstallHint(null), 6000)
        return
      }

      // 有 installCommand：给出平台化安装建议
      const suggestion = getInstallSuggestionForCommand(server.command || '')
      const hintSuffix = suggestion ? `（${suggestion}）` : ''
      setInstallHint(`请在终端执行：${server.installCommand}${hintSuffix}，安装完成后启用右上角的开关`)
    } catch {
      setInstallHint('检测失败，请检查配置是否正确')
    } finally {
      setInstallChecking(false)
    }
    installTimerRef.current = setTimeout(() => setInstallHint(null), 6000)
  }

  const transportBadgeColor = {
    stdio: 'bg-accent-blue/15 text-accent-blue',
    http:  'bg-accent-green/15 text-accent-green',
    sse:   'bg-accent-purple/15 text-accent-purple',
  }[server.transport] || 'bg-bg-hover text-text-secondary'

  const sourceBadge = server.source === 'builtin'
    ? <span className="text-xs px-1.5 py-0.5 rounded bg-bg-hover text-text-secondary">内置</span>
    : null

  // 决定要显示哪些 Provider 徽章
  const providerIds: string[] = server.compatibleProviders === 'all'
    ? ALL_PROVIDER_IDS
    : (server.compatibleProviders as string[]) || []

  // ── 按 Provider 单独启用/禁用 ──
  // enabledForProviders=null/undefined 表示对所有兼容 Provider 均启用
  const isEnabledForProvider = (pid: string) =>
    !server.enabledForProviders || server.enabledForProviders.includes(pid)

  const handleToggleProvider = (pid: string) => {
    const currentlyEnabled = isEnabledForProvider(pid)
    let next: string[] | null
    if (currentlyEnabled) {
      // 关掉这个 Provider：保留其余已启用的
      const remaining = providerIds.filter(p => p !== pid && isEnabledForProvider(p))
      next = remaining.length > 0 ? remaining : []
    } else {
      // 打开这个 Provider：加回去
      const base = server.enabledForProviders ?? providerIds
      const merged = Array.from(new Set([...base, pid]))
      // 若已全部启用，恢复为 null（全量）
      next = providerIds.every(p => merged.includes(p)) ? null : merged
    }
    onUpdateProviders(next)
  }

  return (
    <div className={`border rounded-lg transition-colors ${
      server.isGlobalEnabled
        ? 'border-border/50 bg-bg-secondary'
        : 'border-border bg-bg-tertiary opacity-60'
    }`}>
      <div className="flex items-center gap-3 px-4 py-3">
        {/* 分类图标 */}
        <div className="w-8 h-8 rounded-md bg-bg-hover flex items-center justify-center text-lg flex-shrink-0">
          {CATEGORY_ICONS[server.category] || '🔌'}
        </div>

        {/* 主信息 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary truncate">{server.name}</span>
            {server.version && <span className="text-xs text-text-muted">v{server.version}</span>}
            {sourceBadge}
          </div>
          <div className="text-xs text-text-muted truncate mt-0.5">{server.description}</div>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span className={`text-xs px-1.5 py-0.5 rounded ${transportBadgeColor}`}>
              {server.transport}
            </span>
            {/* 兼容 Provider 徽章（带 Tooltip） */}
            {providerIds.map(pid => (
              <ProviderBadge key={pid} providerId={pid} />
            ))}
            {/* 测试结果 */}
            {testResult && (
              <span className={`text-xs ${testResult.success ? 'text-green-400' : 'text-red-400'}`}>
                {testResult.success ? '✓ 可用' : `✗ ${testResult.error || '连接失败'}`}
              </span>
            )}
          </div>
        </div>

        {/* 操作区 */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {!server.isInstalled && (
            <button
              onClick={handleInstallClick}
              disabled={installChecking}
              className="text-xs px-2 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {installChecking ? '检测中...' : '安装'}
            </button>
          )}
          <button
            onClick={onTest}
            disabled={testing}
            className="text-xs px-2 py-1 rounded border border-border text-text-secondary hover:text-text-primary hover:border-border transition-colors disabled:opacity-50"
          >
            {testing ? '测试中...' : '测试'}
          </button>
          {server.configSchema && (
            <button
              onClick={() => setShowConfig(!showConfig)}
              className="text-text-muted hover:text-text-secondary text-sm"
              title="配置"
            >
              ⚙
            </button>
          )}
          <button onClick={onEdit} className="text-text-muted hover:text-text-secondary text-sm" title="编辑">✎</button>
          {server.source !== 'builtin' && (
            <button onClick={onDelete} className="text-text-muted hover:text-red-400 text-sm" title="删除">✕</button>
          )}
          {/* 开关 */}
          <button
            onClick={() => onToggle(!server.isGlobalEnabled)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              server.isGlobalEnabled ? 'bg-blue-600' : 'bg-bg-hover'
            }`}
          >
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              server.isGlobalEnabled ? 'translate-x-4' : 'translate-x-1'
            }`} />
          </button>
        </div>
      </div>

      {/* 安装提示 Toast */}
      {installHint && (
        <div className={`mx-4 mb-3 px-3 py-2 rounded-md text-xs flex items-start justify-between gap-2 border ${
          installHint.startsWith('✓')
            ? 'bg-green-900/20 border-green-700/40 text-green-300'
            : installChecking
              ? 'bg-blue-900/20 border-blue-700/40 text-blue-300'
              : 'bg-yellow-900/20 border-yellow-700/40 text-yellow-300'
        }`}>
          <span className="leading-relaxed">{installHint}</span>
          <button
            onClick={() => setInstallHint(null)}
            className="opacity-60 hover:opacity-100 flex-shrink-0 mt-0.5"
          >
            ✕
          </button>
        </div>
      )}

      {/* 按 Provider 单独启用/禁用（全局已启用 & 兼容 2 个以上 Provider 时显示） */}
      {server.isGlobalEnabled && providerIds.length > 1 && (
        <div className="px-4 pb-3 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-text-muted">应用到：</span>
          {providerIds.map(pid => {
            const on = isEnabledForProvider(pid)
            return (
              <button
                key={pid}
                onClick={() => handleToggleProvider(pid)}
                title={on
                  ? `点击：暂停对 ${PROVIDER_LABELS[pid] || pid} 应用此 MCP`
                  : `点击：为 ${PROVIDER_LABELS[pid] || pid} 启用此 MCP`}
                className={`text-xs px-2 py-0.5 rounded-full border transition-all ${
                  on
                    ? 'border-blue-500/40 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20'
                    : 'border-border bg-bg-tertiary text-text-muted hover:border-border line-through opacity-50'
                }`}
              >
                {PROVIDER_LABELS[pid] || pid}
              </button>
            )
          })}
          {server.enabledForProviders && (
            <span className="text-xs text-yellow-500/80">⚠ 部分 Provider 已禁用</span>
          )}
        </div>
      )}

      {/* 展开的配置表单（如果有 configSchema） */}
      {showConfig && server.configSchema && (
        <McpConfigForm
          server={server}
          onSave={(config) => {
            ;(window as any).spectrAI.mcp.update(server.id, { userConfig: config })
          }}
        />
      )}
    </div>
  )
}

// ── MCP 配置表单（用于 configSchema 动态渲染） ──
function McpConfigForm({ server, onSave }: { server: McpServer; onSave: (config: Record<string, string>) => void }) {
  const schema = server.configSchema!
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(
      Object.entries(schema.properties).map(([k]) => [
        k,
        String((server.userConfig as any)?.[k] ?? (server.envVars as any)?.[k] ?? ''),
      ])
    )
  )

  return (
    <div className="border-t border-border px-4 py-3 space-y-2">
      {Object.entries(schema.properties).map(([key, prop]) => (
        <div key={key}>
          <label className="block text-xs text-text-secondary mb-1">
            {prop.description}
            {schema.required?.includes(key) && <span className="text-red-400 ml-1">*</span>}
          </label>
          <input
            type={
              key.toLowerCase().includes('key') ||
              key.toLowerCase().includes('token') ||
              key.toLowerCase().includes('password')
                ? 'password'
                : 'text'
            }
            value={values[key] || ''}
            onChange={e => setValues(prev => ({ ...prev, [key]: e.target.value }))}
            className="w-full bg-bg-input border border-border text-text-primary text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
            placeholder={String(prop.default ?? '')}
          />
        </div>
      ))}
      <button
        onClick={() => onSave(values)}
        className="mt-1 px-3 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
      >
        保存配置
      </button>
    </div>
  )
}

// ── 添加/编辑 MCP 弹窗 ──
function McpFormDialog({ server, onClose, onSave }: {
  server: McpServer | null
  onClose: () => void
  onSave: (data: Partial<McpServer>) => Promise<void>
}) {
  const isEdit = !!server
  const [form, setForm] = useState({
    name:                server?.name || '',
    description:         server?.description || '',
    category:            (server?.category || 'custom') as McpServer['category'],
    transport:           (server?.transport || 'stdio') as McpServer['transport'],
    command:             server?.command || '',
    args:                server?.args?.join(', ') || '',
    url:                 server?.url || '',
    compatibleProviders: server?.compatibleProviders || ('all' as string[] | 'all'),
    fallbackMode:        (server?.fallbackMode || 'disabled') as McpServer['fallbackMode'],
    installCommand:      server?.installCommand || '',
    installMethod:       (server?.installMethod || 'npm') as McpServer['installMethod'],
  })
  const [saving, setSaving] = useState(false)
  const [allProviders, setAllProviders] = useState(
    !server || server.compatibleProviders === 'all'
  )

  // ── 快速导入状态 ──
  const [importTab, setImportTab] = useState<'npm' | 'json'>('npm')
  const [npmInput, setNpmInput] = useState('')
  const [jsonInput, setJsonInput] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [detectedEnv, setDetectedEnv] = useState<Record<string, string> | null>(null)

  const PROVIDERS = ['claude-code', 'codex', 'gemini-cli', 'iflow', 'opencode']

  // 根据命令推断 installMethod
  const inferInstallMethod = (cmd: string): McpServer['installMethod'] => {
    if (cmd === 'npx' || cmd === 'npm') return 'npm'
    if (cmd === 'uvx' || cmd === 'pip') return 'manual'
    return 'manual'
  }

  // npm 包名快速导入
  const handleApplyNpm = () => {
    const pkg = npmInput.trim()
    if (!pkg) return
    const derivedName = pkg.replace(/^@[^/]+\//, '').replace(/^mcp-server-?/, '') || pkg
    setForm(prev => ({
      ...prev,
      name:           prev.name || derivedName,
      command:        'npx',
      args:           `-y, ${pkg}`,
      transport:      'stdio',
      installCommand: `npm install -g ${pkg}`,
      installMethod:  'npm',
    }))
    setImportError(null)
    setDetectedEnv(null)
  }

  // JSON 配置解析导入
  const handleApplyJson = () => {
    try {
      const parsed = JSON.parse(jsonInput.trim())
      // 兼容三种格式：
      //   1. { "command": "...", "args": [...] }               ← 单个 server config
      //   2. { "serverName": { "command": "...", ... } }       ← 一个 server 的 KV
      //   3. { "mcpServers": { "name": { "command":... } } }   ← 完整 Claude Desktop 格式
      let config: any = parsed
      let inferredName = ''

      if (config.mcpServers && typeof config.mcpServers === 'object') {
        const entries = Object.entries(config.mcpServers)
        if (entries.length > 0) {
          const [key, val] = entries[0] as [string, any]
          inferredName = key
          config = val
        }
      } else if (!config.command) {
        const entries = Object.entries(config)
        if (entries.length > 0) {
          const [key, val] = entries[0] as [string, any]
          if ((val as any)?.command) {
            inferredName = key
            config = val as any
          }
        }
      }

      if (!config.command) {
        setImportError('未找到 command 字段，请确认 JSON 格式正确')
        return
      }

      const argsStr = Array.isArray(config.args) ? config.args.join(', ') : ''
      const cmd: string = config.command || ''
      setForm(prev => ({
        ...prev,
        name:          prev.name || inferredName || '',
        command:       cmd,
        args:          argsStr,
        transport:     'stdio',
        installMethod: inferInstallMethod(cmd),
      }))

      if (config.env && typeof config.env === 'object' && Object.keys(config.env).length > 0) {
        setDetectedEnv(config.env)
      } else {
        setDetectedEnv(null)
      }
      setImportError(null)
    } catch {
      setImportError('JSON 格式错误，请检查括号和引号是否完整')
    }
  }

  const handleSave = async () => {
    if (!form.name.trim()) return
    setSaving(true)
    const now = new Date().toISOString()
    await onSave({
      ...form,
      args: form.args ? form.args.split(',').map(a => a.trim()).filter(Boolean) : [],
      compatibleProviders: allProviders
        ? 'all'
        : (Array.isArray(form.compatibleProviders) ? form.compatibleProviders : []),
      isInstalled:     false,
      installMethod:   form.installMethod,
      source:          'custom',
      isGlobalEnabled: true,
      id:              server?.id || `mcp-${Date.now()}`,
      createdAt:       server?.createdAt || now,
      updatedAt:       now,
    })
    setSaving(false)
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-bg-secondary border border-border rounded-xl w-[520px] max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-sm font-semibold text-text-primary">
            {isEdit ? '编辑 MCP 服务器' : '添加 MCP 服务器'}
          </h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-secondary">✕</button>
        </div>

        <div className="px-5 py-4 space-y-4">

          {/* ── 快速导入区（新增时显示） ── */}
          {!isEdit && (
            <div className="border border-border rounded-lg overflow-hidden">
              {/* Tab 标题 */}
              <div className="flex border-b border-border bg-bg-tertiary">
                <button
                  onClick={() => setImportTab('npm')}
                  className={`flex-1 px-3 py-2 text-xs transition-colors ${
                    importTab === 'npm'
                      ? 'text-text-primary bg-bg-secondary font-medium'
                      : 'text-text-muted hover:text-text-secondary'
                  }`}
                >
                  📦 npm 包名快捷
                </button>
                <div className="w-px bg-border" />
                <button
                  onClick={() => setImportTab('json')}
                  className={`flex-1 px-3 py-2 text-xs transition-colors ${
                    importTab === 'json'
                      ? 'text-text-primary bg-bg-secondary font-medium'
                      : 'text-text-muted hover:text-text-secondary'
                  }`}
                >
                  📋 粘贴 JSON 配置
                </button>
              </div>

              <div className="p-3">
                {importTab === 'npm' ? (
                  /* npm 包名模式 */
                  <div className="space-y-2">
                    <p className="text-xs text-text-muted">输入 npm 包名，自动配置 npx 命令</p>
                    <div className="flex gap-2">
                      <input
                        value={npmInput}
                        onChange={e => setNpmInput(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleApplyNpm()}
                        placeholder="@scope/mcp-server 或 mcp-server-xxx"
                        className="flex-1 bg-bg-input border border-border text-text-primary text-xs rounded-md px-3 py-2 focus:outline-none focus:border-blue-500 font-mono"
                      />
                      <button
                        onClick={handleApplyNpm}
                        className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded-md whitespace-nowrap transition-colors"
                      >
                        自动填表
                      </button>
                    </div>
                  </div>
                ) : (
                  /* JSON 导入模式 */
                  <div className="space-y-2">
                    <p className="text-xs text-text-muted">
                      粘贴 GitHub README 里的 JSON 配置，支持 Claude Desktop 格式
                    </p>
                    <textarea
                      value={jsonInput}
                      onChange={e => setJsonInput(e.target.value)}
                      placeholder={'{\n  "command": "npx",\n  "args": ["-y", "@scope/mcp-server"],\n  "env": { "API_KEY": "your-key" }\n}'}
                      rows={5}
                      className="w-full bg-bg-input border border-border text-text-primary text-xs rounded-md px-3 py-2 focus:outline-none focus:border-blue-500 font-mono resize-none"
                    />
                    {importError && (
                      <p className="text-xs text-red-400">{importError}</p>
                    )}
                    <button
                      onClick={handleApplyJson}
                      className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded-md transition-colors"
                    >
                      解析并填表
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 检测到 env 变量提示 */}
          {detectedEnv && (
            <div className="px-3 py-2.5 bg-yellow-500/10 border border-yellow-500/30 rounded-lg text-xs text-yellow-400">
              <div className="font-medium mb-1">⚠️ JSON 中包含以下环境变量，请添加后在卡片中手动填写：</div>
              <div className="font-mono space-y-0.5">
                {Object.entries(detectedEnv).map(([k, v]) => (
                  <div key={k}>{k} = <span className="text-yellow-600">{v || '（待填写）'}</span></div>
                ))}
              </div>
            </div>
          )}

          {/* 分隔线（新增时） */}
          {!isEdit && (
            <div className="flex items-center gap-2">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs text-text-muted">手动配置</span>
              <div className="flex-1 h-px bg-border" />
            </div>
          )}

          {/* 名称 */}
          <div>
            <label className="block text-xs text-text-secondary mb-1.5">
              名称 <span className="text-red-400">*</span>
            </label>
            <input
              value={form.name}
              onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
              className="w-full bg-bg-input border border-border text-text-primary text-sm rounded-md px-3 py-2 focus:outline-none focus:border-blue-500"
              placeholder="如：文件系统"
            />
          </div>

          {/* 描述 */}
          <div>
            <label className="block text-xs text-text-secondary mb-1.5">描述</label>
            <input
              value={form.description}
              onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
              className="w-full bg-bg-input border border-border text-text-primary text-sm rounded-md px-3 py-2 focus:outline-none focus:border-blue-500"
              placeholder="简短描述这个 MCP 的功能"
            />
          </div>

          {/* 分类 + 传输方式 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-secondary mb-1.5">分类</label>
              <select
                value={form.category}
                onChange={e => setForm(p => ({ ...p, category: e.target.value as any }))}
                className="w-full bg-bg-input border border-border text-text-primary text-sm rounded-md px-3 py-2 focus:outline-none focus:border-blue-500"
              >
                {['filesystem', 'database', 'web', 'code', 'productivity', 'custom'].map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1.5">传输方式</label>
              <select
                value={form.transport}
                onChange={e => setForm(p => ({ ...p, transport: e.target.value as any }))}
                className="w-full bg-bg-input border border-border text-text-primary text-sm rounded-md px-3 py-2 focus:outline-none focus:border-blue-500"
              >
                <option value="stdio">stdio（命令行）</option>
                <option value="http">http</option>
                <option value="sse">sse（流式）</option>
              </select>
            </div>
          </div>

          {/* stdio 字段 */}
          {form.transport === 'stdio' && (
            <>
              <div>
                <label className="block text-xs text-text-secondary mb-1.5">
                  命令 <span className="text-red-400">*</span>
                </label>
                <input
                  value={form.command}
                  onChange={e => setForm(p => ({ ...p, command: e.target.value }))}
                  className="w-full bg-bg-input border border-border text-text-primary text-sm rounded-md px-3 py-2 focus:outline-none focus:border-blue-500"
                  placeholder="如：npx"
                />
              </div>
              <div>
                <label className="block text-xs text-text-secondary mb-1.5">参数（逗号分隔）</label>
                <input
                  value={form.args}
                  onChange={e => setForm(p => ({ ...p, args: e.target.value }))}
                  className="w-full bg-bg-input border border-border text-text-primary text-sm rounded-md px-3 py-2 focus:outline-none focus:border-blue-500"
                  placeholder="如：-y, @modelcontextprotocol/server-filesystem"
                />
              </div>
            </>
          )}

          {/* http/sse 字段 */}
          {(form.transport === 'http' || form.transport === 'sse') && (
            <div>
              <label className="block text-xs text-text-secondary mb-1.5">
                URL <span className="text-red-400">*</span>
              </label>
              <input
                value={form.url}
                onChange={e => setForm(p => ({ ...p, url: e.target.value }))}
                className="w-full bg-bg-input border border-border text-text-primary text-sm rounded-md px-3 py-2 focus:outline-none focus:border-blue-500"
                placeholder="如：http://localhost:3000"
              />
            </div>
          )}

          {/* 兼容 Provider */}
          <div>
            <label className="block text-xs text-text-secondary mb-1.5">兼容 Provider</label>
            <div className="flex items-center gap-2 mb-2">
              <input
                type="checkbox"
                id="mcp-all-providers"
                checked={allProviders}
                onChange={e => {
                  setAllProviders(e.target.checked)
                  if (e.target.checked) setForm(p => ({ ...p, compatibleProviders: 'all' }))
                }}
                className="rounded"
              />
              <label htmlFor="mcp-all-providers" className="text-xs text-text-secondary">所有 Provider</label>
            </div>
            {!allProviders && (
              <div className="flex flex-wrap gap-3">
                {PROVIDERS.map(pid => (
                  <label key={pid} className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Array.isArray(form.compatibleProviders) && form.compatibleProviders.includes(pid)}
                      onChange={e => {
                        const curr = Array.isArray(form.compatibleProviders) ? form.compatibleProviders : []
                        setForm(p => ({
                          ...p,
                          compatibleProviders: e.target.checked
                            ? [...curr, pid]
                            : curr.filter(x => x !== pid),
                        }))
                      }}
                      className="rounded"
                    />
                    {PROVIDER_LABELS[pid] || pid}
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* 降级策略 */}
          <div>
            <label className="block text-xs text-text-secondary mb-1.5">不兼容时的降级策略</label>
            <select
              value={form.fallbackMode}
              onChange={e => setForm(p => ({ ...p, fallbackMode: e.target.value as any }))}
              className="w-full bg-bg-input border border-border text-text-primary text-sm rounded-md px-3 py-2 focus:outline-none focus:border-blue-500"
            >
              <option value="disabled">禁用（不对不兼容 Provider 注入）</option>
              <option value="prompt-injection">降级为 Prompt 注入（Gemini 可用）</option>
            </select>
          </div>

          {/* 安装命令 */}
          <div>
            <label className="block text-xs text-text-secondary mb-1.5">安装命令（可选）</label>
            <input
              value={form.installCommand}
              onChange={e => setForm(p => ({ ...p, installCommand: e.target.value }))}
              className="w-full bg-bg-input border border-border text-text-primary text-sm rounded-md px-3 py-2 focus:outline-none focus:border-blue-500"
              placeholder="如：npm install -g @mcp/server-xxx"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-border">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !form.name.trim()}
            className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-md transition-colors"
          >
            {saving ? '保存中...' : (isEdit ? '更新' : '添加')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 安装进度 Modal ──
function InstallProgressModal({
  mcpId,
  mcpName,
  onClose,
}: {
  mcpId: string
  mcpName: string
  onClose: () => void
}) {
  const [lines, setLines] = useState<Array<{ text: string; type: string }>>([])
  const [done, setDone] = useState(false)
  const [success, setSuccess] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const spectrAI = (window as any).spectrAI
    // 监听安装进度事件
    spectrAI?.mcp?.onInstallProgress?.((data: { id: string; line: string; type: string }) => {
      if (data.id !== mcpId) return
      setLines(prev => [...prev, { text: data.line, type: data.type }])
      if (data.type === 'done') { setDone(true); setSuccess(true) }
      if (data.type === 'error') { setDone(true); setSuccess(false) }
    })

    // 触发安装
    spectrAI?.mcp?.install?.(mcpId).then((result: any) => {
      if (!result?.success) {
        setLines(prev => [...prev, { text: result?.error || '安装失败', type: 'error' }])
        setDone(true)
        setSuccess(false)
      }
    })
  }, [mcpId])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [lines])

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={done ? onClose : undefined}
    >
      <div className="bg-bg-secondary border border-border rounded-xl w-[560px]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-sm font-semibold text-text-primary">安装 {mcpName}</h3>
          {done && <button onClick={onClose} className="text-text-muted hover:text-text-secondary">✕</button>}
        </div>
        <div
          ref={scrollRef}
          className="px-4 py-3 h-48 overflow-y-auto font-mono text-xs space-y-0.5 bg-[#1a1a1a]"
        >
          {lines.length === 0 && (
            <div className="text-zinc-500">正在启动安装...</div>
          )}
          {lines.map((l, i) => (
            <div key={i} className={
              l.type === 'error'  ? 'text-red-400'    :
              l.type === 'done'   ? 'text-green-400'  :
              l.type === 'stderr' ? 'text-yellow-400' :
              'text-zinc-300'
            }>
              {l.text}
            </div>
          ))}
        </div>
        <div className="px-5 py-3 border-t border-border flex items-center justify-between">
          <span className="text-xs text-text-muted">
            {done ? (success ? '✓ 安装成功' : '✗ 安装失败') : '安装中...'}
          </span>
          <button
            onClick={onClose}
            disabled={!done}
            className="px-3 py-1 text-sm bg-bg-hover hover:bg-bg-hover disabled:opacity-40 text-text-primary rounded transition-colors"
          >
            {done ? '关闭' : '安装中...'}
          </button>
        </div>
      </div>
    </div>
  )
}
