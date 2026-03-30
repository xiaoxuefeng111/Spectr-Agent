/**
 * 状态推断引擎
 * 结合 prompt marker 检测（精确）和超时推断（兜底），准确判断会话状态
 * @author weibin
 */

import { EventEmitter } from 'events'
import type { SessionStatus, ProviderStateConfig } from '../../shared/types'
import { THRESHOLDS } from '../../shared/constants'
import {
  TailBuffer,
  stripAnsi,
  chunkContainsPromptMarker,
  looksLikeQuestion,
  normalizeForComparison
} from '../agent/ansiUtils'

/** 默认状态推断参数（未配置的 Provider 使用） */
const DEFAULT_STATE_CONFIG: Required<ProviderStateConfig> = {
  startupPattern: '',
  idleTimeoutMs: THRESHOLDS.IDLE_TIMEOUT_MS,
  possibleStuckMs: THRESHOLDS.POSSIBLE_STUCK_MS,
  stuckInterventionMs: THRESHOLDS.STUCK_INTERVENTION_MS,
  startupStuckMs: THRESHOLDS.STARTUP_STUCK_MS,
}

/** Prompt marker 检测稳定性参数 */
const PROMPT_STABILITY_DELAY_MS = 1000    // 检测到 marker 后等待确认稳定
const PROMPT_STABILITY_CHECKS = 2         // 需要连续稳定次数

/** 每个会话的 prompt marker 检测状态 */
interface PromptDetectionState {
  tailBuffer: TailBuffer
  promptDetected: boolean
  stabilityChecksRemaining: number
  stabilitySnapshot: string
  stabilityTimer: NodeJS.Timeout | null
  /** 上次 normalized 输出（用于 quiescence 判断） */
  lastNormalized: string
  /** 输出稳定起始时间 */
  stableSince: number
}

/**
 * 状态推断引擎
 * 基于 prompt marker + 超时 双重机制推断会话状态
 */
export class StateInference extends EventEmitter {
  /** 每个会话的最后输出时间 */
  private lastOutputTime: Map<string, number> = new Map()

  /** 每个会话的当前状态 */
  private sessionStatus: Map<string, SessionStatus> = new Map()

  /** 已发送过卡住通知的会话（防止重复通知） */
  private notifiedStuck: Set<string> = new Set()

  /** 已发送过可能卡住警告的会话 */
  private notifiedPossibleStuck: Set<string> = new Set()

  /** 尚在启动阶段的会话（未检测到 CLI banner） */
  private startupPhase: Set<string> = new Set()

  /** 已通知过启动超时的会话 */
  private notifiedStartupStuck: Set<string> = new Set()

  /** 会话当前处于等待用户下一步输入 */
  private awaitingUserInput: Set<string> = new Set()

  /** 定时器 ID */
  private intervalId: NodeJS.Timeout | null = null

  /** 会话 → Provider 状态配置 */
  private sessionStateConfig: Map<string, Required<ProviderStateConfig>> = new Map()

  /** 会话 → 编译后的启动检测正则 */
  private startupPatterns: Map<string, RegExp | null> = new Map()

  /** 会话 → prompt marker 检测状态 */
  private promptDetection: Map<string, PromptDetectionState> = new Map()

  /** 已终止/移除的会话（防止 removeSession 后延迟事件重新注册） */
  private removedSessions: Set<string> = new Set()

  /**
   * 注册会话的 Provider 状态配置
   */
  registerSessionConfig(sessionId: string, config?: ProviderStateConfig): void {
    const merged: Required<ProviderStateConfig> = {
      ...DEFAULT_STATE_CONFIG,
      ...config,
    }
    this.sessionStateConfig.set(sessionId, merged)

    // 编译启动检测正则
    if (merged.startupPattern) {
      try {
        this.startupPatterns.set(sessionId, new RegExp(merged.startupPattern, 'i'))
      } catch {
        this.startupPatterns.set(sessionId, null)
      }
    } else {
      this.startupPatterns.set(sessionId, null)
    }
  }

  /**
   * 获取会话的状态配置
   */
  private getConfig(sessionId: string): Required<ProviderStateConfig> {
    return this.sessionStateConfig.get(sessionId) || DEFAULT_STATE_CONFIG
  }

  /**
   * 获取或创建 prompt 检测状态
   */
  private getOrCreatePromptState(sessionId: string): PromptDetectionState {
    let state = this.promptDetection.get(sessionId)
    if (!state) {
      state = {
        tailBuffer: new TailBuffer(4096),
        promptDetected: false,
        stabilityChecksRemaining: 0,
        stabilitySnapshot: '',
        stabilityTimer: null,
        lastNormalized: '',
        stableSince: Date.now(),
      }
      this.promptDetection.set(sessionId, state)
    }
    return state
  }

  /**
   * 检测输出是否匹配启动完成标志
   * 由外部调用，传入去除 ANSI 后的干净文本
   * @returns true 如果匹配到启动标志
   */
  checkStartupPattern(sessionId: string, cleanData: string): boolean {
    const pattern = this.startupPatterns.get(sessionId)
    if (!pattern) return false
    if (!this.startupPhase.has(sessionId)) return false

    if (pattern.test(cleanData)) {
      this.markStartupComplete(sessionId)
      return true
    }
    return false
  }

  /**
   * 接收原始 PTY 输出数据（新增方法）
   * 在 index.ts 的 sessionManager.on('output') 中调用
   * 用于 prompt marker 检测和确认提示检测
   */
  onOutputData(sessionId: string, data: string): void {
    // ★ 已移除的会话忽略后续输出数据
    if (this.removedSessions.has(sessionId)) return

    const pState = this.getOrCreatePromptState(sessionId)
    const currentStatus = this.sessionStatus.get(sessionId)

    // 追加到 TailBuffer
    pState.tailBuffer.append(data)

    // 已完成/已终止的会话不再检测
    if (!currentStatus || currentStatus === 'completed' || currentStatus === 'terminated' || currentStatus === 'error') {
      return
    }

    const bufferText = pState.tailBuffer.getText()
    const stripped = stripAnsi(bufferText)
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    // === 检测确认提示（Y/n 等） ===
    if (looksLikeQuestion(bufferText)) {
      // 确认提示检测到 → 标记为 waiting_input
      // 注意：这里只做状态推断，不发 intervention 事件（那是 OutputParser 的职责）
      if (currentStatus !== 'waiting_input' && currentStatus !== 'paused') {
        this.awaitingUserInput.add(sessionId)
        this.sessionStatus.set(sessionId, 'waiting_input')
        this.emit('status-change', sessionId, 'waiting_input')
      }
      // 重置 prompt 检测状态
      pState.promptDetected = false
      pState.stabilityChecksRemaining = 0
      return
    }

    // === 检测 prompt marker（❯ / ›） ===
    if (chunkContainsPromptMarker(stripped)) {
      if (!pState.promptDetected) {
        pState.promptDetected = true
        pState.stabilitySnapshot = normalizeForComparison(bufferText)
        pState.stabilityChecksRemaining = PROMPT_STABILITY_CHECKS

        // 启动稳定性验证
        this.schedulePromptStabilityCheck(sessionId, pState)
      }
    }
  }

  /**
   * Prompt marker 稳定性检查
   * 连续 N 次确认 marker 仍在且输出未变化 → 确认为 waiting_input
   */
  private schedulePromptStabilityCheck(sessionId: string, pState: PromptDetectionState): void {
    if (pState.stabilityTimer) {
      clearTimeout(pState.stabilityTimer)
    }

    pState.stabilityTimer = setTimeout(() => {
      pState.stabilityTimer = null

      const currentStatus = this.sessionStatus.get(sessionId)
      // ★ 已结束或已被 removeSession 清理（undefined）的会话不再处理
      if (!currentStatus || currentStatus === 'completed' || currentStatus === 'terminated' || currentStatus === 'error') {
        return
      }

      const bufferText = pState.tailBuffer.getText()
      const currentStripped = stripAnsi(bufferText)
        .replace(/[\x00-\x1f\x7f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

      // 检查1: prompt marker 是否还在？
      if (!chunkContainsPromptMarker(currentStripped)) {
        // marker 消失了 → 重置
        pState.promptDetected = false
        pState.stabilityChecksRemaining = 0
        pState.stabilitySnapshot = ''
        return
      }

      // 检查2: 输出是否变化？
      const currentNormalized = normalizeForComparison(bufferText)
      if (currentNormalized !== pState.stabilitySnapshot) {
        // 输出变了 → 重置
        pState.promptDetected = false
        pState.stabilityChecksRemaining = 0
        pState.stabilitySnapshot = ''
        return
      }

      // 两项都通过
      pState.stabilityChecksRemaining--

      if (pState.stabilityChecksRemaining <= 0) {
        // ★ 稳定确认完成 → 标记为 waiting_input
        pState.promptDetected = false
        pState.stabilitySnapshot = ''

        if (currentStatus !== 'waiting_input' && currentStatus !== 'paused') {
          this.awaitingUserInput.add(sessionId)
          this.sessionStatus.set(sessionId, 'waiting_input')
          this.emit('status-change', sessionId, 'waiting_input')
        }
      } else {
        // 安排下一次检查
        pState.stabilitySnapshot = currentNormalized
        this.schedulePromptStabilityCheck(sessionId, pState)
      }
    }, PROMPT_STABILITY_DELAY_MS)
  }

  /**
   * 定时检查所有会话状态（超时兜底机制）
   */
  private tick(): void {
    const now = Date.now()

    for (const [sessionId, lastTime] of this.lastOutputTime.entries()) {
      const elapsedMs = now - lastTime
      const currentStatus = this.sessionStatus.get(sessionId)
      const config = this.getConfig(sessionId)

      // 已完成/已终止的会话不再检查
      if (currentStatus === 'completed' || currentStatus === 'terminated' || currentStatus === 'error') {
        continue
      }

      // 启动阶段：超时无 banner → startup-stuck
      if (this.startupPhase.has(sessionId) && elapsedMs >= config.startupStuckMs) {
        if (!this.notifiedStartupStuck.has(sessionId)) {
          this.notifiedStartupStuck.add(sessionId)
          this.emit('startup-stuck', sessionId)
        }
      }

      // 等待用户操作的状态不应判定为卡住
      const isWaitingUser =
        currentStatus === 'paused' ||
        currentStatus === 'waiting_input' ||
        this.awaitingUserInput.has(sessionId)

      // 超时兜底：空闲超时 → idle（prompt marker 未命中时的后备方案）
      if (elapsedMs >= config.idleTimeoutMs && currentStatus !== 'idle' && !isWaitingUser) {
        this.sessionStatus.set(sessionId, 'idle')
        this.emit('status-change', sessionId, 'idle')
      }

      // 可能卡住
      if (elapsedMs >= config.possibleStuckMs && elapsedMs < config.stuckInterventionMs) {
        if (!isWaitingUser && !this.notifiedPossibleStuck.has(sessionId)) {
          this.notifiedPossibleStuck.add(sessionId)
          this.emit('possible-stuck', sessionId)
        }
      }

      // 需要干预
      if (elapsedMs >= config.stuckInterventionMs) {
        if (!isWaitingUser && !this.notifiedStuck.has(sessionId)) {
          this.notifiedStuck.add(sessionId)
          this.emit('intervention-needed', sessionId, 'stuck')
        }
      }
    }
  }

  /**
   * 记录会话输出事件
   * @param data 原始输出数据（用于判断是否为实质性输出）
   */
  onOutput(sessionId: string, data?: string): void {
    // ★ 已移除的会话忽略后续输出，防止 pty flush 数据重新注册
    if (this.removedSessions.has(sessionId)) return

    const now = Date.now()
    const current = this.sessionStatus.get(sessionId)
    const wasIdle = current === 'idle'
    const wasWaitingInput = current === 'waiting_input'

    this.lastOutputTime.set(sessionId, now)

    // 有新输出，重置卡住通知标记
    // ★ 如果之前被标记为卡住，清除后通知前端恢复（即使输出非实质性）
    const wasStuck = this.notifiedStuck.has(sessionId) || this.notifiedPossibleStuck.has(sessionId)
    this.notifiedStuck.delete(sessionId)
    this.notifiedPossibleStuck.delete(sessionId)
    if (wasStuck) {
      this.emit('output-recovered', sessionId)
    }

    if (wasIdle || wasWaitingInput) {
      // ★ 从 idle/waiting_input 切回 running 时，要求实质性输出
      // 过滤掉 spinner 动画、光标控制、空白等微量输出，避免状态闪烁
      if (data) {
        const substantive = data
          .replace(/\x1B\[[?>=!]*[0-9;]*[a-zA-Z~@`]/g, '') // CSI 控制序列
          .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '') // OSC 序列
          .replace(/\x1B./g, '')    // 其他 ESC 序列
          .replace(/[\x00-\x1f\x7f]/g, '') // 控制字符（含 \r \n）
          .replace(/\s+/g, '')      // 空白
          .trim()
        if (substantive.length < 2) {
          // 非实质性输出（spinner 字符、控制序列等），不切换状态
          return
        }
      }
      this.awaitingUserInput.delete(sessionId)
      this.sessionStatus.set(sessionId, 'running')
      this.emit('status-change', sessionId, 'running')
    } else if (!this.sessionStatus.has(sessionId)) {
      this.sessionStatus.set(sessionId, 'running')
      this.startupPhase.add(sessionId)
    }
  }

  /**
   * 标记会话启动完成（已检测到 CLI banner）
   */
  markStartupComplete(sessionId: string): void {
    this.startupPhase.delete(sessionId)
    const wasNotified = this.notifiedStartupStuck.delete(sessionId)
    if (wasNotified) {
      this.emit('startup-recovered', sessionId)
    }
  }

  /**
   * 启动状态推断引擎
   */
  start(): void {
    if (this.intervalId) return
    this.intervalId = setInterval(() => this.tick(), 2000)
  }

  /**
   * 停止状态推断引擎
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }

  /**
   * 移除会话跟踪
   */
  removeSession(sessionId: string): void {
    // ★ 标记为已移除，防止后续延迟事件（pty flush 数据、pending 定时器）
    // 重新将该 session 注册回 Maps 中
    this.removedSessions.add(sessionId)

    this.lastOutputTime.delete(sessionId)
    this.sessionStatus.delete(sessionId)
    this.notifiedStuck.delete(sessionId)
    this.notifiedPossibleStuck.delete(sessionId)
    this.startupPhase.delete(sessionId)
    this.notifiedStartupStuck.delete(sessionId)
    this.awaitingUserInput.delete(sessionId)
    this.sessionStateConfig.delete(sessionId)
    this.startupPatterns.delete(sessionId)

    // 清理 prompt 检测状态（包括 pending 的 stabilityTimer）
    const pState = this.promptDetection.get(sessionId)
    if (pState) {
      if (pState.stabilityTimer) clearTimeout(pState.stabilityTimer)
      this.promptDetection.delete(sessionId)
    }
  }

  /**
   * 手动设置会话状态
   */
  setSessionStatus(sessionId: string, status: SessionStatus): void {
    if (this.removedSessions.has(sessionId)) return
    this.sessionStatus.set(sessionId, status)
    if (status === 'waiting_input' || status === 'paused') {
      this.awaitingUserInput.add(sessionId)
    } else {
      this.awaitingUserInput.delete(sessionId)
    }
    this.emit('status-change', sessionId, status)
  }

  /**
   * 标记会话当前在等待用户下一步输入（例如 AI 刚完成回答）
   */
  markAwaitingUserInput(sessionId: string): void {
    if (this.removedSessions.has(sessionId)) return
    this.awaitingUserInput.add(sessionId)
    if (this.sessionStatus.get(sessionId) !== 'paused') {
      this.sessionStatus.set(sessionId, 'waiting_input')
      this.emit('status-change', sessionId, 'waiting_input')
    }
  }

  /**
   * 标记用户已发起新一轮输入，恢复为运行态并重新参与卡住检测
   */
  markWorkStarted(sessionId: string): void {
    if (this.removedSessions.has(sessionId)) return
    this.awaitingUserInput.delete(sessionId)
    this.notifiedStuck.delete(sessionId)
    this.notifiedPossibleStuck.delete(sessionId)
    this.lastOutputTime.set(sessionId, Date.now())
    this.sessionStatus.set(sessionId, 'running')
    this.emit('status-change', sessionId, 'running')

    // 重置 prompt 检测状态
    const pState = this.promptDetection.get(sessionId)
    if (pState) {
      if (pState.stabilityTimer) clearTimeout(pState.stabilityTimer)
      pState.promptDetected = false
      pState.stabilityChecksRemaining = 0
      pState.stabilitySnapshot = ''
      pState.tailBuffer.clear()
    }
  }
}
