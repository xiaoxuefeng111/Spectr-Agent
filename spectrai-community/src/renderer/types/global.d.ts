/**
 * 全局类型声明 - 扩展 window 对象
 * 类型定义来源：src/preload/index.d.ts
 * @author weibin
 */

import type { SpectrAIAPI } from '../../preload/index.d'

declare global {
  interface Window {
    spectrAI: SpectrAIAPI
  }
}

export {}
