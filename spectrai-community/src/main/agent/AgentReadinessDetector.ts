/**
 * AgentReadinessDetector - Agent 就绪检测器 v5
 *
 * ★ v5 改进：交互式模式关闭 Fast Path，只用 Quiescence + 结构化信号
 *
 * 检测逻辑：
 *   1. Fast Path（事件驱动）：onScreenUpdate 检测到 prompt marker → 立即 resolve
 *      ★ 仅用于 CLI 启动检测 和 oneShot 模式。交互式模式关闭（太多误判）。
 *   2. Slow Path（轮询兜底）：屏幕内容持续不变超过阈值 → quiescence resolve
 *      ★ 交互式模式的主要检测方式。通用，不依赖任何 CLI 特定格式。
 *   3. 结构化信号：notifyTaskComplete() — 来自 JSONL 等解析器的确定性信号
 *      ★ Claude Code 专属加速。有就用，没有也不依赖。
 *
 * @author weibin
 */

import {
  chunkContainsPromptMarker,
  looksLikeQuestion,
  looksLikeThinking
} from './ansiUtils'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const AUTOSEND_MIN_WAIT_MS = 500          // 启动后最小等待时间
const DEFAULT_MAX_WAIT_MS = 180000        // 默认超时 3 分钟
const QUIESCENCE_POLL_MS = 500            // quiescence 轮询间隔
const DEFAULT_QUIESCENCE_THRESHOLD_MS = 3000 // 默认输出稳定阈值
const FAST_PATH_FALLBACK_MS = 500         // Fast Path 兜底：首次检测到 prompt 后无后续写入时的超时

/** Detector 配置 */
export interface DetectorConfig {
  /** Provider 特定的 prompt marker 正则，留空使用默认 */
  promptMarkers?: RegExp[]
  /** 就绪超时（毫秒），留空使用默认 180s */
  maxWaitMs?: number
  /** 输出稳定时间阈值（毫秒），留空使用默认 3s */
  quiescenceThresholdMs?: number
  /**
   * reset 后的冷却期（毫秒），在此期间不触发就绪检测。
   * 用于防止 prompt 回显被误判为 AI 回答完毕。
   * 默认 2000ms，首次 waitReady（CLI 启动检测）不受此限制。
   */
  postResetCooldownMs?: number
}

export class AgentReadinessDetector {
  private agentId: string
  private spawnedAt: number

  // 配置
  private promptMarkers?: RegExp[]
  private maxWaitMs: number
  private quiescenceThresholdMs: number
  private postResetCooldownMs: number

  // ★ v5: Fast Path 开关（交互式模式关闭）
  private _fastPathDisabled = false

  // 就绪 Promise 控制
  private readyResolve: ((ready: boolean) => void) | null = null
  private readyPromise: Promise<boolean> | null = null

  // ★ v4 Fast Path 状态：事件驱动的连续确认
  private promptDetected = false
  private fastPathFallbackTimer: NodeJS.Timeout | null = null

  // Slow path (quiescence) 状态
  private quiescenceTimer: NodeJS.Timeout | null = null
  private lastScreenSnapshot = ''
  private stableSince = 0

  // ★ 最新的屏幕内容（由 onScreenUpdate 更新）
  private currentScreenText = ''
  /** 累计原始字节数（用于检测输出是否增长） */
  private _lastTotalAppended = 0

  // 超时
  private timeoutTimer: NodeJS.Timeout | null = null

  private destroyed = false
  private isResetting = false

  // reset 后需要先看到输出变化才允许 quiescence 判定就绪
  private outputSeenSinceReset = true  // 初始 true，首次 waitReady 不受限
  private resetAt = 0
  private isFirstWait = true

  constructor(agentId: string, config?: DetectorConfig) {
    this.agentId = agentId
    this.spawnedAt = Date.now()
    this.promptMarkers = config?.promptMarkers
    this.maxWaitMs = config?.maxWaitMs || DEFAULT_MAX_WAIT_MS
    this.quiescenceThresholdMs = config?.quiescenceThresholdMs || DEFAULT_QUIESCENCE_THRESHOLD_MS
    this.postResetCooldownMs = config?.postResetCooldownMs ?? 2000
  }

  /**
   * ★ v5: 关闭 Fast Path（prompt marker 检测）
   * 交互式模式下调用，只保留 quiescence + 结构化信号。
   * 此设置跨 reset 持久有效。
   */
  set fastPathDisabled(value: boolean) {
    this._fastPathDisabled = value
    if (value) {
      // 清理 fast path 状态
      this.promptDetected = false
      if (this.fastPathFallbackTimer) {
        clearTimeout(this.fastPathFallbackTimer)
        this.fastPathFallbackTimer = null
      }
    }
  }

  get fastPathDisabled(): boolean {
    return this._fastPathDisabled
  }

  /**
   * ★ v4 核心：接收虚拟终端的屏幕更新通知（事件驱动）
   *
   * ★ v5: 当 fastPathDisabled=true 时，跳过 prompt marker 检测，
   * 只更新屏幕快照（供 quiescence 使用）。
   */
  onScreenUpdate(lastLines: string[], totalAppended: number): void {
    if (this.destroyed || !this.readyResolve || this.isResetting) return

    // 更新屏幕快照
    this.currentScreenText = lastLines.join('\n')
    this._lastTotalAppended = totalAppended

    // ★ v5: Fast Path 关闭时，不做 prompt marker 检测
    if (this._fastPathDisabled) return

    // Post-reset 冷却期：reset 后一段时间内不触发检测
    if (!this.isFirstWait && this.resetAt > 0) {
      const sinceReset = Date.now() - this.resetAt
      if (sinceReset < this.postResetCooldownMs) return
    }

    // 必须看到过输出（AI 开始响应）才检测
    if (!this.outputSeenSinceReset) return

    // ★ 在准确的屏幕文本上检测 prompt marker
    if (chunkContainsPromptMarker(this.currentScreenText, this.promptMarkers)) {
      // question 阻塞（Y/n 等）不触发 ready
      if (looksLikeQuestion(this.currentScreenText)) {
        this.promptDetected = false
        return
      }

      // AI 正在 thinking 时不触发
      if (looksLikeThinking(this.currentScreenText)) {
        this.promptDetected = false
        return
      }

      if (this.promptDetected) {
        // ★ 连续第二次确认 prompt marker → 立即 resolve！
        if (this.fastPathFallbackTimer) {
          clearTimeout(this.fastPathFallbackTimer)
          this.fastPathFallbackTimer = null
        }
        console.log(`[ReadinessDetector] Agent ${this.agentId} ready via fast path (consecutive prompt confirmation)`)
        this.resolveReady(true)
      } else {
        // 第一次检测到 prompt marker → 标记并启动兜底定时器
        this.promptDetected = true
        this.scheduleFastPathFallback()
      }
    } else {
      // Prompt marker 消失 → 重置（可能是中间态重绘）
      this.promptDetected = false
      if (this.fastPathFallbackTimer) {
        clearTimeout(this.fastPathFallbackTimer)
        this.fastPathFallbackTimer = null
      }
    }
  }

  /**
   * ★ v4: Fast Path 兜底定时器
   */
  private scheduleFastPathFallback(): void {
    if (this.fastPathFallbackTimer) {
      clearTimeout(this.fastPathFallbackTimer)
    }
    this.fastPathFallbackTimer = setTimeout(() => {
      this.fastPathFallbackTimer = null
      if (this.destroyed || !this.readyResolve) return

      if (this.promptDetected &&
          chunkContainsPromptMarker(this.currentScreenText, this.promptMarkers) &&
          !looksLikeThinking(this.currentScreenText) &&
          !looksLikeQuestion(this.currentScreenText)) {
        console.log(`[ReadinessDetector] Agent ${this.agentId} ready via fast path fallback (${FAST_PATH_FALLBACK_MS}ms)`)
        this.resolveReady(true)
      } else {
        this.promptDetected = false
      }
    }, FAST_PATH_FALLBACK_MS)
  }

  /**
   * 兼容旧接口：接收 PTY 原始输出
   * 仅用于标记有新输出（outputSeenSinceReset）。
   */
  onOutput(_data: string): void {
    if (!this.outputSeenSinceReset) {
      this.outputSeenSinceReset = true
    }
  }

  /**
   * ★ 结构化完成通知 — 来自 JSONL 等解析器的确定性信号
   * 零延迟 resolve，不受 fastPathDisabled 影响。
   */
  notifyTaskComplete(): void {
    if (this.destroyed || !this.readyResolve || this.isResetting) return

    // 必须过了冷却期
    if (!this.isFirstWait && this.resetAt > 0) {
      const sinceReset = Date.now() - this.resetAt
      if (sinceReset < this.postResetCooldownMs) return
    }

    console.log(`[ReadinessDetector] Agent ${this.agentId} ready via structured signal (task_complete)`)
    this.resolveReady(true)
  }

  /**
   * 等待 Agent 就绪
   */
  waitReady(): Promise<boolean> {
    if (this.readyPromise) return this.readyPromise

    this.readyPromise = new Promise<boolean>((resolve) => {
      this.readyResolve = resolve
    })

    // 超时
    this.timeoutTimer = setTimeout(() => {
      if (this.readyResolve) {
        console.warn(`[ReadinessDetector] Agent ${this.agentId} timed out after ${this.maxWaitMs}ms`)
        this.resolveReady(false)
      }
    }, this.maxWaitMs)

    // 启动 quiescence 轮询（Slow Path）
    this.startQuiescencePolling()

    return this.readyPromise
  }

  /**
   * Slow Path — Quiescence 轮询
   * 屏幕内容持续不变超过阈值 → 就绪
   * ★ v5: 交互式模式的主要检测方式（fast path 关闭时唯一的屏幕检测路径）
   */
  private startQuiescencePolling(): void {
    this.lastScreenSnapshot = this.currentScreenText
    this.stableSince = Date.now()

    this.quiescenceTimer = setInterval(() => {
      if (this.destroyed || !this.readyResolve) {
        if (this.quiescenceTimer) {
          clearInterval(this.quiescenceTimer)
          this.quiescenceTimer = null
        }
        return
      }

      const elapsed = Date.now() - this.spawnedAt
      if (elapsed < AUTOSEND_MIN_WAIT_MS) return

      // Post-reset 冷却期
      if (!this.isFirstWait && this.resetAt > 0) {
        const sinceReset = Date.now() - this.resetAt
        if (sinceReset < this.postResetCooldownMs) return
      }

      // ★ v5: 只有 fast path 开启时才让 fast path 接管
      if (!this._fastPathDisabled) {
        // fast path 已检测到 prompt marker，让 fast path 处理
        if (this.promptDetected) return

        const screen = this.currentScreenText

        // 如果屏幕上出现了 prompt marker，交给 fast path 处理
        if (chunkContainsPromptMarker(screen, this.promptMarkers)) {
          if (!looksLikeQuestion(screen) && !looksLikeThinking(screen)) {
            if (this.outputSeenSinceReset) {
              this.promptDetected = true
              this.scheduleFastPathFallback()
            }
          }
          return
        }
      }

      const screen = this.currentScreenText

      // ★ 直接比较屏幕文本
      if (screen === this.lastScreenSnapshot) {
        // 屏幕没变 → 检查是否满足稳定时间
        if (!this.outputSeenSinceReset) return

        if (looksLikeThinking(screen)) {
          this.stableSince = Date.now()
          return
        }

        const stableDuration = Date.now() - this.stableSince
        if (stableDuration >= this.quiescenceThresholdMs) {
          console.log(`[ReadinessDetector] Agent ${this.agentId} ready via quiescence (stable ${stableDuration}ms)`)
          this.resolveReady(true)
        }
      } else {
        // 屏幕变了 → 重置
        this.stableSince = Date.now()
        this.lastScreenSnapshot = screen
        this.outputSeenSinceReset = true
      }
    }, QUIESCENCE_POLL_MS)
  }

  private resolveReady(ready: boolean): void {
    if (this.readyResolve) {
      const resolver = this.readyResolve
      this.readyResolve = null
      this.readyPromise = null
      this.cleanup()
      resolver(ready)
    }
  }

  /**
   * 重置状态，用于检测下一轮就绪
   * ★ v5: fastPathDisabled 不受 reset 影响（跨轮次持久有效）
   */
  reset(): void {
    this.isResetting = true
    try {
      this.cleanup()
      this.promptDetected = false
      this.lastScreenSnapshot = ''
      this.stableSince = 0
      this.readyPromise = null
      this.readyResolve = null
      this.spawnedAt = Date.now()
      this.resetAt = Date.now()
      this.isFirstWait = false
      this.outputSeenSinceReset = false
    } finally {
      this.isResetting = false
    }
  }

  destroy(): void {
    this.destroyed = true
    this.cleanup()
    if (this.readyResolve) {
      const resolver = this.readyResolve
      this.readyResolve = null
      resolver(false)
    }
  }

  private cleanup(): void {
    if (this.fastPathFallbackTimer) {
      clearTimeout(this.fastPathFallbackTimer)
      this.fastPathFallbackTimer = null
    }
    if (this.quiescenceTimer) {
      clearInterval(this.quiescenceTimer)
      this.quiescenceTimer = null
    }
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer)
      this.timeoutTimer = null
    }
  }
}
