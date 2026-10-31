import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      // 口径：core 纯逻辑 + host 适配层。host/testing 是假宿主测试替身
      // （fake ctx/deps/ports），不属于产品代码，故排除。
      include: ['src/core/**/*.ts', 'src/host/**/*.ts'],
      exclude: ['src/core/**/*.d.ts', 'src/host/**/*.d.ts', 'src/host/testing/**'],
      // 回归防线（NFR-5 核心逻辑单测覆盖率 ≥ 80%）。阈值按最终实测设定并留余量：
      // 实测 core 语句 90.0% / 分支 80.0% / 函数 90.6% / 行 92.6%；
      // core+host 合计约 语句 83.9% / 分支 73.6% / 函数 83.5% / 行 87.0%。
      thresholds: {
        statements: 80,
        functions: 80,
        lines: 80,
        branches: 70,
      },
    },
  },
})
