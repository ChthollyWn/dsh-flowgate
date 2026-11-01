# FlowGate

[简体中文](./README.md) | English

[![CI](https://github.com/ChthollyWn/dsh-flowgate/actions/workflows/ci.yml/badge.svg)](https://github.com/ChthollyWn/dsh-flowgate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH 0.2.1-rc.5](https://img.shields.io/badge/DSH-0.2.1--rc.5-informational)](docs/compat/0.2.1-rc.5.md)


> **One sentence:** FlowGate turns the specification layer of OpenSpec, the execution discipline of Superpowers, and the delivery loop of gstack into a DSH plugin's own capabilities, and enforces a 7-stage development pipeline in code — if the previous stage is not complete, the next stage's writes are rejected, with an explanation of what is missing and how to unlock.

- Host: DeepSeek Harness (DSH) `>=0.2.1-rc.5 <0.3.0` (Desktop / Web)
- Package: `dsh-flowgate`, MIT licensed
- Repository: <https://github.com/ChthollyWn/dsh-flowgate>
- Status: **v0.1.0 published to npm (2026-10-31)** ([npm](https://www.npmjs.com/package/dsh-flowgate); after the sixth-round cleanup, functionality and docs are consistent; feature status table below; anything not done is marked as planned — see [docs/impl/implementation-status.md](docs/impl/implementation-status.md) for actual status and remaining items, and [docs/release/v0.1.0.md](docs/release/v0.1.0.md) for release notes)

---

## Why this exists (three pieces of hard evidence)

1. **Prompts cannot enforce discipline.** The Superpowers v7.0.1 release notes state that, before the brainstorming rewrite, in one test scenario the agent **skipped the design document and started coding in 24 out of 24 runs**; after the rewrite it still happened 3 times. Discipline has to be enforced by code.
2. **DSH has no native stage gates.** The official [`dsh-plan-mode`](docs/reference/dsh-0.2.1-rc.5/dsh-plan-mode.zh.md) docs say: "it does not restrict the agent: every tool remains callable, so use sandbox mode and approval prompts when you need hard limits." Sandboxes and approvals govern "may I do this", not "should this be done now".
3. **Existing gate plugins leave a gap.** Competitive research found that current DSH gate plugins tend to be soft by default, produce false positives, silently fail, and can even prevent the host from starting; nobody implements the ordered state machine of "step 0 is not done, so step 3 is forbidden". FlowGate makes the ordering a hard constraint while treating false positives and graceful degradation as first-class concerns.

## What it looks like: a 7-stage pipeline

```mermaid
flowchart LR
  S0["S0 Kickoff"] -->|"G0 auto"| S1["S1 Requirements"]
  S1 -->|"G1 sign-off (human)"| S2["S2 Context"]
  S2 -->|"G2 auto"| S3["S3 Design & Breakdown"]
  S3 -->|"G3 plan approval (human)"| S4["S4 Execution"]
  S4 -->|"G4 task gate per task"| S5["S5 Verification"]
  S5 -->|"G5 auto"| S6["S6 Delivery"]
  S6 -->|"G6 delivery approval (human)"| DONE(("Archived"))
  S5 -.->|"verification failed, create fix task"| S4
  S4 -.->|"requirement gap, write increment"| S1
  RISK{{"Risk triggers (registered in S3, active S4–S6)"}} -.->|"hit => human"| S4
```

When starting from an empty repository, a project roadmap comes before S0: project-level clarification → split into capabilities → engineering skeleton C0 → owner approval (GR) → each change walks the pipeline above.

| Stage | Judgment to practice | Main artifacts | Exit gate | Who approves |
|---|---|---|---|---|
| Project roadmap / S0 kickoff | How to split capabilities, where the MVP line sits | `project-clarify.md`, `roadmap.md`, change directory | GR / G0 | Human / auto |
| S1 Requirements | Is the goal, boundary, and acceptance criteria verifiable? | `clarify.md`, `proposal.md`, delta spec | G1 | **Human** |
| S2 Context | Which facts does the agent need so it does not guess? | `context.md`, baseline test record | G2 | Auto |
| S3 Design & breakdown | Are tasks small enough to finish and verify one by one; are risks identified early? | `design.md`, `risk.md`, `tasks.md`, execution graph | G3 | **Human** |
| S4 Execution | Write the failing test first; only touch the declared files; stop after three failures and find the root cause | Code + RED/GREEN evidence per task | G4 (task gate) | Auto |
| S5 Verification | What evidence proves it works, and was it produced after the last change? | Full test suite vs baseline, review verdicts, runtime evidence | G5 | Auto |
| S6 Delivery | Can someone else take over, can it be rolled back, were lessons captured? | Commit notes, CHANGELOG, archived specs, retro, HTML report | G6 | **Human** |

Process level has two independent dimensions: **complexity** (low / medium / high / ultra) decides how much of the pipeline runs, and **risk** (normal / high) decides how strict the checks are. Low complexity needs only two human confirmations (plan confirmation card + delivery confirmation); a "small but dangerous" change can take the short path while still being checked strictly.

## Three hard constraints (code, not prompts)

- **Ordering:** in S0–S3 only stage artifacts may be written; source writes are rejected. In S4 you must claim a task first and may only write inside that task's declared scope.
- **Evidence:** verification is executed by the plugin (`flow_verify`), producing receipts with command, exit code, test counts, and input hashes. Receipts expire when inputs change. "It passed on my machine" does not count.
- **Delivery:** G1 / G3 / G6 are human gates. The agent has no tool to approve, override, or lower a level; pushes and PR creation can only happen after G6 and only when the owner triggers them.

## Quick start (dual profiles: daily desktop / dev flowgate-dev / dogfood)

**Do not `link:` a workspace source checkout into your daily `desktop` profile** (lesson from the v0.5.1 incident: a broken build instantly pollutes daily use, and recovery actions may be blocked by the broken plugin). Since v0.6, use the three profiles described in [docs/impl/dev-loop.md](docs/impl/dev-loop.md):

| profile | Install from | Purpose |
|---|---|---|
| `desktop` (daily) | published npm version (`dsh-flowgate@<known-good>`) | Daily use; keep the previous known-good version for a fast rollback |
| `flowgate-dev` | `link:<repo>` | Source development / local E2E (`pnpm verify:host`) |
| `flowgate-dogfood` | `pnpm pack` → `file:<tgz>` | Govern FlowGate's own development; upgrade only after `verify:host` passes |

During development and trial installs, use an isolated profile — do not install into your daily `desktop` profile. Create an isolated development profile first:

```bash
# Use the CLI bundled with the desktop app (a global dsh may be outdated)
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

# 1. Create an isolated web profile (first time only; re-running overwrites that profile)
"$DSH" flowgate-dev --from-default-profile web

# 2a. Install the published version from npm (recommended)
"$DSH" plugin --profile flowgate-dev add dsh-flowgate@0.1.0

# 2b. Or link: a source checkout during development (isolated dev profile only; run pnpm install && pnpm build first)
"$DSH" plugin --profile flowgate-dev add link:/path/to/dsh-flowgate

# 3. Confirm the plugin line exists in the composition tree
"$DSH" --profile flowgate-dev --dump-config | grep -i flowgate

# 4. Start
"$DSH" --profile flowgate-dev
```

Then initialize the project to be governed and start the first change:

```text
Day to day you only need **natural language and clicks** — every decision that needs you appears as a card; no commands to memorize:

```text
[the input dock shows an "Enable FlowGate" authorization card] → click it to initialize (scan repo, draft project.md)
"add sharing to the todo list"                → the agent creates the change and enters S1 clarification
                                             → the agent asks you through native question cards (click options / type a line)
[G1 authorization card]                      → click "Approve & continue" to sign off the requirements
                                             → S2 context → S3 design / risks / task cards
[G3 authorization card]                      → one click approves the design, risks, and task list
                                             → S4 execution (per the execution graph); the plugin verifies and reviews each task
[G6 authorization card]                      → click "Approve & deliver"; the plugin writes the report and archives specs
```

- **Graphical flow:** the dock above the composer is a seven-stage animated rail (breathing current stage, solid completed links, dashed upcoming links); the right sidebar has a full graphical flow page (progress ring + vertical timeline + "next step" arrow).
- **Click-to-authorize:** approve / reject / clear breaker / confirm external changes are all executed by the card button (`ctx.remote.commands.execute`) — **nothing is written into the composer**, and you never press Enter to confirm a command.
- **Question cards:** questions use the native `ask_user_question` tool, rendered as DSH question cards (options + custom text); the agent is told not to ask in plain prose.
- **In-conversation visualization:** every `flow_*` tool call renders as a mini seven-stage rail, showing where that call sits in the pipeline.
- **Bug fixes need no change proposal (v0.6 repair lane + v0.7 smart admission):** for a known-bad behavior, just say "fix this bug: <symptom>". The agent calls `flow_fix_start` → reproduce for RED → iterate freely inside scope → GREEN → full regression → auto-archive under `.flowgate/fixes/`. No seven-stage documents and no human gates, but the evidence chain is unchanged; new features/requirement changes still use the change lane. Since v0.7, **scope/verify may be omitted**: the engine derives them from the latest failed receipts, uncommitted changes, and project commands, then runs deterministic admission (cross-module/sensitive/too-broad/dirty-worktree cases are rejected with the correct recommended lane); use `dryRun: true` to preview. See [docs/impl/repair-lane.md](docs/impl/repair-lane.md).
- **Self-rescue first (v0.6):** if the plugin breaks the host, do not uninstall it — run `pnpm host:recover --safe-mode --reason "<symptom>"`; after a restart the plugin enters **safe mode (takeover=off, no blocking at all, guard and related modules skipped)**. Fix it, confirm with `pnpm verify:host`, then `--clear`. See [docs/impl/host-recovery.md](docs/impl/host-recovery.md).

> Projects that never ran `/flow init` are **not** gated; the dock shows a one-click enable card (FR-15.1).
>
> Power users can still use the `/flow` commands listed below; they are equivalent to the cards. Normal flows never need a typed command.
>
> Host requirements: `engines.dsh >=0.2.1-rc.5 <0.3.0`; `@deepseek-ai/*` packages are peerDependencies only, so host core packages never enter the bundle.

## Commands (human-only; never sent to the model; for power users/troubleshooting — normal flows use cards)

| Command | Purpose |
|---|---|
| `/flow` | Show state: stage, gate checks, active tasks, pending items, next step |
| `/flow init` | Scan the repo and draft `.flowgate/project.md` |
| `/flow new <description>` | Create a change; `/flow new --project <description>` declares a new project (project-level clarification + roadmap first) |
| `/flow approve <gate>` | Approve the current human gate (GR / G1 / G3 / G6; low complexity combines G1+G3 in one confirmation card) |
| `/flow reject <reason>` | Reject the current human gate; the reason is injected to the agent |
| `/flow roadmap` | Show the roadmap and each change's status |
| `/flow resume [change]` / `/flow pause` | Resume / pause a change (pause writes a handoff summary and releases the lease) |
| `/flow resume <change> --takeover` | Take over a change owned by another live session |
| `/flow handoff` | Generate a handoff summary immediately |
| `/flow board` | Open the cross-session `dashboard.html` board |
| `/flow parallel <n>` | Change the parallel limit (affects future batches only) |
| `/flow route <full\|standard\|fast> <reason>` | Owner override of the auto-flow route (fast still limited to low complexity × normal risk) |
| `/flow fix [status\|done\|abort <reason>]` | Repair lane: status / close (validates RED→GREEN, scope, full regression) / abort; `/flow repair` (rebuild state from the ledger) keeps its old meaning |
| `/flow incident` | Show unclosed incident records (after agent `flow_self_pause`); close them with `flow_incident_close` for audit |
| `/flow allow-once <rule id or last> <reason>` | One-time override (`OV-n`, applies to the next matching action only) |
| `/flow scope approve\|reject <SC-n> [reason]` | Handle scope-change requests |
| `/flow risk approve\|reject <RK-n> [reason]` | Handle risk take-over items |
| `/flow plan approve\|reject <PC-n> [reason]` | Handle plan-revision requests |
| `/flow rule approve\|reject <RL-n> [reason]` | Handle rule-sedimentation proposals |
| `/flow unblock [BL-n\|task id] [reason]` | Clear a consecutive-failure breaker (T-FAILURE-LIMIT): reset the failure count, resume the paused task, and close the task's remaining open `BL-*` blockers (no argument = the current change's single open blocker) |
| `/flow complexity <level> [reason]` / `/flow risk-level <level> [reason]` | Adjust levels; lowering requires a human reason |
| `/flow metrics [--csv]` | Show metrics (M-1..M-18) |
| `/flow report` | Generate and open the HTML delivery report |
| `/flow doctor` / `/flow repair` | Self-check / rebuild state from the ledger and artifacts |
| `/flow off` / `/flow on` | Turn gating off / on for this session (recorded; the dock turns red and offers a recovery card when off) |

## Model tools (no approve, override, or lower-level tools)

**21 tools** are registered: 20 `flow_*` tools plus `flow_dispatch_next` (dispatch mode only). The repair-lane and incident tools are included; **none of them can approve, allow, or lower a level** (only the owner can do that via `/flow` commands or authorization cards).

| Tool | When | Notes |
|---|---|---|
| `flow_status` | Anytime | Current stage, gate checks, active tasks, allowed next steps |
| `flow_new_change` | Before kickoff | Create a change or read-only analysis task (`kind: change \| analysis`); can start from a roadmap item |
| `flow_submit` | After finishing a stage's artifacts | Run gate checks (GR / G0 / G1 / G2 / G3 / G5 / G6); human gates wait for the owner |
| `flow_task_start` | S4 (`dispatch: inline`) | Claim a task card with relevant context, TDD requirements, verify commands; must follow the execution graph |
| `flow_dispatch_next` | S4 (dispatch mode) | Start the next batch per the graph; returns summaries, task gates, and checkpoint results |
| `flow_task_done` | S4 | Task gate: evidence freshness, scope, TDD, review |
| `flow_verify` | S2–S5 | Plugin-executed verification and receipt; only these receipts count as RED/GREEN evidence |
| `flow_request_scope_change` | S4 | Request a task scope extension (`SC-n`) |
| `flow_request_plan_change` | S4 | Request added tasks / reorder not-yet-started tasks (`PC-n`) |
| `flow_report_risk` | S3–S6 | Proactively report a risk (`RK-n`) |
| `flow_attach_evidence` | S4–S5 | Attach manual evidence (screenshots, logs); marked "agent claim", never a substitute for `flow_verify` |
| `flow_propose_rule` | S4–S6 | Propose a project rule for recurring findings (`RL-n`, owner approval required) |
| `flow_investigate` | Analysis tasks, S1–S2 | Spawn read-only investigation subagents (default max 2) returning cited reports |
| `flow_submit_analysis` | Analysis tasks | Submit conclusion, proposal, limitations, and source citations; the plugin verifies citations before archiving |
| `flow_diff` | Review subagents only | Read-only diff of the task under review |
| `flow_declare_rework` | S4–S6 on defects/requirement changes | Rework declaration: invalidates affected tasks' receipts and reviews by type (defects propagate along depends_on) |
| `flow_fix_start` | Bug fixing (no active change) | **Repair lane + smart admission (v0.7):** only `symptom` is required; scope/verify/title may be omitted (derived from failed receipts, uncommitted changes, project commands). Deterministic admission rejects an active change (suggests `flow_declare_rework`), sensitive/too-broad scope (suggests `flow_new_change`), dirty worktrees, and missing/invalid verify. After the `FIX-id`, iterate freely inside scope with no change proposal or human gate, but RED→GREEN evidence is mandatory; `dryRun: true` previews only |
| `flow_fix_done` | After the fix | Close-out checks: RED/GREEN order, every `git status` change inside scope, `config.commands.test` full regression, re-run of the declared verify, fresh receipts; failure keeps the lane open |
| `flow_fix_abort` | Abandon the fix | Requires a reason; logs `repair.aborted` and clears the in-progress declaration |
| `flow_self_pause` | Cannot continue safely / owner decision needed | Agent self-pause: project-level write pause + `INC-id` incident record (`autoRearm`; recovers automatically on the next host start; the agent cannot resume by itself) |
| `flow_incident_close` | After recovery | Write summary/commit/tests/files, archive `.flowgate/incidents/<INC-id>.json`, clear the incident marker |

## Rule reference

Rules are data (built-in defaults + `.flowgate/config.yaml` overrides), not hard-coded branches. Example defaults:

```yaml
# overridden or extended under `rules:` in .flowgate/config.yaml
- id: R-STAGE-SRC          # S0–S3 may not write source code
  when: { stage: [S0, S1, S2, S3], action: write, path: "**", except: [".flowgate/changes/{change}/**"] }
  decision: deny
  unlock: finish the stage artifacts and call flow_submit; for an urgent change ask the owner for /flow allow-once R-STAGE-SRC <reason>
- id: R-SCOPE              # S4 may only write inside the current task's scope
  when: { stage: [S4], action: [write, create, delete], outside: task.scope }
  decision: deny
  unlock: call flow_request_scope_change with the extra paths and reason, then wait for owner approval
- id: R-DEP                # dependency changes require a human
  when: { stage: [S4, S5], action: dependency }
  decision: human
```

**Evaluation order:** protected paths → locked mode → risk triggers (human) → stage policy → task scope → new-file control → TDD ordering → overrides/exceptions → allow by default. Once a rule denies, later rules cannot flip the decision; a one-time override only cancels the exact rule it names.

**Built-in risk triggers (tunable under `triggers`):** sensitive paths (auth / payment / migrations / infrastructure / CI / production config), dependency manifest changes, dangerous commands (`rm -rf`, `git push --force`, `git reset --hard`, `DROP`/`TRUNCATE`, `curl … | sh`, etc.), suspected secrets, budget overruns, scope inflation, consecutive failures. A hit rejects the current action and creates a pending item; the owner can approve a one-time pass. **The consecutive-failure breaker only blocks actions that would make progress or mutate state** (file writes, workspace-mutating commands, progress tools such as `flow_verify` / `flow_task_done`); `read`/`glob`/`grep`, read-only commands and `flow_status`/`flow_diff`/`flow_report_risk` stay allowed so the agent can gather evidence and find the root cause before the owner runs `/flow unblock <BL-n>`.

For the full rule definitions, command tokenization, and false-positive regression cases see [docs/03-技术方案.md](docs/03-技术方案.md) §4–§5.

## What is in the repo

```text
src/core/          pure logic: state machine, rules, artifact checks, ledger, evidence, metrics, reports (no @deepseek-ai/* imports)
src/host/          DSH host adapter: guards, commands, tools, presets, projection, review and dispatch
src/client/        graphical input dock (seven-stage rail + authorization cards), right sidebar panel, conversation tool views (bundled for window.__ModuleLoader__)
skills/            15 built-in skills (SKILL.md + learn.md learning cards)
examples/          three benchmark repos: ts-todo-api, py-csv-cli, java-renewal
docs/              requirements, technical design, execution plan, implementation contracts, method sources, DSH references
```

### 15 built-in skills

| Stage | Skill | Upstream ideas it adapts (rewritten as built-in capabilities) |
|---|---|---|
| Starting from zero | `flow-roadmap` | gstack `/office-hours`, `/plan-ceo-review`; Superpowers brainstorming; OpenSpec "one capability per change" |
| S1 Requirements | `flow-clarify` | Superpowers brainstorming; gstack `/spec`; OpenSpec propose / explore |
| S2 Context | `flow-context` | OpenSpec `config.yaml` context / rules |
| S3 Design | `flow-design` | Superpowers multi-option comparison; gstack `/plan-eng-review` |
| S3 Plan | `flow-plan` | Superpowers writing-plans; OpenSpec tasks |
| S4 Scheduling | `flow-orchestrate` | Superpowers subagent-driven-development, dispatching-parallel-agents |
| S4 Execution | `flow-tdd`, `flow-debug`, `flow-scope` | Superpowers TDD / systematic-debugging; gstack `/freeze`, `/careful`, `/investigate` |
| S4–S5 Verification | `flow-verify`, `flow-review`, `flow-qa` | Superpowers verification-before-completion / code review; gstack `/review`, `/qa`, `/cso` |
| S6 Delivery | `flow-ship`, `flow-retro` | gstack `/ship`, `/document-release`, `/retro`; OpenSpec archive; Superpowers finishing-a-development-branch |
| Analysis tasks | `flow-analysis` | dsh-task-engine's read-only analysis contract; Superpowers "find the root cause first" |

Every skill ships a `SKILL.md` (when to use, executable steps, what code enforces, what is guidance only, anti-patterns, good/bad examples, artifact paths) and a `learn.md` learning card (what / why / acceptance criteria / upstream practice / anti-patterns / good / bad). Upstream versions and per-skill provenance are tracked in [docs/method-sources.md](docs/method-sources.md); third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Feature status (v0.1, sixth-round check 2026-10-31)

> Honest status: ✅ implemented with automated/offline verification; 🟡 implemented, pending real-host end-to-end confirmation; 🗓 planned. Evidence: [docs/impl/implementation-status.md](docs/impl/implementation-status.md).

| Capability | Status |
|---|---|
| 15 built-in skills (30 SKILL/learn files), method-source table, third-party notices | ✅ done |
| Three benchmark repos (TS / Java / Python, independently buildable/testable) | ✅ done and executed ([examples/](examples/README.md)) |
| State machine + level matrix, rules engine + shell tokenizer, scope control | ✅ done (core unit tests + engine integration tests) |
| Artifact parsers, 52 gate checks (GR/G0–G3/G5/G6), task cards, execution plan/graph | ✅ done (positive + negative per check) |
| `.flowgate/`, change ledger, hash-chained + HMAC audit ledger, cross-session leases, locked mode and `/flow repair` | ✅ done (tamper located by line; strict rebuild round-trip) |
| Verification receipts, input-hash freshness, risk engine, rework invalidation, verifiable citations | ✅ done |
| Review subagent, execution-graph dispatch, worktree parallelism, integration checkpoints | 🟡 wired + dedicated unit tests (slot refill, checkpoint repair/retry, `run: main` routing, line-level read coverage, same-diff dedupe, three final conclusions, checkpoint task verification + full tests); a real headless host verified worktree creation, executor subagents, task gates and review, and **sequential dispatch settled all the way to S5** (3 batches done, G4 passed); parallel batches really start but the one-shot run exits before the integration-checkpoint merge, so an interactive/long-lived host is still needed |
| Graphical flow visualization (input dock / panel flow page / in-conversation tool rail) | ✅ 2026-11-01 v0.2: the input dock became a seven-stage animated rail + next-step chip + graphical state card (demo/locked/off/idle/active/awaiting/pending/blocked); the sidebar gained a `panel-rail` and a graphical flow page (hero progress ring, vertical timeline, human/auto gate badges, "you are here", next-step callout); each `flow_*` tool call renders a mini seven-stage rail; motion only animates transform/opacity/stroke and respects `prefers-reduced-motion`; **cards and panels use DSH's native `--dsw-*` design tokens, the authorization card mirrors the native plan-approval card (warn strip + white card + primary/outline buttons), and widths strictly match `--dsh-chat-content-width` (real-host measurement: dock/card 844.8px, ±0px)**; real-host screenshots in [docs/screenshots](docs/screenshots/README.md) |
| Card-first interaction (click-to-authorize + native question cards) | ✅ 2026-11-01 v0.2: human gates / pending items (SC·RK·PC·RL·TM·CF·BL) / non-agent change confirmation / enable / repair are all clickable authorization cards; a click executes the equivalent command through `ctx.remote.commands.execute` (`sessions.binding().session.command` as fallback) and **the composer is never filled**; the FlowGate preset composes the native `ask_user_question` tool for question cards; user-facing `/flow` hints in host/core were rewritten as card guidance (only help / usage errors / doctor diagnostics remain); real-host click flow in [docs/screenshots](docs/screenshots/README.md) |
| Full FlowGate takeover + auto-flow routing + auto-review | ✅ v0.5 (2026-11-01): once enabled, writes/mutating shell without an active change are denied by `R-NO-CHANGE` (reads and `flow_*` allowed) — every change must start with a change record. The model self-assesses size/clarity in `flow_new_change.assessment` and proposes a `route`: `full` (all human gates), `standard` (G1+G3 merged into one confirmation), `fast` (low complexity + clear/verifiable: G1/G3/G6 auto-pass after checks, through delivery). A deterministic host auto-review independently enforces safety: high risk/complex/sensitive surfaces force full; fast requires clear + ≥2 acceptance items + valid verify command + 1–5 scope entries; the owner can override with `/flow route ...`. Audit events `flow.assessed` / `flow.route_override`; the dock/panel show an auto-flow badge |
| **Repair lane (bug fixing as a first-class citizen, v0.6)** | ✅ 2026-11-01: `flow_fix_start/done/abort` + `/flow fix`; FIX-id declares scope (1–20), verify and symptom → RED (`flow_verify` failure receipt) → free iteration in scope → GREEN → full regression → auto-archive `.flowgate/fixes/<FIX-id>.json` + `index.md` + ledger `repair.*`; guards `R-FIX-SCOPE`/`R-FIX-SHELL`/`R-FIX-TOOL`; no human gates, no seven-stage documents; contract and limits in [repair-lane.md](docs/impl/repair-lane.md) |
| **Repair-lane smart admission (v0.7)** | ✅ 2026-11-01: `flow_fix_start` now runs signal derivation + deterministic admission (`src/core/flow/repair-admission.ts`, `FlowEngine.previewRepair()`): derives scope/verify/title from latest failed receipts, uncommitted changes, and project commands; rejects an active change (suggests `flow_declare_rework`), sensitive surfaces / too-broad scope (suggests `flow_new_change`), dirty worktrees, and missing/invalid verify; approvals log `repair.assessed` (source/confidence/checks) and rejections log `repair.rejected` without leaving a half-open repair; `dryRun` previews only; close-out adds a ≤20 changed-files cap. See [repair-lane.md §2.3](docs/impl/repair-lane.md) |
| **Self-healing and recovery (v0.6)** | ✅ 2026-11-01: safe-mode sentinel (`$DSH_HOME/flowgate/safe-mode` + project-level + `FLOWGATE_SAFE`) → forces takeover=off and skips guard/delegation/gates/dispatch; module switches `FLOWGATE_DISABLE`/`config.modules`; self-host repository defaults to observe (**only `R-NO-CHANGE` unplanned writes are allowed and recorded; stage/scope/protected-path/repair-scope rules still block**); `pnpm host:recover` (`--status/--safe-mode/--clear/--profile <p> --remove [--yes]`, audits to `recovery.log`, never deletes project data); agent self-pause/incident records (`flow_self_pause`/`flow_incident_close`, `INC-id`); see [host-recovery.md](docs/impl/host-recovery.md) |
| **Real-host regression gate `pnpm verify:host` (v0.6)** | ✅ 2026-11-01: isolated `DSH_HOME` + real DSH web host + `link:` this repo, **creates ≥2 (default 3) sessions in a row** and asserts no `not lossless JSON` — the only reliable regression gate for the v0.5.1 incident (a single session misses it); fixed build 3/3 GREEN, a neutralized pre-fix build fails at the 2nd/3rd creation (validated via `--expect-fail`). See [docs/compat/host-smoke.md](docs/compat/host-smoke.md) |
| **Explicit projection wire DTO + self-check + budget (v0.6)** | ✅ 2026-11-01: `src/host/boundary/json.ts` mirrors DSH lossless rules (undefined/NaN/negative zero/sparse arrays/class instances…); `wire.ts` explicit allow-list DTO + count limits + a 256KiB per-frame budget with a degradation order; `projectionSelfCheck()` before registration (a failing projection is not registered); `stateVersion=2`; measurements in [projection-budget.md](docs/impl/projection-budget.md) |
| Learning mode / stage learning cards (removed) | 🗑 Removed in v0.4 at the owner's request: the panel's learning-mode selector, stage learning cards (what/why/method source/anti-patterns/examples), glossary, the `/flow learn` command, the `learning` config and projection field; a legacy `learning:` key in `.flowgate/config.yaml` is ignored on load. Live gate checks and artifact chips remain. |
| Runtime visualization: subagent topology (workflow graph / tree) + background job list | ✅ 2026-11-01 v0.3: two new panel views. The subagent view reads the native DSH `subagentCatalog` session projection plus live running state and joins it with FlowGate tasks/batches/worktrees, offering **workflow graph (top-down, measured 0 horizontal overflow at 560/719px sidebar widths) / tree** modes; the jobs view reuses the native DSH `ctx.jobs` service to show status, **exit code**, duration, **live output** (streamed on expand) and **two-step force termination**; all styling uses native `--dsw-*` tokens/neutral colors. Limitation: real-host populated data needs a model run — the real host only verified empty states/composition (22/22), so 34–36 are component-level fixtures, labelled as such. |
| 10-view right sidebar panel (ledger/flow/gates/tasks/agents/jobs/trace/risk/intercepts/metrics) | ✅ walked through in a real DSH web host: 10 views, in-session preset switch, panel approvals, pending decisions, exception list/revoke, non-agent change confirmation; context occupancy (`contextPct`) wired to the DSH token-meter projection (shown ≥60%); stale GREEN detected by input hash; execution-graph nodes are clickable with a task-detail panel; rule trial is a client-side approximation explicitly labelled "host decision is authoritative"; intercept-view misjudgement feedback verified at component level |
| HTML delivery report, cross-session dashboard | ✅ done (single-file, offline, samples in test/fixtures) |
| Metrics M-1..M-18, export, rule capture, read-only analysis tasks | ✅ done (missing data is reported as "unknown", never 0) |
| With / without plugin evaluation report | ✅ **18/18 runs done + manual scoring of all 4 subjective metrics 18/18** (9 tasks × A/B, real model + headless); this round also adds the from-scratch and dispatch (inline vs auto) comparisons ([§6.5–§6.7](docs/evaluation.md)). Honest conclusion: B did not win on requirement coverage (most B runs were blocked by environment/human gates); its real gains are zero false completions and auditable process — small sample, not generalizable |

**Verification boundary** (locally measured in the sixth round, 2026-10-31): `pnpm lint && pnpm test && pnpm build && pnpm verify:package && pnpm verify:client` are green (**112 files / 1522 tests**; fifth round 107/1459, i.e. +5 files / +63 tests); `pnpm coverage` passes thresholds (80/80/80/70; total 86.40 / 76.25 / 86.92 / 89.46, core/host details in implementation-status §2); the npm package is about **39 files / ~1.03MB** (exact value in implementation-status §2 and the release notes); a real DSH 0.2.1-rc.5 process composes and imports this plugin via `--dump-config`, and `verify:compat` reruns **13/13** in an isolated profile (sixth round used a fresh build in `/tmp/fg-audit-env`, dump-config 1314 lines; `--dump-config-schema` also fails on rc.5 for the host's own preset rows, so it is not used as evidence — see [docs/compat/0.2.1-rc.5.md](docs/compat/0.2.1-rc.5.md)); startup overhead **+16.2ms** and uninstall cleanliness pass; real web-host UI and a real-model S0→S6 run have been exercised; the controlled evaluation has completed all 18 runs plus subjective scoring, with counterexamples/blockers and sandbox caveats in [docs/evaluation.md](docs/evaluation.md) and [docs/impl/implementation-status.md](docs/impl/implementation-status.md). **The independent sixth-round re-verification drove fixes for 7 P1 wiring gaps** (parallel worktree execution root, dispatch double-settlement, S5 regression verdict, compaction/cross-session re-injection, clarify placeholders, low-complexity task limit; see implementation-status §3.12), and local gates are all green; **the sixth-round commits are pushed** (`cea85dd` + `25fffac`), and CI run [41197243594](https://github.com/ChthollyWn/dsh-flowgate/actions/runs/41197243594) is **success** (lint → test → coverage → build → verify:package → verify:client). Fifth-round acceptance and sixth-round re-verification records are in [acceptance-gap-audit](docs/impl/acceptance-gap-audit-2026-10-31.md).

**v0.2 (2026-11-01, graphical flow + card authorization) local gates:** `pnpm lint` / `npx vitest run` (**116 files / 1642 tests**) / `pnpm coverage` (86.39 / 76.24 / 86.93 / 89.47, thresholds pass) / `pnpm build` (host 1.21MB / client 346.6KB) / `verify:package` (39 files / 1065.3KB) / `verify:client` all green; real DSH web host click-to-authorize and graphical flow walkthrough in [docs/screenshots](docs/screenshots/README.md) and [docs/impl/ui-interaction-redesign.md](docs/impl/ui-interaction-redesign.md).

**v0.3 (2026-11-01, runtime visualization: subagent topology + background jobs):** `pnpm lint` / `npx vitest run` (**118 files / 1683 tests**) / `pnpm coverage` (86.39 / 76.25 / 86.93 / 89.47, thresholds pass) / `pnpm build` (host 1.21MB / client 411.6KB) / `verify:package` / `verify:client` all green; real DSH web host zero-model smoke **22/22** (10 tabs, new-view empty states, no regressions, 0 pageerror/console.error/model requests); the subagent workflow graph has **0 horizontal overflow** at 560px / 719px sidebar widths (508/508, 667/667). Real-host populated data needs a model run; 34–36 are component-level evidence, disclosed as such.

**v0.4 (2026-11-01, learning mode removed):** `pnpm lint` / `npx vitest run` (**117 files / 1669 tests**) / `pnpm coverage` (86.31 / 76.23 / 86.88 / 89.37, thresholds pass) / `pnpm build` (host 1.21MB / client 381.4KB) / `verify:package` (39 files / 1062.5KB) / `verify:client` all green; real DSH web host zero-model E2E **14/14** (no learning-mode anchor, no stage-card/glossary, `/flow help` hides learn, `/flow learn` is an unknown subcommand, legacy `learning:` config still loads, 0 pageerror/console.error/model requests); the panel no longer renders the learning-mode selector, stage learning cards or glossary, `/flow learn` fails as an unknown subcommand, and legacy `learning:` keys are ignored; the graphical flow page keeps live checks, artifact chips and the next-step callout.

**v0.5 (2026-11-01, auto-flow takeover + auto-review):** `R-NO-CHANGE` takes over unplanned writes; `flow_new_change.assessment` self-assessment + host auto-review selects full/standard/fast; fast auto-passes G1/G3/G6 after checks and delivers/archives, standard merges G1+G3 into one human confirmation; new `/flow route` owner override. Verification: lint green; 119 files / 1687 tests (8 auto-review rule classes + fast/standard state-machine integration); coverage 86.18 / 76.23 / 86.88 / 89.27 (thresholds pass); build (host 1.23MB / client 369.4KB); verify:package (39 files / 1079.2KB) / verify:client green; zero-model real-host E2E: auto-flow badge 7/7 (dock + panel, `data-route=fast`) + v0.4 regression 14/14, 0 pageerror/console.error/model requests (see docs/impl/auto-flow.md).

**v0.7 (2026-11-01, repair-lane smart admission) integrated verification:** lint/tsc pass (149 source files, 0 error); `npx vitest run` **131 files / 1876 tests** green (new admission rule matrix 17 cases + engine end-to-end 9 cases); `pnpm coverage` **86.61 / 76.61 / 87.44 / 89.71** (thresholds pass); `pnpm build` host **1.36MB** (1,358,014 B, sha256 `37ca9097…`) / client **375.2KB**; `verify:package` **39 files / 1190.8KB**; `verify:client` **18 slots + 1 right-rail tab** pass; `verify:uninstall` pass; `measure:startup` **about +16ms** (14.6–17.3ms across runs, <200ms); `verify:compat` **13/13** pass (isolated `DSH_HOME`, `--dump-config` 1316 lines); real-host `pnpm verify:host` **creates 3 sessions in a row successfully** (0.8s ready, no lossless errors); a neutralized pre-fix build reproduces at the 2nd/3rd creation (gate proven), see [docs/compat/host-smoke.md](docs/compat/host-smoke.md). Deterministic admission rules and limits are in [repair-lane.md §2.3](docs/impl/repair-lane.md).

**v0.6 (2026-11-01, repair lane + self-healing/recovery + verify:host) integrated verification:** lint/tsc pass (148 source files, 0 error); `npx vitest run` **129 files / 1849 tests** green; `pnpm coverage` **86.50 / 76.45 / 87.41 / 89.63** (thresholds pass); `pnpm build` host **1.34MB** / client **375.2KB**; `verify:package` **39 files / 1172.6KB**; `verify:client` **18 slots + 1 right-rail tab** pass; `verify:uninstall` pass; `measure:startup` **about +16ms** (15.3–17.3ms across runs, <200ms; see [docs/compat/startup.md](docs/compat/startup.md) for the measurement); `verify:compat` passed **13/13** (isolated `DSH_HOME`, `--dump-config` 1316 lines; still rerun per the release checklist on a machine with DSH). Real-host evidence: `pnpm verify:host` **creates 3 sessions in a row successfully** (isolated web host ready in 0.8s, about 0.02s/session, no lossless errors); a neutralized pre-fix build reproduces `not lossless JSON` at the 2nd/3rd creation (gate proven effective), see [docs/compat/host-smoke.md](docs/compat/host-smoke.md). Safety/recovery: `host:recover`, safe-mode, module switches, observe mode, repair lane, and incident records are all in place (see the table and docs/impl).

**v0.5.1 (2026-11-01, fix new-session failure):** the `flowgate` session projection wire value contained `undefined` fields; DSH's `api-session/added` lossless-JSON assertion rejected it, so creating a new session/subagent failed with `forwarded host event "api-session/added" argument 0 is not lossless JSON data`. Fixed by sanitizing at the projection boundary (`toLosslessJson()` in `init()` + `wire.view()`) plus regression tests; isolated-host reproduction shows the old build fails from the **2nd consecutive new session** while the fixed build returns `ok:true` (zero model requests; since v0.6, `pnpm verify:host` creating ≥2 sessions in a row is the regression gate). Verification: lint green; 119 files / 1689 tests; coverage 86.18/76.23/86.88/89.26; build host 1.23MB / client 383.4KB; verify:package 39 files/1080.6KB; verify:client 18 slots pass.

## Known limitations (v0.7)

- **Repair-lane scope/verify can be inferred, but only heuristically**: v0.7 admission derives them from latest failed receipts, uncommitted changes, and project commands, and checks width/sensitive surfaces/dirty worktrees; it does not decide "this is a bug" and does not take responsibility on the agent's behalf. Runtime out-of-scope writes are still rejected by `R-FIX-SCOPE`; close-out still compares against the full `git status --untracked-files=all` and caps changed files at **20**. **Unrelated uncommitted changes present before opening the lane are rejected as out of scope** — commit/stash them first. Cross-module/high-risk work should use the change lane.
- **The repair-lane shell policy is governance, not a sandbox**: shape-based allow-list for test/build/lint/run and read-only/commit git commands, backed by the close-out scope check and full regression; use host sandboxing/containers for strong isolation.
- **observe only relaxes unplanned writes** (`R-NO-CHANGE`); stage/scope/protected-path rules still block when a change is active. **safe-mode is the only fully non-blocking mode**, it requires a restart, and you should not rely on gates while recovering.
- **`pnpm verify:host` needs a local DSH desktop install**: GitHub Actions runners have no DSH, so CI does not run it; the release checklist requires running it on a machine with DSH (see [docs/release/v0.1.0.md](docs/release/v0.1.0.md)).
- **Projection wire size**: panel blocks have count limits and a 256KiB per-frame budget, but an extreme `snapshot` can still exceed it; on-demand panel fetching (remote) is future work (see [projection-budget.md](docs/impl/projection-budget.md)).
- Desktop (Electron window) walkthroughs are still manual; real-host E2E evidence is web-host based ([docs/compat/host-smoke.md](docs/compat/host-smoke.md), [docs/screenshots](docs/screenshots/README.md)).

## Screenshots

Taken in a real DSH `0.2.1-rc.5` web host (isolated `flowgate-dev` profile). v0.2, 2026-11-01 — capture method and the zero-model-request disclosure are in [docs/screenshots/](docs/screenshots/README.md).

| Graphical input dock (seven-stage rail + next step; same width as the native content column) | Authorization card (click-to-authorize, composer empty; native plan-card style) |
|---|---|
| ![graphical dock](docs/screenshots/30-flow-dock-active.png) | ![authorization card](docs/screenshots/31-flow-auth-card.png) |

| After approving (G3 passed, stage S4) | Graphical flow page in the sidebar |
|---|---|
| ![approved](docs/screenshots/32-flow-approved.png) | ![flow page](docs/screenshots/33-panel-flow-map.png) |

| Subagent topology (workflow graph / tree) | Background jobs (exit code / live output / force kill) |
|---|---|
| ![subagent topology](docs/screenshots/34-panel-subagents-graph.png) | ![background jobs](docs/screenshots/36-panel-jobs.png) |

> 34–36 are **component-level populated evidence** (real components + real `--dsw-*` token CSS + fixtures; zero-model runs cannot produce real subagents/jobs), while real-host empty states/composition have a separate 22/22 assertion set; tree mode in [35-panel-subagents-tree.png](docs/screenshots/35-panel-subagents-tree.png). See [docs/screenshots/README.md](docs/screenshots/README.md) and [docs/impl/runtime-visualization.md](docs/impl/runtime-visualization.md).

| v0.5: auto-flow badge (dock + panel) | v0.4: panel after learning-mode removal |
|---|---|
| ![v0.5 auto-flow](docs/screenshots/38-panel-auto-flow-v05.png) | ![v0.4 panel](docs/screenshots/37-panel-pipeline-v04.png) |

Historical screenshots of the pre-v0.2 text status line and the 8-view panel remain under [docs/screenshots](docs/screenshots/README.md) (01–26).

## FAQ

**Can it lock me out?**
No dead ends: `/flow allow-once`, "add exception" in the panel, `/flow off` (recorded and counted in metrics), `/flow doctor`, and `/flow repair` (rebuild state from the ledger and artifacts). **If the plugin itself is broken (v0.6):** `pnpm host:recover --safe-mode` writes a sentinel → after a restart the plugin degrades to non-blocking (no uninstall needed); fix it, confirm with `pnpm verify:host`, then `--clear`. Keep `desktop` on stable releases, develop in an isolated `flowgate-dev`, dogfood from a packed tgz; the worst case is rolling back the tgz or recreating the dev profile (see [host-recovery.md](docs/impl/host-recovery.md), [dev-loop.md](docs/impl/dev-loop.md)).

**Do bug fixes need a change proposal?**
No (since v0.6). Known bugs / incident regressions use the **repair lane**: the agent calls `flow_fix_start` with the symptom, reproduces for RED evidence, fixes freely inside the declared scope, then turns the verify command GREEN and runs the full regression before auto-archiving. No seven-stage documents or human gates, but writes outside the scope are rejected by `R-FIX-SCOPE`, dangerous commands by `R-FIX-SHELL`, and the evidence chain is not weakened. **Since v0.7 it is even lighter**: scope/verify/title can be omitted and are derived from latest failed receipts, uncommitted changes, and project commands; deterministic admission blocks "feature disguised as a bug" (active change / sensitive surface / too-broad scope / dirty worktree are rejected with the correct recommended lane); `dryRun: true` previews the admission verdict. New features / requirement changes still use the change lane (fast route can accelerate it).

**What about false positives?**
There is a feedback loop: mark an interception as a false positive in the panel → allow once / add an exception (with a reason, revocable) / export evidence. The target is a false-positive rate (M-5) ≤ 5%; rules above that are downgraded to warnings and go into the retro (only after ≥ 20 intercepts; the downgrade allows that one action, logs `rule.hinted`, and enters the retro).

**What happens if I don't initialize?**
Nothing is gated. Gating is enabled only when `.flowgate/config.yaml` exists; the dock shows an "Enable FlowGate" authorization card that initializes it in one click (equivalent to `/flow init`).

**My stack isn't auto-detected.**
Detection covers Maven, Gradle, npm / pnpm / yarn, pytest, Go, and Cargo. If detection fails, write commands in `.flowgate/project.md` or override them under `commands:` in `config.yaml`. If the project genuinely has no tests, set `test: none`; the baseline falls back to build / type-check / lint and a "missing automated tests" risk is recorded automatically.

**Does it upload my code?**
No. It does not use the network, upload anything, or collect telemetry; the ledger, reports, and dashboard all live under the local `.flowgate/`.

**Where is state stored, and does it go into git?**
Everything lives in the project-root `.flowgate/`. By default the whole directory is git-ignored (the plugin writes its own `.gitignore` inside it and never edits the project-root `.gitignore`); optionally `git.commit_flowgate: true` commits most files except `state/`, `worktrees/`, and `dashboard.html`. Deleting the directory or running `git clean -x` loses all records.

**How does this relate to DSH plan mode and approvals?**
`dsh-plan-mode` does not restrict tools, and approvals govern "may I execute". FlowGate governs "should this happen now". They are complementary; sandboxes and approvals still work inside a governed session, but gate decisions do not depend on them.

**What is the token cost?**
Runtime context injection is bounded at ≤ 600 tokens per step, and test output is compressed to ≤ 400 tokens by default. The low-complexity fast lane and per-task context injection keep it down further. Process overhead (M-15) will be measured in the evaluation before tuning.

**Can it coexist with other plugins?**
Any plugin failure must not block host startup or affect other plugins; guard exceptions fail closed (that write is rejected with an explanation). In governed sessions native delegation tools are disabled so subagents can only be dispatched by FlowGate.

**Why not just use OpenSpec / Superpowers / gstack?**
Their methods are good, but they are prompt/workflow shaped and a model can bypass them. FlowGate adapts the methodology into host-level hard constraints while keeping OpenSpec's artifact format, so what you learn transfers back to the upstream tools.

## Development

```bash
pnpm install
pnpm lint        # layer lint + tsc --noEmit
pnpm test        # vitest
pnpm build       # tsdown
pnpm verify:package   # inspect the npm tarball (no host core packages; lib/ + skills/)
pnpm verify:client    # offline check of the browser bundle protocol + slot registrations
pnpm verify:compat    # compose/import the plugin in an isolated DSH_HOME (never the daily profile)
pnpm verify:uninstall # isolated-profile install/uninstall cleanliness (never the daily profile)
pnpm verify:host      # ★ real-host gate: isolated DSH host, creates sessions in a row, asserts no not-lossless-JSON
pnpm host:recover     # recovery CLI: --status / --safe-mode / --clear / --profile <p> --remove [--yes]
                      # (see --help; only writes the sentinel and audit log, never deletes project data)
pnpm measure:startup  # host entry module-load overhead (T6.2, target <200ms)
```

During development and trial installs use an isolated profile (see Quick start); verify in the isolated profile before regular use. See [examples/README.md](examples/README.md) for how to run the three benchmark repos.

## Documentation

- [00-总览与阅读指南](docs/00-总览与阅读指南.md): one-page overview, pipeline, learning map
- [02-需求规格说明](docs/02-需求规格说明.md): functional requirements, acceptance scenarios, metrics, v1.0 definition of done
- [03-技术方案](docs/03-技术方案.md): DSH extension points, state machine, rule engine, data formats, UI
- [04-执行方案](docs/04-执行方案.md): milestones, task cards, risks and mitigations
- [docs/method-sources.md](docs/method-sources.md): per-skill upstream provenance, what we rewrote, review cycle
- [docs/reference/](docs/reference/): official package references for DSH 0.2.1-rc.5
- [docs/impl/implementation-status.md](docs/impl/implementation-status.md): per-milestone delivery status and known gaps
- [docs/evaluation.md](docs/evaluation.md): with/without-plugin evaluation (18/18 + subjective scoring) plus from-scratch and dispatch comparisons
- [docs/impl/web-walkthrough.md](docs/impl/web-walkthrough.md): real web-host interaction walkthrough (preset switching, panel fallbacks, confirmation card)
- [docs/screenshots/](docs/screenshots/): real web-host screenshots (25)
- [docs/interview-notes.md](docs/interview-notes.md): interview / portfolio notes (capability → mechanism → metric → real story)

## License

MIT, see [LICENSE](LICENSE). Method provenance and third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
