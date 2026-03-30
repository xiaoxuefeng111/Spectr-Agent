/**
 * 主题选择器组件
 * 下拉菜单展示所有可用主题（名称 + 预览色块）
 * @author weibin
 */

import { useState, useRef, useEffect } from 'react'
import { Palette } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import { THEMES, THEME_IDS } from '../../../shared/constants'

export default function ThemeToggle() {
  const theme = useUIStore((s) => s.theme)
  const setTheme = useUIStore((s) => s.setTheme)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const currentTheme = THEMES[theme]

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-bg-hover transition-colors"
        title="切换主题"
        aria-label="切换主题"
      >
        <Palette className="w-3.5 h-3.5 text-text-secondary" />
        <span className="text-[11px] text-text-secondary hidden sm:inline">
          {currentTheme?.name || theme}
        </span>
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-1 w-48 bg-bg-secondary border border-border rounded-lg shadow-xl overflow-hidden animate-fade-in z-50">
          <div className="px-3 py-2 text-[10px] text-text-muted uppercase tracking-wider border-b border-border">
            选择主题
          </div>
          {THEME_IDS.map((id) => {
            const t = THEMES[id]
            const isActive = id === theme
            return (
              <button
                key={id}
                onClick={() => {
                  setTheme(id)
                  setOpen(false)
                }}
                className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                  isActive
                    ? 'bg-accent-blue/15 text-accent-blue'
                    : 'hover:bg-bg-hover text-text-primary'
                }`}
              >
                {/* 预览色块 */}
                <div className="flex gap-0.5 flex-shrink-0">
                  <div
                    className="w-3 h-3 rounded-sm"
                    style={{ backgroundColor: t.colors.bg.primary }}
                  />
                  <div
                    className="w-3 h-3 rounded-sm"
                    style={{ backgroundColor: t.colors.accent.blue }}
                  />
                  <div
                    className="w-3 h-3 rounded-sm"
                    style={{ backgroundColor: t.colors.accent.green }}
                  />
                </div>
                {/* 主题名称 */}
                <span className="text-xs flex-1">{t.name}</span>
                {/* 当前标记 */}
                {isActive && (
                  <div className="w-1.5 h-1.5 rounded-full bg-accent-blue flex-shrink-0" />
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
