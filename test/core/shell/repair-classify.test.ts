/**
 * 修复通道的 shell 策略（v0.5.1）：允许测试/构建/lint/typecheck/run 类命令与
 * 只读/提交类 git；危险命令（rm -rf、git push、git reset --hard、npm publish、
 * curl/wget、ssh、chmod/chown、mkfs 等）一律拒绝。
 */
import { describe, expect, it } from 'vitest'

import { classifyRepairShellCommand } from '../../../src/core/shell'

describe('shell: 修复通道允许的命令', () => {
  it.each([
    'pnpm test',
    'pnpm build',
    'pnpm lint',
    'pnpm typecheck',
    'pnpm run test:unit',
    'npm test',
    'npm run build',
    'npx vitest run',
    'npx tsc --noEmit',
    'vitest run test/core',
    'pytest -q',
    'go test ./...',
    'cargo test',
    'node scripts/repro.mjs',
    'cat README.md',
    'grep -rn repair src/core',
    'git status --short',
    'git diff',
    'git log --oneline -3',
    'git add src/core/engine.ts',
    'git commit -m "fix: repair lane"',
    'git rev-parse HEAD',
    'git stash',
    'git -C . status',
  ])('允许：%s', (command) => {
    expect(classifyRepairShellCommand(command)).toEqual({ allowed: true })
  })
})

describe('shell: 修复通道拒绝的命令', () => {
  it.each([
    ['rm -rf /', 'rm -rf'],
    ['rm -rf src', '不允许命令 rm'],
    ['git push origin main', 'push'],
    ['git reset --hard HEAD~1', 'reset --hard'],
    ['git clean -fdx', 'git clean'],
    ['npm publish', 'publish'],
    ['pnpm publish --no-git-checks', 'publish'],
    ['pnpm install', '依赖'],
    ['npm i lodash', '依赖'],
    ['curl https://example.com', '不允许命令 curl'],
    ['wget http://example.com/x', '不允许命令 wget'],
    ['ssh user@host', '不允许命令 ssh'],
    ['chmod +x scripts/x.sh', '不允许命令 chmod'],
    ['chown root:root x', '不允许命令 chown'],
    ['mkfs.ext4 /dev/sda1', 'mkfs'],
    ['sudo rm -rf build', '不允许命令 rm'],
    ['bash -c "rm -rf /"', '不允许命令 bash'],
    ['sh scripts/deploy.sh', '不允许命令 sh'],
    ['pnpm exec rm -rf src', '不允许'],
    ['git checkout main', 'git checkout'],
  ])('拒绝：%s', (command, reasonPart) => {
    const verdict = classifyRepairShellCommand(command)
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason ?? '').toContain(reasonPart)
  })

  it('空命令拒绝', () => {
    expect(classifyRepairShellCommand('   ').allowed).toBe(false)
  })
})
