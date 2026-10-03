# Flight Recorder — design spec

Date: 2026-10-03
Status: approved in brainstorming, pending written-spec review

## 1. Goal

A Claude Code plugin that shows, live, what Claude is doing in the current
session, and can export a clean log of it for review. Published publicly in
the Claude directory (developer portal, Plugin bundle).

Priorities, in order:

1. **Live watching** — glance at the screen and see what Claude is doing, so
   you can catch it going off track early.
2. **Review afterwards** — an on-demand Markdown log to read before commit or
   paste into a PR.

### Success criteria

- `claude plugin validate --strict` passes; its `calls:` list matches the
  README disclosure.
- `claude plugin test` passes.
- In a real session (`claude --plugin-dir .`): the band and pane update per
  tool call, each alert can be triggered, and export writes the expected file.
- Developer portal **Validate** reports no blocking findings.

## 2. Identity

- Plugin `name`: `stepscope` (working name; distinctive, kebab-case, no
  reserved words). Can change until the first public push, never after.
- `displayName`: `Stepscope — flight recorder for Claude Code`.
- Repository directory: `flight-recorder-plugin/` (plugin at the repo root).
- License: MIT. Initial `version`: `0.1.0`.
- Requires Claude Code v2.1.287 or later (mods).

## 3. Approach

A pure mod: one hooks module observes tool calls, keeps the timeline in
memory, draws a band and a pane, and adds one command. No settings hooks, no
MCP server, no external process, no network, no npm dependencies. The only
disk write is the user-requested export.

Rejected alternatives:

- Settings hooks writing JSONL plus a mod reading it: adds disk writes and
  scripts for review; auto-save was explicitly not wanted.
- Status line plus skill: works everywhere but has no pane or toast, which
  fails the "visual" goal.

## 4. Files

```
.claude-plugin/plugin.json     manifest + userConfig
hooks/hooks.json               { "modules": ["./register.ts"] }
hooks/register.ts              wiring only: on(...) calls, command, timers
src/timeline.ts                pure: step list, counters, append/finish, cap
src/labels.ts                  pure: tool input → short label + icon kind
src/alerts.ts                  pure: failure-loop, out-of-repo, long-step rules
src/render.ts                  pure: timeline → band tree / pane tree
src/export.ts                  pure: timeline → Markdown string
src/*.test.ts                  unit tests (claude plugin test)
hooks/register.test.ts         hook-level tests
README.md
LICENSE
```

Only `hooks/register.ts` touches the mods API (`$`). Everything in `src/` is
pure functions over plain data, so it is testable without a session. Render
functions take an element factory (from `$.ui.resolve(e)`) as an argument
rather than importing it.

## 5. Data model

```ts
type StepStatus = 'running' | 'ok' | 'fail'
type StepKind = 'edit' | 'bash' | 'read' | 'other'

interface Step {
  id: string            // tool call id
  tool: string          // e.g. "Edit", "Bash"
  kind: StepKind
  label: string         // file path, command (first 60 chars), or tool name
  path?: string         // absolute path for edit-kind steps
  startedAt: number     // ms epoch
  durationMs?: number
  status: StepStatus
  error?: string        // first line of the failure, max 200 chars
}

interface Timeline {
  steps: Step[]         // oldest first, capped at 2,000
  dropped: number       // count of steps removed by the cap
  sessionStartedAt: number
}
```

Counters shown in the UI (steps, edits, fails, elapsed) are derived from the
timeline, not stored.

### Labels (`src/labels.ts`)

| Tool | kind | label |
| --- | --- | --- |
| `Edit`, `Write`, `NotebookEdit` | `edit` | file path, relative to session root when inside it |
| `Bash` | `bash` | command, whitespace collapsed, first 60 chars |
| `Read`, `Grep`, `Glob` | `read` | file path or pattern |
| anything else (MCP tools, Task, etc.) | `other` | tool name |

Icons: `✎` edit, `$` bash, `◎` read, `·` other.

## 6. Event flow

On `tool.call` (all tools):

1. Append a `running` step; `$.ui.invalidate('ui.render')`; start the
   long-step ticker if not running.
2. `const result = await next(e)`.
3. Finish the step: `ok` or `fail` from the result, set `durationMs`, run
   alert rules, invalidate.
4. Return `result` unchanged.

If `next(e)` throws, mark the step `fail` and rethrow the same error.
Recorder logic around `next` is wrapped in `try/catch` so that a recorder bug
never blocks, denies or changes a tool call. Every registration gets a
`.catch` that logs via `$.ui.log` and passes the event through.

How a result maps to `fail` (error flag / non-zero Bash exit) is read from
the result shape declared in the Claude Code type declarations for the
installed build; this is confirmed at implementation time against
`claude-code.d.ts`, not guessed.

On `session.end`: reset the timeline and stop the ticker.

Timeline cap: when `steps.length` would exceed 2,000, drop the oldest and
increment `dropped`. The pane shows `+N earlier steps` at the top.

## 7. Interface

### Band (`ui.render`, component `AbovePrompt`)

One row, truncated to `e.props.bodyColumns`:

```
● 12 steps · 4 edits · 1 fail · 3m12s · now: $ npm test (8s)
```

- Dot colour: green idle; cyan while a step runs; red when the last finished
  step failed; amber when the running step exceeded the long-step threshold.
- `now:` segment appears only while a step runs.
- Hidden until the first step is recorded.
- The hook calls `next(e)` and adds the row; it never replaces other mods'
  band content.

### Pane (`ui.render`, component `Pane`, id `flight-recorder`)

- Header: counters and two buttons, `Export` and `Clear`.
- One row per step: `HH:MM:SS  icon  label  duration  ✓/✗`.
- Failed rows red, running row cyan. Newest at the bottom; auto-scroll to it.
- Narrow widths: drop the duration column first, then timestamps.
- Opened only by the user (`/fr` or a button), never automatically.

### Where nothing draws

When `$.session.surfaces()` reports no drawing surface (VS Code chat panel,
`claude -p`), `/fr` replies with a text summary (counters plus last 10
steps) instead of opening the pane. Alerts fall back to `$.ui.notice`.

## 8. Alerts (`src/alerts.ts`)

Rules are pure: `(timeline, newStep, config, root) → Alert | null`.

| Alert | Trigger | Output | Repeat |
| --- | --- | --- | --- |
| Repeat-failure loop | Same normalized Bash command fails `failStreak` times in a row (default 3). Normalization: trim and collapse whitespace. Any success or different command resets the streak. | Toast: `Same command failed 3× — Claude may be stuck: <label>` | Once per streak |
| Out-of-repo write | An `edit`-kind step's resolved absolute path is outside `$.session.root()` | Toast: `Edit outside the project: <path>` | Once per path per session |
| Long step | Running step older than `longStepSeconds` (default 60) | Band dot turns amber; no toast | While running |

Path check: resolve against the session cwd, normalize `.` and `..`, then
check prefix with a trailing separator (so `/repo-other` is not inside
`/repo`). Symlinks are not resolved (no filesystem access in the pure rule).

Long-step ticker: `$.clock.every(1000, …)` runs only while a step is
`running`; it invalidates the band and is cancelled when no step runs.

## 9. Configuration (`userConfig` in plugin.json)

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `failStreak` | number | 3 | Failures in a row before the loop alert |
| `longStepSeconds` | number | 60 | Seconds before a running step turns amber |
| `showBand` | boolean | true | Turn the band off and use only the pane |

## 10. Commands

Registered with `$.command.register`; they run instantly with no Claude turn.

| Command | Effect |
| --- | --- |
| `/fr` | Toggle the pane (text summary where nothing draws) |
| `/fr export [path]` | Write the Markdown log. Default path: `flight-recorder-<YYYYMMDD-HHMM>.md` in the session root. Refuses to overwrite an existing file. Replies with the written path or the error. |
| `/fr clear` | Reset the timeline |

### Export format (`src/export.ts`)

```markdown
# Session log — 2026-10-03 14:02–14:05

12 steps · 4 edits · 1 failure · 3m12s

| Time | Step | Result | Duration |
| --- | --- | --- | --- |
| 14:02:10 | Edit src/api.ts | ok | 0.1s |
| 14:02:12 | Bash npm test | FAIL | 8.4s |

## Files changed
- src/api.ts (2 edits)

## Failures
- 14:02:12 `npm test` — <first line of error>
```

Pipe characters in labels are escaped. The `Files changed` list comes from
`edit`-kind steps, grouped by path, with counts.

## 11. Error handling

- Recorder failures never affect tool calls (see section 6).
- Export errors (invalid path, existing file, write failure) are reported in
  the command reply; the timeline is kept.
- `$.fs.write` is called only from the export command.

## 12. Testing

Unit tests (`claude plugin test`, pure modules):

- timeline: append, finish ok/fail, duration, cap and `dropped` count
- labels: each tool row in section 5, truncation, relative paths
- alerts: streak of 3 fires once; success resets; different command resets;
  out-of-repo for `..`, absolute outside path, sibling-prefix dir; inside
  paths do not fire; long-step threshold boundary
- render: band text and truncation; dot colour per state; pane column
  dropping at narrow widths
- export: snapshot of a fixed timeline; pipe escaping; files-changed grouping

Hook-level tests (mods test harness, `hooks/register.test.ts`):

- a fake successful `tool.call` records an `ok` step and returns the result
  unchanged
- a fake failing call records `fail`; a throwing call rethrows the same error
- `/fr export` writes a file; a second export to the same path is refused

Manual check before release:

- `claude --plugin-dir ./flight-recorder-plugin`, run a real task, confirm
  band, pane, each alert, export, and `/fr clear`.

## 13. Release

1. `claude plugin validate --strict` passes; `calls:` line lists only
   `ui.*`, `command.register`, `session.*`, `clock.*`, `fs.write`.
2. README (40+ words outside code blocks): what it does, screenshot, commands,
   config, a "What it reads and writes" section (observes tool calls in
   memory; no network; no processes; writes a file only on `/fr export`),
   requirement Claude Code ≥ 2.1.287.
3. `plugin.json`: `name`, `displayName`, `description`, `author`, `version`,
   `license`, `homepage`, `repository`.
4. No `.DS_Store` or binaries other than the PNG screenshot; every file under
   256 KiB.
5. Push to a public GitHub repo; developer portal → Submit new → Plugin
   bundle → Validate → fix blocking findings → submit.

## 14. Out of scope for v1

- Auto-saving history and browsing past sessions
- Edit-churn alert
- Multi-session or subagent-aware views
- Diff preview inside the pane
