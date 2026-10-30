import { describe, expect, it } from 'vitest'
import { detectTechStack, renderProjectDocDraft } from '../../../src/core/detect/stack'
import { parseProjectDoc } from '../../../src/core/artifacts/parse'
import { MemoryFileSystem } from '../../../src/core/util/memory-fs'

const NOW = '2026-11-12T10:31:05+08:00'

function fs(seed: Record<string, string>): MemoryFileSystem {
  return new MemoryFileSystem(seed)
}

describe('detectTechStack — Maven', () => {
  const pom = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.5</version>
  </parent>
  <groupId>com.acme</groupId>
  <artifactId>member-service</artifactId>
  <properties>
    <java.version>17</java.version>
  </properties>
  <modules>
    <module>member-api</module>
    <module>member-web</module>
  </modules>
  <build>
    <plugins>
      <plugin>
        <artifactId>spring-boot-maven-plugin</artifactId>
      </plugin>
      <plugin>
        <artifactId>spotless-maven-plugin</artifactId>
      </plugin>
    </plugins>
  </build>
</project>
`
  it('识别 Maven + Spring Boot + Java 版本，使用 mvnw', async () => {
    const stack = await detectTechStack(fs({ 'pom.xml': pom, mvnw: '#!/bin/sh\n' }), '')
    expect(stack.kind).toBe('maven')
    expect(stack.name).toBe('member-service')
    expect(stack.commands.test).toBe('./mvnw -B test')
    expect(stack.commands.lint).toBe('./mvnw -q spotless:check')
    expect(stack.commands.run).toBe('./mvnw -q spring-boot:run')
    expect(stack.commands.integration).toBe('./mvnw -B verify')
    const texts = stack.stackFacts.map((fact) => fact.text).join('\n')
    expect(texts).toContain('Spring Boot 3.2.5')
    expect(texts).toContain('Java 17')
    expect(stack.stackFacts.every((fact) => fact.citations.length > 0)).toBe(true)
    expect(stack.readFiles).toEqual(expect.arrayContaining(['pom.xml', 'mvnw']))
    expect(stack.modules.map((module) => module.path)).toEqual(['member-api', 'member-web'])
  })

  it('没有 mvnw 时退回系统 mvn，并给出风险', async () => {
    const stack = await detectTechStack(fs({ 'pom.xml': pom }), '')
    expect(stack.commands.test).toBe('mvn -B test')
    expect(stack.risks.join('\n')).toContain('Maven Wrapper')
  })
})

describe('detectTechStack — Gradle', () => {
  it('识别 gradlew test --rerun-tasks 与 spotlessCheck', async () => {
    const stack = await detectTechStack(
      fs({
        'build.gradle': `plugins { id 'java'; id 'org.springframework.boot' version '3.2.0' }\nsourceCompatibility = '17'\napply plugin: 'spotless'\n`,
        'settings.gradle': `rootProject.name = 'member'\ninclude ':member-api'\n`,
        gradlew: '#!/bin/sh\n',
      }),
      '',
    )
    expect(stack.kind).toBe('gradle')
    expect(stack.commands.test).toBe('./gradlew test --rerun-tasks')
    expect(stack.commands.lint).toBe('./gradlew spotlessCheck')
    expect(stack.commands.run).toBe('./gradlew bootRun')
    expect(stack.modules.map((module) => module.path)).toContain('member-api')
  })
})

describe('detectTechStack — Node.js', () => {
  const pkg = JSON.stringify({
    name: 'member-web',
    version: '1.2.0',
    scripts: { test: 'vitest run', build: 'vite build' },
    devDependencies: { vitest: '^2.0.0', eslint: '^9.0.0', typescript: '^5.0.0' },
  })

  it('识别 pnpm + vitest + eslint + tsc', async () => {
    const stack = await detectTechStack(
      fs({ 'package.json': pkg, 'pnpm-lock.yaml': 'lockfileVersion: 9\n', 'tsconfig.json': '{}' }),
      '',
    )
    expect(stack.kind).toBe('node')
    expect(stack.name).toBe('member-web')
    expect(stack.commands.test).toBe('pnpm test')
    expect(stack.commands.build).toBe('pnpm build')
    expect(stack.commands.lint).toBe('pnpm exec eslint .')
    expect(stack.commands.typecheck).toBe('pnpm exec tsc --noEmit')
    expect(stack.stackFacts.map((fact) => fact.text).join('\n')).toContain('pnpm')
    expect(stack.readFiles).toContain('package.json')
  })

  it('无测试脚本和测试框架时 test: none 并登记风险', async () => {
    const stack = await detectTechStack(
      fs({ 'package.json': JSON.stringify({ name: 'plain', scripts: { build: 'vite build' } }) }),
      '',
    )
    expect(stack.commands.test).toBe('none')
    expect(stack.risks.join('\n')).toContain('缺少自动化测试')
  })

  it('npm 项目使用 npx 执行 vitest', async () => {
    const stack = await detectTechStack(
      fs({
        'package.json': JSON.stringify({ name: 'npm-app', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^2.0.0' } }),
        'package-lock.json': '{}',
      }),
      '',
    )
    expect(stack.commands.test).toBe('npm test')
    expect(stack.commands.lint).toBeUndefined()
  })
})

describe('detectTechStack — Python / Go / Rust / unknown', () => {
  it('识别 pytest + ruff + python -m build', async () => {
    const pyproject = `[project]\nname = "member-api"\nrequires-python = ">=3.11"\n[build-system]\nrequires = ["setuptools"]\n[tool.pytest.ini_options]\n`
    const stack = await detectTechStack(fs({ 'pyproject.toml': pyproject, 'requirements.txt': 'pytest\nruff\n', 'src/__init__.py': '' }), '')
    expect(stack.kind).toBe('python')
    expect(stack.name).toBe('member-api')
    expect(stack.commands.test).toBe('pytest -q')
    expect(stack.commands.lint).toBe('ruff check .')
    expect(stack.commands.build).toBe('python -m build')
    expect(stack.stackFacts.map((fact) => fact.text).join('\n')).toContain('Python')
  })

  it('识别 Go 的 go test -json', async () => {
    const stack = await detectTechStack(fs({ 'go.mod': 'module example.com/member\n\ngo 1.22\n' }), '')
    expect(stack.kind).toBe('go')
    expect(stack.commands.test).toBe('go test -json ./...')
    expect(stack.commands.build).toBe('go build ./...')
    expect(stack.commands.lint).toBe('go vet ./...')
    expect(stack.stackFacts.map((fact) => fact.text).join('\n')).toContain('Go 1.22')
  })

  it('识别 Rust 的 cargo test', async () => {
    const stack = await detectTechStack(fs({ 'Cargo.toml': '[package]\nname = "member"\nedition = "2021"\n' }), '')
    expect(stack.kind).toBe('rust')
    expect(stack.commands.test).toBe('cargo test')
    expect(stack.commands.build).toBe('cargo build')
    expect(stack.commands.lint).toContain('cargo clippy')
  })

  it('探测不到技术栈时返回 unknown 并要求负责人填写', async () => {
    const stack = await detectTechStack(fs({ 'README.md': '# 项目\n- src: 源码\n', 'src/index.ts': 'export {}\n' }), '')
    expect(stack.kind).toBe('unknown')
    expect(stack.commands.test).toBeUndefined()
    expect(stack.risks.join('\n')).toContain('未识别技术栈')
    expect(stack.modules.map((module) => module.path)).toContain('src')
  })
})

describe('renderProjectDocDraft', () => {
  it('生成的 project.md 可被 parseProjectDoc 读回（round-trip）', async () => {
    const stack = await detectTechStack(
      fs({
        'pom.xml': `<project><artifactId>member</artifactId><properties><java.version>21</java.version></properties><modules><module>member-api</module></modules></project>`,
        mvnw: '#!/bin/sh\n',
        'README.md': '# member\n- member-api: 会员接口\n',
      }),
      '',
    )
    const draft = renderProjectDocDraft(stack, NOW)
    expect(draft).toContain(`# 项目上下文：${stack.name}`)
    expect(draft).toContain('已确认')
    expect(draft).toContain('## 命令')
    expect(draft).toContain('./mvnw -B test')
    const parsed = parseProjectDoc(draft)
    expect(parsed.name).toBe(stack.name)
    expect(parsed.commands.test).toBe('./mvnw -B test')
    expect(parsed.readFiles).toEqual(expect.arrayContaining(['pom.xml', 'mvnw']))
    expect(parsed.stack.length).toBeGreaterThan(0)
    expect(parsed.modules.map((module) => module.path)).toContain('member-api')
  })

  it('unknown 技术栈草稿包含待确认提示', async () => {
    const stack = await detectTechStack(fs({}), '')
    const draft = renderProjectDocDraft(stack, NOW)
    expect(draft).toContain('待确认')
    expect(parseProjectDoc(draft).commands.test).toBe('none')
  })
})
