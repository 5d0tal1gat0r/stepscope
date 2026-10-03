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
