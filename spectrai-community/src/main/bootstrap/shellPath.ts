import { execFileSync } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { logger } from '../logger'

const PATH_BEGIN = '__CLAUDEOPS_PATH_BEGIN__'
const PATH_END = '__CLAUDEOPS_PATH_END__'
const SHELL_PATH_TIMEOUT_MS = 3000

function parsePathFromShellOutput(output: string): string | null {
  const begin = output.indexOf(PATH_BEGIN)
  const end = output.indexOf(PATH_END)
  if (begin < 0 || end < 0 || end <= begin) return null
  return output.slice(begin + PATH_BEGIN.length, end).trim() || null
}

function dedupePathEntries(entries: string[]): string[] {
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const entry of entries) {
    const clean = entry.trim()
    if (!clean) continue
    if (seen.has(clean)) continue
    seen.add(clean)
    deduped.push(clean)
  }
  return deduped
}

function getUserFallbackDirs(): string[] {
  const home = process.env.HOME
  if (!home) return []

  const candidates: string[] = [
    join(home, '.local', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.npm-global', 'bin'),
  ]

  // pip --user 默认脚本目录：~/Library/Python/<major.minor>/bin
  const pyRoot = join(home, 'Library', 'Python')
  if (existsSync(pyRoot)) {
    try {
      for (const versionDir of readdirSync(pyRoot)) {
        candidates.push(join(pyRoot, versionDir, 'bin'))
      }
    } catch {
      // ignore
    }
  }

  return candidates.filter((dir) => existsSync(dir))
}

function getHomebrewPythonDirs(): string[] {
  const roots = ['/opt/homebrew/opt', '/usr/local/opt']
  const dirs: string[] = []

  for (const root of roots) {
    if (!existsSync(root)) continue
    try {
      for (const name of readdirSync(root)) {
        if (name !== 'python' && !name.startsWith('python@')) continue
        dirs.push(join(root, name, 'libexec', 'bin'))
      }
    } catch {
      // ignore
    }
  }

  return dirs.filter((dir) => existsSync(dir))
}

/**
 * Finder 启动 app 时，PATH 往往不包含 nvm/homebrew/npm global 目录。
 * 该函数在 macOS 早期执行，尽量恢复交互 shell PATH。
 */
export function bootstrapShellPath(): void {
  if (process.platform !== 'darwin') return

  const shell = process.env.SHELL || '/bin/zsh'
  const currentPath = process.env.PATH || ''
  const separator = ':'
  const fallbackDirs = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    ...getHomebrewPythonDirs(),
    ...getUserFallbackDirs(),
  ]

  let shellPath: string | null = null
  try {
    const markerCmd = `printf '${PATH_BEGIN}%s${PATH_END}' "$PATH"`
    const output = execFileSync(shell, ['-ilc', markerCmd], {
      encoding: 'utf8',
      timeout: SHELL_PATH_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        TERM: process.env.TERM || 'xterm-256color',
      },
    })
    shellPath = parsePathFromShellOutput(output)
  } catch (error: any) {
    logger.warn(`[shellPath] Failed to read interactive shell PATH: ${error?.message || error}`)
  }

  const fromShell = shellPath ? shellPath.split(separator) : []
  const fromCurrent = currentPath.split(separator)
  const fromFallback = fallbackDirs.filter((dir) => existsSync(dir))
  const merged = dedupePathEntries([...fromShell, ...fromCurrent, ...fromFallback])

  if (merged.length === 0) {
    logger.warn('[shellPath] PATH bootstrap skipped: no valid path entries found')
    return
  }

  process.env.PATH = merged.join(separator)
  const preview = merged.slice(0, 6).join(separator)
  logger.info(`[shellPath] PATH bootstrapped (${merged.length} entries): ${preview}`)
}
