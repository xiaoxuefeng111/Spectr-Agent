import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

function parseSemver(version: string): [number, number, number] | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return false
    if (process.platform === 'win32') return true
    return (stat.mode & 0o111) !== 0
  } catch {
    return false
  }
}

function getPathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'PATH'
}

function findNvmWindowsHome(): string | null {
  const nvmHome = process.env.NVM_HOME
  if (nvmHome && fs.existsSync(nvmHome)) return nvmHome
  return null
}

function findUnixNvmDir(): string | null {
  const candidates = [
    process.env.NVM_DIR,
    path.join(os.homedir(), '.nvm'),
  ].filter(Boolean) as string[]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate
    }
  }
  return null
}

function resolveVersionDir(version: string): string[] {
  if (process.platform === 'win32') {
    const nvmHome = findNvmWindowsHome()
    if (!nvmHome) return []
    return [
      path.join(nvmHome, `v${version}`),
      path.join(nvmHome, version),
    ]
  }

  const nvmDir = findUnixNvmDir()
  if (!nvmDir) return []
  return [
    path.join(nvmDir, 'versions', 'node', `v${version}`),
    path.join(nvmDir, 'versions', 'node', version),
  ]
}

/**
 * 返回指定 Node 版本的 bin 目录。
 * Windows: .../vX.Y.Z
 * Unix/macOS: .../vX.Y.Z/bin
 */
export function resolveNodeBinDir(version: string): string | null {
  const candidates = resolveVersionDir(version)
  for (const dir of candidates) {
    const nodePath = process.platform === 'win32'
      ? path.join(dir, 'node.exe')
      : path.join(dir, 'bin', 'node')
    if (isExecutableFile(nodePath)) {
      return process.platform === 'win32' ? dir : path.dirname(nodePath)
    }
  }
  return null
}

/**
 * 列出当前系统 nvm 已安装的 Node 版本（仅 semver）。
 */
export function listInstalledNodeVersions(): string[] {
  if (process.platform === 'win32') {
    const nvmHome = findNvmWindowsHome()
    if (!nvmHome) return []
    try {
      return fs.readdirSync(nvmHome)
        .map((entry) => entry.replace(/^v/, ''))
        .filter((version) => parseSemver(version) !== null)
        .sort((a, b) => {
          const pa = parseSemver(a)!
          const pb = parseSemver(b)!
          if (pa[0] !== pb[0]) return pb[0] - pa[0]
          if (pa[1] !== pb[1]) return pb[1] - pa[1]
          return pb[2] - pa[2]
        })
    } catch {
      return []
    }
  }

  const nvmDir = findUnixNvmDir()
  if (!nvmDir) return []
  const versionsRoot = path.join(nvmDir, 'versions', 'node')
  if (!fs.existsSync(versionsRoot)) return []

  try {
    return fs.readdirSync(versionsRoot)
      .map((entry) => entry.replace(/^v/, ''))
      .filter((version) => parseSemver(version) !== null)
      .sort((a, b) => {
        const pa = parseSemver(a)!
        const pb = parseSemver(b)!
        if (pa[0] !== pb[0]) return pb[0] - pa[0]
        if (pa[1] !== pb[1]) return pb[1] - pa[1]
        return pb[2] - pa[2]
      })
  } catch {
    return []
  }
}

/**
 * 在现有 PATH 前面注入指定 Node 版本目录（如果存在）。
 */
export function prependNodeVersionToEnvPath(env: NodeJS.ProcessEnv, version?: string): NodeJS.ProcessEnv {
  if (!version) return env
  const nodeBinDir = resolveNodeBinDir(version)
  if (!nodeBinDir) return env

  const result = { ...env }
  const pathKey = getPathKey(result)
  const separator = process.platform === 'win32' ? ';' : ':'
  const current = result[pathKey] || ''
  const segments = current.split(separator).filter(Boolean)
  if (!segments.includes(nodeBinDir)) {
    segments.unshift(nodeBinDir)
  }
  if (pathKey !== 'PATH') delete result[pathKey]
  result.PATH = segments.join(separator)
  return result
}

