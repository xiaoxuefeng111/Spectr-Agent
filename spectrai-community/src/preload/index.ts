/**
 * Preload 安全桥接 - 暴露受控的 API 给渲染进程
 * @author weibin
 */

import { contextBridge, ipcRenderer, IpcRendererEvent, clipboard } from 'electron'
import { IPC } from '../shared/constants'

/**
 * 暴露给渲染进程的 API
 */
contextBridge.exposeInMainWorld('spectrAI', {
  // ==================== Clipboard API ====================
  clipboard: {
    readText: () => clipboard.readText(),
    writeText: (text: string) => clipboard.writeText(text)
  },

  // ==================== Theme API ====================
  theme: {
    updateTitleBar: (themeId: string) => ipcRenderer.send(IPC.THEME_UPDATE_TITLE_BAR, themeId)
  },

  // ==================== Settings API ====================
  settings: {
    getAll: () => ipcRenderer.invoke(IPC.SETTINGS_GET_ALL),
    update: (key: string, value: any) => ipcRenderer.invoke(IPC.SETTINGS_UPDATE, key, value),
  },

  // ==================== File System API ====================
  fs: {
    saveImageToTemp: (base64Data: string, mimeType: string) =>
      ipcRenderer.invoke(IPC.FS_SAVE_IMAGE_TO_TEMP, base64Data, mimeType),
  },

  // ==================== Log API ====================
  log: {
    getRecent: (lines?: number) => ipcRenderer.invoke(IPC.LOG_GET_RECENT, lines),
    openFile: () => ipcRenderer.invoke(IPC.LOG_OPEN_FILE),
  },

  // ==================== App API ====================
  app: {
    getCwd: () => process.cwd(),
    getHomePath: () => require('os').homedir(),
    selectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
    selectFile: () => ipcRenderer.invoke(IPC.DIALOG_SELECT_FILE),
    getRecentDirectories: (limit?: number) => ipcRenderer.invoke(IPC.DIRECTORY_GET_RECENT, limit),
    toggleDirectoryPin: (dirPath: string) => ipcRenderer.invoke(IPC.DIRECTORY_TOGGLE_PIN, dirPath),
    removeDirectory: (dirPath: string) => ipcRenderer.invoke(IPC.DIRECTORY_REMOVE, dirPath),
  },

  // ==================== Update API ====================
  update: {
    getState: () => ipcRenderer.invoke(IPC.UPDATE_GET_STATE),
    checkForUpdates: (manual: boolean = true) => ipcRenderer.invoke(IPC.UPDATE_CHECK, manual),
    downloadUpdate: () => ipcRenderer.invoke(IPC.UPDATE_DOWNLOAD),
    quitAndInstall: () => ipcRenderer.invoke(IPC.UPDATE_INSTALL),
    openDownloadPage: () => ipcRenderer.invoke(IPC.UPDATE_OPEN_DOWNLOAD_PAGE),
    onStateChanged: (callback: (state: any) => void) => {
      const listener = (_event: IpcRendererEvent, state: any) => callback(state)
      ipcRenderer.on(IPC.UPDATE_STATE_CHANGED, listener)
      return () => ipcRenderer.removeListener(IPC.UPDATE_STATE_CHANGED, listener)
    },
  },

  // ==================== Session API ====================
  session: {
    create: (config: any) => ipcRenderer.invoke(IPC.SESSION_CREATE, config),

    terminate: (sessionId: string) => ipcRenderer.invoke(IPC.SESSION_TERMINATE, sessionId),

    sendInput: (sessionId: string, input: string) =>
      ipcRenderer.invoke(IPC.SESSION_SEND_INPUT, sessionId, input),

    confirm: (sessionId: string, confirmed: boolean) =>
      ipcRenderer.invoke(IPC.SESSION_CONFIRM, sessionId, confirmed),

    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke(IPC.SESSION_RESIZE, sessionId, cols, rows),

    getOutput: (sessionId: string) =>
      ipcRenderer.invoke(IPC.SESSION_GET_OUTPUT, sessionId),

    getAll: () => ipcRenderer.invoke(IPC.SESSION_GET_ALL),

    getStats: (sessionId: string) => ipcRenderer.invoke(IPC.SESSION_GET_STATS, sessionId),

    getHistory: () => ipcRenderer.invoke(IPC.SESSION_GET_HISTORY),

    getActivities: (sessionId: string, limit?: number) =>
      ipcRenderer.invoke(IPC.SESSION_GET_ACTIVITIES, sessionId, limit),

    resume: (oldSessionId: string) =>
      ipcRenderer.invoke(IPC.SESSION_RESUME, oldSessionId),

    getLogs: (sessionId: string) =>
      ipcRenderer.invoke(IPC.SESSION_GET_LOGS, sessionId),

    rename: (sessionId: string, newName: string) =>
      ipcRenderer.invoke(IPC.SESSION_RENAME, sessionId, newName),

    aiRename: (sessionId: string) =>
      ipcRenderer.invoke(IPC.SESSION_AI_RENAME, sessionId),

    delete: (sessionId: string) =>
      ipcRenderer.invoke(IPC.SESSION_DELETE, sessionId),

    // 事件监听（主进程 → 渲染进程）
    onOutput: (callback: (sessionId: string, data: any) => void) => {
      const listener = (_event: IpcRendererEvent, sessionId: string, data: any) => {
        callback(sessionId, data)
      }
      ipcRenderer.on(IPC.SESSION_OUTPUT, listener)
      return () => ipcRenderer.removeListener(IPC.SESSION_OUTPUT, listener)
    },

    onStatusChange: (callback: (sessionId: string, status: string) => void) => {
      const listener = (_event: IpcRendererEvent, sessionId: string, status: string) => {
        callback(sessionId, status)
      }
      ipcRenderer.on(IPC.SESSION_STATUS_CHANGE, listener)
      return () => ipcRenderer.removeListener(IPC.SESSION_STATUS_CHANGE, listener)
    },

    onActivity: (callback: (sessionId: string, activity: any) => void) => {
      const listener = (_event: IpcRendererEvent, sessionId: string, activity: any) => {
        callback(sessionId, activity)
      }
      ipcRenderer.on(IPC.SESSION_ACTIVITY, listener)
      return () => ipcRenderer.removeListener(IPC.SESSION_ACTIVITY, listener)
    },

    onIntervention: (callback: (sessionId: string, intervention: any) => void) => {
      const listener = (_event: IpcRendererEvent, sessionId: string, intervention: any) => {
        callback(sessionId, intervention)
      }
      ipcRenderer.on(IPC.SESSION_INTERVENTION, listener)
      return () => ipcRenderer.removeListener(IPC.SESSION_INTERVENTION, listener)
    },

    onNameChange: (callback: (sessionId: string, name: string) => void) => {
      const listener = (_event: IpcRendererEvent, sessionId: string, name: string) => {
        callback(sessionId, name)
      }
      ipcRenderer.on(IPC.SESSION_NAME_CHANGE, listener)
      return () => ipcRenderer.removeListener(IPC.SESSION_NAME_CHANGE, listener)
    },


    // SDK V2: 结构化消息发送
    sendMessage: (sessionId: string, text: string) =>
      ipcRenderer.invoke(IPC.SESSION_SEND_MESSAGE, sessionId, text),

    // SDK V2: 获取对话历史
    getConversation: (sessionId: string) =>
      ipcRenderer.invoke(IPC.SESSION_CONVERSATION_HISTORY, sessionId),

    // SDK V2: 中止会话
    abortSession: (sessionId: string) =>
      ipcRenderer.invoke(IPC.SESSION_ABORT, sessionId),

    // SDK V2: 权限响应
    respondPermission: (sessionId: string, accept: boolean) =>
      ipcRenderer.invoke(IPC.SESSION_PERMISSION_RESPOND, sessionId, accept),

    // SDK V2: AskUserQuestion 答案
    answerQuestion: (sessionId: string, answers: Record<string, string>) =>
      ipcRenderer.invoke(IPC.SESSION_ANSWER_QUESTION, sessionId, answers),

    // SDK V2: ExitPlanMode 审批
    approvePlan: (sessionId: string, approved: boolean) =>
      ipcRenderer.invoke(IPC.SESSION_APPROVE_PLAN, sessionId, approved),

    // SDK V2: 获取排队中的消息列表
    getQueue: (sessionId: string) =>
      ipcRenderer.invoke(IPC.SESSION_GET_QUEUE, sessionId),

    // SDK V2: 清空排队中的消息（用户主动取消）
    clearQueue: (sessionId: string) =>
      ipcRenderer.invoke(IPC.SESSION_CLEAR_QUEUE, sessionId),

    // SDK V2: 对话消息事件监听
    onConversationMessage: (callback: (sessionId: string, msg: any) => void) => {
      const listener = (_event: IpcRendererEvent, sessionId: string, msg: any) => {
        callback(sessionId, msg)
      }
      ipcRenderer.on(IPC.SESSION_CONVERSATION_MESSAGE, listener)
      return () => ipcRenderer.removeListener(IPC.SESSION_CONVERSATION_MESSAGE, listener)
    },

    // SDK V2: 会话初始化数据事件监听
    onInitData: (callback: (sessionId: string, data: any) => void) => {
      const listener = (_event: IpcRendererEvent, sessionId: string, data: any) => {
        callback(sessionId, data)
      }
      ipcRenderer.on(IPC.SESSION_INIT_DATA, listener)
      return () => ipcRenderer.removeListener(IPC.SESSION_INIT_DATA, listener)
    },

    // SDK V2: Token 用量更新事件
    onTokenUpdate: (callback: (sessionId: string, usage: any) => void) => {
      const listener = (_event: IpcRendererEvent, sessionId: string, usage: any) => {
        callback(sessionId, usage)
      }
      ipcRenderer.on(IPC.SESSION_TOKEN_UPDATE, listener)
      return () => ipcRenderer.removeListener(IPC.SESSION_TOKEN_UPDATE, listener)
    }
  },

  // ==================== Task API ====================
  task: {
    create: (task: any) => ipcRenderer.invoke(IPC.TASK_CREATE, task),

    update: (taskId: string, updates: any) =>
      ipcRenderer.invoke(IPC.TASK_UPDATE, taskId, updates),

    delete: (taskId: string) => ipcRenderer.invoke(IPC.TASK_DELETE, taskId),

    getAll: () => ipcRenderer.invoke(IPC.TASK_GET_ALL),

    startSession: (taskId: string, config?: any) =>
      ipcRenderer.invoke(IPC.TASK_START_SESSION, taskId, config),

    onStatusChange: (callback: (taskId: string, updates: any) => void) => {
      const listener = (_event: IpcRendererEvent, taskId: string, updates: any) => {
        callback(taskId, updates)
      }
      ipcRenderer.on(IPC.TASK_STATUS_CHANGE, listener)
      return () => ipcRenderer.removeListener(IPC.TASK_STATUS_CHANGE, listener)
    }
  },


  // ==================== Provider API ====================
  provider: {
    getAll: () => ipcRenderer.invoke(IPC.PROVIDER_GET_ALL),
    get: (id: string) => ipcRenderer.invoke(IPC.PROVIDER_GET, id),
    create: (provider: any) => ipcRenderer.invoke(IPC.PROVIDER_CREATE, provider),
    update: (id: string, updates: any) => ipcRenderer.invoke(IPC.PROVIDER_UPDATE, id, updates),
    delete: (id: string) => ipcRenderer.invoke(IPC.PROVIDER_DELETE, id),
    reorder: (orderedIds: string[]) => ipcRenderer.invoke(IPC.PROVIDER_REORDER, orderedIds),
    /** 检测 CLI 命令是否已安装，返回 { found: boolean, path: string | null } */
    checkCli: (command: string) => ipcRenderer.invoke(IPC.PROVIDER_CHECK_CLI, command),
    /**
     * 测试 Claude Code 可执行文件是否可用。
     * - 传入 executablePath：验证该路径的文件是否存在
     * - 不传参数：自动检测系统中的 claude CLI
     * 返回 { found: boolean, path: string | null, error?: string }
     */
    testExecutable: (executablePath?: string) => ipcRenderer.invoke(IPC.PROVIDER_TEST_EXECUTABLE, executablePath),
  },

  // ==================== NVM API ====================
  nvm: {
    listVersions: () => ipcRenderer.invoke(IPC.NVM_LIST_VERSIONS),
  },

  // ==================== Search API ====================
  search: {
    logs: (query: string, sessionId?: string, limit?: number) =>
      ipcRenderer.invoke(IPC.SEARCH_LOGS, query, sessionId, limit)
  },

  // ==================== Usage API ====================
  usage: {
    getSummary: () => ipcRenderer.invoke(IPC.USAGE_GET_SUMMARY),
    getHistory: (days?: number) => ipcRenderer.invoke(IPC.USAGE_GET_HISTORY, days),
    flush: () => ipcRenderer.invoke(IPC.USAGE_FLUSH)
  },

  // Legacy - 保持向后兼容
  getUsageSummary: () => ipcRenderer.invoke(IPC.USAGE_GET_SUMMARY),

  // ==================== Summary API（跨会话上下文） ====================
  summary: {
    getLatest: (sessionId: string) =>
      ipcRenderer.invoke('summary:get-latest', sessionId),

    getAll: (sessionId: string, limit?: number) =>
      ipcRenderer.invoke('summary:get-all', sessionId, limit),

    getAllSessions: () =>
      ipcRenderer.invoke('summary:get-all-sessions'),

  },

  // ==================== Agent API ====================
  agent: {
    list: (parentSessionId?: string) =>
      ipcRenderer.invoke('agent:list', parentSessionId),

    cancel: (agentId: string) =>
      ipcRenderer.invoke('agent:cancel', agentId),

    onCreated: (callback: (agentInfo: any) => void) => {
      const listener = (_event: IpcRendererEvent, agentInfo: any) => callback(agentInfo)
      ipcRenderer.on('agent:created', listener)
      return () => ipcRenderer.removeListener('agent:created', listener)
    },

    onStatusChange: (callback: (agentId: string, status: string) => void) => {
      const listener = (_event: IpcRendererEvent, agentId: string, status: string) => callback(agentId, status)
      ipcRenderer.on('agent:status-change', listener)
      return () => ipcRenderer.removeListener('agent:status-change', listener)
    },

    onCompleted: (callback: (agentId: string, result: any) => void) => {
      const listener = (_event: IpcRendererEvent, agentId: string, result: any) => callback(agentId, result)
      ipcRenderer.on('agent:completed', listener)
      return () => ipcRenderer.removeListener('agent:completed', listener)
    }
  },

  // ==================== Shortcut API ====================
  shortcut: {
    onViewMode: (callback: (mode: string) => void) => {
      const listener = (_event: IpcRendererEvent, mode: string) => callback(mode)
      ipcRenderer.on('shortcut:view-mode', listener)
      return () => ipcRenderer.removeListener('shortcut:view-mode', listener)
    },
    onCycleTerminal: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('shortcut:cycle-terminal', listener)
      return () => ipcRenderer.removeListener('shortcut:cycle-terminal', listener)
    },
    onNewSession: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('shortcut:new-session', listener)
      return () => ipcRenderer.removeListener('shortcut:new-session', listener)
    },
    onNewTaskSession: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('shortcut:new-task-session', listener)
      return () => ipcRenderer.removeListener('shortcut:new-task-session', listener)
    },
    onToggleSidebar: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('shortcut:toggle-sidebar', listener)
      return () => ipcRenderer.removeListener('shortcut:toggle-sidebar', listener)
    },
    onSearch: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('shortcut:search', listener)
      return () => ipcRenderer.removeListener('shortcut:search', listener)
    }
  },


  // ==================== Git / Worktree API ====================
  git: {
    isRepo: (dirPath: string) => ipcRenderer.invoke(IPC.GIT_IS_REPO, dirPath),
    getBranches: (repoPath: string) => ipcRenderer.invoke(IPC.GIT_GET_BRANCHES, repoPath),
    getCurrentBranch: (repoPath: string) => ipcRenderer.invoke(IPC.GIT_GET_CURRENT_BRANCH, repoPath),
    detectMainBranch: (repoPath: string) => ipcRenderer.invoke(IPC.GIT_DETECT_MAIN_BRANCH, repoPath),
    getRepoRoot: (dirPath: string) => ipcRenderer.invoke(IPC.GIT_GET_REPO_ROOT, dirPath),
    isDirty: (dirPath: string) => ipcRenderer.invoke(IPC.GIT_IS_DIRTY, dirPath),
    getStatus:    (repoPath: string) => ipcRenderer.invoke(IPC.GIT_GET_STATUS, repoPath),
    getFileDiff:  (repoPath: string, filePath: string, staged?: boolean, commitHash?: string) =>
                    ipcRenderer.invoke(IPC.GIT_GET_FILE_DIFF, repoPath, filePath, staged, commitHash),
    stage:        (repoPath: string, filePaths: string[]) =>
                    ipcRenderer.invoke(IPC.GIT_STAGE, repoPath, filePaths),
    unstage:      (repoPath: string, filePaths: string[]) =>
                    ipcRenderer.invoke(IPC.GIT_UNSTAGE, repoPath, filePaths),
    discard:      (repoPath: string, filePaths: string[]) =>
                    ipcRenderer.invoke(IPC.GIT_DISCARD, repoPath, filePaths),
    stageAll:     (repoPath: string) => ipcRenderer.invoke(IPC.GIT_STAGE_ALL, repoPath),
    commit:       (repoPath: string, message: string) =>
                    ipcRenderer.invoke(IPC.GIT_COMMIT, repoPath, message),
    pull:         (repoPath: string) => ipcRenderer.invoke(IPC.GIT_PULL, repoPath),
    push:         (repoPath: string) => ipcRenderer.invoke(IPC.GIT_PUSH, repoPath),
    getLog:       (repoPath: string, limit?: number) =>
                    ipcRenderer.invoke(IPC.GIT_GET_LOG, repoPath, limit),
    getRemoteStatus: (repoPath: string) =>
                    ipcRenderer.invoke(IPC.GIT_GET_REMOTE_STATUS, repoPath),
    getCommitFiles: (repoPath: string, hash: string) =>
                    ipcRenderer.invoke(IPC.GIT_GET_COMMIT_FILES, repoPath, hash),
  },

  worktree: {
    create: (repoPath: string, branch: string, taskId: string) =>
      ipcRenderer.invoke(IPC.WORKTREE_CREATE, repoPath, branch, taskId),
    remove: (repoPath: string, worktreePath: string, deleteBranch?: boolean, branchName?: string) =>
      ipcRenderer.invoke(IPC.WORKTREE_REMOVE, repoPath, worktreePath, deleteBranch, branchName),
    list: (repoPath: string) =>
      ipcRenderer.invoke(IPC.WORKTREE_LIST, repoPath),
    checkMerge: (repoPath: string, worktreePath: string) =>
      ipcRenderer.invoke(IPC.WORKTREE_CHECK_MERGE, repoPath, worktreePath),
    merge: (repoPath: string, branchName: string, options?: { squash?: boolean; message?: string; cleanup?: boolean }) =>
      ipcRenderer.invoke(IPC.WORKTREE_MERGE, repoPath, branchName, options),
    getDiffSummary: (repoPath: string, worktreePath: string, baseCommit?: string, baseBranch?: string, worktreeBranchHint?: string) =>
      ipcRenderer.invoke(IPC.WORKTREE_DIFF_SUMMARY, repoPath, worktreePath, baseCommit, baseBranch, worktreeBranchHint),
    getFileDiff: (repoPath: string, worktreeBranch: string, filePath: string, baseCommit?: string, baseBranch?: string) =>
      ipcRenderer.invoke(IPC.WORKTREE_FILE_DIFF, repoPath, worktreeBranch, filePath, baseCommit, baseBranch),
  },

  // ==================== Workspace API ====================
  workspace: {
    list: () => ipcRenderer.invoke(IPC.WORKSPACE_LIST),
    get: (id: string) => ipcRenderer.invoke(IPC.WORKSPACE_GET, id),
    create: (data: any) => ipcRenderer.invoke(IPC.WORKSPACE_CREATE, data),
    update: (id: string, data: any) => ipcRenderer.invoke(IPC.WORKSPACE_UPDATE, id, data),
    delete: (id: string) => ipcRenderer.invoke(IPC.WORKSPACE_DELETE, id),
    scanRepos: (dirPath: string) => ipcRenderer.invoke(IPC.WORKSPACE_SCAN_REPOS, dirPath),
    importVscode: (filePath: string) => ipcRenderer.invoke(IPC.WORKSPACE_IMPORT_VSCODE, filePath),
  },


  // ==================== File Manager API ====================
  fileManager: {
    listDir: (path: string) => ipcRenderer.invoke('file-manager:list-dir', { path }),
    openPath: (path: string) => ipcRenderer.invoke('file-manager:open-path', path),
    readFile: (path: string) => ipcRenderer.invoke('file-manager:read-file', path),
    watchDir: (path: string) => ipcRenderer.invoke('file-manager:watch-dir', path),
    unwatchDir: (path: string) => ipcRenderer.invoke('file-manager:unwatch-dir', path),
    writeFile: (path: string, content: string) =>
      ipcRenderer.invoke('file-manager:write-file', { path, content }),
    onWatchChange: (callback: (event: any) => void) => {
      const handler = (_: IpcRendererEvent, event: any) => callback(event)
      ipcRenderer.on('file-manager:watch-change', handler)
      return () => ipcRenderer.removeListener('file-manager:watch-change', handler)
    },
    getSessionFiles: (sessionId: string) =>
      ipcRenderer.invoke('file-manager:get-session-files', sessionId),
    onSessionFilesUpdated: (callback: (data: { sessionId: string; files: any[] }) => void) => {
      const handler = (_: IpcRendererEvent, data: any) => callback(data)
      ipcRenderer.on('file-manager:session-files-updated', handler)
      return () => ipcRenderer.removeListener('file-manager:session-files-updated', handler)
    },
    /** 递归列举项目目录下的所有文件，用于 @ 符号文件引用 */
    listProjectFiles: (dirPath: string, maxResults?: number) =>
      ipcRenderer.invoke('file-manager:list-project-files', dirPath, maxResults),
    getDiff: (filePath: string) =>
      ipcRenderer.invoke('file-manager:get-file-diff', filePath),
    /** 创建空文件 */
    createFile: (filePath: string) =>
      ipcRenderer.invoke('file-manager:create-file', filePath),
    /** 创建目录 */
    createDir: (dirPath: string) =>
      ipcRenderer.invoke('file-manager:create-dir', dirPath),
    /** 重命名文件/目录 */
    rename: (oldPath: string, newPath: string) =>
      ipcRenderer.invoke('file-manager:rename', { oldPath, newPath }),
    /** 删除文件/目录（移动到回收站） */
    delete: (targetPath: string) =>
      ipcRenderer.invoke('file-manager:delete', targetPath),
    /** 在系统文件管理器中显示 */
    showInFolder: (filePath: string) =>
      ipcRenderer.invoke('file-manager:show-in-folder', filePath),
  },

  // ==================== MCP API ====================
  mcp: {
    getAll: () => ipcRenderer.invoke(IPC.MCP_GET_ALL),
    get: (id: string) => ipcRenderer.invoke(IPC.MCP_GET, id),
    create: (server: any) => ipcRenderer.invoke(IPC.MCP_CREATE, server),
    update: (id: string, updates: any) => ipcRenderer.invoke(IPC.MCP_UPDATE, id, updates),
    delete: (id: string) => ipcRenderer.invoke(IPC.MCP_DELETE, id),
    toggle: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC.MCP_TOGGLE, id, enabled),
    testConnection: (id: string) => ipcRenderer.invoke(IPC.MCP_TEST_CONNECTION, id),
    getForProvider: (providerId: string) => ipcRenderer.invoke(IPC.MCP_GET_FOR_PROVIDER, providerId),
    // Stream A: MCP 一键安装
    install: (id: string) => ipcRenderer.invoke(IPC.MCP_INSTALL, id),
    onInstallProgress: (cb: (data: { id: string; line: string; type: string }) => void) => {
      ipcRenderer.on(IPC.MCP_INSTALL_PROGRESS, (_e, data) => cb(data))
    },
  },

  // ==================== Skill API ====================
  skill: {
    getAll: () => ipcRenderer.invoke(IPC.SKILL_GET_ALL),
    get: (id: string) => ipcRenderer.invoke(IPC.SKILL_GET, id),
    create: (skill: any) => ipcRenderer.invoke(IPC.SKILL_CREATE, skill),
    update: (id: string, updates: any) => ipcRenderer.invoke(IPC.SKILL_UPDATE, id, updates),
    delete: (id: string) => ipcRenderer.invoke(IPC.SKILL_DELETE, id),
    toggle: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC.SKILL_TOGGLE, id, enabled),
    getByCommand: (command: string) => ipcRenderer.invoke(IPC.SKILL_GET_BY_COMMAND, command),
    /** 监听 MCP install_skill 安装新技能的通知，返回取消监听函数 */
    onInstalled: (callback: (skill: any) => void) => {
      const listener = (_event: IpcRendererEvent, skill: any) => callback(skill)
      ipcRenderer.on(IPC.SKILL_INSTALLED_NOTIFY, listener)
      return () => ipcRenderer.removeListener(IPC.SKILL_INSTALLED_NOTIFY, listener)
    },
  },

  // ==================== Registry API（在线市场）====================
  registry: {
    fetchMcps: () => ipcRenderer.invoke(IPC.REGISTRY_FETCH_MCPS),
    fetchSkills: (forceRefresh?: boolean) => ipcRenderer.invoke(IPC.REGISTRY_FETCH_SKILLS, forceRefresh),
    forceRefresh: () => ipcRenderer.invoke(IPC.REGISTRY_FORCE_REFRESH),
    importSkillFromUrl: (url: string) => ipcRenderer.invoke(IPC.SKILL_IMPORT_URL, url),
  },

})
