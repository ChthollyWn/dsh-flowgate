import { describe, expect, it } from 'vitest'
import {
  commandNames,
  firstCommandName,
  parseCommandLine,
  parseCommands,
  tokenizeShell,
} from '../../../src/core/shell/tokenize'

describe('shell/tokenize — tokenizeShell（引号与转义）', () => {
  it('splits words and strips quotes', () => {
    expect(tokenizeShell('echo "hello world"')).toEqual(['echo', 'hello world'])
    expect(tokenizeShell("echo 'a b'")).toEqual(['echo', 'a b'])
    expect(tokenizeShell('echo a\\ b')).toEqual(['echo', 'a b'])
    expect(tokenizeShell('  ls   -la  ')).toEqual(['ls', '-la'])
    expect(tokenizeShell('')).toEqual([])
  })

  it('keeps quoted operators literal (no false splitting)', () => {
    expect(tokenizeShell('echo "a && b; c | d"')).toEqual(['echo', 'a && b; c | d'])
    expect(tokenizeShell('echo "=> x"')).toEqual(['echo', '=> x'])
    expect(tokenizeShell('node -e "const f = x => x * 2"')).toEqual(['node', '-e', 'const f = x => x * 2'])
  })

  it('keeps redirect targets and resolves double-quote escapes', () => {
    expect(tokenizeShell('echo "a \\"b\\""')).toEqual(['echo', 'a "b"'])
    expect(tokenizeShell('echo x > out.log')).toEqual(['echo', 'x', 'out.log'])
  })
})

describe('shell/tokenize — parseCommands（命令切分）', () => {
  it('splits on && || ; and |', () => {
    const commands = parseCommandLine('a && b || c; d | e')
    expect(commands.map((command) => command.name)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(commands.map((command) => command.separator)).toEqual(['start', '&&', '||', ';', '|'])
    expect(commandNames('a && b || c; d | e')).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('parses args, raw text and output redirects', () => {
    const [command] = parseCommands('  echo x > out.log  ')
    expect(command).toMatchObject({
      name: 'echo',
      args: ['x'],
      raw: 'echo x > out.log',
      redirects: ['out.log'],
      background: false,
    })
    expect(parseCommands('echo x >> a.log')[0]!.redirects).toEqual(['a.log'])
    expect(parseCommands('cmd 2> err.log')[0]!.redirects).toEqual(['err.log'])
    // fd duplication is not a path
    expect(parseCommands('cmd >&2')[0]!.redirects).toEqual([])
    expect(parseCommands('cmd 2>&1')[0]!.redirects).toEqual([])
    expect(parseCommands('cat < in.txt')[0]!.redirects).toEqual([])
  })

  it('records background execution and keeps quoted text on one command', () => {
    expect(parseCommands('sleep 1 &')[0]).toMatchObject({ name: 'sleep', background: true })
    const quoted = parseCommands('echo "a;b && c | d"')
    expect(quoted).toHaveLength(1)
    expect(quoted[0]!.args).toEqual(['a;b && c | d'])
    // escaped separator is part of the word
    expect(parseCommands('echo a\\;b')).toHaveLength(1)
    expect(parseCommands('echo a\\;b')[0]!.args).toEqual(['a;b'])
    // redirect char inside quotes is not an operator
    expect(parseCommands('echo "a > b"')[0]!.redirects).toEqual([])
    expect(parseCommands('echo "a > b"')[0]!.args).toEqual(['a > b'])
  })

  it('surfaces subshells and command substitutions as their own commands', () => {
    expect(parseCommands('(cd /tmp && rm -rf x)').map((command) => command.name)).toEqual(['cd', 'rm'])
    expect(commandNames('echo $(git push origin main)').sort()).toEqual(['echo', 'git'])
    expect(commandNames('echo `git push`').sort()).toEqual(['echo', 'git'])
    const segments = parseCommandLine('echo $(git push)')
    expect(segments.some((segment) => segment.separator === 'subshell')).toBe(true)
    // command substitution inside double quotes is still scanned
    expect(commandNames('echo "prefix $(git push)"').sort()).toEqual(['echo', 'git'])
  })

  it('never treats heredoc bodies as commands', () => {
    expect(commandNames('cat <<EOF\nrm -rf /\nEOF')).toEqual(['cat'])
    expect(commandNames("cat <<'EOF'\nrm -rf /\n&& echo nope\nEOF")).toEqual(['cat'])
    expect(commandNames('cat <<-EOF\n\trm -rf /\n\tEOF')).toEqual(['cat'])
    // commands after the heredoc terminator are parsed again
    expect(commandNames('cat <<EOF\nbody\nEOF\necho ok')).toEqual(['cat', 'echo'])
    // none of the heredoc content leaks into write targets or args
    expect(parseCommands('cat <<EOF > out.log\nrm -rf /\nEOF')[0]).toMatchObject({
      name: 'cat',
      redirects: ['out.log'],
    })
  })

  it('handles here-strings as a plain argument', () => {
    const [command] = parseCommands('wc -l <<< "a b"')
    expect(command!.name).toBe('wc')
    expect(command!.args).toEqual(['-l', 'a b'])
    expect(command!.redirects).toEqual([])
  })

  it('returns command names and the first command name', () => {
    expect(commandNames('')).toEqual([])
    expect(firstCommandName('')).toBeNull()
    expect(firstCommandName('pnpm vitest run')).toBe('pnpm')
    expect(firstCommandName('git -C ../repo push origin main')).toBe('git')
  })

  it('tolerates an unterminated quote', () => {
    expect(parseCommands('echo "abc')).toHaveLength(1)
    expect(parseCommands('echo "abc')[0]!.args).toEqual(['abc'])
  })
})
