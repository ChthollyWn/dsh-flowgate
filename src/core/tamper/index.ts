/**
 * 篡改检测（T3.5 / 03 §6.9）：识别「让测试/门禁失效」的改动。
 *
 * 纯函数、无 IO：由宿主在事后检测拿到 `git diff` 文本后调用。检测三类信号：
 * 1. 跳过测试：给测试加 `@Disabled` / `.skip(` / `.todo(` / `pytest.mark.skip` 等；
 * 2. 删减断言：测试文件里被删掉的行包含断言 API；
 * 3. 改测试基础设施：CI、lint、覆盖率、测试运行器配置被改动（风险信号，交负责人复核）。
 *
 * 信号进入待处理项（TM-n）和 G6 清单，并作为审查子 agent 的输入；不直接判定失败，
 * 避免把合法的测试重构误杀。
 */

export type TamperSignalKind =
  | 'skipped-test'
  | 'removed-assertion'
  | 'removed-test-file'
  | 'modified-test-config'
  | 'modified-ci'
  | 'modified-lint-config'
  | 'modified-coverage-config'

export interface TamperSignal {
  kind: TamperSignalKind
  path: string
  detail: string
}

/** 判断一个仓库相对路径是否属于「测试基础设施」并给出类别。 */
export function classifyTamperPath(path: string): TamperSignalKind | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
  const base = normalized.split('/').pop() ?? normalized
  const lower = base.toLowerCase()
  if (
    /^\.github\/workflows\//.test(normalized) ||
    /^(\.gitlab-ci\.yml|\.circleci\/config\.yml|Jenkinsfile|azure-pipelines\.yml|\.travis\.yml)$/i.test(normalized) ||
    lower === '.gitlab-ci.yml' ||
    lower === 'jenkinsfile'
  ) {
    return 'modified-ci'
  }
  if (
    /^(eslint\.config\.(js|mjs|cjs|ts)|\.eslintrc(\.(js|json|yml|yaml))?|biome\.json|\.oxlintrc\.json|ruff\.toml|\.pylintrc|checkstyle.*\.xml|\.golangci\.(yml|yaml)|\.clang-tidy|tslint\.json)$/i.test(
      lower,
    )
  ) {
    return 'modified-lint-config'
  }
  if (
    /^coverage\//i.test(normalized) ||
    /(^coverage$|^\.nycrc(\.(json|yml|yaml))?$|^codecov\.(yml|yaml)$|^\.coveragerc$|^vitest\.config\.|^jest\.config\.|^\.c8rc|^karma\.conf\.)/i.test(
      lower,
    )
  ) {
    return 'modified-coverage-config'
  }
  if (/^(pytest\.ini|tox\.ini|conftest\.py|phpunit\.xml.*|\.mocharc.*|playwright\.config\.|cypress\.config\.)/i.test(lower)) {
    return 'modified-test-config'
  }
  return null
}

/** 路径看起来像测试文件（用于只在测试文件里统计「删断言」）。 */
export function isTestFilePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
  const base = normalized.split('/').pop() ?? normalized
  return (
    /(^|\/)(__tests__|tests?|spec)\//.test(normalized) ||
    /\.(test|spec)\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(base) ||
    /(^|_)(test|spec)\.(py)$/i.test(base) ||
    /_test\.(go|py)$/i.test(base) ||
    /(Test|Tests|IT)\.(java|kt|scala)$/.test(base)
  )
}

const SKIP_PATTERNS: RegExp[] = [
  /@Disabled\b/,
  /@Ignore\b/,
  /\[Ignore\]/,
  /#\[ignore\]/,
  /\.(skip|todo|failing|concurrent\.skip)\s*\(/,
  /\b(xit|xtest|xdescribe)\s*\(/,
  /\bpytest\.mark\.(skip|xfail)\b/,
  /\bunittest\.skip\b/,
  /\bt\.Skip(f|Now)?\s*\(/,
  /\bSkipIf\b/,
  /<!--\s*skip\s*-->/i,
]

const ASSERTION_PATTERNS: RegExp[] = [
  /\bexpect(\.|\s*\()/,
  /\bassert[A-Za-z_]*\s*\(/,
  /\bAssert(ions)?\.\w+\s*\(/,
  /\bself\.assert\w+\s*\(/,
  /\bshould\b/,
  /\bt\.(Error|Fatal|Fatalf|Fail)\s*\(/,
  /\brequire\.\w+\s*\(/,
]

function matchesAny(patterns: RegExp[], line: string): boolean {
  return patterns.some((pattern) => pattern.test(line))
}

interface ParsedHunk {
  path: string
  added: string[]
  removed: string[]
  deleted: boolean
}

/** 把 unified diff 拆成「文件 → 新增/删除行」。 */
export function parseDiffByFile(diffText: string): ParsedHunk[] {
  const files: ParsedHunk[] = []
  let current: ParsedHunk | null = null
  for (const rawLine of diffText.split('\n')) {
    if (rawLine.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(rawLine)
      current = { path: (match?.[2] ?? match?.[1] ?? '').trim(), added: [], removed: [], deleted: false }
      files.push(current)
      continue
    }
    if (!current) continue
    if (rawLine.startsWith('deleted file mode')) {
      current.deleted = true
      continue
    }
    if (rawLine.startsWith('+++') || rawLine.startsWith('---') || rawLine.startsWith('@@') || rawLine.startsWith('index ')) continue
    if (rawLine.startsWith('+')) current.added.push(rawLine.slice(1))
    else if (rawLine.startsWith('-')) current.removed.push(rawLine.slice(1))
  }
  return files.filter((file) => file.path !== '')
}

/**
 * 从 diff 文本与改动路径集合中提取篡改信号（去重，顺序稳定）。
 *
 * @param diffText `git diff` 文本；为空时只能做路径级检测
 * @param changedPaths 本次改动涉及的仓库相对路径（用于检测配置/CI 改动）
 */
export function collectTamperSignals(diffText: string, changedPaths: string[] = []): TamperSignal[] {
  const signals: TamperSignal[] = []
  const seen = new Set<string>()
  const push = (signal: TamperSignal): void => {
    const key = `${signal.kind}\u0000${signal.path}`
    if (seen.has(key)) return
    seen.add(key)
    signals.push(signal)
  }

  for (const path of changedPaths) {
    const kind = classifyTamperPath(path)
    if (kind) push({ kind, path, detail: `测试基础设施文件被修改：${path}` })
  }

  for (const file of parseDiffByFile(diffText)) {
    const pathKind = classifyTamperPath(file.path)
    if (pathKind) push({ kind: pathKind, path: file.path, detail: `测试基础设施文件被修改：${file.path}` })
    if (file.deleted && isTestFilePath(file.path)) {
      push({ kind: 'removed-test-file', path: file.path, detail: `测试文件被删除：${file.path}` })
      continue
    }
    if (!isTestFilePath(file.path)) continue
    for (const line of file.added) {
      if (matchesAny(SKIP_PATTERNS, line)) {
        push({ kind: 'skipped-test', path: file.path, detail: `新增跳过测试：${line.trim().slice(0, 120)}` })
      }
    }
    for (const line of file.removed) {
      if (matchesAny(ASSERTION_PATTERNS, line)) {
        push({ kind: 'removed-assertion', path: file.path, detail: `删除断言：${line.trim().slice(0, 120)}` })
      }
    }
  }
  return signals
}

/** 是否有任何信号（宿主用于快速判断是否需要建待处理项）。 */
export function hasTamperSignals(signals: TamperSignal[]): boolean {
  return signals.length > 0
}
