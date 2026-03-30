/**
 * SessionManager 内部类型定义
 * @author weibin
 */

import type { SessionStatus, SessionConfig } from '../../shared/types';
import type { IPty } from 'node-pty';

/**
 * 环形缓冲区 - 用于高效存储会话输出
 */
export class RingBuffer {
  private buffer: string[];
  private index: number = 0;
  private size: number;
  private isFull: boolean = false;

  constructor(size: number = 1000) {
    this.size = size;
    this.buffer = new Array(size);
  }

  /**
   * 添加数据到缓冲区
   */
  push(data: string): void {
    this.buffer[this.index] = data;
    this.index = (this.index + 1) % this.size;
    if (this.index === 0) {
      this.isFull = true;
    }
  }

  /**
   * 获取所有数据（按时间顺序）
   */
  getAll(): string[] {
    if (!this.isFull) {
      return this.buffer.slice(0, this.index);
    }
    return [...this.buffer.slice(this.index), ...this.buffer.slice(0, this.index)];
  }

  /**
   * 获取最近的 n 条数据
   */
  getRecent(n: number): string[] {
    const all = this.getAll();
    return all.slice(Math.max(0, all.length - n));
  }

  /**
   * 清空缓冲区
   */
  clear(): void {
    this.buffer = new Array(this.size);
    this.index = 0;
    this.isFull = false;
  }

  /**
   * 获取当前存储的数据条数
   */
  get length(): number {
    return this.isFull ? this.size : this.index;
  }
}

/**
 * SessionManager 内部会话对象
 */
export interface InternalSession {
  id: string;
  name: string;
  workingDirectory: string;
  status: SessionStatus;
  pty: IPty;
  config: SessionConfig;
  outputBuffer: RingBuffer;
  startTime: Date;
  endTime?: Date;
  exitCode?: number;
  estimatedTokens: number;
  isPaused: boolean;
  /** Claude Code 内部会话 ID，用于 --resume <id> 直接恢复 */
  claudeSessionId?: string;
  /** 名称已锁定（第一次有意义的更新后不再变化） */
  nameLocked?: boolean;
}

/**
 * 会话创建选项
 */
export interface SessionCreateOptions {
  name: string;
  workingDirectory: string;
  config: SessionConfig;
}

/**
 * 终端大小
 */
export interface TerminalSize {
  cols: number;
  rows: number;
}
