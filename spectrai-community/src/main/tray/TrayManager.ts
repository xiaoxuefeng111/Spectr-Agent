/**
 * 系统托盘管理器
 * @author weibin
 */

import { Tray, Menu, BrowserWindow, nativeImage, app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'

/**
 * 系统托盘管理器
 * 负责托盘图标、菜单和徽章
 */
export class TrayManager {
  /** 托盘实例 */
  private tray: Tray | null = null

  /** 徽章计数 */
  private badgeCount: number = 0

  /** 主窗口引用 */
  private mainWindow: BrowserWindow | null = null

  /**
   * 统一唤起主窗口（恢复最小化 + 显示 + 聚焦）
   */
  private revealMainWindow(): void {
    if (!this.mainWindow) return
    if (this.mainWindow.isMinimized()) {
      this.mainWindow.restore()
    }
    if (!this.mainWindow.isVisible()) {
      this.mainWindow.show()
    }
    this.mainWindow.focus()
  }

  /**
   * 初始化托盘
   * @param mainWindow 主窗口实例
   */
  init(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow

    // 平台差异：
    // - Windows: 使用 .ico
    // - macOS: 使用 PNG 并标记为 template image，适配菜单栏亮/暗模式
    const isDev = !app.isPackaged
    const iconPath = process.platform === 'darwin'
      ? (isDev
        ? join(app.getAppPath(), 'build/icon-16.png')
        : join(process.resourcesPath, 'trayIcon.png'))
      : (isDev
        ? join(app.getAppPath(), 'build/icon.ico')
        : join(process.resourcesPath, 'icon.ico'))

    let icon: Electron.NativeImage
    if (existsSync(iconPath)) {
      icon = nativeImage.createFromPath(iconPath)
      // 托盘图标推荐 16x16，自动缩放
      icon = icon.resize({ width: 16, height: 16 })
      if (process.platform === 'darwin') {
        icon.setTemplateImage(true)
      }
    } else {
      // 兜底：使用默认蓝色图标
      icon = this.createDefaultIcon()
    }

    this.tray = new Tray(icon)
    this.tray.setToolTip('SpectrAI - Claude Code 会话管理')

    // 创建上下文菜单
    this.updateContextMenu()

    // 点击托盘图标显示/隐藏主窗口
    this.tray.on('click', () => {
      if (this.mainWindow) {
        if (this.mainWindow.isVisible()) {
          this.mainWindow.hide()
        } else {
          this.revealMainWindow()
        }
      }
    })
  }

  /**
   * 创建默认图标（纯色 16x16 图标）
   */
  private createDefaultIcon(): Electron.NativeImage {
    // 创建 16x16 RGBA 缓冲区（蓝色：#58A6FF）
    const size = 16
    const buffer = Buffer.alloc(size * size * 4)

    for (let i = 0; i < size * size; i++) {
      buffer[i * 4] = 0x58     // R
      buffer[i * 4 + 1] = 0xA6 // G
      buffer[i * 4 + 2] = 0xFF // B
      buffer[i * 4 + 3] = 0xFF // A
    }

    return nativeImage.createFromBuffer(buffer, { width: size, height: size })
  }

  /**
   * 更新上下文菜单
   */
  private updateContextMenu(): void {
    if (!this.tray) return

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => {
          if (this.mainWindow) {
            this.revealMainWindow()
          }
        }
      },
      { type: 'separator' },
      {
        label: '新建会话',
        click: () => {
          if (this.mainWindow) {
            this.revealMainWindow()
            this.mainWindow.webContents.send('tray-new-session')
          }
        }
      },
      {
        label: '暂停所有会话',
        click: () => {
          if (this.mainWindow) {
            this.mainWindow.webContents.send('tray-pause-all')
          }
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.quit()
        }
      }
    ])

    this.tray.setContextMenu(contextMenu)
  }

  /**
   * 增加徽章计数
   */
  incrementBadge(): void {
    this.badgeCount++
    this.updateBadge()
  }

  /**
   * 减少徽章计数
   */
  decrementBadge(count: number = 1): void {
    this.badgeCount = Math.max(0, this.badgeCount - count)
    this.updateBadge()
  }

  /**
   * 清除徽章计数
   */
  clearBadge(): void {
    this.badgeCount = 0
    this.updateBadge()
  }

  /**
   * 更新徽章显示
   */
  private updateBadge(): void {
    if (!this.mainWindow) return

    // Windows 平台使用 overlay icon
    if (process.platform === 'win32') {
      if (this.badgeCount > 0) {
        // 创建简单的红色圆形徽章（16x16 像素缓冲区）
        const size = 16
        const buffer = Buffer.alloc(size * size * 4)
        const center = size / 2
        const radius = size / 2

        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const dist = Math.sqrt((x - center) ** 2 + (y - center) ** 2)
            const idx = (y * size + x) * 4

            if (dist <= radius) {
              buffer[idx] = 0xF8     // R (red)
              buffer[idx + 1] = 0x51 // G
              buffer[idx + 2] = 0x49 // B
              buffer[idx + 3] = 0xFF // A
            } else {
              buffer[idx + 3] = 0x00 // transparent
            }
          }
        }

        const badgeImage = nativeImage.createFromBuffer(buffer, { width: size, height: size })
        this.mainWindow.setOverlayIcon(badgeImage, `${this.badgeCount} 个待处理通知`)
      } else {
        this.mainWindow.setOverlayIcon(null, '')
      }
    }

    // macOS 使用 dock badge
    if (process.platform === 'darwin') {
      app.dock?.setBadge(this.badgeCount > 0 ? this.badgeCount.toString() : '')
    }

    // 更新托盘提示文本
    this.updateTooltip(
      this.badgeCount > 0
        ? `SpectrAI - ${this.badgeCount} 个待处理通知`
        : 'SpectrAI - Claude Code 会话管理'
    )
  }

  /**
   * 更新托盘提示文本
   * @param text 提示文本
   */
  updateTooltip(text: string): void {
    if (this.tray) {
      this.tray.setToolTip(text)
    }
  }

  /**
   * 销毁托盘
   */
  destroy(): void {
    if (this.tray) {
      this.tray.destroy()
      this.tray = null
    }
  }
}
