/**
 * 消息输入组件
 *
 * 多行文本输入框 + 发送按钮。
 * - Enter 发送（单行模式）
 * - Shift+Enter 换行
 * - `@` 触发文件选择弹窗（Cursor 风格），选择后生成文件引用卡片
 * - `/` 前缀触发 Slash Command 自动补全
 * - Ctrl+V 粘贴截图/图片 → 图片缩略图预览
 * - Ctrl+V 粘贴文件（从资源管理器）→ 图片显示缩略图，其他文件显示文件引用卡片
 * - Ctrl+V 粘贴文件路径文本 → 自动识别并格式化为文件引用卡片
 * - 拖拽图片文件 → 图片缩略图预览
 * - 拖拽非图片文件 → 文件引用卡片（支持任意文件类型）
 * - 发送中禁用输入
 *
 * @author weibin
 */

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { FileText, Code, FileImage, FileArchive, X, ExternalLink, MessagesSquare, AtSign } from 'lucide-react'
import { useSessionStore } from '../../stores/sessionStore'
import { useUIStore } from '../../stores/uiStore'
import { toPlatformShortcutLabel } from '../../utils/shortcut'

interface ImageAttachment {
  id: string
  previewUrl: string  // blob URL，仅用于缩略图展示，发送后 revoke
  filePath: string    // 真实磁盘路径，拼入消息文本
  name: string        // 显示名称（截图/文件名）
}

/** 非图片文件引用（拖拽/粘贴路径/@ 符号产生） */
interface FileRefAttachment {
  id: string
  filePath: string  // 真实磁盘路径
  name: string      // 文件名（显示用）
  ext: string       // 扩展名，用于图标选择
}

/** 项目文件（@ 弹窗中展示的候选项） */
interface ProjectFile {
  name: string
  path: string
  relativePath: string
  ext: string
}

/** 从 skills 中提取的 slash command 定义 */
interface SlashCommand {
  name: string         // 不含 / 前缀，如 "commit"
  description: string  // 简短描述
}

interface MessageInputProps {
  sessionId?: string   // SDK V2 对话视图传入，用于获取 slash commands
  onSend: (text: string) => Promise<void>
  disabled?: boolean
  placeholder?: string
  /** SessionToolbar Skill chip 点击时注入的命令文本（如 "/simplify "），处理后调用 onPendingInsertHandled 清零 */
  pendingInsert?: string
  /** pendingInsert 已处理完毕的回调，父组件应将 pendingInsert 重置为 undefined */
  onPendingInsertHandled?: () => void
  /** 外部插入的文本（如跨会话引用内容），追加到输入框末尾 */
  externalInsert?: string
  /** externalInsert 已处理完毕的回调 */
  onExternalInsertHandled?: () => void
  /** 点击"引用会话"按钮的回调（打开跨会话搜索面板） */
  onOpenSessionSearch?: () => void
}

/**
 * 从 initData 的 skills 数组提取 slash command 列表
 * SDK skills 格式: { name: "commit", description: "..." } 或字符串
 */
function extractSlashCommands(skills: any[]): SlashCommand[] {
  if (!skills || skills.length === 0) return []
  return skills.map((s: any) => {
    if (typeof s === 'string') {
      const name = s.startsWith('/') ? s.slice(1) : s
      return { name, description: '' }
    }
    const name = s.name || s.command || s.slug || ''
    const desc = s.description || s.hint || s.summary || s.help || ''
    return { name: name.startsWith('/') ? name.slice(1) : name, description: desc }
  }).filter(s => s.name)
}

/** 粘贴/拖拽文件时，根据扩展名判断是否为图片 */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tiff', '.avif'])

/** 代码类文件扩展名，用于图标区分 */
const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.kt', '.go', '.rs', '.rb',
  '.php', '.cs', '.cpp', '.c', '.h', '.swift', '.vue', '.html', '.css', '.scss',
  '.sass', '.less', '.sql', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.yaml',
  '.yml', '.json', '.xml', '.toml', '.ini', '.cfg', '.env', '.md', '.mdx',
])

/** 压缩包扩展名 */
const ARCHIVE_EXTS = new Set(['.zip', '.tar', '.gz', '.bz2', '.rar', '.7z'])

function getFileExt(filePathOrName: string): string {
  const value = (filePathOrName || '').trim()
  const dotIdx = value.lastIndexOf('.')
  return dotIdx >= 0 ? value.slice(dotIdx).toLowerCase() : ''
}

function getFileName(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() || filePath
}

/**
 * 判断粘贴的纯文本是否为文件路径
 * 支持：
 * - Windows 绝对路径: C:\Users\... 或 D:\projects\...
 * - Unix 绝对路径: /home/user/... 或 /Users/...
 * - 相对路径: src/components/xxx.tsx（必须含扩展名且含路径分隔符）
 */
function detectFilePath(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.includes('\n')) return null  // 多行文本不是路径
  // Windows 绝对路径
  if (/^[A-Za-z]:\\/.test(trimmed)) return trimmed
  // Unix 绝对路径
  if (/^\/[^/]/.test(trimmed)) return trimmed
  // 相对路径（有路径分隔符 + 有扩展名）
  if ((trimmed.includes('/') || trimmed.includes('\\')) && /\.[a-zA-Z0-9]+$/.test(trimmed)) {
    // 排除 URL（http:// 等）
    if (/^https?:\/\//.test(trimmed)) return null
    return trimmed
  }
  return null
}

/** 根据文件扩展名返回对应图标 */
function FileTypeIcon({ ext, className }: { ext: string; className?: string }) {
  if (IMAGE_EXTS.has(ext)) return <FileImage size={14} className={className} />
  if (CODE_EXTS.has(ext)) return <Code size={14} className={className} />
  if (ARCHIVE_EXTS.has(ext)) return <FileArchive size={14} className={className} />
  return <FileText size={14} className={className} />
}

/** 文件引用卡片 —— 显示在附件区域 */
function FileRefCard({
  fileRef,
  onRemove,
}: {
  fileRef: FileRefAttachment
  onRemove: () => void
}) {
  const handleOpen = useCallback(() => {
    // Electron 环境：尝试通过 shell 打开文件
    const shell = (window as any).spectrAI?.shell
    if (shell?.openPath) {
      shell.openPath(fileRef.filePath)
    }
  }, [fileRef.filePath])

  return (
    <div
      className="group flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border
        bg-bg-secondary hover:border-accent-blue/40 transition-colors
        max-w-[220px] flex-shrink-0"
      title={fileRef.filePath}
    >
      {/* 文件类型图标 */}
      <FileTypeIcon ext={fileRef.ext} className="text-accent-blue flex-shrink-0" />

      {/* 文件名 */}
      <span className="text-xs text-text-primary truncate flex-1 font-mono min-w-0">
        {fileRef.name}
      </span>

      {/* 操作按钮（hover 显示） */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
        <button
          type="button"
          onClick={handleOpen}
          title="在系统中打开"
          className="p-0.5 rounded hover:text-accent-blue text-text-muted transition-colors"
        >
          <ExternalLink size={11} />
        </button>
        <button
          type="button"
          onClick={onRemove}
          title="移除引用"
          className="p-0.5 rounded hover:text-accent-red text-text-muted transition-colors"
        >
          <X size={11} />
        </button>
      </div>
    </div>
  )
}

const MessageInput: React.FC<MessageInputProps> = ({
  sessionId,
  onSend,
  disabled = false,
  placeholder = '输入消息...',
  pendingInsert,
  onPendingInsertHandled,
  externalInsert,
  onExternalInsertHandled,
  onOpenSessionSearch,
}) => {
  // 从 store 恢复草稿（视图切换时保留未发送内容）
  const storedDraft = useUIStore(state => sessionId ? (state.draftInputs[sessionId] ?? '') : '')
  const setDraftInput = useUIStore(state => state.setDraftInput)

  const [text, setText] = useState(storedDraft)
  const [sending, setSending] = useState(false)
  const [attachments, setAttachments] = useState<ImageAttachment[]>([])
  const [fileRefs, setFileRefs] = useState<FileRefAttachment[]>([])
  const [previewAttachment, setPreviewAttachment] = useState<ImageAttachment | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [dragHasNonImage, setDragHasNonImage] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // ---- Slash Command 自动补全状态 ----
  const [showSlashMenu, setShowSlashMenu] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)

  // ---- @ 文件引用弹窗状态 ----
  const [atMenuOpen, setAtMenuOpen] = useState(false)
  const [atQuery, setAtQuery] = useState('')
  const [atAnchorIndex, setAtAnchorIndex] = useState(-1)  // @ 符号在 text 中的位置
  const [atSelectedIndex, setAtSelectedIndex] = useState(0)
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([])
  const [projectFilesLoaded, setProjectFilesLoaded] = useState(false)
  const [loadingFiles, setLoadingFiles] = useState(false)
  const atMenuRef = useRef<HTMLDivElement>(null)

  // 从 store 获取会话信息
  const initData = useSessionStore(state =>
    sessionId ? state.sessionInitData[sessionId] : undefined
  )
  const workDir = useSessionStore(state =>
    sessionId ? state.sessions.find(s => s.id === sessionId)?.config?.workingDirectory : undefined
  )

  const slashCommands = useMemo(() => {
    return extractSlashCommands(initData?.skills || [])
  }, [initData?.skills])

  // 将草稿文本同步到 store，保证视图切换后可恢复
  useEffect(() => {
    if (sessionId) {
      setDraftInput(sessionId, text)
    }
  }, [text, sessionId, setDraftInput])

  // 根据输入文本过滤 slash 命令
  const filteredCommands = useMemo(() => {
    if (!text.startsWith('/')) return []
    const query = text.slice(1).toLowerCase()
    if (!query) return slashCommands
    return slashCommands.filter(cmd =>
      cmd.name.toLowerCase().includes(query) ||
      cmd.description.toLowerCase().includes(query)
    )
  }, [text, slashCommands])

  // 控制 slash 菜单显示（有命令可选 + 文本以 / 开头 + 单行模式即无换行）
  useEffect(() => {
    const shouldShow = text.startsWith('/') && !text.includes('\n') && filteredCommands.length > 0
    setShowSlashMenu(shouldShow)
    if (shouldShow) {
      setSelectedIndex(0)
    }
  }, [text, filteredCommands.length])

  // 滚动 slash 菜单选中项到可见区域
  useEffect(() => {
    if (!showSlashMenu || !menuRef.current) return
    const item = menuRef.current.children[selectedIndex] as HTMLElement
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, showSlashMenu])

  // 滚动 @ 菜单选中项到可见区域
  useEffect(() => {
    if (!atMenuOpen || !atMenuRef.current) return
    const item = atMenuRef.current.children[atSelectedIndex] as HTMLElement
    item?.scrollIntoView({ block: 'nearest' })
  }, [atSelectedIndex, atMenuOpen])

  useEffect(() => {
    if (!previewAttachment) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPreviewAttachment(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [previewAttachment])

  // 自动聚焦
  useEffect(() => {
    if (!disabled && !sending) {
      textareaRef.current?.focus()
    }
  }, [disabled, sending])

  // 处理来自 SessionToolbar 的外部命令注入
  useEffect(() => {
    if (!pendingInsert) return
    setText(prev => {
      if (!prev) return pendingInsert
      const sep = prev.endsWith(' ') || prev.endsWith('\n') ? '' : ' '
      return prev + sep + pendingInsert
    })
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
    onPendingInsertHandled?.()
  }, [pendingInsert]) // eslint-disable-line react-hooks/exhaustive-deps

  // 处理来自跨会话搜索的外部引用插入
  useEffect(() => {
    if (!externalInsert) return
    setText(prev => {
      if (!prev) return externalInsert
      const sep = prev.endsWith('\n') ? '' : '\n'
      return prev + sep + externalInsert
    })
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
    onExternalInsertHandled?.()
  }, [externalInsert]) // eslint-disable-line react-hooks/exhaustive-deps

  // 自动调整高度：避免在隐藏状态下测量导致 scrollHeight 异常偏大
  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current
    if (!el) return

    // display:none 或宽度为 0 时不做测量，等待可见后再重算
    if (el.offsetParent === null || el.clientWidth === 0) return

    // 空内容时强制回到单行高度，避免残留的大高度
    if (!text.trim()) {
      el.style.height = '2rem'
      return
    }

    el.style.height = '0'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [text])

  // sessionId 变化时双帧重算一次，兼容视图切换后布局尚未稳定的场景
  useEffect(() => {
    const raf1 = requestAnimationFrame(() => {
      adjustTextareaHeight()
      requestAnimationFrame(adjustTextareaHeight)
    })
    return () => cancelAnimationFrame(raf1)
  }, [adjustTextareaHeight, sessionId])

  // 容器尺寸变化（例如切换 Teams/会话后重新显示）时重算高度
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const el = textareaRef.current
    if (!el) return
    const ro = new ResizeObserver(() => adjustTextareaHeight())
    ro.observe(el)
    if (el.parentElement) {
      ro.observe(el.parentElement)
    }
    return () => ro.disconnect()
  }, [adjustTextareaHeight, sessionId])

  // 窗口 resize 时重算高度
  useEffect(() => {
    const onResize = () => adjustTextareaHeight()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [adjustTextareaHeight])

  // ---- Slash Command 选中 ----
  const selectCommand = useCallback((cmd: SlashCommand) => {
    setText(`/${cmd.name} `)
    setShowSlashMenu(false)
    textareaRef.current?.focus()
  }, [])

  /** 加载项目文件列表（懒加载，@ 首次触发时执行） */
  const loadProjectFiles = useCallback(async () => {
    if (!workDir || loadingFiles || projectFilesLoaded) return
    setLoadingFiles(true)
    try {
      const result = await (window.spectrAI.fileManager as any).listProjectFiles(workDir, 800)
      if (result?.files) {
        setProjectFiles(result.files)
      }
    } catch (err) {
      console.warn('[MessageInput] 加载项目文件失败:', err)
    } finally {
      setLoadingFiles(false)
      setProjectFilesLoaded(true)
    }
  }, [workDir, loadingFiles, projectFilesLoaded])

  /** 添加文件引用（自动去重） */
  const addFileRef = useCallback((filePath: string) => {
    setFileRefs(prev => {
      if (prev.some(r => r.filePath === filePath)) return prev
      const name = getFileName(filePath)
      const ext = getFileExt(name)
      return [...prev, { id: crypto.randomUUID(), filePath, name, ext }]
    })
  }, [])

  /** 从 @ 弹窗中选中文件 */
  const selectAtFile = useCallback((file: ProjectFile) => {
    // 删除 @ 加查询词
    const deleteLen = 1 + atQuery.length  // '@' + query
    const newText = text.slice(0, atAnchorIndex) + text.slice(atAnchorIndex + deleteLen)
    setText(newText)
    setAtMenuOpen(false)
    setAtQuery('')
    addFileRef(file.path)
    // 光标定位到 @ 所在位置
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(atAnchorIndex, atAnchorIndex)
    })
  }, [text, atAnchorIndex, atQuery, addFileRef])

  /** @ 菜单候选文件（按 atQuery 模糊过滤，最多 10 条） */
  const filteredAtFiles = useMemo(() => {
    if (!atMenuOpen) return []
    const q = atQuery.toLowerCase()
    if (!q) {
      return projectFiles.slice(0, 10)
    }
    return projectFiles
      .filter(f =>
        f.name.toLowerCase().includes(q) || f.relativePath.toLowerCase().includes(q)
      )
      .sort((a, b) => {
        // 文件名匹配优先于路径匹配
        const aName = a.name.toLowerCase().includes(q)
        const bName = b.name.toLowerCase().includes(q)
        if (aName && !bName) return -1
        if (!aName && bName) return 1
        return a.relativePath.localeCompare(b.relativePath)
      })
      .slice(0, 10)
  }, [atMenuOpen, projectFiles, atQuery])

  // @ 菜单候选变化时重置选中索引
  useEffect(() => {
    if (atMenuOpen) setAtSelectedIndex(0)
  }, [atQuery, atMenuOpen])

  // ---- textarea onChange（含 @ 检测） ----
  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value
    const cursorPos = e.target.selectionStart ?? newText.length
    setText(newText)

    // 检测 @ 引用
    const textBeforeCursor = newText.slice(0, cursorPos)
    const lastAtIdx = textBeforeCursor.lastIndexOf('@')

    if (lastAtIdx >= 0) {
      const textBetween = textBeforeCursor.slice(lastAtIdx + 1)
      // @ 和光标之间无空格/换行 → 激活 @ 模式
      if (!textBetween.includes(' ') && !textBetween.includes('\n')) {
        setAtQuery(textBetween)
        setAtAnchorIndex(lastAtIdx)
        if (!atMenuOpen) {
          setAtMenuOpen(true)
          // 首次触发时懒加载项目文件
          if (!projectFilesLoaded && workDir) {
            loadProjectFiles()
          }
        }
        return
      }
    }

    // 没有活跃的 @ → 关闭弹窗
    if (atMenuOpen) {
      setAtMenuOpen(false)
      setAtQuery('')
    }
  }, [atMenuOpen, projectFilesLoaded, workDir, loadProjectFiles])

  // ---- 粘贴截图 / 文件 / 路径 ----
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items)

    // ① 剪贴板中直接含有图片数据（截图、从浏览器复制的图片等）
    const imageDataItem = items.find(item => item.type.startsWith('image/'))
    if (imageDataItem) {
      e.preventDefault()
      const file = imageDataItem.getAsFile()
      if (!file) return

      const reader = new FileReader()
      reader.onload = async (ev) => {
        const dataUrl = ev.target?.result as string
        const base64 = dataUrl.split(',')[1]
        const filePath = await window.spectrAI.fs.saveImageToTemp(base64, imageDataItem.type)
        const previewUrl = URL.createObjectURL(file)
        const name = `截图_${new Date().toLocaleTimeString()}`
        setAttachments(prev => [...prev, { id: crypto.randomUUID(), previewUrl, filePath, name }])
      }
      reader.readAsDataURL(file)
      return
    }

    // ② 从资源管理器复制文件后粘贴（type 为空，kind === 'file'）
    const fileItems = items.filter(item => item.kind === 'file')
    if (fileItems.length > 0) {
      let hasHandled = false
      for (const item of fileItems) {
        const file = item.getAsFile()
        if (!file) continue
        const filePath = (file as any).path as string
        if (!filePath) continue

        hasHandled = true
        const ext = getFileExt(filePath || file.name || '')

        if (IMAGE_EXTS.has(ext)) {
          // 图片文件 → 图片预览卡片
          const previewUrl = URL.createObjectURL(file)
          setAttachments(prev => [...prev, {
            id: crypto.randomUUID(),
            previewUrl,
            filePath,
            name: file.name,
          }])
        } else {
          // 非图片文件 → 文件引用卡片
          addFileRef(filePath)
        }
      }
      if (hasHandled) {
        e.preventDefault()
      }
      return
    }

    // ③ 粘贴纯文本 → 检测是否为文件路径，若是则转为文件引用卡片
    const textItem = items.find(item => item.type === 'text/plain')
    if (textItem) {
      textItem.getAsString((pastedText) => {
        const detectedPath = detectFilePath(pastedText)
        if (detectedPath) {
          e.preventDefault()
          addFileRef(detectedPath)
        }
        // 否则正常粘贴（不阻止默认行为）
      })
    }
  }, [addFileRef])

  // ---- 拖拽处理 ----
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    // ① OS 文件系统拖入（如从桌面/资源管理器拖拽）
    const hasOsFiles = [...e.dataTransfer.items].some(i => i.kind === 'file')
    // ② 从应用内文件管理器拖入（text/x-spectrai-filepath 或 text/plain）
    const hasInAppFile = e.dataTransfer.types.includes('text/x-spectrai-filepath')
      || e.dataTransfer.types.includes('text/plain')

    if (!hasOsFiles && !hasInAppFile) return
    setDragOver(true)

    // 检测是否包含非图片文件，用于显示不同提示文案
    if (hasInAppFile) {
      // 应用内文件管理器拖入：一定是文件路径（非图片为主）
      setDragHasNonImage(true)
    } else {
      const hasNonImage = [...e.dataTransfer.items].some(i => {
        if (i.kind !== 'file') return false
        return !i.type.startsWith('image/')
      })
      setDragHasNonImage(hasNonImage)
    }
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOver(false)
    setDragHasNonImage(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    setDragHasNonImage(false)

    // ── 情况 A：OS 文件系统拖入（桌面/资源管理器拖拽） ──
    const osFiles = Array.from(e.dataTransfer.files)
    if (osFiles.length > 0) {
      for (const file of osFiles) {
        const filePath = (file as any).path as string | undefined  // Electron 提供真实磁盘路径
        if (!filePath) continue
        const ext = getFileExt(filePath || file.name || '')
        const isImage = file.type.startsWith('image/') || IMAGE_EXTS.has(ext)

        if (isImage) {
          // 图片 → 图片预览卡片
          const previewUrl = URL.createObjectURL(file)
          setAttachments(prev => [...prev, {
            id: crypto.randomUUID(),
            previewUrl,
            filePath,
            name: file.name,
          }])
        } else {
          // 非图片文件 → 文件引用卡片
          addFileRef(filePath)
        }
      }
      return
    }

    // ── 情况 B：应用内文件管理器拖入（text/x-spectrai-filepath） ──
    const inAppPath = e.dataTransfer.getData('text/x-spectrai-filepath')
    if (inAppPath) {
      addFileRef(inAppPath)
      return
    }

    // ── 情况 C：text/plain 降级兜底（路径文本） ──
    const plainText = e.dataTransfer.getData('text/plain')
    if (plainText) {
      const detected = detectFilePath(plainText)
      if (detected) addFileRef(detected)
    }
  }, [addFileRef])

  // ---- 发送 ----
  const handleSend = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed && attachments.length === 0 && fileRefs.length === 0) return
    if (sending || disabled) return

    setSending(true)
    setText('')
    if (sessionId) setDraftInput(sessionId, '')
    setShowSlashMenu(false)
    setAtMenuOpen(false)

    let fullMessage = trimmed

    // 附加图片引用
    if (attachments.length > 0) {
      setPreviewAttachment(null)
      const imgLines = attachments.map(a => `[图片: ${a.filePath}]`).join('\n')
      fullMessage = fullMessage ? `${fullMessage}\n\n${imgLines}` : imgLines
      attachments.forEach(a => URL.revokeObjectURL(a.previewUrl))
      setAttachments([])
    }

    // 附加文件引用（生成 [文件: path] 格式，让 AI 用 Read 工具读取文件内容）
    if (fileRefs.length > 0) {
      const fileLines = fileRefs.map(r => `[文件: ${r.filePath}]`).join('\n')
      fullMessage = fullMessage ? `${fullMessage}\n\n${fileLines}` : fileLines
      setFileRefs([])
    }

    try {
      await onSend(fullMessage)
    } finally {
      setSending(false)
      textareaRef.current?.focus()
    }
  }, [text, attachments, fileRefs, sending, disabled, onSend, sessionId, setDraftInput])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // ①  @ 弹窗打开时拦截上下箭头/Enter/Esc/Tab
    if (atMenuOpen && filteredAtFiles.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAtSelectedIndex(prev => (prev > 0 ? prev - 1 : filteredAtFiles.length - 1))
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAtSelectedIndex(prev => (prev < filteredAtFiles.length - 1 ? prev + 1 : 0))
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        selectAtFile(filteredAtFiles[atSelectedIndex])
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        selectAtFile(filteredAtFiles[atSelectedIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setAtMenuOpen(false)
        setAtQuery('')
        return
      }
    }

    // @ 弹窗打开但无候选时，Escape 也关闭
    if (atMenuOpen && e.key === 'Escape') {
      e.preventDefault()
      setAtMenuOpen(false)
      setAtQuery('')
      return
    }

    // ② Slash 菜单打开时拦截上下箭头/Enter/Esc
    if (showSlashMenu && filteredCommands.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(prev => (prev > 0 ? prev - 1 : filteredCommands.length - 1))
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(prev => (prev < filteredCommands.length - 1 ? prev + 1 : 0))
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        selectCommand(filteredCommands[selectedIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowSlashMenu(false)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        selectCommand(filteredCommands[selectedIndex])
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend, showSlashMenu, filteredCommands, selectedIndex, selectCommand,
      atMenuOpen, filteredAtFiles, atSelectedIndex, selectAtFile])

  const isDisabled = disabled || sending
  const hasAttachments = attachments.length > 0 || fileRefs.length > 0

  return (
    <div
      className="px-4 pb-3 pt-2 bg-bg-primary relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Slash Command 下拉菜单（浮动在输入框上方） */}
      {showSlashMenu && filteredCommands.length > 0 && (
        <div
          ref={menuRef}
          className="absolute bottom-full left-4 right-4 mb-1
            bg-bg-secondary border border-border rounded-lg shadow-lg
            max-h-52 overflow-y-auto z-50"
          style={{ scrollbarWidth: 'thin' }}
        >
          {filteredCommands.map((cmd, idx) => (
            <button
              key={cmd.name}
              className={`w-full text-left px-3 py-2 flex items-baseline gap-2
                transition-colors text-sm
                ${idx === selectedIndex
                  ? 'bg-accent-blue/15 text-accent-blue'
                  : 'text-text-primary hover:bg-bg-hover'}`}
              onMouseEnter={() => setSelectedIndex(idx)}
              onMouseDown={(e) => {
                e.preventDefault() // 阻止 textarea 失焦
                selectCommand(cmd)
              }}
            >
              <span className="font-mono font-medium flex-shrink-0">/{cmd.name}</span>
              {cmd.description && (
                <span className="text-xs text-text-secondary truncate">{cmd.description}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* @ 文件选择弹窗（浮动在输入框上方，仅当工作目录存在时启用） */}
      {atMenuOpen && workDir && (
        <div
          ref={atMenuRef}
          className="absolute bottom-full left-4 right-4 mb-1
            bg-bg-secondary border border-border rounded-lg shadow-lg
            max-h-52 overflow-y-auto z-50"
          style={{ scrollbarWidth: 'thin' }}
        >
          {/* 标题行 */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50 sticky top-0 bg-bg-secondary">
            <div className="flex items-center gap-1.5 text-xs text-text-muted">
              <AtSign size={12} />
              <span>引用文件{atQuery ? `："${atQuery}"` : ''}</span>
            </div>
            {loadingFiles && (
              <svg className="animate-spin h-3 w-3 text-text-muted" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
          </div>

          {/* 候选文件列表 */}
          {filteredAtFiles.length === 0 && !loadingFiles ? (
            <div className="px-3 py-4 text-xs text-text-muted text-center">
              {projectFilesLoaded ? `未找到"${atQuery}"相关文件` : '加载项目文件中...'}
            </div>
          ) : (
            filteredAtFiles.map((file, idx) => (
              <button
                key={file.path}
                className={`w-full text-left px-3 py-2 flex items-center gap-2
                  transition-colors text-sm
                  ${idx === atSelectedIndex
                    ? 'bg-accent-blue/15 text-accent-blue'
                    : 'text-text-primary hover:bg-bg-hover'}`}
                onMouseEnter={() => setAtSelectedIndex(idx)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  selectAtFile(file)
                }}
              >
                <FileTypeIcon
                  ext={file.ext}
                  className={idx === atSelectedIndex ? 'text-accent-blue' : 'text-text-muted'}
                />
                <span className="font-mono font-medium flex-shrink-0 text-xs">{file.name}</span>
                <span className="text-xs text-text-muted truncate">{file.relativePath}</span>
              </button>
            ))
          )}
        </div>
      )}

      <div className={`flex flex-col p-2 bg-bg-input border rounded-xl transition-colors shadow-sm
        ${dragOver ? 'border-accent-blue' : 'border-border'}`}>

        {/* 附件区域：图片预览 + 文件引用卡片（有附件时显示） */}
        {hasAttachments && (
          <div className="px-2 pt-2 pb-1 border-b border-border mb-1">
            <div className="flex flex-wrap gap-2 pb-1">

              {/* 图片缩略图 */}
              {attachments.map(att => (
                <div key={att.id} className="relative flex-shrink-0 group">
                  <button
                    type="button"
                    title={att.name}
                    onClick={() => setPreviewAttachment(att)}
                    className="w-20 h-20 rounded-lg overflow-hidden border border-border bg-bg-tertiary hover:border-accent-blue/40 btn-transition"
                  >
                    <img
                      src={att.previewUrl}
                      alt={att.name}
                      className="w-full h-full object-cover"
                    />
                  </button>
                  {/* 悬停时底部文件名蒙层 */}
                  <div className="absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-black/60 to-transparent
                    rounded-b-lg opacity-0 group-hover:opacity-100 transition-opacity flex items-end px-1 pb-0.5">
                    <span className="text-[10px] text-white/90 truncate w-full leading-tight">{att.name}</span>
                  </div>
                  {/* 删除按钮（右上角） */}
                  <button
                    onClick={() => {
                      if (previewAttachment?.id === att.id) setPreviewAttachment(null)
                      URL.revokeObjectURL(att.previewUrl)
                      setAttachments(prev => prev.filter(a => a.id !== att.id))
                    }}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full
                      bg-bg-primary border border-border
                      flex items-center justify-center
                      text-text-secondary hover:text-accent-red hover:border-accent-red
                      opacity-0 group-hover:opacity-100 transition-all
                      text-xs leading-none"
                  >×</button>
                </div>
              ))}

              {/* 文件引用卡片 */}
              {fileRefs.map(ref => (
                <FileRefCard
                  key={ref.id}
                  fileRef={ref}
                  onRemove={() => setFileRefs(prev => prev.filter(r => r.id !== ref.id))}
                />
              ))}
            </div>
          </div>
        )}

        {/* 拖拽覆盖提示 */}
        {dragOver && (
          <div className="flex items-center justify-center py-2 text-xs text-accent-blue gap-1.5">
            <span>{dragHasNonImage ? '📁' : '🖼️'}</span>
            <span>{dragHasNonImage ? '松开鼠标添加文件引用' : '松开鼠标添加图片'}</span>
          </div>
        )}

        {/* textarea + 工具按钮行 */}
        <div className="flex items-end gap-1">
          {/* 跨会话引用按钮（有回调时才显示） */}
          {onOpenSessionSearch && (
            <button
              type="button"
              onClick={onOpenSessionSearch}
              disabled={isDisabled}
              title={`搜索并引用其他会话内容 (${toPlatformShortcutLabel('Ctrl+Shift+F')})`}
              className="p-1.5 rounded-lg text-text-muted hover:text-accent-blue hover:bg-accent-blue/10
                disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex-shrink-0"
            >
              <MessagesSquare size={14} />
            </button>
          )}

          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onFocus={adjustTextareaHeight}
            placeholder={isDisabled ? '等待 AI 响应...' : placeholder}
            disabled={isDisabled}
            rows={1}
            className="flex-1 bg-transparent text-text-primary text-sm font-mono
              px-2 py-1.5 resize-none overflow-y-auto leading-5 min-h-[2rem]
              focus:outline-none focus-visible:outline-none
              disabled:opacity-50 disabled:cursor-not-allowed
              placeholder:text-text-muted"
          />
          <button
            onClick={handleSend}
            disabled={isDisabled || (!text.trim() && !hasAttachments)}
            className="px-3 py-1.5 bg-accent-blue text-white text-xs font-medium
              rounded-lg hover:bg-accent-blue/80
              disabled:opacity-30 disabled:cursor-not-allowed
              transition-colors whitespace-nowrap flex-shrink-0"
          >
            {sending ? '...' : '发送'}
          </button>
        </div>
      </div>

      {/* 图片全屏预览 */}
      {previewAttachment && (
        <div
          className="fixed inset-0 z-[120] bg-black/80 p-4 flex items-center justify-center"
          onClick={() => setPreviewAttachment(null)}
        >
          <div
            className="relative max-w-[92vw] max-h-[92vh] w-full flex flex-col items-center gap-2"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="self-end px-2 py-1 text-xs rounded bg-bg-primary/80 text-text-primary hover:bg-bg-primary btn-transition"
              onClick={() => setPreviewAttachment(null)}
            >
              关闭
            </button>
            <img
              src={previewAttachment.previewUrl}
              alt={previewAttachment.name}
              className="max-w-full max-h-[82vh] object-contain rounded border border-border bg-black/20"
            />
            <div className="w-full text-[11px] text-white/85 text-center break-all">
              {previewAttachment.name}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

MessageInput.displayName = 'MessageInput'
export default MessageInput
