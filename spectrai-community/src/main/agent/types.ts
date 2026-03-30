/**
 * Agent 编排相关类型定义
 * @author weibin
 */

/** MCP 工具分级模式 */
export type McpSessionMode = 'supervisor' | 'member' | 'awareness'

/** Agent 创建配置 */
export interface AgentConfig {
  name: string
  prompt: string
  workDir?: string          // 不传则继承父会话
  autoAccept?: boolean
  providerId?: string       // 指定 AI Provider（不传则默认 claude-code）
  oneShot?: boolean         // true: 任务完成后自动终止会话（默认 true）
  sessionMode?: McpSessionMode  // MCP 工具分级模式（默认 awareness，team 成员传 member）
}

/** Agent 信息 */
export interface AgentInfo {
  agentId: string
  name: string
  parentSessionId: string
  childSessionId: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  prompt: string
  workDir: string
  createdAt: string
  completedAt?: string
  result?: AgentResult
  providerId?: string       // 指定 AI Provider（不传则默认 claude-code）
}

/** Agent 执行结果 */
export interface AgentResult {
  success: boolean
  exitCode: number
  output?: string           // 最后 N 行清洗后的输出
  error?: string
  failedProvider?: string   // 失败时记录使用的 provider ID，方便切换重试
  artifacts?: string[]      // 创建/修改的文件列表
}

/** AgentBridge WebSocket 消息 */
export interface BridgeRequest {
  id: string
  sessionId: string
  method: string
  params: Record<string, any>
}

export interface BridgeResponse {
  id: string
  result?: any
  error?: string
}
