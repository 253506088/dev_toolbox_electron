import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 合成媒体、验收快照与诊断目录可能含源码副本，不能作为当前项目的测试重复执行。
    exclude: [...configDefaults.exclude, 'test-results/**', 'playwright-report/**']
  }
})
