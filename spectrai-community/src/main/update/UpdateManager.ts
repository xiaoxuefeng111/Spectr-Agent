import { app, shell, type BrowserWindow } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import { EventEmitter } from 'events'
import { IPC } from '../../shared/constants'

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  latestVersion?: string
  isMajorUpdate?: boolean
  releaseNotes?: string
  percent?: number
  message?: string
}

export interface UpdatePolicy {
  forceUpgradeFrom?: string
  minSupportedVersion?: string
  downloadUrl?: string
  notice?: string
}

const DEFAULT_FEED_BASE = 'http://claudeops.wbdao.cn/releases'
const DEFAULT_POLICY_URL = 'http://claudeops.wbdao.cn/api/update-policy.json'

export class UpdateManager extends EventEmitter {
  private state: UpdateState = {
    status: 'idle',
    currentVersion: app.getVersion(),
  }

  private initialized = false
  private policy: UpdatePolicy | null = null
  private intervalTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly getMainWindow: () => BrowserWindow | null,
    private readonly getAppSettings: () => Record<string, any>,
  ) {
    super()
  }

  init(): void {
    if (this.initialized) return
    this.initialized = true

    if (!app.isPackaged) {
      this.setState({
        status: 'idle',
        message: 'Update checks are disabled in development mode.',
      })
      return
    }

    this.configureAutoUpdater()
    this.bindAutoUpdaterEvents()

    setTimeout(() => {
      void this.checkForUpdates(false)
    }, 10_000)

    this.intervalTimer = setInterval(() => {
      void this.checkForUpdates(false)
    }, 6 * 60 * 60 * 1000)
  }

  cleanup(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer)
      this.intervalTimer = null
    }
  }

  getState(): UpdateState {
    return { ...this.state }
  }

  async checkForUpdates(manual: boolean): Promise<{ success: boolean; state: UpdateState }> {
    if (!app.isPackaged) {
      this.setState({
        status: 'idle',
        message: 'Update checks are disabled in development mode.',
      })
      return { success: false, state: this.getState() }
    }

    this.configureAutoUpdater()

    if (manual) {
      this.setState({ status: 'checking', message: 'Checking for updates...' })
    }

    try {
      await this.fetchPolicy()
      await autoUpdater.checkForUpdates()
      return { success: true, state: this.getState() }
    } catch (error: any) {
      this.setState({
        status: 'error',
        message: error?.message || 'Failed to check updates.',
      })
      return { success: false, state: this.getState() }
    }
  }

  async downloadUpdate(): Promise<{ success: boolean; state: UpdateState }> {
    try {
      await autoUpdater.downloadUpdate()
      return { success: true, state: this.getState() }
    } catch (error: any) {
      this.setState({
        status: 'error',
        message: error?.message || 'Failed to download update.',
      })
      return { success: false, state: this.getState() }
    }
  }

  quitAndInstall(): { success: boolean } {
    autoUpdater.quitAndInstall(false, true)
    return { success: true }
  }

  openDownloadPage(): { success: boolean } {
    const url = this.policy?.downloadUrl || 'http://claudeops.wbdao.cn/'
    void shell.openExternal(url)
    return { success: true }
  }

  private configureAutoUpdater(): void {
    const settings = this.getAppSettings()
    const channel = settings.updateChannel === 'beta' ? 'beta' : 'stable'
    const feedBase = typeof settings.updateFeedBase === 'string' && settings.updateFeedBase
      ? settings.updateFeedBase
      : DEFAULT_FEED_BASE

    const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : process.platform
    const arch = process.arch === 'x64' ? 'x64' : process.arch
    const feedUrl = `${feedBase}/${channel}/${platform}/${arch}`

    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = channel === 'beta'
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl, protocol: 'http' } as any)
  }

  private bindAutoUpdaterEvents(): void {
    autoUpdater.on('checking-for-update', () => {
      this.setState({
        status: 'checking',
        message: 'Checking for updates...',
      })
    })

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      const isMajorUpdate = this.isMajorUpdate(info.version)
      const releaseNotes = this.normalizeReleaseNotes(info.releaseNotes)
      const isForced = this.shouldForceUpgrade(this.state.currentVersion)

      this.setState({
        status: 'available',
        latestVersion: info.version,
        isMajorUpdate,
        releaseNotes,
        message: isForced
          ? 'Critical update detected. Please upgrade now.'
          : isMajorUpdate
            ? 'Major version detected. Please review before upgrading.'
            : 'Update available. You can download it in background.',
      })

      const settings = this.getAppSettings()
      const autoDownloadEnabled = settings.autoDownloadUpdate !== false
      if (autoDownloadEnabled && !isMajorUpdate && !isForced) {
        void this.downloadUpdate()
      }
    })

    autoUpdater.on('update-not-available', () => {
      this.setState({
        status: 'not-available',
        message: 'You are already on the latest version.',
      })
    })

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.setState({
        status: 'downloading',
        percent: progress.percent,
        message: `Downloading update ${progress.percent.toFixed(1)}%`,
      })
    })

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this.setState({
        status: 'downloaded',
        latestVersion: info.version,
        releaseNotes: this.normalizeReleaseNotes(info.releaseNotes),
        message: 'Update downloaded. Restart to install.',
      })
    })

    autoUpdater.on('error', (error: Error) => {
      this.setState({
        status: 'error',
        message: error.message || 'Update failed.',
      })
    })
  }

  private async fetchPolicy(): Promise<void> {
    const settings = this.getAppSettings()
    const policyUrl = typeof settings.updatePolicyUrl === 'string' && settings.updatePolicyUrl
      ? settings.updatePolicyUrl
      : DEFAULT_POLICY_URL

    try {
      const res = await fetch(policyUrl, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) return
      const data = await res.json() as UpdatePolicy
      this.policy = data
    } catch {
      // ignore policy request errors
    }
  }

  private shouldForceUpgrade(currentVersion: string): boolean {
    if (!this.policy?.forceUpgradeFrom) return false
    return this.compareVersions(currentVersion, this.policy.forceUpgradeFrom) <= 0
  }

  private isMajorUpdate(nextVersion: string): boolean {
    const currentMajor = Number((this.state.currentVersion || '0').split('.')[0] || '0')
    const nextMajor = Number((nextVersion || '0').split('.')[0] || '0')
    return nextMajor > currentMajor
  }

  private normalizeReleaseNotes(notes: UpdateInfo['releaseNotes']): string | undefined {
    if (!notes) return undefined
    if (typeof notes === 'string') return notes
    if (Array.isArray(notes)) {
      return notes.map((item) => `${item.version || ''}\n${item.note || ''}`.trim()).join('\n\n').trim()
    }
    return undefined
  }

  private compareVersions(a: string, b: string): number {
    const pa = a.split('.').map((v) => Number(v) || 0)
    const pb = b.split('.').map((v) => Number(v) || 0)
    const max = Math.max(pa.length, pb.length)
    for (let i = 0; i < max; i += 1) {
      const va = pa[i] ?? 0
      const vb = pb[i] ?? 0
      if (va > vb) return 1
      if (va < vb) return -1
    }
    return 0
  }

  private setState(patch: Partial<UpdateState>): void {
    this.state = {
      ...this.state,
      ...patch,
      currentVersion: app.getVersion(),
    }
    this.emit('state-changed', this.state)
    this.pushStateToRenderer(this.state)
  }

  private pushStateToRenderer(state: UpdateState): void {
    const win = this.getMainWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send(IPC.UPDATE_STATE_CHANGED, state)
  }
}
