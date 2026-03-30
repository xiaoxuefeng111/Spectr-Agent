// ============================================================
// SpectrAI 核心类型定义
// @author weibin
// ============================================================

// ---- AI Provider ----

export interface AIProvider {
  id: string                // 'claude-code' | uuid
  name: string              // "Claude Code", "Codex CLI"
  command: string           // "claude", "cc", "codex"
  isBuiltin: boolean        // 内置不可删除
  icon?: string             // 'claude' | 'codex' | 'custom'
  defaultArgs?: string[]    // 每次启动时附加的参数
  autoAcceptArg?: string    // 跳过确认的参数，如 '--dangerously-skip-permissions'
  resumeArg?: string        // 恢复参数，如 '--resume'（Claude）或 'resume'（Codex 子命令），留空=不支持恢复
  resumeFormat?: 'flag' | 'subcommand'  // 'flag': cmd [args] --resume <id>（默认）; 'subcommand': cmd resume <id>
  promptPassMode?: 'positional' | 'stdin' | 'flag' | 'none'  // prompt 传递方式
  promptArg?: string              // 'flag' 模式时使用的参数名（如 '-p', '--prompt'），Agent spawn 会用此传 prompt
  /**
   * 非交互 print 模式参数。设置后 oneShot Agent 用此模式运行，进程完成后自动退出，无需 heuristic 检测。
   * prompt 作为 positional arg 追加在 printModeArgs 之后，autoAcceptArg 追加在最末尾。
   * 最终命令格式：command [printModeArgs...] "prompt" [autoAcceptArg]
   * 示例：
   * - Claude Code: ['-p']              → claude -p "prompt" --dangerously-skip-permissions
   * - Codex CLI:   ['exec']            → codex exec "prompt" --full-auto
   * - Gemini CLI:  ['-p']              → gemini -p "prompt" --yolo
   */
  printModeArgs?: string[]
  sessionIdDetection?: 'claude-jsonl' | 'output-regex' | 'none'  // 会话 ID 检测方式
  sessionIdPattern?: string   // output-regex 模式下的正则表达式，第一个捕获组=sessionId
  nodeVersion?: string              // 指定 Node.js 版本号（如 '24.11.0'），spawn 时自动切换 PATH
  envOverrides?: Record<string, string>  // 自定义环境变量覆盖
  /** Prompt marker 正则模式（字符串形式），用于 Agent 就绪检测。留空使用通用默认 */
  promptMarkerPatterns?: string[]
  /** 确认提示模式配置（留空使用通用默认） */
  confirmationConfig?: ProviderConfirmationConfig
  /** 状态推断参数配置（留空使用全局默认） */
  stateConfig?: ProviderStateConfig
  /** 默认模型名称（留空则使用适配器内置默认值）。例如 'claude-opus-4-5-20251101'、'claude-sonnet-4-6' */
  defaultModel?: string
  /** SDK V2: Adapter 类型（用于 SDK 架构路由） */
  adapterType?: AdapterType
  /**
   * 自定义可执行文件路径（仅 claude-sdk 适配器使用）。
   * 留空时自动检测（通过 where/which claude 或常见安装路径探测）。
   * 适用于 claude CLI 未在系统 PATH 中但已安装于自定义路径的场景。
   * 示例（Windows）：C:\Users\xxx\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js
   */
  executablePath?: string
  /**
   * git-bash 可执行文件路径（仅 claude-sdk 适配器 / Windows 使用）。
   * Claude Code 在 Windows 上必须依赖 git-bash，留空时自动探测常见安装路径。
   * 若自动探测失败（Git 安装在非标准路径），在此手动指定 bash.exe 路径。
   * 示例：C:\Program Files\Git\bin\bash.exe
   */
  gitBashPath?: string
  createdAt?: string
  updatedAt?: string
}

/** 内置 Claude Code Provider 预设 */
export const BUILTIN_CLAUDE_PROVIDER: AIProvider = {
  id: 'claude-code',
  name: 'Claude Code',
  command: 'claude',
  isBuiltin: true,
  icon: 'claude',
  adapterType: 'claude-sdk',
  defaultArgs: [],
  autoAcceptArg: '--dangerously-skip-permissions',
  resumeArg: '--resume',
  promptPassMode: 'positional',
  printModeArgs: ['-p'],
  sessionIdDetection: 'claude-jsonl',
  promptMarkerPatterns: ['❯'],
  confirmationConfig: {
    highPatterns: [
      'Allow\\s+\\w+\\s*\\?.*\\(y\\)',
      '\\(Y\\/n\\)',
      '\\(y\\/N\\)',
    ],
    mediumPatterns: [
      'Shall I (?:continue|proceed)',
      'Would you like me to',
      'Do you want to proceed',
      'Continue\\?',
    ],
  },
  stateConfig: {
    startupPattern: 'Claude\\s*Code\\s+v\\d',
    idleTimeoutMs: 5000,
    possibleStuckMs: 60000,
    stuckInterventionMs: 300000,
    startupStuckMs: 30000,
  },
}

/** 内置 Codex CLI Provider 预设 */
export const BUILTIN_CODEX_PROVIDER: AIProvider = {
  id: 'codex',
  name: 'Codex CLI',
  command: 'codex',
  isBuiltin: true,
  icon: 'codex',
  adapterType: 'codex-appserver',
  defaultArgs: [],
  autoAcceptArg: '--full-auto',
  resumeArg: 'resume',
  resumeFormat: 'subcommand',
  promptPassMode: 'positional',
  printModeArgs: ['exec'],
  sessionIdDetection: 'none',
  promptMarkerPatterns: ['›', '>\\s'],
  confirmationConfig: {
    highPatterns: [
      'approve|reject',
      'permission.*(?:allow|deny)',
    ],
    mediumPatterns: [
      'Do you want to (?:run|execute|apply)',
    ],
  },
  stateConfig: {
    startupPattern: 'codex',
    idleTimeoutMs: 8000,
    possibleStuckMs: 90000,
    stuckInterventionMs: 360000,
    startupStuckMs: 45000,
  },
}

/** 内置 Gemini CLI Provider 预设 */
export const BUILTIN_GEMINI_PROVIDER: AIProvider = {
  id: 'gemini-cli',
  name: 'Gemini CLI',
  command: 'gemini',
  isBuiltin: true,
  icon: 'gemini',
  adapterType: 'gemini-headless',
  nodeVersion: '24.11.0',
  defaultArgs: [],
  autoAcceptArg: '--yolo',
  promptPassMode: 'positional',
  printModeArgs: ['-p'],
  sessionIdDetection: 'none',
  promptMarkerPatterns: ['❯', '>\\s', '\\$\\s'],
  confirmationConfig: {
    highPatterns: [
      'Approve\\?\\s*\\(Y\\/n\\)',
      'Approve\\?\\s*\\(y\\/n\\/always\\)',
    ],
    mediumPatterns: [
      'Do you want to (?:continue|proceed|run)',
    ],
  },
  stateConfig: {
    startupPattern: 'Gemini CLI|Hello!.*Gemini',
    idleTimeoutMs: 6000,
    possibleStuckMs: 90000,
    stuckInterventionMs: 360000,
    startupStuckMs: 180000,
  },
}

/** 内置 OpenCode Provider 预设（HTTP-first AI 编码助手，使用 @opencode-ai/sdk 通信） */
export const BUILTIN_OPENCODE_PROVIDER: AIProvider = {
  id: 'opencode',
  name: 'OpenCode',
  command: 'opencode',
  isBuiltin: true,
  icon: 'opencode',
  adapterType: 'opencode-sdk',
  autoAcceptArg: undefined,
  resumeArg: undefined,
  promptPassMode: 'none',
  printModeArgs: [],
  sessionIdDetection: 'none',
  promptMarkerPatterns: [],
  confirmationConfig: undefined,
  stateConfig: {
    startupPattern: 'listening|ready|started',
    idleTimeoutMs: 5000,
    possibleStuckMs: 60000,
    stuckInterventionMs: 300000,
    startupStuckMs: 30000,
  },
}

/** 内置 iFlow CLI Provider 预设（ACP over JSON-RPC 2.0 on stdio） */
export const BUILTIN_IFLOW_PROVIDER: AIProvider = {
  id: 'iflow',
  name: 'iFlow CLI',
  command: 'iflow',
  isBuiltin: true,
  icon: 'iflow',
  adapterType: 'iflow-acp',
  defaultArgs: [],
  autoAcceptArg: '--yolo',
  promptPassMode: 'none',
  printModeArgs: [],
  sessionIdDetection: 'none',
}

/** 所有内置 Provider 列表 */
export const BUILTIN_PROVIDERS: AIProvider[] = [
  BUILTIN_CLAUDE_PROVIDER,
  BUILTIN_CODEX_PROVIDER,
  BUILTIN_GEMINI_PROVIDER,
  BUILTIN_IFLOW_PROVIDER,
  BUILTIN_OPENCODE_PROVIDER,
]

// ---- 会话相关 ----

export type ShellType = 'powershell' | 'pwsh' | 'cmd'

export interface SessionConfig {
  id: string
  name: string
  workingDirectory: string
  claudeArgs?: string[]
  autoAccept?: boolean
  env?: Record<string, string>
  taskId?: string
  initialPrompt?: string   // 创建会话后自动发送的初始 prompt
  initialPromptVisibility?: 'visible' | 'hidden' // 初始 prompt 是否显示为用户消息
  shell?: ShellType         // 终端类型，默认 powershell
  providerId?: string       // 使用的 Provider ID，默认 'claude-code'
  enableAgent?: boolean     // 启用 Agent 编排（允许 Claude 创建子会话）
  supervisorMode?: boolean  // Supervisor 模式（自动启用 Agent + 注入引导 Prompt）
  parentSessionId?: string  // 父会话 ID（Agent 子会话）
  agentId?: string          // Agent ID（Agent 子会话）
  mcpConfigPath?: string    // MCP 配置文件路径（内部使用）
  promptFile?: string       // prompt 临时文件路径（Agent 子会话，避免命令行长度限制）
  adapterType?: AdapterType  // SDK V2 适配器类型
  /** 平台自动创建的 worktree 实际路径（workingDirectory 可能已指向此处） */
  worktreePath?: string
  /** worktree 所在分支名 */
  worktreeBranch?: string
  /** worktree 来源仓库根路径（用于清理时定位） */
  worktreeSourceRepo?: string
  /** 关联的工作区 ID（新建会话时选择工作区模式时传入） */
  workspaceId?: string
  /** 工作区内除主仓库外的其他仓库路径（传递给 SDK additionalDirectories，让 AI 可访问多个目录） */
  additionalDirectories?: string[]
  /** 追加到系统提示的内容（内部使用，用于注入 worktree 等规则，确保每次会话生效） */
  systemPromptAppend?: string
}

export type SessionStatus =
  | 'starting'
  | 'running'
  | 'idle'
  | 'waiting_input'
  | 'paused'
  | 'completed'
  | 'error'
  | 'terminated'
  | 'interrupted'

export interface Session {
  id: string
  name: string
  config: SessionConfig
  status: SessionStatus
  startedAt: string
  endedAt?: string
  exitCode?: number
  estimatedTokens: number
  claudeSessionId?: string
  providerId?: string       // 冗余存储，列表展示用
}

export interface SessionStats {
  totalRunningTime: number
  totalOutputLines: number
  filesRead: string[]
  filesWritten: string[]
  commandsExecuted: string[]
  estimatedTokens: number
  interventionCount: number
}

// ---- 活动事件 ----

export type ActivityEventType =
  | 'session_start'
  | 'thinking'
  | 'file_read'
  | 'file_write'
  | 'file_edit'
  | 'file_create'
  | 'file_delete'
  | 'command_execute'
  | 'command_output'
  | 'search'
  | 'tool_use'
  | 'error'
  | 'waiting_confirmation'
  | 'waiting_ask_question'   // AskUserQuestion 工具调用，等待用户回答多个问题
  | 'waiting_plan_approval'  // ExitPlanMode 工具调用，等待用户审批/拒绝计划
  | 'user_input'
  | 'user_question'         // AI 主动向用户提问（含选项时显示按钮，否则显示输入框）
  | 'turn_complete'         // 当前轮次结束（不代表整个任务完成）
  | 'task_complete'
  | 'context_summary'
  | 'assistant_message'
  | 'session_end'
  | 'idle'
  | 'unknown_activity'

/** AI 提问元数据（user_question 活动的 metadata 字段） */
export interface UserQuestionMeta {
  /** 问题文本 */
  question: string
  /** 可选项列表（有值则渲染为按钮，null 则只显示输入框） */
  options: string[] | null
}

/** AskUserQuestion 工具的问题列表元数据 */
export interface AskUserQuestionMeta {
  questions: Array<{
    question: string
    header?: string
    options?: Array<{
      label: string
      description?: string
      markdown?: string
    }>
    multiSelect?: boolean
  }>
}

/** ExitPlanMode 工具的计划内容元数据 */
export interface PlanApprovalMeta {
  /** 计划的原始 toolInput，可能包含 allowedPrompts 数组或其他字段 */
  toolInput: Record<string, unknown>
}

export interface ActivityEvent {
  id: string
  sessionId: string
  timestamp: string
  type: ActivityEventType
  detail: string
  raw?: string
  metadata?: Record<string, unknown>
}

// ---- 任务（看板） ----

export type TaskStatus = 'todo' | 'in_progress' | 'waiting' | 'done'
export type TaskPriority = 'low' | 'medium' | 'high'

export interface TaskCard {
  id: string
  title: string
  description: string
  status: TaskStatus
  sessionId?: string
  priority: TaskPriority
  createdAt: string
  updatedAt: string
  completedAt?: string
  tags: string[]
  estimatedDuration?: number
  parentTaskId?: string
  /** Git Worktree 隔离 */
  worktreeEnabled?: boolean
  /** 源 git 仓库路径（单仓库模式，向后兼容） */
  gitRepoPath?: string
  /** 任务分支名（单仓库 & 工作区模式共用） */
  gitBranch?: string
  /** worktree 目录路径（单仓库，自动生成） */
  worktreePath?: string
  /** 绑定的工作区 ID（多仓库模式，优先于 gitRepoPath） */
  workspaceId?: string
  /** 多仓库 worktree 路径映射: repoId → worktreePath */
  worktreePaths?: Record<string, string>
}

// ---- Workspace 工作区 ----

export interface WorkspaceRepo {
  id: string
  workspaceId: string
  /** git 仓库绝对路径 */
  repoPath: string
  /** 显示名称 */
  name: string
  /** 是否为主仓库（AI 会话的实际 workDir） */
  isPrimary: boolean
  /** 排序顺序 */
  sortOrder: number
}

export interface Workspace {
  id: string
  name: string
  description?: string
  /** 父目录路径（可选，仅用于展示） */
  rootPath?: string
  repos: WorkspaceRepo[]
  createdAt: string
  updatedAt: string
}

// ---- 通知 ----

export type NotificationType =
  | 'confirmation_needed'
  | 'task_completed'
  | 'error_occurred'
  | 'session_stuck'
  | 'quota_warning'

export type InterventionType = 'confirmation' | 'error' | 'stuck'

export interface NotificationConfig {
  enabled: boolean
  types: Record<
    NotificationType,
    {
      enabled: boolean
      sound: boolean
      persistent: boolean
      autoFocusWindow: boolean
    }
  >
  doNotDisturb: {
    enabled: boolean
    startTime: string
    endTime: string
  }
}

// ---- 主题 ----

export interface ThemeTerminalColors {
  bg: string
  fg: string
  cursor: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface ThemeConfig {
  id: string
  name: string
  type: 'light' | 'dark'
  colors: {
    bg: { primary: string; secondary: string; tertiary: string; hover: string }
    text: { primary: string; secondary: string; muted: string }
    accent: { blue: string; green: string; yellow: string; red: string; purple: string }
    border: string
  }
  terminal: ThemeTerminalColors
}

// ---- UI ----

export type ViewMode = 'grid' | 'tabs' | 'dashboard' | 'kanban'

export type LayoutMode = 'single' | 'split-h' | 'split-v'
export type PaneContent = 'sessions' | 'files'

export interface TerminalHeaderInfo {
  taskName: string
  status: SessionStatus
  runningTime: string
  activityIndicator: boolean
}

// ---- 用量 ----

export interface UsageSummary {
  totalTokens: number
  totalMinutes: number
  todayTokens: number
  todayMinutes: number
  activeSessions: number
  sessionBreakdown: Record<string, number>
}

export interface UsageHistory {
  dailyStats: Array<{
    date: string
    tokens: number
    minutes: number
    sessions: number
  }>
  sessionStats: Array<{
    sessionId: string
    sessionName: string
    tokens: number
    minutes: number
  }>
}

// ---- 并发控制 ----

export interface ConcurrencyConfig {
  maxSessions: number
  maxActiveOutput: number
  resourceWarningThreshold: number
}

export interface ResourceStatus {
  memoryUsedMB: number
  systemFreeMemMB: number
  warning: boolean
}

// ---- 确认检测 ----

export interface ConfirmationDetection {
  confidence: 'high' | 'medium'
  promptText: string
  originalLine: string
}

// ---- 搜索 ----

export interface SearchResult {
  sessionId: string
  sessionName: string
  timestamp: string
  content: string
  highlight?: string
}

// ---- 看板列 ----

export interface KanbanColumn {
  id: TaskStatus
  title: string
  icon: string
}

// ---- 解析规则 ----

export interface ParserRule {
  type: ActivityEventType
  priority: number
  patterns: RegExp[]
  extractDetail: (line: string) => string
  /** 绑定的 Provider ID，留空表示通用规则（所有 Provider 生效） */
  providerId?: string
}

// ---- Provider 扩展配置（用于解析层 Provider 化） ----

/** Provider 确认提示模式 */
export interface ProviderConfirmationConfig {
  /** 高置信度正则（字符串形式，运行时编译） */
  highPatterns: string[]
  /** 中置信度正则 */
  mediumPatterns: string[]
}

/** Provider 状态推断参数 */
export interface ProviderStateConfig {
  /** 启动完成检测正则（字符串形式） */
  startupPattern?: string
  /** 空闲超时（毫秒），默认 5000 */
  idleTimeoutMs?: number
  /** 可能卡住超时（毫秒），默认 60000 */
  possibleStuckMs?: number
  /** 需要干预超时（毫秒），默认 300000 */
  stuckInterventionMs?: number
  /** 启动超时（毫秒），默认 30000 */
  startupStuckMs?: number
}

// ---- 会话性能指标 ----

export interface SessionMetrics {
  /** 会话 ID */
  sessionId: string
  /** 首次输出延迟 (ms) */
  timeToFirstOutput: number
  /** 平均响应时间 (ms) */
  avgResponseTime: number
  /** 总 token 消耗 */
  totalTokens: number
  /** 工具调用次数 */
  toolCallCount: number
  /** 错误次数 */
  errorCount: number
  /** 采集时间 */
  collectedAt: string
}

// ---- SDK V2：Adapter 类型 ----

export type AdapterType = 'claude-sdk' | 'codex-appserver' | 'gemini-headless' | 'iflow-acp' | 'opencode-sdk'

// ---- SDK V2：对话消息 ----

export interface ConversationAttachment {
  type: 'image'
  path: string
  name?: string
}

export interface ConversationMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result'
  content: string
  timestamp: string
  attachments?: ConversationAttachment[]
  /** 工具名（tool_use / tool_result） */
  toolName?: string
  /** 工具输入参数 JSON（tool_use） */
  toolInput?: Record<string, unknown>
  /** 工具执行结果（tool_result） */
  toolResult?: string
  /** 工具调用是否出错（tool_result） */
  isError?: boolean
  /** 思考内容 */
  thinkingText?: string
  /** Token 用量 */
  usage?: { inputTokens: number; outputTokens: number }
  /** 工具调用 ID（关联 tool_use 和 tool_result） */
  toolUseId?: string
  /** 是否为增量消息（text_delta，前端需要追加而非替换） */
  isDelta?: boolean
  /** 文件变更信息（由 SpectrAI MCP 文件操作工具生成） */
  fileChange?: FileChangeInfo
}

/** 文件变更信息，用于对话流中展示 AI 对文件的改动 */
export interface FileChangeInfo {
  /** 文件绝对路径 */
  filePath: string
  /** 改动类型 */
  changeType: 'edit' | 'create' | 'write' | 'delete'
  /** 本次操作的 unified diff */
  operationDiff: string
  /** 累积改动 diff（相对于基准分支，可选） */
  cumulativeDiff?: string
  /** 新增行数 */
  additions: number
  /** 删除行数 */
  deletions: number
}

// ─────────────────────────────────────────────────────────────
// Git 面板类型
// ─────────────────────────────────────────────────────────────

export interface GitRepoInfo {
  /** 仓库根目录（normalize 后的绝对路径） */
  repoRoot: string
  /** 主工作区当前分支名 */
  branch: string
  /** 主工作区是否有未提交改动 */
  isDirty: boolean
  /** 所有 worktree 列表（来自 git worktree list） */
  worktrees: Array<{
    path: string
    head: string
    branch: string
    isMain: boolean
  }>
  /** 正在使用该仓库（或其 worktree）的 sessions */
  sessions: Session[]
}

export interface GitFileStatus {
  path: string
  /** 状态码：M=修改 A=新增 D=删除 R=重命名 ?=未跟踪 */
  statusCode: string
  staged: boolean
}

export interface GitStatusResult {
  staged: Array<{ path: string; statusCode: string }>
  unstaged: Array<{ path: string; statusCode: string }>
  untracked: string[]
}

export interface GitCommit {
  hash: string
  shortHash: string
  message: string
  author: string
  relativeDate: string
}

export interface GitOperationResult {
  success: boolean
  output: string
  error?: string
}

// ---- 文件改动追踪 ----

export type FileChangeType = 'create' | 'modify' | 'delete'

export interface TrackedFileChange {
  filePath: string
  changeType: FileChangeType
  timestamp: number
  sessionId: string
  concurrent?: boolean  // 多会话同时改动同一文件时标记
}

// ─────────────────────────────────────────────────────────────
// MCP (Model Context Protocol) 服务器类型
// ─────────────────────────────────────────────────────────────

export type McpTransport = 'stdio' | 'http' | 'sse'
export type McpCategory = 'filesystem' | 'database' | 'web' | 'code' | 'productivity' | 'custom'
export type McpSource = 'builtin' | 'registry' | 'github' | 'local'
export type McpInstallMethod = 'npm' | 'pip' | 'binary' | 'builtin'

export interface McpConfigSchema {
  type: 'object'
  properties: Record<string, { type: string; description: string; default?: unknown }>
  required?: string[]
}

export interface McpServer {
  id: string
  name: string
  description: string
  category: McpCategory
  transport: McpTransport
  /** stdio 模式：命令 */
  command?: string
  /** stdio 模式：参数列表 */
  args?: string[]
  /** http/sse 模式：URL */
  url?: string
  /** http/sse 模式：自定义请求头（如 Authorization） */
  headers?: Record<string, string>
  /** 兼容的 Provider ID 列表，'all' 表示所有 Provider */
  compatibleProviders: string[] | 'all'
  /** 不兼容时的降级策略 */
  fallbackMode: 'prompt-injection' | 'disabled'
  /** 用户可配置参数的 JSON Schema */
  configSchema?: McpConfigSchema
  /** 用户已配置的参数值 */
  userConfig?: Record<string, unknown>
  /** 额外的环境变量 */
  envVars?: Record<string, string>
  /** 是否已安装（CLI 工具已存在） */
  isInstalled: boolean
  /** 安装方式 */
  installMethod: McpInstallMethod
  /** 安装命令（如 npm install -g @mcp/server-xxx） */
  installCommand?: string
  /** 来源 */
  source: McpSource
  /** Registry URL */
  registryUrl?: string
  version?: string
  /** 是否全局启用 */
  isGlobalEnabled: boolean
  /** 仅对指定 Provider 启用（undefined 表示所有已启用 Provider） */
  enabledForProviders?: string[]
  tags?: string[]
  author?: string
  homepage?: string
  createdAt: string
  updatedAt: string
}

// ─────────────────────────────────────────────────────────────
// Skill 技能模板类型
// ─────────────────────────────────────────────────────────────

export type SkillType = 'prompt' | 'native'
export type SkillSource = 'builtin' | 'marketplace' | 'local' | 'custom'

export interface SkillVariable {
  name: string
  description: string
  required: boolean
  defaultValue?: string
  type?: 'text' | 'select' | 'multiline'
  options?: string[]
}

export interface Skill {
  id: string
  name: string
  description: string
  category: string
  /** 触发命令，不含 /（如 "code-review" 对应 /code-review） */
  slashCommand?: string
  type: SkillType
  /** 兼容的 Provider，'all' 表示所有 */
  compatibleProviders: string[] | 'all'
  // ---- Prompt Skill ----
  promptTemplate?: string
  systemPromptAddition?: string
  inputVariables?: SkillVariable[]
  // ---- Native Skill（直接透传给 Provider） ----
  nativeConfig?: {
    providerId: string
    rawContent: string
  }
  /** 使用此 Skill 所需的 MCP ID 列表 */
  requiredMcps?: string[]
  isInstalled: boolean
  isEnabled: boolean
  source: SkillSource
  version?: string
  author?: string
  tags?: string[]
  createdAt: string
  updatedAt: string
}

// ─────────────────────────────────────────────────────────────
// Provider 能力声明
// ─────────────────────────────────────────────────────────────

export interface ProviderMcpCapability {
  /** 是否原生支持 MCP */
  native: boolean
  /** MCP 配置参数名（如 '--mcp-config'） */
  configFlag?: string
  /** MCP 配置环境变量名（如 'OPENCODE_CONFIG'、'CODEX_HOME'） */
  configEnvVar?: string
  /** 配置文件格式（json-opencode: {"mcp":{...}} 格式，区别于 claude-code 的 {"mcpServers":{...}}） */
  configFormat?: 'json' | 'toml' | 'yaml' | 'json-opencode'
  /** 不支持 MCP 时的降级策略 */
  fallback: 'prompt-injection' | 'none'
}

export interface ProviderSkillCapability {
  /** 是否原生支持 /slash 命令 */
  slashCommands: boolean
  /** 是否支持 System Prompt 注入 */
  systemPrompt: boolean
  /** Provider 自己的 Skill 文件目录（如 .claude/commands） */
  nativeSkillDir?: string
}

export interface ProviderCapability {
  providerId: string
  mcpSupport: ProviderMcpCapability
  skillSupport: ProviderSkillCapability
}

