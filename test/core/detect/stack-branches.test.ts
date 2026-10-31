/**
 * Branch tests for evidence-based stack detection (detect/stack.ts).
 *
 * Each case seeds a minimal in-memory project tree and asserts the detected
 * facts / commands / modules / risks, plus the rendered project.md draft.
 */
import { describe, expect, it } from 'vitest'
import { detectTechStack, renderProjectDocDraft } from '../../../src/core/detect/stack'
import type { DetectedStack } from '../../../src/core/detect/stack'
import type { CitationRef } from '../../../src/core/types'
import { MemoryFileSystem } from '../../../src/core/util/memory-fs'

function fs(seed: Record<string, string>): MemoryFileSystem {
  return new MemoryFileSystem(seed)
}

const NOW = '2026-11-12T10:31:05+08:00'

describe('detect/stack — Maven 边界', () => {
  it('父 POM 没有 version 时 Spring Boot 事实不带版本；artifactId 可回退到父 POM', async () => {
    const pom = `<project>
  <parent>
    <artifactId>spring-boot-starter-parent</artifactId>
  </parent>
  <properties>
    <maven.compiler.source>11</maven.compiler.source>
  </properties>
</project>
`
    const stack = await detectTechStack(fs({ 'pom.xml': pom }), '')
    expect(stack.kind).toBe('maven')
    // 去掉 <parent> 后没有 artifactId，回退到原始 pom 的父 artifactId
    expect(stack.name).toBe('spring-boot-starter-parent')
    const texts = stack.stackFacts.map((factItem) => factItem.text)
    expect(texts).toContain('Spring Boot（spring-boot-starter-parent）')
    expect(texts).toContain('Java 11')
    expect(stack.commands.lint).toBeUndefined()
    expect(stack.commands.run).toBeUndefined()
  })

  it('checkstyle 作为 lint；子模块来自 topLevelDirs + README 职责描述', async () => {
    const pom = `<project>
  <artifactId>svc</artifactId>
  <build><plugins><plugin><artifactId>checkstyle-maven-plugin</artifactId></plugin></plugins></build>
</project>
`
    const readme = [
      '# demo',
      '- api: 会员接口',
      '`web`：Web 层',
      '- lib/: 公共库',
      '- ignored 没有匹配的模块',
    ].join('\n')
    const tree: Record<string, string> = {
      'pom.xml': pom,
      'README.md': readme,
      'api/a.ts': 'x',
      'web/b.ts': 'x',
      'lib/c.ts': 'x',
      'node_modules/d.ts': 'x',
      'random/e.ts': 'x',
      'src/f.ts': 'x',
    }
    const stack = await detectTechStack(fs(tree), '')
    expect(stack.commands.lint).toBe('mvn -q checkstyle:check')
    const modules = Object.fromEntries(stack.modules.map((module) => [module.path, module.responsibility]))
    expect(modules['api']).toBe('会员接口')
    expect(modules['web']).toBe('Web 层')
    expect(modules['lib']).toBe('公共库')
    // src 被过滤；非模块提示目录与忽略目录不进模块表
    expect(modules['src']).toBeUndefined()
    expect(modules['node_modules']).toBeUndefined()
    expect(modules['random']).toBeUndefined()
  })

  it('模块目录最多 20 个；名字回退到项目目录名或"未知项目"', async () => {
    const hints = [
      'app', 'apps', 'lib', 'libs', 'packages', 'modules', 'module', 'server', 'client', 'web',
      'api', 'core', 'services', 'service', 'cmd', 'internal', 'pkg', 'components', 'pages', 'tests',
      'test', 'docs', 'scripts', 'deploy', 'infra',
    ]
    const tree: Record<string, string> = { 'pom.xml': '<project><artifactId></artifactId></project>' }
    for (const dir of hints) tree[`${dir}/index.ts`] = 'x'
    const stack = await detectTechStack(fs(tree), '')
    expect(stack.modules).toHaveLength(20)
    expect(stack.name).toBe('未知项目')

    const rooted = await detectTechStack(fs({ 'app/pom.xml': '<project></project>' }), 'app')
    expect(rooted.name).toBe('app')
  })
})

describe('detect/stack — Gradle 边界', () => {
  it('settings 子项目 / rootProject.name / ktlint / Spring Boot / JavaLanguageVersion', async () => {
    const build = `plugins { id 'org.springframework.boot' }
java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }
ktlint { }
`
    const settings = `rootProject.name = 'orders'
include(':api:web', 'core')
`
    const stack = await detectTechStack(
      fs({ 'build.gradle': build, 'settings.gradle': settings }),
      '',
    )
    expect(stack.kind).toBe('gradle')
    expect(stack.commands).toMatchObject({ test: 'gradle test --rerun-tasks', build: 'gradle build', lint: 'gradle ktlintCheck', run: 'gradle bootRun' })
    // include(...) 每个参数需要单独一个 include(...)：这里只解析到第一个子项目
    expect(stack.modules.map((module) => module.path)).toEqual(['api/web'])
    expect(stack.stackFacts.some((factItem) => factItem.text.includes('orders'))).toBe(true)
    expect(stack.risks.join('\n')).toContain('Gradle Wrapper')
    expect(stack.name).toBe('未知项目')
  })

  it('build.gradle.kts + settings.gradle.kts + wrapper；无 settings 时按目录推断模块', async () => {
    const tree: Record<string, string> = {
      'proj/build.gradle.kts': 'plugins { java }\n',
      'proj/settings.gradle.kts': "include(\":kts-mod\")",
      'proj/gradlew': '#!/bin/sh\n',
      'proj/README.md': '- api: 接口层\n',
      'proj/api/index.kt': 'x',
      'proj/src/main.kt': 'x',
    }
    const stack = await detectTechStack(fs(tree), 'proj')
    expect(stack.kind).toBe('gradle')
    expect(stack.commands.test).toBe('./gradlew test --rerun-tasks')
    // settings.gradle.kts 存在时子项目来自 include(...)，不回退目录扫描
    expect(stack.modules.map((module) => module.path)).toEqual(['kts-mod'])
    expect(stack.name).toBe('proj')

    // settings 文件不存在 -> modules 回退 topLevelDirs
    const noSettings = await detectTechStack(
      fs({ 'build.gradle': 'plugins { java }\n', 'core/x.java': 'x', 'src/y.java': 'x' }),
      '',
    )
    expect(noSettings.modules.map((module) => module.path)).toEqual(['core'])
  })
})

describe('detect/stack — Node.js 包管理器与命令回退', () => {
  it('yarn.lock / package-lock.json / pnpm-workspace.yaml 的包管理器识别与命令生成', async () => {
    const yarnPkg = JSON.stringify({ name: 'yarn-app', scripts: { test: 'jest' } })
    const yarn = await detectTechStack(fs({ 'package.json': yarnPkg, 'yarn.lock': '' }), '')
    expect(yarn.commands.test).toBe('yarn test')
    expect(yarn.stackFacts.map((factItem) => factItem.text).join('\n')).toContain('包管理器：yarn')

    const npmPkg = JSON.stringify({
      name: 'npm-app',
      devDependencies: { vitest: '1', typescript: '5', '@biomejs/biome': '1' },
    })
    const npm = await detectTechStack(
      fs({ 'package.json': npmPkg, 'package-lock.json': '{}', 'tsconfig.build.json': '{}' }),
      '',
    )
    expect(npm.commands.test).toBe('npx vitest run')
    expect(npm.commands.lint).toBe('npx biome check .')
    expect(npm.commands.typecheck).toBe('npx tsc --noEmit')
    expect(npm.commands.build).toBeUndefined()
    expect(npm.commands.run).toBeUndefined()

    const pnpmWorkspace = await detectTechStack(
      fs({ 'package.json': '{"name":"ws"}', 'pnpm-workspace.yaml': 'packages:\n  - apps/*\n' }),
      '',
    )
    expect(pnpmWorkspace.stackFacts.map((factItem) => factItem.text).join('\n')).toContain('pnpm-workspace.yaml')

    // 什么锁文件都没有 -> 默认 npm 并登记风险
    const bare = await detectTechStack(fs({ 'package.json': '{"name":"bare"}' }), '')
    expect(bare.stackFacts.map((factItem) => factItem.text).join('\n')).toContain('默认使用 npm')
    expect(bare.risks.join('\n')).toContain('锁文件')
    expect(bare.commands.test).toBe('none')
  })

  it('测试框架回退顺序：jest / mocha / playwright / 配置文件探测', async () => {
    const jest = await detectTechStack(
      fs({ 'package.json': JSON.stringify({ devDependencies: { jest: '29' } }), 'pnpm-lock.yaml': '' }),
      '',
    )
    expect(jest.commands.test).toBe('pnpm exec jest --ci')

    const mocha = await detectTechStack(fs({ 'package.json': '{"devDependencies":{"mocha":"10"}}' }), '')
    expect(mocha.commands.test).toBe('npx mocha')

    const playwright = await detectTechStack(
      fs({ 'package.json': '{"devDependencies":{"@playwright/test":"1"}}' }),
      '',
    )
    expect(playwright.commands.test).toBe('npx playwright test')

    const jestConfig = await detectTechStack(fs({ 'package.json': '{}', 'jest.config.ts': 'export default {}' }), '')
    expect(jestConfig.commands.test).toBe('npx jest --ci')

    const vitestConfig = await detectTechStack(fs({ 'package.json': '{}', 'vitest.config.js': 'export default {}' }), '')
    expect(vitestConfig.commands.test).toBe('npx vitest run')
  })

  it('scripts 覆盖 lint / typecheck / type-check / build / dev / start 与空脚本', async () => {
    const pkg = JSON.stringify({
      name: 'scripts-app',
      version: '2.0.0',
      scripts: {
        test: 'vitest run',
        lint: 'eslint .',
        build: 'tsc -p .',
        'type-check': 'tsc --noEmit',
        dev: 'vite',
        start: 'node dist/index.js',
        'empty-script': '   ',
      },
      workspaces: ['packages/a', 'packages/b', 'packages/**', 'packages/a', ''],
    })
    const stack = await detectTechStack(fs({ 'package.json': pkg, 'pnpm-lock.yaml': '' }), '')
    expect(stack.commands).toMatchObject({
      test: 'pnpm test',
      lint: 'pnpm lint',
      build: 'pnpm build',
      typecheck: 'pnpm type-check',
      run: 'pnpm dev',
    })
    // workspaces 去重 / 去掉通配与空模式 / ** 归一化
    expect(stack.modules.map((module) => module.path)).toEqual(['packages/a', 'packages/b', 'packages'])

    const fallback = await detectTechStack(
      fs({ 'package.json': JSON.stringify({ scripts: { start: 'node .', build: 'tsc' } }) }),
      '',
    )
    expect(fallback.commands.run).toBe('npm start')
    expect(fallback.commands.build).toBe('npm run build')
  })

  it('workspaces 为对象 / 非法 JSON / 缺 name 时走默认分支', async () => {
    const objectWorkspaces = await detectTechStack(
      fs({
        'package.json': JSON.stringify({ name: 'obj', workspaces: { packages: ['apps/x', 'apps/y'] } }),
      }),
      '',
    )
    expect(objectWorkspaces.modules.map((module) => module.path)).toEqual(['apps/x', 'apps/y'])

    const objectWithoutPackages = await detectTechStack(
      fs({ 'package.json': JSON.stringify({ workspaces: { nope: true } }), 'core/x.ts': 'x' }),
      '',
    )
    expect(objectWithoutPackages.modules.map((module) => module.path)).toEqual(['core'])

    // 非法 JSON -> 空对象：test none + 风险
    const broken = await detectTechStack(fs({ 'package.json': '{not json', '.github/workflows/ci.yml': 'on: push' }), '')
    expect(broken.commands.test).toBe('none')
    expect(broken.name).toBe('未知项目')
    expect(broken.risks.join('\n')).toContain('缺少自动化测试')
    // 存在 CI 配置时不登记 CI 风险
    expect(broken.risks.join('\n')).not.toContain('未发现 CI')

    const gitlab = await detectTechStack(
      fs({ 'repo/package.json': '{}', 'repo/package-lock.json': '{}', 'repo/.gitlab-ci.yml': 'test:' }),
      'repo',
    )
    expect(gitlab.name).toBe('repo')
    expect(gitlab.risks.join('\n')).not.toContain('未发现 CI')
    expect(gitlab.risks.join('\n')).not.toContain('锁文件')
  })
})

describe('detect/stack — Python 边界', () => {
  it('pyproject 的版本 / 框架 / 工具链 / 脚本 / __init__.py 模块', async () => {
    const pyproject = `[project]
name = "billing"
requires-python = ">=3.11"
dependencies = ["django"]
[project.scripts]
serve = "billing.cli:main"
[build-system]
requires = ["setuptools"]
[tool.ruff]
[tool.mypy]
[tool.pytest.ini_options]
minversion = "7.0"
[tool.pytest.ini_options]
minversion = "7.0"
`
    const tree: Record<string, string> = {
      'pyproject.toml': pyproject,
      'README.md': '- api: 接口\n',
      'api/__init__.py': '',
      'src/app.py': 'x',
      'tests/test_api.py': 'x',
      'docs/readme.md': 'x',
    }
    const stack = await detectTechStack(fs(tree), '')
    expect(stack.kind).toBe('python')
    expect(stack.name).toBe('billing')
    expect(stack.commands).toMatchObject({
      test: 'pytest -q',
      lint: 'ruff check .',
      build: 'python -m build',
      typecheck: 'mypy .',
      run: 'python -m serve',
    })
    expect(stack.modules.map((module) => module.path)).toEqual(['api'])
    expect(stack.stackFacts.map((factItem) => factItem.text).join('\n')).toContain('Python >=3.11')
    expect(stack.stackFacts.map((factItem) => factItem.text).join('\n')).toContain('Web 框架：django')
    expect(stack.risks).toHaveLength(0)
  })

  it('setup.py / requirements.txt 的回退与风险', async () => {
    const setup = await detectTechStack(
      fs({ 'setup.py': 'from setuptools import setup\nsetup(name="legacy")\n# unittest flake8 pyright\n' }),
      '',
    )
    expect(setup.commands.test).toBe('python -m unittest discover -v')
    expect(setup.commands.lint).toBe('flake8')
    expect(setup.commands.typecheck).toBe('pyright')
    expect(setup.name).toBe('未知项目')

    const requirementsOnly = await detectTechStack(
      fs({ 'svc/requirements.txt': 'fastapi\npytest\n' }),
      'svc',
    )
    expect(requirementsOnly.name).toBe('svc')
    expect(requirementsOnly.stackFacts.map((factItem) => factItem.text).join('\n')).toContain('Web 框架：fastapi')

    // setup.py 存在但内容为空：没有测试框架与构建文件 -> 风险
    const emptySetup = await detectTechStack(fs({ 'setup.py': '' }), '')
    expect(emptySetup.commands.test).toBe('none')
    expect(emptySetup.risks.join('\n')).toContain('缺少自动化测试')
    expect(emptySetup.risks.join('\n')).toContain('pyproject.toml / setup.py')
  })
})

describe('detect/stack — Go / Rust', () => {
  it('go.mod 模块名与版本；缺失时仍有基础事实', async () => {
    const stack = await detectTechStack(
      fs({ 'go.mod': 'module example.com/order\ngo 1.22\n', 'internal/x.go': 'x', 'src/y.go': 'y' }),
      '',
    )
    expect(stack.kind).toBe('go')
    expect(stack.commands.test).toBe('go test -json ./...')
    expect(stack.stackFacts.map((factItem) => factItem.text).join('\n')).toContain('example.com/order')
    expect(stack.stackFacts.map((factItem) => factItem.text).join('\n')).toContain('Go 1.22')
    expect(stack.modules.map((module) => module.path)).toEqual(['internal'])

    const bare = await detectTechStack(fs({ 'gosvc/go.mod': '' }), 'gosvc')
    expect(bare.name).toBe('gosvc')
    expect(bare.stackFacts[0]?.text).toContain('Go 项目')
  })

  it('Cargo.toml 的 name / edition 与缺失回退', async () => {
    const stack = await detectTechStack(
      fs({ 'Cargo.toml': '[package]\nname = "orders"\nedition = "2021"\n', 'cmd/main.rs': 'x' }),
      '',
    )
    expect(stack.kind).toBe('rust')
    expect(stack.name).toBe('orders')
    expect(stack.commands).toMatchObject({ test: 'cargo test', lint: 'cargo clippy --all-targets', typecheck: 'cargo check' })
    expect(stack.stackFacts[0]?.text).toContain('edition 2021')

    const bare = await detectTechStack(fs({ 'rs/Cargo.toml': '[package]\n' }), 'rs')
    expect(bare.name).toBe('rs')
    expect(bare.stackFacts[0]?.text).not.toContain('edition')
  })
})

describe('detect/stack — unknown 与渲染', () => {
  it('探测不出技术栈时返回 unknown，带 README 模块与风险', async () => {
    const stack = await detectTechStack(
      fs({ 'README.md': '- docs: 文档\n', 'docs/a.md': 'x', 'random.txt': 'x' }),
      '',
    )
    expect(stack.kind).toBe('unknown')
    expect(stack.name).toBe('未知项目')
    expect(stack.modules.map((module) => module.path)).toEqual(['docs'])
    expect(stack.risks.join('\n')).toContain('未识别技术栈')
  })

  it('renderProjectDocDraft 覆盖空栈 / 空模块 / 空命令 / 空读取记录与假设状态', () => {
    const citation: CitationRef = { file: 'pom.xml', startLine: 1, endLine: 1, quote: '<project>' }
    const confirmed: DetectedStack = {
      kind: 'maven',
      name: '',
      stackFacts: [{ text: 'Maven 项目', citations: [citation], status: 'confirmed' }],
      commands: {},
      modules: [{ path: 'api', responsibility: '' }],
      readFiles: ['pom.xml'],
      risks: [],
    }
    const draft = renderProjectDocDraft(confirmed, NOW)
    expect(draft).toContain('# 项目上下文：未知项目')
    expect(draft).toContain('来源：pom.xml:1-1')
    expect(draft).toContain('（已确认）')
    expect(draft).toContain('| api | 待确认 |')
    expect(draft).toContain('| test | none |')
    expect(draft).toContain('- `pom.xml`')
    expect(draft).not.toContain('## 风险提示')

    const empty: DetectedStack = {
      kind: 'unknown',
      name: '空项目',
      stackFacts: [{ text: '推导事实', citations: [], status: 'derived' }, { text: '假设事实', citations: [], status: 'assumption' }],
      commands: { test: 'none', build: 'make' },
      modules: [],
      readFiles: [],
      risks: ['未识别技术栈'],
    }
    const emptyDraft = renderProjectDocDraft(empty, NOW)
    expect(emptyDraft).toContain('| 待确认 | 待负责人补充模块划分 |')
    expect(emptyDraft).toContain('| test | none |')
    expect(emptyDraft).toContain('| build | make |')
    expect(emptyDraft).toContain('- 无（未读到任何构建或说明文件）')
    expect(emptyDraft).toContain('## 风险提示')
    expect(emptyDraft).toContain('（代码推导）')
    expect(emptyDraft).toContain('（假设）')

    // 无 facts 的未知栈：技术栈与描述两处都写"未识别"
    const noFacts: DetectedStack = { ...empty, stackFacts: [], risks: [] }
    const noFactsDraft = renderProjectDocDraft(noFacts, NOW)
    expect(noFactsDraft).toContain('- 待确认：未识别技术栈，请负责人补充')
    expect(noFactsDraft).toContain('- 未识别技术栈（待确认）')
  })
})
