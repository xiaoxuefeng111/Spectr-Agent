/**
 * AgentBridge - WebSocket 服务端，运行在 Electron 主进程
 * MCP Server (stdio 子进程) 通过 WS 连接此桥接器，转发请求到 AgentManager
 * @author weibin
 */

import { EventEmitter } from 'events'
import { WebSocketServer, WebSocket } from 'ws'
import type { BridgeRequest, BridgeResponse } from './types'

export class AgentBridge extends EventEmitter {
  private wss: WebSocketServer | null = null
  private connections: Map<string, WebSocket> = new Map() // sessionId → ws
  private port: number = 0

  /**
   * 启动 WebSocket 服务
   */
  start(port: number): void {
    this.port = port
    this.wss = new WebSocketServer({ host: '127.0.0.1', port })

    this.wss.on('connection', (ws: WebSocket) => {
      let registeredSessionId: string | null = null

      ws.on('message', (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(raw.toString())

          // 注册消息：MCP Server 连接后先注册 sessionId
          if (msg.type === 'register') {
            registeredSessionId = msg.sessionId
            this.connections.set(msg.sessionId, ws)
            console.log(`[AgentBridge] MCP Server registered for session: ${msg.sessionId}`)
            ws.send(JSON.stringify({ type: 'registered', sessionId: msg.sessionId }))
            return
          }

          // 文件变更事件：MCP Server 本地执行文件操作后通知
          if (msg.type === 'file-change') {
            this.emit('file-change', {
              sessionId: registeredSessionId || msg.sessionId,
              data: msg.data,
            })
            return
          }

          // 请求消息：转发到 AgentManager 处理
          if (msg.type === 'request') {
            const request: BridgeRequest = {
              id: msg.id,
              sessionId: registeredSessionId || msg.sessionId,
              method: msg.method,
              params: msg.params || {}
            }
            this.emit('request', request, (response: BridgeResponse) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'response', ...response }))
              }
            })
          }
        } catch (err) {
          console.error('[AgentBridge] Failed to parse message:', err)
        }
      })

      ws.on('close', () => {
        if (registeredSessionId) {
          this.connections.delete(registeredSessionId)
          console.log(`[AgentBridge] MCP Server disconnected: ${registeredSessionId}`)
        }
      })

      ws.on('error', (err) => {
        console.error('[AgentBridge] WebSocket error:', err)
      })
    })

    this.wss.on('error', (err) => {
      console.error(`[AgentBridge] Server error on port ${port}:`, err)
    })

    console.log(`[AgentBridge] WebSocket server started on 127.0.0.1:${port}`)
  }

  /**
   * 获取当前端口
   */
  getPort(): number {
    return this.port
  }

  /**
   * 关闭服务
   */
  close(): void {
    if (this.wss) {
      // 关闭所有连接
      for (const ws of this.connections.values()) {
        try { ws.close() } catch (_) { /* ignore */ }
      }
      this.connections.clear()
      this.wss.close()
      this.wss = null
      console.log('[AgentBridge] Server closed')
    }
  }
}
