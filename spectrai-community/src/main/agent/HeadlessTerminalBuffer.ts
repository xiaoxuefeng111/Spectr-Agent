/**
 * HeadlessTerminalBuffer - 基于 @xterm/headless 的虚拟终端缓冲区
 *
 * 替代原有的 TailBuffer（字符串拼接），使用真正的终端模拟器处理 PTY 输出。
 * 正确处理光标移动、行清除、覆写、滚动等终端控制序列，
 * 使 getText() 返回的内容与屏幕上实际显示一致。
 *
 * ★ 支持 onScreenUpdate 回调：write 完成后通知外部屏幕内容已更新，
 *   用于 ReadinessDetector 在准确的屏幕内容上做 prompt marker 检测。
 *
 * @author weibin
 */

import { Terminal } from '@xterm/headless'

/** 默认配置 — 必须与 SessionManager 创建 PTY 时的尺寸一致 */
const DEFAULT_COLS = 120       // 列宽（与 SessionManager.ts 的 PTY cols 一致）
const DEFAULT_ROWS = 80        // 可视行数（与 SessionManager.ts 的 Agent PTY rows 一致）
const DEFAULT_SCROLLBACK = 5000 // 回滚缓冲区行数

/** 屏幕更新回调参数 */
export interface ScreenUpdateInfo {
  /** 屏幕最后 N 行文本（已处理 TUI 重绘，纯文本） */
  lastLines: string[]
  /** 累计写入的原始字节数 */
  totalAppended: number
}

export class HeadlessTerminalBuffer {
  private terminal: Terminal
  private _totalAppended: number = 0
  private _disposed = false
  /** ★ 屏幕内容更新后的回调（write 完成时触发） */
  private _onScreenUpdate: ((info: ScreenUpdateInfo) => void) | null = null
  /** 回调中返回的尾部行数 */
  private _callbackTailLines: number = 30

  constructor(options?: {
    cols?: number
    rows?: number
    scrollback?: number
    /** 屏幕更新回调（每次 write 完成后触发，传入准确的屏幕内容） */
    onScreenUpdate?: (info: ScreenUpdateInfo) => void
    /** 回调中返回最后多少行，默认 30 */
    callbackTailLines?: number
  }) {
    this.terminal = new Terminal({
      cols: options?.cols || DEFAULT_COLS,
      rows: options?.rows || DEFAULT_ROWS,
      scrollback: options?.scrollback || DEFAULT_SCROLLBACK,
      allowProposedApi: true,
    })
    this._onScreenUpdate = options?.onScreenUpdate || null
    this._callbackTailLines = options?.callbackTailLines || 30
  }

  /**
   * 追加 PTY 原始输出（含 ANSI 转义序列），终端模拟器会正确处理。
   * ★ 写入完成后触发 onScreenUpdate 回调，传入准确的屏幕内容。
   */
  append(data: string): void {
    if (this._disposed) return
    this._totalAppended += data.length

    if (this._onScreenUpdate) {
      // 使用 write callback，确保数据被终端完全处理后再通知
      this.terminal.write(data, () => {
        if (this._disposed || !this._onScreenUpdate) return
        this._onScreenUpdate({
          lastLines: this.getLastLines(this._callbackTailLines),
          totalAppended: this._totalAppended,
        })
      })
    } else {
      this.terminal.write(data)
    }
  }

  /**
   * 获取终端屏幕的实际显示内容（纯文本）
   * 返回的是经过终端模拟器处理后的真实画面，
   * 光标移动、行清除、覆写的效果都已正确反映。
   */
  getText(): string {
    if (this._disposed) return ''
    const buffer = this.terminal.buffer.active
    const lines: string[] = []

    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y)
      if (line) {
        lines.push(line.translateToString(true))
      }
    }

    // 去除末尾的空行
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop()
    }

    return lines.join('\n')
  }

  /**
   * 获取最后 n 个字符
   */
  getLastChars(n: number): string {
    const text = this.getText()
    return text.slice(-n)
  }

  /** 清空终端内容 */
  clear(): void {
    if (this._disposed) return
    this.terminal.clear()
    this.terminal.reset()
    this._totalAppended = 0
  }

  /** 当前终端文本内容长度 */
  get length(): number {
    if (this._disposed) return 0
    return this._totalAppended > 0 ? Math.max(1, this.getText().length) : 0
  }

  /** 累计追加的总字节数（用于卡住检测） */
  get totalAppended(): number {
    return this._totalAppended
  }

  /**
   * 获取最后 N 行文本
   */
  getLastLines(n: number): string[] {
    if (this._disposed) return []
    const buffer = this.terminal.buffer.active
    const allLines: string[] = []

    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y)
      if (line) {
        allLines.push(line.translateToString(true))
      }
    }

    // 去除末尾空行
    while (allLines.length > 0 && allLines[allLines.length - 1] === '') {
      allLines.pop()
    }

    return allLines.slice(-n)
  }

  /** 销毁终端实例，释放资源 */
  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this._onScreenUpdate = null
    this.terminal.dispose()
  }
}
