/**
 * ANSI 工具函数 — 终端输出清洗与 Tail Buffer
 * 参考 parallel-code/src/store/taskStatus.ts 实现
 * @author weibin
 */

// ---------------------------------------------------------------------------
// ANSI 转义序列正则
// ---------------------------------------------------------------------------
const ANSI_REGEX =
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g

// ---------------------------------------------------------------------------
// 1. stripAnsi — 移除所有 ANSI 转义序列
// ---------------------------------------------------------------------------
/**
 * 移除所有 ANSI 转义序列，包括：
 * - CSI 序列 (如 \x1b[32m 颜色, \x1b[1;1H 光标定位)
 * - OSC 序列 (如 \x1b]0;title\x07 窗口标题)
 * - 单字符 escape
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '')
}

// ---------------------------------------------------------------------------
// 2. normalizeForComparison — 用于 quiescence 检测时对比输出是否变化
// ---------------------------------------------------------------------------
/**
 * 先 stripAnsi，然后去掉控制字符，合并连续空白为单个空格，trim。
 * 用于 quiescence 检测时对比输出是否变化。
 */
export function normalizeForComparison(text: string): string {
  return stripAnsi(text)
    .replace(/[\x00-\x1f\x7f]/g, '') // 去掉控制字符
    // ★ Bug 2 Fix: 去除已知的动态内容（状态栏百分比、spinner、快捷键提示等）
    // 这些内容持续刷新导致 stability check 和 quiescence 无法判定稳定
    .replace(/\d+%\s*context\s*(left|remaining|used)/gi, '') // "99% context left"
    .replace(/\d+(\.\d+)?%/g, '')                            // 任意百分比数字 "99%"
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '')                        // Braille spinner
    .replace(/\?\s*for\s*shortcuts?/gi, '')                  // "? for shortcuts"
    .replace(/Run\s+\/\w+\s+on\s+my\s+current\s+changes/gi, '') // Codex "/review" 提示
    // ★ Fix: 去除 Codex "Working (Xs • esc to interrupt)" 动态计时器
    .replace(/Working\s*\(\d+s\s*[•·]\s*esc to interrupt\)/gi, '')
    // ★ Fix: 去除 Gemini auth 等待动画 "⠋ Waiting for auth..."
    .replace(/Waiting for auth[^)]*\)/gi, '')
    .replace(/\s+/g, ' ') // 合并连续空白为单个空格
    .trim()
}

// ---------------------------------------------------------------------------
// 3. TailBuffer 类 — 保留最后 maxSize 个字符的环形缓冲
// ---------------------------------------------------------------------------
/**
 * 保留最后 maxSize 个字符的尾部缓冲区。
 * 适用于终端输出场景，仅关心最近的输出内容。
 */
export class TailBuffer {
  private buffer: string = ''
  private maxSize: number
  /** 累计追加的总字节数（不受环形截断影响，用于判断输出是否增长） */
  private _totalAppended: number = 0

  constructor(maxSize: number = 4096) {
    this.maxSize = maxSize
  }

  /** 追加文本，超过 maxSize 则截取末尾 */
  append(text: string): void {
    this._totalAppended += text.length
    this.buffer += text
    if (this.buffer.length > this.maxSize) {
      this.buffer = this.buffer.slice(-this.maxSize)
    }
  }

  /** 获取当前 buffer 内容 */
  getText(): string {
    return this.buffer
  }

  /** 获取最后 n 个字符 */
  getLastChars(n: number): string {
    return this.buffer.slice(-n)
  }

  /** 清空 buffer */
  clear(): void {
    this.buffer = ''
    this._totalAppended = 0
  }

  /** 当前长度 */
  get length(): number {
    return this.buffer.length
  }

  /** 累计追加的总字节数（即使 buffer 满了也持续增长，用于检测 Agent 是否还在产出） */
  get totalAppended(): number {
    return this._totalAppended
  }
}

// ---------------------------------------------------------------------------
// 4. PROMPT_MARKERS — 已知的 prompt marker 正则数组
// ---------------------------------------------------------------------------
/** 默认 prompt marker 正则数组（覆盖常见 CLI 工具） */
export const DEFAULT_PROMPT_MARKERS: RegExp[] = [
  /❯/,     // Claude Code
  /›/,     // Codex CLI (Unicode)
  />\s/,   // 通用 prompt: IFlow, OpenCode, Gemini 等（">" 后跟空白，减少误匹配）
  /\$\s*$/, // Shell prompt
  /✦/,     // IFlow 回答标记
]

// ---------------------------------------------------------------------------
// 5. chunkContainsPromptMarker — 检查文本最后 200 字符中是否包含已知的 prompt marker
// ---------------------------------------------------------------------------
/**
 * 检查文本最后 200 字符中是否包含已知的 prompt marker。
 * 可传入自定义 markers 覆盖默认列表（用于 Provider 特定检测）。
 */
export function chunkContainsPromptMarker(text: string, markers?: RegExp[]): boolean {
  const tail = text.slice(-200)
  const effectiveMarkers = markers || DEFAULT_PROMPT_MARKERS
  return effectiveMarkers.some((re) => re.test(tail))
}

/**
 * 将字符串正则模式编译为 RegExp 数组（用于 Provider 配置的 promptMarkerPatterns）。
 * 返回 undefined 表示使用默认 markers。
 */
export function compilePromptMarkers(patterns?: string[]): RegExp[] | undefined {
  if (!patterns || patterns.length === 0) return undefined
  return patterns.map(p => new RegExp(p))
}

// ---------------------------------------------------------------------------
// 6. QUESTION_PATTERNS — 确认提示正则数组
// ---------------------------------------------------------------------------
/** 确认提示正则数组 */
export const QUESTION_PATTERNS: RegExp[] = [
  /\[Y\/n\]\s*$/i,
  /\[y\/N\]\s*$/i,
  /\(y(?:es)?\/n(?:o)?\)\s*$/i,
  /\bproceed\b.*\?/i,
  /\ballow\b.*\?/i,
  /Do you want to/i,
  /Would you like to/i,
  /Are you sure/i
]

// ---------------------------------------------------------------------------
// 7. looksLikeQuestion — 检查文本末尾是否像确认提问
// ---------------------------------------------------------------------------
/**
 * 检查文本末尾是否像确认提问。
 */
export function looksLikeQuestion(text: string): boolean {
  const tail = text.slice(-500)
  return QUESTION_PATTERNS.some((re) => re.test(tail))
}

// ---------------------------------------------------------------------------
// 8. THINKING_PATTERNS — AI 思考中的标志正则数组
// ---------------------------------------------------------------------------
/** AI 正在思考中的标志（出现在 TUI 终端的 thinking 提示） */
export const THINKING_PATTERNS: RegExp[] = [
  /\(thinking\)/i,                       // Claude Code "(thinking)" 标记
  /\(thought for \d+/i,                  // Claude Code "(thought for Xs)" 标记
  /\bZigzagging\b/i,                     // Claude Code thinking 动画
  /\bMeandering\b/i,                     // Claude Code thinking 动画
  /\bRuminating\b/i,                     // Claude Code thinking 动画
  /\bPondering\b/i,                      // Claude Code thinking 动画
  /\bPollinating\b/i,                    // Claude Code thinking 动画
  /\bManifesting\b/i,                    // Claude Code thinking 动画
  /生成中\s+\d+s/,                        // IFlow "生成中 3s ... (按esc取消)"
  /Working \(\d+s/i,                     // Codex CLI "Working (4s • esc to interrupt)"
  /esc to interrupt/i,                   // Codex CLI 工作中的通用标记
  /Generating\b/i,                       // Gemini CLI 生成中
  /Waiting for auth/i,                   // Gemini CLI 等待认证
]

// ---------------------------------------------------------------------------
// 9. looksLikeThinking — 检查文本末尾是否像 AI 思考中
// ---------------------------------------------------------------------------
/**
 * 检查文本末尾是否包含 AI 思考中的标志。
 * 用于防止 thinking 静默期被误判为 Agent 就绪。
 */
export function looksLikeThinking(text: string): boolean {
  const tail = text.slice(-500)
  return THINKING_PATTERNS.some((re) => re.test(tail))
}
