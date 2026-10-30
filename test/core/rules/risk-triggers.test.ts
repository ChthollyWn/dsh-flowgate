import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DEPENDENCY_FILES,
  DEFAULT_SENSITIVE_PATHS,
  HOTSPOT_PATTERNS,
  dependencyFilePatterns,
  isHotspot,
  matchRiskTriggers,
  sensitivePathPatterns,
} from '../../../src/core/rules/risk-triggers'
import { makeTaskState } from '../state/fixtures'
import { evalInput, makeChange, makeConfig } from './fixtures'

function triggers(action: Parameters<typeof evalInput>[0], options: Parameters<typeof evalInput>[1] = {}) {
  return matchRiskTriggers(evalInput(action, options))
}

describe('rules/risk-triggers — 内置触发器清单（03 §8.2）', () => {
  it('exports the documented sensitive paths and dependency files', () => {
    for (const pattern of ['**/auth/**', '**/payment*/**', '**/migration*/**', '**/*.sql', '.github/workflows/**']) {
      expect(DEFAULT_SENSITIVE_PATHS).toContain(pattern)
    }
    for (const file of ['package.json', 'pom.xml', 'requirements*.txt', 'go.mod', 'Cargo.toml']) {
      expect(DEFAULT_DEPENDENCY_FILES).toContain(file)
    }
    expect(HOTSPOT_PATTERNS).toEqual(expect.arrayContaining(['**/routes/**', '**/types/**', '**/locales/**', 'CHANGELOG*']))
  })

  it('isHotspot recognises dependency, routing, shared-type and i18n files', () => {
    const config = makeConfig()
    for (const path of ['package.json', 'pom.xml', 'src/routes/index.ts', 'src/types/api.ts', 'src/locales/zh.json', 'CHANGELOG.md']) {
      expect(isHotspot(path, config), path).toBe(true)
    }
    for (const path of ['src/main/java/com/acme/renewal/RenewalService.java', 'docs/usage.md']) {
      expect(isHotspot(path, config), path).toBe(false)
    }
  })

  it('lets config extend sensitive paths, dependency files and hotspots', () => {
    const base = makeConfig()
    const config = makeConfig({
      triggers: { ...base.triggers, sensitive_paths_extra: ['src/main/java/**/billing/**'], dependency_files: ['deps.yaml'] },
      parallel: { ...base.parallel, hotspots_extra: ['src/main/resources/application*.yml'] },
    })
    expect(sensitivePathPatterns(config)).toContain('src/main/java/**/billing/**')
    expect(dependencyFilePatterns(config)).toContain('deps.yaml')
    expect(isHotspot('src/main/resources/application-prod.yml', config)).toBe(true)
    expect(triggers({ kind: 'write', tool: 'write', path: 'src/main/java/com/acme/billing/Invoice.java' }, { config, stage: 'S4' })).toHaveLength(1)
  })
})

describe('rules/risk-triggers — 命中判定', () => {
  it('sensitive path write -> human', () => {
    const hits = triggers(
      { kind: 'write', tool: 'write', path: 'src/main/java/com/acme/payment/RenewalCallback.java' },
      { stage: 'S4' },
    )
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ trigger: 'sensitive-path', decision: 'human', title: '敏感路径修改' })
    expect(hits[0]!.detail).toContain('payment')
  })

  it('sensitive path reached through a shell redirect -> human', () => {
    const hits = triggers(
      { kind: 'shell', tool: 'bash', command: 'echo x >> src/main/java/com/acme/auth/Login.java' },
      { stage: 'S4' },
    )
    expect(hits.map((hit) => hit.trigger)).toContain('sensitive-path')
  })

  it('dependency manifest write -> human', () => {
    const hits = triggers({ kind: 'write', tool: 'write', path: 'pom.xml' }, { stage: 'S4' })
    expect(hits[0]).toMatchObject({ trigger: 'dependency-change', decision: 'human' })
  })

  it('dependency commands -> human', () => {
    for (const command of ['npm install express', 'pnpm add zod', 'go get github.com/x/y', 'poetry add requests']) {
      const hits = triggers({ kind: 'shell', tool: 'bash', command }, { stage: 'S4' })
      expect(hits.map((hit) => hit.trigger), command).toContain('dependency-change')
    }
  })

  it('dangerous commands -> human, but push is left to R-PUSH', () => {
    const reset = triggers({ kind: 'shell', tool: 'bash', command: 'git reset --hard HEAD' }, { stage: 'S4' })
    expect(reset[0]).toMatchObject({ trigger: 'dangerous-command', decision: 'human' })
    const clean = triggers({ kind: 'shell', tool: 'bash', command: 'git clean -fdx' }, { stage: 'S4' })
    expect(clean[0]!.trigger).toBe('dangerous-command')
    const forcePush = triggers(
      { kind: 'shell', tool: 'bash', command: 'git push --force origin main' },
      { stage: 'S4' },
    )
    expect(forcePush.map((hit) => hit.trigger)).not.toContain('dangerous-command')
  })

  it('secret content write -> deny (never logs the secret)', () => {
    const hits = triggers(
      {
        kind: 'write',
        tool: 'write',
        path: 'src/config.ts',
        content: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...',
      },
      { stage: 'S4' },
    )
    expect(hits[0]).toMatchObject({ trigger: 'secret-write', decision: 'deny' })
    expect(hits[0]!.detail).toContain('已脱敏')
  })

  it('a secret in a shell command -> deny', () => {
    const hits = triggers(
      {
        kind: 'shell',
        tool: 'bash',
        command: 'echo "ghp_1234567890abcdefghijklmnopqrstuv" > token.txt',
      },
      { stage: 'S4' },
    )
    expect(hits[0]).toMatchObject({ trigger: 'secret-write', decision: 'deny' })
  })

  it('reading .env / private key files -> human', () => {
    for (const path of ['.env', 'config/id_rsa', 'certs/server.pem']) {
      const hits = triggers({ kind: 'read', tool: 'read', path }, { stage: 'S4' })
      expect(hits[0], path).toMatchObject({ trigger: 'secret-read', decision: 'human' })
    }
    expect(triggers({ kind: 'read', tool: 'read', path: '.env.example' }, { stage: 'S4' })).toHaveLength(0)
    expect(triggers({ kind: 'read', tool: 'read', path: 'src/app.ts' }, { stage: 'S4' })).toHaveLength(0)
  })

  it('consecutive verification failures -> human (blocker)', () => {
    const change = makeChange({
      stage: 'S4',
      tasks: {
        T3: makeTaskState({ id: 'T3', failureCount: 3 }),
        T4: makeTaskState({ id: 'T4', failureCount: 1 }),
      },
    })
    const hits = triggers(
      { kind: 'write', tool: 'write', path: 'src/main/java/com/acme/renewal/Impl.java' },
      { change, stage: 'S4' },
    )
    expect(hits.map((hit) => hit.trigger)).toContain('consecutive-failure')
    expect(hits.find((hit) => hit.trigger === 'consecutive-failure')!.detail).toContain('T3')

    const doneChange = makeChange({
      stage: 'S4',
      tasks: { T3: makeTaskState({ id: 'T3', status: 'done', failureCount: 5 }) },
    })
    const doneHits = triggers(
      { kind: 'write', tool: 'write', path: 'src/main/java/com/acme/renewal/Impl.java' },
      { change: doneChange, stage: 'S4' },
    )
    expect(doneHits.map((hit) => hit.trigger)).not.toContain('consecutive-failure')
  })

  it('benign writes in non-sensitive areas produce no trigger', () => {
    expect(
      triggers(
        { kind: 'write', tool: 'write', path: 'src/main/java/com/acme/renewal/RenewalService.java' },
        { stage: 'S4' },
      ),
    ).toEqual([])
  })

  it('never emits fingerprints itself (the rule engine owns action fingerprints)', () => {
    const hits = triggers({ kind: 'write', tool: 'write', path: 'pom.xml' }, { stage: 'S4' })
    expect(hits[0]!.fingerprint).toBeUndefined()
  })
})
