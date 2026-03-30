/**
 * Session 工具栏组件
 *
 * 显示在消息输入框上方，提供两类快捷入口：
 * 1. Skill 按钮：显示可用 Skill 数量，点击弹出列表，列表中点击注入 /slashCommand 到输入框
 * 2. MCP 状态按钮：显示当前会话已启用的 MCP 数量，点击弹出只读列表
 *
 * Skill 来源合并策略（三类来源）：
 *   - SpectrAI DB Skill：isEnabled + 有 slashCommand + compatibleProviders 兼容当前 Provider
 *   - Provider 原生命令：来自 sessionInitData.skills（Claude Code 的 /compact、/memory 等）
 *   - 去重规则：DB Skill 优先，原生命令中与 DB 同名的 slashCommand 不重复展示
 *
 * @author weibin
 */

import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useSessionStore } from '../../stores/sessionStore'
import { useSkillStore } from '../../stores/skillStore'
import { useMcpStore } from '../../stores/mcpStore'

// ---- 类型 ----

/** 展示在 Popover 中的统一 Skill 条目 */
export interface SkillItem {
  slashCommand: string
  name: string
  description: string
  /** 来源标识，用于在 Popover 中显示不同的视觉标记 */
  source: 'custom' | 'builtin' | 'native'
  /**
   * Skill 类型
   * - 'prompt'：SpectrAI 管理的模板型 Skill，需要静默展开后发送
   * - 'native'：Provider 原生命令（/compact 等），直接插入输入框由 CLI 处理
   */
  type: 'prompt' | 'native' | 'orchestration'
  /** promptTemplate 原文（type==='prompt' 时有值） */
  promptTemplate?: string
}

interface SessionToolbarProps {
  sessionId: string
  /** 原生命令点击时回调：插入 "/slashCommand " 到输入框，由 CLI 原生处理 */
  onSkillClick: (command: string) => void
  /** Prompt 型 Skill 点击时回调：父组件负责静默展开并发送，不插入输入框 */
  onSkillExecute: (skill: SkillItem) => void
}

// ---- 通用 hook ----

/** Popover 通用的"点击外部 + Esc 关闭"逻辑 */
function usePopoverClose(
  open: boolean,
  setOpen: (v: boolean) => void,
  btnRef: React.RefObject<HTMLElement | null>,
  panelRef: React.RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return
    const handleOutside = (e: MouseEvent) => {
      if (
        btnRef.current?.contains(e.target as Node) ||
        panelRef.current?.contains(e.target as Node)
      ) return
      setOpen(false)
    }
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleOutside)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleOutside)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [open, setOpen, btnRef, panelRef])
}

// ---- 来源标记样式 ----

const SOURCE_DOT: Record<SkillItem['source'], string> = {
  custom:  'bg-accent-blue',
  builtin: 'bg-text-muted',
  native:  'bg-accent-green',
}

const SOURCE_LABEL: Record<SkillItem['source'], string> = {
  custom:  '自定义',
  builtin: '内置',
  native:  '原生',
}

// ---- 主组件 ----

const SessionToolbar: React.FC<SessionToolbarProps> = ({ sessionId, onSkillClick, onSkillExecute }) => {
  const [skillPopoverOpen, setSkillPopoverOpen] = useState(false)
  const [mcpPopoverOpen, setMcpPopoverOpen] = useState(false)
  /** Skill 搜索框内容 */
  const [skillFilter, setSkillFilter] = useState('')

  const skillBtnRef = useRef<HTMLButtonElement>(null)
  const skillPopoverRef = useRef<HTMLDivElement>(null)
  const skillFilterRef = useRef<HTMLInputElement>(null)
  const mcpBtnRef = useRef<HTMLButtonElement>(null)
  const mcpPopoverRef = useRef<HTMLDivElement>(null)

  // ---- 数据来源 ----
  const initData = useSessionStore(s => s.sessionInitData[sessionId])
  // 当前会话的 Provider（用于过滤 compatibleProviders）
  const providerId = useSessionStore(s =>
    s.sessions.find(sess => sess.id === sessionId)?.providerId
  )
  const allSkills = useSkillStore(s => s.skills)
  const fetchSkills = useSkillStore(s => s.fetchAll)
  const allMcpServers = useMcpStore(s => s.servers)
  const fetchMcps = useMcpStore(s => s.fetchAll)

  // 首次挂载时确保数据已加载
  useEffect(() => {
    if (allSkills.length === 0) fetchSkills()
    if (allMcpServers.length === 0) fetchMcps()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Popover 打开时自动聚焦搜索框；关闭时清空筛选词
  useEffect(() => {
    if (skillPopoverOpen) {
      // 等 DOM 渲染后聚焦
      setTimeout(() => skillFilterRef.current?.focus(), 50)
    } else {
      setSkillFilter('')
    }
  }, [skillPopoverOpen])

  // ---- 计算合并后的 Skill 列表 ----
  const skillList = useMemo((): SkillItem[] => {
    // 1. SpectrAI DB Skill：isEnabled + 有 slashCommand + 兼容当前 Provider
    const dbItems: SkillItem[] = allSkills
      .filter(s => {
        if (!s.isEnabled || !s.slashCommand) return false
        if (s.compatibleProviders === 'all') return true
        if (!providerId) return true
        return Array.isArray(s.compatibleProviders) && s.compatibleProviders.includes(providerId)
      })
      .map(s => ({
        slashCommand: s.slashCommand!,
        name: s.name,
        description: s.description || '',
        source: (s.source === 'custom' ? 'custom' : 'builtin') as SkillItem['source'],
        type: (s.type || 'prompt') as SkillItem['type'],
        promptTemplate: s.promptTemplate,
      }))

    // 2. Provider 原生命令：解析 sessionInitData.skills
    const nativeItems: SkillItem[] = []
    if (initData?.skills && initData.skills.length > 0) {
      for (const s of initData.skills as any[]) {
        const cmd = typeof s === 'string'
          ? (s.startsWith('/') ? s.slice(1) : s)
          : (s.name || s.command || s.slug || '')
        const desc = typeof s === 'object'
          ? (s.description || s.hint || s.summary || s.help || '')
          : ''
        if (cmd) {
          nativeItems.push({ slashCommand: cmd, name: cmd, description: desc, source: 'native', type: 'native' })
        }
      }
    }

    // 3. 去重：DB 中已有同名 slashCommand 的原生命令不再重复
    const dbCommandSet = new Set(dbItems.map(i => i.slashCommand))
    const uniqueNative = nativeItems.filter(n => !dbCommandSet.has(n.slashCommand))

    // 4. SpectrAI 系统 Skill：custom（自定义 + MCP 安装）在前，builtin（内置）在后
    const systemItems = [
      ...dbItems.filter(i => i.source === 'custom'),
      ...dbItems.filter(i => i.source === 'builtin'),
    ]

    // 5. CLI 原生命令排最后
    return [...systemItems, ...uniqueNative]
  }, [initData?.skills, allSkills, providerId])

  /** 搜索过滤后的列表（忽略大小写，匹配命令名 or 描述） */
  const filteredSkillList = useMemo(() => {
    const q = skillFilter.trim().toLowerCase()
    if (!q) return skillList
    return skillList.filter(s =>
      s.slashCommand.toLowerCase().includes(q) ||
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q)
    )
  }, [skillList, skillFilter])

  // ---- 计算 MCP 列表 ----
  const mcpList = useMemo(() => {
    // 从 initData.tools 中解析 MCP 工具（格式：mcp__serverKey__toolName）
    const toolsByServer: Record<string, string[]> = {}
    if (initData?.tools && Array.isArray(initData.tools)) {
      for (const tool of initData.tools as string[]) {
        if (tool.startsWith('mcp__')) {
          // mcp__serverKey__toolName，serverKey 本身可能含双下划线，取第一段
          const withoutPrefix = tool.slice('mcp__'.length)
          const secondSep = withoutPrefix.indexOf('__')
          if (secondSep > 0) {
            const serverKey = withoutPrefix.slice(0, secondSep)
            const toolName = withoutPrefix.slice(secondSep + 2)
            if (!toolsByServer[serverKey]) toolsByServer[serverKey] = []
            toolsByServer[serverKey].push(toolName)
          }
        }
      }
    }

    if (initData?.mcpServers && initData.mcpServers.length > 0) {
      return initData.mcpServers.map((m: any) => {
        // initData.mcpServers 中存放的是 Claude Code 上报的配置键名（即 McpServer.id）
        // 需要同时匹配 s.id（用户自建 MCP）和 s.name（内置 MCP 键名与名称相同的情况）
        const key = typeof m === 'string' ? m : (m.name || m.id || String(m))
        const full = allMcpServers.find(s => s.id === key || s.name === key)
        // 优先展示用户填写的中文显示名，若未找到则回退到 key
        const tools = toolsByServer[key] || []
        return { name: full?.name ?? key, category: full?.category, description: full?.description, key, tools }
      }).filter(m => m.name)
    }
    return allMcpServers
      .filter(s => s.isGlobalEnabled)
      .map(s => {
        const tools = toolsByServer[s.id] || toolsByServer[s.name] || []
        return { name: s.name, category: s.category, description: s.description, key: s.id, tools }
      })
  }, [initData?.mcpServers, initData?.tools, allMcpServers])

  // ---- MCP 工具展开状态 ----
  const [expandedMcps, setExpandedMcps] = useState<Set<string>>(new Set())
  const toggleMcpExpand = useCallback((key: string) => {
    setExpandedMcps(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // ---- Popover 关闭逻辑 ----
  usePopoverClose(skillPopoverOpen, setSkillPopoverOpen, skillBtnRef, skillPopoverRef)
  usePopoverClose(mcpPopoverOpen, setMcpPopoverOpen, mcpBtnRef, mcpPopoverRef)

  // 点击 Skill 列表项：根据类型路由
  // - native：插入 /command 到输入框，由 CLI 原生处理
  // - prompt/orchestration：触发静默执行（展开模板后发送，用户不见模板原文）
  const handleSkillSelect = useCallback((skill: SkillItem) => {
    setSkillPopoverOpen(false)
    if (skill.type === 'native') {
      onSkillClick(`/${skill.slashCommand} `)
    } else {
      onSkillExecute(skill)
    }
  }, [onSkillClick, onSkillExecute])

  // 无内容时不渲染，保持原有布局不变
  if (skillList.length === 0 && mcpList.length === 0) return null

  return (
    <div className="px-4 pt-1.5 pb-0 flex items-center gap-1.5 bg-bg-primary">

      {/* ---- Skill 按钮 ---- */}
      {skillList.length > 0 && (
        <div className="relative flex-shrink-0">
          <button
            ref={skillBtnRef}
            onClick={() => setSkillPopoverOpen(o => !o)}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs
              bg-bg-secondary border text-text-muted
              hover:text-text-secondary hover:bg-bg-hover
              transition-colors cursor-pointer select-none
              ${skillPopoverOpen ? 'border-accent-blue/40 text-text-secondary' : 'border-border'}`}
          >
            <span>⚡</span>
            <span>{skillList.length} 个 Skill</span>
          </button>

          {/* Skill Popover */}
          {skillPopoverOpen && (
            <div
              ref={skillPopoverRef}
              className="absolute bottom-full left-0 mb-1.5
                w-80 bg-bg-secondary border border-border rounded-lg shadow-lg
                py-1.5 z-50"
            >
              {/* 标题行 */}
              <div className="px-3 pb-1.5 flex items-center justify-between border-b border-border">
                <span className="text-[11px] text-text-muted font-medium uppercase tracking-wide">
                  可用 Skill
                </span>
                <span className="text-[10px] text-text-muted">
                  SpectrAI 优先
                </span>
              </div>

              {/* 搜索框 */}
              <div className="px-2 pt-1.5 pb-1">
                <input
                  ref={skillFilterRef}
                  type="text"
                  value={skillFilter}
                  onChange={e => setSkillFilter(e.target.value)}
                  placeholder="搜索 Skill..."
                  className="w-full px-2.5 py-1 text-xs rounded-md
                    bg-bg-primary border border-border
                    text-text-primary placeholder:text-text-muted
                    focus:outline-none focus:border-accent-blue/50
                    transition-colors"
                  // 阻止 Enter/Esc 冒泡到 Popover 关闭逻辑
                  onKeyDown={e => {
                    if (e.key === 'Escape') {
                      if (skillFilter) {
                        e.stopPropagation()
                        setSkillFilter('')
                      }
                      // 若搜索框已空，让 Esc 正常冒泡关闭 Popover
                    }
                  }}
                />
              </div>

              {/* Skill 列表（带分组 header） */}
              <div className="max-h-60 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                {filteredSkillList.length === 0 ? (
                  <div className="px-3 py-4 text-xs text-text-muted text-center">
                    未找到「{skillFilter}」相关 Skill
                  </div>
                ) : (() => {
                  // 按 source 分组渲染，保持已排好序的顺序，遇到新 source 插入分组 header
                  const elements: React.ReactNode[] = []
                  let lastSource: SkillItem['source'] | null = null
                  const GROUP_LABEL: Record<SkillItem['source'], string> = {
                    custom:  'SpectrAI 技能',
                    builtin: '内置技能',
                    native:  'CLI 原生命令',
                  }
                  for (const skill of filteredSkillList) {
                    if (skill.source !== lastSource) {
                      // 分组 header（除第一组外加上间距）
                      elements.push(
                        <div
                          key={`group-${skill.source}`}
                          className={`px-3 py-1 flex items-center gap-1.5
                            ${lastSource !== null ? 'mt-0.5 border-t border-border/40' : ''}`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${SOURCE_DOT[skill.source]}`} />
                          <span className="text-[10px] font-medium text-text-muted uppercase tracking-wide">
                            {GROUP_LABEL[skill.source]}
                          </span>
                        </div>
                      )
                      lastSource = skill.source
                    }
                    elements.push(
                      <button
                        key={skill.slashCommand}
                        onClick={() => handleSkillSelect(skill)}
                        className="w-full px-3 py-1.5 flex items-start gap-2 text-left
                          hover:bg-bg-hover transition-colors"
                      >
                        {/* 两行布局：命令名 + 描述 */}
                        <span className="flex flex-col gap-0.5 min-w-0 pl-3">
                          <span className="font-mono text-xs text-accent-blue leading-none">
                            /{skill.slashCommand}
                          </span>
                          {skill.description && (
                            <span className="text-[11px] text-text-muted leading-snug break-words whitespace-normal">
                              {skill.description}
                            </span>
                          )}
                        </span>
                      </button>
                    )
                  }
                  return elements
                })()}
              </div>

              {/* 底部统计 */}
              <div className="px-3 pt-1 mt-0.5 border-t border-border/60">
                <span className="text-[10px] text-text-muted">
                  {skillFilter
                    ? `${filteredSkillList.length} / ${skillList.length} 个结果`
                    : `共 ${skillList.length} 个 Skill`}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ---- MCP 状态按钮 ---- */}
      {mcpList.length > 0 && (
        <div className="relative flex-shrink-0">
          <button
            ref={mcpBtnRef}
            onClick={() => setMcpPopoverOpen(o => !o)}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs
              bg-bg-secondary border text-text-muted
              hover:text-text-secondary hover:bg-bg-hover
              transition-colors cursor-pointer select-none
              ${mcpPopoverOpen ? 'border-accent-blue/40 text-text-secondary' : 'border-border'}`}
          >
            <span>🔌</span>
            <span>{mcpList.length} 个 MCP</span>
          </button>

          {/* 只读 Popover */}
          {mcpPopoverOpen && (
            <div
              ref={mcpPopoverRef}
              className="absolute bottom-full left-0 mb-1.5
                w-64 bg-bg-secondary border border-border rounded-lg shadow-lg
                py-1.5 z-50"
            >
              <div className="px-3 pb-1.5 text-[11px] text-text-muted font-medium uppercase tracking-wide border-b border-border mb-1">
                当前会话已启用 MCP
              </div>
              <div className="max-h-72 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                {mcpList.map(mcp => {
                  const isExpanded = expandedMcps.has(mcp.key)
                  const hasTools = mcp.tools && mcp.tools.length > 0
                  return (
                    <div key={mcp.key}>
                      {/* MCP 服务器行 */}
                      <div
                        className={`px-3 py-1.5 flex items-center gap-2 ${hasTools ? 'cursor-pointer hover:bg-bg-hover' : ''} transition-colors`}
                        onClick={() => hasTools && toggleMcpExpand(mcp.key)}
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-accent-green flex-shrink-0" />
                        <span className="flex-1 text-xs text-text-secondary truncate">{mcp.name}</span>
                        {mcp.category && (
                          <span className="text-[10px] text-text-muted flex-shrink-0 bg-bg-primary px-1 py-0.5 rounded">
                            {mcp.category}
                          </span>
                        )}
                        {hasTools && (
                          <span className="text-[10px] text-text-muted flex-shrink-0 ml-0.5">
                            {isExpanded ? '▲' : '▼'}
                          </span>
                        )}
                      </div>
                      {/* 工具列表（展开时显示） */}
                      {isExpanded && hasTools && (
                        <div className="pb-1 bg-bg-primary/40">
                          <div className="px-4 py-0.5 text-[10px] text-text-muted">
                            {mcp.tools.length} 个工具
                          </div>
                          {mcp.tools.map((tool: string) => (
                            <div key={tool} className="px-5 py-0.5 flex items-center gap-1.5">
                              <span className="text-text-muted text-[10px]">›</span>
                              <span className="text-[11px] text-text-secondary font-mono truncate">{tool}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              <div className="px-3 pt-1.5 mt-0.5 border-t border-border">
                <p className="text-[10px] text-text-muted">在设置中管理 MCP 服务器</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

SessionToolbar.displayName = 'SessionToolbar'
export default SessionToolbar
