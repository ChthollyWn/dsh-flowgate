import { describe, expect, it } from 'vitest'
import {
  HOTSPOT_PATTERNS,
  batchOverlaps,
  checkExecutionPlan,
  isHotspotPattern,
  nextRunnableBatch,
  renderExecutionDiagram,
  renderExecutionPlanMarkdown,
  taskDependenciesRespectBatches,
} from '../../../src/core/plan/check'
import type { ChangeStatus, ExecutionPlan, TaskCard } from '../../../src/core/types'
import {
  RENEWAL_SCOPE,
  NOW,
  taskCard,
  validChange,
  validConfig,
  validExecutionPlan,
  validTaskCards,
} from '../../fixtures/artifacts/helpers'

function config() {
  return validConfig()
}

function planOf(batches: ExecutionPlan['batches']): ExecutionPlan {
  return { batches }
}

describe('checkExecutionPlan', () => {
  it('合法执行计划通过', () => {
    const outcome = checkExecutionPlan(validTaskCards(), validExecutionPlan(), config())
    expect(outcome.passed).toBe(true)
    expect(outcome.details).toBeUndefined()
  })

  it('任务同时出现在两个批次 → 失败', () => {
    const plan = planOf([
      { batch: 'B1', mode: 'sequential', tasks: ['T1', 'T2'], why: '顺序' },
      { batch: 'B2', mode: 'sequential', tasks: ['T2', 'T3', 'T4'], why: '顺序' },
    ])
    const outcome = checkExecutionPlan(validTaskCards(), plan, config())
    expect(outcome.passed).toBe(false)
    expect(outcome.details!.join('\n')).toContain('同时出现在批次')
  })

  it('任务没有排进任何批次 → 失败', () => {
    const plan = planOf([{ batch: 'B1', mode: 'sequential', tasks: ['T1', 'T2', 'T3'], why: '顺序' }])
    const outcome = checkExecutionPlan(validTaskCards(), plan, config())
    expect(outcome.passed).toBe(false)
    expect(outcome.details!.join('\n')).toContain('T4 没有被排进任何批次')
  })

  it('批次引用不存在的任务 / 缺 why → 失败', () => {
    const plan = planOf([{ batch: 'B1', mode: 'sequential', tasks: ['T1', 'T2', 'T3', 'T4', 'T9'], why: '' }])
    const outcome = checkExecutionPlan(validTaskCards(), plan, config())
    expect(outcome.passed).toBe(false)
    const details = outcome.details!.join('\n')
    expect(details).toContain('不存在的任务 T9')
    expect(details).toContain('没有写 why')
  })

  it('依赖指向更晚批次 → 失败', () => {
    const tasks = validTaskCards().map((task) =>
      task.id === 'T1' ? { ...task, dependsOn: ['T3'] } : task,
    )
    const outcome = checkExecutionPlan(tasks, validExecutionPlan(), config())
    expect(outcome.passed).toBe(false)
    expect(outcome.details!.join('\n')).toContain('更晚批次 B2')
  })

  it('并行批次内互相依赖 → 失败', () => {
    const tasks = validTaskCards().map((task) =>
      task.id === 'T4' ? { ...task, dependsOn: ['T3'] } : task,
    )
    const outcome = checkExecutionPlan(tasks, validExecutionPlan(), config())
    expect(outcome.passed).toBe(false)
    expect(outcome.details!.join('\n')).toContain('并行任务必须互不依赖')
  })

  it('顺序批次内依赖排在后面的任务 → 失败', () => {
    const tasks = validTaskCards().map((task) =>
      task.id === 'T1' ? { ...task, dependsOn: ['T2'] } : task,
    )
    const outcome = checkExecutionPlan(tasks, validExecutionPlan(), config())
    expect(outcome.passed).toBe(false)
    expect(outcome.details!.join('\n')).toContain('依赖必须指向更早执行的任务')
  })

  it('并行批次范围重叠 → 指出重叠文件（T2.9 验收）', () => {
    const shared = 'src/main/java/com/acme/member/renewal/RenewalService.java'
    const tasks = validTaskCards().map((task) =>
      task.id === 'T4' ? { ...task, scope: [...task.scope, shared] } : task.id === 'T3' ? { ...task, scope: [...task.scope, shared] } : task,
    )
    const outcome = checkExecutionPlan(tasks, validExecutionPlan(), config())
    expect(outcome.passed).toBe(false)
    const text = `${outcome.details!.join('\n')}\n${outcome.hint ?? ''}\n${outcome.example ?? ''}`
    expect(text).toContain('RenewalService.java')
    expect(text).toContain('范围重叠')
  })

  it('并行批次触碰热点文件 pom.xml → 失败并提示移到顺序批次（T2.9 验收）', () => {
    const tasks = validTaskCards().map((task) =>
      task.id === 'T3' ? { ...task, scope: ['pom.xml'] } : task,
    )
    const outcome = checkExecutionPlan(tasks, validExecutionPlan(), config())
    expect(outcome.passed).toBe(false)
    const text = outcome.details!.join('\n')
    expect(text).toContain('热点文件 pom.xml')
    expect(text).toContain('顺序批次')
  })

  it('空计划 → 失败', () => {
    const outcome = checkExecutionPlan(validTaskCards(), planOf([]), config())
    expect(outcome.passed).toBe(false)
    expect(outcome.details!.join('\n')).toContain('执行计划为空')
  })
})

describe('batchOverlaps / taskDependenciesRespectBatches / isHotspotPattern', () => {
  it('batchOverlaps 找出并行范围交集', () => {
    const shared = 'src/main/java/com/acme/member/renewal/RenewalService.java'
    const tasks = validTaskCards().map((task) =>
      task.id === 'T3' || task.id === 'T4' ? { ...task, scope: [shared] } : task,
    )
    const overlaps = batchOverlaps(tasks, { batch: 'B2', mode: 'parallel', tasks: ['T3', 'T4'], why: '' })
    expect(overlaps).toHaveLength(1)
    expect(overlaps[0]).toMatchObject({ a: 'T3', b: 'T4', path: shared })
  })

  it('taskDependenciesRespectBatches 返回违规描述', () => {
    const tasks = validTaskCards().map((task) => (task.id === 'T1' ? { ...task, dependsOn: ['T3'] } : task))
    const violations = taskDependenciesRespectBatches(tasks, validExecutionPlan())
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('更晚批次')
  })

  it('isHotspotPattern 覆盖依赖清单、路由、迁移、i18n 与自定义热点', () => {
    const cfg = validConfig()
    expect(isHotspotPattern('pom.xml', cfg)).toBe(true)
    expect(isHotspotPattern('package.json', cfg)).toBe(true)
    expect(isHotspotPattern('src/main/resources/db/migration/V1.sql', cfg)).toBe(true)
    expect(isHotspotPattern('src/main/java/com/acme/member/renewal/**', cfg)).toBe(false)
    const withExtra = validConfig()
    withExtra.parallel.hotspots_extra = ['src/main/resources/application*.yml']
    expect(isHotspotPattern('src/main/resources/application-prod.yml', withExtra)).toBe(true)
    expect(HOTSPOT_PATTERNS).toContain('pnpm-lock.yaml')
  })
})

describe('nextRunnableBatch', () => {
  it('返回首个未完成的 pending 批次', () => {
    const change = validChange({
      batches: [
        { id: 'B1', mode: 'sequential', status: 'done', tasks: ['T1'] },
        { id: 'B2', mode: 'parallel', status: 'pending', tasks: ['T2', 'T3'] },
        { id: 'B3', mode: 'sequential', status: 'pending', tasks: ['T4'] },
      ],
    })
    const batch = nextRunnableBatch(change)
    expect(batch).toMatchObject({ batch: 'B2', mode: 'parallel', tasks: ['T2', 'T3'] })
  })

  it('前一批次未完成 → null', () => {
    const change = validChange({
      batches: [
        { id: 'B1', mode: 'sequential', status: 'running', tasks: ['T1'] },
        { id: 'B2', mode: 'sequential', status: 'pending', tasks: ['T2'] },
      ],
    })
    expect(nextRunnableBatch(change)).toBeNull()
  })

  it('全部完成或空计划 → null', () => {
    expect(nextRunnableBatch(validChange())).toBeNull()
    expect(nextRunnableBatch(validChange({ batches: [] }))).toBeNull()
  })

  it('批次阻塞 / 失败 → null', () => {
    const blocked = validChange({
      batches: [{ id: 'B1', mode: 'sequential', status: 'blocked', tasks: ['T1'] }],
    })
    expect(nextRunnableBatch(blocked)).toBeNull()
  })
})

describe('renderExecutionDiagram / renderExecutionPlanMarkdown', () => {
  function changeWithStates(): ChangeStatus {
    const change = validChange()
    return {
      ...change,
      batches: [
        { id: 'B1', mode: 'sequential', status: 'done', tasks: ['T1', 'T2'] },
        { id: 'B2', mode: 'parallel', status: 'running', tasks: ['T3', 'T4'] },
      ],
      tasks: {
        ...change.tasks,
        T3: { ...change.tasks.T3!, status: 'running' },
        T4: { ...change.tasks.T4!, status: 'pending' },
      },
    }
  }

  it('生成 mermaid flowchart（批次 subgraph、检查点、状态着色）', () => {
    const mermaid = renderExecutionDiagram(validExecutionPlan(), changeWithStates())
    expect(mermaid).toContain('flowchart LR')
    expect(mermaid).toContain('subgraph B1')
    expect(mermaid).toContain('B2 并行')
    expect(mermaid).toContain('T2 --> T3')
    expect(mermaid).toContain('T3 --> CP_B2')
    expect(mermaid).toContain('集成检查点')
    expect(mermaid).toContain('classDef done')
    expect(mermaid).toContain('classDef running')
    expect(mermaid).toContain('classDef pending')
    expect(mermaid).toMatch(/class [^\n]*T1[^\n]* done/)
    expect(mermaid).toMatch(/class [^\n]*T3[^\n]* running/)
    expect(mermaid).toMatch(/class [^\n]*T4[^\n]* pending/)
  })

  it('顺序批次内部按列出顺序连边', () => {
    const mermaid = renderExecutionDiagram(validExecutionPlan(), validChange())
    expect(mermaid).toContain('T1 --> T2')
  })

  it('空计划给出占位图', () => {
    const mermaid = renderExecutionDiagram({ batches: [] }, validChange())
    expect(mermaid).toContain('flowchart LR')
    expect(mermaid).toContain('暂无执行计划')
  })

  it('生成带批次表的执行计划 markdown', () => {
    const markdown = renderExecutionPlanMarkdown(validExecutionPlan(), changeWithStates())
    expect(markdown).toContain('# 执行计划')
    expect(markdown).toContain('| B1 | 顺序 |')
    expect(markdown).toContain('| B2 | 并行 |')
    expect(markdown).toContain('```mermaid')
    expect(markdown).toContain('图例')
    expect(markdown).toContain('进行中')
  })
})

describe('plan helpers with custom tasks', () => {
  it('并行批次任务 tags 与顺序批次不触发热点检查', () => {
    const tasks: TaskCard[] = [
      taskCard({ id: 'T1', scope: [RENEWAL_SCOPE], verify: [{ group: 'g', command: 'pnpm test', inputs: ['src/**'] }], covers: ['R1.S1'] }),
      taskCard({ id: 'T2', scope: [RENEWAL_SCOPE], verify: [{ group: 'g', command: 'pnpm test', inputs: ['src/**'] }], covers: ['R1.S2'] }),
    ]
    const plan = planOf([{ batch: 'B1', mode: 'sequential', tasks: ['T1', 'T2'], why: '顺序' }])
    expect(checkExecutionPlan(tasks, plan, config()).passed).toBe(true)
    void NOW
  })
})
