/**
 * SessionManager - Claude Code 会话进程管理器
 * @author weibin
 */

import { EventEmitter } from 'events';
import * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import type { SessionStatus, SessionConfig, ActivityEvent, AIProvider } from '../../shared/types';
import { BUILTIN_CLAUDE_PROVIDER } from '../../shared/types';
import { RingBuffer, type InternalSession, type SessionCreateOptions, type TerminalSize } from './types';
import { resolveNodeBinDir, listInstalledNodeVersions } from '../node/NodeVersionResolver';

export class SessionManager extends EventEmitter {
  private sessions: Map<string, InternalSession> = new Map();
  /** 用户输入缓冲区，积累按键直到回车才发 activity */
  private inputBuffers: Map<string, string> = new Map();

  constructor() {
    super();
  }

  /**
   * 使用指定 ID 创建会话（用于恢复场景，复用旧会话 ID）
   * 逻辑与 createSession 完全一致，唯一区别是使用传入的 id
   * @param claudeSessionId 可选，恢复时传入已知的 Claude 会话 ID，避免重新检测
   */
  createSessionWithId(id: string, config: SessionConfig, claudeSessionId?: string, provider?: AIProvider): string {
    // 如果 sessions Map 中已有该 id 的残留对象，先清理
    const existing = this.sessions.get(id);
    if (existing) {
      try {
        if (existing.status !== 'completed') {
          existing.pty.kill();
        }
      } catch (_err) { /* PTY 可能已退出 */ }
      this.sessions.delete(id);
      this.inputBuffers.delete(id);
    }
    const resultId = this._createSession(id, config, provider);

    // 立即设置 claudeSessionId，确保 detectClaudeSessionId 的定时器检查时直接跳过
    if (claudeSessionId) {
      const session = this.sessions.get(resultId);
      if (session) {
        session.claudeSessionId = claudeSessionId;
        console.log(`[SessionManager] Inherited Claude session ID: ${claudeSessionId} for session ${resultId}`);
      }
    }

    return resultId;
  }

  /**
   * 创建新会话并启动 Claude Code 进程
   */
  createSession(config: SessionConfig, provider?: AIProvider): string {
    const id = uuidv4();
    return this._createSession(id, config, provider);
  }

  /**
   * 内部创建会话实现（共享逻辑）
   */
  private _createSession(id: string, config: SessionConfig, provider?: AIProvider): string {
    const resolvedProvider = provider || BUILTIN_CLAUDE_PROVIDER;
    const { command, args, promptForStdin } = this.buildProviderCommand(config, resolvedProvider);

    // 设置环境变量
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...config.env,
      FORCE_COLOR: '1'
    };

    // ★ 清除 Claude Code 嵌套检测环境变量
    // 当 SpectrAI 从 Claude Code 内启动时（开发模式），CLAUDECODE 变量会被继承
    // 导致子进程启动 claude CLI 时报 "cannot be launched inside another Claude Code session"
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    // Provider 级别 Node 版本切换：修改 PATH 指向指定 nvm 版本目录
    if (resolvedProvider.nodeVersion) {
      const nvmNodeDir = SessionManager.resolveNvmNodeDir(resolvedProvider.nodeVersion);
      if (nvmNodeDir) {
        const sep = process.platform === 'win32' ? ';' : ':';
        // ★ Windows 上 process.env 展开后 PATH 键名可能是 Path/path 等大小写变体
        //   必须先读取实际值再统一为 PATH，否则会出现两个不同大小写的键导致 nvm 切换失效
        const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
        const existingPath = env[pathKey] || '';
        if (pathKey !== 'PATH') {
          delete env[pathKey];
        }
        env.PATH = `${nvmNodeDir}${sep}${existingPath}`;
        console.log(`[SessionManager] Node version override: ${resolvedProvider.nodeVersion} → ${nvmNodeDir}`);
      } else {
        console.warn(`[SessionManager] Node version ${resolvedProvider.nodeVersion} not found in nvm, using system default`);
      }
    }

    // Provider 级别自定义环境变量
    if (resolvedProvider.envOverrides) {
      Object.assign(env, resolvedProvider.envOverrides);
    }

    // 根据平台和配置选择 shell
    let shell: string;
    let shellArgs: string[];

    // 如果有初始 prompt 且不是恢复会话，根据 provider.promptPassMode 处理
    const isResume = resolvedProvider.resumeArg
      ? args.some(a => a === resolvedProvider.resumeArg)
      : args.some(a => a === '--resume');
    const promptToSend = (config.initialPrompt && !isResume && resolvedProvider.promptPassMode === 'positional')
      ? config.initialPrompt : null;

    if (process.platform === 'win32') {
      const shellType = config.shell || 'powershell';
      const cmdParts = [command, ...args];

      // 添加初始 prompt 作为位置参数
      if (promptToSend) {
        cmdParts.push(promptToSend);
      }

      // ★ promptFile 模式：通过管道传 prompt，彻底绕过命令行长度限制
      // Agent 子会话专用：prompt 写在临时文件中，用 Get-Content | claude -p 传递
      if (config.promptFile) {
        const escapedPath = config.promptFile.replace(/'/g, "''");
        const quotedParts = cmdParts.map(p => `'${p.replace(/'/g, "''")}'`);
        const psScript = `Get-Content -Raw -Encoding UTF8 '${escapedPath}' | & ${quotedParts.join(' ')}`;
        const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
        shell = shellType === 'pwsh' ? 'pwsh.exe' : 'powershell.exe';
        shellArgs = ['-NoLogo', '-EncodedCommand', encoded];
        console.log(`[SessionManager] PS pipe script (promptFile): ${psScript.slice(0, 200)}...`);
      } else {
        switch (shellType) {
          case 'pwsh':
          case 'powershell':
          default: {
            // ★ 使用 -EncodedCommand (Base64) 绕过 node-pty → PowerShell 命令行解析
            // 注意：provider.command 必须是真实可执行命令（如 'claude'），不能是 PowerShell 函数/别名
            // （PowerShell 5.1 函数中 $args 传给 native command 会合并参数，属于 PS 已知 bug）
            const quotedParts = cmdParts.map(p => `'${p.replace(/'/g, "''")}'`);
            const psScript = `& ${quotedParts.join(' ')}`;
            const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
            shell = shellType === 'pwsh' ? 'pwsh.exe' : 'powershell.exe';
            shellArgs = ['-NoLogo', '-EncodedCommand', encoded];
            console.log(`[SessionManager] PS script: ${psScript}`);
            break;
          }
          case 'cmd': {
            const fullCmd = cmdParts.map(p =>
              (/[\s&|<>^"%!]/.test(p) || /[^\x20-\x7E]/.test(p)) ? `"${p.replace(/"/g, '""')}"` : p
            ).join(' ');
            shell = 'cmd.exe';
            shellArgs = ['/c', fullCmd];
            console.log(`[SessionManager] cmd: ${fullCmd}`);
            break;
          }
        }
      }
    } else {
      shell = 'bash';
      if (config.promptFile) {
        // Unix: cat promptFile | claude -p --dangerously-skip-permissions
        const quotedParts = [command, ...args].map(p => `'${p.replace(/'/g, "'\\''")}'`);
        shellArgs = ['-c', `cat '${config.promptFile.replace(/'/g, "\\'")}' | ${quotedParts.join(' ')}`];
      } else if (promptToSend) {
        const escaped = promptToSend.replace(/'/g, "'\\''");
        shellArgs = ['-c', `${command} ${args.join(' ')} '${escaped}'`];
      } else {
        shellArgs = ['-c', `${command} ${args.join(' ')}`];
      }
    }

    // 创建 PTY 进程
    // ★ Agent 子会话使用更大的终端行数（80行），避免 TUI 布局在 30 行中拥挤导致重叠
    // 普通交互会话保持 30 行（UI 终端组件会通过 resize 同步实际窗口大小）
    const ptyRows = config.agentId ? 80 : 30;
    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: ptyRows,
      cwd: config.workingDirectory,
      env
    });

    // 创建内部会话对象
    // Agent 子会话（有 agentId）锁定名称，防止 MCP server 启动输出的 OSC 标题覆盖
    const session: InternalSession = {
      id,
      name: config.name || `Session-${id.slice(0, 8)}`,
      nameLocked: !!config.agentId,
      workingDirectory: config.workingDirectory,
      status: 'running' as SessionStatus,
      pty: ptyProcess,
      config,
      outputBuffer: new RingBuffer(5000),
      startTime: new Date(),
      estimatedTokens: 0,
      isPaused: false
    };

    this.sessions.set(id, session);

    // stdin 模式：启动后延迟写入初始 prompt
    if (promptForStdin) {
      setTimeout(() => {
        const s = this.sessions.get(id);
        if (s && s.status !== 'completed') {
          s.pty.write(promptForStdin + '\n');
          console.log(`[SessionManager] Sent prompt via stdin for session ${id}`);
        }
      }, 1500);
    }

    // 绑定 PTY 事件
    // 注意: 回调通过闭包持有 session 对象引用。当 createSessionWithId 替换会话时，
    // 旧 PTY 的回调仍会触发，需要检查 Map 中是否还是同一个对象来避免污染新会话。
    ptyProcess.onData((data: string) => {
      // 会话已被替换（恢复场景），忽略旧 PTY 的输出
      if (this.sessions.get(id) !== session) return;

      session.outputBuffer.push(data);

      // 供 output-regex 模式检测 session ID
      this.emit(`_raw_output_${id}`, data);

      if (!session.nameLocked) {
        const title = this.parseOscTitle(data);
        if (title && title.length > 0 && !this.isShellTitle(title) && title !== session.name) {
          session.name = title;
          // OSC 标题不锁定，等活动事件给出更有意义的名称后再锁
          this.emit('title-change', id, title);
        }
      }

      this.emit('output', id, data);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      // 清理 Agent prompt 临时文件
      if (config.promptFile) {
        try {
          const fs = require('fs');
          if (fs.existsSync(config.promptFile)) {
            fs.unlinkSync(config.promptFile);
            console.log(`[SessionManager] Cleaned up prompt file: ${config.promptFile}`);
          }
        } catch (_) { /* ignore */ }
      }

      // 会话已被替换（恢复场景），旧 PTY 退出不应影响新会话
      if (this.sessions.get(id) !== session) {
        console.log(`[SessionManager] Old PTY exited for replaced session ${id}, skipping events`);
        return;
      }

      // ★ 如果 terminateSession 已经处理过（status 已是 completed），
      // 只补充 exitCode 信息，不重复发射 status-change 事件
      if (session.status === 'completed') {
        session.exitCode = exitCode;
        // 仍然发射 activity 事件（补充退出码信息），但不发射 status-change
        this.emit('activity', id, {
          id: uuidv4(),
          sessionId: id,
          timestamp: new Date().toISOString(),
          type: 'task_complete',
          detail: `Session ended with code ${exitCode}${signal ? `, signal ${signal}` : ''}`,
          metadata: { exitCode, signal }
        } as ActivityEvent);
        return;
      }

      session.status = 'completed';
      session.endTime = new Date();
      session.exitCode = exitCode;

      this.emit('status-change', id, 'completed');
      this.emit('activity', id, {
        id: uuidv4(),
        sessionId: id,
        timestamp: new Date().toISOString(),
        type: 'task_complete',
        detail: `Session ended with code ${exitCode}${signal ? `, signal ${signal}` : ''}`,
        metadata: { exitCode, signal }
      } as ActivityEvent);
    });

    this.emit('status-change', id, 'running');
    this.emit('activity', id, {
      id: uuidv4(),
      sessionId: id,
      timestamp: new Date().toISOString(),
      type: 'session_start',
      detail: `Session started in ${config.workingDirectory} (${resolvedProvider.name})`,
      metadata: { config, providerId: resolvedProvider.id }
    } as ActivityEvent);

    // 根据 provider 配置分发会话 ID 检测策略
    // claude-jsonl 模式由 ClaudeJsonlReader 的目录扫描自动驱动，不再在此检测
    if (resolvedProvider.sessionIdDetection === 'output-regex' && resolvedProvider.sessionIdPattern) {
      this.detectSessionIdFromOutput(id, resolvedProvider.sessionIdPattern);
    }

    return id;
  }

  /**
   * 终止会话
   */
  terminateSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }

    if (session.status === 'completed') {
      return; // 已完成的会话无需终止
    }

    // ★ 先标记状态为 completed，这样 pty.onExit 回调触发时检测到状态已是 completed
    // 就不会再重复发射 status-change 事件（见 onExit 中的守卫）
    session.status = 'completed';
    session.endTime = new Date();
    session.pty.kill();

    this.emit('status-change', id, 'completed');
    this.emit('activity', id, {
      id: uuidv4(),
      sessionId: id,
      timestamp: new Date().toISOString(),
      type: 'session_end',
      detail: 'Session terminated by user',
      metadata: { reason: 'user_termination' }
    } as ActivityEvent);
  }

  /**
   * 暂停会话（发送 Ctrl+C）
   */
  pauseSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }

    if (session.status !== 'running') {
      throw new Error(`Cannot pause session ${id} with status ${session.status}`);
    }

    // 发送 Ctrl+C 信号
    session.pty.write('\x03');
    session.isPaused = true;
    session.status = 'paused';

    this.emit('status-change', id, 'paused');
    this.emit('activity', id, {
      id: uuidv4(),
      sessionId: id,
      timestamp: new Date().toISOString(),
      type: 'user_input',
      detail: 'Session paused',
      metadata: { action: 'pause' }
    } as ActivityEvent);
  }

  /**
   * 恢复会话
   */
  resumeSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }

    session.isPaused = false;
    session.status = 'running';

    this.emit('status-change', id, 'running');
    this.emit('activity', id, {
      id: uuidv4(),
      sessionId: id,
      timestamp: new Date().toISOString(),
      type: 'user_input',
      detail: 'Session resumed',
      metadata: { action: 'resume' }
    } as ActivityEvent);
  }

  /**
   * 向会话发送输入
   * 缓冲按键，只在用户按回车时才发 activity 事件
   */
  sendInput(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }

    session.pty.write(data);

    // 缓冲输入，回车时才发活动事件
    const buffer = (this.inputBuffers.get(id) || '') + data;

    if (data.includes('\r') || data.includes('\n')) {
      const input = buffer.replace(/[\r\n]/g, '').trim();
      if (input) {
        this.emit('activity', id, {
          id: uuidv4(),
          sessionId: id,
          timestamp: new Date().toISOString(),
          type: 'user_input',
          detail: `用户输入: ${input.length > 100 ? input.slice(0, 100) + '...' : input}`,
          metadata: { inputLength: input.length }
        } as ActivityEvent);
      }
      this.inputBuffers.set(id, '');
    } else {
      this.inputBuffers.set(id, buffer);
    }
  }

  /**
   * 发送确认响应（y/n）
   */
  sendConfirmation(id: string, accept: boolean): void {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }

    const response = accept ? 'y\n' : 'n\n';
    session.pty.write(response);

    this.emit('activity', id, {
      id: uuidv4(),
      sessionId: id,
      timestamp: new Date().toISOString(),
      type: 'user_input',
      detail: `Confirmation: ${accept ? 'accepted' : 'rejected'}`,
      metadata: { accept }
    } as ActivityEvent);
  }

  /**
   * 调整终端大小
   */
  resizeSession(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }

    session.pty.resize(cols, rows);
  }

  /**
   * 获取会话
   */
  getSession(id: string): InternalSession | undefined {
    return this.sessions.get(id);
  }

  /**
   * 获取所有会话
   */
  getAllSessions(): InternalSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * 按状态获取会话
   */
  getSessionsByStatus(status: SessionStatus): InternalSession[] {
    return this.getAllSessions().filter(s => s.status === status);
  }

  /**
   * 根据 Provider 配置构建命令和参数
   * @returns command: 可执行命令, args: 参数数组, promptForStdin: stdin 模式时需要发送的 prompt
   */
  private buildProviderCommand(config: SessionConfig, provider: AIProvider): {
    command: string
    args: string[]
    promptForStdin: string | null
  } {
    const command = provider.command;
    const args: string[] = [];

    // 检测是否为恢复会话（claudeArgs 中包含 resumeArg）
    const resumeArg = provider.resumeArg;
    const isSubcommandResume = provider.resumeFormat === 'subcommand';
    const hasResumeInArgs = resumeArg && config.claudeArgs?.some(a => a === resumeArg);

    if (isSubcommandResume && hasResumeInArgs) {
      // 子命令模式恢复（如 codex resume <id>）：
      // resumeArg 和 sessionId 放最前面，不附加 defaultArgs/autoAcceptArg
      args.push(...config.claudeArgs!);
    } else {
      // 常规模式 / flag 模式恢复

      // 附加 provider 的默认参数
      if (provider.defaultArgs && provider.defaultArgs.length > 0) {
        args.push(...provider.defaultArgs);
      }

      // autoAccept 使用 provider 指定的参数
      if (config.autoAccept && provider.autoAcceptArg) {
        args.push(provider.autoAcceptArg);
      }

      // MCP 配置注入（Agent 编排功能）
      if (config.mcpConfigPath) {
        args.push('--mcp-config', config.mcpConfigPath);
      }

      // 兼容旧会话的 claudeArgs（恢复场景）
      if (config.claudeArgs && config.claudeArgs.length > 0) {
        args.push(...config.claudeArgs);
      }
    }

    // stdin 模式时，prompt 不放在命令行而是延迟写入
    let promptForStdin: string | null = null;
    if (config.initialPrompt && provider.promptPassMode === 'stdin') {
      promptForStdin = config.initialPrompt;
    }

    return { command, args, promptForStdin };
  }

  /**
   * 判断标题是否为 Windows Shell 路径（不应作为会话名称）
   * 如 "C:\Windows\System32\cmd.exe"、"C:\Windows\system32\WindowsPowerShell\..."
   */
  private isShellTitle(title: string): boolean {
    // Windows 可执行文件路径
    if (/\.exe\b/i.test(title)) return true
    // Windows 系统目录路径
    if (/^[A-Za-z]:\\Windows\\/i.test(title)) return true
    // 常见 shell 窗口标题
    if (/^(Windows PowerShell|Administrator:|管理员：|Select |选择)/i.test(title)) return true
    // Claude CLI 通用默认标题（不应覆盖活动级名称）
    if (/^Claude\s*(Code)?$/i.test(title)) return true
    return false
  }

  /**
   * 外部更新会话名称（如通过活动事件动态命名）
   */
  updateSessionName(id: string, name: string): void {
    const session = this.sessions.get(id)
    if (!session || !name || name === session.name || session.nameLocked) return
    session.name = name
    session.nameLocked = true
    this.emit('title-change', id, name)
  }

  /**
   * 设置会话的 Claude 内部会话 ID（由 Reader 发现事件调用）
   * @returns true 设置成功，false 会话不存在或已有 ID
   */
  setClaudeSessionId(sessionId: string, claudeId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session || session.claudeSessionId) return false
    session.claudeSessionId = claudeId
    return true
  }

  /**
   * 用户手动重命名会话（锁定名称，阻止后续自动覆盖）
   * @returns true 如果会话在内存中被更新，false 如果会话不在内存中（已完成）
   */
  renameSession(id: string, name: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.name = name
    session.nameLocked = true
    this.emit('title-change', id, name)
    return true
  }

  /**
   * 从 PTY 原始输出中解析 OSC 标题转义序列
   * 格式: ESC ] 0|2 ; title BEL  或  ESC ] 0|2 ; title ST
   */
  private parseOscTitle(data: string): string | null {
    // 匹配 \x1B]0;...\x07 或 \x1B]2;...\x07 或 \x1B]0;...\x1B\\
    const match = data.match(/\x1B\](?:0|2);([^\x07\x1B]*?)(?:\x07|\x1B\\)/);
    if (match && match[1]) {
      const title = match[1].trim();
      // 过滤掉过短或无意义的标题
      if (title.length >= 2) {
        return title;
      }
    }
    return null;
  }

  /**
   * 检测 Claude Code 内部会话 ID
   * 用"快照对比"法：启动前记录已有 .jsonl 文件，之后找新增的文件
   * ★ 只扫描 cwd 对应的项目目录（Claude Code 按项目路径隔离会话）
   */
  private detectClaudeSessionId(sessionId: string, cwd: string): void {
    const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(claudeProjectsDir)) return;

    // 将工作目录映射到 Claude 的项目目录（与 ClaudeJsonlReader.computeProjectHash 一致）
    const projectHash = cwd.replace(/[\\/]+$/, '').replace(/[^a-zA-Z0-9]/g, '-');
    const projectDir = path.join(claudeProjectsDir, projectHash);

    // 启动前拍快照：只记录本项目目录中的 .jsonl 文件
    const existingFiles = new Set(this.getJsonlFilesInDir(projectDir));
    console.log(`[SessionManager] Snapshot: ${existingFiles.size} existing .jsonl files in ${projectHash}`);

    // 多次尝试检测，延迟递增（Claude Code 可能需要几秒才创建会话文件）
    const delays = [3000, 6000, 12000];
    for (const delay of delays) {
      setTimeout(() => {
        const session = this.sessions.get(sessionId);
        // 已找到 ID 或会话已结束则跳过
        if (!session || session.claudeSessionId || session.status === 'completed') return;

        try {
          const currentFiles = this.getJsonlFilesInDir(projectDir);
          // 找出新增的文件（会话启动后才出现的）
          const newFiles = currentFiles.filter(f => !existingFiles.has(f));

          if (newFiles.length === 0) {
            console.log(`[SessionManager] Detection at ${delay}ms: no new .jsonl files in ${projectHash}`);
            return;
          }

          // 如果只有一个新文件，就是它；多个则选最新的
          let targetFile: string;
          if (newFiles.length === 1) {
            targetFile = newFiles[0];
          } else {
            targetFile = newFiles.reduce((newest, file) => {
              try {
                const a = fs.statSync(newest).mtimeMs;
                const b = fs.statSync(file).mtimeMs;
                return b > a ? file : newest;
              } catch { return newest; }
            });
          }

          const claudeId = path.basename(targetFile).replace('.jsonl', '');
          session.claudeSessionId = claudeId;
          this.emit('claude-session-id', sessionId, claudeId);
          console.log(`[SessionManager] Detected Claude session ID: ${claudeId} (in ${projectHash}, ${delay}ms)`);
        } catch (err) {
          console.warn(`[SessionManager] Detection at ${delay}ms failed:`, err);
        }
      }, delay);
    }
  }

  /**
   * 获取指定目录下的所有 .jsonl 文件完整路径
   */
  private getJsonlFilesInDir(dirPath: string): string[] {
    const files: string[] = [];
    try {
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return files;
      const entries = fs.readdirSync(dirPath);
      for (const entry of entries) {
        if (entry.endsWith('.jsonl')) {
          files.push(path.join(dirPath, entry));
        }
      }
    } catch { /* ignore */ }
    return files;
  }

  /**
   * 从 CLI 输出中通过正则匹配检测会话 ID（用于非 Claude 的 Provider）
   * 仅在前 30 秒内扫描输出，匹配到后立即停止
   */
  private detectSessionIdFromOutput(sessionId: string, pattern: string): void {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (err) {
      console.warn(`[SessionManager] Invalid sessionIdPattern: ${pattern}`, err);
      return;
    }

    const startTime = Date.now();
    const SCAN_TIMEOUT = 30000; // 30 秒扫描窗口

    const onDataHandler = (data: string) => {
      const session = this.sessions.get(sessionId);
      if (!session || session.claudeSessionId || session.status === 'completed') {
        // 已找到 ID 或会话已结束，移除监听
        this.removeListener(`_raw_output_${sessionId}`, onDataHandler);
        return;
      }

      if (Date.now() - startTime > SCAN_TIMEOUT) {
        // 超过扫描窗口，停止扫描
        this.removeListener(`_raw_output_${sessionId}`, onDataHandler);
        console.log(`[SessionManager] Output-regex scan timed out for session ${sessionId}`);
        return;
      }

      const match = regex.exec(data);
      if (match && match[1]) {
        session.claudeSessionId = match[1];
        this.emit('claude-session-id', sessionId, match[1]);
        this.removeListener(`_raw_output_${sessionId}`, onDataHandler);
        console.log(`[SessionManager] Detected session ID from output: ${match[1]}`);
      }
    };

    this.on(`_raw_output_${sessionId}`, onDataHandler);
  }

  /**
   * 解析 nvm 版本目录路径
   * Windows 返回 nvm 版本目录，Unix/macOS 返回 bin 目录
   * ★ 改为 static 以支持外部模块复用（如 providerAvailability）
   */
  static resolveNvmNodeDir(version: string): string | null {
    return resolveNodeBinDir(version);
  }

  /**
   * 列出 nvm 已安装的 Node.js 版本
   * 供 IPC 调用，渲染进程用于 Provider 编辑时的版本选择
   */
  static listNvmVersions(): string[] {
    return listInstalledNodeVersions();
  }

  /**
   * 清理已完成的会话
   */
  cleanupCompletedSessions(olderThan?: Date): void {
    const cutoffTime = olderThan || new Date(Date.now() - 24 * 60 * 60 * 1000); // 默认24小时前

    for (const [id, session] of this.sessions.entries()) {
      if (session.status === 'completed' && session.endTime && session.endTime < cutoffTime) {
        this.sessions.delete(id);
      }
    }
  }

  /**
   * 获取会话输出缓冲区
   */
  getSessionOutput(id: string, recent?: number): string[] {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }

    return recent ? session.outputBuffer.getRecent(recent) : session.outputBuffer.getAll();
  }
}
