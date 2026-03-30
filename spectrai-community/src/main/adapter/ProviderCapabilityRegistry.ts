/**
 * Provider 能力注册表
 * 声明每个 AI Provider 对 MCP 和 Skill 的支持能力
 * @author weibin
 */
import type { ProviderCapability, ProviderMcpCapability, ProviderSkillCapability } from '../../shared/types'

export class ProviderCapabilityRegistry {
  private static readonly capabilities: ReadonlyMap<string, ProviderCapability> = new Map([
    ['claude-code', {
      providerId: 'claude-code',
      mcpSupport: {
        native: true,
        configFlag: '--mcp-config',
        configFormat: 'json',
        fallback: 'none',
      },
      skillSupport: {
        slashCommands: true,
        systemPrompt: true,
        nativeSkillDir: '.claude/commands',
      },
    }],
    ['codex', {
      providerId: 'codex',
      mcpSupport: {
        native: false,
        fallback: 'prompt-injection',
      },
      skillSupport: {
        slashCommands: false,
        systemPrompt: true,
      },
    }],
    ['gemini-cli', {
      providerId: 'gemini-cli',
      mcpSupport: {
        native: false,
        fallback: 'prompt-injection',
      },
      skillSupport: {
        slashCommands: false,
        systemPrompt: true,
      },
    }],
    ['iflow', {
      providerId: 'iflow',
      mcpSupport: {
        native: true,
        configFlag: '--mcp-config',
        configFormat: 'json',
        fallback: 'none',
      },
      skillSupport: {
        slashCommands: false,
        systemPrompt: true,
      },
    }],
    ['opencode', {
      providerId: 'opencode',
      mcpSupport: {
        native: true,
        configEnvVar: 'OPENCODE_CONFIG',
        configFormat: 'json-opencode',
        fallback: 'none',
      },
      skillSupport: {
        slashCommands: false,
        systemPrompt: true,
      },
    }],
  ])

  /** 获取指定 Provider 的完整能力描述 */
  static get(providerId: string): ProviderCapability | undefined {
    return this.capabilities.get(providerId)
  }

  /** 获取所有 Provider 的能力列表 */
  static getAll(): ProviderCapability[] {
    return Array.from(this.capabilities.values())
  }

  /** 获取指定 Provider 的 MCP 能力（未注册时返回保守默认值） */
  static getMcpCapability(providerId: string): ProviderMcpCapability {
    return this.capabilities.get(providerId)?.mcpSupport ?? {
      native: false,
      fallback: 'none',
    }
  }

  /** 获取指定 Provider 的 Skill 能力 */
  static getSkillCapability(providerId: string): ProviderSkillCapability {
    return this.capabilities.get(providerId)?.skillSupport ?? {
      slashCommands: false,
      systemPrompt: false,
    }
  }

  /** 是否原生支持 MCP */
  static supportsNativeMcp(providerId: string): boolean {
    return this.capabilities.get(providerId)?.mcpSupport.native ?? false
  }

  /** 是否支持 MCP Prompt Injection 降级 */
  static supportsMcpFallback(providerId: string): boolean {
    return this.capabilities.get(providerId)?.mcpSupport.fallback === 'prompt-injection'
  }
}
