import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  detectEvidenceKind,
  evidencePhase,
  parseCargoConsole,
  parseGoTestJson,
  parseGradleConsole,
  parseJestConsole,
  parseJUnitXml,
  parseMavenConsole,
  parsePytestConsole,
  parseTestOutput,
  parseVitestConsole,
  type ParseInput,
} from '../../../src/core/evidence/parse'

const FIXTURES = new URL('../../fixtures/test-outputs/', import.meta.url)

function fixture(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, FIXTURES)), 'utf8')
}

const TOOLCHAINS: {
  name: string
  parser: string
  parse: (text: string) => ReturnType<typeof parseJUnitXml>
  samples: {
    pass: string
    fail: string
    zero: string
    passCounts: [number, number, number, number]
    failCounts: [number, number, number, number]
  }
}[] = [
  {
    name: 'surefire junit xml',
    parser: 'junit-xml',
    parse: parseJUnitXml,
    samples: {
      pass: 'surefire-junit/pass.xml',
      fail: 'surefire-junit/fail.xml',
      zero: 'surefire-junit/zero.xml',
      passCounts: [3, 2, 0, 1],
      failCounts: [3, 2, 1, 0],
    },
  },
  {
    name: 'gradle junit xml',
    parser: 'junit-xml',
    parse: parseJUnitXml,
    samples: {
      pass: 'gradle-junit/pass.xml',
      fail: 'gradle-junit/fail.xml',
      zero: 'gradle-junit/zero.xml',
      passCounts: [4, 3, 0, 1],
      failCounts: [3, 2, 1, 0],
    },
  },
  {
    name: 'gradle console',
    parser: 'gradle-console',
    parse: parseGradleConsole,
    samples: {
      pass: 'gradle-console/pass.txt',
      fail: 'gradle-console/fail.txt',
      zero: 'gradle-console/zero.txt',
      passCounts: [4, 3, 0, 1],
      failCounts: [3, 2, 1, 0],
    },
  },
  {
    name: 'maven console',
    parser: 'maven-console',
    parse: parseMavenConsole,
    samples: {
      pass: 'maven-console/pass.txt',
      fail: 'maven-console/fail.txt',
      zero: 'maven-console/zero.txt',
      passCounts: [4, 3, 0, 1],
      failCounts: [4, 3, 1, 0],
    },
  },
  {
    name: 'pytest console',
    parser: 'pytest-console',
    parse: parsePytestConsole,
    samples: {
      pass: 'pytest-console/pass.txt',
      fail: 'pytest-console/fail.txt',
      zero: 'pytest-console/zero.txt',
      passCounts: [3, 3, 0, 0],
      failCounts: [3, 2, 1, 0],
    },
  },
  {
    name: 'pytest junitxml',
    parser: 'junit-xml',
    parse: parseJUnitXml,
    samples: {
      pass: 'pytest-junitxml/pass.xml',
      fail: 'pytest-junitxml/fail.xml',
      zero: 'pytest-junitxml/zero.xml',
      passCounts: [2, 2, 0, 0],
      failCounts: [2, 1, 1, 0],
    },
  },
  {
    name: 'vitest console',
    parser: 'vitest-console',
    parse: parseVitestConsole,
    samples: {
      pass: 'vitest-console/pass.txt',
      fail: 'vitest-console/fail.txt',
      zero: 'vitest-console/zero.txt',
      passCounts: [3, 3, 0, 0],
      failCounts: [3, 2, 1, 0],
    },
  },
  {
    name: 'jest console',
    parser: 'jest-console',
    parse: parseJestConsole,
    samples: {
      pass: 'jest-console/pass.txt',
      fail: 'jest-console/fail.txt',
      zero: 'jest-console/zero.txt',
      passCounts: [2, 2, 0, 0],
      failCounts: [2, 1, 1, 0],
    },
  },
  {
    name: 'go test -json',
    parser: 'go-test-json',
    parse: parseGoTestJson,
    samples: {
      pass: 'go-test-json/pass.json',
      fail: 'go-test-json/fail.json',
      zero: 'go-test-json/zero.json',
      passCounts: [2, 2, 0, 0],
      failCounts: [2, 1, 1, 0],
    },
  },
  {
    name: 'cargo console',
    parser: 'cargo-console',
    parse: parseCargoConsole,
    samples: {
      pass: 'cargo-console/pass.txt',
      fail: 'cargo-console/fail.txt',
      zero: 'cargo-console/zero.txt',
      passCounts: [3, 2, 0, 1],
      failCounts: [2, 1, 1, 0],
    },
  },
]

describe('证据输出解析：每种工具链的通过 / 失败 / 零测试样本', () => {
  for (const toolchain of TOOLCHAINS) {
    it(`${toolchain.name} 通过样本`, () => {
      const summary = toolchain.parse(fixture(toolchain.samples.pass))
      const [run, passed, failed, skipped] = toolchain.samples.passCounts
      expect(summary.parsed).toBe(true)
      expect(summary.parser).toBe(toolchain.parser)
      expect(summary.run).toBe(run)
      expect(summary.passed).toBe(passed)
      expect(summary.failed).toBe(failed)
      expect(summary.skipped).toBe(skipped)
      expect(summary.failures ?? []).toHaveLength(0)
    })

    it(`${toolchain.name} 失败样本`, () => {
      const summary = toolchain.parse(fixture(toolchain.samples.fail))
      const [run, passed, failed, skipped] = toolchain.samples.failCounts
      expect(summary.parsed).toBe(true)
      expect(summary.run).toBe(run)
      expect(summary.passed).toBe(passed)
      expect(summary.failed).toBe(failed)
      expect(summary.skipped).toBe(skipped)
      expect(summary.failures?.length ?? 0).toBeGreaterThan(0)
    })

    it(`${toolchain.name} 零测试样本`, () => {
      const summary = toolchain.parse(fixture(toolchain.samples.zero))
      // Machine-readable parsers still parse the run; console parsers may need
      // the toolchain to print a 0-test summary line.
      expect(summary.parsed).toBe(true)
      expect(summary.run).toBe(0)
      expect(summary.passed).toBe(0)
      expect(summary.failed).toBe(0)
    })
  }
})

describe('失败用例的细节（名称 / 位置 / 首行错误）', () => {
  it('surefire XML 带出 class.method、文件:行与断言消息', () => {
    const summary = parseJUnitXml(fixture('surefire-junit/fail.xml'))
    const failure = summary.failures?.[0]
    expect(failure?.name).toBe('com.example.RenewalCallbackTest.duplicateCallbackIsIgnored')
    expect(failure?.file).toBe('RenewalServiceTest.java')
    expect(failure?.line).toBe(88)
    expect(failure?.message).toContain('2026-12-01')
  })

  it('gradle XML 带出失败位置', () => {
    const summary = parseJUnitXml(fixture('gradle-junit/fail.xml'))
    const failure = summary.failures?.[0]
    expect(failure?.name).toBe('com.example.billing.InvoiceTest.invoiceTotals')
    expect(failure?.file).toBe('InvoiceTest.java')
    expect(failure?.line).toBe(57)
  })

  it('maven 控制台解析 [ERROR] 失败行', () => {
    const summary = parseMavenConsole(fixture('maven-console/fail.txt'))
    const failure = summary.failures?.[0]
    expect(failure?.name).toBe('RenewalServiceTest.duplicateCallbackIsIgnored')
    expect(failure?.line).toBe(88)
    expect(failure?.message).toContain('expected')
  })

  it('pytest 控制台解析 FAILED 行与消息', () => {
    const summary = parsePytestConsole(fixture('pytest-console/fail.txt'))
    const failure = summary.failures?.[0]
    expect(failure?.name).toBe('tests/test_renewal.py::test_duplicate')
    expect(failure?.message).toBe('assert 2 == 1')
  })

  it('vitest 控制台解析失败用例与首行错误', () => {
    const summary = parseVitestConsole(fixture('vitest-console/fail.txt'))
    const failure = summary.failures?.[0]
    expect(failure?.name).toBe('duplicate callback is ignored')
    expect(failure?.message).toBe('expected 2026-12-01 to be 2026-12-31')
  })

  it('jest 控制台解析失败用例', () => {
    const summary = parseJestConsole(fixture('jest-console/fail.txt'))
    expect(summary.failures?.[0]?.name).toBe('duplicate callback is ignored')
  })

  it('go test -json 解析测试级状态与文件:行', () => {
    const summary = parseGoTestJson(fixture('go-test-json/fail.json'))
    const failure = summary.failures?.[0]
    expect(failure?.name).toBe('example.com/renewal.TestDuplicateCallbackIsIgnored')
    expect(failure?.file).toBe('renewal_test.go')
    expect(failure?.line).toBe(42)
    expect(failure?.message).toContain('got 2026-12-31')
  })

  it('cargo 控制台解析失败用例与 panic 位置', () => {
    const summary = parseCargoConsole(fixture('cargo-console/fail.txt'))
    const failure = summary.failures?.[0]
    expect(failure?.name).toBe('tests::duplicate_callback_is_ignored')
    expect(failure?.file).toBe('src/renewal.rs')
    expect(failure?.line).toBe(42)
  })
})

describe('go test -json 的包级通过 / 全部跳过不算有用例通过', () => {
  it('只有包级 pass、没有 testcase 的包 run = 0', () => {
    const summary = parseGoTestJson(fixture('go-test-json/package-only-pass.json'))
    expect(summary.parsed).toBe(true)
    expect(summary.run).toBe(0)
    expect(summary.passed).toBe(0)
  })

  it('全部 skip 的包 run > 0 但 passed = 0，证据判定为 none', () => {
    const summary = parseGoTestJson(fixture('go-test-json/all-skipped.json'))
    expect(summary.parsed).toBe(true)
    expect(summary.run).toBe(1)
    expect(summary.passed).toBe(0)
    expect(summary.skipped).toBe(1)
    expect(evidencePhase(summary, 0)).toBe('none')
  })

  it('[no test files] 与包级 ok 混合时仍为 run = 0', () => {
    const summary = parseGoTestJson(fixture('go-test-json/zero.json'))
    expect(summary.parsed).toBe(true)
    expect(summary.run).toBe(0)
    expect(evidencePhase(summary, 0)).toBe('none')
  })
})

describe('parseTestOutput：优先机器可读报告，其次控制台', () => {
  function input(overrides: Partial<ParseInput>): ParseInput {
    return { command: 'mvn -B test', stdout: '', stderr: '', exitCode: 0, ...overrides }
  }

  it('有 JUnit XML 报告时忽略控制台输出', () => {
    const summary = parseTestOutput(
      input({
        stdout: fixture('maven-console/pass.txt'),
        reportFiles: [{ path: 'target/surefire-reports/TEST-Renewal.xml', content: fixture('surefire-junit/fail.xml') }],
      }),
    )
    expect(summary.parser).toBe('junit-xml')
    expect(summary.run).toBe(3)
    expect(summary.failed).toBe(1)
  })

  it('有 Vitest JSON 报告时使用 JSON 解析器', () => {
    const summary = parseTestOutput(
      input({
        command: 'vitest run',
        stdout: fixture('vitest-console/fail.txt'),
        reportFiles: [{ path: 'test-results/vitest.json', content: fixture('vitest-json/fail.json') }],
      }),
    )
    expect(summary.parser).toBe('vitest-json')
    expect(summary.run).toBe(2)
    expect(summary.failed).toBe(1)
    expect(summary.failures?.[0]?.name).toBe('renewal > duplicate callback is ignored')
  })

  it('没有报告文件时按命令选择控制台解析器', () => {
    const cases: { command: string; sample: string; parser: string }[] = [
      { command: 'pytest -q', sample: 'pytest-console/fail.txt', parser: 'pytest-console' },
      { command: 'go test -json ./...', sample: 'go-test-json/fail.json', parser: 'go-test-json' },
      { command: 'cargo test', sample: 'cargo-console/fail.txt', parser: 'cargo-console' },
      { command: 'jest', sample: 'jest-console/pass.txt', parser: 'jest-console' },
      { command: './mvnw -B test', sample: 'maven-console/pass.txt', parser: 'maven-console' },
      { command: './gradlew test --rerun-tasks', sample: 'gradle-console/fail.txt', parser: 'gradle-console' },
    ]
    for (const entry of cases) {
      const summary = parseTestOutput(input({ command: entry.command, stdout: fixture(entry.sample) }))
      expect(summary.parser, entry.command).toBe(entry.parser)
      expect(summary.parsed, entry.command).toBe(true)
    }
  })

  it('通用 npm test 命令能按输出内容识别 vitest', () => {
    const summary = parseTestOutput(input({ command: 'npm test', stdout: fixture('vitest-console/pass.txt') }))
    expect(summary.parser).toBe('vitest-console')
    expect(summary.run).toBe(3)
  })

  it('解析不出测试数量时 parsed = false，退出码 0 也不能当 GREEN', () => {
    const summary = parseTestOutput(input({ command: 'pnpm build', stdout: fixture('unparseable/build-success.txt') }))
    expect(summary.parsed).toBe(false)
    expect(summary.run).toBe(0)
    expect(evidencePhase(summary, 0)).toBe('none')
  })
})

describe('detectEvidenceKind / evidencePhase', () => {
  it('按命令识别证据类型', () => {
    expect(detectEvidenceKind('mvn -B test')).toBe('test')
    expect(detectEvidenceKind('./gradlew test --rerun-tasks')).toBe('test')
    expect(detectEvidenceKind('pytest')).toBe('test')
    expect(detectEvidenceKind('pnpm vitest run')).toBe('test')
    expect(detectEvidenceKind('go test -json ./...')).toBe('test')
    expect(detectEvidenceKind('cargo test')).toBe('test')
    expect(detectEvidenceKind('tsc --noEmit')).toBe('typecheck')
    expect(detectEvidenceKind('eslint src')).toBe('lint')
    expect(detectEvidenceKind('mvn -B package')).toBe('build')
    expect(detectEvidenceKind('node server.js')).toBe('run')
    expect(detectEvidenceKind('')).toBe('run')
  })

  it('RED 需要看到失败用例数：解析失败 + 非零退出码不等于 RED', () => {
    expect(evidencePhase(null, 1)).toBe('none')
    const unparsed = parseVitestConsole('')
    expect(evidencePhase(unparsed, 1)).toBe('none')
  })

  it('失败样本（即使退出码为 0）判为 RED', () => {
    const summary = parseJUnitXml(fixture('surefire-junit/fail.xml'))
    expect(evidencePhase(summary, 0)).toBe('red')
    expect(evidencePhase(summary, 1)).toBe('red')
  })

  it('全部通过且运行数 > 0 才判为 GREEN', () => {
    const summary = parseMavenConsole(fixture('maven-console/pass.txt'))
    expect(evidencePhase(summary, 0)).toBe('green')
    const zero = parseMavenConsole(fixture('maven-console/zero.txt'))
    expect(evidencePhase(zero, 0)).toBe('none')
    expect(evidencePhase(null, 0)).toBe('none')
  })

  it('非测试证据（构建成功）不会误判为 GREEN', () => {
    const summary = parseTestOutput({ command: 'pnpm build', stdout: fixture('unparseable/build-success.txt'), stderr: '', exitCode: 0 })
    expect(evidencePhase(summary, 0)).toBe('none')
  })
})
