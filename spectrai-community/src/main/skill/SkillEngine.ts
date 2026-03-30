/**
 * Skill 引擎 - 处理 Prompt Skill 的模板展开和变量解析
 * @author weibin
 */
import type { Skill, SkillVariable } from '../../shared/types'

export class SkillEngine {
  /**
   * 展开技能提示词模板
   * @param skill - Skill 定义
   * @param userInput - 用户输入（/command 后的文本）
   * @param variables - 已解析的变量值
   * @returns 展开后的提示词
   */
  static expand(skill: Skill, userInput: string, variables?: Record<string, string>): string {
    if (!skill.promptTemplate) {
      // 没有模板，直接返回用户输入
      return userInput
    }

    let prompt = skill.promptTemplate

    // 替换用户输入占位符
    prompt = prompt.replace(/\{\{user_input\}\}/g, userInput)
    prompt = prompt.replace(/\{\{input\}\}/g, userInput)

    // 替换已提供的变量值
    if (variables) {
      for (const [key, value] of Object.entries(variables)) {
        prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value)
      }
    }

    // 用默认值填充未提供的变量
    if (skill.inputVariables) {
      for (const variable of skill.inputVariables) {
        if (variable.defaultValue !== undefined) {
          prompt = prompt.replace(
            new RegExp(`\\{\\{${variable.name}\\}\\}`, 'g'),
            variable.defaultValue,
          )
        }
      }
    }

    // 移除仍未替换的占位符（留空）
    prompt = prompt.replace(/\{\{[a-zA-Z_][a-zA-Z0-9_]*\}\}/g, '')

    // 前置系统提示词补充
    if (skill.systemPromptAddition) {
      prompt = `${skill.systemPromptAddition}\n\n${prompt}`
    }

    return prompt.trim()
  }

  /**
   * 从用户输入中解析 --varname=value 格式的变量
   * 例如：/translate --lang=英文 这段文字
   * @returns 解析出的变量 + 剩余文本
   */
  static parseVariables(
    userInput: string,
    variables: SkillVariable[],
  ): { parsedVariables: Record<string, string>; remainingInput: string } {
    const parsedVariables: Record<string, string> = {}
    let remaining = userInput

    // 匹配 --varname=value 或 --varname="value with spaces"
    const varPattern = /--(\w+)=(?:"([^"]*)"|(\S+))/g
    const matches = [...userInput.matchAll(varPattern)]

    for (const match of matches) {
      const varName = match[1]
      const varValue = match[2] ?? match[3] ?? ''
      // 只解析 skill 定义了的变量
      if (variables.some(v => v.name === varName)) {
        parsedVariables[varName] = varValue
        remaining = remaining.replace(match[0], '').trim()
      }
    }

    return { parsedVariables, remainingInput: remaining }
  }

  /**
   * 验证所有必填变量是否已提供
   * @returns 缺少的必填变量名列表（空数组=验证通过）
   */
  static validateVariables(skill: Skill, provided: Record<string, string>): string[] {
    if (!skill.inputVariables) return []
    return skill.inputVariables
      .filter(v => v.required && !provided[v.name] && !v.defaultValue)
      .map(v => v.name)
  }
}
