# Stepscope (Flight Recorder) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code mod that records every tool call of the session as a live timeline (band above the prompt + toggleable pane), raises three alerts, and exports a Markdown log on demand.

**Architecture:** One hooks module (`hooks/register.tsx`) wires Claude Code events to pure modules in `src/`. The pure modules hold all logic (timeline, labels, paths, alerts, view models, Markdown export) and never touch the mods API, so they are unit-tested directly. The hooks module turns view models into elements and is covered by kit tests (`claude-code/testing`).

**Tech Stack:** TypeScript loaded directly by Claude Code ≥ 2.1.287 (no build step, no npm dependencies); JSX with the engine's global `h`; `claude plugin test`; `claude plugin validate --strict`.

**Spec:** `docs/superpowers/specs/2026-10-03-flight-recorder-design.md`

## Global Constraints

- Claude Code v2.1.287 or later. Types for the build are written to `.claude-plugin/types/` when the mod loads with `--plugin-dir`; trust them over docs.
- No npm dependencies, no `package.json`, no lockfile, no launchers (`npx`, `uvx`).
- Mods API calls allowed: `$.ui.*`, `$.command.register`, `$.session.cwd/root/surfaces`, `$.clock.now/every`, `$.fs.exists/write`. No `$.http`, `$.process`, `$.model`, `$.store`, `$.env`.
- `$.fs.write` only from the export path.
- Hook rules (static analysis): write every mods API call in full as `$.ns.method(...)`; never assign or destructure `$` or a namespace; event names are string literals; import only relative files and `claude-code`; `$` may be passed only to functions declared at the top level of `register.tsx`.
- Never declare `h` or `Fragment` in a file that uses JSX.
- Recorder logic must never block, deny or change a tool call: return what `next(e)` resolved to, rethrow what it threw.
- Plugin `name`: `stepscope`. Pane id: `flight-recorder`. Command: `/fr`.
- Files under 256 KiB; plain text only (plus one PNG screenshot later); plugin at repo root.
- Defaults: `failStreak` 3, `longStepSeconds` 60, `showBand` true. Timeline cap 2,000 steps. Label max 60 chars.

## Review Focus

- A tool call whose `next(e)` throws (interrupt, engine error): the step must end as `fail` and the same error must propagate — test in Task 6.
- Parallel tool calls (several `running` at once): band must show the newest running one, and each finishes independently — test in Task 2 (`currentStep`) and Task 6.
- `/fr export` with a path containing spaces or `..`: path resolves against the session root, existing files are never overwritten — test in Task 6.
- A sibling directory sharing the root's prefix (`/repo-other` vs `/repo`) must count as outside — test in Task 3.
- Very narrow terminals (band width < 10, pane width < 40): no crash, no negative widths — test in Task 4.

## File Map

| File | Responsibility |
| --- | --- |
| `.claude-plugin/plugin.json` | Manifest, `userConfig` |
| `hooks/hooks.json` | Points to the hooks module |
| `hooks/register.tsx` | Event wiring, commands, drawing; only file using `$` |
| `src/format.ts` | `formatDuration`, `formatClock`, `truncate`, `plural` |
| `src/timeline.ts` | Step/Timeline types, append/finish/cap, counts, current/last step |
| `src/paths.ts` | `resolvePath`, `isInside`, `relativeTo` (POSIX) |
| `src/labels.ts` | Tool call → `StepInfo` (kind, label, path, command), icons |
| `src/alerts.ts` | Out-of-repo, failure streak, long-step rules |
| `src/render.ts` | Band segments, pane view, text summary (view models) |
| `src/export.ts` | Markdown export and default file name |
| `tests/*.test.ts` | Unit tests per module + `register.test.ts` kit tests |
| `README.md`, `LICENSE` | Listing text, disclosure, MIT |

Note: the spec listed tests as `src/*.test.ts`; they live in `tests/` because the generated `tsconfig.json` includes `tests/`.

---

### Task 1: Scaffold, format helpers, timeline

**Files:**
- Create: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx` (stub), `.gitignore`
- Create: `src/format.ts`, `src/timeline.ts`
- Test: `tests/format.test.ts`, `tests/timeline.test.ts`

**Interfaces:**
- Produces:
  - `formatDuration(ms: number): string`, `formatClock(epochMs: number): string`, `truncate(text: string, width: number): string`, `plural(n: number, word: string, many?: string): string`
  - `type StepStatus = 'running' | 'ok' | 'fail'`, `type StepKind = 'edit' | 'bash' | 'read' | 'other'`
  - `interface StepInfo { id: string; tool: string; kind: StepKind; label: string; path?: string; command?: string }`
  - `interface Step extends StepInfo { startedAt: number; durationMs?: number; status: StepStatus; error?: string }`
  - `interface Timeline { steps: Step[]; dropped: number; firstStepAt?: number }`
  - `MAX_STEPS = 2000`, `createTimeline(): Timeline`, `startStep(t, info, now): Step`, `finishStep(step, status: 'ok' | 'fail', now, error?): void`
  - `interface Counts { steps: number; edits: number; fails: number; elapsedMs: number }`, `counts(t, now): Counts`, `currentStep(t): Step | undefined`, `lastFinished(t): Step | undefined`

- [ ] **Step 1: Scaffold the plugin**

`.claude-plugin/plugin.json`:
```json
{
  "name": "stepscope",
  "displayName": "Stepscope — flight recorder for Claude Code",
  "version": "0.1.0",
  "description": "Live timeline of every tool call Claude makes: a band above the prompt, a timeline pane, alerts when Claude loops or edits outside the project, and a Markdown export for review.",
  "author": { "name": "5d0tal1gat0r" },
  "license": "MIT",
  "homepage": "https://github.com/5d0tal1gat0r/stepscope",
  "repository": "https://github.com/5d0tal1gat0r/stepscope",
  "keywords": ["mod", "timeline", "observability", "review"],
  "userConfig": {
    "failStreak": {
      "type": "number",
      "title": "Failure streak",
      "description": "Failures in a row of the same shell command before the loop alert",
      "default": 3
    },
    "longStepSeconds": {
      "type": "number",
      "title": "Long step (seconds)",
      "description": "Seconds before a running step turns the band amber",
      "default": 60
    },
    "showBand": {
      "type": "boolean",
      "title": "Show band",
      "description": "Show the one-line summary above the prompt",
      "default": true
    }
  }
}
```

`hooks/hooks.json`:
```json
{
  "description": "Stepscope hooks module",
  "modules": ["./register.tsx"]
}
```

`hooks/register.tsx` (stub, replaced in Task 6):
```tsx
export function register(on) {
  on('tool.call', async ($, e, next) => next(e))
}
```

`.gitignore`:
```
.claude-plugin/types/
tsconfig.json
flight-recorder-*.md
```

- [ ] **Step 2: Validate the scaffold**

Run: `claude plugin validate .`
Expected: `✔ Validation passed` (warnings allowed). If `userConfig` `number`/`boolean` types are rejected, switch those fields to `"type": "string"` and parse with `Number(...)` / `!== 'false'` in Task 6; record the change in the commit message.

- [ ] **Step 3: Write failing tests for format helpers**

`tests/format.test.ts`:
```ts
import { expect, test } from 'claude-code/testing'
import { formatClock, formatDuration, plural, truncate } from '../src/format.ts'

test('formatDuration uses tenths under 10s, seconds under 1m, then m+s', async () => {
  expect(formatDuration(100)).toBe('0.1s')
  expect(formatDuration(8400)).toBe('8.4s')
  expect(formatDuration(42_000)).toBe('42s')
  expect(formatDuration(192_000)).toBe('3m12s')
  expect(formatDuration(3_725_000)).toBe('1h02m')
})

test('formatClock pads local time', async () => {
  expect(formatClock(new Date(2026, 9, 3, 4, 2, 9).getTime())).toBe('04:02:09')
})

test('truncate adds an ellipsis and never goes negative', async () => {
  expect(truncate('abcdef', 10)).toBe('abcdef')
  expect(truncate('abcdef', 4)).toBe('abc…')
  expect(truncate('abcdef', 1)).toBe('…')
  expect(truncate('abcdef', 0)).toBe('')
  expect(truncate('abcdef', -3)).toBe('')
})

test('plural picks singular for one', async () => {
  expect(plural(1, 'step')).toBe('1 step')
  expect(plural(2, 'step')).toBe('2 steps')
  expect(plural(0, 'failure')).toBe('0 failures')
})
```

- [ ] **Step 4: Run to see it fail**

Run: `claude plugin test`
Expected: FAIL (cannot resolve `../src/format.ts`).

- [ ] **Step 5: Implement `src/format.ts`**

```ts
export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms)
  if (safe < 10_000) return (Math.round(safe / 100) / 10).toFixed(1) + 's'
  const totalSeconds = Math.floor(safe / 1000)
  if (totalSeconds < 60) return totalSeconds + 's'
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return minutes + 'm' + String(totalSeconds % 60).padStart(2, '0') + 's'
  return Math.floor(minutes / 60) + 'h' + String(minutes % 60).padStart(2, '0') + 'm'
}

export function formatClock(epochMs: number): string {
  const d = new Date(epochMs)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

export function truncate(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length <= width) return text
  if (width === 1) return '…'
  return text.slice(0, width - 1) + '…'
}

export function plural(n: number, word: string, many: string = word + 's'): string {
  return n + ' ' + (n === 1 ? word : many)
}
```

- [ ] **Step 6: Write failing timeline tests**

`tests/timeline.test.ts`:
```ts
import { expect, test } from 'claude-code/testing'
import { MAX_STEPS, counts, createTimeline, currentStep, finishStep, lastFinished, startStep } from '../src/timeline.ts'

const info = (id: string, kind: 'edit' | 'bash' | 'read' | 'other' = 'bash') =>
  ({ id, tool: kind === 'edit' ? 'Edit' : 'Bash', kind, label: id })

test('start and finish a step', async () => {
  const t = createTimeline()
  const s = startStep(t, info('a'), 1000)
  expect(s.status).toBe('running')
  expect(t.firstStepAt).toBe(1000)
  finishStep(s, 'ok', 1500)
  expect(s.status).toBe('ok')
  expect(s.durationMs).toBe(500)
})

test('failure keeps the first non-empty line of the error, max 200 chars', async () => {
  const t = createTimeline()
  const s = startStep(t, info('a'), 0)
  finishStep(s, 'fail', 10, '\n  Exit code 1\nmore')
  expect(s.error).toBe('Exit code 1')
  const s2 = startStep(t, info('b'), 0)
  finishStep(s2, 'fail', 10, 'x'.repeat(500))
  expect(s2.error?.length).toBe(200)
})

test('cap drops oldest and counts them', async () => {
  const t = createTimeline()
  for (let i = 0; i < MAX_STEPS + 5; i++) startStep(t, info('s' + i), i)
  expect(t.steps.length).toBe(MAX_STEPS)
  expect(t.dropped).toBe(5)
  expect(t.steps[0]?.id).toBe('s5')
})

test('counts derive steps, edits, fails, elapsed', async () => {
  const t = createTimeline()
  finishStep(startStep(t, info('e1', 'edit'), 1000), 'ok', 1100)
  finishStep(startStep(t, info('b1'), 2000), 'fail', 2100)
  startStep(t, info('b2'), 3000)
  expect(counts(t, 5000)).toEqual({ steps: 3, edits: 1, fails: 1, elapsedMs: 4000 })
  expect(counts(createTimeline(), 5000)).toEqual({ steps: 0, edits: 0, fails: 0, elapsedMs: 0 })
})

test('currentStep is the newest running step; parallel steps finish independently', async () => {
  const t = createTimeline()
  const a = startStep(t, info('a'), 0)
  const b = startStep(t, info('b'), 1)
  expect(currentStep(t)?.id).toBe('b')
  finishStep(b, 'ok', 2)
  expect(currentStep(t)?.id).toBe('a')
  expect(lastFinished(t)?.id).toBe('b')
  finishStep(a, 'fail', 3)
  expect(currentStep(t)).toBeUndefined()
  expect(lastFinished(t)?.id).toBe('a')
})
```

Note: `lastFinished` is the most recently **finished** step (largest `startedAt + durationMs`), not the last in list order.

- [ ] **Step 7: Run to see it fail**

Run: `claude plugin test`
Expected: format tests PASS, timeline tests FAIL (module missing).

- [ ] **Step 8: Implement `src/timeline.ts`**

```ts
export type StepStatus = 'running' | 'ok' | 'fail'
export type StepKind = 'edit' | 'bash' | 'read' | 'other'

export interface StepInfo {
  id: string
  tool: string
  kind: StepKind
  label: string
  path?: string
  command?: string
}

export interface Step extends StepInfo {
  startedAt: number
  durationMs?: number
  status: StepStatus
  error?: string
}

export interface Timeline {
  steps: Step[]
  dropped: number
  firstStepAt?: number
}

export interface Counts {
  steps: number
  edits: number
  fails: number
  elapsedMs: number
}

export const MAX_STEPS = 2000

export function createTimeline(): Timeline {
  return { steps: [], dropped: 0 }
}

export function startStep(t: Timeline, info: StepInfo, now: number): Step {
  const step: Step = { ...info, startedAt: now, status: 'running' }
  if (t.firstStepAt === undefined) t.firstStepAt = now
  t.steps.push(step)
  const extra = t.steps.length - MAX_STEPS
  if (extra > 0) {
    t.steps.splice(0, extra)
    t.dropped += extra
  }
  return step
}

export function finishStep(step: Step, status: 'ok' | 'fail', now: number, error?: string): void {
  step.status = status
  step.durationMs = Math.max(0, now - step.startedAt)
  if (error) step.error = firstLine(error, 200)
}

function firstLine(text: string, max: number): string {
  const line = text.split('\n').find(l => l.trim() !== '') ?? ''
  return line.trim().slice(0, max)
}

export function counts(t: Timeline, now: number): Counts {
  let edits = 0
  let fails = 0
  for (const s of t.steps) {
    if (s.kind === 'edit') edits++
    if (s.status === 'fail') fails++
  }
  return {
    steps: t.steps.length + t.dropped,
    edits,
    fails,
    elapsedMs: t.firstStepAt === undefined ? 0 : Math.max(0, now - t.firstStepAt),
  }
}

export function currentStep(t: Timeline): Step | undefined {
  for (let i = t.steps.length - 1; i >= 0; i--) {
    const s = t.steps[i]
    if (s && s.status === 'running') return s
  }
  return undefined
}

export function lastFinished(t: Timeline): Step | undefined {
  let best: Step | undefined
  let bestEnd = -Infinity
  for (const s of t.steps) {
    if (s.status === 'running') continue
    const end = s.startedAt + (s.durationMs ?? 0)
    if (end >= bestEnd) {
      best = s
      bestEnd = end
    }
  }
  return best
}
```

- [ ] **Step 9: Run tests**

Run: `claude plugin test`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add .claude-plugin/plugin.json hooks src tests .gitignore
git commit -m "feat: scaffold stepscope mod with timeline and format helpers"
```

---

### Task 2: Paths and labels

**Files:**
- Create: `src/paths.ts`, `src/labels.ts`
- Test: `tests/paths.test.ts`, `tests/labels.test.ts`

**Interfaces:**
- Consumes: `StepInfo`, `StepKind` (Task 1), `truncate` (Task 1)
- Produces:
  - `resolvePath(p: string, base: string): string`, `isInside(path: string, root: string): boolean`, `relativeTo(path: string, root: string): string`
  - `LABEL_MAX = 60`, `ICONS: Record<StepKind, string>`, `normalizeCommand(cmd: string): string`
  - `describeCall(id: string, tool: string, input: Record<string, unknown>, cwd: string, root: string): StepInfo`

- [ ] **Step 1: Write failing path tests**

`tests/paths.test.ts`:
```ts
import { expect, test } from 'claude-code/testing'
import { isInside, relativeTo, resolvePath } from '../src/paths.ts'

test('resolvePath handles relative, dot segments and absolute', async () => {
  expect(resolvePath('src/a.ts', '/repo')).toBe('/repo/src/a.ts')
  expect(resolvePath('./src/../b.ts', '/repo/')).toBe('/repo/b.ts')
  expect(resolvePath('../../etc/x', '/repo/sub')).toBe('/etc/x')
  expect(resolvePath('/abs/x', '/repo')).toBe('/abs/x')
  expect(resolvePath('../../../..', '/a')).toBe('/')
  expect(resolvePath('my notes.md', '/repo')).toBe('/repo/my notes.md')
})

test('isInside respects segment boundaries', async () => {
  expect(isInside('/repo/src/a.ts', '/repo')).toBe(true)
  expect(isInside('/repo', '/repo')).toBe(true)
  expect(isInside('/repo-other/a.ts', '/repo')).toBe(false)
  expect(isInside('/etc/passwd', '/repo/')).toBe(false)
})

test('isInside never flags non-POSIX paths', async () => {
  expect(isInside('C:\\x\\a.ts', 'C:\\repo')).toBe(true)
})

test('relativeTo strips the root only when inside', async () => {
  expect(relativeTo('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
  expect(relativeTo('/other/a.ts', '/repo')).toBe('/other/a.ts')
})
```

- [ ] **Step 2: Run to see it fail**

Run: `claude plugin test`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/paths.ts`**

```ts
export function resolvePath(p: string, base: string): string {
  const abs = p.startsWith('/') ? p : base.replace(/\/+$/, '') + '/' + p
  const out: string[] = []
  for (const part of abs.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

export function isInside(path: string, root: string): boolean {
  if (!path.startsWith('/') || !root.startsWith('/')) return true
  const r = resolvePath(root, '/')
  if (r === '/') return true
  const p = resolvePath(path, '/')
  return p === r || p.startsWith(r + '/')
}

export function relativeTo(path: string, root: string): string {
  if (!path.startsWith('/') || !root.startsWith('/')) return path
  const r = resolvePath(root, '/')
  return path.startsWith(r + '/') ? path.slice(r.length + 1) : path
}
```

- [ ] **Step 4: Write failing label tests**

`tests/labels.test.ts`:
```ts
import { expect, test } from 'claude-code/testing'
import { ICONS, LABEL_MAX, describeCall, normalizeCommand } from '../src/labels.ts'

test('edit tools resolve the path and label it relative to root', async () => {
  const s = describeCall('1', 'Edit', { file_path: 'src/api.ts' }, '/repo', '/repo')
  expect(s).toEqual({ id: '1', tool: 'Edit', kind: 'edit', label: 'src/api.ts', path: '/repo/src/api.ts' })
  const w = describeCall('2', 'Write', { file_path: '/tmp/x.md' }, '/repo', '/repo')
  expect(w.label).toBe('/tmp/x.md')
  const n = describeCall('3', 'NotebookEdit', { notebook_path: '/repo/n.ipynb' }, '/repo', '/repo')
  expect(n.kind).toBe('edit')
  expect(n.label).toBe('n.ipynb')
})

test('bash collapses whitespace and truncates', async () => {
  const s = describeCall('1', 'Bash', { command: '  npm   test\n -- --watch=false ' }, '/r', '/r')
  expect(s.kind).toBe('bash')
  expect(s.command).toBe('npm test -- --watch=false')
  expect(s.label).toBe('npm test -- --watch=false')
  const long = describeCall('2', 'Bash', { command: 'x'.repeat(100) }, '/r', '/r')
  expect(long.label.length).toBe(LABEL_MAX)
  expect(long.command?.length).toBe(100)
})

test('read tools use path or pattern', async () => {
  expect(describeCall('1', 'Read', { file_path: '/r/a.ts' }, '/r', '/r').label).toBe('a.ts')
  expect(describeCall('2', 'Grep', { pattern: 'TODO' }, '/r', '/r').label).toBe('TODO')
  expect(describeCall('3', 'Glob', { pattern: '**/*.ts' }, '/r', '/r').kind).toBe('read')
})

test('other tools and missing input fall back to the tool name', async () => {
  expect(describeCall('1', 'mcp__x__y', {}, '/r', '/r')).toEqual({ id: '1', tool: 'mcp__x__y', kind: 'other', label: 'mcp__x__y' })
  expect(describeCall('2', 'Edit', {}, '/r', '/r').label).toBe('Edit')
  expect(describeCall('3', 'Bash', {}, '/r', '/r').label).toBe('Bash')
})

test('normalizeCommand and icons', async () => {
  expect(normalizeCommand(' a \t b ')).toBe('a b')
  expect(ICONS).toEqual({ edit: '✎', bash: '$', read: '◎', other: '·' })
})
```

- [ ] **Step 5: Run to see it fail**

Run: `claude plugin test`
Expected: label tests FAIL (module missing).

- [ ] **Step 6: Implement `src/labels.ts`**

```ts
import { truncate } from './format.ts'
import { relativeTo, resolvePath } from './paths.ts'
import type { StepInfo, StepKind } from './timeline.ts'

export const LABEL_MAX = 60

export const ICONS: Record<StepKind, string> = { edit: '✎', bash: '$', read: '◎', other: '·' }

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])

export function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, ' ')
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key]
  return typeof v === 'string' && v !== '' ? v : undefined
}

export function describeCall(
  id: string,
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  root: string,
): StepInfo {
  if (EDIT_TOOLS.has(tool)) {
    const raw = str(input, 'file_path') ?? str(input, 'notebook_path')
    if (!raw) return { id, tool, kind: 'edit', label: tool }
    const path = resolvePath(raw, cwd)
    return { id, tool, kind: 'edit', label: truncate(relativeTo(path, root), LABEL_MAX), path }
  }
  if (tool === 'Bash') {
    const command = normalizeCommand(str(input, 'command') ?? '')
    if (!command) return { id, tool, kind: 'bash', label: tool }
    return { id, tool, kind: 'bash', label: truncate(command, LABEL_MAX), command }
  }
  if (READ_TOOLS.has(tool)) {
    const target = str(input, 'file_path') ?? str(input, 'pattern') ?? str(input, 'path') ?? tool
    return { id, tool, kind: 'read', label: truncate(relativeTo(target, root), LABEL_MAX) }
  }
  return { id, tool, kind: 'other', label: truncate(tool, LABEL_MAX) }
}
```

- [ ] **Step 7: Run tests**

Run: `claude plugin test`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/paths.ts src/labels.ts tests/paths.test.ts tests/labels.test.ts
git commit -m "feat: describe tool calls as labelled steps"
```

---

### Task 3: Alerts

**Files:**
- Create: `src/alerts.ts`
- Test: `tests/alerts.test.ts`

**Interfaces:**
- Consumes: `Step` (Task 1), `isInside` (Task 2)
- Produces:
  - `interface AlertConfig { failStreak: number; longStepSeconds: number }`, `DEFAULT_CONFIG: AlertConfig`
  - `interface AlertState { streakCommand?: string; streakCount: number; streakFired: boolean; warnedPaths: Set<string> }`, `createAlertState(): AlertState`
  - `onStepStart(state, step, root): string | null` (out-of-repo toast text)
  - `onStepFinish(state, step, cfg): string | null` (loop toast text)
  - `isSlow(step, now, cfg): boolean`

- [ ] **Step 1: Write failing tests**

`tests/alerts.test.ts`:
```ts
import { expect, test } from 'claude-code/testing'
import { DEFAULT_CONFIG, createAlertState, isSlow, onStepFinish, onStepStart } from '../src/alerts.ts'
import type { Step } from '../src/timeline.ts'

const bash = (command: string, status: 'ok' | 'fail'): Step =>
  ({ id: command, tool: 'Bash', kind: 'bash', label: command, command, startedAt: 0, status })
const edit = (path: string): Step =>
  ({ id: path, tool: 'Edit', kind: 'edit', label: path, path, startedAt: 0, status: 'running' })

test('loop alert fires once at the streak threshold', async () => {
  const st = createAlertState()
  expect(onStepFinish(st, bash('npm test', 'fail'), DEFAULT_CONFIG)).toBeNull()
  expect(onStepFinish(st, bash('npm test', 'fail'), DEFAULT_CONFIG)).toBeNull()
  expect(onStepFinish(st, bash('npm test', 'fail'), DEFAULT_CONFIG))
    .toBe('Same command failed 3× — Claude may be stuck: npm test')
  expect(onStepFinish(st, bash('npm test', 'fail'), DEFAULT_CONFIG)).toBeNull()
})

test('a success or a different command resets the streak', async () => {
  const st = createAlertState()
  onStepFinish(st, bash('a', 'fail'), DEFAULT_CONFIG)
  onStepFinish(st, bash('a', 'fail'), DEFAULT_CONFIG)
  onStepFinish(st, bash('a', 'ok'), DEFAULT_CONFIG)
  expect(onStepFinish(st, bash('a', 'fail'), DEFAULT_CONFIG)).toBeNull()
  onStepFinish(st, bash('b', 'fail'), DEFAULT_CONFIG)
  expect(st.streakCommand).toBe('b')
  expect(st.streakCount).toBe(1)
})

test('non-bash steps do not touch the streak', async () => {
  const st = createAlertState()
  onStepFinish(st, bash('a', 'fail'), DEFAULT_CONFIG)
  const read: Step = { id: 'r', tool: 'Read', kind: 'read', label: 'x', startedAt: 0, status: 'fail' }
  expect(onStepFinish(st, read, DEFAULT_CONFIG)).toBeNull()
  expect(st.streakCount).toBe(1)
})

test('custom threshold is honoured', async () => {
  const st = createAlertState()
  const cfg = { ...DEFAULT_CONFIG, failStreak: 1 }
  expect(onStepFinish(st, bash('x', 'fail'), cfg)).toBe('Same command failed 1× — Claude may be stuck: x')
})

test('out-of-repo alert fires once per path, never inside root', async () => {
  const st = createAlertState()
  expect(onStepStart(st, edit('/repo/a.ts'), '/repo')).toBeNull()
  expect(onStepStart(st, edit('/repo-other/a.ts'), '/repo')).toBe('Edit outside the project: /repo-other/a.ts')
  expect(onStepStart(st, edit('/repo-other/a.ts'), '/repo')).toBeNull()
  expect(onStepStart(st, edit('/etc/hosts'), '/repo')).toBe('Edit outside the project: /etc/hosts')
  expect(onStepStart(st, bash('rm x', 'ok'), '/repo')).toBeNull()
})

test('isSlow at the threshold boundary', async () => {
  const s: Step = { ...bash('x', 'ok'), status: 'running', startedAt: 1000 }
  expect(isSlow(s, 1000 + 59_999, DEFAULT_CONFIG)).toBe(false)
  expect(isSlow(s, 1000 + 60_000, DEFAULT_CONFIG)).toBe(true)
  expect(isSlow({ ...s, status: 'ok' }, 1_000_000, DEFAULT_CONFIG)).toBe(false)
})
```

- [ ] **Step 2: Run to see it fail**

Run: `claude plugin test`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/alerts.ts`**

```ts
import { isInside } from './paths.ts'
import type { Step } from './timeline.ts'

export interface AlertConfig {
  failStreak: number
  longStepSeconds: number
}

export const DEFAULT_CONFIG: AlertConfig = { failStreak: 3, longStepSeconds: 60 }

export interface AlertState {
  streakCommand?: string
  streakCount: number
  streakFired: boolean
  warnedPaths: Set<string>
}

export function createAlertState(): AlertState {
  return { streakCount: 0, streakFired: false, warnedPaths: new Set() }
}

export function onStepStart(state: AlertState, step: Step, root: string): string | null {
  if (step.kind !== 'edit' || !step.path) return null
  if (isInside(step.path, root) || state.warnedPaths.has(step.path)) return null
  state.warnedPaths.add(step.path)
  return 'Edit outside the project: ' + step.path
}

export function onStepFinish(state: AlertState, step: Step, cfg: AlertConfig): string | null {
  if (step.kind !== 'bash') return null
  if (step.status !== 'fail') {
    state.streakCommand = undefined
    state.streakCount = 0
    state.streakFired = false
    return null
  }
  if (step.command !== state.streakCommand) {
    state.streakCommand = step.command
    state.streakCount = 1
    state.streakFired = false
  } else {
    state.streakCount++
  }
  if (state.streakCount >= cfg.failStreak && !state.streakFired) {
    state.streakFired = true
    return 'Same command failed ' + state.streakCount + '× — Claude may be stuck: ' + step.label
  }
  return null
}

export function isSlow(step: Step, now: number, cfg: AlertConfig): boolean {
  return step.status === 'running' && now - step.startedAt >= cfg.longStepSeconds * 1000
}
```

- [ ] **Step 4: Run tests**

Run: `claude plugin test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/alerts.ts tests/alerts.test.ts
git commit -m "feat: add loop, out-of-repo and long-step alert rules"
```

---

### Task 4: View models (band, pane, text summary)

**Files:**
- Create: `src/render.ts`
- Test: `tests/render.test.ts`

**Interfaces:**
- Consumes: Task 1 (`Timeline`, `counts`, `currentStep`, `lastFinished`, format helpers), Task 2 (`ICONS`), Task 3 (`AlertConfig`, `isSlow`)
- Produces:
  - `type Color = 'green' | 'cyan' | 'red' | 'yellow'`, `interface Segment { text: string; color?: Color }`
  - `type Tone = 'idle' | 'running' | 'fail' | 'slow'`, `bandTone(t, now, cfg): Tone`
  - `summaryLine(t, now): string`
  - `bandSegments(t, now, cfg, columns): Segment[] | null`
  - `interface PaneView { header: string; earlier?: string; rows: Segment[] }`, `paneView(t, now, columns, maxRows): PaneView`
  - `summaryText(t, now, last?: number): string`

- [ ] **Step 1: Write failing tests**

`tests/render.test.ts`:
```ts
import { expect, test } from 'claude-code/testing'
import { DEFAULT_CONFIG } from '../src/alerts.ts'
import { bandSegments, bandTone, paneView, summaryLine, summaryText } from '../src/render.ts'
import { createTimeline, finishStep, startStep, type Timeline } from '../src/timeline.ts'

function sample(): Timeline {
  const t = createTimeline()
  const base = new Date(2026, 9, 3, 14, 2, 10).getTime()
  finishStep(startStep(t, { id: '1', tool: 'Edit', kind: 'edit', label: 'src/api.ts', path: '/r/src/api.ts' }, base), 'ok', base + 100)
  finishStep(startStep(t, { id: '2', tool: 'Bash', kind: 'bash', label: 'npm test', command: 'npm test' }, base + 2000), 'fail', base + 10_400, 'Exit code 1')
  return t
}

test('empty timeline draws no band', async () => {
  expect(bandSegments(createTimeline(), 0, DEFAULT_CONFIG, 80)).toBeNull()
})

test('summary line wording', async () => {
  const t = sample()
  const end = t.firstStepAt! + 192_000
  expect(summaryLine(t, end)).toBe('2 steps · 1 edit · 1 fail · 3m12s')
})

test('band tone follows state', async () => {
  const t = sample()
  const now = t.firstStepAt! + 20_000
  expect(bandTone(t, now, DEFAULT_CONFIG)).toBe('fail')
  const run = startStep(t, { id: '3', tool: 'Bash', kind: 'bash', label: 'sleep 99', command: 'sleep 99' }, now)
  expect(bandTone(t, now + 1000, DEFAULT_CONFIG)).toBe('running')
  expect(bandTone(t, now + 60_000, DEFAULT_CONFIG)).toBe('slow')
  finishStep(run, 'ok', now + 61_000)
  expect(bandTone(t, now + 61_000, DEFAULT_CONFIG)).toBe('idle')
})

test('band shows the running step and truncates to width', async () => {
  const t = sample()
  const now = t.firstStepAt! + 20_000
  startStep(t, { id: '3', tool: 'Bash', kind: 'bash', label: 'npm run build', command: 'npm run build' }, now)
  const segs = bandSegments(t, now + 8000, DEFAULT_CONFIG, 200)!
  expect(segs[0]).toEqual({ text: '● ', color: 'cyan' })
  expect(segs[1]?.text).toBe('3 steps · 1 edit · 1 fail · 28s · now: $ npm run build (8.0s)')
  const narrow = bandSegments(t, now + 8000, DEFAULT_CONFIG, 12)!
  expect(narrow[1]?.text.length).toBe(10)
  const tiny = bandSegments(t, now + 8000, DEFAULT_CONFIG, 1)!
  expect(tiny[1]?.text).toBe('')
})

test('pane rows: time, icon, label, duration, mark; failed rows red', async () => {
  const t = sample()
  const v = paneView(t, t.firstStepAt! + 20_000, 60, 20)
  expect(v.rows.length).toBe(2)
  expect(v.rows[0]?.text.startsWith('14:02:10  ✎ src/api.ts')).toBe(true)
  expect(v.rows[0]?.text.endsWith('0.1s ✓')).toBe(true)
  expect(v.rows[0]?.text.length).toBe(60)
  expect(v.rows[1]?.color).toBe('red')
  expect(v.rows[1]?.text.endsWith('8.4s ✗')).toBe(true)
  expect(v.earlier).toBeUndefined()
})

test('pane drops duration then time on narrow widths, never negative', async () => {
  const t = sample()
  const now = t.firstStepAt! + 20_000
  expect(paneView(t, now, 45, 20).rows[0]?.text.startsWith('14:02:10  ✎')).toBe(true)
  expect(paneView(t, now, 45, 20).rows[0]?.text.includes('0.1s')).toBe(false)
  expect(paneView(t, now, 30, 20).rows[0]?.text.startsWith('✎ src/api.ts')).toBe(true)
  expect(paneView(t, now, 3, 20).rows[0]?.text.length).toBeDefined()
})

test('pane keeps the newest rows that fit and reports hidden ones', async () => {
  const t = createTimeline()
  for (let i = 0; i < 10; i++) startStep(t, { id: String(i), tool: 'Read', kind: 'read', label: 'f' + i }, i)
  t.dropped = 5
  const v = paneView(t, 100, 60, 4)
  expect(v.rows.length).toBe(4)
  expect(v.rows[3]?.text.includes('f9')).toBe(true)
  expect(v.earlier).toBe('+11 earlier steps')
})

test('text summary for surfaces that cannot draw', async () => {
  expect(summaryText(createTimeline(), 0)).toBe('No steps recorded yet.')
  const t = sample()
  const text = summaryText(t, t.firstStepAt! + 20_000)
  expect(text.split('\n')[0]).toBe('2 steps · 1 edit · 1 fail · 20s')
  expect(text.split('\n').length).toBe(3)
})
```

- [ ] **Step 2: Run to see it fail**

Run: `claude plugin test`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/render.ts`**

```ts
import { type AlertConfig, isSlow } from './alerts.ts'
import { formatClock, formatDuration, plural, truncate } from './format.ts'
import { ICONS } from './labels.ts'
import { type Step, type Timeline, counts, currentStep, lastFinished } from './timeline.ts'

export type Color = 'green' | 'cyan' | 'red' | 'yellow'
export type Tone = 'idle' | 'running' | 'fail' | 'slow'

export interface Segment {
  text: string
  color?: Color
}

export interface PaneView {
  header: string
  earlier?: string
  rows: Segment[]
}

const TONE_COLOR: Record<Tone, Color> = { idle: 'green', running: 'cyan', fail: 'red', slow: 'yellow' }

export function bandTone(t: Timeline, now: number, cfg: AlertConfig): Tone {
  const running = currentStep(t)
  if (running) return isSlow(running, now, cfg) ? 'slow' : 'running'
  return lastFinished(t)?.status === 'fail' ? 'fail' : 'idle'
}

export function summaryLine(t: Timeline, now: number): string {
  const c = counts(t, now)
  return [plural(c.steps, 'step'), plural(c.edits, 'edit'), plural(c.fails, 'fail'), formatDuration(c.elapsedMs)].join(' · ')
}

export function bandSegments(t: Timeline, now: number, cfg: AlertConfig, columns: number): Segment[] | null {
  if (t.steps.length === 0 && t.dropped === 0) return null
  let text = summaryLine(t, now)
  const running = currentStep(t)
  if (running) text += ' · now: ' + ICONS[running.kind] + ' ' + running.label + ' (' + formatDuration(now - running.startedAt) + ')'
  return [
    { text: '● ', color: TONE_COLOR[bandTone(t, now, cfg)] },
    { text: truncate(text, columns - 2) },
  ]
}

function stepRow(s: Step, now: number, columns: number): Segment {
  const showTime = columns >= 40
  const showDuration = columns >= 50
  const mark = s.status === 'ok' ? '✓' : s.status === 'fail' ? '✗' : '…'
  const head = (showTime ? formatClock(s.startedAt) + '  ' : '') + ICONS[s.kind] + ' '
  const duration = s.durationMs ?? now - s.startedAt
  const tail = (showDuration ? ' ' + formatDuration(duration) : '') + ' ' + mark
  const labelWidth = Math.max(0, columns - head.length - tail.length)
  const text = truncate(head + truncate(s.label, labelWidth).padEnd(labelWidth) + tail, Math.max(columns, 1))
  if (s.status === 'fail') return { text, color: 'red' }
  if (s.status === 'running') return { text, color: 'cyan' }
  return { text }
}

export function paneView(t: Timeline, now: number, columns: number, maxRows: number): PaneView {
  const fit = Math.max(1, maxRows)
  const shown = t.steps.slice(-fit)
  const hidden = t.dropped + (t.steps.length - shown.length)
  return {
    header: truncate(summaryLine(t, now), columns),
    earlier: hidden > 0 ? '+' + hidden + ' earlier steps' : undefined,
    rows: shown.map(s => stepRow(s, now, columns)),
  }
}

export function summaryText(t: Timeline, now: number, last: number = 10): string {
  if (t.steps.length === 0 && t.dropped === 0) return 'No steps recorded yet.'
  const rows = t.steps.slice(-last).map(s => stepRow(s, now, 80).text.trimEnd())
  return [summaryLine(t, now), ...rows].join('\n')
}
```

Note: in the pane test at width 60 the row is exactly 60 chars because the label is padded; `summaryText` trims padding.

- [ ] **Step 4: Run tests**

Run: `claude plugin test`
Expected: all PASS. If the `toBe(60)` length check fails because `✎`/`✓` count as one JS char each (they do; both are single UTF-16 units), recheck padding math before changing the test.

- [ ] **Step 5: Commit**

```bash
git add src/render.ts tests/render.test.ts
git commit -m "feat: build band, pane and summary view models"
```

---

### Task 5: Markdown export

**Files:**
- Create: `src/export.ts`
- Test: `tests/export.test.ts`

**Interfaces:**
- Consumes: Task 1 (`Timeline`, `counts`, format helpers)
- Produces: `exportFileName(now: number): string`, `toMarkdown(t: Timeline, now: number): string`, `escapeCell(s: string): string`

- [ ] **Step 1: Write failing tests**

`tests/export.test.ts`:
```ts
import { expect, test } from 'claude-code/testing'
import { escapeCell, exportFileName, toMarkdown } from '../src/export.ts'
import { createTimeline, finishStep, startStep } from '../src/timeline.ts'

const at = (h: number, m: number, s: number) => new Date(2026, 9, 3, h, m, s).getTime()

test('default file name uses local date and time', async () => {
  expect(exportFileName(at(14, 5, 0))).toBe('flight-recorder-20261003-1405.md')
})

test('escapeCell escapes pipes and newlines', async () => {
  expect(escapeCell('a | b\nc')).toBe('a \\| b c')
})

test('markdown snapshot', async () => {
  const t = createTimeline()
  finishStep(startStep(t, { id: '1', tool: 'Edit', kind: 'edit', label: 'src/api.ts', path: '/r/src/api.ts' }, at(14, 2, 10)), 'ok', at(14, 2, 10) + 100)
  finishStep(startStep(t, { id: '2', tool: 'Bash', kind: 'bash', label: 'npm test | tee log', command: 'npm test | tee log' }, at(14, 2, 12)), 'fail', at(14, 2, 12) + 8400, 'Exit code 1')
  finishStep(startStep(t, { id: '3', tool: 'Edit', kind: 'edit', label: 'src/api.ts', path: '/r/src/api.ts' }, at(14, 3, 1)), 'ok', at(14, 3, 1) + 100)
  startStep(t, { id: '4', tool: 'Read', kind: 'read', label: 'README.md' }, at(14, 5, 0))
  expect(toMarkdown(t, at(14, 5, 2))).toBe([
    '# Session log — 2026-10-03 14:02–14:05',
    '',
    '4 steps · 2 edits · 1 failure · 2m52s',
    '',
    '| Time | Step | Result | Duration |',
    '| --- | --- | --- | --- |',
    '| 14:02:10 | Edit src/api.ts | ok | 0.1s |',
    '| 14:02:12 | Bash npm test \\| tee log | FAIL | 8.4s |',
    '| 14:03:01 | Edit src/api.ts | ok | 0.1s |',
    '| 14:05:00 | Read README.md | running | — |',
    '',
    '## Files changed',
    '',
    '- src/api.ts (2 edits)',
    '',
    '## Failures',
    '',
    '- 14:02:12 `npm test | tee log` — Exit code 1',
    '',
  ].join('\n'))
})

test('empty timeline and dropped steps', async () => {
  const t = createTimeline()
  const md = toMarkdown(t, at(9, 0, 0))
  expect(md.startsWith('# Session log — 2026-10-03 09:00–09:00')).toBe(true)
  expect(md).toContain('## Files changed\n\n- none')
  expect(md).toContain('## Failures\n\n- none')
  t.dropped = 7
  expect(toMarkdown(t, at(9, 0, 0))).toContain('_7 earlier steps not shown._')
})
```

- [ ] **Step 2: Run to see it fail**

Run: `claude plugin test`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/export.ts`**

```ts
import { formatClock, formatDuration, plural } from './format.ts'
import { type Timeline, counts } from './timeline.ts'

const pad = (n: number) => String(n).padStart(2, '0')

function ymd(d: Date): string {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

function hm(d: Date): string {
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}

export function exportFileName(now: number): string {
  const d = new Date(now)
  return 'flight-recorder-' + ymd(d).replace(/-/g, '') + '-' + hm(d).replace(':', '') + '.md'
}

export function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')
}

export function toMarkdown(t: Timeline, now: number): string {
  const start = new Date(t.firstStepAt ?? now)
  const c = counts(t, now)
  const lines: string[] = [
    '# Session log — ' + ymd(start) + ' ' + hm(start) + '–' + hm(new Date(now)),
    '',
    [plural(c.steps, 'step'), plural(c.edits, 'edit'), plural(c.fails, 'failure'), formatDuration(c.elapsedMs)].join(' · '),
    '',
  ]
  if (t.dropped > 0) lines.push('_' + t.dropped + ' earlier steps not shown._', '')
  lines.push('| Time | Step | Result | Duration |', '| --- | --- | --- | --- |')
  for (const s of t.steps) {
    const result = s.status === 'ok' ? 'ok' : s.status === 'fail' ? 'FAIL' : 'running'
    const duration = s.durationMs === undefined ? '—' : formatDuration(s.durationMs)
    lines.push('| ' + formatClock(s.startedAt) + ' | ' + escapeCell(s.tool + ' ' + s.label) + ' | ' + result + ' | ' + duration + ' |')
  }

  const files = new Map<string, number>()
  for (const s of t.steps) if (s.kind === 'edit') files.set(s.label, (files.get(s.label) ?? 0) + 1)
  lines.push('', '## Files changed', '')
  if (files.size === 0) lines.push('- none')
  for (const [label, n] of files) lines.push('- ' + label + ' (' + plural(n, 'edit') + ')')

  const failures = t.steps.filter(s => s.status === 'fail')
  lines.push('', '## Failures', '')
  if (failures.length === 0) lines.push('- none')
  for (const s of failures) {
    lines.push('- ' + formatClock(s.startedAt) + ' `' + s.label + '`' + (s.error ? ' — ' + s.error : ''))
  }
  lines.push('')
  return lines.join('\n')
}
```

- [ ] **Step 4: Run tests**

Run: `claude plugin test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/export.ts tests/export.test.ts
git commit -m "feat: export the timeline as Markdown"
```

---

### Task 6: Hooks module (wiring, drawing, command)

**Files:**
- Modify: `hooks/register.tsx` (replace stub)
- Test: `tests/register.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: the running mod. Command `/fr [export [path] | clear]`. Pane id `flight-recorder`.

Facts from the 2.1.287 types used here:
- `tool.call` input: `e.tool`, `e.tool_use_id?`, tool arguments as sibling fields.
- `next(e)` resolves to `{ deny }` or `{ result, text?, isError? }`; `isError: true` means the tool reported an error (non-zero Bash exits included — confirm in Step 6).
- `$.clock.every(ms, fn)` returns `{ cancel() }`; `$.clock.now()` is async.
- `$.ui.open({ id, title })` resolves `{ isPlaced, reason? }`; `$.ui.panes()` lists open panes; `$.ui.close({ id })`.
- `$.session.surfaces()` is empty where nothing draws.
- `.catch(($, e, next) => next(e))` is replay-safe.
- JSX uses the engine's global `h`; elements come from `$.ui.resolve(e)`.

- [ ] **Step 1: Write failing kit tests**

`tests/register.test.ts`:
```ts
import { expect, mock, test } from 'claude-code/testing'

function stubSession(on: any, written: Map<string, string>, toasts: string[]) {
  mock.clock(on, { now: new Date(2026, 9, 3, 14, 0, 0).getTime() })
  on('session.cwd', () => ({ value: '/work' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('ui.toast', ($: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))
  on('fs.exists', ($: any, e: any) => ({ value: written.has(e.path) }))
  on('fs.write', ($: any, e: any) => { written.set(e.path, e.text); return { value: undefined } })
}

test('a successful call is recorded and its result returned unchanged', async ($, on) => {
  const written = new Map<string, string>()
  const toasts: string[] = []
  stubSession(on, written, toasts)
  on('tool.call', () => ({ result: 'done' }))
  const out = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(out).toEqual({ result: 'done' })
  const answer = await $.command.run({ command: 'fr', args: 'export' })
  expect(answer.text).toMatch(/^Exported 1 step to \/work\/flight-recorder-20261003-1400\.md$/)
  expect([...written.values()][0]).toContain('| Bash ls | ok |')
})

test('isError and deny count as failures; three in a row raise the loop toast', async ($, on) => {
  const written = new Map<string, string>()
  const toasts: string[] = []
  stubSession(on, written, toasts)
  on('tool.call', () => ({ result: 'boom', text: 'Exit code 1', isError: true }))
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(toasts).toEqual(['Same command failed 3× — Claude may be stuck: npm test'])
  await $.command.run({ command: 'fr', args: 'export out.md' })
  expect(written.get('/work/out.md')).toContain('- 14:00:00 `npm test` — Exit code 1')
})

test('a throwing call is recorded as failed and the same error propagates', async ($, on) => {
  const written = new Map<string, string>()
  const toasts: string[] = []
  stubSession(on, written, toasts)
  on('tool.call', () => { throw new Error('interrupted') })
  let message = ''
  try {
    await $.tool.call({ tool: 'Bash', command: 'sleep 9' })
  } catch (error: any) {
    message = error.message
  }
  expect(message).toContain('interrupted')
  await $.command.run({ command: 'fr', args: 'export' })
  expect([...written.values()][0]).toContain('| FAIL |')
})

test('edit outside the project raises a toast once', async ($, on) => {
  const toasts: string[] = []
  stubSession(on, new Map(), toasts)
  on('tool.call', () => ({ result: 'ok' }))
  await $.tool.call({ tool: 'Edit', file_path: '../other/x.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: '/other/x.ts', old_string: 'a', new_string: 'b' })
  expect(toasts).toEqual(['Edit outside the project: /other/x.ts'])
})

test('export never overwrites and resolves paths with spaces and dots', async ($, on) => {
  const written = new Map<string, string>([['/work/taken.md', 'old']])
  stubSession(on, written, [])
  on('tool.call', () => ({ result: 'ok' }))
  await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
  const refused = await $.command.run({ command: 'fr', args: 'export taken.md' })
  expect(refused.text).toBe('Not written: /work/taken.md already exists.')
  expect(written.get('/work/taken.md')).toBe('old')
  const spaced = await $.command.run({ command: 'fr', args: 'export logs/../my log.md' })
  expect(spaced.text).toBe('Exported 1 step to /work/my log.md')
})

test('clear resets; unknown subcommand prints usage', async ($, on) => {
  const written = new Map<string, string>()
  stubSession(on, written, [])
  on('tool.call', () => ({ result: 'ok' }))
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect((await $.command.run({ command: 'fr', args: 'clear' })).text).toBe('Timeline cleared.')
  expect((await $.command.run({ command: 'fr', args: 'export' })).text).toMatch(/^Exported 0 steps/)
  expect((await $.command.run({ command: 'fr', args: 'nope' })).text).toBe('Usage: /fr [export [path] | clear]')
})

test('/fr prints a text summary where nothing draws', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('session.surfaces', () => ({ value: [] }))
  const answer = await $.command.run({ command: 'fr', args: '' })
  expect(answer.text).toBe('No steps recorded yet.')
})

test('/fr toggles the pane where something draws', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('session.surfaces', () => ({ value: ['terminal'] }))
  const opened: string[] = []
  let open = false
  on('ui.panes', () => ({ value: open ? [{ id: 'flight-recorder' }] : [] }))
  on('ui.open', ($: any, e: any) => { opened.push(e.id); open = true; return { value: { isPlaced: true } } })
  on('ui.close', () => { open = false; return { value: undefined } })
  await $.command.run({ command: 'fr', args: '' })
  expect(opened).toEqual(['flight-recorder'])
  expect(open).toBe(true)
  await $.command.run({ command: 'fr', args: '' })
  expect(open).toBe(false)
})

test('band draws the summary after the first step', async ($, on) => {
  stubSession(on, new Map(), [])
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  const BAND = {
    plugin: 'stepscope', component: 'AbovePrompt', requestId: 'band', surface: 'terminal',
    viewport: { columns: 100, rows: 30 },
    props: { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 100, scroll: { offset: 0, bodyRows: 5 }, view: {} },
  } as const
  const before = await $.ui.mount(BAND as any)
  expect(await before.find({ type: 'Text', text: /steps?/ })).toBeUndefined()
  await before.unmount()
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const after = await $.ui.mount(BAND as any)
  expect(await after.find({ type: 'Text', text: /^1 step · 0 edits · 0 fails/ })).toBeDefined()
})
```

- [ ] **Step 2: Run to see it fail**

Run: `claude plugin test tests/register.test.ts` (or `claude plugin test` if a path argument is not accepted)
Expected: FAIL (stub module has no command or drawing).

- [ ] **Step 3: Implement `hooks/register.tsx`**

```tsx
import { DEFAULT_CONFIG, type AlertConfig, type AlertState, createAlertState, onStepFinish, onStepStart } from '../src/alerts.ts'
import { exportFileName, toMarkdown } from '../src/export.ts'
import { describeCall } from '../src/labels.ts'
import { resolvePath } from '../src/paths.ts'
import { bandSegments, paneView, summaryText } from '../src/render.ts'
import { type Step, type Timeline, createTimeline, currentStep, finishStep, startStep } from '../src/timeline.ts'

const PANE_ID = 'flight-recorder'
const USAGE = 'Usage: /fr [export [path] | clear]'

let timeline: Timeline = createTimeline()
let alerts: AlertState = createAlertState()
let config: AlertConfig = { ...DEFAULT_CONFIG }
let showBand = true
let ticker: { cancel: () => void } | null = null

function reset() {
  timeline = createTimeline()
  alerts = createAlertState()
}

function positive(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function failureOf(result: unknown): { failed: boolean; error?: string } {
  if (!result || typeof result !== 'object') return { failed: false }
  const r = result as { deny?: unknown; isError?: unknown; text?: unknown }
  if (typeof r.deny === 'string') return { failed: true, error: r.deny }
  if (r.isError === true) return { failed: true, error: typeof r.text === 'string' ? r.text : undefined }
  return { failed: false }
}

async function startTicker($) {
  if (ticker) return
  ticker = $.clock.every(1000, () => {
    if (!currentStep(timeline) && ticker) {
      ticker.cancel()
      ticker = null
    }
    $.ui.invalidate('ui.render')
  })
}

async function finish($, step: Step | null, failed: boolean, error?: string) {
  if (!step) return
  finishStep(step, failed ? 'fail' : 'ok', await $.clock.now(), error)
  const warning = onStepFinish(alerts, step, config)
  if (warning) $.ui.toast(warning)
  $.ui.invalidate('ui.render')
}

async function exportLog($, arg: string): Promise<string> {
  const now = await $.clock.now()
  const root = await $.session.root()
  const target = resolvePath(arg || exportFileName(now), root)
  if (await $.fs.exists(target)) return 'Not written: ' + target + ' already exists.'
  try {
    await $.fs.write(target, toMarkdown(timeline, now))
  } catch (err) {
    return 'Export failed: ' + (err instanceof Error ? err.message : String(err))
  }
  const n = timeline.steps.length
  return 'Exported ' + n + (n === 1 ? ' step' : ' steps') + ' to ' + target
}

async function togglePane($): Promise<{ text?: string }> {
  const surfaces = await $.session.surfaces()
  if (surfaces.length === 0) return { text: summaryText(timeline, await $.clock.now()) }
  const panes = await $.ui.panes()
  if (panes.some(p => p.id === PANE_ID)) {
    await $.ui.close({ id: PANE_ID })
    return {}
  }
  const opened = await $.ui.open({ id: PANE_ID, title: 'Flight Recorder' })
  return opened.isPlaced ? {} : { text: 'Pane not shown: ' + (opened.reason ?? 'not enough room') }
}

export function register(on, options) {
  config = {
    failStreak: positive(options?.failStreak, DEFAULT_CONFIG.failStreak),
    longStepSeconds: positive(options?.longStepSeconds, DEFAULT_CONFIG.longStepSeconds),
  }
  showBand = options?.showBand !== false && options?.showBand !== 'false'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fr',
      description: 'Flight recorder: toggle the timeline pane, export it as Markdown, or clear it',
      argumentHint: '[export [path] | clear]',
      immediate: true,
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    reset()
    if (ticker) {
      ticker.cancel()
      ticker = null
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    let step: Step | null = null
    try {
      const cwd = await $.session.cwd()
      const root = await $.session.root()
      const id = e.tool_use_id ?? 'step-' + (timeline.steps.length + timeline.dropped + 1)
      step = startStep(timeline, describeCall(id, e.tool, e as Record<string, unknown>, cwd, root), await $.clock.now())
      const warning = onStepStart(alerts, step, root)
      if (warning) $.ui.toast(warning)
      await startTicker($)
      $.ui.invalidate('ui.render')
    } catch (err) {
      $.ui.log('stepscope: ' + String(err), { to: 'debug' })
    }
    let result
    try {
      result = await next(e)
    } catch (err) {
      try {
        await finish($, step, true, err instanceof Error ? err.message : String(err))
      } catch {}
      throw err
    }
    try {
      const outcome = failureOf(result)
      await finish($, step, outcome.failed, outcome.error)
    } catch (err) {
      $.ui.log('stepscope: ' + String(err), { to: 'debug' })
    }
    return result
  })

  on('command.run', { command: 'fr' }, async ($, e) => {
    const parts = (e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const sub = parts[0]
    if (sub === 'export') return { text: await exportLog($, (e.args ?? '').trim().slice('export'.length).trim()) }
    if (sub === 'clear') {
      reset()
      $.ui.invalidate('ui.render')
      return { text: 'Timeline cleared.' }
    }
    if (sub) return { text: USAGE }
    return togglePane($)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (!showBand) return below
    const segments = bandSegments(timeline, await $.clock.now(), config, e.props.bodyColumns)
    if (!segments) return below
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Box>
          {segments.map((seg, i) => <Text key={'b' + i} color={seg.color}>{seg.text}</Text>)}
        </Box>
        {below}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const rowsAvailable = e.props.placement === 'dock' ? e.props.scroll.bodyRows - 3 : 20
    const view = paneView(timeline, await $.clock.now(), e.props.bodyColumns, rowsAvailable)
    return (
      <Box flexDirection="column">
        <Text bold>{view.header}</Text>
        <Box gap={2}>
          <Button key="export" label="Export" onPress={async () => $.ui.toast(await exportLog($, ''))} />
          <Button key="clear" label="Clear" onPress={() => { reset(); $.ui.invalidate('ui.render') }} />
        </Box>
        {view.earlier ? <Text dimColor>{view.earlier}</Text> : null}
        {view.rows.map((row, i) => <Text key={'r' + i} color={row.color}>{row.text}</Text>)}
      </Box>
    )
  })
}
```

Note: the `/fr export` argument is taken from the raw `e.args` after the word `export`, so paths with spaces survive.

- [ ] **Step 4: Validate static analysis**

Run: `claude plugin validate .`
Expected: `✔ Validation passed`; `hooks:` lists `session.start, session.end, tool.call, command.run{command=fr}, ui.render{component=AbovePrompt}, ui.render{component=Pane}`; `calls:` lists only `$.command.register`, `$.session.*`, `$.clock.*`, `$.ui.*`, `$.fs.exists`, `$.fs.write`.
If validation rejects passing `$` into the `onPress` closures, move each press into a `ui.press` hook matched by `{ key: 'export' }` / `{ key: 'clear' }` and drop `onPress`.

- [ ] **Step 5: Run all tests**

Run: `claude plugin test`
Expected: all PASS. If a stub name is reported missing (`no implementation for X`), add the stub to `stubSession` with the shape from the testing docs table.

- [ ] **Step 6: Confirm Bash failure shape in a real session**

Run: `claude --plugin-dir . -p "run the shell command: false" --allowedTools Bash` then `claude --plugin-dir . -p "/fr"`.
Expected: the first run executes `false`. In an interactive `claude --plugin-dir .` session, run `false` via Claude, then `/fr export`: the exported row says `FAIL`. If it says `ok`, extend `failureOf` to also treat a Bash result whose `text` starts with `Exit code` as failed, add a kit test for that shape, rerun Step 5.

- [ ] **Step 7: Commit**

```bash
git add hooks/register.tsx tests/register.test.ts
git commit -m "feat: wire stepscope hooks, band, pane and /fr command"
```

---

### Task 7: README, license, release checks

**Files:**
- Create: `README.md`, `LICENSE`
- Modify: none

- [ ] **Step 1: Write `LICENSE`** (MIT, `Copyright (c) 2026 5d0tal1gat0r`, standard MIT text).

- [ ] **Step 2: Write `README.md`**

```markdown
# Stepscope — flight recorder for Claude Code

See what Claude is doing while it works. Stepscope records every tool call in
the current session and shows it live: a one-line band above the prompt with
step, edit and failure counts plus the step running now, and a timeline pane
you open with `/fr`. It warns you when Claude looks stuck or edits files
outside your project, and exports a clean Markdown log you can read before
you commit or paste into a pull request.

## Requirements

- Claude Code v2.1.287 or later (mods). Tested with 2.1.287.
- Draws in the terminal and the Desktop app's Code tab. In the VS Code chat
  panel and `claude -p`, `/fr` prints a text summary instead.

## Commands

| Command | What it does |
| --- | --- |
| `/fr` | Open or close the timeline pane |
| `/fr export [path]` | Write the session log as Markdown (default `flight-recorder-YYYYMMDD-HHMM.md` in the project root). Never overwrites a file. |
| `/fr clear` | Start the timeline over |

## Alerts

- **Stuck loop:** the same shell command fails 3 times in a row.
- **Edit outside the project:** Claude edits a file outside the session's project root.
- **Long step:** the band turns amber when a step runs longer than 60 seconds.

## Settings

Set with `/plugin configure stepscope@<marketplace>`:

| Option | Default | Meaning |
| --- | --- | --- |
| `failStreak` | 3 | Failures in a row before the stuck-loop alert |
| `longStepSeconds` | 60 | Seconds before a running step turns the band amber |
| `showBand` | true | Show the band above the prompt |

## What it reads and writes

- Reads each tool call's name, arguments and result inside Claude Code, in
  memory, for the current session only. Nothing is saved between sessions.
- Never changes, blocks or approves a tool call.
- No network access, no processes, no model calls.
- Writes a file only when you run `/fr export` or press **Export**, at the
  path shown in the reply.

## License

MIT
```

- [ ] **Step 3: Strict validation**

Run: `claude plugin validate --strict .`
Expected: `✔ Validation passed` with no warnings. Fix any warning (unknown manifest field, missing field) and rerun.

- [ ] **Step 4: Tests and size checks**

Run: `claude plugin test && find . -path ./.git -prune -o -type f -size +256k -print`
Expected: tests pass; `find` prints nothing.

- [ ] **Step 5: Manual session check**

Run `claude --plugin-dir .` in a scratch repo and ask Claude to edit a file, run a failing command three times, edit `/tmp/x.txt`, and run `sleep 65`. Confirm: band counts and colours, pane rows and buttons, both toasts, amber band, `/fr export` file content, `/fr clear`.

- [ ] **Step 6: Commit and push**

```bash
git add README.md LICENSE
git commit -m "docs: add README with disclosure and MIT license"
git push
```

Release (repo public + portal submission) happens after the manual check and a screenshot are done; it is not part of this plan.
