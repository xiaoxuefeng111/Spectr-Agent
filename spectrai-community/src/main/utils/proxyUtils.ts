/**
 * 代理工具函数 — 跨模块共享
 *
 * 提供从进程环境变量 / Windows PowerShell profile 读取代理 URL 的能力，
 * 供 AI 连接（ClaudeSdkAdapter）等模块复用。
 */

import { execSync } from 'child_process'

/** PowerShell 读取结果缓存（undefined = 尚未读取，null = 未找到代理） */
let psProxyCache: string | null | undefined = undefined

/**
 * 从可能包含多行文本的字符串中提取第一个合法的代理 URL。
 *
 * 场景：PowerShell profile 加载时可能向 stdout 输出额外文字
 * （如 "启动代理 Proxy auto-configured on port 7897"），
 * execSync 会将这些前缀文字与实际 URL 一并捕获，导致整段文本
 * 无法被 new URL() 解析。此函数按行扫描，找到第一个以合法协议
 * 开头的行并返回，忽略其他噪声行。
 *
 * @param raw 原始字符串（可能多行）
 * @returns 提取到的代理 URL，或 null
 */
function extractValidProxyUrl(raw: string): string | null {
  const lines = raw.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^(https?|socks5?):\/\//i.test(trimmed)) {
      return trimmed
    }
  }
  return null
}

/**
 * 从当前运行环境读取代理 URL，优先级：
 *   1. 进程环境变量（HTTPS_PROXY / HTTP_PROXY / ALL_PROXY，大小写均支持）
 *   2. Windows：通过 PowerShell 读取 profile 中设置的代理环境变量（带内存缓存）
 *
 * @returns 代理 URL 字符串（如 "http://127.0.0.1:7890" / "socks5://127.0.0.1:7891"）
 *          或 null（未检测到任何代理）
 */
export function readProxyUrlFromEnvironment(): string | null {
  // ── 优先：当前进程环境变量 ──
  // 环境变量值本身可能也含多行文本（某些代理工具写入时附带描述），
  // 同样通过 extractValidProxyUrl 提取干净的 URL。
  const envProxy =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY  || process.env.http_proxy  ||
    process.env.ALL_PROXY   || process.env.all_proxy
  if (envProxy) {
    return extractValidProxyUrl(envProxy) ?? envProxy
  }

  // ── Windows 兜底：从 PowerShell profile 读取（带缓存，避免重复执行） ──
  if (process.platform === 'win32') {
    if (psProxyCache !== undefined) return psProxyCache

    try {
      // 读取 PowerShell 进程中的代理环境变量（会加载用户 profile）。
      // 注意：profile 加载时可能向 stdout 输出额外文字（如代理工具的提示信息），
      // execSync 会将其与实际环境变量值一并捕获，因此用 extractValidProxyUrl 过滤。
      const psScript = [
        "foreach ($v in @('HTTPS_PROXY','HTTP_PROXY','ALL_PROXY')) {",
        "  $val = (Get-ChildItem Env: -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $v }).Value",
        "  if ($val) { Write-Output $val; break }",
        "}"
      ].join('\n')

      const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
      const output = execSync(`powershell -EncodedCommand ${encoded}`, {
        encoding: 'utf8',
        timeout: 10000,
      }).trim()

      psProxyCache = extractValidProxyUrl(output) ?? (output || null)
      return psProxyCache
    } catch {
      psProxyCache = null
      return null
    }
  }

  return null
}

/** 清除 PowerShell 代理缓存（测试或热重载时使用） */
export function clearProxyCache(): void {
  psProxyCache = undefined
}
