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
