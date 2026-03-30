/**
 * Preload 类型声明 - 为渲染进程提供类型支持
 * @author weibin
 */

export interface SpectrAIAPI {
  clipboard: {
    readText: () => string
    writeText: (text: string) => void
  }

  theme: {
    updateTitleBar: (themeId: string) => void
  }

  update: {
    getState: () => Promise<{
      status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
      currentVersion: string
      latestVersion?: string
      isMajorUpdate?: boolean
      releaseNotes?: string
      percent?: number
      message?: string
    }>
    checkForUpdates: (manual?: boolean) => Promise<{ success: boolean; state: any }>
    downloadUpdate: () => Promise<{ success: boolean; state: any }>
    quitAndInstall: () => Promise<{ success: boolean }>
    openDownloadPage: () => Promise<{ success: boolean }>
    onStateChanged: (callback: (state: any) => void) => () => void
  }

  app: {
    getCwd: () => string
    getHomePath: () => string
    selectDirectory: () => Promise<string | null>
    selectFile: () => Promise<string | null>
    getRecentDirectories: (limit?: number) => Promise<Array<{
      path: string
      isPinned: boolean
      useCount: number
      lastUsedAt: string
    }>>
    toggleDirectoryPin: (dirPath: string) => Promise<{ success: boolean }>
    removeDirectory: (dirPath: string) => Promise<{ success: boolean }>
  }

  session: {
    create: (config: any) => Promise<{ success: boolean; sessionId?: string; ready?: boolean; status?: string; error?: string }>
    terminate: (sessionId: string) => Promise<{ success: boolean; error?: string }>
    sendInput: (sessionId: string, input: string) => Promise<{ success: boolean }>
    confirm: (sessionId: string, confirmed: boolean) => Promise<{ success: boolean }>
    resize: (sessionId: string, cols: number, rows: number) => Promise<{ success: boolean }>
    getOutput: (sessionId: string) => Promise<string[]>
    getAll: () => Promise<any[]>
    getHistory: () => Promise<any[]>
    getActivities: (sessionId: string, limit?: number) => Promise<any[]>
    resume: (oldSessionId: string) => Promise<{ success: boolean; sessionId?: string; error?: string }>
    getLogs: (sessionId: string) => Promise<string[]>
    rename: (sessionId: string, newName: string) => Promise<{ success: boolean; error?: string }>
    aiRename: (sessionId: string) => Promise<{ success: boolean; name?: string; error?: string }>
    delete: (sessionId: string) => Promise<{ success: boolean; error?: string }>
    getStats: (sessionId: string) => Promise<{
      tokenCount: number
      duration: number
      outputLines?: number
    }>
    onOutput: (callback: (sessionId: string, data: any) => void) => () => void
    onStatusChange: (callback: (sessionId: string, status: string) => void) => () => void
    onActivity: (callback: (sessionId: string, activity: any) => void) => () => void
    onIntervention: (callback: (sessionId: string, intervention: any) => void) => () => void
    onNameChange: (callback: (sessionId: string, name: string) => void) => () => void

    // SDK V2 扩展方法
    sendMessage?: (sessionId: string, text: string) => Promise<{
      success: boolean
      error?: string
      dispatch?: {
        dispatched: boolean
        scheduled: boolean
        strategy?: 'interrupt_now' | 'queue_after_turn'
        queueLength?: number
        reason?: 'session_starting' | 'session_running'
      }
    }>
    getConversation?: (sessionId: string) => Promise<any[]>
    abortSession?: (sessionId: string) => Promise<{ success: boolean; error?: string }>
    respondPermission?: (sessionId: string, accept: boolean) => Promise<{ success: boolean; error?: string }>
    answerQuestion?: (sessionId: string, answers: Record<string, string>) => Promise<{ success: boolean; error?: string }>
    approvePlan?: (sessionId: string, approved: boolean) => Promise<{ success: boolean; error?: string }>
    getQueue?: (sessionId: string) => Promise<{ success: boolean; messages?: Array<{ id: string; text: string; queuedAt: string; strategy?: string }>; error?: string }>
    clearQueue?: (sessionId: string) => Promise<{ success: boolean; cleared?: number; error?: string }>
    onConversationMessage?: (callback: (sessionId: string, msg: any) => void) => () => void
    onInitData?: (callback: (sessionId: string, data: any) => void) => () => void
    onTokenUpdate?: (callback: (sessionId: string, usage: any) => void) => () => void
  }

  task: {
    create: (task: any) => Promise<{ success: boolean; taskId?: string }>
    update: (taskId: string, updates: any) => Promise<{ success: boolean }>
    delete: (taskId: string) => Promise<{ success: boolean }>
    getAll: () => Promise<any[]>
    startSession: (taskId: string, config?: any) => Promise<{ success: boolean; sessionId?: string; reused?: boolean; error?: string }>
    onStatusChange: (callback: (taskId: string, updates: any) => void) => () => void
  }


  provider: {
    getAll: () => Promise<any[]>
    get: (id: string) => Promise<any | null>
    create: (provider: any) => Promise<{ success: boolean; provider?: any; error?: string }>
    update: (id: string, updates: any) => Promise<{ success: boolean; error?: string }>
    delete: (id: string) => Promise<{ success: boolean; error?: string }>
    /** 检测 CLI 命令是否已安装，返回安装路径 */
    checkCli: (command: string) => Promise<{ found: boolean; path: string | null }>
    /** 测试 Claude Code 可执行文件（cli.js）是否可用，支持自动检测或验证指定路径 */
    testExecutable: (executablePath?: string) => Promise<{ found: boolean; path: string | null; error?: string }>
  }

  nvm: {
    listVersions: () => Promise<string[]>
  }

  search: {
    logs: (query: string, sessionId?: string, limit?: number) => Promise<Array<{
      id: number
      sessionId: string
      sessionName: string
      timestamp: string
      chunk: string
      highlight: string
    }>>
  }

  usage: {
    getSummary: () => Promise<{
      totalTokens: number
      totalMinutes: number
      todayTokens: number
      todayMinutes: number
      activeSessions: number
      sessionBreakdown: Record<string, number>
    }>
    getHistory: (days?: number) => Promise<{
      dailyStats: Array<{
        date: string
        tokens: number
        minutes: number
        sessions: number
      }>
      sessionStats: Array<{
        sessionId: string
        sessionName: string
        tokens: number
        minutes: number
      }>
    }>
    flush: () => Promise<{ success: boolean }>
  }

  /** @deprecated use usage.getSummary() */
  getUsageSummary: () => Promise<{
    totalTokens: number
    sessionBreakdown: Record<string, number>
  }>

  agent: {
    list: (parentSessionId?: string) => Promise<Array<{
      agentId: string
      name: string
      parentSessionId: string
      childSessionId: string
      status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
      prompt: string
      workDir: string
      createdAt: string
      completedAt?: string
      result?: {
        success: boolean
        exitCode: number
        output?: string
        error?: string
        artifacts?: string[]
      }
    }>>
    cancel: (agentId: string) => Promise<{ success: boolean; error?: string }>
    onCreated: (callback: (agentInfo: any) => void) => () => void
    onStatusChange: (callback: (agentId: string, status: string) => void) => () => void
    onCompleted: (callback: (agentId: string, result: any) => void) => () => void
  }

  summary: {
    getLatest: (sessionId: string) => Promise<any>
    getAll: (sessionId: string, limit?: number) => Promise<any[]>
    getAllSessions: () => Promise<any[]>
  }

  git: {
    isRepo: (dirPath: string) => Promise<boolean>
    getBranches: (repoPath: string) => Promise<string[]>
    getCurrentBranch: (repoPath: string) => Promise<string | null>
    detectMainBranch: (repoPath: string) => Promise<string | null>
    getRemoteStatus: (repoPath: string) => Promise<{
      hasUpstream: boolean
      upstream: string | null
      ahead: number
      behind: number
    }>
  }

  worktree: {
    create: (repoPath: string, branch: string, taskId: string) => Promise<{ success: boolean; worktreePath?: string; branch?: string; error?: string }>
    remove: (repoPath: string, worktreePath: string, deleteBranch?: boolean, branchName?: string) => Promise<{ success: boolean; error?: string }>
    list: (repoPath: string) => Promise<Array<{ path: string; head: string; branch: string; isMain: boolean }>>
    checkMerge: (repoPath: string, worktreePath: string) => Promise<{
      mainBranch: string
      mainAheadCount: number
      conflictingFiles: string[]
      canMerge: boolean
      error?: string
    }>
    merge: (repoPath: string, branchName: string, options?: { squash?: boolean; message?: string; cleanup?: boolean }) => Promise<{
      success: boolean
      mainBranch?: string
      linesAdded?: number
      linesRemoved?: number
      error?: string
    }>
  }

  workspace: {
    list: () => Promise<any[]>
    get: (id: string) => Promise<any | null>
    create: (data: any) => Promise<{ success: boolean; workspaceId?: string; error?: string }>
    update: (id: string, data: any) => Promise<{ success: boolean; error?: string }>
    delete: (id: string) => Promise<{ success: boolean; error?: string }>
    scanRepos: (dirPath: string) => Promise<{ success: boolean; repos?: Array<{ repoPath: string; name: string }>; error?: string }>
    importVscode: (filePath: string) => Promise<{ success: boolean; repos?: Array<{ repoPath: string; name: string }>; error?: string }>
  }


  shortcut: {
    onViewMode: (callback: (mode: string) => void) => () => void
    onCycleTerminal: (callback: () => void) => () => void
    onNewSession: (callback: () => void) => () => void
    onNewTaskSession: (callback: () => void) => () => void
    onToggleSidebar: (callback: () => void) => () => void
    onSearch: (callback: () => void) => () => void
  }

  fileManager: {
    listDir: (path: string) => Promise<import('../shared/fileManagerTypes').DirListing & { error?: string }>
    openPath: (path: string) => Promise<{ success: boolean; error?: string }>
    readFile: (path: string) => Promise<{ content?: string; error?: string }>
    watchDir: (path: string) => Promise<{ success: boolean }>
    unwatchDir: (path: string) => Promise<{ success: boolean }>
    writeFile: (path: string, content: string) => Promise<{ success?: boolean; error?: string }>
    onWatchChange: (callback: (event: import('../shared/fileManagerTypes').FileWatchEvent) => void) => () => void
    getSessionFiles: (sessionId: string) => Promise<any[]>
    onSessionFilesUpdated: (callback: (data: { sessionId: string; files: any[] }) => void) => () => void
    listProjectFiles: (dirPath: string, maxResults?: number) => Promise<{ files: any[]; total: number; truncated: boolean; error?: string }>
    getDiff: (filePath: string) => Promise<{ hunks: any[]; raw: string; error?: string }>
    createFile: (filePath: string) => Promise<{ success: boolean; error?: string }>
    createDir: (dirPath: string) => Promise<{ success: boolean; error?: string }>
    rename: (oldPath: string, newPath: string) => Promise<{ success: boolean; error?: string }>
    delete: (targetPath: string) => Promise<{ success: boolean; error?: string }>
    showInFolder: (filePath: string) => Promise<{ success: boolean; error?: string }>
  }

}

declare global {
  interface Window {
    spectrAI: SpectrAIAPI
  }
}

export {}
