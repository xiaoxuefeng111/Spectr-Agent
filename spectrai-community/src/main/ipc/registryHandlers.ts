/**
 * Registry（在线市场）IPC 处理器
 * 支持在线获取 MCP/Skill 列表、从 URL 导入 Skill
 *
 * 注意：缓存使用 app_settings 表存储，通过 database.getAppSettings() 统一读取（已自动 JSON.parse），
 * 通过 database.updateAppSetting(key, value) 存储（内部自动 JSON.stringify，勿重复序列化）。
 */
import { ipcMain } from 'electron'
import { IPC } from '../../shared/constants'
import type { IpcDependencies } from './index'

const DEFAULT_REGISTRY_URL = 'https://raw.githubusercontent.com/spectrai/registry/main/registry.json'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24 小时

// ── 内置默认技能列表（离线 fallback / 首次使用时展示）──
const BUILTIN_MARKET_SKILLS = [
  {
    id: 'skill-code-review',
    name: '代码审查',
    description: '对代码进行全面审查，包括逻辑、性能、安全性和可维护性',
    category: 'development',
    slashCommand: 'code-review',
    type: 'prompt',
    compatibleProviders: 'all',
    author: 'SpectrAI',
    version: '1.0.0',
    tags: ['code', 'review', 'quality'],
    promptTemplate: '请对以下代码进行全面审查：\n\n```\n{{user_input}}\n```\n\n请从以下维度分析：\n1. **逻辑正确性** — 是否有 bug、边界条件处理\n2. **性能** — 时间/空间复杂度，是否有不必要的计算\n3. **安全性** — SQL 注入、XSS、敏感信息泄露等\n4. **可维护性** — 命名、注释、结构清晰度\n5. **最佳实践** — 是否符合语言/框架惯例\n\n对每个问题给出具体的改进建议。',
  },
  {
    id: 'skill-git-commit',
    name: '生成提交信息',
    description: '根据代码变更自动生成规范的 Git commit message',
    category: 'development',
    slashCommand: 'git-commit',
    type: 'prompt',
    compatibleProviders: 'all',
    author: 'SpectrAI',
    version: '1.0.0',
    tags: ['git', 'commit', 'workflow'],
    promptTemplate: '请根据以下 git diff 生成规范的提交信息：\n\n```diff\n{{user_input}}\n```\n\n要求：\n- 遵循 Conventional Commits 规范（feat/fix/refactor/docs/test/chore）\n- 主题行不超过 72 个字符\n- 如有必要，添加正文说明改动原因\n- 使用中文',
  },
  {
    id: 'skill-explain-code',
    name: '解释代码',
    description: '用通俗易懂的语言解释代码的功能和实现原理',
    category: 'development',
    slashCommand: 'explain',
    type: 'prompt',
    compatibleProviders: 'all',
    author: 'SpectrAI',
    version: '1.0.0',
    tags: ['code', 'explain', 'learning'],
    promptTemplate: '请解释以下代码：\n\n```\n{{user_input}}\n```\n\n解释要求：\n1. **整体功能** — 这段代码做什么\n2. **逐行/逐块解析** — 关键部分的具体含义\n3. **使用的技术/模式** — 涉及的设计模式、算法或框架特性\n4. **注意事项** — 使用时需要注意什么',
  },
  {
    id: 'skill-write-tests',
    name: '编写测试用例',
    description: '为代码自动生成单元测试和集成测试用例',
    category: 'development',
    slashCommand: 'write-tests',
    type: 'prompt',
    compatibleProviders: 'all',
    author: 'SpectrAI',
    version: '1.0.0',
    tags: ['test', 'tdd', 'quality'],
    promptTemplate: '请为以下代码编写测试用例：\n\n```\n{{user_input}}\n```\n\n请生成：\n1. **单元测试** — 覆盖核心功能和边界条件\n2. **异常测试** — 错误输入和异常情况处理\n3. **集成测试（如适用）** — 与依赖组件的交互\n\n测试框架：根据代码语言自动选择（Jest/pytest/JUnit 等）\n确保测试覆盖率达到 80% 以上，并包含测试说明注释。',
  },
  {
    id: 'skill-translate-to-en',
    name: '中译英（技术文档）',
    description: '将中文技术文档或代码注释翻译为专业英文',
    category: 'language',
    slashCommand: 'trans-en',
    type: 'prompt',
    compatibleProviders: 'all',
    author: 'SpectrAI',
    version: '1.0.0',
    tags: ['translation', 'english', 'docs'],
    promptTemplate: '请将以下中文内容翻译为专业英文：\n\n{{user_input}}\n\n翻译要求：\n- 保持技术术语的准确性\n- 语言自然流畅，符合英文技术文档规范\n- 保留原有的代码块、格式标记（Markdown）\n- 如有歧义，在括号内注明原文',
  },
  {
    id: 'skill-refactor',
    name: '重构建议',
    description: '分析代码并提供具体的重构方案，提升代码质量',
    category: 'development',
    slashCommand: 'refactor',
    type: 'prompt',
    compatibleProviders: 'all',
    author: 'SpectrAI',
    version: '1.0.0',
    tags: ['refactor', 'code', 'clean'],
    promptTemplate: '请分析以下代码并提供重构建议：\n\n```\n{{user_input}}\n```\n\n重构目标：\n1. **消除重复代码**（DRY 原则）\n2. **简化复杂逻辑**\n3. **改善命名和可读性**\n4. **提取可复用的函数/组件**\n5. **应用合适的设计模式**\n\n请提供重构后的代码示例，并说明每处改动的原因。',
  },
  {
    id: 'skill-sql-optimize',
    name: 'SQL 优化',
    description: '分析 SQL 查询并提供性能优化建议',
    category: 'database',
    slashCommand: 'sql-opt',
    type: 'prompt',
    compatibleProviders: 'all',
    author: 'SpectrAI',
    version: '1.0.0',
    tags: ['sql', 'database', 'performance'],
    promptTemplate: '请优化以下 SQL 查询：\n\n```sql\n{{user_input}}\n```\n\n请分析：\n1. **执行计划** — 预估的查询复杂度\n2. **索引建议** — 需要创建或修改哪些索引\n3. **查询重写** — 是否有更高效的写法\n4. **潜在问题** — N+1 查询、全表扫描等\n\n提供优化后的 SQL 和预期的性能提升说明。',
  },
  {
    id: 'skill-api-design',
    name: 'API 设计审查',
    description: '审查 API 设计，检查 RESTful 规范、安全性和易用性',
    category: 'development',
    slashCommand: 'api-review',
    type: 'prompt',
    compatibleProviders: 'all',
    author: 'SpectrAI',
    version: '1.0.0',
    tags: ['api', 'rest', 'design'],
    promptTemplate: '请审查以下 API 设计：\n\n```\n{{user_input}}\n```\n\n审查维度：\n1. **RESTful 规范** — URL 命名、HTTP 方法使用是否正确\n2. **安全性** — 认证、授权、输入验证\n3. **错误处理** — 错误码是否合理、错误信息是否清晰\n4. **版本控制** — 是否有版本策略\n5. **文档完整性** — 参数、返回值是否清晰\n\n提供具体改进建议。',
  },
  {
    id: 'skill-doc-gen',
    name: '生成文档注释',
    description: '为函数、类或模块自动生成规范的文档注释（JSDoc/docstring）',
    category: 'development',
    slashCommand: 'doc-gen',
    type: 'prompt',
    compatibleProviders: 'all',
    author: 'SpectrAI',
    version: '1.0.0',
    tags: ['docs', 'comments', 'jsdoc'],
    promptTemplate: '请为以下代码生成完整的文档注释：\n\n```\n{{user_input}}\n```\n\n注释要求：\n- 根据语言自动选择注释格式（JSDoc/TypeDoc/Python docstring/JavaDoc）\n- 描述功能、参数类型和含义、返回值、可能的异常\n- 添加使用示例（如有必要）\n- 保持简洁，避免废话\n\n直接输出带注释的完整代码。',
  },
  {
    id: 'skill-security-audit',
    name: '安全审计',
    description: '对代码进行安全漏洞扫描，识别 OWASP Top 10 等常见安全问题',
    category: 'security',
    slashCommand: 'security',
    type: 'prompt',
    compatibleProviders: 'all',
    author: 'SpectrAI',
    version: '1.0.0',
    tags: ['security', 'audit', 'owasp'],
    promptTemplate: '请对以下代码进行安全审计：\n\n```\n{{user_input}}\n```\n\n重点检查 OWASP Top 10：\n1. **注入攻击**（SQL/命令注入、XSS）\n2. **身份验证缺陷**（弱密码、会话管理）\n3. **敏感数据泄露**（硬编码密钥、日志泄露）\n4. **权限控制缺陷**\n5. **不安全的依赖**\n6. **其他安全问题**\n\n对每个发现的问题：标注严重程度（高/中/低）、描述风险、提供修复方案。',
  },
]

export function registerRegistryHandlers(deps: IpcDependencies): void {
  const { database } = deps

  // ── 获取在线 MCP 列表（带 24h 缓存）──
  ipcMain.handle(IPC.REGISTRY_FETCH_MCPS, async () => {
    try {
      const settings = database.getAppSettings()
      const cacheTime = Number(settings['registry_cache_time'] || 0)
      if (Date.now() - cacheTime < CACHE_TTL_MS) {
        const cached = settings['registry_cache_mcps']
        if (cached) return cached
      }
      const registryUrl = String(settings['registry_url'] || DEFAULT_REGISTRY_URL)
      const res = await fetch(registryUrl, { signal: AbortSignal.timeout(10000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { mcps?: any[]; skills?: any[] }
      const mcps = data.mcps || []
      // updateAppSetting 内部会 JSON.stringify，直接传原始值
      database.updateAppSetting('registry_cache_mcps', mcps)
      database.updateAppSetting('registry_cache_time', Date.now())
      return mcps
    } catch (err: any) {
      console.error('[Registry] fetch MCPs failed:', err.message)
      // 降级返回缓存（即使过期也比报错好）
      const stale = database.getAppSettings()['registry_cache_mcps']
      return stale || []
    }
  })

  // ── 获取在线 Skill 列表（带 24h 缓存，在线为空时 fallback 到内置列表）──
  ipcMain.handle(IPC.REGISTRY_FETCH_SKILLS, async (_event, forceRefresh = false) => {
    try {
      const settings = database.getAppSettings()
      // 非强制刷新时检查缓存
      if (!forceRefresh) {
        const cacheTime = Number(settings['registry_cache_time'] || 0)
        if (Date.now() - cacheTime < CACHE_TTL_MS) {
          const cached = settings['registry_cache_skills']
          if (cached && Array.isArray(cached) && cached.length > 0) return cached
        }
      }
      const registryUrl = String(settings['registry_url'] || DEFAULT_REGISTRY_URL)
      const res = await fetch(registryUrl, { signal: AbortSignal.timeout(10000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { mcps?: any[]; skills?: any[] }
      const skills = data.skills || []
      // 在线 registry 为空时，使用内置默认列表（但不缓存，下次仍会尝试在线）
      if (skills.length === 0) {
        console.log('[Registry] online skills empty, using builtin defaults')
        return BUILTIN_MARKET_SKILLS
      }
      database.updateAppSetting('registry_cache_skills', skills)
      database.updateAppSetting('registry_cache_time', Date.now())
      return skills
    } catch (err: any) {
      console.error('[Registry] fetch Skills failed:', err.message)
      // 降级：先尝试缓存，再用内置列表
      const stale = database.getAppSettings()['registry_cache_skills']
      if (stale && Array.isArray(stale) && stale.length > 0) return stale
      console.log('[Registry] using builtin skill list as fallback')
      return BUILTIN_MARKET_SKILLS
    }
  })

  // ── 强制刷新 Registry 缓存 ──
  ipcMain.handle(IPC.REGISTRY_FORCE_REFRESH, async () => {
    try {
      const settings = database.getAppSettings()
      const registryUrl = String(settings['registry_url'] || DEFAULT_REGISTRY_URL)
      const res = await fetch(registryUrl, { signal: AbortSignal.timeout(10000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { mcps?: any[]; skills?: any[] }
      const mcps = data.mcps || []
      const skills = data.skills || []
      database.updateAppSetting('registry_cache_mcps', mcps)
      database.updateAppSetting('registry_cache_skills', skills.length > 0 ? skills : BUILTIN_MARKET_SKILLS)
      database.updateAppSetting('registry_cache_time', Date.now())
      return { success: true, mcpsCount: mcps.length, skillsCount: skills.length }
    } catch (err: any) {
      console.error('[Registry] force refresh failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  // ── 从 URL 导入 Skill ──
  ipcMain.handle(IPC.SKILL_IMPORT_URL, async (_event, url: string) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as any
      if (!data.name || !data.type) {
        throw new Error('无效的 Skill 格式：缺少 name 或 type 字段')
      }
      const now = new Date().toISOString()
      const skill = {
        ...data,
        id: data.id || `imported-${Date.now()}`,
        source: 'marketplace',
        isEnabled: true,
        isInstalled: true,
        createdAt: data.createdAt || now,
        updatedAt: now,
      }
      database.createSkill(skill)
      return { success: true, skill }
    } catch (err: any) {
      console.error('[Registry] import skill from URL failed:', err.message)
      return { success: false, error: err.message }
    }
  })
}
