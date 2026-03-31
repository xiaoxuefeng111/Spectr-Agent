# SpectrAI 技术架构文档

> 版本：0.4.6 | 更新日期：2026-03-31 | 作者：weibin

---

## 目录

1. [项目概述](#1-项目概述)
2. [系统架构总览](#2-系统架构总览)
3. [主进程架构](#3-主进程架构)
4. [会话管理与 Agent 编排](#4-会话管理与-agent-编排)
5. [数据存储层](#5-数据存储层)
6. [渲染进程架构](#6-渲染进程架构)
7. [核心功能模块详解](#7-核心功能模块详解)
8. [数据结构与类型定义](#8-数据结构与类型定义)
9. [关键代码路径示例](#9-关键代码路径示例)
10. [开发指南](#10-开发指南)

---

## 1. 项目概述

### 1.1 背景

SpectrAI 诞生于一个核心痛点：**多个 AI CLI 工具（Claude Code、Codex、Gemini CLI 等）各自独立运行，无法统一管理和协作**。开发者需要在多个终端窗口间切换，难以追踪对话历史、监控 Token 消耗、协调多 Agent 任务。

### 1.2 目标

- **统一入口**：一个桌面应用同时管理多个 AI 会话
- **结构化视图**：将裸终端输出转换为可读的消息气泡、工具卡片、时间线
- **Agent 编排**：让 AI 能够自动创建和管理子会话，实现任务分解与并行执行
- **跨 Provider 支持**：屏蔽各 CLI 工具的通信差异，提供一致的操作体验

### 1.3 核心价值

| 价值点 | 说明 |
|--------|------|
| **会话可视化** | 结构化对话视图、时间线、Token 用量统计 |
| **Agent 编排** | Supervisor 模式 + MCP 工具链，自动任务分解 |
| **多 Provider** | 统一 Adapter 抽象层，支持 Claude/Codex/Gemini/iFlow/OpenCode |
| **文件追踪** | 实时监听 AI 改动，多会话归因，竞态检测 |
| **远程控制** | Telegram Bot 集成，随时随地管理会话 |

### 1.4 技术栈概览

| 类别 | 技术 |
|------|------|
| **框架** | Electron 28 + React 18 + TypeScript 5 |
| **构建** | electron-vite + Vite 5 |
| **状态管理** | Zustand |
| **存储** | better-sqlite3（SQLite）+ Repository 模式 |
| **AI 接入** | Claude Agent SDK V2 + 自定义 Provider Adapter |
| **UI** | Tailwind CSS + Lucide Icons + Allotment |
| **拖拽** | @dnd-kit |
| **图表** | Recharts |
| **MCP** | @modelcontextprotocol/sdk |
| **通信** | WebSocket（Agent Bridge） |

---

## 2. 系统架构总览

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           SpectrAI Desktop App                          │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                     Renderer Process (React)                     │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────────┐ │    │
│  │  │ Session  │ │Conversation│ │ File     │ │ Agent Teams /       │ │    │
│  │  │ Sidebar  │ │   View    │ │ Manager  │ │   Dashboard         │ │    │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────────────────┘ │    │
│  │  ┌──────────────────────────────────────────────────────────────┐│    │
│  │  │              Zustand Stores (State Management)               ││    │
│  │  │  sessionStore | taskStore | settingsStore | teamStore        ││    │
│  │  └──────────────────────────────────────────────────────────────┘│    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                    │                                     │
│                              IPC (contextBridge)                         │
│                                    │                                     │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                      Main Process (Node.js)                      │    │
│  │  ┌─────────────────────────────────────────────────────────────┐│    │
│  │  │                    AdapterRegistry                           ││    │
│  │  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐            ││    │
│  │  │  │ClaudeSdk    │ │CodexApp     │ │Gemini       │ ...        ││    │
│  │  │  │Adapter      │ │ServerAdapter│ │HeadlessAdapt│            ││    │
│  │  │  └─────────────┘ └─────────────┘ └─────────────┘            ││    │
│  │  └─────────────────────────────────────────────────────────────┘│    │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                │    │
│  │  │SessionManager│ │AgentManager │ │FileChange   │                │    │
│  │  │     V2      │ │     V2      │ │  Tracker    │                │    │
│  │  └─────────────┘ └─────────────┘ └─────────────┘                │    │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────────┐│    │
│  │  │Database     │ │AgentBridge  │ │   IPC Handlers              ││    │
│  │  │Manager      │ │(WebSocket)  │ │   (session/task/agent/...)  ││    │
│  │  └─────────────┘ └─────────────┘ └─────────────────────────────┘│    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                    │                                     │
│                              AI CLI Processes                            │
│              (Claude Code / Codex / Gemini / iFlow / OpenCode)           │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 核心设计原则

| 原则 | 说明 |
|------|------|
| **Provider Adapter 抽象** | 统一 `BaseProviderAdapter` 接口，屏蔽各 CLI 通信差异 |
| **事件驱动架构** | SessionManager/AgentManager 均继承 EventEmitter，模块间松耦合 |
| **Repository 模式** | 每个业务领域独立 Repository，Database 作为连接池 |
| **确定性就绪检测** | 使用 `turn_complete` 事件替代超时推断，消除竞态问题 |
| **增量消息流** | `text_delta` 事件支持流式渲染，提升用户体验 |

### 2.3 三层架构

```
┌────────────────────────────────────────────────────────────┐
│                    Presentation Layer                       │
│         React Components / Zustand Stores / IPC Client     │
├────────────────────────────────────────────────────────────┤
│                    Business Logic Layer                     │
│    SessionManagerV2 / AgentManagerV2 / FileChangeTracker   │
│              AdapterRegistry / SkillEngine                  │
├────────────────────────────────────────────────────────────┤
│                    Data Access Layer                        │
│         DatabaseManager / Repositories / MCPConfig          │
└────────────────────────────────────────────────────────────┘
```

---

## 3. 主进程架构

### 3.1 入口与生命周期

**文件**：`src/main/index.ts`

#### 初始化顺序

```
app.whenReady()
  ├── bootstrapShellPath()           // 修复 macOS Finder 启动时 PATH 缺失
  ├── migrateFromLegacyUserData()    // 数据迁移（旧目录 → 新目录）
  ├── initializeManagers()           // 初始化所有管理器
  │     ├── DatabaseManager          // ① 数据库（最先，其他模块依赖）
  │     ├── SessionManager           // ② PTY 会话管理（V1 兼容）
  │     ├── ConcurrencyGuard         // ③ 并发控制
  │     ├── OutputParser             // ④ 输出解析引擎
  │     ├── StateInference           // ⑤ 状态推断引擎
  │     ├── NotificationManager      // ⑥ 通知管理器
  │     ├── TrayManager              // ⑦ 系统托盘
  │     ├── TaskSessionCoordinator   // ⑧ 任务-会话协调器
  │     ├── OutputReaderManager      // ⑨ 结构化输出读取器
  │     ├── AgentBridge              // ⑩ WebSocket 桥接（端口 63721）
  │     ├── AgentManager             // ⑪ Agent 管理器（V1）
  │     ├── AdapterRegistry          // ⑫ SDK V2 Adapter 注册
  │     ├── SessionManagerV2         // ⑬ SDK V2 会话管理器
  │     └── AgentManagerV2           // ⑭ SDK V2 Agent 管理器
  ├── wireEvents()                   // 连接模块间事件流
  ├── registerIpcHandlers()          // 注册 IPC 处理器
  ├── createWindow()                 // 创建主窗口
  └── trayManager.init()             // 初始化系统托盘
```

#### 退出流程

```
app.on('before-quit')
  ├── stateInference.stop()          // 停止状态推断引擎
  ├── outputParser.stopWatching()    // 停止文件监听
  ├── sessionManager.cleanup()       // 清理 V1 会话
  ├── sessionManagerV2.cleanup()     // 清理 V2 会话
  ├── agentManager.cleanup()         // 清理 V1 Agent
  ├── agentManagerV2.cleanup()       // 清理 V2 Agent
  ├── adapterRegistry.cleanup()      // 清理所有 Adapter
  ├── fileChangeTracker.destroy()    // 销毁文件追踪器
  ├── database.resolveAllInterrupted() // 标记中断会话
  ├── database.close()               // 关闭数据库连接
  └── trayManager.destroy()          // 销毁托盘图标
```

### 3.2 IPC 通信层

**文件**：`src/main/ipc/index.ts`

#### IPC 模块划分

| 模块 | 文件 | 职责 |
|------|------|------|
| `sessionHandlers` | sessionHandlers.ts | 会话创建/终止/恢复/消息发送 |
| `agentHandlers` | agentHandlers.ts | Agent spawn/wait/cancel |
| `taskHandlers` | taskHandlers.ts | 看板任务 CRUD |
| `providerHandlers` | providerHandlers.ts | AI Provider 管理 |
| `gitHandlers` | gitHandlers.ts | Git 分支/Worktree 操作 |
| `fileManagerHandlers` | fileManagerHandlers.ts | 文件树/改动追踪 |
| `mcpHandlers` | mcpHandlers.ts | MCP 服务器管理 |
| `skillHandlers` | skillHandlers.ts | Skill 技能管理 |
| `systemHandlers` | systemHandlers.ts | 应用设置/主题/自动更新 |

#### 依赖注入接口

```typescript
interface IpcDependencies {
  sessionManager: SessionManager       // V1 PTY 会话（兼容）
  sessionManagerV2?: SessionManagerV2  // V2 SDK 会话
  database: DatabaseManager
  outputParser: OutputParser
  concurrencyGuard: ConcurrencyGuard
  notificationManager: NotificationManager
  trayManager: TrayManager
  agentManagerV2?: AgentManagerV2
  updateManager?: UpdateManager
}
```

### 3.3 Provider Adapter 层

**核心抽象**：`src/main/adapter/types.ts`

```typescript
abstract class BaseProviderAdapter extends EventEmitter {
  abstract readonly providerId: string      // 唯一标识
  abstract readonly displayName: string     // 友好名称

  // 会话生命周期
  abstract startSession(sessionId: string, config: AdapterSessionConfig): Promise<void>
  abstract resumeSession(sessionId: string, providerSessionId: string, config: AdapterSessionConfig): Promise<void>
  abstract terminateSession(sessionId: string): Promise<void>

  // 交互
  abstract sendMessage(sessionId: string, message: string): Promise<void>
  abstract sendConfirmation(sessionId: string, accept: boolean): Promise<void>
  abstract abortCurrentTurn(sessionId: string): Promise<void>

  // 查询
  abstract getConversation(sessionId: string): ConversationMessage[]
  abstract getProviderSessionId(sessionId: string): string | undefined
  abstract hasSession(sessionId: string): boolean

  // 清理
  abstract cleanup(): void
}
```

#### 统一事件类型

```typescript
type ProviderEventType =
  | 'text_delta'          // AI 文本流（增量）
  | 'thinking'            // 思考/推理内容
  | 'tool_use_start'      // 工具调用开始
  | 'tool_use_end'        // 工具调用结束
  | 'permission_request'  // 需要用户确认
  | 'ask_user_question'   // AskUserQuestion 工具
  | 'exit_plan_mode'      // ExitPlanMode 工具
  | 'turn_complete'       // 一轮对话结束
  | 'session_complete'    // 会话结束
  | 'error'               // 错误
```

#### Adapter 实现对比

| Adapter | 通信方式 | 会话恢复 | 特色功能 |
|---------|----------|----------|----------|
| `ClaudeSdkAdapter` | Agent SDK V2 | ✅ `--resume` | 结构化事件流、权限回调 |
| `CodexAppServerAdapter` | JSON-RPC (`codex serve`) | ✅ `resume` 子命令 | 自动接受模式 |
| `GeminiHeadlessAdapter` | NDJSON 流式 | ❌ | Node 版本切换 |
| `IFlowAcpAdapter` | ACP 协议 | ❌ | 自动接受 |
| `OpenCodeSdkAdapter` | HTTP API | ❌ | 配置文件注入 |

---

## 4. 会话管理与 Agent 编排

### 4.1 SessionManagerV2

**文件**：`src/main/session/SessionManagerV2.ts`

#### 核心职责

- 会话生命周期管理（创建/恢复/终止）
- Adapter 事件路由到 IPC/Database
- 消息缓冲与调度（解决启动慢导致的首条消息丢失）

#### 内部状态结构

```typescript
interface ManagedSession {
  id: string
  name: string
  workingDirectory: string
  status: SessionStatus
  config: SessionConfig
  provider: AIProvider
  nameLocked: boolean              // AI 自动重命名后锁定
  startedAt: string
  claudeSessionId?: string         // Provider 端会话 ID（用于恢复）
  totalUsage: { inputTokens: number; outputTokens: number }
  pendingMessages: string[]        // 启动期间暂存的消息
  scheduledMessages: ScheduledMessage[] // 运行中插入的消息队列
  _cleanup?: () => void            // 清理 adapter 事件监听器
}
```

#### 事件发射

| 事件名 | 参数 | 说明 |
|--------|------|------|
| `status-change` | (sessionId, status) | 会话状态变更 |
| `activity` | (sessionId, ActivityEvent) | 活动事件（工具调用、思考等） |
| `conversation-message` | (sessionId, ConversationMessage) | 对话消息 |
| `title-change` | (sessionId, name) | 会话名称变化 |
| `claude-session-id` | (sessionId, claudeId) | Provider 会话 ID 检测到 |
| `usage-update` | (sessionId, usage) | Token 用量更新 |
| `auto-rename` | (sessionId) | 触发 AI 自动重命名 |

#### 消息发送流程

```
sendMessage(sessionId, message)
  │
  ├── status === 'starting' ?
  │     └── 暂存到 pendingMessages（等待 ready 后 flush）
  │
  ├── status === 'running' ?
  │     ├── 解析策略：interrupt_now | queue_after_turn
  │     ├── 加入 scheduledMessages 队列
  │     └── 若 interrupt_now → adapter.abortCurrentTurn()
  │
  └── else (waiting_input / idle)
        ├── 检测 /slash 命令 → Skill 拦截
        └── adapter.sendMessage()
```

### 4.2 AgentManagerV2

**文件**：`src/main/agent/AgentManagerV2.ts`

#### 核心职责

- Agent 子会话的 spawn/send/wait/cancel
- MCP Bridge 请求处理（WebSocket 接收来自 AI 的工具调用）
- Git Worktree 生命周期管理

#### Agent 模式

| 模式 | oneShot | 行为 |
|------|---------|------|
| **一次性** | `true` | 第一轮 `turn_complete` 后自动完成并终止 |
| **持久多轮** | `false` | 保持活跃，可接收后续 `send_to_agent` |

#### 内部映射

```typescript
agents: Map<string, ManagedAgent>        // agentId → Agent 信息
childToAgent: Map<string, string>        // childSessionId → agentId
parentToAgents: Map<string, Set<string>> // parentSessionId → Set<agentId>
waiters: Map<string, Array<...>>         // agentId → 等待完成的 resolve
idleWaiters: Map<string, Array<...>>     // agentId → 等待空闲的 resolve
agentIdleFlags: Map<string, boolean>     // agentId → 空闲状态（解决竞态）
```

#### MCP Bridge 工具列表

| 工具名 | 功能 |
|--------|------|
| `spawn_agent` | 创建 Agent 子会话 |
| `send_to_agent` | 向持久 Agent 发送追加指令 |
| `wait_agent` | 等待 Agent 完成（oneShot 模式） |
| `wait_agent_idle` | 等待 Agent 空闲（turn_complete） |
| `get_agent_output` | 获取 Agent 输出 |
| `get_agent_status` | 获取 Agent 状态 |
| `list_agents` | 列出父会话的所有 Agent |
| `cancel_agent` | 取消 Agent |
| `enter_worktree` | 进入 Git Worktree 隔离 |
| `check_merge` | 检查 Worktree 合并状态 |
| `merge_worktree` | 合并 Worktree 分支 |
| `list_sessions` | 跨会话感知：列出所有会话 |
| `get_session_summary` | 获取会话摘要 |
| `search_sessions` | 搜索会话日志 |
| `install_skill` | 安装 Skill |
| `list_skills` | 列出 Skills |

### 4.3 AgentBridge（WebSocket 桥接）

**文件**：`src/main/agent/AgentBridge.ts`

#### 通信流程

```
AI CLI 进程
    │
    │  MCP 协议 (stdio)
    ▼
AgentMCPServer (独立进程)
    │
    │  WebSocket (端口 63721)
    ▼
AgentBridge (主进程)
    │
    │  EventEmitter
    ▼
AgentManagerV2.handleBridgeRequest()
    │
    │  执行操作
    ▼
respond(response) → AgentMCPServer → AI CLI
```

---

## 5. 数据存储层

### 5.1 DatabaseManager

**文件**：`src/main/storage/Database.ts`

#### 初始化流程

```typescript
constructor(dbPath: string) {
  try {
    // 尝试加载 better-sqlite3
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')    // 写前日志模式
    this.db.pragma('foreign_keys = ON')     // 启用外键约束
    this.initializeSchema()                  // 创建基础表
    this.migrateSchema()                     // 执行版本化迁移
    this.usingSqlite = true
  } catch (error) {
    // 降级到内存存储
    this.usingSqlite = false
  }
  // 初始化所有 Repository
  this.taskRepo = new TaskRepository(this.db, this.usingSqlite)
  this.sessionRepo = new SessionRepository(this.db, this.usingSqlite)
  // ... 其他 Repository
}
```

### 5.2 核心数据表

| 表名 | 说明 | 关键字段 |
|------|------|----------|
| `sessions` | 会话记录 | id, name, working_directory, status, config, claude_session_id |
| `activity_events` | 活动事件 | id, session_id, type, detail, timestamp |
| `conversation_messages` | 对话消息 | id, session_id, role, content, tool_name, timestamp |
| `tasks` | 看板任务 | id, title, status, priority, session_id |
| `agent_sessions` | Agent 子会话 | agent_id, parent_session_id, child_session_id, status |
| `agent_results` | Agent 结果 | agent_id, success, output, error |
| `providers` | AI Provider 配置 | id, name, command, adapter_type |
| `mcp_servers` | MCP 服务器配置 | id, name, transport, command, is_global_enabled |
| `skills` | Skill 技能配置 | id, name, slash_command, type, prompt_template |
| `workspaces` | 工作区 | id, name, repos (JSON) |
| `usage_stats` | Token 用量统计 | session_id, date, estimated_tokens |
| `session_logs` | 会话原始日志 | session_id, chunk, timestamp |
| `session_logs_fts` | FTS5 全文搜索索引 | session_id, chunk |

### 5.3 Repository 模式

**目录结构**：

```
src/main/storage/repositories/
├── AgentRepository.ts        # Agent 会话与结果
├── ConversationRepository.ts # 对话消息
├── DirectoryRepository.ts    # 收藏目录
├── LogRepository.ts          # 会话日志
├── McpRepository.ts          # MCP 服务器
├── ProviderRepository.ts     # AI Provider
├── SessionRepository.ts      # 会话
├── SettingsRepository.ts     # 应用设置
├── SkillRepository.ts        # Skill 技能
├── TaskRepository.ts         # 看板任务
├── UsageRepository.ts        # 用量统计
└── WorkspaceRepository.ts    # 工作区
```

### 5.4 数据库迁移

**文件**：`src/main/storage/migrations.ts`

```typescript
export const MIGRATIONS: MigrationDefinition[] = [
  {
    version: 1,
    name: 'add_provider_fields',
    up: (db) => {
      db.exec(`ALTER TABLE providers ADD COLUMN adapter_type TEXT`)
    }
  },
  // ... 后续版本
]
```

### 5.5 FTS5 全文搜索

```sql
CREATE VIRTUAL TABLE session_logs_fts USING fts5(
  session_id UNINDEXED,
  chunk,
  content='session_logs',
  content_rowid='id'
);
```

---

## 6. 渲染进程架构

### 6.1 React 组件结构

```
src/renderer/
├── App.tsx                      # 根组件
├── components/
│   ├── layout/                  # 三栏分栏布局
│   ├── conversation/            # 结构化对话视图
│   │   ├── ConversationView.tsx
│   │   ├── MessageBubble.tsx
│   │   ├── ToolUseCard.tsx
│   │   ├── MessageInput.tsx
│   │   ├── AskUserQuestionPanel.tsx
│   │   └── PlanApprovalPanel.tsx
│   ├── file-manager/            # 文件资源管理器
│   ├── session/                 # 会话管理
│   ├── agent/                   # Agent 子任务追踪
│   ├── kanban/                  # 看板组件
│   ├── settings/                # 设置面板
│   ├── dashboard/               # 数据可视化仪表盘
│   └── common/                  # 通用组件
```

### 6.2 Zustand 状态管理

| Store | 文件 | 职责 |
|-------|------|------|
| `sessionStore` | sessionStore.ts | 会话列表、活动事件、对话消息、Agent 状态 |
| `settingsStore` | settingsStore.ts | 全局设置、主题、代理配置 |
| `taskStore` | taskStore.ts | 看板任务 CRUD |
| `teamStore` | teamStore.ts | Agent Teams 团队、角色、任务、消息 |

#### sessionStore 核心状态

```typescript
interface SessionState {
  sessions: Session[]
  selectedSessionId: string | null
  activities: Record<string, ActivityEvent[]>
  conversations: Record<string, ConversationMessage[]>
  streamingSessions: Set<string>
  agents: Record<string, AgentInfo[]>
  // ... 30+ 方法
}
```

### 6.3 IPC 客户端

```typescript
window.spectrAI = {
  session: {
    getAll, create, resume, terminate,
    sendMessage, confirm,
    onStatusChange, onActivity, onConversationMessage,
  },
  agent: { list, onCreated, onStatusChange, onCompleted },
  task: { /* ... */ },
  provider: { /* ... */ },
  git: { /* ... */ },
  file: { /* ... */ },
  mcp: { /* ... */ },
  skill: { /* ... */ },
  settings: { /* ... */ },
}
```

---

## 7. 核心功能模块详解

### 7.1 多会话管理

#### 会话状态流转

```
starting → running → waiting_input → idle
    │          │           │
    │          ↓           ↓
    │      error       completed
    │                      ↑
    └──────────────────────┘
           (terminated)
```

### 7.2 结构化对话视图

| Provider 事件 | ConversationMessage |
|---------------|---------------------|
| `text_delta` | `{ role: 'assistant', isDelta: true }` |
| `thinking` | `{ role: 'assistant', thinkingText: '...' }` |
| `tool_use_start` | `{ role: 'tool_use', toolName, toolInput }` |
| `tool_use_end` | `{ role: 'tool_result', toolResult, isError }` |

### 7.3 文件改动追踪

**文件**：`src/main/tracker/FileChangeTracker.ts`

```
FS Watch (300ms debounce)
    │
    ├─ 多会话归因：按 workingDirectory 深度 + 最近活动时间
    │
    ├─ 竞态检测：同一文件被多个会话同时改动 → 标记警告
    │
    └─ DB 持久化：file_changes 表
```

### 7.4 Agent 编排（Supervisor 模式）

**Supervisor Prompt 注入**：

```typescript
`You are running in Supervisor mode within SpectrAI session ${config.id}.
You have access to MCP tools for spawning and managing sub-agents.
Use these tools to delegate complex tasks to specialized agents.`
```

### 7.5 Git Worktree 隔离

**文件**：`src/main/git/GitWorktreeService.ts`

| 方法 | 功能 |
|------|------|
| `createWorktree(repoPath, branchName, taskId)` | 创建独立工作树 |
| `verifyWorktree(worktreePath)` | 验证 worktree 是否存在 |
| `checkMerge(repoPath, worktreePath)` | 检查合并状态 |
| `mergeToMain(repoPath, branchName, options)` | 合并分支到主分支 |
| `removeWorktree(repoPath, worktreePath, options)` | 清理 worktree |

### 7.6 Skill 技能系统

| type | 说明 | 执行方式 |
|------|------|----------|
| `prompt` | Prompt 模板 | 拦截 `/slash` 命令，展开模板后发送给 Provider |
| `native` | 原生技能 | 透传给 Provider 自行处理 |

---

## 8. 数据结构与类型定义

### 8.1 核心类型

**文件**：`src/shared/types.ts`

#### AIProvider

```typescript
interface AIProvider {
  id: string                // 'claude-code' | uuid
  name: string              // "Claude Code", "Codex CLI"
  command: string           // "claude", "codex"
  isBuiltin: boolean        // 内置不可删除
  adapterType?: AdapterType // SDK V2 适配器类型
  autoAcceptArg?: string    // 跳过确认的参数
  resumeArg?: string        // 恢复参数
  nodeVersion?: string      // 指定 Node.js 版本
}
```

#### SessionConfig

```typescript
interface SessionConfig {
  id: string
  name: string
  workingDirectory: string
  providerId?: string       // 使用的 Provider ID
  initialPrompt?: string    // 初始 prompt
  autoAccept?: boolean      // 自动接受权限请求
  supervisorMode?: boolean  // Supervisor 模式
  parentSessionId?: string  // 父会话 ID（Agent 子会话）
}
```

#### ConversationMessage

```typescript
interface ConversationMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result'
  content: string
  timestamp: string
  attachments?: ConversationAttachment[]
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResult?: string
  isDelta?: boolean         // 增量消息标记
}
```

#### ActivityEvent

```typescript
interface ActivityEvent {
  id: string
  sessionId: string
  timestamp: string
  type: ActivityEventType   // 'tool_use' | 'thinking' | 'file_write' | ...
  detail: string
  metadata?: Record<string, unknown>
}
```

---

## 9. 关键代码路径示例

### 9.1 创建会话完整流程

```
用户点击"新建会话"
    │
    ▼
NewSessionModal (Renderer)
    │  填写配置：name, workingDirectory, providerId, initialPrompt
    │
    ▼
window.spectrAI.session.create(config)
    │  IPC: 'session:create'
    │
    ▼
sessionHandlers.ts (Main)
    │  concurrencyGuard.acquire()
    │  sessionManagerV2.createSession(config, provider)
    │
    ▼
SessionManagerV2.createSession()
    │  创建 ManagedSession 内部状态
    │  adapterRegistry.get(provider.id) → ClaudeSdkAdapter
    │  adapter.startSession(sessionId, adapterConfig)
    │
    ▼
ClaudeSdkAdapter.startSession()
    │  sdk.query({ prompt: inputStream, options })
    │  启动 consumeStream() 异步循环
    │
    ▼
consumeStream() → for await (msg of sdkQuery)
    │  msg.type === 'system' → emit('session-init-data')
    │  msg.type === 'assistant' → emit('conversation-message')
    │  msg.type === 'result' → emit('turn_complete')
    │
    ▼
SessionManagerV2.handleProviderEvent()
    │  转换为 ActivityEvent / ConversationMessage
    │  emit('activity') / emit('conversation-message')
    │
    ▼
wireSessionManagerV2Events() (Main)
    │  转发到 sendToRenderer()
    │  database.addActivityEvent() / insertConversationMessage()
    │
    ▼
sessionStore (Renderer)
    │  addActivity() / addConversationMessage()
    │  React 组件重新渲染
```

### 9.2 Agent spawn 与通信流程

```
AI 调用 spawn_agent MCP 工具
    │
    ▼
AgentMCPServer (子进程)
    │  解析 MCP 请求
    │  WebSocket → AgentBridge
    │
    ▼
AgentBridge.emit('request', { method: 'spawn_agent', params })
    │
    ▼
AgentManagerV2.handleBridgeRequest()
    │  spawnAgent(parentSessionId, config)
    │
    ▼
spawnAgent()
    │  生成 agentId, childSessionId
    │  MCPConfigGenerator.generate() → mcpConfigPath
    │  sessionManagerV2.createSessionWithId(childSessionId, config)
    │  database.createAgentSession()
    │
    ▼
SessionManagerV2.createSessionWithId()
    │  创建子会话
    │  adapter.startSession()
    │
    ▼
respond({ agentId, childSessionId }) → AI CLI
```

---

## 10. 开发指南

### 10.1 环境搭建

```bash
# 1. 安装依赖
npm install

# 2. 重建原生模块（better-sqlite3）
npm run rebuild

# 3. 启动开发模式
npm run dev
```

### 10.2 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发模式（热重载） |
| `npm run build` | 构建生产版本 |
| `npm run dist` | 打包 Windows 安装程序 |
| `npm run rebuild` | 重建原生模块 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run lint` | ESLint 代码检查 |

### 10.3 扩展新 Provider

1. 在 `src/main/adapter/` 创建新的 Adapter 类，继承 `BaseProviderAdapter`
2. 实现所有抽象方法（startSession, sendMessage 等）
3. 在 `src/main/index.ts` 的 `initializeManagers()` 中注册到 `AdapterRegistry`
4. 在 `src/shared/types.ts` 的 `BUILTIN_PROVIDERS` 中添加 Provider 定义

### 10.4 调试技巧

- **主进程调试**：在 VS Code 中使用 "Attach to Process" 附加到 Electron 进程
- **渲染进程调试**：使用 DevTools（`Ctrl+Shift+I`）
- **日志查看**：主进程日志通过 `electron-log` 输出到控制台和文件

---

## 附录

### A. 项目文件统计

| 目录 | 文件数 | 说明 |
|------|--------|------|
| `src/main/` | ~80 | 主进程代码 |
| `src/renderer/` | ~60 | 渲染进程代码 |
| `src/shared/` | ~5 | 共享类型定义 |
| `src/preload/` | ~2 | Preload 脚本 |

### B. 依赖版本

| 依赖 | 版本 |
|------|------|
| Electron | 28.3.3 |
| React | 18.3.1 |
| TypeScript | 5.7.2 |
| better-sqlite3 | 11.7.0 |
| @anthropic-ai/claude-agent-sdk | 0.2.62 |

---

*本文档由 Claude 生成，基于 SpectrAI v0.4.6 源代码分析。*