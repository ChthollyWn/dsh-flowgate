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
      // 回归防线（NFR-5 核心逻辑单测覆盖率 ≥ 80%）。阈值按第五轮实测设定并留余量；
      // thresholds 检查的是 core+host 合计口径。
      // 实测（2026-10-31 第五轮 `pnpm coverage`，语句/分支/函数/行）：
      //   core 82.97% / 68.50% / 81.51% / 88.15%；host 73.76% / 65.10% / 70.00% / 77.82%；
      //   core+host 合计 86.19% / 75.84% / 86.60% / 89.29%。
      // （早期注释里的 90.0/80.0/90.6/92.6 是第二轮 core-only 口径，已过期。）
      thresholds: {
        statements: 80,
        functions: 80,
        lines: 80,
        branches: 70,
      },
    },
  },
})
