/**
 * Python standard library `unittest` console parser tests.
 *
 * Fixtures are verbatim `python3 -m unittest` stderr output from Python 3.13
 * (the runtime the greenfield drill used); absolute paths are rewritten to
 * `/tmp/repo` so the assertions stay stable. Docs 02 FR-5.2 / 03 §6.3 require
 * RED/GREEN to come from parseable test output: before this parser existed a
 * unittest RED receipt produced `parsed=false / run=0`, so no RED could be
 * recorded (T-FAILURE-LIMIT circuit breaker in the greenfield drill).
 */
import { describe, expect, it } from 'vitest'
import {
  detectEvidenceKind,
  evidencePhase,
  parseTestOutput,
  parseUnittestConsole,
  type ParseInput,
} from '../../../src/core/evidence/parse'

const GREEN = `...
----------------------------------------------------------------------
Ran 3 tests in 0.005s

OK
`

const GREEN_VERBOSE = `test_ok_one (tests.test_health.ConfigTests.test_ok_one) ... ok
test_ok_two (tests.test_health.ConfigTests.test_ok_two) ... ok
test_ok_three (tests.test_health.ConfigTests.test_ok_three) ... ok

----------------------------------------------------------------------
Ran 3 tests in 0.005s

OK
`

const FAILED_ASSERTION = `F..
======================================================================
FAIL: test_bad_assertion (tests.test_health.ConfigTests.test_bad_assertion)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/tmp/repo/tests/test_health.py", line 12, in test_bad_assertion
    self.assertEqual(1, 2)
    ~~~~~~~~~~~~~~~~^^^^^^
AssertionError: 1 != 2

----------------------------------------------------------------------
Ran 3 tests in 0.002s

FAILED (failures=1)
`

/** Exact shape of evidence E-0001 in the greenfield drill (unittest import error). */
const FAILED_IMPORT = `tests (unittest.loader._FailedTest.tests) ... ERROR

======================================================================
ERROR: tests (unittest.loader._FailedTest.tests)
----------------------------------------------------------------------
ImportError: Failed to import test module: tests
Traceback (most recent call last):
  File "/Library/Frameworks/Python.framework/Versions/3.13/lib/python3.13/unittest/loader.py", line 137, in loadTestsFromName
    module = __import__(module_name)
  File "/tmp/repo/tests/__init__.py", line 13, in <module>
    from app.config import load_config
ModuleNotFoundError: No module named 'app'


----------------------------------------------------------------------
Ran 1 test in 0.000s

FAILED (errors=1)
`

const ERRORS_TWO = `EE
======================================================================
ERROR: test_a (tests.test_err.BoomTests.test_a)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/tmp/repo/tests/test_err.py", line 6, in setUp
    raise RuntimeError("db unavailable")
RuntimeError: db unavailable

======================================================================
ERROR: setUpClass (tests.test_err.SecondBoomTests)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/tmp/repo/tests/test_err.py", line 15, in setUpClass
    raise ValueError("missing fixture")
ValueError: missing fixture

----------------------------------------------------------------------
Ran 1 test in 0.000s

FAILED (errors=2)
`

const SKIPPED = `.ss.
----------------------------------------------------------------------
Ran 4 tests in 0.001s

OK (skipped=2)
`

const SKIPPED_VERBOSE = `test_known_bug (tests.test_more.XfailTests.test_known_bug) ... expected failure
test_ok (tests.test_more.XfailTests.test_ok) ... ok
test_skip (tests.test_more.XfailTests.test_skip) ... skipped 'later'
test_unexpected_pass (tests.test_more.XfailTests.test_unexpected_pass) ... unexpected success

======================================================================
UNEXPECTED SUCCESS: test_unexpected_pass (tests.test_more.XfailTests.test_unexpected_pass)
----------------------------------------------------------------------
Ran 4 tests in 0.003s

FAILED (skipped=1, expected failures=1, unexpected successes=1)
`

const MIXED_VERBOSE = `test_error (tests.test_mixed.MixedTests.test_error) ... ERROR
test_fail (tests.test_mixed.MixedTests.test_fail) ... FAIL
test_pass (tests.test_mixed.MixedTests.test_pass) ... ok
test_skip (tests.test_mixed.MixedTests.test_skip) ... skipped 'nope'

======================================================================
ERROR: test_error (tests.test_mixed.MixedTests.test_error)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/tmp/repo/tests/test_mixed.py", line 12, in test_error
    raise RuntimeError("boom")
RuntimeError: boom

======================================================================
FAIL: test_fail (tests.test_mixed.MixedTests.test_fail)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/tmp/repo/tests/test_mixed.py", line 9, in test_fail
    self.assertEqual(1, 2)
    ~~~~~~~~~~~~~~~~^^^^^^
AssertionError: 1 != 2

----------------------------------------------------------------------
Ran 4 tests in 0.003s

FAILED (failures=1, errors=1, skipped=1)
`

const SUBTEST_FAILURES = `FF
======================================================================
FAIL: test_each (tests.test_sub.SubTests.test_each) (i=1)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/tmp/repo/tests/test_sub.py", line 8, in test_each
    self.assertNotEqual(i, 1)
    ~~~~~~~~~~~~~~~~~~~^^^^^^
AssertionError: 1 == 1

======================================================================
FAIL: test_each (tests.test_sub.SubTests.test_each) (i=2)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/tmp/repo/tests/test_sub.py", line 9, in test_each
    self.assertNotEqual(i, 2)
    ~~~~~~~~~~~~~~~~~~~^^^
AssertionError: 2 == 2

----------------------------------------------------------------------
Ran 1 test in 0.000s

FAILED (failures=2)
`

/** Killed / truncated run: `Ran` line present, result line lost. */
const TRUNCATED_AFTER_RAN = `F..
======================================================================
FAIL: test_bad_assertion (tests.test_health.ConfigTests.test_bad_assertion)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/tmp/repo/tests/test_health.py", line 12, in test_bad_assertion
    self.assertEqual(1, 2)
AssertionError: 1 != 2

----------------------------------------------------------------------
Ran 3 tests in 0.043s
`

const PYTEST_OUTPUT = `============================= test session starts ==============================
collected 2 items

tests/test_x.py .F                                                       [100%]

=================================== FAILURES ===================================
__________________________________ test_y ____________________________________

    def test_y():
>       assert 1 == 2
E       assert 1 == 2

tests/test_x.py:5: AssertionError
=========================== short test summary info ============================
FAILED tests/test_x.py::test_y - assert 1 == 2
========================= 1 failed, 1 passed in 0.03s ==========================
`

function input(overrides: Partial<ParseInput>): ParseInput {
  return { command: 'python3 -m unittest', stdout: '', stderr: '', exitCode: 0, ...overrides }
}

describe('parseUnittestConsole：全绿输出（GREEN）', () => {
  it('Ran + OK 解析为 run/passed，证据判为 GREEN', () => {
    const summary = parseUnittestConsole(GREEN)
    expect(summary).toMatchObject({ parser: 'unittest', parsed: true, run: 3, passed: 3, failed: 0, skipped: 0 })
    expect(summary.failures).toBeUndefined()
    expect(summary.durationMs).toBe(5)
    expect(evidencePhase(summary, 0)).toBe('green')
  })

  it('-v 全绿输出按 Ran 行计数，不会把每个 -v 行重复累计', () => {
    const summary = parseUnittestConsole(GREEN_VERBOSE)
    expect(summary).toMatchObject({ parser: 'unittest', parsed: true, run: 3, passed: 3, failed: 0, skipped: 0 })
    expect(evidencePhase(summary, 0)).toBe('green')
  })

  it('durationMs 由 Ran 行毫秒化；0.000s 不产出 durationMs', () => {
    expect(parseUnittestConsole(FAILED_ASSERTION).durationMs).toBe(2)
    expect(parseUnittestConsole(FAILED_IMPORT).durationMs).toBeUndefined()
  })

  it('输出形态稳定时（stdout/stderr 合并后）解析结果一致', () => {
    const merged = parseTestOutput(input({ command: 'python3 -m unittest tests.test_health -v', stderr: GREEN_VERBOSE }))
    expect(merged).toMatchObject({ parser: 'unittest', parsed: true, run: 3, passed: 3, failed: 0 })
    expect(evidencePhase(merged, 0)).toBe('green')
  })
})

describe('parseUnittestConsole：失败输出（RED）', () => {
  it('断言失败：RED 判定，并带出失败名称 / 文件 / 行 / 消息', () => {
    const summary = parseUnittestConsole(FAILED_ASSERTION)
    expect(summary).toMatchObject({ parser: 'unittest', parsed: true, run: 3, passed: 2, failed: 1, skipped: 0 })
    const failure = summary.failures?.[0]
    expect(failure?.name).toBe('tests.test_health.ConfigTests.test_bad_assertion')
    expect(failure?.file).toBe('/tmp/repo/tests/test_health.py')
    expect(failure?.line).toBe(12)
    expect(failure?.message).toBe('AssertionError: 1 != 2')
    // RED 必须来自解析出的失败数：即使退出码被掩盖也仍是 RED。
    expect(evidencePhase(summary, 1)).toBe('red')
    expect(evidencePhase(summary, 0)).toBe('red')
  })

  it('导入失败（_FailedTest）：错误数计入 failed，位置取用户文件而不是标准库 loader', () => {
    const summary = parseUnittestConsole(FAILED_IMPORT)
    expect(summary).toMatchObject({ parser: 'unittest', parsed: true, run: 1, passed: 0, failed: 1, skipped: 0 })
    const failure = summary.failures?.[0]
    expect(failure?.name).toBe('unittest.loader._FailedTest.tests')
    expect(failure?.file).toBe('/tmp/repo/tests/__init__.py')
    expect(failure?.line).toBe(13)
    expect(failure?.message).toBe('ImportError: Failed to import test module: tests')
    expect(evidencePhase(summary, 1)).toBe('red')
  })

  it('多个 error（setUp / setUpClass）：failed = errors 之和，passed 不为负', () => {
    const summary = parseUnittestConsole(ERRORS_TWO)
    expect(summary).toMatchObject({ parsed: true, run: 1, passed: 0, failed: 2, skipped: 0 })
    expect(summary.failures?.map((failure) => failure.name)).toEqual([
      'tests.test_err.BoomTests.test_a',
      'tests.test_err.SecondBoomTests',
    ])
    expect(summary.failures?.[0]?.message).toBe('RuntimeError: db unavailable')
    expect(summary.failures?.[1]?.file).toBe('/tmp/repo/tests/test_err.py')
    expect(summary.failures?.[1]?.line).toBe(15)
    expect(evidencePhase(summary, 1)).toBe('red')
  })

  it('失败 / 错误 / 跳过混合：计数取 Ran + 结果行，失败清单逐个带消息', () => {
    const summary = parseUnittestConsole(MIXED_VERBOSE)
    expect(summary).toMatchObject({ parsed: true, run: 4, passed: 1, failed: 2, skipped: 1 })
    const failures = summary.failures ?? []
    expect(failures.map((failure) => failure.name)).toEqual([
      'tests.test_mixed.MixedTests.test_error',
      'tests.test_mixed.MixedTests.test_fail',
    ])
    expect(failures[0]?.message).toBe('RuntimeError: boom')
    expect(failures[1]?.message).toBe('AssertionError: 1 != 2')
    expect(failures[1]?.line).toBe(9)
    expect(evidencePhase(summary, 1)).toBe('red')
  })

  it('subTest 失败：同名用例按参数后缀区分，每个失败子测试都计入 failures', () => {
    const summary = parseUnittestConsole(SUBTEST_FAILURES)
    expect(summary).toMatchObject({ parsed: true, run: 1, passed: 0, failed: 2, skipped: 0 })
    expect(summary.failures?.map((failure) => failure.name)).toEqual([
      'tests.test_sub.SubTests.test_each (i=1)',
      'tests.test_sub.SubTests.test_each (i=2)',
    ])
    expect(summary.failures?.map((failure) => failure.line)).toEqual([8, 9])
  })
})

describe('parseUnittestConsole：skipped / expected failure', () => {
  it('OK (skipped=N)：run = passed + skipped', () => {
    const summary = parseUnittestConsole(SKIPPED)
    expect(summary).toMatchObject({ parsed: true, run: 4, passed: 2, failed: 0, skipped: 2 })
    expect(evidencePhase(summary, 0)).toBe('green')
  })

  it('-v 的 skipped 原因 / expected failure / unexpected success 状态都可识别且不破坏计数', () => {
    const summary = parseUnittestConsole(SKIPPED_VERBOSE)
    expect(summary).toMatchObject({ parsed: true, run: 4, passed: 3, failed: 0, skipped: 1 })
  })

  it('跳过的原因不会进入解析结果（只在原始输出里）', () => {
    const output = `test_skip (tests.test_secret.SecretTests.test_skip) ... skipped 'token=sk-live-123 phone 13800138000'

----------------------------------------------------------------------
Ran 1 test in 0.001s

OK (skipped=1)
`
    const summary = parseUnittestConsole(output)
    expect(summary).toMatchObject({ parsed: true, run: 1, passed: 0, skipped: 1 })
    expect(JSON.stringify(summary)).not.toContain('sk-live-123')
    expect(JSON.stringify(summary)).not.toContain('13800138000')
  })
})

describe('parseUnittestConsole：结果不确定时 parsed=false，不制造 RED', () => {
  it('只有 Ran 行（进程被杀 / 输出截断）不算结果', () => {
    const summary = parseUnittestConsole(TRUNCATED_AFTER_RAN)
    expect(summary).toMatchObject({ parser: 'unittest', parsed: false, run: 0 })
    expect(evidencePhase(summary, 1)).toBe('none')
  })

  it('只有结果行、没有 Ran 行与 -v 统计时无法确定 run', () => {
    for (const output of ['FAILED (failures=1)\n', 'OK\n']) {
      const summary = parseUnittestConsole(output)
      expect(summary.parsed, output).toBe(false)
      expect(evidencePhase(summary, 1)).toBe('none')
    }
  })

  it('只有 -v 行、没有 Ran 行与结果行时仍不解析', () => {
    const output = `test_ok_one (tests.test_health.ConfigTests.test_ok_one) ... ok
test_ok_two (tests.test_health.ConfigTests.test_ok_two) ... ok
`
    expect(parseUnittestConsole(output).parsed).toBe(false)
  })

  it('Ran 行 + -v 行但结果行丢失时 parsed=false', () => {
    const output = `test_ok_one (tests.test_health.ConfigTests.test_ok_one) ... ok

----------------------------------------------------------------------
Ran 1 test in 0.001s
`
    expect(parseUnittestConsole(output).parsed).toBe(false)
  })

  it('结果行 + -v 行但 Ran 行丢失（截断）时用 -v 行补齐 run', () => {
    const output = `test_ok_one (tests.test_health.ConfigTests.test_ok_one) ... ok
test_ok_two (tests.test_health.ConfigTests.test_ok_two) ... ok
test_skip (tests.test_health.ConfigTests.test_skip) ... skipped 'later'

OK (skipped=1)
`
    const summary = parseUnittestConsole(output)
    expect(summary).toMatchObject({ parsed: true, run: 3, passed: 2, failed: 0, skipped: 1 })
  })

  it('空输出与无关输出 parsed=false（沿用 unknown 语义）', () => {
    expect(parseUnittestConsole('').parsed).toBe(false)
    expect(parseUnittestConsole('all good\n').parsed).toBe(false)
    expect(parseUnittestConsole('Ran 3 tests in 0.002s').parsed).toBe(false)
  })

  it('run = 0 的两种真实形态都 parsed 但按 FR-5.2 不算证据', () => {
    // Python 3.13 discover 无测试：`NO TESTS RAN` + 退出码 5。
    const noTests = parseUnittestConsole(`
----------------------------------------------------------------------
Ran 0 tests in 0.000s

NO TESTS RAN
`)
    expect(noTests).toMatchObject({ parser: 'unittest', parsed: true, run: 0, passed: 0, failed: 0, skipped: 0 })
    expect(evidencePhase(noTests, 5)).toBe('none')
    expect(evidencePhase(noTests, 0)).toBe('none')

    // 旧版 Python / 显式空 suite：`Ran 0 tests` + `OK`。
    const ranZero = parseUnittestConsole(`
----------------------------------------------------------------------
Ran 0 tests in 0.000s

OK
`)
    expect(ranZero).toMatchObject({ parsed: true, run: 0, passed: 0, failed: 0 })
    expect(evidencePhase(ranZero, 0)).toBe('none')
  })
})

describe('parseTestOutput：unittest 命令路由与 stdout/stderr 合并', () => {
  it('常见 unittest 命令形状都路由到 unittest 解析器', () => {
    const commands = [
      'python3 -m unittest tests.test_health -v',
      'python -m unittest discover -s tests -p test_*.py',
      'python3.13 -m unittest',
      '/usr/bin/python3.12 -m unittest tests.test_x',
      'unittest discover -s tests',
    ]
    for (const command of commands) {
      const summary = parseTestOutput(input({ command, stderr: GREEN_VERBOSE }))
      expect(summary.parser, command).toBe('unittest')
      expect(summary.parsed, command).toBe(true)
      expect(summary.run, command).toBe(3)
    }
  })

  it('unittest 默认把结果写 stderr：stdout 为空也能形成 RED / GREEN 回执', () => {
    const red = parseTestOutput(input({ command: 'python3 -m unittest tests.test_health -v', stdout: '', stderr: FAILED_ASSERTION, exitCode: 1 }))
    expect(red).toMatchObject({ parser: 'unittest', parsed: true, run: 3, failed: 1 })
    expect(evidencePhase(red, 1)).toBe('red')

    const green = parseTestOutput(input({ command: 'python3 -m unittest tests.test_health -v', stdout: '', stderr: GREEN_VERBOSE, exitCode: 0 }))
    expect(green).toMatchObject({ parser: 'unittest', parsed: true, run: 3, failed: 0 })
    expect(evidencePhase(green, 0)).toBe('green')
  })

  it('python -m pytest 仍走 pytest 解析器，pytest 输出不会被误判成 unittest', () => {
    expect(parseUnittestConsole(PYTEST_OUTPUT).parsed).toBe(false)
    const summary = parseTestOutput(input({ command: 'python3 -m pytest -q', stdout: PYTEST_OUTPUT, exitCode: 1 }))
    expect(summary.parser).toBe('pytest-console')
    expect(summary.parsed).toBe(true)
    expect(summary.run).toBe(2)
    expect(summary.failed).toBe(1)
  })

  it('命令未命中任何解析器时仍按输出兜底识别 unittest', () => {
    const summary = parseTestOutput(input({ command: 'custom-runner', stderr: GREEN_VERBOSE }))
    expect(summary).toMatchObject({ parser: 'unittest', parsed: true, run: 3, passed: 3 })
  })
})

describe('detectEvidenceKind：python unittest 归为 test', () => {
  it('unittest 命令（含裸命令）判定为 test', () => {
    expect(detectEvidenceKind('python3 -m unittest')).toBe('test')
    expect(detectEvidenceKind('python -m unittest')).toBe('test')
    expect(detectEvidenceKind('python3.13 -m unittest tests.test_health -v')).toBe('test')
    expect(detectEvidenceKind("python3 -m unittest discover -s tests -p 'test_*.py'")).toBe('test')
    expect(detectEvidenceKind('unittest discover -s tests')).toBe('test')
  })

  it('不回归既有判定：pytest 仍是 test，普通 python 脚本仍是 run', () => {
    expect(detectEvidenceKind('python3 -m pytest -q')).toBe('test')
    expect(detectEvidenceKind('pytest')).toBe('test')
    expect(detectEvidenceKind('python3 tools/seed.py')).toBe('run')
    expect(detectEvidenceKind('python3 -m csvtool stats data/members.csv')).toBe('run')
  })
})
