/**
 * AI Provider 管理弹窗（支持拖拽排序）
 * @author weibin
 */

import { useState, useEffect, useRef } from 'react'
import { X, Plus, Pencil, Trash2, Terminal, Cpu, Save, Sparkles, Code2, GripVertical, Zap, FolderOpen, FlaskConical, CheckCircle, AlertCircle, Loader } from 'lucide-react'
import type { AIProvider } from '../../../shared/types'
import { v4 as uuidv4 } from 'uuid'

interface ProviderManagerProps {
  onClose: () => void
}

/** Provider 图标和颜色映射 */
const PROVIDER_ICON_MAP: Record<string, { icon: typeof Terminal; color: string }> = {
  claude: { icon: Terminal, color: 'text-accent-blue' },
  codex: { icon: Code2, color: 'text-green-400' },
  gemini: { icon: Sparkles, color: 'text-yellow-400' },

  opencode: { icon: Zap, color: 'text-orange-400' },
  custom: { icon: Cpu, color: 'text-text-muted' },
}

function ProviderIcon({ icon, className }: { icon?: string; className?: string }) {
  const mapping = PROVIDER_ICON_MAP[icon || 'custom'] || PROVIDER_ICON_MAP.custom
  const IconComp = mapping.icon
  return <IconComp className={`${className || 'w-4 h-4'} ${mapping.color}`} />
}

/** 生成 Provider 能力标签 */
function ProviderBadges({ provider }: { provider: AIProvider }) {
  const badges: { label: string; color: string }[] = []
  if (provider.resumeArg) badges.push({ label: '可恢复', color: 'bg-accent-blue/15 text-accent-blue' })
  if (provider.autoAcceptArg) badges.push({ label: '可自动接受', color: 'bg-accent-green/15 text-accent-green' })
  if (provider.sessionIdDetection && provider.sessionIdDetection !== 'none') {
    badges.push({ label: '会话追踪', color: 'bg-accent-purple/15 text-accent-purple' })
  }
  if (provider.confirmationConfig) badges.push({ label: '确认检测', color: 'bg-yellow-500/15 text-yellow-400' })
  if (!badges.length) return null
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {badges.map(b => (
        <span key={b.label} className={`px-1 py-0.5 rounded text-[9px] ${b.color} leading-none`}>{b.label}</span>
      ))}
    </div>
  )
}

const EMPTY_FORM: Partial<AIProvider> = {
  name: '',
  command: '',
  icon: 'custom',
  defaultArgs: [],
  autoAcceptArg: '',
  resumeArg: '',
  resumeFormat: 'flag',
  promptPassMode: 'positional',
  sessionIdDetection: 'none',
  sessionIdPattern: '',
  nodeVersion: '',
  envOverrides: undefined,
  executablePath: '',
  gitBashPath: '',
  defaultModel: '',
}

/** 可执行文件测试状态 */
type TestStatus = 'idle' | 'testing' | 'ok' | 'error'

export default function ProviderManager({ onClose }: ProviderManagerProps) {
  const [providers, setProviders] = useState<AIProvider[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<Partial<AIProvider>>(EMPTY_FORM)
  const [isNew, setIsNew] = useState(false)
  const [defaultArgsText, setDefaultArgsText] = useState('')
  const [nvmVersions, setNvmVersions] = useState<string[]>([])
  const [envOverridesText, setEnvOverridesText] = useState('')
  // 编辑表单内的测试状态（仅 claude-sdk 路径验证用）
  const [testStatus, setTestStatus] = useState<TestStatus>('idle')
  const [testResult, setTestResult] = useState<{ path: string | null; error?: string } | null>(null)
  // 卡片列表中每个 Provider 的测试状态（providerId → 状态）
  const [cardTestMap, setCardTestMap] = useState<Record<string, { status: TestStatus; message: string }>>({})

  // 拖拽排序状态
  const dragIndex = useRef<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  useEffect(() => {
    loadProviders()
    loadNvmVersions()
  }, [])

  const loadProviders = async () => {
    try {
      const list = await window.spectrAI.provider.getAll()
      setProviders(list)
    } catch { /* ignore */ }
  }

  const loadNvmVersions = async () => {
    try {
      const versions = await window.spectrAI.nvm.listVersions()
      setNvmVersions(versions)
    } catch { /* ignore */ }
  }

  // -------- 拖拽排序逻辑 --------
  const handleDragStart = (index: number) => {
    dragIndex.current = index
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    setDragOverIndex(index)
  }

  const handleDrop = async (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault()
    const from = dragIndex.current
    if (from === null || from === dropIndex) {
      setDragOverIndex(null)
      dragIndex.current = null
      return
    }

    // 本地重排
    const reordered = [...providers]
    const [moved] = reordered.splice(from, 1)
    reordered.splice(dropIndex, 0, moved)
    setProviders(reordered)
    setDragOverIndex(null)
    dragIndex.current = null

    // 持久化到 DB
    try {
      await window.spectrAI.provider.reorder(reordered.map(p => p.id))
    } catch { /* ignore */ }
  }

  const handleDragEnd = () => {
    setDragOverIndex(null)
    dragIndex.current = null
  }

  const handleEdit = (provider: AIProvider) => {
    setEditingId(provider.id)
    setForm({ ...provider })
    setDefaultArgsText((provider.defaultArgs || []).join(' '))
    setEnvOverridesText(
      provider.envOverrides
        ? Object.entries(provider.envOverrides).map(([k, v]) => `${k}=${v}`).join('\n')
        : ''
    )
    setTestStatus('idle')
    setTestResult(null)
    setIsNew(false)
  }

  const handleNew = () => {
    setEditingId('__new__')
    setForm({ ...EMPTY_FORM })
    setDefaultArgsText('')
    setEnvOverridesText('')
    setTestStatus('idle')
    setTestResult(null)
    setIsNew(true)
  }

  /** 浏览选择可执行文件（可写入 executablePath 或 command） */
  const handleBrowseExecutable = async (target: 'executablePath' | 'command' = 'executablePath') => {
    const filePath = await window.spectrAI.app.selectFile()
    if (!filePath) return
    setForm(f => target === 'command'
      ? ({ ...f, command: filePath })
      : ({ ...f, executablePath: filePath }))
  }

  /** 测试当前编辑项的可执行配置是否可用 */
  const handleTestExecutable = async (adapterType?: string) => {
    const isClaude = adapterType === 'claude-sdk'
    setTestStatus('testing')
    setTestResult(null)
    try {
      if (isClaude) {
        const result = await window.spectrAI.provider.testExecutable(form.executablePath?.trim() || undefined)
        setTestStatus(result.found ? 'ok' : 'error')
        setTestResult({ path: result.path, error: result.error })
      } else {
        const command = form.command?.trim() || ''
        const result = await window.spectrAI.provider.checkCli(command)
        const reason = (result as { reason?: string }).reason
        setTestStatus(result.found ? 'ok' : 'error')
        setTestResult({
          path: result.path,
          error: result.found ? undefined : (reason || `未找到命令 "${command}"`),
        })
      }
    } catch (err: any) {
      setTestStatus('error')
      setTestResult({ path: null, error: err.message })
    }
  }

  /** 点击卡片上的"测试连接"按钮 */
  const handleCardTest = async (provider: AIProvider) => {
    const id = provider.id
    setCardTestMap(m => ({ ...m, [id]: { status: 'testing', message: '检测中…' } }))
    try {
      let found = false
      let message = ''
      if (provider.adapterType === 'claude-sdk') {
        // claude-sdk：测试 cli.js 是否可找到（支持自定义路径）
        const result = await window.spectrAI.provider.testExecutable(provider.executablePath?.trim() || undefined)
        found = result.found
        message = result.found
          ? `✓ ${result.path ?? '可用'}`
          : (result.error ?? '未找到 Claude Code CLI')
      } else {
        // 其他 Provider：检测 CLI 命令是否在 PATH 中
        const result = await window.spectrAI.provider.checkCli(provider.command)
        found = result.found
        message = result.found
          ? `✓ ${result.path ?? provider.command}`
          : `未找到命令 "${provider.command}"，请确认已安装`
      }
      setCardTestMap(m => ({ ...m, [id]: { status: found ? 'ok' : 'error', message } }))
    } catch (err: any) {
      setCardTestMap(m => ({ ...m, [id]: { status: 'error', message: err.message ?? '检测失败' } }))
    }
  }

  /** 解析 KEY=VALUE 格式的环境变量文本 */
  const parseEnvOverrides = (text: string): Record<string, string> | undefined => {
    const trimmed = text.trim()
    if (!trimmed) return undefined
    const result: Record<string, string> = {}
    for (const line of trimmed.split('\n')) {
      const idx = line.indexOf('=')
      if (idx > 0) {
        result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
      }
    }
    return Object.keys(result).length > 0 ? result : undefined
  }

  const handleSave = async () => {
    if (!form.name?.trim() || !form.command?.trim()) return

    const args = defaultArgsText.trim()
      ? defaultArgsText.trim().split(/\s+/)
      : []

    if (isNew) {
      const result = await window.spectrAI.provider.create({
        id: uuidv4(),
        name: form.name.trim(),
        command: form.command.trim(),
        icon: form.icon || 'custom',
        defaultArgs: args,
        autoAcceptArg: form.autoAcceptArg?.trim() || undefined,
        resumeArg: form.resumeArg?.trim() || undefined,
        resumeFormat: form.resumeFormat || 'flag',
        promptPassMode: form.promptPassMode || 'positional',
        sessionIdDetection: form.sessionIdDetection || 'none',
        sessionIdPattern: form.sessionIdPattern?.trim() || undefined,
        nodeVersion: form.nodeVersion?.trim() || undefined,
        envOverrides: parseEnvOverrides(envOverridesText),
        defaultModel: form.defaultModel?.trim() || undefined,
      })
      if (result.success) {
        await loadProviders()
        setEditingId(null)
      }
    } else if (editingId) {
      const updates: Partial<AIProvider> = {}
      const provider = providers.find(p => p.id === editingId)

      if (provider?.isBuiltin) {
        // 内置 provider：允许改 command、nodeVersion、envOverrides、executablePath、gitBashPath、defaultModel
        updates.command = form.command?.trim()
        updates.nodeVersion = form.nodeVersion?.trim() || undefined
        updates.envOverrides = parseEnvOverrides(envOverridesText)
        updates.executablePath = form.executablePath?.trim() || undefined
        updates.gitBashPath = form.gitBashPath?.trim() || undefined
        updates.defaultModel = form.defaultModel?.trim() || undefined
      } else {
        updates.name = form.name?.trim()
        updates.command = form.command?.trim()
        updates.icon = form.icon
        updates.defaultArgs = args
        updates.autoAcceptArg = form.autoAcceptArg?.trim() || undefined
        updates.resumeArg = form.resumeArg?.trim() || undefined
        updates.resumeFormat = form.resumeFormat || 'flag'
        updates.promptPassMode = form.promptPassMode
        updates.sessionIdDetection = form.sessionIdDetection
        updates.sessionIdPattern = form.sessionIdPattern?.trim() || undefined
        updates.nodeVersion = form.nodeVersion?.trim() || undefined
        updates.envOverrides = parseEnvOverrides(envOverridesText)
        updates.executablePath = form.executablePath?.trim() || undefined
        updates.gitBashPath = form.gitBashPath?.trim() || undefined
        updates.defaultModel = form.defaultModel?.trim() || undefined
      }

      const result = await window.spectrAI.provider.update(editingId, updates)
      if (result.success) {
        await loadProviders()
        setEditingId(null)
      }
    }
  }

  const handleDelete = async (id: string) => {
    const provider = providers.find(p => p.id === id)
    if (!provider || provider.isBuiltin) return

    if (!confirm(`确定要删除 "${provider.name}" 吗？`)) return

    const result = await window.spectrAI.provider.delete(id)
    if (result.success) {
      await loadProviders()
      if (editingId === id) setEditingId(null)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-bg-secondary rounded-lg shadow-2xl w-full max-w-lg border border-border max-h-[80vh] flex flex-col">
        {/* 头部 */}
        <div className="flex items-center justify-between p-4 border-b border-border flex-shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">AI 提供者管理</h2>
            <p className="text-[11px] text-text-muted mt-0.5">拖动左侧图标可调整显示顺序</p>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary btn-transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {/* Provider 列表（支持拖拽） */}
          {providers.map((p, index) => (
            <div
              key={p.id}
              draggable={editingId === null}
              onDragStart={() => handleDragStart(index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDrop={(e) => handleDrop(e, index)}
              onDragEnd={handleDragEnd}
              className={`rounded border transition-all ${
                editingId === p.id
                  ? 'border-accent-blue/40 bg-bg-primary'
                  : dragOverIndex === index
                    ? 'border-accent-blue/60 bg-accent-blue/5 scale-[1.01]'
                    : 'border-border bg-bg-hover'
              }`}
            >
              {editingId === p.id ? (
                /* 编辑表单 */
                <div className="p-3 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] text-text-muted mb-1">名称</label>
                      <input
                        type="text"
                        value={form.name || ''}
                        onChange={e => setForm({ ...form, name: e.target.value })}
                        disabled={p.isBuiltin && !isNew}
                        className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue disabled:opacity-50"
                        placeholder="显示名称"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-text-muted mb-1">命令/路径</label>
                      <input
                        type="text"
                        value={form.command || ''}
                        onChange={e => setForm({ ...form, command: e.target.value })}
                        className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue font-mono"
                        placeholder="例如 gemini 或 C:\\tools\\gemini\\gemini.cmd"
                      />
                    </div>
                  </div>

                  {!(p.isBuiltin && !isNew) && (
                    <>
                      <div>
                        <label className="block text-[11px] text-text-muted mb-1">默认参数（空格分隔）</label>
                        <input
                          type="text"
                          value={defaultArgsText}
                          onChange={e => setDefaultArgsText(e.target.value)}
                          className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue font-mono"
                          placeholder="例如 --verbose --model gpt-4"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[11px] text-text-muted mb-1">跳过确认参数</label>
                          <input
                            type="text"
                            value={form.autoAcceptArg || ''}
                            onChange={e => setForm({ ...form, autoAcceptArg: e.target.value })}
                            className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue font-mono"
                            placeholder="例如 --dangerously-skip-permissions"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] text-text-muted mb-1">恢复参数</label>
                          <input
                            type="text"
                            value={form.resumeArg || ''}
                            onChange={e => setForm({ ...form, resumeArg: e.target.value })}
                            className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue font-mono"
                            placeholder="例如 --resume（留空=不支持恢复）"
                          />
                        </div>
                      </div>
                      {form.resumeArg && (
                        <div>
                          <label className="block text-[11px] text-text-muted mb-1">恢复格式</label>
                          <select
                            value={form.resumeFormat || 'flag'}
                            onChange={e => setForm({ ...form, resumeFormat: e.target.value as any })}
                            className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
                          >
                            <option value="flag">参数标志（cmd --resume id）</option>
                            <option value="subcommand">子命令（cmd resume id）</option>
                          </select>
                          <p className="text-[10px] text-text-muted mt-0.5">
                            {form.resumeFormat === 'subcommand'
                              ? '子命令模式：恢复参数作为子命令，不附加默认参数'
                              : '参数标志模式：恢复参数附加在默认参数之后'}
                          </p>
                        </div>
                      )}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[11px] text-text-muted mb-1">Prompt 传递方式</label>
                          <select
                            value={form.promptPassMode || 'positional'}
                            onChange={e => setForm({ ...form, promptPassMode: e.target.value as any })}
                            className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
                          >
                            <option value="positional">位置参数</option>
                            <option value="stdin">标准输入 (stdin)</option>
                            <option value="none">不传递</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-[11px] text-text-muted mb-1">会话 ID 检测</label>
                          <select
                            value={form.sessionIdDetection || 'none'}
                            onChange={e => setForm({ ...form, sessionIdDetection: e.target.value as any })}
                            className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
                          >
                            <option value="claude-jsonl">Claude JSONL 文件</option>
                            <option value="output-regex">输出正则匹配</option>
                            <option value="none">不检测</option>
                          </select>
                        </div>
                      </div>
                      {form.sessionIdDetection === 'output-regex' && (
                        <div>
                          <label className="block text-[11px] text-text-muted mb-1">会话 ID 正则表达式</label>
                          <input
                            type="text"
                            value={form.sessionIdPattern || ''}
                            onChange={e => setForm({ ...form, sessionIdPattern: e.target.value })}
                            className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue font-mono"
                            placeholder="第一个捕获组=会话ID，如 session[=:]\\s*([a-f0-9-]{36})"
                          />
                          <p className="text-[10px] text-text-muted mt-0.5">
                            从 CLI 输出中匹配会话 ID（前 30 秒内扫描）
                          </p>
                        </div>
                      )}
                    </>
                  )}

                  {/* 默认模型（所有 Provider 包括内置都可配置） */}
                  <div>
                    <label className="block text-[11px] text-text-muted mb-1">默认模型</label>
                    <input
                      type="text"
                      value={form.defaultModel || ''}
                      onChange={e => setForm({ ...form, defaultModel: e.target.value })}
                      className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue font-mono"
                      placeholder="留空使用适配器默认值（如 claude-sonnet-4-6）"
                    />
                    <p className="text-[10px] text-text-muted mt-0.5">指定模型名称，例如 claude-opus-4-5-20251101</p>
                  </div>

                  {/* Node.js 版本切换 & 环境变量（所有 Provider 包括内置都可配置） */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] text-text-muted mb-1">Node.js 版本</label>
                      <select
                        value={form.nodeVersion || ''}
                        onChange={e => setForm({ ...form, nodeVersion: e.target.value })}
                        className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
                      >
                        <option value="">系统默认</option>
                        {nvmVersions.map(v => (
                          <option key={v} value={v}>v{v}</option>
                        ))}
                      </select>
                      {nvmVersions.length === 0 && (
                        <p className="text-[10px] text-text-muted mt-0.5">未检测到 nvm</p>
                      )}
                    </div>
                    <div>
                      <label className="block text-[11px] text-text-muted mb-1">自定义环境变量</label>
                      <textarea
                        value={envOverridesText}
                        onChange={e => setEnvOverridesText(e.target.value)}
                        className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue font-mono resize-none"
                        rows={2}
                        placeholder={'KEY=VALUE\nANOTHER=VAL'}
                      />
                    </div>
                  </div>

                  {/* Claude Code SDK 专属：可执行文件路径 */}
                  {(form.adapterType === 'claude-sdk' || p.adapterType === 'claude-sdk' || true) && (
                    <div className="border border-border/50 rounded p-2.5 space-y-2 bg-bg-hover/30">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] font-medium text-text-secondary">Claude Code 可执行文件路径</span>
                        {(form.adapterType !== 'claude-sdk' && p.adapterType !== 'claude-sdk') && (
                          <span className="text-[10px] text-text-muted">使用命令路径</span>
                        )}
                        {(form.adapterType === 'claude-sdk' || p.adapterType === 'claude-sdk')
                          ? <span className="text-[9px] text-text-muted bg-bg-secondary px-1 py-0.5 rounded">claude-sdk</span>
                          : <span className="text-[9px] text-text-muted bg-bg-secondary px-1 py-0.5 rounded">command</span>}
                      </div>
                      <div className="flex gap-1.5">
                        <input
                          type="text"
                          value={(form.adapterType === 'claude-sdk' || p.adapterType === 'claude-sdk') ? (form.executablePath || '') : (form.command || '')}
                          onChange={e => {
                            setForm(f => (form.adapterType === 'claude-sdk' || p.adapterType === 'claude-sdk') ? ({ ...f, executablePath: e.target.value }) : ({ ...f, command: e.target.value }))
                            setTestStatus('idle')
                            setTestResult(null)
                          }}
                          className="flex-1 px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue font-mono"
                          placeholder="留空自动检测（需已安装 claude CLI）"
                        />
                        <button
                          onClick={() => handleBrowseExecutable((form.adapterType === 'claude-sdk' || p.adapterType === 'claude-sdk') ? 'executablePath' : 'command')}
                          className="flex items-center gap-1 px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-muted hover:text-text-primary hover:border-accent-blue/50 btn-transition flex-shrink-0"
                          title="浏览文件"
                        >
                          <FolderOpen className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleTestExecutable((form.adapterType === 'claude-sdk' || p.adapterType === 'claude-sdk') ? 'claude-sdk' : p.adapterType)}
                          disabled={testStatus === 'testing'}
                          className="flex items-center gap-1 px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-muted hover:text-text-primary hover:border-accent-blue/50 btn-transition flex-shrink-0 disabled:opacity-50"
                          title="测试是否可用"
                        >
                          {testStatus === 'testing'
                            ? <Loader className="w-3.5 h-3.5 animate-spin" />
                            : <FlaskConical className="w-3.5 h-3.5" />}
                          测试
                        </button>
                      </div>
                      {/* 测试结果 */}
                      {testStatus === 'ok' && testResult && (
                        <div className="flex items-start gap-1.5 text-accent-green">
                          <CheckCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                          <span className="text-[11px] font-mono break-all">{testResult.path || '可用'}</span>
                        </div>
                      )}
                      {testStatus === 'error' && testResult && (
                        <div className="flex items-start gap-1.5 text-accent-red">
                          <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                          <span className="text-[11px]">{testResult.error || '检测失败'}</span>
                        </div>
                      )}
                      {(form.adapterType !== 'claude-sdk' && p.adapterType !== 'claude-sdk') && (
                        <p className="text-[10px] text-text-muted leading-relaxed">
                          非 Claude Provider 请优先在“命令/路径”中填写绝对路径；本输入框会同步改写该字段。
                        </p>
                      )}
                      <p className="text-[10px] text-text-muted leading-relaxed">
                        指定 <code className="bg-bg-secondary px-1 rounded">cli.js</code> 的完整路径可解决在客户机器上找不到 Claude Code 的问题。
                        留空时软件会自动搜索系统中已安装的 claude CLI。
                      </p>
                    </div>
                  )}

                  {/* Claude Code SDK 专属：git-bash 路径（Windows 必需） */}
                  {(form.adapterType === 'claude-sdk' || p.adapterType === 'claude-sdk') && (
                    <div className="border border-border/50 rounded p-2.5 space-y-2 bg-bg-hover/30">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] font-medium text-text-secondary">Git Bash 路径</span>
                        <span className="text-[9px] text-text-muted bg-bg-secondary px-1 py-0.5 rounded">Windows</span>
                      </div>
                      <input
                        type="text"
                        value={form.gitBashPath || ''}
                        onChange={e => setForm(f => ({ ...f, gitBashPath: e.target.value }))}
                        className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue font-mono"
                        placeholder="留空自动探测（如：C:\Program Files\Git\bin\bash.exe）"
                      />
                      <p className="text-[10px] text-text-muted leading-relaxed">
                        Claude Code 在 Windows 上依赖 <code className="bg-bg-secondary px-1 rounded">git-bash</code>，
                        若自动探测失败（Git 安装在非标准路径），请在此手动指定 <code className="bg-bg-secondary px-1 rounded">bash.exe</code> 的完整路径。
                      </p>
                    </div>
                  )}

                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={handleSave}
                      disabled={!form.name?.trim() || !form.command?.trim()}
                      className="flex items-center gap-1 px-3 py-1.5 bg-accent-blue text-white rounded text-xs font-medium btn-transition hover:bg-opacity-90 disabled:opacity-50"
                    >
                      <Save className="w-3 h-3" />
                      保存
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="px-3 py-1.5 bg-bg-hover text-text-secondary rounded text-xs btn-transition hover:bg-bg-tertiary"
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                /* 展示模式（含拖拽把手） */
                <div className="p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      {/* 拖拽把手 */}
                      <div
                        className="text-text-muted/40 hover:text-text-muted cursor-grab active:cursor-grabbing flex-shrink-0"
                        title="拖动调整顺序"
                      >
                        <GripVertical className="w-3.5 h-3.5" />
                      </div>
                      <ProviderIcon icon={p.icon} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium text-text-primary">{p.name}</span>
                          {p.isBuiltin && (
                            <span className="px-1 py-0.5 rounded text-[9px] bg-accent-blue/15 text-accent-blue leading-none">内置</span>
                          )}
                        </div>
                        <span className="text-[11px] text-text-muted font-mono">{p.command}</span>
                        <ProviderBadges provider={p} />
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {/* 测试连接按钮 */}
                      {(() => {
                        const ct = cardTestMap[p.id]
                        const status = ct?.status ?? 'idle'
                        const iconClass = status === 'ok'
                          ? 'text-accent-green'
                          : status === 'error'
                            ? 'text-accent-red'
                            : 'text-text-muted hover:text-text-primary'
                        return (
                          <button
                            onClick={() => handleCardTest(p)}
                            disabled={status === 'testing'}
                            className={`p-1.5 rounded hover:bg-bg-tertiary btn-transition disabled:opacity-50 ${iconClass}`}
                            title={ct?.message ?? '测试连接'}
                          >
                            {status === 'testing'
                              ? <Loader className="w-3.5 h-3.5 animate-spin" />
                              : status === 'ok'
                                ? <CheckCircle className="w-3.5 h-3.5" />
                                : status === 'error'
                                  ? <AlertCircle className="w-3.5 h-3.5" />
                                  : <FlaskConical className="w-3.5 h-3.5" />}
                          </button>
                        )
                      })()}
                      <button
                        onClick={() => handleEdit(p)}
                        className="p-1.5 rounded hover:bg-bg-tertiary text-text-muted hover:text-text-primary btn-transition"
                        title="编辑"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      {!p.isBuiltin && (
                        <button
                          onClick={() => handleDelete(p.id)}
                          className="p-1.5 rounded hover:bg-bg-tertiary text-text-muted hover:text-accent-red btn-transition"
                          title="删除"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                  {/* 测试结果详情（成功/失败后显示） */}
                  {cardTestMap[p.id] && cardTestMap[p.id].status !== 'idle' && cardTestMap[p.id].status !== 'testing' && (
                    <div className={`mt-1.5 ml-10 flex items-center gap-1 text-[10px] font-mono truncate ${
                      cardTestMap[p.id].status === 'ok' ? 'text-accent-green' : 'text-accent-red'
                    }`}>
                      <span className="truncate">{cardTestMap[p.id].message}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {/* 新增 Provider */}
          {editingId === '__new__' ? (
            <div className="p-3 rounded border border-accent-green/40 bg-bg-primary space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-text-muted mb-1">名称</label>
                  <input
                    type="text"
                    value={form.name || ''}
                    onChange={e => setForm({ ...form, name: e.target.value })}
                    className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
                    placeholder="例如 Codex CLI"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-text-muted mb-1">命令/路径</label>
                  <input
                    type="text"
                    value={form.command || ''}
                    onChange={e => setForm({ ...form, command: e.target.value })}
                    className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue font-mono"
                    placeholder="例如 codex 或 C:\\tools\\codex\\codex.cmd"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-text-muted mb-1">默认参数（空格分隔）</label>
                <input
                  type="text"
                  value={defaultArgsText}
                  onChange={e => setDefaultArgsText(e.target.value)}
                  className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue font-mono"
                  placeholder="可选"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-text-muted mb-1">跳过确认参数</label>
                  <input
                    type="text"
                    value={form.autoAcceptArg || ''}
                    onChange={e => setForm({ ...form, autoAcceptArg: e.target.value })}
                    className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue font-mono"
                    placeholder="可选"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-text-muted mb-1">恢复参数</label>
                  <input
                    type="text"
                    value={form.resumeArg || ''}
                    onChange={e => setForm({ ...form, resumeArg: e.target.value })}
                    className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue font-mono"
                    placeholder="留空=不支持恢复"
                  />
                </div>
              </div>
              {form.resumeArg && (
                <div>
                  <label className="block text-[11px] text-text-muted mb-1">恢复格式</label>
                  <select
                    value={form.resumeFormat || 'flag'}
                    onChange={e => setForm({ ...form, resumeFormat: e.target.value as any })}
                    className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
                  >
                    <option value="flag">参数标志（cmd --resume id）</option>
                    <option value="subcommand">子命令（cmd resume id）</option>
                  </select>
                  <p className="text-[10px] text-text-muted mt-0.5">
                    {form.resumeFormat === 'subcommand'
                      ? '子命令模式：恢复参数作为子命令，不附加默认参数'
                      : '参数标志模式：恢复参数附加在默认参数之后'}
                  </p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-text-muted mb-1">Prompt 传递方式</label>
                  <select
                    value={form.promptPassMode || 'positional'}
                    onChange={e => setForm({ ...form, promptPassMode: e.target.value as any })}
                    className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
                  >
                    <option value="positional">位置参数</option>
                    <option value="stdin">标准输入 (stdin)</option>
                    <option value="none">不传递</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-text-muted mb-1">会话 ID 检测</label>
                  <select
                    value={form.sessionIdDetection || 'none'}
                    onChange={e => setForm({ ...form, sessionIdDetection: e.target.value as any })}
                    className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
                  >
                    <option value="claude-jsonl">Claude JSONL 文件</option>
                    <option value="output-regex">输出正则匹配</option>
                    <option value="none">不检测</option>
                  </select>
                </div>
              </div>
              {form.sessionIdDetection === 'output-regex' && (
                <div>
                  <label className="block text-[11px] text-text-muted mb-1">会话 ID 正则表达式</label>
                  <input
                    type="text"
                    value={form.sessionIdPattern || ''}
                    onChange={e => setForm({ ...form, sessionIdPattern: e.target.value })}
                    className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue font-mono"
                    placeholder={'第一个捕获组=会话ID，如 session[=:]\\s*([a-f0-9-]{36})'}
                  />
                  <p className="text-[10px] text-text-muted mt-0.5">
                    从 CLI 输出中匹配会话 ID（前 30 秒内扫描）
                  </p>
                </div>
              )}
              {/* 默认模型 */}
              <div>
                <label className="block text-[11px] text-text-muted mb-1">默认模型</label>
                <input
                  type="text"
                  value={form.defaultModel || ''}
                  onChange={e => setForm({ ...form, defaultModel: e.target.value })}
                  className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue font-mono"
                  placeholder="留空使用适配器默认值（如 claude-sonnet-4-6）"
                />
                <p className="text-[10px] text-text-muted mt-0.5">指定模型名称，例如 claude-opus-4-5-20251101</p>
              </div>
              {/* Node.js 版本切换 */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-text-muted mb-1">Node.js 版本</label>
                  <select
                    value={form.nodeVersion || ''}
                    onChange={e => setForm({ ...form, nodeVersion: e.target.value })}
                    className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
                  >
                    <option value="">系统默认</option>
                    {nvmVersions.map(v => (
                      <option key={v} value={v}>v{v}</option>
                    ))}
                  </select>
                  {nvmVersions.length === 0 && (
                    <p className="text-[10px] text-text-muted mt-0.5">未检测到 nvm</p>
                  )}
                </div>
                <div>
                  <label className="block text-[11px] text-text-muted mb-1">自定义环境变量</label>
                  <textarea
                    value={envOverridesText}
                    onChange={e => setEnvOverridesText(e.target.value)}
                    className="w-full px-2 py-1.5 bg-bg-secondary border border-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue font-mono resize-none"
                    rows={2}
                    placeholder={'KEY=VALUE\nANOTHER=VAL'}
                  />
                </div>
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleSave}
                  disabled={!form.name?.trim() || !form.command?.trim()}
                  className="flex items-center gap-1 px-3 py-1.5 bg-accent-green text-white rounded text-xs font-medium btn-transition hover:bg-opacity-90 disabled:opacity-50"
                >
                  <Save className="w-3 h-3" />
                  创建
                </button>
                <button
                  onClick={() => setEditingId(null)}
                  className="px-3 py-1.5 bg-bg-hover text-text-secondary rounded text-xs btn-transition hover:bg-bg-tertiary"
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={handleNew}
              className="w-full p-3 rounded border border-dashed border-border hover:border-accent-green/50 text-text-muted hover:text-accent-green btn-transition flex items-center justify-center gap-2 text-xs"
            >
              <Plus className="w-4 h-4" />
              添加自定义 AI 提供者
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
