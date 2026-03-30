/**
 * 输出解析引擎核心
 * @author weibin
 */

import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { ParserRule, ActivityEvent, ActivityEventType, AIProvider, ProviderConfirmationConfig } from '../../shared/types'
import type { ParserState } from './types'
import { PARSER_RULES } from './rules'
import { ConfirmationDetector } from './ConfirmationDetector'
import { UsageEstimator } from './UsageEstimator'
import { stripAnsi } from '../agent/ansiUtils'

/** 自定义规则 JSON 格式 */
interface CustomRuleJson {
  type: string
  priority?: number
  patterns: string[]  // 正则表达式字符串
  detailTemplate: string  // 模板字符串，支持 $1 $2 等引用
}

/**
 * 输出解析引擎
 * 负责解析 Claude Code 输出，识别活动事件
 */
export class OutputParser extends EventEmitter {
  /** 行缓冲区，按会话存储不完整的行 */
  private lineBuffer: Map<string, string> = new Map()

  /** 解析器状态映射 */
  private stateMap: Map<string, ParserState> = new Map()

  /** 去重缓存：sessionId → { type+detail → timestamp } */
  private dedupeCache: Map<string, Map<string, number>> = new Map()

  /** 会话 → Provider ID 映射 */
  private sessionProviderMap: Map<string, string> = new Map()

  /** Provider → 确认检测器缓存（按需创建） */
  private providerConfirmDetectors: Map<string, ConfirmationDetector> = new Map()

  /** 已启用结构化读取器的会话 — 这些会话的 error 事件由读取器从 JSONL 准确检测，正则匹配的 error 将被抑制 */
  private structuredReaderSessions: Set<string> = new Set()

  /** AI 文本累积 flush 延迟（毫秒） */
  private readonly TEXT_FLUSH_DELAY = 2000

  /** 普通事件去重窗口（毫秒） */
  private readonly DEDUPE_WINDOW = 3000

  /** 干预类事件去重窗口（确认请求、错误），更长以避免重复通知 */
  private readonly INTERVENTION_DEDUPE_WINDOW = 30000

  /** 确认请求检测器 */
  private confirmationDetector: ConfirmationDetector

  /** Token 用量估算器 */
  private usageEstimator: UsageEstimator

  /** 解析规则列表（按优先级排序） */
  private rules: ParserRule[]

  /** 自定义规则文件路径 */
  private customRulesPath: string

  /** 自定义规则文件监听器 */
  private fileWatcher: fs.StatWatcher | null = null

  constructor() {
    super()
    this.confirmationDetector = new ConfirmationDetector()
    this.usageEstimator = new UsageEstimator()

    // 自定义规则文件路径
    this.customRulesPath = path.join(os.homedir(), '.claudeops', 'custom-rules.json')

    // 合并内置规则和自定义规则，按优先级排序
    const customRules = this.loadCustomRules()
    this.rules = [...PARSER_RULES, ...customRules].sort((a, b) => b.priority - a.priority)

    // 监听自定义规则文件变化
    this.watchCustomRules()
  }

  /**
   * 加载自定义规则
   */
  private loadCustomRules(): ParserRule[] {
    try {
      if (!fs.existsSync(this.customRulesPath)) return []

      const content = fs.readFileSync(this.customRulesPath, 'utf-8')
      const jsonRules: CustomRuleJson[] = JSON.parse(content)

      if (!Array.isArray(jsonRules)) {
        console.warn('[OutputParser] custom-rules.json must be an array')
        return []
      }

      const parsed: ParserRule[] = []
      for (const rule of jsonRules) {
        const validated = this.validateAndConvertRule(rule)
        if (validated) {
          parsed.push(validated)
        }
      }

      if (parsed.length > 0) {
        console.log(`[OutputParser] Loaded ${parsed.length} custom rules`)
      }
      return parsed
    } catch (err) {
      console.warn('[OutputParser] Failed to load custom rules:', err)
      return []
    }
  }

  /**
   * 验证并转换自定义规则 JSON 到 ParserRule
   */
  private validateAndConvertRule(rule: CustomRuleJson): ParserRule | null {
    // 类型验证
    if (!rule.type || typeof rule.type !== 'string') {
      console.warn('[OutputParser] Custom rule missing or invalid "type"')
      return null
    }

    // patterns 验证
    if (!Array.isArray(rule.patterns) || rule.patterns.length === 0) {
      console.warn(`[OutputParser] Custom rule "${rule.type}" missing or empty "patterns"`)
      return null
    }

    // detailTemplate 验证
    if (!rule.detailTemplate || typeof rule.detailTemplate !== 'string') {
      console.warn(`[OutputParser] Custom rule "${rule.type}" missing "detailTemplate"`)
      return null
    }

    // 编译正则表达式
    const compiledPatterns: RegExp[] = []
    for (const patternStr of rule.patterns) {
      try {
        compiledPatterns.push(new RegExp(patternStr, 'i'))
      } catch (err) {
        console.warn(`[OutputParser] Invalid regex in rule "${rule.type}": ${patternStr}`)
        return null
      }
    }

    // 构建 extractDetail 函数
    const template = rule.detailTemplate
    const extractDetail = (line: string): string => {
      for (const pattern of compiledPatterns) {
        const match = line.match(pattern)
        if (match) {
          // 替换 $0, $1, $2 等
          return template.replace(/\$(\d+)/g, (_, idx) => {
            const i = parseInt(idx, 10)
            return (match[i] || '').slice(0, 80)
          })
        }
      }
      return template.replace(/\$\d+/g, '')
    }

    return {
      type: rule.type as ActivityEventType,
      priority: rule.priority ?? 10,
      patterns: compiledPatterns,
      extractDetail
    }
  }

  /**
   * 监听自定义规则文件变化，热加载
   */
  private watchCustomRules(): void {
    try {
      // 确保目录存在
      const dir = path.dirname(this.customRulesPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      // 使用 watchFile 而非 watch（更稳定，跨平台）
      fs.watchFile(this.customRulesPath, { interval: 5000 }, (curr, prev) => {
        if (curr.mtimeMs !== prev.mtimeMs) {
          console.log('[OutputParser] Custom rules file changed, reloading...')
          const customRules = this.loadCustomRules()
          this.rules = [...PARSER_RULES, ...customRules].sort((a, b) => b.priority - a.priority)
        }
      })
      this.fileWatcher = {} as any // 标记监听已启动
    } catch (err) {
      console.warn('[OutputParser] Failed to watch custom rules file:', err)
    }
  }

  /**
   * 停止文件监听
   */
  stopWatching(): void {
    if (this.fileWatcher) {
      fs.unwatchFile(this.customRulesPath)
      this.fileWatcher = null
    }
  }

  // ==================== Provider 化方法 ====================

  /**
   * 注册会话所使用的 Provider（创建会话时调用）
   */
  registerSessionProvider(sessionId: string, provider: AIProvider): void {
    this.sessionProviderMap.set(sessionId, provider.id)

    // 如果 Provider 有自定义确认配置，缓存一个专用检测器
    if (provider.confirmationConfig && !this.providerConfirmDetectors.has(provider.id)) {
      this.providerConfirmDetectors.set(
        provider.id,
        ConfirmationDetector.fromConfig(provider.confirmationConfig)
      )
    }
  }

  /**
   * 标记会话已启用结构化读取器
   * error 类事件将由读取器从 JSONL 的 is_error 字段准确检测，
   * OutputParser 的正则匹配 error 将被抑制（避免自然语言误匹配）
   */
  setStructuredReaderActive(sessionId: string): void {
    this.structuredReaderSessions.add(sessionId)
  }

  /**
   * 获取会话对应的 Provider ID
   */
  getSessionProviderId(sessionId: string): string {
    return this.sessionProviderMap.get(sessionId) || 'claude-code'
  }

  /**
   * 获取会话对应的确认检测器
   */
  private getConfirmationDetector(sessionId: string): ConfirmationDetector {
    const providerId = this.getSessionProviderId(sessionId)
    return this.providerConfirmDetectors.get(providerId) || this.confirmationDetector
  }

  /**
   * 获取适用于指定会话的规则列表
   * 优先级：Provider 专属规则 > 通用规则（providerId 为空）
   */
  private getRulesForSession(sessionId: string): ParserRule[] {
    const providerId = this.getSessionProviderId(sessionId)
    return this.rules.filter(rule => !rule.providerId || rule.providerId === providerId)
  }

  /**
   * 获取或创建会话状态
   */
  private getOrCreateState(sessionId: string): ParserState {
    if (!this.stateMap.has(sessionId)) {
      this.stateMap.set(sessionId, {
        sessionId,
        lastEventType: null,
        lastOutputTime: Date.now(),
        isThinking: false,
        textBufferLines: [],
        textBufferStartTime: 0,
        flushTimer: null
      })
    }
    return this.stateMap.get(sessionId)!
  }

  /**
   * 获取事件类型对应的去重窗口
   */
  private getDedupeWindow(type: ActivityEventType): number {
    if (type === 'waiting_confirmation' || type === 'error') {
      return this.INTERVENTION_DEDUPE_WINDOW
    }
    return this.DEDUPE_WINDOW
  }

  /**
   * 去重检查：同类型同详情在窗口内只发一次
   */
  private isDuplicate(sessionId: string, type: ActivityEventType, detail: string): boolean {
    if (!this.dedupeCache.has(sessionId)) {
      this.dedupeCache.set(sessionId, new Map())
    }
    const cache = this.dedupeCache.get(sessionId)!
    const key = `${type}::${detail}`
    const now = Date.now()
    const lastTime = cache.get(key)
    const window = this.getDedupeWindow(type)

    if (lastTime && (now - lastTime) < window) {
      return true
    }

    cache.set(key, now)

    // 定期清理过期条目
    if (cache.size > 100) {
      const maxWindow = Math.max(this.DEDUPE_WINDOW, this.INTERVENTION_DEDUPE_WINDOW)
      for (const [k, t] of cache.entries()) {
        if (now - t > maxWindow * 2) {
          cache.delete(k)
        }
      }
    }

    return false
  }

  /**
   * 清除指定会话的干预类去重缓存（用户确认后允许新的检测）
   */
  clearInterventionDedupe(sessionId: string): void {
    const cache = this.dedupeCache.get(sessionId)
    if (!cache) return

    for (const key of cache.keys()) {
      if (key.startsWith('waiting_confirmation::') || key.startsWith('error::')) {
        cache.delete(key)
      }
    }
  }

  /**
   * 判断一行文本是否为有意义的 AI 文本输出
   * 排除纯符号行、短行、代码缩进行等噪音
   */
  private isSignificantText(line: string): boolean {
    // 过短
    if (line.length < 8) return false
    // 纯符号/数字/空白
    if (/^[\s\d\W]+$/.test(line)) return false
    // 文件路径行（通常是工具输出的一部分）
    if (/^[A-Z]:\\|^\/[\w/]/.test(line) && !line.includes(' ')) return false
    // 代码行（强缩进 4+ 空格，通常是工具输出内容）
    if (/^ {4,}\S/.test(line)) return false
    // 纯分隔线
    if (/^[-=─━_]{3,}$/.test(line)) return false
    // 含有字母字符（有实际文字内容）
    return /[a-zA-Z\u4e00-\u9fff]/.test(line)
  }

  /**
   * flush 文本缓冲区，发出 assistant_message 事件
   */
  private flushTextBuffer(sessionId: string, state: ParserState): void {
    if (state.textBufferLines.length === 0) return

    // 清除定时器
    if (state.flushTimer) {
      clearTimeout(state.flushTimer)
      state.flushTimer = null
    }

    const fullText = state.textBufferLines.join('\n').trim()
    if (fullText.length < 8) {
      state.textBufferLines = []
      return
    }

    // 截取前 150 字符作为 detail
    const preview = fullText.length > 150
      ? fullText.slice(0, 150) + '...'
      : fullText

    // 去重检查
    if (!this.isDuplicate(sessionId, 'assistant_message', preview)) {
      const event: ActivityEvent = {
        id: uuidv4(),
        sessionId,
        type: 'assistant_message',
        timestamp: new Date(state.textBufferStartTime).toISOString(),
        detail: preview,
        metadata: {
          lineCount: state.textBufferLines.length,
          fullLength: fullText.length
        }
      }

      this.emit('activity', sessionId, event)

      // 发出完整 AI 回答事件（供 session_summaries 存储）
      if (fullText.length >= 20) {
        this.emit('ai-response', sessionId, fullText)
      }
    }

    // 清空缓冲
    state.textBufferLines = []
    state.textBufferStartTime = 0
  }

  /**
   * 安排定时 flush（debounce）
   */
  private scheduleFlush(sessionId: string, state: ParserState): void {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer)
    }
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null
      this.flushTextBuffer(sessionId, state)
    }, this.TEXT_FLUSH_DELAY)
  }

  /**
   * 解析单行输出（已去除 ANSI 的干净文本）
   */
  private parseLine(sessionId: string, line: string, state: ParserState): void {
    // 去除 ANSI 转义码
    let cleanLine = stripAnsi(line)

    // 处理终端回车覆写（\r）：终端中 \r 表示光标回到行首，后续内容覆盖前面
    // 只保留最后一次覆写的内容，模拟用户实际看到的终端画面
    if (cleanLine.includes('\r')) {
      const segments = cleanLine.split('\r')
      cleanLine = segments.filter(s => s.length > 0).pop() || ''
    }

    const trimmed = cleanLine.trim()

    // 跳过过短的行（通常是终端控制碎片）
    if (trimmed.length < 3) return

    // 首先检查确认请求（高优先级，使用 Provider 对应的检测器）
    const detector = this.getConfirmationDetector(sessionId)
    const confirmation = detector.detect(cleanLine)
    if (confirmation) {
      if (this.isDuplicate(sessionId, 'waiting_confirmation', confirmation.promptText)) return

      // 有新的结构化事件，先 flush 累积的文本
      this.flushTextBuffer(sessionId, state)

      const event: ActivityEvent = {
        id: uuidv4(),
        sessionId,
        type: 'waiting_confirmation',
        timestamp: new Date().toISOString(),
        detail: confirmation.promptText,
        metadata: {
          confidence: confirmation.confidence,
          originalLine: confirmation.originalLine
        }
      }

      state.lastEventType = 'waiting_confirmation'
      state.lastOutputTime = Date.now()

      this.emit('activity', sessionId, event)
      this.emit('intervention-needed', sessionId, 'confirmation')
      return
    }

    // 按优先级顺序匹配规则（Provider 隔离）
    const applicableRules = this.getRulesForSession(sessionId)
    for (const rule of applicableRules) {
      let matched = false

      for (const pattern of rule.patterns) {
        // 重置 lastIndex（正则可能带 g 标志）
        pattern.lastIndex = 0
        if (pattern.test(cleanLine)) {
          matched = true
          break
        }
      }

      if (matched) {
        // 有结构化读取器时，抑制正则匹配的 error 事件
        // 结构化读取器通过 JSONL is_error 字段准确检测错误，正则匹配容易误判自然语言
        if (rule.type === 'error' && this.structuredReaderSessions.has(sessionId)) {
          return
        }

        const detail = rule.extractDetail(cleanLine)

        // 去重检查
        if (this.isDuplicate(sessionId, rule.type, detail)) return

        // 有新的结构化事件，先 flush 累积的文本
        this.flushTextBuffer(sessionId, state)

        const event: ActivityEvent = {
          id: uuidv4(),
          sessionId,
          type: rule.type,
          timestamp: new Date().toISOString(),
          detail,
          metadata: {
            originalLine: trimmed
          }
        }

        state.lastEventType = rule.type
        state.lastOutputTime = Date.now()

        // 更新思考状态
        if (rule.type === 'thinking') {
          state.isThinking = true
        } else if (state.isThinking) {
          state.isThinking = false
        }

        this.emit('activity', sessionId, event)

        // 错误额外触发干预事件
        if (rule.type === 'error') {
          this.emit('intervention-needed', sessionId, 'error')
        }

        return
      }
    }

    // 没有规则命中：检查是否为有意义的 AI 文本输出，加入累积缓冲
    if (this.isSignificantText(trimmed)) {
      if (state.textBufferLines.length === 0) {
        state.textBufferStartTime = Date.now()
      }
      state.textBufferLines.push(trimmed)
      // 安排定时 flush（debounce，连续文本行会不断重置定时器）
      this.scheduleFlush(sessionId, state)
    }
  }

  /**
   * 喂入输出数据
   */
  feed(sessionId: string, data: string): void {
    // 累计用量估算
    this.usageEstimator.accumulateUsage(sessionId, data)

    // 获取会话状态
    const state = this.getOrCreateState(sessionId)

    // 获取行缓冲
    const buffer = this.lineBuffer.get(sessionId) || ''
    const newBuffer = buffer + data

    // 提取完整行
    const incompleteLineStartIndex = newBuffer.lastIndexOf('\n')
    if (incompleteLineStartIndex === -1) {
      // 没有完整行，全部保留到缓冲区
      this.lineBuffer.set(sessionId, newBuffer)
      return
    }

    const incompleteLine = newBuffer.slice(incompleteLineStartIndex + 1)
    this.lineBuffer.set(sessionId, incompleteLine)

    // 处理完整行
    const completeLines = newBuffer.slice(0, incompleteLineStartIndex).split('\n')

    for (const line of completeLines) {
      this.parseLine(sessionId, line, state)
    }
  }

  /**
   * 获取 Token 用量汇总
   */
  getUsageSummary() {
    return this.usageEstimator.getSummary()
  }

  /**
   * 获取指定会话的 Token 用量
   */
  getSessionUsage(sessionId: string): number {
    return this.usageEstimator.getSessionUsage(sessionId)
  }

  /**
   * 获取用量估算器实例（用于绑定数据库等）
   */
  getUsageEstimator(): UsageEstimator {
    return this.usageEstimator
  }

  /**
   * 标记会话结束（flush 用量到数据库）
   */
  markSessionEnded(sessionId: string): void {
    // 会话结束前 flush 残留的文本缓冲
    const state = this.stateMap.get(sessionId)
    if (state) {
      this.flushTextBuffer(sessionId, state)
    }
    this.usageEstimator.markSessionEnded(sessionId)
  }

  /**
   * 清理会话资源
   */
  clearSession(sessionId: string): void {
    // 清理文本缓冲定时器
    const state = this.stateMap.get(sessionId)
    if (state?.flushTimer) {
      clearTimeout(state.flushTimer)
    }
    this.lineBuffer.delete(sessionId)
    this.stateMap.delete(sessionId)
    this.dedupeCache.delete(sessionId)
    this.sessionProviderMap.delete(sessionId)
    this.structuredReaderSessions.delete(sessionId)
    this.usageEstimator.resetSessionUsage(sessionId)
  }

  /**
   * 清理用量估算器资源
   */
  cleanupUsage(): void {
    this.usageEstimator.cleanup()
  }
}
