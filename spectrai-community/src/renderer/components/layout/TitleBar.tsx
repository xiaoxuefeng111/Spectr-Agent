/**
 * 自定义标题栏 - VSCode 风格
 * 提供可拖拽区域，展示应用标识；原生窗口控制按钮由 titleBarOverlay 渲染
 *
 * 平台差异：
 * - Windows: titleBarStyle='hidden' + titleBarOverlay，窗口控制按钮在右侧，右侧预留 w-36
 * - macOS:   titleBarStyle='hiddenInset'，Traffic Light 在左侧，左侧需预留 ~72px 空间
 */

import { Zap } from 'lucide-react'

const isMac =
  typeof navigator !== 'undefined' &&
  (/Mac/i.test(navigator.platform) || /Mac/i.test(navigator.userAgent))

export default function TitleBar() {
  return (
    <div
      className="flex items-center h-9 bg-bg-secondary border-b border-border flex-shrink-0 select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* macOS：左侧预留 Traffic Light 空间（close/minimize/fullscreen，约 72px） */}
      {isMac && <div className="w-[72px] flex-shrink-0" />}

      {/* App 图标 + 名称（需标记 no-drag，否则点击无法触发） */}
      <div
        className="flex items-center gap-1.5 px-3.5"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <Zap size={13} className="text-accent-blue" strokeWidth={2.5} />
        <span className="text-xs font-semibold text-text-primary tracking-wide">
          SpectrAI
        </span>
      </div>

      {/* 中间：纯拖拽区域（flex-1 撑满剩余宽度） */}
      <div className="flex-1" />

      {/* 右侧预留约 140px 给原生窗口控制按钮（Windows: 最小化/最大化/关闭） */}
      {!isMac && <div className="w-36 flex-shrink-0" />}
    </div>
  )
}
