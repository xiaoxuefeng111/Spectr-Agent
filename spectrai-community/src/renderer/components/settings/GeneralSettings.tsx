/**
 * 通用全局设置面板
 */

import React, { useEffect, useState } from 'react'
import { X, FolderGit2, Power, RefreshCw, ExternalLink } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'

interface GeneralSettingsProps {
  onClose: () => void
}

type UpdateState = {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  currentVersion: string
  latestVersion?: string
  isMajorUpdate?: boolean
  releaseNotes?: string
  percent?: number
  message?: string
}

const GeneralSettings: React.FC<GeneralSettingsProps> = ({ onClose }) => {
  const { settings, updateSetting } = useSettingsStore()
  const [updateState, setUpdateState] = useState<UpdateState | null>(null)
  const [updating, setUpdating] = useState(false)

  useEffect(() => {
    let cancelled = false

    const loadState = async () => {
      try {
        const state = await window.spectrAI.update.getState()
        if (!cancelled) setUpdateState(state)
      } catch {
        // ignore
      }
    }

    void loadState()
    const unsubscribe = window.spectrAI.update.onStateChanged((state) => {
      setUpdateState(state)
    })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  const handleCheckUpdate = async () => {
    setUpdating(true)
    try {
      const result = await window.spectrAI.update.checkForUpdates(true)
      setUpdateState(result.state)
    } finally {
      setUpdating(false)
    }
  }

  const handleDownloadUpdate = async () => {
    setUpdating(true)
    try {
      const result = await window.spectrAI.update.downloadUpdate()
      setUpdateState(result.state)
    } finally {
      setUpdating(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-bg-secondary rounded-xl shadow-2xl w-full max-w-md border border-border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-text-primary">通用设置</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Power className="w-4 h-4 text-accent-blue" />
              <h3 className="text-sm font-medium text-text-primary">启动行为</h3>
            </div>

            <label className="flex items-start gap-3 cursor-pointer group">
              <div className="mt-0.5">
                <div
                  role="switch"
                  aria-checked={settings.autoLaunch}
                  onClick={() => updateSetting('autoLaunch', !settings.autoLaunch)}
                  className={[
                    'relative w-9 h-5 rounded-full transition-colors cursor-pointer flex-shrink-0',
                    settings.autoLaunch ? 'bg-accent-blue' : 'bg-bg-tertiary border border-border',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform',
                      settings.autoLaunch ? 'translate-x-[18px]' : 'translate-x-0.5',
                    ].join(' ')}
                  />
                </div>
              </div>
              <div>
                <div className="text-sm text-text-primary group-hover:text-text-primary transition-colors">开机时自动启动</div>
                <div className="text-xs text-text-muted mt-0.5 leading-relaxed">开启后，系统登录时将自动启动 SpectrAI。</div>
              </div>
            </label>
          </div>

          <div className="border-t border-border" />

          <div>
            <div className="flex items-center gap-2 mb-3">
              <FolderGit2 className="w-4 h-4 text-accent-blue" />
              <h3 className="text-sm font-medium text-text-primary">Git Worktree 隔离</h3>
            </div>

            <label className="flex items-start gap-3 cursor-pointer group">
              <div className="mt-0.5">
                <div
                  role="switch"
                  aria-checked={settings.autoWorktree}
                  onClick={() => updateSetting('autoWorktree', !settings.autoWorktree)}
                  className={[
                    'relative w-9 h-5 rounded-full transition-colors cursor-pointer flex-shrink-0',
                    settings.autoWorktree ? 'bg-accent-blue' : 'bg-bg-tertiary border border-border',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform',
                      settings.autoWorktree ? 'translate-x-[18px]' : 'translate-x-0.5',
                    ].join(' ')}
                  />
                </div>
              </div>
              <div>
                <div className="text-sm text-text-primary group-hover:text-text-primary transition-colors">新建任务时默认启用 Worktree 隔离</div>
                <div className="text-xs text-text-muted mt-0.5 leading-relaxed">每个任务在独立分支目录工作，降低并行开发冲突。</div>
              </div>
            </label>
          </div>

          <div className="border-t border-border" />

          <div>
            <div className="flex items-center gap-2 mb-3">
              <RefreshCw className="w-4 h-4 text-accent-blue" />
              <h3 className="text-sm font-medium text-text-primary">应用更新</h3>
            </div>
            <div className="text-xs text-text-secondary mb-2">
              当前版本：{updateState?.currentVersion || '未知'}
              {updateState?.latestVersion ? ` · 最新：${updateState.latestVersion}` : ''}
            </div>
            {updateState?.message && <div className="text-xs text-text-muted mb-2">{updateState.message}</div>}
            {typeof updateState?.percent === 'number' && (
              <div className="text-xs text-accent-blue mb-2">下载进度：{updateState.percent.toFixed(1)}%</div>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleCheckUpdate}
                disabled={updating || updateState?.status === 'checking'}
                className="px-3 py-1.5 rounded text-xs bg-bg-tertiary border border-border text-text-primary hover:border-accent-blue/30 disabled:opacity-50"
              >
                检查更新
              </button>

              {(updateState?.status === 'available' || updateState?.status === 'downloading') && !updateState?.isMajorUpdate && (
                <button
                  onClick={handleDownloadUpdate}
                  disabled={updating || updateState?.status === 'downloading'}
                  className="px-3 py-1.5 rounded text-xs bg-accent-blue text-white hover:opacity-90 disabled:opacity-50"
                >
                  下载更新
                </button>
              )}

              {updateState?.status === 'downloaded' && (
                <button
                  onClick={() => void window.spectrAI.update.quitAndInstall()}
                  className="px-3 py-1.5 rounded text-xs bg-green-600 text-white hover:opacity-90"
                >
                  重启并安装
                </button>
              )}

              {(updateState?.isMajorUpdate || updateState?.status === 'error') && (
                <button
                  onClick={() => void window.spectrAI.update.openDownloadPage()}
                  className="px-3 py-1.5 rounded text-xs bg-bg-tertiary border border-border text-text-primary hover:border-accent-blue/30 inline-flex items-center gap-1"
                >
                  官网下载 <ExternalLink className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-border bg-bg-primary/50 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm bg-accent-blue text-white rounded hover:bg-accent-blue/80 transition-colors"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  )
}

GeneralSettings.displayName = 'GeneralSettings'
export default GeneralSettings
