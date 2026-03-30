/**
 * 统一设置面板
 *
 * 整合所有应用配置，通过顶部 Tab 导航分区管理：
 *
 * 【通用】
 *   - 通用：Git Worktree 隔离等全局开关
 *   - 主题：界面外观主题切换
 *   - 日志：主进程运行日志查看
 *
 * @author weibin
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  X, FolderGit2, Globe, Bell, MonitorCheck,
  Plus, Trash2, TestTube, RefreshCw, Check, AlertCircle, Loader2, Pencil,
  Palette, ScrollText, ExternalLink, ShieldAlert, Info,
} from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import type { ProxyType } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import { THEMES, THEME_IDS } from '../../../shared/constants'
import { WorkspaceTab } from './WorkspaceManager'
import McpManager from './McpManager'
import SkillManager from './SkillManager'

// ──────────────────────────────────────────────
// Tab 类型
// ──────────────────────────────────────────────
type TabId = 'general' | 'theme' | 'logs' | 'workspace' | 'mcp' | 'skills'
type TabGroup = 'app'

interface Tab {
  id: TabId
  label: string
  group: TabGroup
}

const TABS: Tab[] = [
  { id: 'general',   label: '通用',    group: 'app' },
  { id: 'theme',     label: '主题',    group: 'app' },
  { id: 'workspace', label: '工作区',  group: 'app' },
  { id: 'mcp',       label: '🔌 MCP',  group: 'app' },
  { id: 'skills',    label: '🎯 技能', group: 'app' },
  { id: 'logs',      label: '日志',    group: 'app' },
]

// ──────────────────────────────────────────────
// 主组件
// ──────────────────────────────────────────────
interface Props {
  onClose: () => void
  /** 打开时默认定位到哪个 tab（默认 'general'） */
  initialTab?: string
}

export default function UnifiedSettingsModal({ onClose, initialTab = 'general' }: Props) {
  const [activeTab, setActiveTab] = useState<string>(initialTab ?? 'general')
  const { fetchSettings } = useSettingsStore()

  useEffect(() => {
    fetchSettings()  // 确保代理设置最新
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div
        className="bg-bg-secondary rounded-xl shadow-2xl w-full max-w-2xl border border-border max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── 标题栏 ── */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold text-text-primary">设置</h2>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary btn-transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ── Tab 导航 ── */}
        <div className="flex items-center border-b border-border px-4 shrink-0 overflow-x-auto">
          {/* App 通用分组 */}
          {TABS.filter((t) => t.group === 'app').map((t) => (
            <TabButton key={t.id} id={t.id} label={t.label} active={activeTab} onClick={setActiveTab} />
          ))}
        </div>

        {/* ── 内容区 ── */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {activeTab === 'general'   && <GeneralTab />}
          {activeTab === 'theme'     && <ThemeTab />}
          {activeTab === 'workspace' && <WorkspaceTab />}
          {activeTab === 'mcp'       && <McpManager />}
          {activeTab === 'skills'    && <SkillManager />}
          {activeTab === 'logs'      && <LogTab />}
        </div>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────
// Tab 按钮
// ──────────────────────────────────────────────
function TabButton({
  id, label, active, onClick,
}: {
  id: TabId; label: string; active: string; onClick: (id: string) => void
}) {
  return (
    <button
      onClick={() => onClick(id)}
      className={[
        'px-3 py-2.5 text-sm font-medium btn-transition border-b-2 whitespace-nowrap shrink-0',
        active === id
          ? 'text-accent-blue border-accent-blue'
          : 'text-text-secondary border-transparent hover:text-text-primary',
      ].join(' ')}
    >
      {label}
    </button>
  )
}

// ══════════════════════════════════════════════
// ── 通用 Tab ──
// ══════════════════════════════════════════════
function GeneralTab() {
  const { settings, updateSetting, updateSettings } = useSettingsStore()

  // ── 代理设置本地状态 ──
  const [proxyType,     setProxyType]     = useState<ProxyType>('none')
  const [proxyHost,     setProxyHost]     = useState('')
  const [proxyPort,     setProxyPort]     = useState('')
  const [proxyUsername, setProxyUsername] = useState('')
  const [proxyPassword, setProxyPassword] = useState('')
  const [proxySaved,    setProxySaved]    = useState(false)

  // 从 store 初始化本地状态
  useEffect(() => {
    setProxyType(settings.proxyType || 'none')
    setProxyHost(settings.proxyHost || '')
    setProxyPort(settings.proxyPort || '')
    setProxyUsername(settings.proxyUsername || '')
    setProxyPassword(settings.proxyPassword || '')
  }, [settings.proxyType, settings.proxyHost, settings.proxyPort, settings.proxyUsername, settings.proxyPassword])

  const handleSaveProxy = async () => {
    await updateSettings({
      proxyType,
      proxyHost:     proxyType !== 'none' ? proxyHost     : '',
      proxyPort:     proxyType !== 'none' ? proxyPort     : '',
      proxyUsername: proxyType !== 'none' ? proxyUsername : '',
      proxyPassword: proxyType !== 'none' ? proxyPassword : '',
    })
    setProxySaved(true)
    setTimeout(() => setProxySaved(false), 2000)
  }

  const inputCls = 'w-full px-2.5 py-1.5 rounded bg-bg-primary border border-border text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-blue/60'

  const hasProxy = settings.proxyType && settings.proxyType !== 'none'
  const [updateState, setUpdateState] = useState<{
    status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
    currentVersion: string
    latestVersion?: string
    isMajorUpdate?: boolean
    percent?: number
    message?: string
  } | null>(null)
  const [updating, setUpdating] = useState(false)

  useEffect(() => {
    let cancelled = false

    const loadState = async () => {
      try {
        const state = await window.spectrAI.update.getState()
        if (!cancelled) setUpdateState(state)
      } catch {
        // ignore
      }
    }

    void loadState()
    const unsubscribe = window.spectrAI.update.onStateChanged((state) => {
      setUpdateState(state)
    })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  const handleCheckUpdate = async () => {
    setUpdating(true)
    try {
      const result = await window.spectrAI.update.checkForUpdates(true)
      setUpdateState(result.state)
    } finally {
      setUpdating(false)
    }
  }

  const handleDownloadUpdate = async () => {
    setUpdating(true)
    try {
      const result = await window.spectrAI.update.downloadUpdate()
      setUpdateState(result.state)
    } finally {
      setUpdating(false)
    }
  }

  return (
    <div className="space-y-6">

      {/* ── 代理设置 ── */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Globe className="w-4 h-4 text-accent-blue" />
          <h3 className="text-sm font-medium text-text-primary">代理设置</h3>
          <span className="text-xs text-text-muted">用于 AI 连接 Anthropic 等服务</span>
        </div>

        <div className="border border-border rounded-lg p-3 space-y-3">
          {/* 代理类型选择 */}
          <div className="flex gap-2">
            {(['none', 'http', 'socks5'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setProxyType(t)}
                className={[
                  'px-3 py-1.5 rounded text-xs transition-colors',
                  proxyType === t
                    ? 'bg-accent-blue/15 text-accent-blue border border-accent-blue/40'
                    : 'bg-bg-tertiary text-text-secondary border border-border hover:border-accent-blue/30',
                ].join(' ')}
              >
                {t === 'none' ? '不使用' : t === 'http' ? 'HTTP' : 'SOCKS5'}
              </button>
            ))}
          </div>

          {/* 代理详情输入（非 none 时显示） */}
          {proxyType !== 'none' && (
            <>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <input
                    value={proxyHost}
                    onChange={(e) => setProxyHost(e.target.value)}
                    placeholder="代理地址（如 127.0.0.1）"
                    className={inputCls}
                  />
                </div>
                <input
                  value={proxyPort}
                  onChange={(e) => setProxyPort(e.target.value)}
                  placeholder="端口（如 7890）"
                  className={inputCls}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={proxyUsername}
                  onChange={(e) => setProxyUsername(e.target.value)}
                  placeholder="用户名（可选）"
                  className={inputCls}
                />
                <input
                  type="password"
                  value={proxyPassword}
                  onChange={(e) => setProxyPassword(e.target.value)}
                  placeholder="密码（可选）"
                  className={inputCls}
                />
              </div>
            </>
          )}

          {/* 保存按钮 + 状态 */}
          <div className="flex items-center gap-3">
            <button
              onClick={handleSaveProxy}
              className="px-3 py-1.5 bg-accent-blue text-white rounded text-xs transition-opacity hover:opacity-90"
            >
              保存代理设置
            </button>
            {proxySaved && (
              <span className="flex items-center gap-1 text-xs text-green-500">
                <Check className="w-3 h-3" /> 已保存
              </span>
            )}
          </div>

          {/* 状态提示 */}
          {hasProxy ? (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-green-500/5 border border-green-500/20 text-xs text-text-secondary leading-relaxed">
              <Check className="w-3 h-3 text-green-500 flex-shrink-0 mt-0.5" />
              <span>
                已配置 {settings.proxyType?.toUpperCase()} 代理：{settings.proxyHost}:{settings.proxyPort}。
                AI 连接将使用此代理。
              </span>
            </div>
          ) : (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-yellow-500/5 border border-yellow-500/20 text-xs text-text-secondary leading-relaxed">
              <ShieldAlert className="w-3 h-3 text-yellow-500 flex-shrink-0 mt-0.5" />
              <span>
                未配置代理。程序将自动从系统环境变量或 PowerShell profile 读取代理（仅 Windows），AI 连接均适用。
                如果连接失败，请在此手动配置代理。
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Git Worktree 隔离 ── */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <FolderGit2 className="w-4 h-4 text-accent-blue" />
          <h3 className="text-sm font-medium text-text-primary">Git Worktree 隔离</h3>
        </div>

        <label className="flex items-start gap-3 cursor-pointer group">
          <div className="mt-0.5">
            <div
              role="switch"
              aria-checked={settings.autoWorktree}
              onClick={() => updateSetting('autoWorktree', !settings.autoWorktree)}
              className={[
                'relative w-9 h-5 rounded-full transition-colors cursor-pointer flex-shrink-0',
                settings.autoWorktree ? 'bg-accent-blue' : 'bg-bg-tertiary border border-border',
              ].join(' ')}
            >
              <span
                className={[
                  'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform',
                  settings.autoWorktree ? 'translate-x-[18px]' : 'translate-x-0.5',
                ].join(' ')}
              />
            </div>
          </div>
          <div>
            <div className="text-sm text-text-primary">新建任务时默认启用 Worktree 隔离</div>
            <div className="text-xs text-text-muted mt-0.5 leading-relaxed">
              开启后，在看板中创建新任务时，Git Worktree 隔离选项将默认勾选并展开，
              每个任务在独立的分支目录下工作，彻底隔离代码修改，适合并行开发场景。
            </div>
          </div>
        </label>

        {settings.autoWorktree && (
          <div className="mt-3 flex items-start gap-2 px-3 py-2.5 rounded-lg bg-accent-blue/5 border border-accent-blue/20 text-xs text-text-secondary leading-relaxed">
            <span className="text-accent-blue flex-shrink-0 mt-0.5">✓</span>
            <span>
              已启用。新建任务时 Worktree 区域将自动展开，还需手动指定 Git 仓库路径和分支名方可创建。
            </span>
          </div>
        )}
      </div>

      {/* ── 开机自启 ── */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <MonitorCheck className="w-4 h-4 text-accent-blue" />
          <h3 className="text-sm font-medium text-text-primary">开机自启</h3>
        </div>

        <label className="flex items-start gap-3 cursor-pointer group">
          <div className="mt-0.5">
            <div
              role="switch"
              aria-checked={settings.autoLaunch}
              onClick={() => updateSetting('autoLaunch', !settings.autoLaunch)}
              className={[
                'relative w-9 h-5 rounded-full transition-colors cursor-pointer flex-shrink-0',
                settings.autoLaunch ? 'bg-accent-blue' : 'bg-bg-tertiary border border-border',
              ].join(' ')}
            >
              <span
                className={[
                  'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform',
                  settings.autoLaunch ? 'translate-x-[18px]' : 'translate-x-0.5',
                ].join(' ')}
              />
            </div>
          </div>
          <div>
            <div className="text-sm text-text-primary">系统登录后自动启动 SpectrAI</div>
            <div className="text-xs text-text-muted mt-0.5 leading-relaxed">
              开启后，电脑重启或用户登录时将自动启动应用。
            </div>
          </div>
        </label>
      </div>

      {/* ── 系统通知 ── */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Bell className="w-4 h-4 text-accent-blue" />
          <h3 className="text-sm font-medium text-text-primary">系统通知</h3>
        </div>

        <label className="flex items-start gap-3 cursor-pointer group">
          <div className="mt-0.5">
            <div
              role="switch"
              aria-checked={settings.notificationEnabled}
              onClick={() => updateSetting('notificationEnabled', !settings.notificationEnabled)}
              className={[
                'relative w-9 h-5 rounded-full transition-colors cursor-pointer flex-shrink-0',
                settings.notificationEnabled ? 'bg-accent-blue' : 'bg-bg-tertiary border border-border',
              ].join(' ')}
            >
              <span
                className={[
                  'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform',
                  settings.notificationEnabled ? 'translate-x-[18px]' : 'translate-x-0.5',
                ].join(' ')}
              />
            </div>
          </div>
          <div>
            <div className="text-sm text-text-primary">会话完成时发送系统通知</div>
            <div className="text-xs text-text-muted mt-0.5 leading-relaxed">
              主会话任务完成后弹出操作系统原生通知。子 Agent 会话不会触发通知。
            </div>
          </div>
        </label>
      </div>

      {/* App Update */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <RefreshCw className="w-4 h-4 text-accent-blue" />
          <h3 className="text-sm font-medium text-text-primary">应用更新</h3>
        </div>

        <div className="text-xs text-text-secondary mb-2">
          当前版本：{updateState?.currentVersion || 'unknown'}
          {updateState?.latestVersion ? ` · 最新：${updateState.latestVersion}` : ''}
        </div>

        {updateState?.message && <div className="text-xs text-text-muted mb-2">{updateState.message}</div>}
        {typeof updateState?.percent === 'number' && (
          <div className="text-xs text-accent-blue mb-2">下载进度：{updateState.percent.toFixed(1)}%</div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            onClick={handleCheckUpdate}
            disabled={updating || updateState?.status === 'checking'}
            className="px-3 py-1.5 rounded text-xs bg-bg-tertiary border border-border text-text-primary hover:border-accent-blue/30 disabled:opacity-50"
          >
            检查更新
          </button>

          {(updateState?.status === 'available' || updateState?.status === 'downloading') && !updateState?.isMajorUpdate && (
            <button
              onClick={handleDownloadUpdate}
              disabled={updating || updateState?.status === 'downloading'}
              className="px-3 py-1.5 rounded text-xs bg-accent-blue text-white hover:opacity-90 disabled:opacity-50"
            >
              下载更新
            </button>
          )}

          {updateState?.status === 'downloaded' && (
            <button
              onClick={() => void window.spectrAI.update.quitAndInstall()}
              className="px-3 py-1.5 rounded text-xs bg-green-600 text-white hover:opacity-90"
            >
              重启并安装
            </button>
          )}

          {(updateState?.isMajorUpdate || updateState?.status === 'error') && (
            <button
              onClick={() => void window.spectrAI.update.openDownloadPage()}
              className="px-3 py-1.5 rounded text-xs bg-bg-tertiary border border-border text-text-primary hover:border-accent-blue/30 inline-flex items-center gap-1"
            >
              官网下载 <ExternalLink className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════
// ── 主题 Tab ──
// ══════════════════════════════════════════════
function ThemeTab() {
  const theme    = useUIStore((s) => s.theme)
  const setTheme = useUIStore((s) => s.setTheme)

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-4">
        <Palette className="w-4 h-4 text-accent-blue" />
        <h3 className="text-sm font-medium text-text-primary">界面主题</h3>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {THEME_IDS.map((id) => {
          const t = THEMES[id]
          const isActive = id === theme
          return (
            <button
              key={id}
              onClick={() => setTheme(id)}
              className={[
                'relative flex flex-col gap-2.5 p-3.5 rounded-lg border text-left btn-transition',
                isActive
                  ? 'border-accent-blue bg-accent-blue/8 ring-1 ring-accent-blue/40'
                  : 'border-border hover:border-text-muted bg-bg-primary/40 hover:bg-bg-hover/60',
              ].join(' ')}
            >
              {/* 配色预览 */}
              <div
                className="w-full h-10 rounded-md overflow-hidden flex"
                style={{ backgroundColor: t.colors.bg.primary }}
              >
                {/* 左侧：侧边栏色 */}
                <div
                  className="w-1/4 h-full"
                  style={{ backgroundColor: t.colors.bg.secondary }}
                />
                {/* 右侧：内容区 + 强调色点缀 */}
                <div className="flex-1 h-full flex items-end gap-1 p-1.5">
                  <div
                    className="h-1.5 flex-1 rounded-full opacity-60"
                    style={{ backgroundColor: t.colors.text.secondary }}
                  />
                  <div
                    className="h-2.5 w-2.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: t.colors.accent.blue }}
                  />
                  <div
                    className="h-2 w-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: t.colors.accent.green }}
                  />
                </div>
              </div>

              {/* 名称 + 类型 */}
              <div className="flex items-center justify-between">
                <span className={`text-sm font-medium ${isActive ? 'text-accent-blue' : 'text-text-primary'}`}>
                  {t.name}
                </span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                  t.type === 'dark'
                    ? 'bg-bg-tertiary text-text-muted'
                    : 'bg-accent-yellow/10 text-accent-yellow'
                }`}>
                  {t.type === 'dark' ? '暗色' : '浅色'}
                </span>
              </div>

              {/* 选中标记 */}
              {isActive && (
                <div className="absolute top-2.5 right-2.5 w-2 h-2 rounded-full bg-accent-blue" />
              )}
            </button>
          )
        })}
      </div>

      <p className="text-xs text-text-muted mt-2">主题偏好保存在本地，重启后保留。</p>
    </div>
  )
}

// ══════════════════════════════════════════════
// ── 日志 Tab ──
// ══════════════════════════════════════════════
type LogLevel = 'all' | 'error' | 'warn' | 'info' | 'debug'

const LOG_LEVEL_LABELS: Record<LogLevel, string> = {
  all: '全部', error: 'Error', warn: 'Warn', info: 'Info', debug: 'Debug',
}

function getLineLevel(line: string): LogLevel {
  const lower = line.toLowerCase()
  if (lower.includes('[error]')) return 'error'
  if (lower.includes('[warn]'))  return 'warn'
  if (lower.includes('[info]'))  return 'info'
  if (lower.includes('[debug]')) return 'debug'
  return 'info'
}

function getLineColor(level: LogLevel): string {
  switch (level) {
    case 'error': return 'text-accent-red'
    case 'warn':  return 'text-accent-yellow'
    case 'debug': return 'text-text-muted'
    default:      return 'text-text-primary'
  }
}

function LogTab() {
  const [lines,   setLines]   = useState<string[]>([])
  const [filter,  setFilter]  = useState<LogLevel>('all')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const timerRef  = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.spectrAI.log.getRecent(300)
      setLines(result || [])
    } catch (err) {
      console.error('[LogTab] Failed to fetch logs:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  // 首次加载 + 每 5 秒自动刷新（标签页内，间隔可稍长）
  useEffect(() => {
    fetchLogs()
    timerRef.current = setInterval(fetchLogs, 5000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [fetchLogs])

  // 新日志到达时滚到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines])

  const filteredLines = filter === 'all'
    ? lines
    : lines.filter((l) => getLineLevel(l) === filter)

  return (
    <div className="flex flex-col h-full gap-3" style={{ minHeight: '320px' }}>
      {/* 工具栏 */}
      <div className="flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2">
          <ScrollText className="w-4 h-4 text-accent-blue" />
          <span className="text-sm font-medium text-text-primary">应用日志</span>
          {loading && <RefreshCw className="w-3 h-3 animate-spin text-text-muted" />}
        </div>

        <div className="flex items-center gap-2">
          {/* 级别过滤 */}
          <div className="flex items-center gap-0.5 bg-bg-tertiary rounded px-1">
            {(Object.keys(LOG_LEVEL_LABELS) as LogLevel[]).map((level) => (
              <button
                key={level}
                onClick={() => setFilter(level)}
                className={`px-2 py-1 rounded text-xs btn-transition ${
                  filter === level
                    ? 'bg-accent-blue text-white'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {LOG_LEVEL_LABELS[level]}
              </button>
            ))}
          </div>
          {/* 手动刷新 */}
          <button
            onClick={fetchLogs}
            className="p-1.5 rounded btn-transition text-text-secondary hover:text-text-primary"
            title="立即刷新"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          {/* 在系统编辑器中打开 */}
          <button
            onClick={() => window.spectrAI.log.openFile()}
            className="p-1.5 rounded btn-transition text-text-secondary hover:text-text-primary"
            title="用系统编辑器打开日志文件"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 日志内容 */}
      <div className="flex-1 overflow-y-auto bg-bg-primary rounded-lg border border-border p-3 font-mono text-xs leading-relaxed"
           style={{ maxHeight: '400px' }}>
        {filteredLines.length === 0 ? (
          <div className="text-text-muted text-center mt-8">
            {lines.length === 0 ? '暂无日志（启动后将自动刷新）' : '当前过滤器无匹配日志'}
          </div>
        ) : (
          filteredLines.map((line, i) => {
            const level = getLineLevel(line)
            return (
              <div key={i} className={`py-0.5 break-all ${getLineColor(level)}`}>
                {line}
              </div>
            )
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* 底部状态 */}
      <div className="flex justify-between text-xs text-text-muted shrink-0">
        <span>共 {filteredLines.length} 条{filter !== 'all' ? `（已过滤）` : ''}</span>
        <span>每 5 秒自动刷新</span>
      </div>
    </div>
  )
}


