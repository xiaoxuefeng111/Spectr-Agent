/**
 * IPC 共享工具 - 被多个 handler 文件引用的公共函数和状态
 *
 * ★ 此模块独立于 index.ts，避免 handler → index → handler 循环依赖
 */

import { BrowserWindow } from 'electron'
import type { DatabaseManager } from '../storage/Database'

/**
 * 向所有渲染进程窗口发送消息
 */
export function sendToRenderer(channel: string, ...args: any[]): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }
}

/** 正在执行 AI 重命名的 session ID 集合，防止并发重复调用 */
export const aiRenamingLocks = new Set<string>()

/**
 * AI 重命名核心逻辑：从会话内容/摘要/对话记录中提取上下文，调用 LLM 生成简短中文名称
 */
export async function performAiRename(
  database: DatabaseManager,
  sessionId: string,
): Promise<{ success: boolean; name?: string; error?: string }> {
  const summaries = database.getSessionSummaries(sessionId, 10)
  let contextText = ''

  if (summaries.length > 0) {
    contextText = summaries.reverse().map((s: any) => s.content).join('\n').slice(0, 2000)
  } else {
    const activities = database.getSessionActivities(sessionId, 100)
    const userInputs = activities
      .filter((a: any) => a.type === 'user_input')
      .map((a: any) => a.detail)
      .filter(Boolean)
    const aiMessages = activities
      .filter((a: any) => a.type === 'assistant_message' || a.type === 'thinking')
      .map((a: any) => a.detail)
      .filter(Boolean)

    if (userInputs.length > 0) contextText += 'User input:\n' + userInputs.slice(0, 5).join('\n')
    if (aiMessages.length > 0) contextText += '\nAI response:\n' + aiMessages.slice(0, 5).join('\n')
    contextText = contextText.slice(0, 2000)
  }

  if (!contextText.trim()) {
    const messages = database.getConversationMessages(sessionId, 20)
    const userMsgs = messages
      .filter((m: any) => m.role === 'user' && m.content)
      .map((m: any) => String(m.content))
      .slice(0, 3)
    const aiMsgs = messages
      .filter((m: any) => m.role === 'assistant' && m.content)
      .map((m: any) => String(m.content))
      .slice(0, 3)

    if (userMsgs.length > 0) contextText += 'User input:\n' + userMsgs.join('\n')
    if (aiMsgs.length > 0) contextText += '\nAI response:\n' + aiMsgs.join('\n')
    contextText = contextText.slice(0, 2000)
  }

  if (!contextText.trim()) {
    return { success: false, error: 'Session content is empty, cannot generate name.' }
  }

  // LLMService has been removed (Pro feature). AI rename is not available in community edition.
  return { success: false, error: 'AI rename is not available in community edition.' }
}
