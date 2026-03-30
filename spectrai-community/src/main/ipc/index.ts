/**
 * IPC 通信模块 - 注册所有 IPC handler 并导出公共工具
 * @author weibin
 */

import type { DatabaseManager } from '../storage/Database'
import type { ConcurrencyGuard } from '../session/ConcurrencyGuard'
import type { NotificationManager } from '../notification/NotificationManager'
import type { TrayManager } from '../tray/TrayManager'
import type { SessionManager } from '../session/SessionManager'
import type { OutputParser } from '../parser/OutputParser'
import type { StateInference } from '../parser/StateInference'
import type { AgentManager } from '../agent/AgentManager'
import type { OutputReaderManager } from '../reader/OutputReaderManager'
import type { TaskSessionCoordinator } from '../task/TaskSessionCoordinator'
import type { AgentManagerV2 } from '../agent/AgentManagerV2'
import type { SessionManagerV2 } from '../session/SessionManagerV2'
import type { UpdateManager } from '../update/UpdateManager'
// ★ 公共工具从 shared.ts 导出，避免 handler → index → handler 循环依赖
export { sendToRenderer, aiRenamingLocks, performAiRename } from './shared'

/**
 * Manager 依赖注入接口
 * 注：SDK V2 架构下 PTY 相关 manager（outputParser / stateInference /
 *   outputReaderManager / agentManager / sessionManager）为可选
 */
export interface IpcDependencies {
  sessionManager: SessionManager
  sessionManagerV2?: SessionManagerV2
  database: DatabaseManager
  outputParser: OutputParser
  concurrencyGuard: ConcurrencyGuard
  stateInference?: StateInference
  notificationManager: NotificationManager
  trayManager: TrayManager
  agentManager?: AgentManager
  agentManagerV2?: AgentManagerV2
  outputReaderManager?: OutputReaderManager
  agentBridgePort?: number
  taskCoordinator?: TaskSessionCoordinator
  updateManager?: UpdateManager
}

// 各子模块 handler 注册函数
import { registerSessionHandlers } from './sessionHandlers'
import { registerTaskHandlers } from './taskHandlers'
import { registerAgentHandlers } from './agentHandlers'
import { registerProviderHandlers } from './providerHandlers'
import { registerGitHandlers } from './gitHandlers'
import { registerSystemHandlers } from './systemHandlers'
import { registerWorkspaceHandlers } from './workspaceHandlers'
import { registerFileManagerHandlers } from './fileManagerHandlers'
import { registerMcpHandlers } from './mcpHandlers'
import { registerSkillHandlers } from './skillHandlers'
import { registerRegistryHandlers } from './registryHandlers'
import { registerUpdateHandlers } from './updateHandlers'
import type { FileChangeTracker } from '../tracker/FileChangeTracker'

// re-export wireSessionManagerV2Events from systemHandlers
export { wireSessionManagerV2Events } from './systemHandlers'

/**
 * Register all IPC handlers
 * @param deps manager dependencies
 * @param fileChangeTracker optional file change tracker
 */
export function registerIpcHandlers(deps: IpcDependencies, fileChangeTracker?: FileChangeTracker): void {
  registerSessionHandlers(deps)
  registerTaskHandlers(deps)
  registerAgentHandlers(deps)
  registerProviderHandlers(deps)
  registerGitHandlers(deps, fileChangeTracker)
  registerSystemHandlers(deps)
  registerWorkspaceHandlers(deps)
  registerFileManagerHandlers(deps, fileChangeTracker)
  registerMcpHandlers(deps)
  registerSkillHandlers(deps)
  registerRegistryHandlers(deps)
  if (deps.updateManager) {
    registerUpdateHandlers(deps.updateManager)
  }
}
