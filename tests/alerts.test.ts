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
