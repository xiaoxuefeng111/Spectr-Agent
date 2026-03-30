/**
 * ConcurrencyGuard - 并发控制和资源检查
 * @author weibin
 */

import os from 'os';
import { execFileSync } from 'node:child_process';

export interface ConcurrencyConfig {
  maxSessions: number;
  minMemoryMB: number;
  maxCpuPercent: number;
}

export interface ResourceStatus {
  canCreate: boolean;
  reason?: string;
  currentSessions: number;
  maxSessions: number;
  memoryUsagePercent: number;
  availableMemoryMB: number;
}

export class ConcurrencyGuard {
  private config: ConcurrencyConfig;
  private activeSessions: number = 0;

  constructor(config?: Partial<ConcurrencyConfig>) {
    const defaultMinMemoryMB = process.platform === 'darwin' ? 256 : 512;
    this.config = {
      maxSessions: config?.maxSessions || 9,
      minMemoryMB: config?.minMemoryMB || defaultMinMemoryMB,
      maxCpuPercent: config?.maxCpuPercent || 90
    };
  }

  private getMemorySnapshot(): { totalMemMB: number; availableMemMB: number; memoryUsagePercent: number } {
    const totalMemMB = os.totalmem() / (1024 * 1024);
    const fallbackFreeMemMB = os.freemem() / (1024 * 1024);

    if (process.platform !== 'darwin') {
      const memoryUsagePercent = ((totalMemMB - fallbackFreeMemMB) / totalMemMB) * 100;
      return { totalMemMB, availableMemMB: fallbackFreeMemMB, memoryUsagePercent };
    }

    try {
      const vmStatOutput = execFileSync('/usr/bin/vm_stat', {
        encoding: 'utf8',
        timeout: 1200,
      });

      const pageSizeMatch = vmStatOutput.match(/page size of (\d+) bytes/i);
      if (!pageSizeMatch) {
        const memoryUsagePercent = ((totalMemMB - fallbackFreeMemMB) / totalMemMB) * 100;
        return { totalMemMB, availableMemMB: fallbackFreeMemMB, memoryUsagePercent };
      }

      const pageSize = Number(pageSizeMatch[1]);
      const freePages = this.parseVmStatPages(vmStatOutput, 'Pages free');
      const inactivePages = this.parseVmStatPages(vmStatOutput, 'Pages inactive');
      const speculativePages = this.parseVmStatPages(vmStatOutput, 'Pages speculative');
      const purgeablePages = this.parseVmStatPages(vmStatOutput, 'Pages purgeable');

      const reclaimablePages = freePages + inactivePages + speculativePages + purgeablePages;
      const vmStatAvailableMB = (reclaimablePages * pageSize) / (1024 * 1024);
      const availableMemMB = Number.isFinite(vmStatAvailableMB) && vmStatAvailableMB > 0
        ? Math.max(fallbackFreeMemMB, vmStatAvailableMB)
        : fallbackFreeMemMB;
      const memoryUsagePercent = ((totalMemMB - availableMemMB) / totalMemMB) * 100;
      return { totalMemMB, availableMemMB, memoryUsagePercent };
    } catch {
      const memoryUsagePercent = ((totalMemMB - fallbackFreeMemMB) / totalMemMB) * 100;
      return { totalMemMB, availableMemMB: fallbackFreeMemMB, memoryUsagePercent };
    }
  }

  private parseVmStatPages(output: string, label: string): number {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = output.match(new RegExp(`${escapedLabel}:\\s*(\\d+)\\.`, 'i'));
    return match ? Number(match[1]) : 0;
  }

  /**
   * 检查是否可以创建新会话
   */
  canCreateSession(): boolean {
    if (this.activeSessions >= this.config.maxSessions) {
      return false;
    }
    return true;
  }

  /**
   * 检查系统资源状态
   */
  checkResources(): ResourceStatus {
    const { availableMemMB, memoryUsagePercent } = this.getMemorySnapshot();

    // 检查会话数限制
    if (this.activeSessions >= this.config.maxSessions) {
      return {
        canCreate: false,
        reason: `Maximum session limit reached (${this.config.maxSessions})`,
        currentSessions: this.activeSessions,
        maxSessions: this.config.maxSessions,
        memoryUsagePercent,
        availableMemoryMB: availableMemMB
      };
    }

    // 检查内存
    if (availableMemMB < this.config.minMemoryMB) {
      return {
        canCreate: false,
        reason: `Insufficient memory (${Math.round(availableMemMB)}MB available, ${this.config.minMemoryMB}MB required)`,
        currentSessions: this.activeSessions,
        maxSessions: this.config.maxSessions,
        memoryUsagePercent,
        availableMemoryMB: availableMemMB
      };
    }

    return {
      canCreate: true,
      currentSessions: this.activeSessions,
      maxSessions: this.config.maxSessions,
      memoryUsagePercent,
      availableMemoryMB: availableMemMB
    };
  }

  /**
   * 注册新会话
   */
  registerSession(): void {
    this.activeSessions++;
  }

  /**
   * 注销会话
   */
  unregisterSession(): void {
    if (this.activeSessions > 0) {
      this.activeSessions--;
    }
  }

  /**
   * 获取当前活跃会话数
   */
  getActiveSessionCount(): number {
    return this.activeSessions;
  }

  /**
   * 获取最大会话数
   */
  getMaxSessions(): number {
    return this.config.maxSessions;
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<ConcurrencyConfig>): void {
    this.config = {
      ...this.config,
      ...config
    };
  }

  /**
   * 获取系统信息
   */
  getSystemInfo(): {
    platform: string;
    arch: string;
    cpuCount: number;
    totalMemoryMB: number;
    freeMemoryMB: number;
    uptime: number;
  } {
    return {
      platform: os.platform(),
      arch: os.arch(),
      cpuCount: os.cpus().length,
      totalMemoryMB: os.totalmem() / (1024 * 1024),
      freeMemoryMB: os.freemem() / (1024 * 1024),
      uptime: os.uptime()
    };
  }

  /**
   * 检查是否应该警告用户资源不足
   */
  shouldWarnResources(): { warn: boolean; message?: string } {
    const { memoryUsagePercent } = this.getMemorySnapshot();

    if (memoryUsagePercent > 85) {
      return {
        warn: true,
        message: `High memory usage: ${Math.round(memoryUsagePercent)}%`
      };
    }

    if (this.activeSessions >= this.config.maxSessions * 0.8) {
      return {
        warn: true,
        message: `Approaching session limit: ${this.activeSessions}/${this.config.maxSessions}`
      };
    }

    return { warn: false };
  }
}
