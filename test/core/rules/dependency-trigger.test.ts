/**
 * T-DEPENDENCY 误伤修复（03 §8.2 / docs/04 T4.1）：依赖清单按「内容是否真的声明/变更
 * 依赖」判定，而不是只看路径。
 *
 * 真实事故（docs/evaluation-data/20261031-1128-greenfield-members-greenfield-B-recovery3）：
 * S4 用 write 新建零依赖 package.json（dependencies/devDependencies 均为空对象）被反复
 * 转人工，单次放行按 action 指纹只生效一次 → 每轮新 RK，流程停滞。
 *
 * 本文件同时锁定保守兜底：解析失败、无 content、edit 片段、锁文件、删除/重命名、
 * 未知/自定义清单仍然触发 human——只放宽「能确认无依赖的工程脚手架」这一种情况。
 */
import { describe, expect, it } from 'vitest'
import type { Action, FileAction, FlowgateConfig } from '../../../src/core/types'
import { matchRiskTriggers } from '../../../src/core/rules/risk-triggers'
import { makeTaskState } from '../state/fixtures'
import { evalInput, makeChange, makeConfig } from './fixtures'

function allHits(action: Action, config: FlowgateConfig = makeConfig()) {
  return matchRiskTriggers(evalInput(action, { config }))
}

function dependencyHits(action: Action, config: FlowgateConfig = makeConfig()) {
  return allHits(action, config).filter((hit) => hit.trigger === 'dependency-change')
}

function fileAction(path: string, content?: string, kind: 'write' | 'create' = 'write'): FileAction {
  const action: FileAction = { kind, tool: 'write', path }
  if (content !== undefined) action.content = content
  return action
}

/** 断言该动作触发依赖变更（human）。 */
function expectDependency(action: Action, config?: FlowgateConfig): void {
  const hits = dependencyHits(action, config)
  expect(hits, `${action.kind} ${'path' in action ? action.path : action.tool}`).toHaveLength(1)
  expect(hits[0]).toMatchObject({ trigger: 'dependency-change', decision: 'human' })
}

/** 断言该动作不触发依赖变更（但允许其它触发器）。 */
function expectNoDependency(action: Action, config?: FlowgateConfig): void {
  expect(dependencyHits(action, config), `${action.kind} ${'path' in action ? action.path : action.tool}`).toHaveLength(0)
}

// 真实演练里被误伤的 package.json：零外部依赖，dependencies/devDependencies 都是空对象。
const REAL_GREENFIELD_PACKAGE_JSON = `{
  "name": "greenfield-members",
  "version": "0.1.0",
  "private": true,
  "description": "C0 工程骨架：Node.js 标准库 HTTP 服务，提供 GET /health",
  "type": "commonjs",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test"
  },
  "dependencies": {},
  "devDependencies": {}
}
`

describe('T-DEPENDENCY：package.json 按内容判定', () => {
  it('真实演练的零依赖脚手架不触发 human（回归用例）', () => {
    const action = fileAction('package.json', REAL_GREENFIELD_PACKAGE_JSON)
    expectNoDependency(action)
    // 也不应有其它触发器（secret/sensitive/continuous 等）误伤。
    expect(allHits(action)).toEqual([])
  })

  it('只有 name/scripts/type、完全没有任何依赖字段时不触发', () => {
    const content = JSON.stringify({
      name: 'demo',
      private: true,
      type: 'module',
      engines: { node: '>=20' },
      scripts: { start: 'node src/server.js', test: 'node --test' },
    })
    expectNoDependency(fileAction('package.json', content))
  })

  it('依赖字段存在但为空对象/空数组时不触发', () => {
    const content = JSON.stringify({
      name: 'demo',
      dependencies: {},
      devDependencies: {},
      peerDependencies: {},
      optionalDependencies: {},
      bundledDependencies: [],
    })
    expectNoDependency(fileAction('package.json', content))
  })

  it.each([
    ['dependencies', { dependencies: { express: '^4.18.0' } }],
    ['devDependencies', { devDependencies: { vitest: '^4.0.0' } }],
    ['peerDependencies', { peerDependencies: { react: '^18.0.0' } }],
    ['optionalDependencies', { optionalDependencies: { fsevents: '^2.3.0' } }],
    ['bundledDependencies（数组）', { bundledDependencies: ['left-pad'] }],
  ])('%s 非空时触发 human', (_label, fields) => {
    expectDependency(fileAction('package.json', JSON.stringify({ name: 'demo', ...fields })))
  })

  it('非法 JSON 保守触发（解析失败无法确认）', () => {
    expectDependency(fileAction('package.json', '{ "name": "demo", broken'))
    expectDependency(fileAction('package.json', ''))
  })

  it('write 没有 content 字段时保守触发（无法读内容）', () => {
    expectDependency(fileAction('package.json'))
  })

  it('create 新建零依赖清单不触发 / 带依赖触发', () => {
    expectNoDependency(fileAction('package.json', REAL_GREENFIELD_PACKAGE_JSON, 'create'))
    expectDependency(fileAction('package.json', JSON.stringify({ dependencies: { zod: '^3.0.0' } }), 'create'))
  })
})

describe('T-DEPENDENCY：pom.xml 按内容判定', () => {
  const pluginOnly = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.acme</groupId>
  <artifactId>demo</artifactId>
  <build>
    <plugins>
      <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId></plugin>
    </plugins>
  </build>
</project>`

  it('只有 build/plugins、没有 <dependency> 时不触发', () => {
    expectNoDependency(fileAction('pom.xml', pluginOnly))
    expectNoDependency(fileAction('pom.xml', '<project><dependencies></dependencies></project>'))
  })

  it('出现 <dependency> 条目时触发 human', () => {
    expectDependency(
      fileAction(
        'pom.xml',
        '<project><dependencies><dependency><groupId>org.x</groupId><artifactId>y</artifactId></dependency></dependencies></project>',
      ),
    )
  })

  it('dependencyManagement 里的 <dependency> 也算声明依赖（保守触发）', () => {
    expectDependency(
      fileAction(
        'pom.xml',
        '<project><dependencyManagement><dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId></dependency></dependencies></dependencyManagement></project>',
      ),
    )
  })

  it('无 content 字段保守触发（既有行为不变）', () => {
    expectDependency(fileAction('pom.xml'))
  })
})

describe('T-DEPENDENCY：build.gradle(.kts) 按内容判定', () => {
  it('只有 plugins/repositories 的骨架不触发', () => {
    expectNoDependency(
      fileAction('build.gradle', "plugins {\n  id 'java'\n}\nrepositories {\n  mavenCentral()\n}\n"),
    )
  })

  it('出现实现类依赖符号时触发 human', () => {
    expectDependency(
      fileAction('build.gradle', "dependencies {\n  implementation 'org.springframework:spring-core:6.0.0'\n}\n"),
    )
    expectDependency(fileAction('build.gradle.kts', 'dependencies {\n  testImplementation("org.junit:junit:5.0")\n}\n'))
  })
})

describe('T-DEPENDENCY：requirements*.txt / constraints*.txt 按内容判定', () => {
  it('空文件与纯注释/空行不触发', () => {
    expectNoDependency(fileAction('requirements.txt', ''))
    expectNoDependency(fileAction('requirements.txt', '# 依赖由标准库替代\n\n   \n# 无第三方依赖\n'))
    expectNoDependency(fileAction('constraints.txt', '# 暂无约束\n'))
  })

  it('有实际依赖行时触发 human', () => {
    expectDependency(fileAction('requirements.txt', 'flask==2.3.0\n# pin for tests\n'))
    expectDependency(fileAction('requirements-dev.txt', '-r requirements.txt\npytest==8.0.0\n'))
    // constraints*.txt 之前不在清单里：现在按同样的内容规则纳入依赖清单。
    expectDependency(fileAction('constraints.txt', 'urllib3<2.0\n'))
  })
})

describe('T-DEPENDENCY：pyproject.toml 按内容判定', () => {
  it('[project] 只有元数据、没有依赖段时不触发', () => {
    expectNoDependency(fileAction('pyproject.toml', '[project]\nname = "demo"\nversion = "0.1.0"\nrequires-python = ">=3.11"\n'))
    expectNoDependency(fileAction('pyproject.toml', '[project]\ndependencies = []\n'))
    expectNoDependency(fileAction('pyproject.toml', '[tool.poetry.dependencies]\n'))
  })

  it('PEP 621 dependencies 数组非空时触发 human', () => {
    expectDependency(fileAction('pyproject.toml', '[project]\ndependencies = [\n  "requests>=2.31",\n]\n'))
  })

  it('[tool.poetry.dependencies] / [project.optional-dependencies] 段内有内容时触发', () => {
    expectDependency(fileAction('pyproject.toml', '[tool.poetry.dependencies]\nrequests = "^2.31"\n'))
    expectDependency(fileAction('pyproject.toml', '[project.optional-dependencies]\ndev = ["pytest>=8"]\n'))
  })

  it('没有 TOML 段头的 edit 片段（只新增一行依赖）保守触发', () => {
    expectDependency(fileAction('pyproject.toml', 'requests = "^2.31"'))
  })
})

describe('T-DEPENDENCY：go.mod / Cargo.toml 按内容判定', () => {
  it('go.mod 只有 module/go 行不触发；空 require 块不触发', () => {
    expectNoDependency(fileAction('go.mod', 'module example.com/demo\n\ngo 1.22\n'))
    expectNoDependency(fileAction('go.mod', 'module example.com/demo\n\ngo 1.22\n\nrequire ()\n'))
  })

  it('go.mod require 块内出现模块时触发 human', () => {
    expectDependency(fileAction('go.mod', 'module example.com/demo\n\ngo 1.22\n\nrequire (\n\tgithub.com/stretchr/testify v1.9.0\n)\n'))
    expectDependency(fileAction('go.mod', 'module example.com/demo\n\ngo 1.22\n\nrequire github.com/x/y v1.0.0\n'))
  })

  it('Cargo.toml [package] 骨架/空 [dependencies] 不触发', () => {
    expectNoDependency(fileAction('Cargo.toml', '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n'))
    expectNoDependency(fileAction('Cargo.toml', '[package]\nname = "demo"\n\n[dependencies]\n'))
  })

  it('Cargo.toml 依赖段内有内容时触发 human（含 dev-dependencies，保守）', () => {
    expectDependency(fileAction('Cargo.toml', '[package]\nname = "demo"\n\n[dependencies]\nserde = { version = "1", features = ["derive"] }\n'))
    expectDependency(fileAction('Cargo.toml', '[package]\nname = "demo"\n\n[dev-dependencies]\nproptest = "1"\n'))
  })
})

describe('T-DEPENDENCY：锁文件 / 删除 / 重命名 / 未知清单保持保守触发', () => {
  it('lockfile 内容变化一律触发 human（内容就是依赖快照）', () => {
    expectDependency(fileAction('package-lock.json', '{"lockfileVersion":3}'))
    expectDependency(fileAction('pnpm-lock.yaml', 'lockfileVersion: 9.0\n'))
    expectDependency(fileAction('yarn.lock'))
    expectDependency(fileAction('Cargo.lock'))
    expectDependency(fileAction('poetry.lock'))
  })

  it('删除/重命名 manifest 无法从内容判断，保持触发', () => {
    expectDependency({ kind: 'delete', tool: 'delete_file', path: 'package.json' })
    expectDependency({ kind: 'rename', tool: 'move_file', path: 'package.json', toPath: 'package.json.bak' })
  })

  it('未知/自定义依赖清单（config.triggers.dependency_files）保持保守触发', () => {
    const base = makeConfig()
    const config = makeConfig({ triggers: { ...base.triggers, dependency_files: ['deps.yaml'] } })
    expectDependency(fileAction('deps.yaml', 'dependencies: []\n'), config)
    // 同时确认自定义清单扩展不会让默认清单失效。
    expectDependency(fileAction('pom.xml'), config)
  })
})

describe('T-DEPENDENCY：shell 依赖命令判定不变', () => {
  it('npm/pnpm/go/poetry 的依赖命令照旧触发 human', () => {
    for (const command of ['npm install express', 'pnpm add zod', 'go get github.com/x/y', 'poetry add requests']) {
      const hits = dependencyHits({ kind: 'shell', tool: 'bash', command })
      expect(hits, command).toHaveLength(1)
    }
  })

  it('shell 重定向写 manifest 时内容不可知，保持触发（不因内容判定放宽）', () => {
    expectDependency({ kind: 'shell', tool: 'bash', command: "printf '{}' > package.json" })
  })
})

describe('T-DEPENDENCY：非依赖路径与其它触发器不受影响', () => {
  it('普通源码/配置文件写入不触发依赖变更', () => {
    expectNoDependency(fileAction('tsconfig.json', '{"compilerOptions":{"strict":true}}'))
    expectNoDependency(fileAction('src/server.js', 'export const health = () => ({ ok: true })\n'))
  })

  it('依赖清单之外的触发器照旧工作（敏感路径控制组）', () => {
    const base = makeConfig()
    const config = makeConfig({ triggers: { ...base.triggers, sensitive_paths: ['**/payment*/**'] } })
    const hits = allHits(fileAction('src/payment/callback.ts', 'export {}\n'), config)
    expect(hits.map((hit) => hit.trigger)).toContain('sensitive-path')
  })

  it('并发失败熔断与依赖触发器顺序不变（依赖变更仍是独立 hit）', () => {
    const change = makeChange({
      stage: 'S4',
      tasks: {
        T1: makeTaskState({ id: 'T1', failureCount: 3 }),
      },
    })
    const hits = matchRiskTriggers(
      evalInput(fileAction('pom.xml'), { config: makeConfig(), change, stage: 'S4' }),
    )
    expect(hits.map((hit) => hit.trigger)).toEqual(['dependency-change', 'consecutive-failure'])
  })
})
