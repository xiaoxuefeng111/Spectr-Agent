/**
 * 会话文件改动列表组件
 * 显示当前选中会话 AI 改动过的文件，支持折叠/展开，可点击跳转
 * 点击文件行可展开内联 DiffViewer 查看具体变更
 * @author weibin
 */

import React, { useState } from 'react'
import { ChevronDown, ChevronRight, FilePlus, FileEdit, FileX, AlertTriangle } from 'lucide-react'
import DiffViewer from './DiffViewer'

interface TrackedFileChange {
  filePath: string
  changeType: 'create' | 'modify' | 'delete'
  timestamp: number
  sessionId: string
  concurrent?: boolean
}

interface Props {
  files: TrackedFileChange[]
  onOpenFile: (filePath: string) => void
}

const changeConfig = {
  create: { Icon: FilePlus, color: 'text-green-400' },
  modify: { Icon: FileEdit, color: 'text-blue-400' },
  delete: { Icon: FileX, color: 'text-red-400' },
}

export default function SessionChangedFiles({ files, onOpenFile }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const [expandedFile, setExpandedFile] = useState<string | null>(null)
  const [diffData, setDiffData] = useState<{ hunks: any[]; error?: string } | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)

  if (files.length === 0) return null

  const getDisplayName = (filePath: string) => {
    const parts = filePath.replace(/\\/g, '/').split('/')
    return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : filePath
  }

  const handleFileClick = async (filePath: string, changeType: string) => {
    if (expandedFile === filePath) {
      // 折叠
      setExpandedFile(null)
      setDiffData(null)
      return
    }
    setExpandedFile(filePath)
    setDiffData(null)

    if (changeType === 'create' || changeType === 'delete') {
      // 新建/删除文件无需请求 diff，DiffViewer 的空状态会处理
      setDiffData({ hunks: [] })
      return
    }

    setDiffLoading(true)
    try {
      const result = await (window as any).spectrAI?.fileManager?.getDiff?.(filePath)
      setDiffData(result ?? { hunks: [] })
    } catch (e: any) {
      setDiffData({ hunks: [], error: e.message })
    } finally {
      setDiffLoading(false)
    }
  }

  return (
    <div className="border-b border-border flex-shrink-0">
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <span className="font-medium">会话改动</span>
        <span className="ml-auto bg-bg-tertiary text-text-secondary px-1.5 py-0.5 rounded text-[10px]">
          {files.length}
        </span>
      </button>
      {!collapsed && (
        <div className="max-h-40 overflow-y-auto">
          {files.map(file => {
            const { Icon, color } = changeConfig[file.changeType] ?? changeConfig.modify
            return (
              <React.Fragment key={file.filePath}>
                <button
                  onClick={() => handleFileClick(file.filePath, file.changeType)}
                  title={file.filePath}
                  className="w-full flex items-center gap-1.5 px-4 py-0.5 text-xs text-left hover:bg-bg-hover cursor-pointer"
                >
                  <Icon size={11} className={`flex-shrink-0 ${color}`} />
                  <span className="truncate text-text-secondary">{getDisplayName(file.filePath)}</span>
                  {file.concurrent && (
                    <AlertTriangle size={10} className="flex-shrink-0 text-yellow-400 ml-auto" title="多会话并发改动" />
                  )}
                </button>
                {expandedFile === file.filePath && (
                  <div className="border-t border-border">
                    <DiffViewer
                      filePath={file.filePath}
                      changeType={file.changeType}
                      hunks={diffData?.hunks ?? []}
                      isLoading={diffLoading}
                      error={diffData?.error}
                    />
                  </div>
                )}
              </React.Fragment>
            )
          })}
        </div>
      )}
    </div>
  )
}
