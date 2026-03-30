/**
 * 清洗终端/日志文本中的控制序列，避免 UI 出现乱码或异常空白。
 */
export function sanitizeDisplayText(input: string): string {
  if (!input) return ''

  return input
    // OSC: ESC ] ... BEL 或 ESC ] ... ST
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    // CSI: ESC [ ... finalByte
    .replace(/\x1B\[[\x20-\x3F]*[\x40-\x7E]/g, '')
    // 8-bit CSI
    .replace(/\x9B[\x20-\x3F]*[\x40-\x7E]/g, '')
    // DCS / APC / PM: ESC P/^/_ ... ST
    .replace(/\x1B(?:P|\^|_)[\s\S]*?\x1B\\/g, '')
    // 残留 ESC
    .replace(/\x1B/g, '')
    // 回车覆写：保留最后一次覆盖内容
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line
      const parts = line.split('\r').filter(Boolean)
      return parts[parts.length - 1] || ''
    })
    .join('\n')
    // 控制字符（保留 \n 与 \t）
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // 零宽字符
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    // 压缩过量空行，避免出现超长“空白滚动区”
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

