import { describe, expect, it } from 'vitest'
import {
  classifyTamperPath,
  collectTamperSignals,
  hasTamperSignals,
  isTestFilePath,
  parseDiffByFile,
} from '../../../src/core/tamper'

const diff = (...lines: string[]): string => `diff --git a/test/renewal.test.ts b/test/renewal.test.ts\n--- a/test/renewal.test.ts\n+++ b/test/renewal.test.ts\n@@ -1,3 +1,2 @@\n${lines.join('\n')}\n`

describe('isTestFilePath', () => {
  it('识别常见测试文件与测试目录', () => {
    expect(isTestFilePath('test/renewal.test.ts')).toBe(true)
    expect(isTestFilePath('src/__tests__/a.tsx')).toBe(true)
    expect(isTestFilePath('pkg/foo_test.go')).toBe(true)
    expect(isTestFilePath('src/test/java/AuthTest.java')).toBe(true)
    expect(isTestFilePath('src/app.ts')).toBe(false)
    expect(isTestFilePath('README.md')).toBe(false)
  })
})

describe('classifyTamperPath', () => {
  it('识别 CI / lint / 覆盖率 / 测试运行器配置', () => {
    expect(classifyTamperPath('.github/workflows/ci.yml')).toBe('modified-ci')
    expect(classifyTamperPath('Jenkinsfile')).toBe('modified-ci')
    expect(classifyTamperPath('eslint.config.js')).toBe('modified-lint-config')
    expect(classifyTamperPath('.eslintrc.json')).toBe('modified-lint-config')
    expect(classifyTamperPath('vitest.config.ts')).toBe('modified-coverage-config')
    expect(classifyTamperPath('.nycrc')).toBe('modified-coverage-config')
    expect(classifyTamperPath('pytest.ini')).toBe('modified-test-config')
    expect(classifyTamperPath('src/index.ts')).toBeNull()
  })
})

describe('parseDiffByFile', () => {
  it('按文件拆出新增/删除行，并识别 deleted file', () => {
    const files = parseDiffByFile(
      [
        'diff --git a/test/a.test.ts b/test/a.test.ts',
        'deleted file mode 100644',
        '--- a/test/a.test.ts',
        '+++ /dev/null',
        'diff --git a/src/x.ts b/src/x.ts',
        '--- a/src/x.ts',
        '+++ b/src/x.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n'),
    )
    expect(files).toHaveLength(2)
    expect(files[0]!.path).toBe('test/a.test.ts')
    expect(files[0]!.deleted).toBe(true)
    expect(files[1]!.path).toBe('src/x.ts')
    expect(files[1]!.added).toEqual(['new'])
    expect(files[1]!.removed).toEqual(['old'])
  })
})

describe('collectTamperSignals（T3.5）', () => {
  it('新增 @Disabled / .skip( / pytest.mark.skip 标记为跳过测试', () => {
    const signals = collectTamperSignals(
      [
        'diff --git a/test/a.test.ts b/test/a.test.ts',
        '+++ b/test/a.test.ts',
        '+it.skip("失败用例先跳过", () => {})',
        'diff --git a/test/b.test.ts b/test/b.test.ts',
        '+++ b/test/b.test.ts',
        '+  @Disabled("flaky")',
        'diff --git a/tests/test_c.py b/tests/test_c.py',
        '+++ b/tests/test_c.py',
        '+@pytest.mark.skip(reason="later")',
      ].join('\n'),
    )
    expect(signals.filter((signal) => signal.kind === 'skipped-test')).toHaveLength(3)
  })

  it('测试文件里删除断言标记为 removed-assertion；非测试文件不算', () => {
    const signals = collectTamperSignals(
      [
        'diff --git a/test/a.test.ts b/test/a.test.ts',
        '+++ b/test/a.test.ts',
        '-expect(result).toBe(42)',
        'diff --git a/src/app.ts b/src/app.ts',
        '+++ b/src/app.ts',
        '-expect(unused).toBe(1)',
      ].join('\n'),
    )
    expect(signals).toEqual([expect.objectContaining({ kind: 'removed-assertion', path: 'test/a.test.ts' })])
  })

  it('删除测试文件、改动 CI/lint/覆盖率配置都会产生信号', () => {
    const signals = collectTamperSignals(
      [
        'diff --git a/test/a.test.ts b/test/a.test.ts',
        'deleted file mode 100644',
        'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml',
        '+++ b/.github/workflows/ci.yml',
        '+run: nope',
        'diff --git a/eslint.config.js b/eslint.config.js',
        '+++ b/eslint.config.js',
        '+export default []',
      ].join('\n'),
      ['coverage/lcov.info'],
    )
    const kinds = signals.map((signal) => signal.kind)
    expect(kinds).toContain('removed-test-file')
    expect(kinds).toContain('modified-ci')
    expect(kinds).toContain('modified-lint-config')
    expect(kinds).toContain('modified-coverage-config')
  })

  it('同一 kind+path 去重；无信号时 hasTamperSignals=false', () => {
    const signals = collectTamperSignals(
      [
        'diff --git a/test/a.test.ts b/test/a.test.ts',
        '+++ b/test/a.test.ts',
        '+it.skip("a", () => {})',
        '+it.skip("b", () => {})',
      ].join('\n'),
    )
    expect(signals).toHaveLength(1)
    expect(hasTamperSignals(signals)).toBe(true)
    expect(hasTamperSignals([])).toBe(false)
  })

  it('普通源码改动不产生信号', () => {
    expect(collectTamperSignals(diff('-const a = 1', '+const a = 2'))).toEqual([])
  })
})
