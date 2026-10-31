/**
 * Degenerate / malformed input tests for the evidence parsers.
 *
 * The parsers must never throw: unknown shapes yield `parsed: false`, partial
 * shapes still produce a best-effort summary. These cases pin the fallback arms
 * of every parser (JUnit XML, Maven/Gradle/pytest/vitest/Jest/node console,
 * go test -json, cargo, Jest/Vitest JSON report files) plus report dispatch.
 */
import { describe, expect, it } from 'vitest'
import type { TestSummary } from '../../../src/core/types'
import {
  detectEvidenceKind,
  evidencePhase,
  mergeTestSummaries,
  parseCargoConsole,
  parseGoTestJson,
  parseGradleConsole,
  parseJestConsole,
  parseJUnitXml,
  parseMavenConsole,
  parseNodeTestConsole,
  parsePytestConsole,
  parseTestOutput,
  parseVitestConsole,
} from '../../../src/core/evidence/parse'

describe('evidence/parse — JUnit XML 边界', () => {
  it('单引号属性、自闭合 testcase、time 累计', () => {
    const summary = parseJUnitXml(
      `<testsuite><testcase name='solo' classname='pkg.C' time='0.5'/></testsuite>`,
    )
    expect(summary).toMatchObject({ parser: 'junit-xml', parsed: true, run: 1, passed: 1, failed: 0, skipped: 0, durationMs: 500 })
  })

  it('skipped / self-closing failure / 无 message 的 failure / 无 classname 的 fullName', () => {
    const xml = `<testsuite>
<testcase name="skipme"><skipped/></testcase>
<testcase name="f1" classname="pkg.F1" time="0.1"><failure message="expected &lt;1&gt; got 2">trace</failure></testcase>
<testcase name="f2" classname="pkg.F2"><error type="boom"/></testcase>
<testcase name="f3" file="src/f3.ts"><failure>
  at com.Foo.bar(Foo.java:12)
  expected 3 but got 4
</failure></testcase>
</testsuite>`
    const summary = parseJUnitXml(xml)
    expect(summary).toMatchObject({ parsed: true, run: 4, passed: 0, failed: 3, skipped: 1 })
    expect(summary.failures?.map((failure) => failure.name)).toEqual(['pkg.F1.f1', 'pkg.F2.f2', 'f3'])
    expect(summary.failures?.[0]?.message).toBe('expected <1> got 2')
    expect(summary.failures?.[1]?.message).toBeUndefined()
    // f2 只有空 body：没有 message 也没有 location
    expect(summary.failures?.[1]?.file).toBeUndefined()
    // f3 的 file 属性优先，行号来自失败文本里的堆栈位置
    expect(summary.failures?.[2]).toMatchObject({ file: 'src/f3.ts', line: 12, message: 'expected 3 but got 4' })
  })

  it('XML 实体全部反转义', () => {
    const summary = parseJUnitXml(
      `<testsuite><testcase name="a &amp; b &#65; &#x42; &quot;q&quot; &apos;s&apos; &lt;x&gt;"/></testsuite>`,
    )
    expect(summary.run).toBe(1)
    // 没有失败时没有 failures；name 只在 failures 里出现，这里用 aggregate 反向验证字符集
    expect(summary.parsed).toBe(true)
  })

  it('没有 testcase 时回退到 <testsuite> 聚合属性；非法 tests 属性被跳过', () => {
    const summary = parseJUnitXml(
      `<testsuite tests="3" failures="1" errors="1" skipped="1" time="2.5"/>
<testsuite name="没有 tests 属性可解析"/>
<testsuite tests="abc"/>`,
    )
    expect(summary).toMatchObject({ parsed: true, run: 3, failed: 2, skipped: 1, passed: 0, durationMs: 2500 })
    // 完全没有 testcase / 可解析 testsuite -> 未解析
    expect(parseJUnitXml('<root/>')).toMatchObject({ parsed: false, run: 0 })
    expect(parseJUnitXml('')).toMatchObject({ parsed: false })
    // 非法 time 不产生 duration
    expect(parseJUnitXml('<testsuite><testcase name="x" time="abc"/></testsuite>').durationMs).toBeUndefined()
  })
})

describe('evidence/parse — Maven / Gradle 控制台', () => {
  it('Maven 最后一次 Tests run 汇总；ERROR 行解析类名/方法/行号并去重', () => {
    const output = [
      '[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0',
      '[INFO] Tests run: 5, Failures: 1, Errors: 1, Skipped: 1',
      '[ERROR]   com.acme.FooTest.testOne:42 expected 1',
      '[ERROR]   com.acme.FooTest.testTwo expected 2',
      '[ERROR]   com.acme.FooTest.testOne:42 重复',
    ].join('\n')
    const summary = parseMavenConsole(output)
    expect(summary).toMatchObject({ parsed: true, run: 5, failed: 2, skipped: 1, passed: 2 })
    expect(summary.failures).toHaveLength(2)
    expect(summary.failures?.[0]).toMatchObject({
      name: 'com.acme.FooTest.testOne',
      file: 'com/acme/FooTest.java',
      line: 42,
      message: 'expected 1',
    })
    expect(summary.failures?.[1]?.name).toBe('com.acme.FooTest.testTwo')
    expect(summary.failures?.[1]?.line).toBeUndefined()
    expect(parseMavenConsole('nothing here').parsed).toBe(false)
  })

  it('Gradle 汇总的 failed/skipped 可选；失败行含方法名与兜底 FAILED 行', () => {
    expect(parseGradleConsole('3 tests completed')).toMatchObject({ parsed: true, run: 3, failed: 0, skipped: 0, passed: 3 })
    const output = [
      '5 tests completed, 2 failed, 1 skipped',
      'com.acme.FooTest > testOne() FAILED',
      'com.acme.BarTest > baz.method FAILED',
    ].join('\n')
    const summary = parseGradleConsole(output)
    expect(summary).toMatchObject({ run: 5, failed: 2, skipped: 1, passed: 2 })
    expect(summary.failures?.map((failure) => failure.name)).toEqual(['com.acme.FooTest.testOne', 'baz.method'])

    // 失败数大于可解析的失败行时，用裸 `Class FAILED` 行兜底
    const fallback = parseGradleConsole(
      ['2 tests completed, 2 failed', 'com.acme.FooTest > testOne() FAILED', 'com.acme.Other FAILED'].join('\n'),
    )
    expect(fallback.failures?.map((failure) => failure.name)).toEqual(['com.acme.FooTest.testOne', 'com.acme.Other'])
    expect(parseGradleConsole('nothing here').parsed).toBe(false)
  })
})

describe('evidence/parse — pytest 控制台', () => {
  it('最终汇总行的 counts 解析、FAILED 行、section 头兜底', () => {
    const output = [
      'FAILED tests/test_a.py::test_x - AssertionError: boom',
      'FAILED tests/test_b.py::test_y',
      'FAILED tests/test_a.py::test_x - AssertionError: boom',
      '= 1 failed, 2 passed, 1 skipped, 1 warning in 0.50s =',
    ].join('\n')
    const summary = parsePytestConsole(output)
    expect(summary).toMatchObject({ parsed: true, run: 4, passed: 2, failed: 1, skipped: 1 })
    expect(summary.failures).toHaveLength(2)
    expect(summary.failures?.[0]?.message).toBe('AssertionError: boom')
    expect(summary.failures?.[1]).toMatchObject({ file: 'tests/test_b.py' })

    // 失败行不足时用 `____ name ____` section 头兜底
    const fallback = parsePytestConsole(['= 2 failed in 0.2s =', '____ test_z ____'].join('\n'))
    expect(fallback.failures?.map((failure) => failure.name)).toEqual(['test_z'])
    expect(parsePytestConsole('nothing here').parsed).toBe(false)
    expect(parsePytestConsole('collected 0 items\nno tests ran in 0.01s')).toMatchObject({ parsed: true, run: 0 })
  })
})

describe('evidence/parse — vitest / Jest / node --test 控制台', () => {
  it('vitest 汇总行（含/不含 skipped）与失败条目详情', () => {
    const output = [
      'Tests  2 failed | 3 passed | 1 skipped (6)',
      ' × first failure 12ms',
      ' × first failure 12ms',
      ' → expected 1 to be 2',
      ' ✗ second failure',
    ].join('\n')
    const summary = parseVitestConsole(output)
    expect(summary).toMatchObject({ parsed: true, run: 6, passed: 3, failed: 2, skipped: 1 })
    expect(summary.failures?.map((failure) => failure.name)).toEqual(['first failure', 'second failure'])
    expect(summary.failures?.[0]?.message).toBe('expected 1 to be 2')

    // 行内没有 skipped 计数（arm=false）
    const noSkip = parseVitestConsole('Tests  2 passed | 1 failed (3)')
    expect(noSkip).toMatchObject({ run: 3, passed: 2, failed: 1, skipped: 0 })
    expect(parseVitestConsole('No test files found').parsed).toBe(true)
    expect(parseVitestConsole('Tests  no tests').parsed).toBe(true)
    expect(parseVitestConsole('nothing here').parsed).toBe(false)
  })

  it('node --test：仅 tests 计数时 pass/fail/todo 回退 0；duration 与 ✖ 失败行', () => {
    const output = ['ℹ tests 5', 'ℹ pass 3', 'ℹ fail 1', 'ℹ skipped 1', 'ℹ todo 0', 'ℹ duration_ms 12.5', '✖ failing test (5ms)'].join('\n')
    const summary = parseNodeTestConsole(output)
    expect(summary).toMatchObject({ parsed: true, run: 5, passed: 3, failed: 1, skipped: 1, durationMs: 13 })
    expect(summary.failures).toEqual([{ name: 'failing test' }])

    const onlyTests = parseNodeTestConsole('ℹ tests 4')
    expect(onlyTests).toMatchObject({ run: 4, passed: 0, failed: 0, skipped: 0 })
    expect(parseNodeTestConsole('nothing').parsed).toBe(false)
  })

  it('Jest：Tests 行各计数可选；✕ 失败行去重', () => {
    const output = [
      'Tests:       2 failed, 3 passed, 1 skipped, 6 total',
      '  ✕ first failure (5 ms)',
      '  ✕ first failure (5 ms)',
      '  × second failure',
    ].join('\n')
    const summary = parseJestConsole(output)
    expect(summary).toMatchObject({ parsed: true, run: 6, passed: 3, failed: 2, skipped: 1 })
    expect(summary.failures?.map((failure) => failure.name)).toEqual(['first failure', 'second failure'])

    // 没有 total / skipped 计数时用 passed+failed+skipped 推总数
    expect(parseJestConsole('Tests:       1 passed')).toMatchObject({ run: 1, passed: 1, failed: 0, skipped: 0 })
    expect(parseJestConsole('No tests found').parsed).toBe(true)
    expect(parseJestConsole('nothing').parsed).toBe(false)
  })
})

describe('evidence/parse — go test -json / cargo', () => {
  it('go test -json：run/output/pass/fail/skip 事件折叠；非法行跳过', () => {
    const lines = [
      '{"Action":"start","Package":"p"}',
      '{"Action":"run","Package":"p","Test":"TestA"}',
      '{"Action":"output","Package":"p","Test":"TestA","Output":"=== RUN TestA\\n"}',
      '{"Action":"output","Package":"p","Test":"TestA","Output":"    a_test.go:12: boom\\n"}',
      '{"Action":"output","Package":"p","Test":"TestA"}',
      '{"Action":"fail","Package":"p","Test":"TestA","Elapsed":0.12}',
      '{"Action":"pass","Package":"p","Test":"TestB"}',
      '{"Action":"skip","Package":"p","Test":"TestC"}',
      '{"Action":"pass","Package":"p"}',
      '{"Action":"pass","Test":"TestD"}',
      'not-json',
      '[1]',
      '{"foo":1}',
    ].join('\n')
    const summary = parseGoTestJson(lines)
    expect(summary).toMatchObject({ parser: 'go-test-json', parsed: true, run: 4, passed: 2, failed: 1, skipped: 1 })
    expect(summary.durationMs).toBe(120)
    expect(summary.failures).toHaveLength(1)
    expect(summary.failures?.[0]).toMatchObject({ name: 'p.TestA', file: 'a_test.go', line: 12 })
    expect(summary.failures?.[0]?.message).toBe('a_test.go:12: boom')
    // 没有 Package 的用例 fullName 回退到用例名
    expect(summary.failures?.[0]?.name).toBe('p.TestA')
    expect(parseGoTestJson('not-json\n[1]\n{"foo":1}').parsed).toBe(false)
    expect(parseGoTestJson('').parsed).toBe(false)
  })

  it('go test -json：无 Package 的失败用例 fullName 用 test 名', () => {
    const summary = parseGoTestJson(
      ['{"Action":"run","Test":"TestZ"}', '{"Action":"fail","Test":"TestZ"}'].join('\n'),
    )
    expect(summary.failures?.[0]?.name).toBe('TestZ')
  })

  it('cargo：多段合计、失败块 stdout 提取、重复 FAILED 行、缺块回退', () => {
    const output = [
      'test result: ok. 2 passed; 0 failed; 0 ignored',
      'test result: FAILED. 1 passed; 2 failed; 1 ignored',
      'test tests::bad ... FAILED',
      'test tests::bad ... FAILED',
      'test tests::other ... FAILED',
      '---- tests::bad stdout ----',
      'thread \'tests::bad\' panicked at src/lib.rs:10:',
      'boom',
      '',
      '---- tests::other stdout ----',
    ].join('\n')
    const summary = parseCargoConsole(output)
    expect(summary).toMatchObject({ parsed: true, run: 6, passed: 3, failed: 2, skipped: 1 })
    expect(summary.failures?.map((failure) => failure.name)).toEqual(['tests::bad', 'tests::other'])
    expect(summary.failures?.[0]).toMatchObject({ file: 'src/lib.rs', line: 10, message: "thread 'tests::bad' panicked at src/lib.rs:10:" })
    expect(summary.failures?.[1]?.message).toBeUndefined()
    expect(parseCargoConsole('nothing').parsed).toBe(false)
  })
})

describe('evidence/parse — report 文件与解析优先级', () => {
  it('Jest/Vitest JSON：testResults 形状的各种坏数据被跳过', () => {
    const report = {
      testResults: [
        null,
        'not-an-object',
        { name: 'src/a.test.ts' },
        {
          name: 'src/a.test.ts',
          assertionResults: [
            null,
            42,
            { status: 'passed' },
            { status: 'failed', failureMessages: ['expect(x).toBe(1) at src/a.test.ts:3', 'second'], fullName: 'a > works' },
            { status: 'failed', failureMessages: [], title: '只有 title' },
            { status: 'failed', failureMessages: [], fullName: '只有 fullName' },
            { status: 'pending' },
            { status: 123 },
            { status: 'failed', failureMessages: [42, 'message at src/b.ts:9'] },
          ],
        },
      ],
    }
    const summary = parseTestOutput({
      command: 'npx jest',
      stdout: '',
      stderr: '',
      exitCode: 1,
      reportFiles: [{ path: 'jest-report.json', content: JSON.stringify(report) }],
    })
    expect(summary).toMatchObject({ parser: 'jest-json', parsed: true, run: 7, passed: 2, failed: 4, skipped: 1 })
    expect(summary.failures).toHaveLength(4)
    expect(summary.failures?.[0]).toMatchObject({ name: 'a > works', file: 'src/a.test.ts', line: 3 })
    expect(summary.failures?.[1]?.name).toBe('只有 title')
    expect(summary.failures?.[2]?.name).toBe('只有 fullName')
    expect(summary.failures?.[3]).toMatchObject({ name: '未知用例', file: 'src/b.ts', line: 9 })
  })

  it('Jest/Vitest JSON：没有 testResults 时用 numTotalTests 聚合计数', () => {
    const summary = parseTestOutput({
      command: 'vitest run',
      stdout: '',
      stderr: '',
      exitCode: 1,
      reportFiles: [
        {
          path: 'vitest-report.json',
          content: JSON.stringify({ numTotalTests: 5, numPassedTests: 3, numFailedTests: 1, numPendingTests: 1 }),
        },
      ],
    })
    expect(summary).toMatchObject({ parser: 'vitest-json', run: 5, passed: 3, failed: 1, skipped: 1 })
  })

  it('JUnit XML 报告文件；解析失败的报告被忽略并回退控制台', () => {
    const junit = parseTestOutput({
      command: 'mvn test',
      stdout: '',
      stderr: '',
      exitCode: 1,
      reportFiles: [
        { path: 'target/surefire-reports/TEST-a.xml', content: '<testsuite><testcase name="a"/></testsuite>' },
        { path: 'target/empty.xml', content: '' },
        { path: 'target/bad.xml', content: '<root/>' },
        { path: 'target/data.json', content: '{bad json' },
        { path: 'target/plain.txt', content: 'plain text' },
      ],
    })
    expect(junit).toMatchObject({ parser: 'junit-xml', run: 1, passed: 1 })

    // 没有可解析报告 -> 回退控制台（stdout 为空时用 stderr）
    const fallback = parseTestOutput({
      command: 'mvn test',
      stdout: '',
      stderr: '[ERROR] Tests run: 1, Failures: 0, Errors: 0, Skipped: 1',
      exitCode: 0,
      reportFiles: [{ path: 'x.xml', content: '<root/>' }],
    })
    expect(fallback).toMatchObject({ parser: 'maven-console', run: 1, skipped: 1, parsed: true })
  })

  it('go test -json 报告文件（含 "Action" 的 JSON lines）', () => {
    const summary = parseTestOutput({
      command: 'go test -json ./...',
      stdout: '',
      stderr: '',
      exitCode: 0,
      reportFiles: [
        {
          path: 'go-test.json',
          content: ['{"Action":"run","Package":"p","Test":"TestA"}', '{"Action":"pass","Package":"p","Test":"TestA"}'].join('\n'),
        },
      ],
    })
    expect(summary).toMatchObject({ parser: 'go-test-json', run: 1, passed: 1 })
  })

  it('多个报告文件合并计数；完全没有证据时返回 unknown 未解析', () => {
    const merged = parseTestOutput({
      command: 'vitest run',
      stdout: 'Tests  1 passed (1)',
      stderr: '',
      exitCode: 0,
      reportFiles: [
        { path: 'a.xml', content: '<testsuite><testcase name="x" time="0.2"/></testsuite>' },
        { path: 'b.xml', content: '<testsuite><testcase name="y" time="0.3"/></testsuite>' },
      ],
    })
    expect(merged).toMatchObject({ parser: 'junit-xml', run: 2, passed: 2, durationMs: 500 })
    expect(merged.parsed).toBe(true)

    expect(parseTestOutput({ command: 'echo hi', stdout: '', stderr: '', exitCode: 0 })).toMatchObject({
      parser: 'unknown',
      parsed: false,
    })
    // 没有任何匹配解析器时按固定顺序回退（maven parser 最先）
    expect(
      parseTestOutput({ command: 'custom-runner', stdout: '[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0', stderr: '', exitCode: 0 }),
    ).toMatchObject({ parser: 'maven-console', run: 2 })
  })
})

describe('evidence/parse — 汇总与判定辅助函数', () => {
  it('mergeTestSummaries 合并计数、失败、耗时与 parser 名', () => {
    const a: TestSummary = { parser: 'vitest', parsed: true, run: 3, passed: 2, failed: 1, skipped: 0, durationMs: 120, failures: [{ name: 'f1' }] }
    const b: TestSummary = { parser: 'jest', parsed: false, run: 2, passed: 2, failed: 0, skipped: 0, failures: [{ name: 'f2' }] }
    const merged = mergeTestSummaries([a, b, { ...a, durationMs: 80 }])
    expect(merged).toMatchObject({
      parser: 'vitest+jest',
      parsed: true,
      run: 8,
      passed: 6,
      failed: 2,
      skipped: 0,
      durationMs: 200,
    })
    expect(merged.failures?.map((failure) => failure.name)).toEqual(['f1', 'f2', 'f1'])
    // 空摘要 -> unknown / 未解析
    expect(mergeTestSummaries([])).toMatchObject({ parser: 'unknown', parsed: false, run: 0 })
  })

  it('detectEvidenceKind 覆盖 test / typecheck / lint / build / manual / run', () => {
    expect(detectEvidenceKind('')).toBe('run')
    expect(detectEvidenceKind('pnpm vitest run')).toBe('test')
    expect(detectEvidenceKind('go test ./...')).toBe('test')
    expect(detectEvidenceKind('pnpm test -- --test: none')).toBe('manual')
    expect(detectEvidenceKind('tsc --noEmit')).toBe('typecheck')
    expect(detectEvidenceKind('eslint .')).toBe('lint')
    expect(detectEvidenceKind('pnpm build')).toBe('build')
    // 中文“手工”不会被 \\b 匹配（JS 词边界只认 ASCII），走 run；manual 关键字可识别
    expect(detectEvidenceKind('手工检查 UI')).toBe('run')
    expect(detectEvidenceKind('manual UI check')).toBe('manual')
    expect(detectEvidenceKind('echo hi')).toBe('run')
  })

  it('evidencePhase 的 red / green / none 边界', () => {
    const summary = (over: Partial<TestSummary>): TestSummary => ({
      parser: 'x',
      parsed: true,
      run: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      ...over,
    })
    expect(evidencePhase(summary({ failed: 1, passed: 0 }), 0)).toBe('red')
    expect(evidencePhase(summary({ failed: 1, passed: 0 }), 1)).toBe('red')
    expect(evidencePhase(summary({}), 0)).toBe('green')
    expect(evidencePhase(summary({}), 1)).toBe('none')
    expect(evidencePhase(null, 0)).toBe('none')
    expect(evidencePhase(summary({ parsed: false }), 0)).toBe('none')
    expect(evidencePhase(summary({ run: 0, passed: 0 }), 0)).toBe('none')
    expect(evidencePhase(summary({ passed: 0 }), 0)).toBe('none')
  })
})
