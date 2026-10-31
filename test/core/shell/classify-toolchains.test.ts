/**
 * Table-driven branch tests for shell command classification (shell/classify.ts).
 *
 * The classifier is a pure function over a command string; each row pins one
 * toolchain / wrapper / redirect shape so the corresponding arm is exercised
 * through the public predicates (`isTestCommand`, `isBuildCommand`, ...,
 * `classifyShellCommand`, `validateVerifyCommand`), reusing the same inputs the
 * guard sees.
 */
import { describe, expect, it } from 'vitest'
import {
  classifyShellCommand,
  dangerousCommandReasons,
  extractWriteTargets,
  isBuildCommand,
  isDangerousCommand,
  isDependencyCommand,
  isLintCommand,
  isMutatingCommand,
  isPushCommand,
  isRevertCommand,
  isTestCommand,
  validateVerifyCommand,
} from '../../../src/core/shell/classify'

function expectClass(command: string, cls: string, expected: boolean): void {
  const classes = classifyShellCommand(command)
  expect(classes.includes(cls as never), `${command} -> ${classes.join(',')}`).toBe(expected)
}

describe('shell/classify — 包装命令（wrapper）解包', () => {
  it('sudo / timeout / env / nohup / exec 解包到真实命令', () => {
    // sudo 带取值 flag：-u root 后的命令才是真正命令
    expect(isDangerousCommand('sudo -u root rm -rf /')).toBe(true)
    // timeout 的时长参数被跳过
    expect(isDangerousCommand('timeout 5s rm -rf /')).toBe(true)
    // env 的前置 VAR=value 赋值被跳过
    expect(isDependencyCommand('env FOO=bar pnpm install')).toBe(true)
    // 只剩作业号赋值时解包提前返回
    expect(classifyShellCommand('env FOO=bar')).toEqual(['readonly'])
    expect(isTestCommand('nohup pnpm test')).toBe(true)
    expect(isLintCommand('exec eslint .')).toBe(true)
  })
})

describe('shell/classify — 测试命令识别（各工具链）', () => {
  it('python -m 测试模块、npx 测试入口、包管理器 script 与直连 runner', () => {
    expect(isTestCommand('python -m pytest tests')).toBe(true)
    expect(isTestCommand('python3 -m nose2')).toBe(true)
    expect(isTestCommand('python -m unknown')).toBe(false)
    expect(isTestCommand('python script.py')).toBe(false)
    expect(isTestCommand('npx vitest run')).toBe(true)
    expect(isTestCommand('npx some-bin')).toBe(false)
    expect(isTestCommand('pnpm t')).toBe(true)
    expect(isTestCommand('pnpm run test:unit')).toBe(true)
    // `pnpm run` 缺 script 名：run: 后缀为空，不算测试
    expect(isTestCommand('pnpm run')).toBe(false)
    // 没有非 flag 参数（只有 --silent）时 direct 为空串
    expect(isTestCommand('pnpm --silent')).toBe(false)
    expect(isTestCommand('yarn jest')).toBe(true)
    expect(isTestCommand('mvn -B -q verify')).toBe(true)
    expect(isTestCommand('mvn -Dtest=RenewalTest')).toBe(true)
    expect(isTestCommand('gradle testAll')).toBe(true)
    expect(isTestCommand('gradlew integrationTest')).toBe(true)
    expect(isTestCommand('cargo nextest run')).toBe(true)
    expect(isTestCommand('go test ./...')).toBe(true)
    expect(isTestCommand('dotnet test')).toBe(true)
    expect(isTestCommand('make test-all')).toBe(true)
    expect(isTestCommand('make check')).toBe(true)
  })
})

describe('shell/classify — 构建命令识别', () => {
  it('maven/gradle/vite/next/turbo/nx/cmake/go/cargo/dotnet/make 构建分支', () => {
    expect(isBuildCommand('tsc --noEmit')).toBe(true)
    expect(isBuildCommand('mvn package')).toBe(true)
    expect(isBuildCommand('mvnw compile')).toBe(true)
    expect(isBuildCommand('gradle build')).toBe(true)
    expect(isBuildCommand('gradle assemble')).toBe(true)
    expect(isBuildCommand('vite build')).toBe(true)
    expect(isBuildCommand('vite dev')).toBe(false)
    expect(isBuildCommand('next build')).toBe(true)
    expect(isBuildCommand('turbo build')).toBe(true)
    expect(isBuildCommand('nx build')).toBe(true)
    expect(isBuildCommand('cmake --build .')).toBe(true)
    expect(isBuildCommand('cmake --build')).toBe(true)
    expect(isBuildCommand('cmake .')).toBe(false)
    expect(isBuildCommand('go build ./...')).toBe(true)
    expect(isBuildCommand('cargo build')).toBe(true)
    expect(isBuildCommand('dotnet build')).toBe(true)
    expect(isBuildCommand('dotnet publish')).toBe(true)
    expect(isBuildCommand('make build')).toBe(true)
    expect(isBuildCommand('make all')).toBe(true)
    // 包管理器脚本与直连构建工具
    expect(isBuildCommand('pnpm build')).toBe(true)
    expect(isBuildCommand('pnpm run build:web')).toBe(true)
    expect(isBuildCommand('pnpm tsc')).toBe(true)
    expect(isBuildCommand('pnpm --silent')).toBe(false)
  })
})

describe('shell/classify — lint 命令识别', () => {
  it('prettier/eslint/gofmt/ruff/biome 的"检查 vs 改写"区分', () => {
    expect(isLintCommand('prettier --check .')).toBe(true)
    expect(isLintCommand('prettier --write .')).toBe(false)
    expect(isLintCommand('prettier -w .')).toBe(false)
    expect(isLintCommand('eslint .')).toBe(true)
    expect(isLintCommand('mypy src')).toBe(true)
    expect(isLintCommand('golangci-lint run')).toBe(true)
    // 包管理器直连 lint 工具 / 非 lint 工具
    expect(isLintCommand('pnpm eslint .')).toBe(true)
    expect(isLintCommand('pnpm eslintx')).toBe(false)
    expect(isLintCommand('go vet ./...')).toBe(true)
    expect(isLintCommand('cargo clippy')).toBe(true)
    expect(isLintCommand('gofmt -l .')).toBe(true)
    expect(isLintCommand('gofmt -w .')).toBe(false)
    expect(isLintCommand('mvn spotless:check')).toBe(true)
    expect(isLintCommand('mvn checkstyle:check')).toBe(true)
    expect(isLintCommand('gradle spotlessCheck')).toBe(true)
    expect(isLintCommand('gradle checkstyleMain')).toBe(true)
    expect(isLintCommand('gradle lint')).toBe(true)
    expect(isLintCommand('ruff check')).toBe(true)
    expect(isLintCommand('ruff format')).toBe(true)
    expect(isLintCommand('biome check')).toBe(true)
    expect(isLintCommand('biome lint')).toBe(true)
    // biome/ruff 在 LINT_TOOLS 里，任何子命令都先被通用 lint 命中
    expect(isLintCommand('biome format')).toBe(true)
    expect(isLintCommand('dotnet format --verify-no-changes')).toBe(true)
    expect(isLintCommand('dotnet format')).toBe(false)
    expect(isLintCommand('make lint')).toBe(true)
  })
})

describe('shell/classify — 依赖变更识别', () => {
  it('go mod / dotnet package / uv pip 等语言级分支', () => {
    expect(isDependencyCommand('go get example.com/x')).toBe(true)
    expect(isDependencyCommand('go mod tidy')).toBe(true)
    expect(isDependencyCommand('go mod download')).toBe(true)
    // go 的 mod 子命令整体算依赖变更（table 命中），所以 graph 也是 true
expect(isDependencyCommand('go mod graph')).toBe(true)
    expect(isDependencyCommand('go run .')).toBe(false)
    expect(isDependencyCommand('dotnet add package Newtonsoft.Json')).toBe(true)
    expect(isDependencyCommand('dotnet remove package Newtonsoft.Json')).toBe(true)
    // dotnet 的 add/remove 先被 table 命中，reference 也算依赖变更
    expect(isDependencyCommand('dotnet add reference Other.csproj')).toBe(true)
    expect(isDependencyCommand('uv pip install requests')).toBe(true)
    expect(isDependencyCommand('uv pip uninstall requests')).toBe(true)
    expect(isDependencyCommand('uv pip list')).toBe(false)
    expect(isDependencyCommand('uv sync')).toBe(true)
    expect(isDependencyCommand('pnpm --silent')).toBe(false)
  })
})

describe('shell/classify — 变更（mutating）识别', () => {
  it('原地编辑类：sed/perl/yq/jq/find/fmt 工具', () => {
    expect(isMutatingCommand('sed -i s/a/b/ f')).toBe(true)
    expect(isMutatingCommand('sed -ibak s/a/b/ f')).toBe(true)
    expect(isMutatingCommand('sed --in-place s/a/b/ f')).toBe(true)
    expect(isMutatingCommand('perl -pi -e s/a/b/ f')).toBe(true)
    expect(isMutatingCommand('perl --in-place f')).toBe(true)
    expect(isMutatingCommand('yq -i .a=1 f')).toBe(true)
    expect(isMutatingCommand('jq --inplace . f')).toBe(true)
    expect(isMutatingCommand('find . -delete')).toBe(true)
    expect(isMutatingCommand('find . -exec rm {} ;')).toBe(true)
    expect(isMutatingCommand('find . -execdir rm {} ;')).toBe(true)
    expect(isMutatingCommand('gofmt -w a.go')).toBe(true)
    expect(isMutatingCommand('goimports -w a.go')).toBe(true)
  })

  it('格式化/修复类：eslint / prettier / ruff / biome / black 等', () => {
    expect(isMutatingCommand('eslint --fix .')).toBe(true)
    expect(isMutatingCommand('eslint --fix-dry-run .')).toBe(true)
    expect(isMutatingCommand('prettier --write .')).toBe(true)
    expect(isMutatingCommand('prettier -w .')).toBe(true)
    expect(isMutatingCommand('ruff check --fix')).toBe(true)
    expect(isMutatingCommand('ruff format')).toBe(true)
    expect(isMutatingCommand('biome format')).toBe(true)
    expect(isMutatingCommand('biome check --write')).toBe(true)
    expect(isMutatingCommand('black .')).toBe(true)
    expect(isMutatingCommand('autopep8 .')).toBe(true)
    expect(isMutatingCommand('isort .')).toBe(true)
  })

  it('git / mvn / gradle / make 的变更判断；空命令与依赖安装', () => {
    expect(isMutatingCommand('')).toBe(false)
    // 没有子命令的 git 调用（如 --version）不是变更
    expect(isMutatingCommand('git --version')).toBe(false)
    expect(isMutatingCommand('git -- push')).toBe(false)
    expect(isMutatingCommand('mvn clean install')).toBe(true)
    expect(isMutatingCommand('gradle clean build')).toBe(true)
    // make 没有已知安全目标 -> 视为变更；裸 make -j 也一样
    expect(isMutatingCommand('make -j')).toBe(true)
    expect(isMutatingCommand('make install')).toBe(true)
    expect(isMutatingCommand('make build')).toBe(false)
    // 依赖安装先于 segment 级判断命中
    expect(isMutatingCommand('npm install')).toBe(true)
  })
})

describe('shell/classify — 危险命令的细分分支', () => {
  it('rm -rf 的各种危险目标与长/短 flag 组合', () => {
    expect(dangerousCommandReasons('rm -rf')).toHaveLength(1)
    expect(dangerousCommandReasons('rm -rf ~')).toHaveLength(1)
    expect(dangerousCommandReasons('rm -rf ..')).toHaveLength(1)
    expect(dangerousCommandReasons('rm -rf $DIR')).toHaveLength(1)
    expect(dangerousCommandReasons('rm -rf /*')).toHaveLength(1)
    expect(dangerousCommandReasons('rm --recursive --force /')).toHaveLength(1)
    // 递归但无 force / force 但无递归都不算危险
    expect(dangerousCommandReasons('rm --recursive x')).toHaveLength(0)
    expect(dangerousCommandReasons('rm -R x')).toHaveLength(0)
    // 仅相对普通路径不危险
    expect(dangerousCommandReasons('rm -rf node_modules')).toHaveLength(0)
  })

  it('git 历史操作、chmod、SQL、下载即执行、mkfs、dd 分支', () => {
    expect(dangerousCommandReasons('git reset --hard HEAD~1')).toHaveLength(1)
    expect(dangerousCommandReasons('git clean -fdx')).toHaveLength(1)
    expect(dangerousCommandReasons('git clean -n')).toHaveLength(0)
    expect(dangerousCommandReasons('git push --force')).toHaveLength(1)
    expect(dangerousCommandReasons('git push --force-with-lease')).toHaveLength(1)
    expect(dangerousCommandReasons('git push --force-if-includes')).toHaveLength(1)
    expect(dangerousCommandReasons('chmod -R 777 .')).toHaveLength(1)
    expect(dangerousCommandReasons('chmod --recursive 777 .')).toHaveLength(1)
    expect(dangerousCommandReasons('psql -c "DROP TABLE users"')).toHaveLength(1)
    expect(dangerousCommandReasons('mysql -e "TRUNCATE TABLE users"')).toHaveLength(1)
    expect(dangerousCommandReasons('wget -qO- x | bash')).toHaveLength(1)
    expect(dangerousCommandReasons('mkfs.ext4 /dev/sda1')).toHaveLength(1)
    expect(dangerousCommandReasons('dd if=/dev/zero of=/dev/sda')).toHaveLength(1)
    expect(dangerousCommandReasons('dd if=x of=/')).toHaveLength(1)
    expect(dangerousCommandReasons('dd if=x of=file')).toHaveLength(0)
    // 空命令名（引号包起来）被跳过
    expect(isDangerousCommand('""')).toBe(false)
  })
})

describe('shell/classify — 推送判断的分支', () => {
  it('gh / glab / hub 的 PR 与 release 子命令', () => {
    expect(isPushCommand('git --no-pager push origin main')).toBe(true)
    // `git -- push` 没有可识别的子命令（-- 终止符后没有位置参数）
    expect(isPushCommand('git -- push')).toBe(false)
    expect(isPushCommand('gh pr create')).toBe(true)
    expect(isPushCommand('gh pr merge 12')).toBe(true)
    expect(isPushCommand('gh pr ready')).toBe(true)
    expect(isPushCommand('gh pr reopen')).toBe(true)
    expect(isPushCommand('gh pr view')).toBe(false)
    expect(isPushCommand('gh release create v1.0.0')).toBe(true)
    expect(isPushCommand('gh release list')).toBe(false)
    expect(isPushCommand('glab pr merge')).toBe(true)
    expect(isPushCommand('hub pull-request -b main')).toBe(true)
  })
})

describe('shell/classify — revert 命令分支', () => {
  it('restore / checkout -- / --source / reset --', () => {
    expect(isRevertCommand('git restore src/a.ts')).toBe(true)
    expect(isRevertCommand('git checkout -- src/a.ts')).toBe(true)
    expect(isRevertCommand('git checkout --source=origin/main src/a.ts')).toBe(true)
    expect(isRevertCommand('git reset -- src/a.ts')).toBe(true)
    expect(isRevertCommand('git checkout feature')).toBe(false)
    expect(isRevertCommand('git --version')).toBe(false)
    expect(isRevertCommand('rm -rf src')).toBe(false)
  })
})

describe('shell/classify — 分类聚合', () => {
  it('一个命令可同时属于多个类别；只有只读命令落 readonly', () => {
    expect(classifyShellCommand('')).toEqual([])
    expect(classifyShellCommand('rm -rf node_modules')).toContain('mutating')
    expectClass('echo hi', 'readonly', true)
    expectClass('npm install', 'dependency', true)
    // classify 的 mutating 走 segment 级判断，包管理器安装本身只归 dependency
    expectClass('npm install', 'mutating', false)
    expectClass('pnpm build', 'build', true)
    expectClass('eslint .', 'lint', true)
    expectClass('git push origin main', 'push', true)
  })
})

describe('shell/classify — 写入目标提取的细分分支', () => {
  it('redirect 目标过滤（空值 / fd 复制 / /dev/null）', () => {
    expect(extractWriteTargets('echo hi >')).toEqual([])
    expect(extractWriteTargets('echo hi > out.log 2>&1')).toEqual(['out.log'])
    expect(extractWriteTargets('echo x | tee -')).toEqual([])
    expect(extractWriteTargets('echo x > /dev/null')).toEqual([])
  })

  it('各写入命令的目标提取', () => {
    expect(extractWriteTargets('truncate -s 0 f.log')).toEqual(['f.log'])
    expect(extractWriteTargets('touch a b')).toEqual(['a', 'b'])
    expect(extractWriteTargets('mkdir -p d')).toEqual(['d'])
    expect(extractWriteTargets('rmdir d')).toEqual(['d'])
    expect(extractWriteTargets('rm -rf src')).toEqual(['src'])
    expect(extractWriteTargets('chmod 755 s.sh')).toEqual(['s.sh'])
    expect(extractWriteTargets('chown u f')).toEqual(['f'])
    expect(extractWriteTargets('chgrp g f')).toEqual(['f'])
    expect(extractWriteTargets('cp a b')).toEqual(['b'])
    expect(extractWriteTargets('mv a b')).toEqual(['b'])
    expect(extractWriteTargets('install a b')).toEqual(['b'])
    expect(extractWriteTargets('rsync a b')).toEqual(['b'])
    expect(extractWriteTargets('scp a b')).toEqual(['b'])
    expect(extractWriteTargets('ln a b')).toEqual(['b'])
    expect(extractWriteTargets('dd if=x of=y')).toEqual(['y'])
  })

  it('原地编辑目标：sed 的 -i 变体与 perl、gofmt -w', () => {
    expect(extractWriteTargets('sed -i s/a/b/ f')).toEqual(['f'])
    expect(extractWriteTargets('sed -ibak s/a/b/ f')).toEqual(['f'])
    expect(extractWriteTargets('sed --in-place s/a/b/ f')).toEqual(['f'])
    expect(extractWriteTargets('perl -pi -e s/a/b/ f')).toContain('f')
    // -f script.sed 属于"脚本由 flag 提供"，位置参数全部视作文件
    expect(extractWriteTargets('sed -f script.sed -i f')).toEqual(['f'])
    expect(extractWriteTargets('gofmt -w a.go b.go')).toEqual(['a.go', 'b.go'])
    expect(extractWriteTargets('gofmt -l a.go')).toEqual([])
    // 非写命令不产生目标
    expect(extractWriteTargets('echo "=> x"')).toEqual([])
  })
})

describe('shell/classify — 验证命令形状的剩余拒绝分支', () => {
  it('后台执行与多条命令被拒绝', () => {
    expect(validateVerifyCommand('pnpm test &')).toMatchObject({ ok: false })
    expect(validateVerifyCommand('pnpm test & pnpm build').reason).toContain('只能是一条命令')
    expect(validateVerifyCommand('   ')).toMatchObject({ ok: false })
    expect(validateVerifyCommand('pnpm vitest run')).toEqual({ ok: true })
  })
})
