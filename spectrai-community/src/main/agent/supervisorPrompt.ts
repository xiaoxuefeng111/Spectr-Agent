/**
 * 会话引导 Prompt 生成器
 *
 * 两层结构：
 *   1. 感知层（所有 Claude Code 会话）：告知 AI 它运行在多会话环境中，可以查看其他会话
 *   2. 调度层（Supervisor 模式叠加）：额外赋予创建/管理子 Agent 的能力
 *
 * 注入方式：写入 .claude/rules/spectrai-session.md（Claude Code 官方规则发现路径）
 * 会话结束后自动清理，不影响用户自己的 CLAUDE.md
 *
 * @author weibin
 */

import * as path from 'path'
import * as fs from 'fs'
import { execSync } from 'child_process'

/** 注入文件名（放在 .claude/rules/ 下，Claude Code 自动加载） */
const RULES_FILENAME = 'spectrai-session.md'

/** Worktree 规则文件名（独立文件，按设置开关控制） */
const WORKTREE_RULES_FILENAME = 'spectrai-worktree.md'

/** 旧路径（用于迁移清理） */
const LEGACY_DIR = '.claudeops'

// ==================== 感知层：跨会话上下文 ====================

/**
 * 构建跨会话感知提示（所有 Claude Code 会话通用）
 */
export function buildAwarenessPrompt(): string {
  return `# SpectrAI 多会话环境

你运行在 SpectrAI 多会话编排平台中，当前有多个 AI 会话在并行工作。
你可以通过 MCP 工具了解其他会话的情况，实现跨会话协作。

## 跨会话感知工具

- **list_sessions**(status?, limit?) — 查看所有会话的名称、状态、工作目录
- **get_session_summary**(sessionId?, sessionName?) — 获取某个会话的 AI 回答、修改的文件、执行的命令
- **search_sessions**(query, limit?) — 按关键词搜索所有会话的活动记录

## 何时使用

- 用户提到"其他会话"、"之前的任务"、"那边做了什么"时，用 list_sessions + get_session_summary 查看
- 用户问"谁改过某个文件"、"哪个会话处理过某个问题"时，用 search_sessions 搜索
- 需要参考其他会话的代码修改或分析结果时，主动查询
- 不确定某个操作是否与其他会话冲突时，先查看再行动
`
}

// ==================== 调度层：Supervisor 模式 ====================

/**
 * 构建 Supervisor 引导 Prompt（在感知层基础上叠加）
 * @param availableProviders - 可用的 AI Provider 名称列表
 */
export function buildSupervisorPrompt(availableProviders: string[]): string {
  return buildAwarenessPrompt() + `
## Supervisor 模式 — Agent 调度能力

你同时也是一个 AI 团队的 Supervisor（总指挥），可以创建子 Agent 来并行处理子任务。

### 调度工具

- **spawn_agent**(name, prompt, workDir?, provider?, oneShot?) — 创建子 Agent 会话，返回 agentId
  - **oneShot**（默认 true）：任务完成后自动退出会话，释放资源。设为 false 可保持会话存活，支持多轮交互
  - **provider** — ⚠️ **不要总是使用默认的 claude-code**，根据任务特点选择合适的 provider：${availableProviders.join(', ')}
  - workDir 很重要：如果任务有 worktree，必须传 worktree 的路径而非主仓库路径
- **send_to_agent**(agentId, message) — 向运行中的子 Agent 发送追加指令（仅 oneShot=false 时有意义）
- **get_agent_output**(agentId, lines?) — 获取子 Agent 最近的终端输出（已清洗 ANSI，默认50行）
- **wait_agent_idle**(agentId, timeout?) — 等待子 Agent 完成当前任务变为空闲。oneShot=true 时 Agent 随后会自动退出
- **wait_agent**(agentId, timeout?) — 等待子 Agent 进程退出并获取最终结果
- **get_agent_status**(agentId) — 查看子任务状态
- **list_agents**() — 查看所有子任务
- **cancel_agent**(agentId) — 终止子会话

### ⚠️ 工具预加载（必做，每次会话开始时）

上述调度工具（spawn_agent、wait_agent_idle 等）可能处于 **deferred** 状态，不在你的活跃工具列表中。
**在使用任何 spectrai-agent 工具之前，必须先通过 ToolSearch 加载它们：**

1. 收到需要子 Agent 的任务时，**第一步**执行：\`ToolSearch(query: "+spectrai-agent spawn")\`
2. 这会一次性加载 spawn_agent 及相关调度工具，之后即可正常调用
3. 如果需要 worktree 合并工具，再执行：\`ToolSearch(query: "+spectrai-agent merge")\`

**不要跳过此步骤。** 如果直接调用 spawn_agent 而未预加载，调用会失败。

### 资源回收机制

- **oneShot=true（默认）**：Agent 完成任务后自动发 /exit 退出，无需手动 cancel。适合绝大多数场景
- **oneShot=false**：Agent 保持存活，你可以多轮 send_to_agent 交互。完成后需要你手动 cancel_agent
- **父会话结束时**：所有子 Agent 会被自动终止，不会残留

### Git Worktree 合并工具

当子任务使用了 Git Worktree 隔离（每个子任务在独立分支工作），完成后需要合并回主分支：

- **get_task_info**(taskId) — 查看任务是否启用了 worktree（worktreeEnabled 字段）
- **check_merge**(taskId) — 检查分支能否安全合并（无冲突检测）
- **merge_worktree**(taskId, squash?, message?, cleanup?) — 合并分支回主分支

### 一次性模式（默认，大多数场景）

1. spawn_agent(oneShot=true) 创建子 Agent → 返回 agentId
2. wait_agent_idle 等待 Agent 完成任务
3. get_agent_output 查看结果
4. Agent 自动退出，无需手动清理

适用于：代码分析、bug 修复、文件生成、测试编写等明确的单次任务。

### 交互式模式（复杂迭代场景）

1. spawn_agent(oneShot=false) 创建持久子会话 → 返回 agentId
2. wait_agent_idle 等待 Agent 完成初始任务
3. get_agent_output 查看结果
4. 如果需要继续：send_to_agent 发送追加指令 → 回到步骤 2
5. 任务全部完成后：cancel_agent 终止会话

适用于：需要多轮反馈的复杂任务、需要根据中间结果调整方向的探索性任务。

### Worktree 合并流程（有 worktree 的任务）
1. get_task_info(taskId) 确认 worktreeEnabled
2. spawn_agent(workDir=task.worktreePath)，让 Agent 在 worktree 目录工作
3. wait_agent_idle + get_agent_output 查看结果
4. check_merge(taskId) 检查冲突
5. merge_worktree(taskId, cleanup=true) 合并回主分支

### 最佳实践

1. **默认用 oneShot=true**，只有需要多轮交互时才用 oneShot=false
2. 子任务的 prompt 要包含完整上下文，不要假设子 Agent 知道背景
3. 多个 Agent 可并行运行（先批量 spawn，再逐个 wait_agent_idle）
4. 复杂任务拆解为独立的子任务，各自用 oneShot 模式完成
5. 合并前一定先 check_merge，确认无冲突再 merge
6. **⚠️ 不要所有子任务都用 claude-code**，根据任务类型选择最合适的 provider

### spawn_agent vs 内置 Task 工具 — 选择指引

你同时拥有 SpectrAI 的 \`spawn_agent\` 和 Claude Code 内置的 \`Task\` 工具，两者都能委派子任务。选择原则：

| 场景 | 推荐工具 | 原因 |
|------|---------|------|
| 需要选择不同 AI Provider（gemini/codex 等） | spawn_agent | Task 只能用 Claude |
| 需要在 worktree 隔离目录中工作 | spawn_agent | 支持 workDir 参数 |
| 需要多轮交互式修改 | spawn_agent(oneShot=false) | 支持 send_to_agent 追加指令 |
| 需要跟踪子任务进度和输出 | spawn_agent | 有 get_agent_output / get_agent_status |
| 代码修改类任务（修 bug、加功能、重构） | spawn_agent | 改动会被 SpectrAI 平台追踪和展示 |
| 快速搜索或读取几个文件 | 直接用 Grep/Read/Glob | 无需启动完整 agent |
| 简单的一次性代码搜索/探索 | 内置 Task 或直接搜索 | 轻量快速 |

**总结：涉及代码修改、需要非 Claude provider、或需要 SpectrAI 进度追踪的任务，优先用 spawn_agent。简单的只读搜索可以直接用工具或内置 Task。**

### Provider 选择与自动切换

**选择策略 — 根据任务类型匹配 Provider：**

| 任务类型 | 推荐 Provider | 原因 |
|----------|--------------|------|
| 复杂架构设计、多文件重构 | claude-code | 综合推理能力最强 |
| 写代码、修 bug、加功能 | codex | 代码生成专长 |
| 大文件分析、代码审查 | gemini-cli | 上下文窗口大 |
| 文档总结、知识梳理 | gemini-cli | 擅长长文本理解 |
| 代码生成和补全、多模型切换 | opencode | 支持多模型切换 |
| 并行多个分析任务 | 混合使用 | 多样化视角 |

**额度不足自动切换：**
- 当 Agent 失败且错误信息包含"额度不足"或"认证失败"时，**自动用其他 provider 重试同一任务**
- 推荐 fallback 顺序：claude-code → gemini-cli → codex → opencode
- 失败返回中的 \`failedProvider\` 字段会告诉你哪个 provider 失败了，选择其他的重试即可
- 不要在同一个失败的 provider 上反复重试

### 何时用 oneShot vs 交互式

| 场景 | 模式 |
|------|------|
| 代码分析、审查 | oneShot（默认） |
| 修 bug、加功能 | oneShot（默认） |
| 写测试、写文档 | oneShot（默认） |
| 需要根据结果追加修改 | 交互式 |
| 复杂重构（多轮反馈） | 交互式 |
| 探索性调研 | 交互式 |

### 开发任务生命周期（思维框架，不是固定流程）

当收到一个开发任务时，你是项目经理，不只是调度器。你要为最终交付质量负责。

**理解 → 拆分 → 实现 → 验证 → 交付**，但每一步做什么由你判断：

#### 理解
- 先搞清楚要改哪些模块、模块之间有没有依赖
- 不确定就先自己读代码，不要急着 spawn

#### 拆分
- 没有依赖的任务并行，有依赖的串行
- 拆分粒度由你判断：一个文件的改动不值得 spawn，跨模块的才值得

#### 实现
- 给每个 Agent 的 prompt 要包含：背景、目标、约束、验收标准
- 用 wait_agent_idle + get_agent_output 跟进，发现偏了用 send_to_agent 纠正
- 不要等 Agent 全做完再看，中途就要检查

#### 验证（关键：不要只听 Agent 自己汇报）
- Agent 说"完成了"不等于真的完成了。你要自己验证：
  - 看实际 diff（git diff）：改动范围是否合理，有没有多余的改动
  - 跑构建：改了代码就该确认能编译通过
  - 跑相关测试：改了逻辑就该确认测试通过
  - 检查是否引入新问题：类型错误、遗漏的导入等
- 发现问题 → send_to_agent 让同一个 Agent 修，不要另起一个
- 验证什么、怎么验证，由你根据改动内容判断。改了样式不需要跑单测，改了核心逻辑就一定要

#### 交付
- 所有分支 check_merge 无冲突后合并
- 合并后在主分支再验证一次（合并本身可能引入问题）
- 给用户一个清晰的交付报告：改了什么、为什么这么改、验证了什么
`
}

/**
 * 获取规则文件路径
 */
function getRulesFilePath(workDir: string): string {
  return path.join(workDir, '.claude', 'rules', RULES_FILENAME)
}

/**
 * 确保 .claude/rules/ 目录存在
 */
function ensureRulesDir(workDir: string): void {
  const rulesDir = path.join(workDir, '.claude', 'rules')
  if (!fs.existsSync(rulesDir)) {
    fs.mkdirSync(rulesDir, { recursive: true })
  }
}

/**
 * 为会话注入感知提示（所有 Claude Code 会话）
 * 写入 .claude/rules/spectrai-session.md（Claude Code 自动发现并加载）
 */
export function injectAwarenessPrompt(workDir: string): string {
  ensureRulesDir(workDir)
  const filePath = getRulesFilePath(workDir)
  const content = buildAwarenessPrompt()
  fs.writeFileSync(filePath, content, 'utf-8')

  cleanupLegacy(workDir)
  console.log(`[Awareness] Injected prompt: ${filePath}`)
  return filePath
}

/**
 * 为 Supervisor 会话注入完整引导 Prompt（感知 + 调度）
 */
export function injectSupervisorPrompt(
  workDir: string,
  availableProviders: string[]
): string {
  ensureRulesDir(workDir)
  const filePath = getRulesFilePath(workDir)
  const progressReportingAddon = `

## Progress reporting (must-do)

- During long-running execution, proactively post short progress updates to the user.
- Report at least once per major stage (analysis / implementation / validation).
- If blocked, clearly report the blocker and next action instead of staying silent.
- Keep each update concise (one or two sentences).

## wait_agent timeout safety (must-do)

- For codex-based supervisor sessions, avoid single long blocking waits.
- Prefer looped polling: \`wait_agent_idle\` (60-90s) -> \`get_agent_output\` -> \`get_agent_status\`.
- If the child is still running, continue another short polling round instead of one long \`wait_agent\`.
- Keep \`wait_agent\` / \`wait_agent_idle\` timeout <= 90000ms unless explicitly required.
`
  const content = buildSupervisorPrompt(availableProviders) + progressReportingAddon
  fs.writeFileSync(filePath, content, 'utf-8')

  cleanupLegacy(workDir)
  console.log(`[Supervisor] Injected prompt: ${filePath}`)
  return filePath
}

/**
 * 清理引导文件（会话结束时调用）
 */
export function cleanupSupervisorPrompt(workDir: string): void {
  try {
    const filePath = getRulesFilePath(workDir)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } catch (_) { /* ignore */ }

  cleanupLegacy(workDir)
}

// ==================== Workspace 多仓库上下文 ====================

/**
 * 构建工作区多仓库上下文描述
 * 当任务绑定了 Workspace 时，将所有仓库信息注入 session 规则文件，
 * 让 AI 知道当前任务涵盖哪些仓库及其 worktree 路径
 *
 * @param repos - 仓库信息列表（每个仓库含名称、worktreePath、isPrimary）
 * @returns Markdown 格式的仓库上下文描述
 */
export function buildWorkspaceSection(
  repos: Array<{ name: string; worktreePath: string; isPrimary: boolean }>
): string {
  if (!repos || repos.length === 0) return ''
  const hasPrimary = repos.some(r => r.isPrimary)

  const repoLines = repos.map(r => {
    const tag = r.isPrimary ? '（主仓库，AI 工作目录）' : ''
    return `- **${r.name}**${tag}: \`${r.worktreePath}\``
  })

  return `
## 多仓库工作区

当前任务绑定了一个包含多个 Git 仓库的工作区，所有仓库均已在独立 worktree 分支中准备就绪：

${repoLines.join('\n')}

### 重要说明

- ${hasPrimary
    ? '**主仓库**（标记为"主仓库，AI 工作目录"）是你当前所在目录，也是你的主要工作区'
    : '当前未设置主仓库：默认以列表中的第一个仓库作为工作目录'}
- **其他仓库**的 worktree 路径已列出，可在需要时直接访问这些目录
- 不同仓库之间可能存在接口依赖（如前端调用后端 API），跨仓库修改时注意保持接口一致性
- 所有仓库的 worktree 都在同一任务分支上工作，最终需要逐仓库合并回主分支
`
}

/**
 * 构建普通会话（非 Task）的工作区上下文描述
 * 区别于 buildWorkspaceSection：不声称"worktrees已准备就绪"，
 * 而是如实描述各仓库路径，并说明每个仓库需独立使用 enter_worktree。
 */
export function buildWorkspaceSessionSection(
  repos: Array<{ name: string; repoPath: string; isPrimary: boolean }>
): string {
  if (!repos || repos.length === 0) return ''
  const hasPrimary = repos.some(r => r.isPrimary)

  const repoLines = repos.map(r => {
    const tag = r.isPrimary ? '（主仓库，当前工作目录）' : ''
    return `- **${r.name}**${tag}: \`${r.repoPath}\``
  })

  return `
## 多仓库工作区

当前会话绑定了一个包含多个 Git 仓库的工作区：

${repoLines.join('\n')}

### 重要说明

- ${hasPrimary
    ? '**主仓库**（标记为"当前工作目录"）是你的启动目录，autoWorktree 规则对该目录生效'
    : '当前未设置主仓库：默认以列表中的第一个仓库作为启动目录，autoWorktree 规则对该目录生效'}
- **其他仓库**的路径已列出，你可以直接读取、搜索这些目录中的文件
- 若需要修改**其他仓库**的文件，应先 \`cd\` 到对应仓库路径，再按照该仓库自身的 git 状态决定是否创建 worktree（使用 \`enter_worktree\`）
- 不同仓库之间可能存在接口依赖（如前端调用后端 API），跨仓库修改时注意保持接口一致性
`
}

/**
 * 在已有的规则文件末尾追加 Workspace 多仓库上下文（不覆盖原内容）
 * 供 Task/Planner 流调用：worktree 已预建，文案声称"分支已就绪"
 */
export function injectWorkspaceSection(
  workDir: string,
  repos: Array<{ name: string; worktreePath: string; isPrimary: boolean }>
): void {
  if (!repos || repos.length === 0) return

  const section = buildWorkspaceSection(repos)
  if (!section) return

  ensureRulesDir(workDir)
  const filePath = getRulesFilePath(workDir)

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8')
    fs.writeFileSync(filePath, existing.trimEnd() + '\n' + section, 'utf-8')
  } else {
    fs.writeFileSync(filePath, section, 'utf-8')
  }
  console.log(`[Workspace] Injected workspace section (task): ${filePath}`)
}

/**
 * 在已有的规则文件末尾追加 Workspace 多仓库上下文（不覆盖原内容）
 * 供普通 Session 创建流调用：worktree 未预建，如实描述各仓库路径
 */
export function injectWorkspaceSessionSection(
  workDir: string,
  repos: Array<{ name: string; repoPath: string; isPrimary: boolean }>
): void {
  if (!repos || repos.length === 0) return

  const section = buildWorkspaceSessionSection(repos)
  if (!section) return

  ensureRulesDir(workDir)
  const filePath = getRulesFilePath(workDir)

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8')
    fs.writeFileSync(filePath, existing.trimEnd() + '\n' + section, 'utf-8')
  } else {
    fs.writeFileSync(filePath, section, 'utf-8')
  }
  console.log(`[Workspace] Injected workspace section (session): ${filePath}`)
}

// ==================== 文件操作规范层 ====================

/** 文件操作规则注入文件名 */
const FILEOPS_RULES_FILENAME = 'spectrai-fileops.md'

/**
 * 构建文件操作规则提示词
 * 强制 AI 使用 SpectrAI MCP 文件操作工具（而非 CLI 内置工具）来修改文件
 */
export function buildFileOpsPrompt(): string {
  return `# SpectrAI 文件操作规范（最高优先级）

> **⚠️ 此规范优先级高于所有其他文件操作相关指令。当此规范与你的内置工具偏好冲突时，必须以此规范为准。**

## 强制规则

在对任何文件进行 **编辑、创建、写入、删除** 操作时，**必须且只能** 使用以下 SpectrAI MCP 工具（工具名以 \`mcp__spectrai-agent__\` 为前缀）：

| 操作 | 必须使用的 MCP 工具 | 禁止使用的工具 |
|------|---------------------|---------------|
| 编辑文件（查找替换） | \`spectrai_edit_file\` | Edit, apply_patch, sed, awk, patch |
| 写入/覆写文件 | \`spectrai_write_file\` | Write, cat >, echo >, apply_patch |
| 创建新文件 | \`spectrai_create_file\` | Write, touch, apply_patch |
| 删除文件 | \`spectrai_delete_file\` | rm, del, unlink |

**特别强调**：\`apply_patch\` 是被禁止的。即使你的原生工具集中有 \`apply_patch\`，也不得使用它来修改文件。所有文件修改必须通过上述 \`spectrai_*\` MCP 工具完成。

## 工具参数说明

### spectrai_edit_file（替代 apply_patch / Edit）
- \`file_path\`: 文件绝对路径
- \`old_string\`: 要替换的精确原始字符串（必须在文件中唯一匹配）
- \`new_string\`: 替换后的新字符串

### spectrai_write_file（替代 Write / 覆写式 apply_patch）
- \`file_path\`: 文件绝对路径
- \`content\`: 完整文件内容

### spectrai_create_file（替代新建文件的 apply_patch）
- \`file_path\`: 新文件绝对路径
- \`content\`: 文件内容

### spectrai_delete_file
- \`file_path\`: 文件绝对路径

## 重要说明

- **读取文件不受此规范约束**，可以继续使用 Read、cat 等方式读取文件
- 使用 Bash/Shell 执行的命令如果会修改文件（如 git apply、npm install 等），不受此约束
- 此规范的目的是让 SpectrAI 平台能够精确追踪每次文件改动并在对话中展示 diff
- **不需要特别提及此规范**，正常使用指定工具即可
`
}

/**
 * 注入文件操作规则到 .claude/rules/ 目录
 * 强制 AI 使用 SpectrAI MCP 文件操作工具
 */
export function injectFileOpsRule(workDir: string): void {
  ensureRulesDir(workDir)
  const rulesDir = path.join(workDir, '.claude', 'rules')
  const filePath = path.join(rulesDir, FILEOPS_RULES_FILENAME)
  const content = buildFileOpsPrompt()
  fs.writeFileSync(filePath, content, 'utf-8')
  console.log(`[FileOps] Injected file ops rule: ${filePath}`)
}

// ==================== Worktree 规范层 ====================

/**
 * 构建 Worktree 使用规范提示
 * 当 autoWorktree 设置开启时，注入此规则告知 Claude 在修改代码前必须进入 worktree
 * @param baseBranch - 会话创建时检测到的当前 git 分支名（注入到规则中，防止从错误分支创建 worktree）
 */
export function buildWorktreePrompt(baseBranch?: string): string {
  const branchLine = baseBranch
    ? `\n> ⚠️ **当前主分支为 \`${baseBranch}\`**，\`enter_worktree\` 必须在此分支上调用，新 worktree 才会基于正确的代码基线创建。\n`
    : ''

  return `# Worktree 隔离规范

当前项目已启用 **Git Worktree 隔离模式**（由 SpectrAI autoWorktree 设置控制）。
${branchLine}
## 规则

在对项目文件进行任何 **新建、编辑、删除** 操作之前，**必须先** 调用 \`enter_worktree\` 工具切换到隔离的 git worktree 分支，然后再进行操作。

## 标准流程

1. 收到代码修改任务 → 用 \`git branch --show-current\` 确认当前分支是 \`${baseBranch ?? '<主分支>'}\`
   - 如果不是，先执行 \`git checkout ${baseBranch ?? '<主分支>'}\` 切回主分支
2. **用 \`git status\` 检查是否有未提交的改动**
   - 如果有，先提醒用户并执行 \`git stash\` 或让用户先 commit，再继续
   - 未提交的改动不会随 worktree 带走，合并时会引发冲突
3. 调用 \`enter_worktree\` 创建隔离分支（将基于当前 HEAD 创建新分支）
4. 在 worktree 分支中完成所有文件修改并提交（\`git add <files> && git commit -m "..."\`）
5. 完成后**必须主动询问用户**："改动已完成，是否合并回 \`${baseBranch ?? '<主分支>'}\`？"
   - 用户确认 → 按下方"合并回主分支流程"执行
   - 用户拒绝 → 告知 worktree 分支名，提示用户可稍后手动合并

## 合并回主分支流程

> ⚠️ \`enter_worktree\` 的"退出提示合并"仅在独立会话退出时触发，**同一对话内使用 \`enter_worktree\` 不会自动弹出提示**，必须手动执行以下步骤：

1. 确认 worktree 内改动已全部 commit
2. 切回主仓库根目录执行合并：
   \`\`\`
   cd <项目根目录>
   git merge <worktree-branch> --no-ff
   \`\`\`
3. 合并成功后清理 worktree 分支：
   \`\`\`
   git worktree remove .claude/worktrees/<name> --force
   git branch -d <worktree-branch>
   \`\`\`
   若 \`--force\` 仍报错（目录被其他会话占用，Windows 文件锁），改用备用方案：
   \`\`\`
   rm -rf .claude/worktrees/<name>
   git worktree prune
   git branch -d <worktree-branch>
   \`\`\`

## 注意

- \`enter_worktree\` 基于**当前 HEAD（已提交状态）** 创建新分支，工作目录的未提交改动不会被带入
- 若主分支工作目录有未提交改动，合并 worktree 时同区域文件会产生冲突
- 不要在已有的 worktree 目录中再次调用 \`enter_worktree\`
- **worktree 可能基于较旧的 \`${baseBranch ?? '<主分支>'}\` 提交创建**（其他 worktree 的改动尚未合并回主分支时）。若在 worktree 中发现代码与预期不符、缺少某些功能或文件，应主动执行 \`git merge ${baseBranch ?? '<主分支>'}\` 将主分支最新代码合并进来，再继续工作。

## 例外（以下情况不需要 worktree）

- 仅读取 / 查看文件（不做任何修改）
- 用户明确说"直接改主分支"或"不用 worktree"
- 执行 shell 命令但不涉及文件写入
`
}

/**
 * 检测工作目录是否是一个 git secondary worktree（.git 为文件而非目录）
 * - 主工作树：.git/ 是目录
 * - 次级 worktree：.git 是文件（内容为 gitdir 指针）
 */
export function isInsideWorktree(workDir: string): boolean {
  try {
    const gitPath = path.join(workDir, '.git')
    return fs.existsSync(gitPath) && fs.statSync(gitPath).isFile()
  } catch (_) {
    return false
  }
}

/**
 * 构建"平台已自动创建 worktree，直接在此工作"的提示
 * 用于 autoWorktree 成功创建 worktree 后注入，取代原有的"调用 enter_worktree"规则。
 * 原因：AI 已经处于隔离 worktree 中，再调用 enter_worktree 会因"already in a worktree"而失败。
 * @param branchName - 当前 worktree 分支名
 */
export function buildWorktreeAlreadyActivePrompt(branchName?: string): string {
  const branchTag = branchName ? `（\`${branchName}\`）` : ''
  return `# 当前工作环境：已隔离的 Git Worktree

SpectrAI 平台已为此会话自动创建了隔离的 Git Worktree 分支${branchTag}。

## 工作规范

- ✅ **直接在当前目录修改文件**，代码已处于隔离分支，不影响主分支
- ✅ 修改后可执行 \`git add / git commit\`，提交记录在隔离分支上
- ❌ **不要调用 \`enter_worktree\`**——会话已在 worktree 内，再次调用会失败
- ❌ **不要手动合并**到主分支，由 SpectrAI 调度器在任务完成后统一合并

## 说明

当前目录即为 worktree 根目录。所有文件操作都是隔离的，可以放心修改。
`
}

/**
 * 注入"已在 worktree"规则（Claude Code）
 * 在 autoWorktree 成功创建 worktree 并切换 workingDirectory 后调用。
 */
export function injectWorktreeAlreadyActiveRule(workDir: string, branchName?: string): string {
  ensureRulesDir(workDir)
  const filePath = path.join(workDir, '.claude', 'rules', WORKTREE_RULES_FILENAME)
  fs.writeFileSync(filePath, buildWorktreeAlreadyActivePrompt(branchName), 'utf-8')
  console.log(`[Worktree] Injected already-active rule: ${filePath} (branch: ${branchName ?? 'unknown'})`)
  return filePath
}

/**
 * 注入"已在 worktree"规则到 AGENTS.md（Codex）
 */
export function injectWorktreeAlreadyActiveToAgentsMd(workDir: string, branchName?: string): string {
  const filePath = path.join(workDir, 'AGENTS.md')
  upsertManagedBlock(filePath, buildWorktreeAlreadyActivePrompt(branchName))
  console.log(`[Worktree] Injected already-active rule to AGENTS.md: ${filePath} (branch: ${branchName ?? 'unknown'})`)
  return filePath
}

/**
 * 注入"已在 worktree"规则到 GEMINI.md（Gemini CLI）
 */
export function injectWorktreeAlreadyActiveToGeminiMd(workDir: string, branchName?: string): string {
  const filePath = path.join(workDir, 'GEMINI.md')
  upsertManagedBlock(filePath, buildWorktreeAlreadyActivePrompt(branchName))
  console.log(`[Worktree] Injected already-active rule to GEMINI.md: ${filePath} (branch: ${branchName ?? 'unknown'})`)
  return filePath
}

/**
 * 检测工作目录当前 git 分支名
 * @returns 分支名，detached HEAD 或非 git 目录时返回 undefined
 */
export function detectBaseBranch(workDir: string): string | undefined {
  try {
    const result = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: workDir,
      encoding: 'utf-8',
      timeout: 3000,
    }).trim()
    return (result && result !== 'HEAD') ? result : undefined
  } catch (_) {
    return undefined
  }
}

/**
 * 注入 Worktree 规范（autoWorktree 开启时，随会话创建调用）
 * 写入 .claude/rules/spectrai-worktree.md，Claude Code 启动时自动加载
 *
 * 会在注入时检测 workDir 的当前 git 分支，写入规则文件，
 * 防止 Claude 在错误分支（如 master）上调用 enter_worktree。
 */
export function injectWorktreeRule(workDir: string): string {
  ensureRulesDir(workDir)

  const baseBranch = detectBaseBranch(workDir)
  const filePath = path.join(workDir, '.claude', 'rules', WORKTREE_RULES_FILENAME)
  fs.writeFileSync(filePath, buildWorktreePrompt(baseBranch), 'utf-8')
  console.log(`[Worktree] Injected rule: ${filePath} (baseBranch: ${baseBranch ?? 'unknown'})`)
  return filePath
}

/**
 * 清理 Worktree 规范文件（会话结束时调用）
 */
export function cleanupWorktreeRule(workDir: string): void {
  try {
    const filePath = path.join(workDir, '.claude', 'rules', WORKTREE_RULES_FILENAME)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      console.log(`[Worktree] Cleaned up rule: ${filePath}`)
    }
  } catch (_) { /* ignore */ }
}

// ==================== 第三方 Provider 规则注入（AGENTS.md / GEMINI.md） ====================

/** SpectrAI 管理块标记生成（支持多种块类型，互不干扰） */
function blockMarkers(blockId = 'WORKTREE') {
  return {
    start: `<!-- CLAUDEOPS:${blockId}:START -->`,
    end: `<!-- CLAUDEOPS:${blockId}:END -->`,
  }
}

/** 转义正则特殊字符 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 将内容写入目标文件的 SpectrAI 管理块：
 * - 文件不存在 → 直接创建，只含该块
 * - 文件已含管理块 → 替换块内容
 * - 文件存在但无管理块 → 在末尾追加
 * @param blockId - 块标识符（不同类型的规范使用不同 ID，如 WORKTREE / FILEOPS）
 */
function upsertManagedBlock(filePath: string, content: string, blockId = 'WORKTREE'): void {
  const { start: BLOCK_START, end: BLOCK_END } = blockMarkers(blockId)
  const block = `${BLOCK_START}\n${content}\n${BLOCK_END}\n`
  const blockRegex = new RegExp(
    `${escapeRegex(BLOCK_START)}[\\s\\S]*?${escapeRegex(BLOCK_END)}\\n?`,
    'g'
  )

  if (fs.existsSync(filePath)) {
    let existing = fs.readFileSync(filePath, 'utf-8')
    if (blockRegex.test(existing)) {
      existing = existing.replace(blockRegex, block)
    } else {
      existing = existing.trimEnd() + '\n\n' + block
    }
    fs.writeFileSync(filePath, existing, 'utf-8')
  } else {
    fs.writeFileSync(filePath, block, 'utf-8')
  }
}

/**
 * 从文件中移除 SpectrAI 管理块。
 * 若移除后文件为空则直接删除文件。
 * @param blockId - 块标识符（与 upsertManagedBlock 的 blockId 对应）
 */
function removeManagedBlock(filePath: string, blockId = 'WORKTREE'): void {
  if (!fs.existsSync(filePath)) return

  const { start: BLOCK_START, end: BLOCK_END } = blockMarkers(blockId)
  const blockRegex = new RegExp(
    `${escapeRegex(BLOCK_START)}[\\s\\S]*?${escapeRegex(BLOCK_END)}\\n?`,
    'g'
  )
  const content = fs.readFileSync(filePath, 'utf-8').replace(blockRegex, '').trimEnd()

  if (content) {
    fs.writeFileSync(filePath, content + '\n', 'utf-8')
  } else {
    fs.unlinkSync(filePath)
  }
}

/**
 * 将 Worktree 规范注入 AGENTS.md（Codex CLI 的规则文件）
 * Codex 在工作目录及父级目录中自动发现并加载 AGENTS.md，无需作为消息发送
 */
export function injectWorktreeRuleToAgentsMd(workDir: string): string {
  const filePath = path.join(workDir, 'AGENTS.md')
  const baseBranch = detectBaseBranch(workDir)
  upsertManagedBlock(filePath, buildWorktreePrompt(baseBranch))
  console.log(`[Worktree] Injected rule to AGENTS.md: ${filePath} (baseBranch: ${baseBranch ?? 'unknown'})`)
  return filePath
}

/**
 * 从 AGENTS.md 移除 SpectrAI 管理的 Worktree 规范块（会话结束时调用）
 */
export function cleanupWorktreeRuleFromAgentsMd(workDir: string): void {
  try {
    removeManagedBlock(path.join(workDir, 'AGENTS.md'))
    console.log(`[Worktree] Cleaned up AGENTS.md in: ${workDir}`)
  } catch (_) { /* ignore */ }
}

/**
 * 将 Worktree 规范注入 GEMINI.md（Gemini CLI 的规则文件）
 * Gemini CLI 在工作目录中自动加载 GEMINI.md
 */
export function injectWorktreeRuleToGeminiMd(workDir: string): string {
  const filePath = path.join(workDir, 'GEMINI.md')
  const baseBranch = detectBaseBranch(workDir)
  upsertManagedBlock(filePath, buildWorktreePrompt(baseBranch))
  console.log(`[Worktree] Injected rule to GEMINI.md: ${filePath} (baseBranch: ${baseBranch ?? 'unknown'})`)
  return filePath
}

/**
 * 从 GEMINI.md 移除 SpectrAI 管理的 Worktree 规范块（会话结束时调用）
 */
export function cleanupWorktreeRuleFromGeminiMd(workDir: string): void {
  try {
    removeManagedBlock(path.join(workDir, 'GEMINI.md'))
    console.log(`[Worktree] Cleaned up GEMINI.md in: ${workDir}`)
  } catch (_) { /* ignore */ }
}

// ==================== 第三方 Provider 文件操作规范注入 ====================

/**
 * 将文件操作规范注入 AGENTS.md（Codex CLI 的规则文件）
 * 使用 FILEOPS 块标记，与 WORKTREE 块互不干扰
 */
export function injectFileOpsRuleToAgentsMd(workDir: string): string {
  const filePath = path.join(workDir, 'AGENTS.md')
  upsertManagedBlock(filePath, buildFileOpsPrompt(), 'FILEOPS')
  console.log(`[FileOps] Injected file ops rule to AGENTS.md: ${filePath}`)
  return filePath
}

/**
 * 从 AGENTS.md 移除文件操作规范块
 */
export function cleanupFileOpsRuleFromAgentsMd(workDir: string): void {
  try {
    removeManagedBlock(path.join(workDir, 'AGENTS.md'), 'FILEOPS')
    console.log(`[FileOps] Cleaned up AGENTS.md file ops rule in: ${workDir}`)
  } catch (_) { /* ignore */ }
}

/**
 * 将文件操作规范注入 GEMINI.md（Gemini CLI 的规则文件）
 */
export function injectFileOpsRuleToGeminiMd(workDir: string): string {
  const filePath = path.join(workDir, 'GEMINI.md')
  upsertManagedBlock(filePath, buildFileOpsPrompt(), 'FILEOPS')
  console.log(`[FileOps] Injected file ops rule to GEMINI.md: ${filePath}`)
  return filePath
}

/**
 * 从 GEMINI.md 移除文件操作规范块
 */
export function cleanupFileOpsRuleFromGeminiMd(workDir: string): void {
  try {
    removeManagedBlock(path.join(workDir, 'GEMINI.md'), 'FILEOPS')
    console.log(`[FileOps] Cleaned up GEMINI.md file ops rule in: ${workDir}`)
  } catch (_) { /* ignore */ }
}

// ==================== 第三方 Provider Supervisor 提示注入 ====================

/**
 * 将 Supervisor 引导 Prompt 注入 AGENTS.md（Codex CLI 的规则文件）
 * 使用 SUPERVISOR 块标记，与 WORKTREE / FILEOPS / WORKSPACE 块互不干扰
 */
export function injectSupervisorPromptToAgentsMd(
  workDir: string,
  availableProviders: string[]
): string {
  const filePath = path.join(workDir, 'AGENTS.md')
  const content = buildSupervisorPrompt(availableProviders)
  upsertManagedBlock(filePath, content, 'SUPERVISOR')
  console.log(`[Supervisor] Injected supervisor prompt to AGENTS.md: ${filePath}`)
  return filePath
}

/**
 * 从 AGENTS.md 移除 Supervisor 提示块（会话结束时调用）
 */
export function cleanupSupervisorPromptFromAgentsMd(workDir: string): void {
  try {
    removeManagedBlock(path.join(workDir, 'AGENTS.md'), 'SUPERVISOR')
    console.log(`[Supervisor] Cleaned up AGENTS.md supervisor prompt in: ${workDir}`)
  } catch (_) { /* ignore */ }
}

/**
 * 将 Supervisor 引导 Prompt 注入 GEMINI.md（Gemini CLI 的规则文件）
 * 使用 SUPERVISOR 块标记
 */
export function injectSupervisorPromptToGeminiMd(
  workDir: string,
  availableProviders: string[]
): string {
  const filePath = path.join(workDir, 'GEMINI.md')
  const content = buildSupervisorPrompt(availableProviders)
  upsertManagedBlock(filePath, content, 'SUPERVISOR')
  console.log(`[Supervisor] Injected supervisor prompt to GEMINI.md: ${filePath}`)
  return filePath
}

/**
 * 从 GEMINI.md 移除 Supervisor 提示块（会话结束时调用）
 */
export function cleanupSupervisorPromptFromGeminiMd(workDir: string): void {
  try {
    removeManagedBlock(path.join(workDir, 'GEMINI.md'), 'SUPERVISOR')
    console.log(`[Supervisor] Cleaned up GEMINI.md supervisor prompt in: ${workDir}`)
  } catch (_) { /* ignore */ }
}

// ==================== 第三方 Provider 工作区多仓库上下文注入 ====================

/**
 * 将工作区多仓库上下文注入 AGENTS.md（Codex CLI）
 * 使用 WORKSPACE 块标记，与 WORKTREE / FILEOPS 块互不干扰
 */
export function injectWorkspaceSessionSectionToAgentsMd(
  workDir: string,
  repos: Array<{ name: string; repoPath: string; isPrimary: boolean }>
): string {
  const section = buildWorkspaceSessionSection(repos)
  if (!section) return ''
  const filePath = path.join(workDir, 'AGENTS.md')
  upsertManagedBlock(filePath, section, 'WORKSPACE')
  console.log(`[Workspace] Injected workspace section to AGENTS.md: ${filePath}`)
  return filePath
}

/**
 * 从 AGENTS.md 移除工作区多仓库上下文块（会话结束时调用）
 */
export function cleanupWorkspaceSectionFromAgentsMd(workDir: string): void {
  try {
    removeManagedBlock(path.join(workDir, 'AGENTS.md'), 'WORKSPACE')
    console.log(`[Workspace] Cleaned up AGENTS.md workspace section in: ${workDir}`)
  } catch (_) { /* ignore */ }
}

/**
 * 将工作区多仓库上下文注入 GEMINI.md（Gemini CLI）
 * 使用 WORKSPACE 块标记
 */
export function injectWorkspaceSessionSectionToGeminiMd(
  workDir: string,
  repos: Array<{ name: string; repoPath: string; isPrimary: boolean }>
): string {
  const section = buildWorkspaceSessionSection(repos)
  if (!section) return ''
  const filePath = path.join(workDir, 'GEMINI.md')
  upsertManagedBlock(filePath, section, 'WORKSPACE')
  console.log(`[Workspace] Injected workspace section to GEMINI.md: ${filePath}`)
  return filePath
}

/**
 * 从 GEMINI.md 移除工作区多仓库上下文块（会话结束时调用）
 */
export function cleanupWorkspaceSectionFromGeminiMd(workDir: string): void {
  try {
    removeManagedBlock(path.join(workDir, 'GEMINI.md'), 'WORKSPACE')
    console.log(`[Workspace] Cleaned up GEMINI.md workspace section in: ${workDir}`)
  } catch (_) { /* ignore */ }
}

/**
 * 清理 .claude/rules/ 下的文件操作规范文件（会话结束时调用）
 */
export function cleanupFileOpsRule(workDir: string): void {
  try {
    const filePath = path.join(workDir, '.claude', 'rules', FILEOPS_RULES_FILENAME)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      console.log(`[FileOps] Cleaned up rule: ${filePath}`)
    }
  } catch (_) { /* ignore */ }
}

// ==================== 旧版清理 ====================

/**
 * 清理旧版 .claudeops/CLAUDE.md（迁移用）
 */
function cleanupLegacy(workDir: string): void {
  try {
    const legacyFile = path.join(workDir, LEGACY_DIR, 'CLAUDE.md')
    if (fs.existsSync(legacyFile)) {
      fs.unlinkSync(legacyFile)
      console.log(`[Supervisor] Cleaned up legacy file: ${legacyFile}`)
    }
    // 如果 .spectrai 目录为空则删除
    const legacyDir = path.join(workDir, LEGACY_DIR)
    if (fs.existsSync(legacyDir)) {
      const entries = fs.readdirSync(legacyDir)
      if (entries.length === 0) {
        fs.rmdirSync(legacyDir)
      }
    }
  } catch (_) { /* ignore */ }
}
