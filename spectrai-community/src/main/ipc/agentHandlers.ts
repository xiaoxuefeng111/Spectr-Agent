/**
 * Agent IPC 处理器 - Agent 管理及会话结束清理
 * ★ 架构说明：仅使用 SDK V2（AgentManagerV2 + SessionManagerV2）
 *   V1 agentManager 事件监听已移除
 */
import { ipcMain } from 'electron'
import { MCPConfigGenerator } from '../agent/MCPConfigGenerator'
import {
  cleanupSupervisorPrompt,
  cleanupSupervisorPromptFromAgentsMd,
  cleanupSupervisorPromptFromGeminiMd,
  cleanupWorktreeRule,
  cleanupFileOpsRule,
  cleanupFileOpsRuleFromAgentsMd,
  cleanupFileOpsRuleFromGeminiMd,
  cleanupWorkspaceSectionFromAgentsMd,
  cleanupWorkspaceSectionFromGeminiMd,
} from '../agent/supervisorPrompt'
import type { IpcDependencies } from './index'
import { sendToRenderer } from './shared'
import { IPC } from '../../shared/constants'

export function registerAgentHandlers(deps: IpcDependencies): void {
  const { sessionManagerV2, agentManagerV2 } = deps

  // ==================== Agent 相关 ====================

  ipcMain.handle('agent:list', async (_event, parentSessionId?: string) => {
    try {
      return agentManagerV2 ? agentManagerV2.listAgents(parentSessionId) : []
    } catch (error) {
      console.error('[IPC] agent:list error:', error)
      return []
    }
  })

  ipcMain.handle('agent:cancel', async (_event, agentId: string) => {
    try {
      if (!agentManagerV2) return { success: false, error: 'AgentManagerV2 未初始化' }
      const success = agentManagerV2.cancelAgent(agentId)
      return { success }
    } catch (error: any) {
      console.error('[IPC] agent:cancel error:', error)
      return { success: false, error: error.message }
    }
  })

  // V2 Agent 事件转发到渲染进程
  if (agentManagerV2) {
    agentManagerV2.on('agent:created', (agentInfo: any) => {
      sendToRenderer('agent:created', agentInfo)
    })

    agentManagerV2.on('agent:status-change', (agentId: string, status: string) => {
      sendToRenderer('agent:status-change', agentId, status)
    })

    agentManagerV2.on('agent:completed', (agentId: string, result: any) => {
      sendToRenderer('agent:completed', agentId, result)
    })

    // 通知渲染进程：有新 Skill 通过 MCP install_skill 安装，需要刷新列表
    agentManagerV2.on('skill-installed', (skill: any) => {
      sendToRenderer(IPC.SKILL_INSTALLED_NOTIFY, skill)
    })
  }

  // ==================== V2 会话结束清理 ====================
  // （auto-rename 和状态更新已在 systemHandlers.ts 的 V2 listener 中处理）

  if (sessionManagerV2) {
    sessionManagerV2.on('status-change', (sessionId: string, status: string) => {
      if (status === 'completed' || status === 'error' || status === 'terminated') {
        MCPConfigGenerator.cleanup(sessionId)
        const session = sessionManagerV2.getSession(sessionId)
        if (session?.workingDirectory) {
          const workDir = session.workingDirectory
          const providerId = session.config?.providerId
          // 检查同工作目录下是否还有其他同 provider 的活跃会话
          const hasOtherActive = sessionManagerV2.getAllSessions().some(s =>
            s.id !== sessionId &&
            s.workingDirectory === workDir &&
            s.status !== 'completed' && s.status !== 'error' && s.status !== 'terminated' &&
            s.config?.providerId === providerId
          )
          if (!hasOtherActive) {
            if (providerId === 'claude-code') {
              cleanupSupervisorPrompt(workDir)
              cleanupWorktreeRule(workDir)
              cleanupFileOpsRule(workDir)
              // .claude/rules/ 下的 workspace section 会随 cleanupSupervisorPrompt 一起清理
            } else if (providerId === 'codex') {
              cleanupSupervisorPromptFromAgentsMd(workDir)
              cleanupFileOpsRuleFromAgentsMd(workDir)
              cleanupWorkspaceSectionFromAgentsMd(workDir)
            } else if (providerId === 'gemini-cli') {
              cleanupSupervisorPromptFromGeminiMd(workDir)
              cleanupFileOpsRuleFromGeminiMd(workDir)
              cleanupWorkspaceSectionFromGeminiMd(workDir)
            }
          }
        }
      }
    })
  }
}
