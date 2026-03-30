/**
 * 终端管理 Hook
 * 负责 xterm.js 实例的生命周期管理和交互
 * @author weibin
 */

import { useEffect, useRef, RefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useUIStore } from '../stores/uiStore'
import { useSessionStore } from '../stores/sessionStore'
import { THEMES, DEFAULT_THEME_ID } from '../../shared/constants'

interface UseTerminalReturn {
  terminal: Terminal | null
  fitAddon: FitAddon | null
}

/** 根据主题 ID 获取终端配色 */
function getTerminalTheme(themeId: string) {
  const t = (THEMES[themeId] || THEMES[DEFAULT_THEME_ID]).terminal
  return {
    background: t.bg,
    foreground: t.fg,
    cursor: t.cursor,
    black: t.black,
    red: t.red,
    green: t.green,
    yellow: t.yellow,
    blue: t.blue,
    magenta: t.magenta,
    cyan: t.cyan,
    white: t.white,
    brightBlack: t.brightBlack,
    brightRed: t.brightRed,
    brightGreen: t.brightGreen,
    brightYellow: t.brightYellow,
    brightBlue: t.brightBlue,
    brightMagenta: t.brightMagenta,
    brightCyan: t.brightCyan,
    brightWhite: t.brightWhite,
  }
}

/** 判断是否为重度使用光标控制序列的 provider（Codex / Gemini） */
function isHeavyCursorProvider(providerId?: string): boolean {
  return providerId === 'codex' || providerId === 'gemini-cli'
}

// 对重度光标控制输出做清洗：保留颜色样式，移除会污染 scrollback 的重绘控制序列。
function sanitizeCursorHeavyOutput(input: string): string {
  if (!input) return ''

  return input
    // OSC 序列：ESC ] ... BEL/ST
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    // DCS/APC/PM 序列
    .replace(/\x1B(?:P|\^|_)[\s\S]*?\x1B\\/g, '')
    // DEC private mode（set/reset）：ESC[?...h / ESC[?...l
    .replace(/\x1B\[\?[0-9;]*[hl]/g, '')
    // 光标控制 & 屏幕操作（不含 m，保留 SGR 颜色）
    .replace(/\x1B\[[0-9;]*[ABCDGHJKfhlnsuSTLMPX@]/g, '')
    // 8-bit CSI 光标控制
    .replace(/\x9B[0-9;]*[ABCDGHJKfhlnsuSTLMPX@]/g, '')
    // 回车覆写：只保留最后一次覆盖内容
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line
      const parts = line.split('\r').filter(Boolean)
      return parts[parts.length - 1] || ''
    })
    .join('\n')
    // 清理残留控制字符（保留 \n \t \r 和 ESC 用于 SGR）
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]/g, '')
}

/**
 * 自定义终端 Hook
 * @param sessionId 会话ID
 * @param containerRef 终端容器引用
 */
export default function useTerminal(
  sessionId: string,
  containerRef: RefObject<HTMLDivElement>
): UseTerminalReturn {
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const theme = useUIStore((s) => s.theme)

  useEffect(() => {
    if (!containerRef.current) return

    // Codex / Gemini 大量使用光标定位做并行任务展示，
    // 回放时旧帧堆积在 scrollback 产生幻影行，需要在回放后 clear()。
    const pid = useSessionStore.getState().sessions.find((x) => x.id === sessionId)?.providerId
    const isHeavyProvider = isHeavyCursorProvider(pid)

    // 创建终端实例
    const term = new Terminal({
      theme: getTerminalTheme(useUIStore.getState().theme),
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 14,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      rows: 24,
      cols: 80,
    })

    // 加载插件
    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()

    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)

    // 挂载到容器
    term.open(containerRef.current)

    // 适配大小 — 使用双重 rAF 确保容器完成布局后再 fit
    let initialFitRaf = requestAnimationFrame(() => {
      initialFitRaf = requestAnimationFrame(() => {
        if (containerRef.current && containerRef.current.offsetWidth > 0) {
          fitAddon.fit()
        }
      })
    })

    terminalRef.current = term
    fitAddonRef.current = fitAddon

    // 实时输出监听 + 历史回放：
    // 在历史回放完成前，将实时数据暂存到队列（避免与缓冲区内容重复写入）
    let historyDone = false
    const pendingQueue: string[] = []

    // 实时输出必须原样传给 xterm（Codex 的光标定位序列在实时渲染中是必须的）
    // sanitizer 仅用于回放，不能用于实时流
    const unsubscribeOutput = window.spectrAI.session.onOutput((sid: string, data: string) => {
      if (sid === sessionId) {
        if (historyDone) {
          term.write(data)
        } else {
          pendingQueue.push(data)
        }
      }
    })

    // 回放主进程缓冲区中的历史输出（解决终端挂载前的输出丢失问题）
    // 关键：write() 是异步的，historyDone 必须在 write 回调中设置，
    // 否则回放数据与实时队列数据交叉写入导致乱码。
    window.spectrAI.session.getOutput(sessionId).then((chunks: string[]) => {
      if (chunks && chunks.length > 0) {
        const replayRaw = chunks.join('')
        const replayData = isHeavyProvider ? sanitizeCursorHeavyOutput(replayRaw) : replayRaw
        if (replayData) {
          term.write(replayData, () => {
            // 全部解析完毕后才切换到实时写入模式
            historyDone = true
            // 队列中的数据与缓冲区快照大概率重叠，丢弃避免重复
            pendingQueue.length = 0
          })
        } else {
          // 全部解析完毕后才切换到实时写入模式
          historyDone = true
          // 队列中的数据与缓冲区快照大概率重叠，丢弃避免重复
          pendingQueue.length = 0
        }
      } else {
        historyDone = true
        pendingQueue.length = 0
      }
    }).catch(() => {
      // 获取历史失败，flush 队列中已有的实时数据
      historyDone = true
      for (const data of pendingQueue) {
        term.write(data)
      }
      pendingQueue.length = 0
    })

    // 监听用户输入
    const onDataDisposable = term.onData((data) => {
      window.spectrAI.session.sendInput(sessionId, data)
    })

    // 处理 Ctrl/Cmd + V 粘贴、Ctrl/Cmd + C 复制
    // 注意：必须调用 event.preventDefault() 阻止浏览器/Electron 默认行为，
    // 因为 xterm.js 的 attachCustomKeyEventHandler 返回 false 只阻止 xterm 处理，
    // 不会阻止 DOM 事件的默认行为（如浏览器 copy/paste 命令）
    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      const isAccel = event.ctrlKey || event.metaKey

      // Ctrl/Cmd+V 或 Ctrl/Cmd+Shift+V：粘贴
      if (event.type === 'keydown' && key === 'v' && isAccel) {
        event.preventDefault()
        event.stopPropagation()
        const text = window.spectrAI.clipboard.readText()
        if (text) {
          window.spectrAI.session.sendInput(sessionId, text)
        }
        return false // 阻止 xterm 默认处理
      }

      // Ctrl/Cmd+C / Ctrl/Cmd+Shift+C：
      // - 有选中内容：复制并阻止默认行为
      // - 无选中内容：
      //   - Ctrl+C 让 xterm 正常发送 ^C（终止当前命令）
      //   - Cmd+C 仅作为复制快捷键，不发送 ^C
      if (event.type === 'keydown' && key === 'c' && isAccel) {
        const selection = term.getSelection()
        if (selection) {
          event.preventDefault()
          event.stopPropagation()
          window.spectrAI.clipboard.writeText(selection)
          term.clearSelection()
          return false
        }

        // Cmd+C 无选中文本时不向终端发送中断信号
        if (event.metaKey) {
          return false
        }

        // Ctrl+Shift+C 无选中文本时也阻止（避免发送 ^C）
        if (event.shiftKey) {
          return false
        }

        // Ctrl+C（无选中）让 xterm 正常发送 ^C 信号
        return true
      }

      return true
    })

    // 右键粘贴
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      const text = window.spectrAI.clipboard.readText()
      if (text) {
        window.spectrAI.session.sendInput(sessionId, text)
      }
    }
    containerRef.current.addEventListener('contextmenu', handleContextMenu)

    // 监听窗口大小变化
    const handleResize = () => {
      if (fitAddonRef.current) {
        fitAddonRef.current.fit()
        // 通知后端更新伪终端大小
        const { cols, rows } = term
        window.spectrAI.session.resize(sessionId, cols, rows)
      }
    }

    window.addEventListener('resize', handleResize)

    // 监听终端大小变化（例如用户调整分栏大小）
    // 添加防抖避免密集 resize 时 fit() 竞态导致滚动失效
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        // 跳过尺寸为 0 的情况（容器被隐藏时）
        if (containerRef.current && containerRef.current.offsetWidth > 0 && containerRef.current.offsetHeight > 0) {
          handleResize()
        }
      }, 50)
    })

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current)
    }

    // 提前保存容器引用，cleanup 时 containerRef.current 可能已为 null
    const container = containerRef.current

    // 清理
    return () => {
      cancelAnimationFrame(initialFitRaf)
      if (resizeTimer) clearTimeout(resizeTimer)
      onDataDisposable.dispose()
      unsubscribeOutput()
      window.removeEventListener('resize', handleResize)
      container?.removeEventListener('contextmenu', handleContextMenu)
      resizeObserver.disconnect()
      term.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [sessionId, containerRef])

  // 监听主题变化，实时更新终端配色
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = getTerminalTheme(theme)
    }
  }, [theme])

  return {
    terminal: terminalRef.current,
    fitAddon: fitAddonRef.current,
  }
}
