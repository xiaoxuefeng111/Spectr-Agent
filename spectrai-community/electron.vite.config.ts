import { resolve } from 'path'
import { builtinModules } from 'module'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// 只有原生模块和 electron 需要 external，其余纯 JS 依赖由 vite 打包进 bundle
// 这样避免 electron-builder 打包时依赖提升(hoisting)导致模块找不到
const nativeExternals = [
  'electron',
  'node-pty',
  'better-sqlite3',
  'bufferutil',
  'utf-8-validate',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`)
]

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'agent/AgentMCPServer': resolve(__dirname, 'src/main/agent/AgentMCPServer.ts')
        },
        external: nativeExternals
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()],
    css: {
      postcss: resolve(__dirname, 'postcss.config.js')
    }
  }
})
