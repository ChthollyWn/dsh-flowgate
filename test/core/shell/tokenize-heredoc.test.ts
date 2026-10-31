/**
 * Tokenizer edge-case tests (shell/tokenize.ts): heredoc stripping, quote
 * escapes, command substitution / backticks, subshells and comments.
 *
 * These are the shapes the guard must never mis-parse (a hidden `rm -rf /`
 * inside `$(...)` or a quoted heredoc marker), so each case asserts the parsed
 * segments via the public parser API.
 */
import { describe, expect, it } from 'vitest'
import { parseCommandLine, parseCommands, tokenizeShell } from '../../../src/core/shell/tokenize'

function names(command: string): string[] {
  return parseCommandLine(command).map((segment) => segment.name)
}

describe('shell/tokenize — heredoc 剥离', () => {
  it('剥离普通 heredoc 体，标记词支持引号 / 反斜杠 / - 前缀', () => {
    // 反斜杠转义的标记词（findHeredocMarkers 的非引号分支）
    expect(names('cat <<E\\F\nbody\nEF')).toEqual(['cat'])
    expect(names("cat <<'EOF'\nbody\nEOF")).toEqual(['cat'])
    expect(names('cat <<-EOF\n\tbody\n\tEOF')).toEqual(['cat'])
    expect(names('cat << "E F"\nbody\nE F')).toEqual(['cat'])
    // here-string 不是 heredoc：内容会变成普通参数
    expect(parseCommands('cat <<< "hi"')[0]).toMatchObject({ name: 'cat', args: ['hi'] })
  })

  it('heredoc 操作符出现在引号 / 转义附近时不破坏 token', () => {
    // removeHeredocOperators：双引号内转义、引号闭合
    expect(parseCommands('cat "x\\"y" <<EOF\nbody\nEOF')[0]).toMatchObject({
      name: 'cat',
      args: ['x"y'],
    })
    // removeHeredocOperators：引号外的反斜杠转义
    expect(parseCommands('cat a\\ b <<EOF\nbody\nEOF')[0]).toMatchObject({
      name: 'cat',
      args: ['a b'],
    })
    // removeHeredocOperators：标记词里的反斜杠
    expect(names('cat <<E\\OF\nbody\nEOF')).toEqual(['cat'])
  })
})

describe('shell/tokenize — 引号与转义', () => {
  it('单引号未闭合时把剩余内容当作 token', () => {
    expect(tokenizeShell("echo 'abc")).toEqual(['echo', 'abc'])
  })

  it('双引号内的续行、特殊转义与其它反斜杠', () => {
    // 反斜杠 + 换行 = 续行，直接丢弃
    expect(tokenizeShell('echo "a\\\nb"')).toEqual(['echo', 'ab'])
    // \\ " $ ` 被去转义
    expect(tokenizeShell('echo "a\\\\b"')).toEqual(['echo', 'a\\b'])
    // 其它字符保留反斜杠本身
    expect(tokenizeShell('echo "a\\xb"')).toEqual(['echo', 'a\\xb'])
  })

  it('双引号内的反引号替换被解析成单独的 segment', () => {
    const segments = parseCommandLine('echo "`rm -rf /`"')
    expect(segments.map((segment) => segment.name)).toEqual(['rm', 'echo'])
    expect(segments[0]?.separator).toBe('backtick')
  })
})

describe('shell/tokenize — 命令替换与子 shell', () => {
  it('$( ) 内的引号、转义、嵌套括号都被正确处理', () => {
    expect(parseCommands('echo $(echo "x y")').map((command) => command.name)).toEqual(['echo', 'echo'])
    expect(parseCommands("echo $('a b')").map((command) => command.name)).toEqual(['a b', 'echo'])
    expect(parseCommands('echo $(echo a\\ b)').map((command) => command.name)).toEqual(['echo', 'echo'])
    expect(parseCommands('echo $( (rm -rf /) )').map((command) => command.name)).toContain('rm')
    // 未闭合的 $( 也会解析出内部命令（fail-safe：宁可多匹配）
    expect(parseCommands('echo $(rm -rf /').map((command) => command.name)).toContain('rm')
  })

  it('空替换不产生 segment；反引号转义与未闭合同样处理', () => {
    expect(parseCommandLine('echo $()').map((segment) => segment.name)).toEqual(['echo'])
    expect(parseCommandLine('echo ``').map((segment) => segment.name)).toEqual(['echo'])
    expect(parseCommands('echo `echo a\\ b`').map((command) => command.name)).toEqual(['echo', 'echo'])
    expect(parseCommands('echo `rm -rf /`').map((command) => command.name)).toContain('rm')
    expect(parseCommands('echo `rm -rf /').map((command) => command.name)).toContain('rm')
  })

  it('括号子 shell 支持引号、转义与嵌套', () => {
    expect(parseCommandLine('(echo "a b")')[0]).toMatchObject({ name: 'echo', args: ['a b'] })
    expect(parseCommandLine("(echo 'a b')")[0]).toMatchObject({ name: 'echo', args: ['a b'] })
    expect(parseCommandLine('(echo \\(x\\))')[0]).toMatchObject({ name: 'echo', args: ['(x)'] })
    expect(parseCommandLine('((echo x))')[0]).toMatchObject({ name: 'echo' })
    // 未闭合括号也解析出内部命令
    expect(parseCommandLine('(echo x').map((segment) => segment.name)).toEqual(['echo'])
  })
})

describe('shell/tokenize — segment 结构与注释', () => {
  it('只有重定向的 segment 名称为空但仍保留 redirects', () => {
    const [segment] = parseCommandLine('> out.log')
    expect(segment).toMatchObject({ name: '', redirects: ['out.log'] })
    // 重定向后紧跟分隔符：pending redirect 被丢弃，不产生空 segment
    expect(names('echo a >; ls')).toEqual(['echo', 'ls'])
  })

  it('行尾孤立反斜杠不产生额外 token', () => {
    expect(tokenizeShell('echo a\\')).toEqual(['echo', 'a'])
  })

  it('# 注释只在命令位置生效，并支持行尾与整行注释', () => {
    expect(parseCommandLine('# full comment')).toEqual([])
    expect(names('ls # comment')).toEqual(['ls'])
    expect(names('ls # c\nrm x')).toEqual(['ls', 'rm'])
    expect(names('a; # c')).toEqual(['a'])
  })

  it('fd 复制（2>&1）不当作写目标，后续重定向仍被记录', () => {
    const [segment] = parseCommandLine('echo x 2>&1 > out.log')
    expect(segment).toMatchObject({ name: 'echo', args: ['x'], redirects: ['out.log'] })
    // 后台执行标记
    expect(parseCommandLine('pnpm test &')[0]).toMatchObject({ name: 'pnpm', background: true })
  })
})
