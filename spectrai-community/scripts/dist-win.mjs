import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

function runOrExit(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function formatTimestamp(date = new Date()) {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`
}

function isOutputDirLocked(outputDir) {
  if (process.platform !== 'win32') return false

  const tasklistResult = spawnSync('tasklist', ['/FI', 'IMAGENAME eq SpectrAI.exe', '/NH'], {
    encoding: 'utf8',
    shell: false,
  })
  if (tasklistResult.stdout && tasklistResult.stdout.toLowerCase().includes('spectrai.exe')) {
    console.warn('[dist] Detected SpectrAI.exe is running, output dir may be locked')
    return true
  }

  const winUnpacked = path.join(outputDir, 'win-unpacked')
  if (!fs.existsSync(winUnpacked)) return false
  const tempDir = `${winUnpacked}.locktest`
  try {
    fs.renameSync(winUnpacked, tempDir)
    fs.renameSync(tempDir, winUnpacked)
    return false
  } catch {
    try {
      if (fs.existsSync(tempDir) && !fs.existsSync(winUnpacked)) {
        fs.renameSync(tempDir, winUnpacked)
      }
    } catch {
      // best effort
    }
    return true
  }
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'

// Usage:
// node scripts/dist-win.mjs [baseDir] [--publish-latest]
// Example:
// node scripts/dist-win.mjs release-new --publish-latest
const baseOutputDir = process.argv[2] || 'release'
const publishLatest = process.argv.includes('--publish-latest')

let outputDir = baseOutputDir
if (isOutputDirLocked(baseOutputDir)) {
  outputDir = path.join(baseOutputDir, `dist-${formatTimestamp()}`)
  console.warn(`[dist] Switched output dir to: ${outputDir}`)
}

runOrExit(npx, ['electron-vite', 'build'])

const builderArgs = ['electron-builder', '--win', `--config.directories.output=${outputDir}`]
if (publishLatest) {
  builderArgs.push('--publish', 'always')
  builderArgs.push('--config.publish.provider=generic')
  builderArgs.push('--config.publish.url=http://claudeops.wbdao.cn/releases/stable/win/x64')
}
runOrExit(npx, builderArgs)

console.log(`[dist] Build done, output: ${outputDir}`)
