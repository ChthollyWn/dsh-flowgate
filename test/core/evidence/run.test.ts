import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ChangeStatus, CommandResult, TaskCard, TestSummary } from '../../../src/core/types'
import type { CommandRunner } from '../../../src/core/types'
import { MemoryFileSystem } from '../../../src/core/util/memory-fs'
import {
  DEFAULT_VERIFY_TIMEOUT_MS,
  assertVerifiableCommand,
  compareWithBaseline,
  runFullSuite,
  runVerifyGroup,
  type BaselineResult,
} from '../../../src/core/evidence/run'
import { hashInputs } from '../../../src/core/evidence/hash'

const FIXTURES = new URL('../../fixtures/test-outputs/', import.meta.url)
function fixture(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, FIXTURES)), 'utf8')
}

const CHANGE: ChangeStatus = {
  id: 'C-001',
  kind: 'change',
  title: '会员续费',
  complexity: 'medium',
  risk: 'normal',
  stage: 'S4',
  lifecycle: 'active',
  gates: {},
  batches: [],
  tasks: {},
  evidenceIds: [],
  pending: [],
  overrides: [],
  exceptions: [],
  violations: [],
  reviews: [],
  createdAt: '2026-11-12T10:00:00+08:00',
  updatedAt: '2026-11-12T10:00:00+08:00',
}

function makeTask(command = 'pnpm vitest run', inputs = ['src/**/*.ts', 'package.json']): TaskCard {
  return {
    id: 'T1',
    title: '幂等回调',
    covers: ['R2.S3'],
    scope: ['src/**'],
    tests: ['src/**/*.test.ts'],
    newFiles: [],
    changes: [],
    dependsOn: [],
    tdd: 'required',
    verify: [{ group: 'renewal-unit', command, inputs }],
    run: 'main',
    risk: [],
    size: 'S',
    body: '',
  }
}

function testClock(): { now(): Date; tick(ms: number): void } {
  let time = 1_700_000_000_000
  return {
    now: () => new Date(time),
    tick: (ms: number) => {
      time += ms
    },
  }
}

interface FakeRunner extends CommandRunner {
  calls: { command: string; options: { cwd: string; timeoutMs: number } }[]
}

function makeRunner(result: CommandResult | (() => Promise<CommandResult>)): FakeRunner {
  const calls: { command: string; options: { cwd: string; timeoutMs: number } }[] = []
  return {
    calls,
    async run(command, options) {
      calls.push({ command, options })
      return typeof result === 'function' ? result() : result
    },
  }
}

const PASS_RESULT: CommandResult = {
  exitCode: 0,
  stdout: fixture('vitest-console/pass.txt'),
  stderr: '',
  timedOut: false,
  durationMs: 1200,
}
const FAIL_RESULT: CommandResult = {
  exitCode: 1,
  stdout: fixture('vitest-console/fail.txt'),
  stderr: '',
  timedOut: false,
  durationMs: 1500,
}

const SEED = {
  'src/renewal.ts': 'export function renew() {}',
  'src/renewal.test.ts': 'test("renew", () => {})',
  'package.json': '{"name":"renewal"}',
}

const NEXT_ID = () => 'E-0001'

describe('runVerifyGroup：插件亲自执行验证命令并写回执', () => {
  it('通过时生成 GREEN 回执，命令来自任务卡验证组', async () => {
    const fs = new MemoryFileSystem(SEED)
    const clock = testClock()
    const runner = makeRunner(async () => {
      clock.tick(1200)
      return PASS_RESULT
    })
    const task = makeTask()
    const receipt = await runVerifyGroup({
      fs,
      root: '',
      runner,
      change: CHANGE,
      task,
      group: task.verify[0]!,
      clock,
      nextEvidenceId: NEXT_ID,
    })

    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]?.command).toBe('pnpm vitest run')
    expect(runner.calls[0]?.options.cwd).toBe('')
    expect(runner.calls[0]?.options.timeoutMs).toBe(DEFAULT_VERIFY_TIMEOUT_MS)

    expect(receipt.id).toBe('E-0001')
    expect(receipt.changeId).toBe('C-001')
    expect(receipt.taskId).toBe('T1')
    expect(receipt.group).toBe('renewal-unit')
    expect(receipt.runBy).toBe('flowgate')
    expect(receipt.kind).toBe('test')
    expect(receipt.phase).toBe('green')
    expect(receipt.exitCode).toBe(0)
    expect(receipt.summary?.run).toBe(3)
    expect(receipt.summary?.failed).toBe(0)
    expect(receipt.outputRef).toBe('.flowgate/state/evidence/E-0001.log')
    expect(receipt.timedOut).toBeUndefined()

    const expectedHash = await hashInputs(fs, '', ['src/**/*.ts', 'package.json'])
    expect(receipt.inputsHash).toBe(expectedHash.hash)
    expect(expectedHash.files).toContain('src/renewal.ts')

    const log = await fs.readFile('.flowgate/state/evidence/E-0001.log')
    expect(log).toContain('pnpm vitest run')
    expect(log).toContain('Tests  3 passed (3)')
    expect(log).toContain('退出码：0')
  })

  it('失败时生成 RED 回执，并记录失败用例信息', async () => {
    const fs = new MemoryFileSystem(SEED)
    const runner = makeRunner(FAIL_RESULT)
    const task = makeTask()
    const receipt = await runVerifyGroup({
      fs,
      root: '',
      runner,
      change: CHANGE,
      task,
      group: task.verify[0]!,
      clock: testClock(),
      nextEvidenceId: NEXT_ID,
    })
    expect(receipt.phase).toBe('red')
    expect(receipt.summary?.failed).toBe(1)
    expect(receipt.summary?.failures?.[0]?.name).toBe('duplicate callback is ignored')
    expect(receipt.notes).toContain('失败')
  })

  it('运行数为 0 不算证据（FR-5.2），phase = none 并写入口径说明', async () => {
    const fs = new MemoryFileSystem(SEED)
    const runner = makeRunner({ exitCode: 0, stdout: fixture('maven-console/zero.txt'), stderr: '', timedOut: false, durationMs: 100 })
    const task = makeTask('mvn -B test')
    const receipt = await runVerifyGroup({
      fs,
      root: '',
      runner,
      change: CHANGE,
      task,
      group: task.verify[0]!,
      clock: testClock(),
      nextEvidenceId: NEXT_ID,
    })
    expect(receipt.phase).toBe('none')
    expect(receipt.summary?.run).toBe(0)
    expect(receipt.notes).toContain('运行数为 0')
  })

  it('解析不出数量时 parsed = false，退出码 0 只能当 GREEN 辅助而不能当 RED', async () => {
    const fs = new MemoryFileSystem(SEED)
    const runner = makeRunner({
      exitCode: 0,
      stdout: fixture('unparseable/build-success.txt'),
      stderr: '',
      timedOut: false,
      durationMs: 100,
    })
    const task = makeTask('pnpm build')
    const receipt = await runVerifyGroup({
      fs,
      root: '',
      runner,
      change: CHANGE,
      task,
      group: task.verify[0]!,
      clock: testClock(),
      nextEvidenceId: NEXT_ID,
    })
    expect(receipt.summary?.parsed).toBe(false)
    expect(receipt.phase).toBe('none')
    expect(receipt.notes).toContain('辅助证据')
  })

  it('优先使用命令开始后生成的机器可读报告（JUnit XML）', async () => {
    const fs = new MemoryFileSystem(SEED)
    const runner = makeRunner(async () => {
      await fs.writeFile('target/surefire-reports/TEST-RenewalCallbackTest.xml', fixture('surefire-junit/fail.xml'))
      return { exitCode: 0, stdout: fixture('maven-console/pass.txt'), stderr: '', timedOut: false, durationMs: 2000 }
    })
    const task = makeTask('mvn -B test')
    const receipt = await runVerifyGroup({
      fs,
      root: '',
      runner,
      change: CHANGE,
      task,
      group: task.verify[0]!,
      clock: testClock(),
      nextEvidenceId: NEXT_ID,
    })
    expect(receipt.summary?.parser).toBe('junit-xml')
    expect(receipt.summary?.failed).toBe(1)
    expect(receipt.phase).toBe('red')
    expect(receipt.notes).toContain('机器可读报告')
  })

  it('从命令里识别显式报告路径（pytest --junitxml=...）', async () => {
    const fs = new MemoryFileSystem(SEED)
    const runner = makeRunner(async () => {
      await fs.writeFile('reports/junit.xml', fixture('pytest-junitxml/fail.xml'))
      return { exitCode: 0, stdout: '1 passed in 0.01s', stderr: '', timedOut: false, durationMs: 100 }
    })
    const task = makeTask('pytest --junitxml=reports/junit.xml')
    const receipt = await runVerifyGroup({
      fs,
      root: '',
      runner,
      change: CHANGE,
      task,
      group: task.verify[0]!,
      clock: testClock(),
      nextEvidenceId: NEXT_ID,
    })
    expect(receipt.summary?.parser).toBe('junit-xml')
    expect(receipt.summary?.run).toBe(2)
    expect(receipt.summary?.failed).toBe(1)
    expect(receipt.phase).toBe('red')
  })

  it('超时的回执标记 timedOut 且不能作为 GREEN', async () => {
    const fs = new MemoryFileSystem(SEED)
    const runner = makeRunner({ exitCode: 124, stdout: '', stderr: 'killed after timeout', timedOut: true, durationMs: 600_000 })
    const task = makeTask()
    const receipt = await runVerifyGroup({
      fs,
      root: '',
      runner,
      change: CHANGE,
      task,
      group: task.verify[0]!,
      clock: testClock(),
      nextEvidenceId: NEXT_ID,
    })
    expect(receipt.timedOut).toBe(true)
    expect(receipt.phase).toBe('none')
    expect(receipt.notes).toContain('超时')
  })

  it('runner 抛错时仍写回执与日志，phase = none', async () => {
    const fs = new MemoryFileSystem(SEED)
    const runner = makeRunner(async () => {
      throw new Error('spawn failed')
    })
    const task = makeTask()
    const receipt = await runVerifyGroup({
      fs,
      root: '',
      runner,
      change: CHANGE,
      task,
      group: task.verify[0]!,
      clock: testClock(),
      nextEvidenceId: NEXT_ID,
    })
    expect(receipt.exitCode).not.toBe(0)
    expect(receipt.phase).toBe('none')
    expect(await fs.exists(receipt.outputRef)).toBe(true)
    expect(await fs.readFile(receipt.outputRef)).toContain('验证命令执行失败')
  })
})

describe('验证命令形状限制（FR-5.11）', () => {
  it('拒绝 && || ; 管道 重定向 命令替换与反引号', () => {
    const invalid = [
      'npm test || true',
      'npm test && echo ok',
      'npm test; echo done',
      'mvn test | tee log',
      'mvn test > out.log',
      'cat < input.txt',
      'echo `date`',
      'echo $(date)',
    ]
    for (const command of invalid) {
      expect(() => assertVerifiableCommand(command), command).toThrow(/不能包含/)
    }
  })

  it('接受常见工具链的单条命令与含箭头函数的 node -e', () => {
    const valid = [
      './mvnw -B -q -Dtest=RenewalCallbackTest test',
      './gradlew test --rerun-tasks',
      'go test -json ./...',
      'pnpm vitest run',
      'cargo test --release',
      'pytest -q',
      'node -e "const f = x => x * 2"',
    ]
    for (const command of valid) {
      expect(() => assertVerifiableCommand(command), command).not.toThrow()
    }
  })

  it('runVerifyGroup 对非法命令直接拒绝，不执行 runner', async () => {
    const fs = new MemoryFileSystem(SEED)
    const runner = makeRunner(PASS_RESULT)
    const task = makeTask('npm test || true')
    await expect(
      runVerifyGroup({
        fs,
        root: '',
        runner,
        change: CHANGE,
        task,
        group: task.verify[0]!,
        clock: testClock(),
        nextEvidenceId: NEXT_ID,
      }),
    ).rejects.toThrow(/不能包含/)
    expect(runner.calls).toHaveLength(0)
  })
})

describe('runFullSuite 与基线对比', () => {
  const baseline: BaselineResult = {
    commit: 'abc123',
    summary: { parser: 'vitest-console', parsed: true, run: 3, passed: 3, failed: 0, skipped: 0 },
    receipts: [],
    failedTests: [],
  }

  it('全量测试相对基线新增回归时，回执不能保持 GREEN', async () => {
    const fs = new MemoryFileSystem(SEED)
    const receipt = await runFullSuite({
      fs,
      root: '',
      runner: makeRunner(FAIL_RESULT),
      change: CHANGE,
      clock: testClock(),
      nextEvidenceId: () => 'E-0100',
      command: 'pnpm vitest run',
      inputs: ['src/**/*.ts'],
      baseline,
    })
    expect(receipt.group).toBe('full-suite')
    expect(receipt.taskId).toBeUndefined()
    expect(receipt.summary?.regressions).toEqual(['duplicate callback is ignored'])
    // 失败用例存在 → RED；关键是不能保持 GREEN。
    expect(receipt.phase).toBe('red')
    expect(receipt.notes).toContain('新增回归')
  })

  it('没有基线时如实标注，不伪造回归数', async () => {
    const fs = new MemoryFileSystem(SEED)
    const receipt = await runFullSuite({
      fs,
      root: '',
      runner: makeRunner(PASS_RESULT),
      change: CHANGE,
      clock: testClock(),
      nextEvidenceId: () => 'E-0101',
      command: 'pnpm vitest run',
      inputs: ['src/**/*.ts'],
    })
    expect(receipt.phase).toBe('green')
    expect(receipt.summary?.regressions).toBeUndefined()
    expect(receipt.notes).toContain('未提供基线')
  })

  it('compareWithBaseline：基线通过现在失败 = 回归；基线失败现在通过 = 新增通过', () => {
    const current: TestSummary = {
      parser: 'x',
      parsed: true,
      run: 4,
      passed: 2,
      failed: 2,
      skipped: 0,
      failures: [
        { name: 'A' },
        { name: 'B' },
      ],
    }
    const withBaseline: BaselineResult = {
      commit: 'abc',
      summary: { parser: 'x', parsed: true, run: 3, passed: 2, failed: 1, skipped: 0 },
      receipts: [],
      failedTests: ['A'],
    }
    const withBase = compareWithBaseline(withBaseline, current)
    expect(withBase.regressions).toEqual(['B'])
    expect(withBase.newPasses).toEqual([])
    expect(withBase.ok).toBe(false)

    const healedCurrent: TestSummary = { parser: 'x', parsed: true, run: 1, passed: 1, failed: 0, skipped: 0 }
    const healed = compareWithBaseline(withBaseline, healedCurrent)
    expect(healed.regressions).toEqual([])
    expect(healed.newPasses).toEqual(['A'])
    expect(healed.ok).toBe(true)

    const noBaseline = compareWithBaseline(null, current)
    expect(noBaseline.regressions).toEqual(['A', 'B'])
    expect(noBaseline.ok).toBe(false)
  })
})
