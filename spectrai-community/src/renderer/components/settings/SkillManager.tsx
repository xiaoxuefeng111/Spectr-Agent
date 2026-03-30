/**
 * Skill 技能模板管理页面
 * 通过 /命令 在任意 Provider 的会话中调用技能模板
 * @author weibin
 */
import React, { useState, useEffect, useRef } from 'react'
import { useSkillStore } from '../../stores/skillStore'
import type { Skill } from '../../../shared/types'

// 过滤类型配置
const SKILL_TYPES = [
  { id: 'all',           label: '全部'    },
  { id: 'prompt',        label: 'Prompt 技能' },
  { id: 'orchestration', label: '编排技能'   },
  { id: 'native',        label: '原生技能'   },
  { id: 'builtin',       label: '内置'    },
]

// 技能类型颜色
const TYPE_COLORS: Record<string, string> = {
  prompt:        'bg-accent-blue/15 text-accent-blue',
  orchestration: 'bg-accent-purple/15 text-accent-purple',
  native:        'bg-accent-green/15 text-accent-green',
}

// Provider 显示映射
const PROVIDER_LABELS: Record<string, string> = {
  'claude-code': 'Claude',
  'codex':       'Codex',
  'gemini-cli':  'Gemini',
  'iflow':       'iFlow',
  'opencode':    'OpenCode',
}

// 市场技能分类标签颜色
const CATEGORY_COLORS: Record<string, string> = {
  development: 'bg-blue-500/15 text-blue-400',
  database:    'bg-orange-500/15 text-orange-400',
  security:    'bg-red-500/15 text-red-400',
  language:    'bg-green-500/15 text-green-400',
  general:     'bg-gray-500/15 text-gray-400',
}

// 市场技能分类名
const CATEGORY_LABELS: Record<string, string> = {
  development: '开发',
  database:    '数据库',
  security:    '安全',
  language:    '语言',
  general:     '通用',
}

// ── 折叠式说明卡片 ──
function InfoCard() {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="mb-4 bg-blue-500/10 border border-blue-500/20 rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-2.5 text-left"
        onClick={() => setExpanded(v => !v)}
      >
        <span className="text-xs font-medium text-blue-400">💡 技能 vs MCP 是什么关系？</span>
        <svg
          className={`w-4 h-4 text-blue-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div className="px-4 pb-3 text-xs text-blue-300/80 space-y-1 leading-relaxed">
          <p>• <strong className="text-blue-300">技能（Skill）</strong> = 快捷 Prompt 模板，输入 /命令 后展开发送给 AI</p>
          <p>• <strong className="text-blue-300">MCP</strong> = 给 AI 增加真实工具能力（读文件、查数据库等）</p>
          <p>• 两者可以结合：<strong className="text-blue-300">技能可以依赖 MCP 工具</strong>来完成任务</p>
        </div>
      )}
    </div>
  )
}

// ── 市场技能卡片 ──
interface MarketSkillItem {
  id: string
  name: string
  description: string
  category?: string
  slashCommand?: string
  type: string
  author?: string
  version?: string
  tags?: string[]
  downloadUrl?: string
  promptTemplate?: string
  systemPromptAddition?: string
  compatibleProviders?: string[] | 'all'
}

function MarketSkillCard({
  item,
  installed,
  installing,
  onInstall,
}: {
  item: MarketSkillItem
  installed: boolean
  installing: boolean
  onInstall: () => void
}) {
  const catColor = CATEGORY_COLORS[item.category || 'general'] || CATEGORY_COLORS.general
  const catLabel = CATEGORY_LABELS[item.category || 'general'] || item.category || '通用'

  return (
    <div className="border border-border rounded-lg px-4 py-3 bg-bg-secondary hover:border-blue-500/30 transition-colors">
      <div className="flex items-start justify-between gap-3">
        {/* 左侧信息 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-text-primary">{item.name}</span>
            {item.slashCommand && (
              <span className="text-xs font-mono text-accent-blue bg-accent-blue/10 px-1.5 py-0.5 rounded border border-accent-blue/20 flex-shrink-0">
                /{item.slashCommand}
              </span>
            )}
            <span className={`text-xs px-1.5 py-0.5 rounded flex-shrink-0 ${catColor}`}>
              {catLabel}
            </span>
            {item.type && (
              <span className={`text-xs px-1.5 py-0.5 rounded flex-shrink-0 ${TYPE_COLORS[item.type] || 'bg-bg-hover text-text-secondary'}`}>
                {item.type}
              </span>
            )}
          </div>
          <p className="text-xs text-text-muted mt-1 leading-relaxed">{item.description}</p>
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            {item.author && (
              <span className="text-xs text-text-muted">👤 {item.author}</span>
            )}
            {item.version && (
              <span className="text-xs text-text-muted">v{item.version}</span>
            )}
            {item.tags && item.tags.length > 0 && (
              <div className="flex gap-1 flex-wrap">
                {item.tags.slice(0, 4).map(tag => (
                  <span key={tag} className="text-xs px-1 py-0.5 bg-bg-hover text-text-muted rounded">
                    #{tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 右侧操作 */}
        <div className="flex-shrink-0">
          {installed ? (
            <span className="flex items-center gap-1 text-xs text-green-400 bg-green-500/10 border border-green-500/20 px-3 py-1.5 rounded-md">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              已安装
            </span>
          ) : (
            <button
              onClick={onInstall}
              disabled={installing}
              className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-md transition-colors whitespace-nowrap"
            >
              {installing ? (
                <span className="flex items-center gap-1">
                  <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  安装中
                </span>
              ) : '+ 安装'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── 技能市场 Tab ──
function MarketplaceTab({ installedSkills, onInstalled }: { installedSkills: Skill[]; onInstalled: () => void }) {
  const [items, setItems] = useState<MarketSkillItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installingIds, setInstallingIds] = useState<Set<string>>(new Set())
  const [successIds, setSuccessIds] = useState<Set<string>>(new Set())
  const [filterCat, setFilterCat] = useState('all')
  const [searchQ, setSearchQ] = useState('')

  const installedIds = new Set(installedSkills.map(s => s.id))

  useEffect(() => {
    fetchMarket()
  }, [])

  const fetchMarket = async () => {
    setLoading(true)
    setError(null)
    try {
      const spectrAI = (window as any).spectrAI
      const result = await spectrAI?.registry?.fetchSkills?.()
      if (Array.isArray(result)) {
        setItems(result)
      } else {
        setError('暂无数据，请检查网络或 Registry URL 配置')
      }
    } catch (e: any) {
      setError(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }

  const handleInstall = async (item: MarketSkillItem) => {
    setInstallingIds(prev => new Set(prev).add(item.id))
    try {
      const spectrAI = (window as any).spectrAI
      let result: { success: boolean; error?: string } | null = null

      if (item.downloadUrl) {
        // 优先通过 URL 导入（主进程 fetch + createSkill）
        result = await spectrAI?.registry?.importSkillFromUrl?.(item.downloadUrl)
      }

      if (!result?.success) {
        // 降级：直接用 registry 返回的数据在本地创建
        const now = new Date().toISOString()
        const skillData: Omit<Skill, 'createdAt' | 'updatedAt'> = {
          id: item.id || `skill-${Date.now()}`,
          name: item.name,
          description: item.description || '',
          category: item.category || 'general',
          slashCommand: item.slashCommand,
          type: (item.type || 'prompt') as Skill['type'],
          compatibleProviders: item.compatibleProviders || 'all',
          promptTemplate: item.promptTemplate,
          systemPromptAddition: item.systemPromptAddition,
          author: item.author,
          version: item.version,
          tags: item.tags,
          isInstalled: true,
          isEnabled: true,
          source: 'marketplace',
        }
        result = await spectrAI?.skill?.create?.(skillData)
      }

      if (result?.success) {
        setSuccessIds(prev => new Set(prev).add(item.id))
        onInstalled()
      } else {
        setError(`安装"${item.name}"失败：${result?.error || '未知错误'}`)
      }
    } catch (e: any) {
      setError(`安装失败：${e.message}`)
    } finally {
      setInstallingIds(prev => {
        const next = new Set(prev)
        next.delete(item.id)
        return next
      })
    }
  }

  // 分类列表
  const categories = ['all', ...Array.from(new Set(items.map(i => i.category || 'general')))]

  const filtered = items.filter(item => {
    const matchCat = filterCat === 'all' || (item.category || 'general') === filterCat
    const matchSearch = !searchQ || [item.name, item.description, ...(item.tags || [])].some(
      s => s?.toLowerCase().includes(searchQ.toLowerCase())
    )
    return matchCat && matchSearch
  })

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-text-muted gap-3">
        <svg className="w-6 h-6 animate-spin text-blue-400" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="text-sm">正在加载技能市场...</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 mb-3">
        <input
          type="text"
          value={searchQ}
          onChange={e => setSearchQ(e.target.value)}
          placeholder="搜索技能..."
          className="flex-1 bg-bg-input border border-border text-text-primary text-sm rounded-md px-3 py-1.5 focus:outline-none focus:border-blue-500"
        />
        <button
          onClick={fetchMarket}
          className="px-3 py-1.5 text-xs border border-border text-text-secondary hover:text-text-primary rounded-md transition-colors flex-shrink-0"
          title="刷新列表"
        >
          ↺ 刷新
        </button>
      </div>

      {/* 分类过滤 */}
      {items.length > 0 && (
        <div className="flex gap-1 mb-3 flex-wrap">
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => setFilterCat(cat)}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                filterCat === cat
                  ? 'bg-blue-600 text-white'
                  : 'bg-bg-hover text-text-muted hover:text-text-secondary'
              }`}
            >
              {cat === 'all' ? '全部' : (CATEGORY_LABELS[cat] || cat)}
            </button>
          ))}
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="mb-3 px-3 py-2 bg-accent-red/10 border border-accent-red/30 rounded-md text-accent-red text-sm flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-accent-red hover:text-accent-red ml-2">✕</button>
        </div>
      )}

      {/* 列表 */}
      {filtered.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-text-muted">
          <div className="text-4xl mb-3">🛒</div>
          <div className="text-sm">
            {items.length === 0
              ? 'Registry 暂无可用技能'
              : '没有匹配的技能'}
          </div>
          {items.length === 0 && (
            <div className="text-xs mt-1 text-center max-w-[280px]">
              请在设置中配置 Registry URL，或检查网络连接
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto space-y-2">
          {filtered.map(item => (
            <MarketSkillCard
              key={item.id}
              item={item}
              installed={installedIds.has(item.id) || successIds.has(item.id)}
              installing={installingIds.has(item.id)}
              onInstall={() => handleInstall(item)}
            />
          ))}
        </div>
      )}

      {/* 底部说明 */}
      {items.length > 0 && (
        <div className="mt-3 pt-3 border-t border-border">
          <p className="text-xs text-text-muted text-center">
            共 {items.length} 个技能 · 数据来源于 Registry · 已安装的技能可在"我的技能"中管理
          </p>
        </div>
      )}
    </div>
  )
}

export default function SkillManager() {
  const { skills, loading, error, fetchAll, create, update, remove, toggle, clearError } = useSkillStore()
  const [mainTab, setMainTab] = useState<'mine' | 'market'>('mine')
  const [activeType, setActiveType] = useState('all')
  const [showEditor, setShowEditor] = useState(false)
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null)
  const [showImportDialog, setShowImportDialog] = useState(false)

  useEffect(() => { fetchAll() }, [])

  const filteredSkills = skills.filter(s => {
    if (activeType === 'all')     return true
    if (activeType === 'builtin') return s.source === 'builtin'
    return s.type === activeType
  })

  return (
    <div className="flex flex-col h-full">
      {/* 顶部主 Tab 切换 */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-text-primary">技能库</h2>
          <p className="text-xs text-text-muted mt-0.5">通过 /命令 在任意 Provider 的会话中调用技能模板</p>
        </div>
        {mainTab === 'mine' && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowImportDialog(true)}
              className="px-3 py-1.5 border border-border hover:border-border text-text-secondary hover:text-text-primary text-sm rounded-md transition-colors"
            >
              📥 从 URL 导入
            </button>
            <button
              onClick={() => { setEditingSkill(null); setShowEditor(true) }}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-md transition-colors"
            >
              + 新建技能
            </button>
          </div>
        )}
      </div>

      {/* 主 Tab 导航 */}
      <div className="flex gap-1 mb-4 border-b border-border">
        <button
          onClick={() => setMainTab('mine')}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            mainTab === 'mine'
              ? 'text-blue-400 border-b-2 border-blue-500 -mb-px'
              : 'text-text-muted hover:text-text-secondary'
          }`}
        >
          我的技能
          {skills.length > 0 && (
            <span className="ml-1.5 text-xs bg-bg-hover text-text-muted px-1.5 py-0.5 rounded-full">
              {skills.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setMainTab('market')}
          className={`px-4 py-2 text-sm font-medium transition-colors flex items-center gap-1.5 ${
            mainTab === 'market'
              ? 'text-blue-400 border-b-2 border-blue-500 -mb-px'
              : 'text-text-muted hover:text-text-secondary'
          }`}
        >
          🛒 技能市场
        </button>
      </div>

      {/* 我的技能 Tab */}
      {mainTab === 'mine' && (
        <>
          {/* 说明卡片 */}
          <InfoCard />

          {/* 错误提示 */}
          {error && (
            <div className="mb-3 px-3 py-2 bg-accent-red/10 border border-accent-red/30 rounded-md text-accent-red text-sm flex items-center justify-between">
              <span>{error}</span>
              <button onClick={clearError} className="text-accent-red hover:text-accent-red">✕</button>
            </div>
          )}

          {/* 类型过滤 */}
          <div className="flex gap-1 mb-4 border-b border-border">
            {SKILL_TYPES.map(t => (
              <button
                key={t.id}
                onClick={() => setActiveType(t.id)}
                className={`px-3 py-1.5 text-xs rounded-t-md transition-colors ${
                  activeType === t.id
                    ? 'text-blue-400 border-b-2 border-blue-500 -mb-px'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Skill 列表 */}
          {loading ? (
            <div className="flex-1 flex items-center justify-center text-text-muted text-sm">加载中...</div>
          ) : filteredSkills.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-text-muted">
              <div className="text-4xl mb-3">🎯</div>
              <div className="text-sm">暂无技能</div>
              <div className="text-xs mt-1">点击"新建技能"创建，或前往"技能市场"一键安装热门技能</div>
              <button
                onClick={() => setMainTab('market')}
                className="mt-3 px-3 py-1.5 text-xs bg-blue-600/20 text-blue-400 border border-blue-500/30 rounded-md hover:bg-blue-600/30 transition-colors"
              >
                去技能市场看看 →
              </button>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto space-y-2">
              {filteredSkills.map(skill => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  onToggle={(enabled) => toggle(skill.id, enabled)}
                  onEdit={() => { setEditingSkill(skill); setShowEditor(true) }}
                  onDelete={() => remove(skill.id)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* 技能市场 Tab */}
      {mainTab === 'market' && (
        <MarketplaceTab
          installedSkills={skills}
          onInstalled={fetchAll}
        />
      )}

      {/* 编辑弹窗 */}
      {showEditor && (
        <SkillEditorDialog
          skill={editingSkill}
          onClose={() => { setShowEditor(false); setEditingSkill(null) }}
          onSave={async (data) => {
            if (editingSkill) {
              await update(editingSkill.id, data)
            } else {
              await create(data as any)
            }
            setShowEditor(false)
            setEditingSkill(null)
          }}
        />
      )}
      {showImportDialog && (
        <SkillImportDialog
          onClose={() => setShowImportDialog(false)}
          onImported={() => fetchAll()}
        />
      )}
    </div>
  )
}

// ── Skill 卡片 ──
function SkillCard({ skill, onToggle, onEdit, onDelete }: {
  skill: Skill
  onToggle: (enabled: boolean) => void
  onEdit: () => void
  onDelete: () => void
}) {
  const isBuiltin = skill.source === 'builtin'

  return (
    <div className={`border rounded-lg px-4 py-3 flex items-center gap-3 transition-colors ${
      skill.isEnabled
        ? 'border-border/50 bg-bg-secondary'
        : 'border-border bg-bg-tertiary opacity-60'
    }`}>
      {/* 斜杠命令 */}
      <div className="flex-shrink-0 text-xs font-mono text-accent-blue bg-accent-blue/10 px-2 py-1 rounded border border-accent-blue/20 min-w-[80px] text-center">
        {skill.slashCommand ? `/${skill.slashCommand}` : '—'}
      </div>

      {/* 主信息 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-primary truncate">{skill.name}</span>
          {isBuiltin && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-bg-hover text-text-secondary">内置</span>
          )}
          {skill.source === 'marketplace' && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-400">市场</span>
          )}
          <span className={`text-xs px-1.5 py-0.5 rounded ${TYPE_COLORS[skill.type] || 'bg-bg-hover text-text-secondary'}`}>
            {skill.type}
          </span>
        </div>
        <div className="text-xs text-text-muted truncate mt-0.5">{skill.description}</div>
        <div className="flex items-center gap-1 mt-1">
          <span className="text-xs text-text-muted">兼容：</span>
          <span className="text-xs text-text-muted">
            {skill.compatibleProviders === 'all'
              ? '所有 Provider'
              : Array.isArray(skill.compatibleProviders)
                ? skill.compatibleProviders.map(p => PROVIDER_LABELS[p] || p).join(', ')
                : '所有 Provider'}
          </span>
        </div>
      </div>

      {/* 操作 */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {!isBuiltin && (
          <button onClick={onEdit} className="text-text-muted hover:text-text-secondary text-sm" title="编辑">✎</button>
        )}
        {!isBuiltin && (
          <button onClick={onDelete} className="text-text-muted hover:text-red-400 text-sm" title="删除">✕</button>
        )}
        {isBuiltin ? (
          <span className="text-xs text-text-muted" title="内置技能不可禁用">🔒</span>
        ) : (
          <button
            onClick={() => onToggle(!skill.isEnabled)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              skill.isEnabled ? 'bg-blue-600' : 'bg-bg-hover'
            }`}
          >
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              skill.isEnabled ? 'translate-x-4' : 'translate-x-1'
            }`} />
          </button>
        )}
      </div>
    </div>
  )
}

// 预览时变量示例值映射
const PREVIEW_EXAMPLES: Record<string, string> = {
  user_input:   '用户输入的内容示例',
  file_content: '[文件内容]',
  selection:    '[选中的文本]',
}

/** 将模板中的 {{变量名}} 替换为示例值 */
function renderPreview(template: string): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name) =>
    PREVIEW_EXAMPLES[name] !== undefined ? PREVIEW_EXAMPLES[name] : `[${name}]`
  )
}

// ── 创建/编辑技能弹窗 ──
function SkillEditorDialog({ skill, onClose, onSave }: {
  skill: Skill | null
  onClose: () => void
  onSave: (data: Partial<Skill>) => Promise<void>
}) {
  const isEdit = !!skill
  const [form, setForm] = useState({
    name:                skill?.name || '',
    description:         skill?.description || '',
    category:            skill?.category || 'general',
    slashCommand:        skill?.slashCommand || '',
    type:                (skill?.type || 'prompt') as Skill['type'],
    compatibleProviders: skill?.compatibleProviders || ('all' as string[] | 'all'),
    promptTemplate:      skill?.promptTemplate || '',
    systemPromptAddition: skill?.systemPromptAddition || '',
  })
  const [allProviders, setAllProviders] = useState(!skill || skill.compatibleProviders === 'all')
  const [saving, setSaving] = useState(false)
  const [showPreview, setShowPreview] = useState(false)

  // textarea ref，用于光标位置插入
  const templateRef = useRef<HTMLTextAreaElement>(null)

  const PROVIDERS = ['claude-code', 'codex', 'gemini-cli', 'iflow', 'opencode']

  /** 在光标处插入变量占位符 */
  const insertVariable = (varName: string) => {
    const textarea = templateRef.current
    if (!textarea) return
    const start = textarea.selectionStart ?? form.promptTemplate.length
    const end   = textarea.selectionEnd   ?? start
    const insertion = `{{${varName}}}`
    const newValue =
      form.promptTemplate.slice(0, start) +
      insertion +
      form.promptTemplate.slice(end)
    setForm(p => ({ ...p, promptTemplate: newValue }))
    // 下一帧恢复焦点并定位光标到插入内容之后
    requestAnimationFrame(() => {
      textarea.focus()
      const cursor = start + insertion.length
      textarea.setSelectionRange(cursor, cursor)
    })
  }

  /** 弹出自定义变量名输入框，然后插入 */
  const insertCustomVariable = () => {
    const name = window.prompt('请输入变量名（字母、数字、下划线）：')
    if (!name) return
    const cleaned = name.trim().replace(/[^\w]/g, '_')
    if (cleaned) insertVariable(cleaned)
  }

  const handleSave = async () => {
    if (!form.name.trim()) return
    setSaving(true)
    const now = new Date().toISOString()
    await onSave({
      ...form,
      compatibleProviders: allProviders
        ? 'all'
        : (Array.isArray(form.compatibleProviders) ? form.compatibleProviders : []),
      isInstalled: true,
      isEnabled:   true,
      source:      'custom',
      id:          skill?.id || `skill-${Date.now()}`,
      createdAt:   skill?.createdAt || now,
      updatedAt:   now,
    })
    setSaving(false)
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-bg-secondary border border-border rounded-xl w-[600px] max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-sm font-semibold text-text-primary">
            {isEdit ? '编辑技能' : '新建技能'}
          </h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-secondary">✕</button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* 名称 + 斜杠命令 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-secondary mb-1.5">
                技能名称 <span className="text-red-400">*</span>
              </label>
              <input
                value={form.name}
                onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                className="w-full bg-bg-input border border-border text-text-primary text-sm rounded-md px-3 py-2 focus:outline-none focus:border-blue-500"
                placeholder="如：代码审查"
              />
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1.5">/slash 命令</label>
              <div className="flex">
                <span className="px-2 py-2 bg-bg-tertiary border border-r-0 border-border rounded-l-md text-text-secondary text-sm">/</span>
                <input
                  value={form.slashCommand}
                  onChange={e => setForm(p => ({
                    ...p,
                    slashCommand: e.target.value.replace(/[^a-z0-9-]/g, ''),
                  }))}
                  className="flex-1 bg-bg-input border border-border text-text-primary text-sm rounded-r-md px-3 py-2 focus:outline-none focus:border-blue-500"
                  placeholder="code-review"
                />
              </div>
            </div>
          </div>

          {/* 描述 */}
          <div>
            <label className="block text-xs text-text-secondary mb-1.5">描述</label>
            <input
              value={form.description}
              onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
              className="w-full bg-bg-input border border-border text-text-primary text-sm rounded-md px-3 py-2 focus:outline-none focus:border-blue-500"
              placeholder="简短描述这个技能的功能"
            />
          </div>

          {/* 类型 + 分类 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-secondary mb-1.5">类型</label>
              <select
                value={form.type}
                onChange={e => setForm(p => ({ ...p, type: e.target.value as any }))}
                className="w-full bg-bg-input border border-border text-text-primary text-sm rounded-md px-3 py-2 focus:outline-none focus:border-blue-500"
              >
                <option value="prompt">Prompt 技能（展开模板发送给 AI）</option>
                <option value="native">原生技能（使用 Provider 特定功能）</option>
                <option value="orchestration">编排技能（多 AI 协作工作流）</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1.5">分类</label>
              <input
                value={form.category}
                onChange={e => setForm(p => ({ ...p, category: e.target.value }))}
                className="w-full bg-bg-input border border-border text-text-primary text-sm rounded-md px-3 py-2 focus:outline-none focus:border-blue-500"
                placeholder="如：development, language"
              />
            </div>
          </div>

          {/* 兼容 Provider */}
          <div>
            <label className="block text-xs text-text-secondary mb-1.5">兼容 Provider</label>
            <div className="flex items-center gap-2 mb-2">
              <input
                type="checkbox"
                id="skill-all-providers"
                checked={allProviders}
                onChange={e => setAllProviders(e.target.checked)}
                className="rounded"
              />
              <label htmlFor="skill-all-providers" className="text-xs text-text-secondary">所有 Provider</label>
              {allProviders && (
                <span className="text-xs text-text-muted">技能会向所有 AI 发送相同 Prompt</span>
              )}
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

          {/* Prompt 模板（仅 prompt 类型） */}
          {form.type === 'prompt' && (
            <>
              <div>
                <label className="block text-xs text-text-secondary mb-1.5">提示词模板</label>

                {/* 变量快速插入工具栏 */}
                <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                  <span className="text-xs text-text-muted mr-0.5">插入变量：</span>
                  {(['user_input', 'file_content', 'selection'] as const).map(varName => (
                    <button
                      key={varName}
                      type="button"
                      onClick={() => insertVariable(varName)}
                      className="px-2 py-1 text-xs bg-bg-hover hover:bg-bg-tertiary text-text-secondary rounded transition-colors font-mono"
                    >
                      {`{{${varName}}}`}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={insertCustomVariable}
                    className="px-2 py-1 text-xs bg-bg-hover hover:bg-bg-tertiary text-text-secondary rounded transition-colors"
                  >
                    + 自定义
                  </button>
                  <div className="flex-1" />
                  <button
                    type="button"
                    onClick={() => setShowPreview(v => !v)}
                    className={`px-2 py-1 text-xs rounded transition-colors ${
                      showPreview
                        ? 'bg-blue-600/30 text-blue-400 border border-blue-500/30'
                        : 'bg-bg-hover hover:bg-bg-tertiary text-text-secondary'
                    }`}
                  >
                    {showPreview ? '隐藏预览' : '👁 预览'}
                  </button>
                </div>

                <textarea
                  ref={templateRef}
                  value={form.promptTemplate}
                  onChange={e => setForm(p => ({ ...p, promptTemplate: e.target.value }))}
                  rows={8}
                  className="w-full bg-bg-input border border-border text-text-primary text-sm rounded-md px-3 py-2 focus:outline-none focus:border-blue-500 font-mono resize-y"
                  placeholder={'请对以下代码进行审查：\n\n{{user_input}}\n\n重点关注：\n1. 逻辑正确性\n2. 性能\n3. 安全性'}
                />

                {/* 占位符提示 */}
                <p className="text-xs text-text-muted mt-1">
                  支持 <code className="text-text-secondary bg-bg-hover px-1 rounded">{`{{变量名}}`}</code> 占位符，触发技能时会提示用户输入
                </p>

                {/* 预览区域 */}
                {showPreview && (
                  <div className="mt-2">
                    <div className="text-xs text-text-muted mb-1">预览效果（变量已替换为示例值）：</div>
                    <div className="bg-bg-input border border-border rounded p-3 text-sm text-text-primary whitespace-pre-wrap font-mono leading-relaxed">
                      {form.promptTemplate
                        ? renderPreview(form.promptTemplate)
                        : <span className="text-text-muted italic">（模板为空）</span>
                      }
                    </div>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs text-text-secondary mb-1.5">系统提示词补充（可选）</label>
                <textarea
                  value={form.systemPromptAddition}
                  onChange={e => setForm(p => ({ ...p, systemPromptAddition: e.target.value }))}
                  rows={3}
                  className="w-full bg-bg-input border border-border text-text-primary text-sm rounded-md px-3 py-2 focus:outline-none focus:border-blue-500 font-mono resize-y"
                  placeholder="追加到系统提示词的内容（可选）"
                />
              </div>
            </>
          )}

          {/* Orchestration 类型提示 */}
          {form.type === 'orchestration' && (
            <div className="px-3 py-2 bg-accent-purple/10 border border-accent-purple/30 rounded-md text-accent-purple text-xs">
              编排技能的步骤配置需要通过 API 设置，当前 UI 支持基础信息编辑。复杂的多步骤编排建议使用内置模板。
            </div>
          )}

          {/* Native 类型提示 */}
          {form.type === 'native' && (
            <div className="px-3 py-2 bg-green-900/20 border border-green-800/30 rounded-md text-green-400 text-xs">
              原生技能直接调用所选 Provider 的特定功能，行为由 Provider 自身决定。
            </div>
          )}
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
            {saving ? '保存中...' : (isEdit ? '更新' : '创建')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 从 URL 导入技能弹窗 ──
function SkillImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [url, setUrl] = useState('')
  const [preview, setPreview] = useState<any | null>(null)
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleFetchPreview = async () => {
    if (!url.trim()) return
    setLoading(true)
    setError(null)
    setPreview(null)
    try {
      const res = await fetch(url.trim())
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (!data.name || !data.type) throw new Error('无效的 Skill 格式')
      setPreview(data)
    } catch (e: any) {
      setError(e.message || '获取失败')
    } finally {
      setLoading(false)
    }
  }

  const handleImport = async () => {
    setImporting(true)
    try {
      const result = await (window as any).spectrAI?.registry?.importSkillFromUrl?.(url.trim())
      if (result?.success) {
        onImported()
        onClose()
      } else {
        setError(result?.error || '导入失败')
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-bg-secondary border border-border rounded-xl w-[520px]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-sm font-semibold text-text-primary">从 URL 导入技能</h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-secondary">✕</button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="block text-xs text-text-secondary mb-1.5">Skill JSON URL</label>
            <div className="flex gap-2">
              <input
                value={url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleFetchPreview()}
                className="flex-1 bg-bg-input border border-border text-text-primary text-sm rounded-md px-3 py-2 focus:outline-none focus:border-blue-500"
                placeholder="https://raw.githubusercontent.com/..."
              />
              <button
                onClick={handleFetchPreview}
                disabled={loading || !url.trim()}
                className="px-3 py-2 text-sm bg-bg-hover hover:bg-bg-hover disabled:opacity-50 text-text-primary rounded-md transition-colors whitespace-nowrap"
              >
                {loading ? '获取中...' : '获取预览'}
              </button>
            </div>
          </div>

          {error && (
            <div className="text-xs text-red-400 bg-red-900/20 border border-red-800/30 rounded px-3 py-2">
              {error}
            </div>
          )}

          {preview && (
            <div className="bg-bg-tertiary border border-border rounded-lg px-4 py-3 space-y-1.5">
              <div className="text-xs text-text-muted mb-2">预览</div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text-primary">{preview.name}</span>
                {preview.slashCommand && (
                  <span className="text-xs font-mono text-accent-blue bg-accent-blue/10 px-1.5 py-0.5 rounded border border-accent-blue/20">
                    /{preview.slashCommand}
                  </span>
                )}
                <span className={`text-xs px-1.5 py-0.5 rounded ${
                  preview.type === 'orchestration' ? 'bg-accent-purple/15 text-accent-purple' : 'bg-accent-blue/15 text-accent-blue'
                }`}>
                  {preview.type}
                </span>
              </div>
              {preview.description && (
                <div className="text-xs text-text-muted">{preview.description}</div>
              )}
              {preview.author && (
                <div className="text-xs text-text-muted">作者：{preview.author}</div>
              )}
            </div>
          )}

          <div className="text-xs text-text-muted">
            支持格式：标准 SpectrAI Skill JSON（含 name、type、promptTemplate 等字段）
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-border">
          <button onClick={onClose} className="px-4 py-1.5 text-sm text-text-secondary hover:text-text-primary">取消</button>
          <button
            onClick={handleImport}
            disabled={!preview || importing}
            className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-md transition-colors"
          >
            {importing ? '导入中...' : '确认导入'}
          </button>
        </div>
      </div>
    </div>
  )
}
