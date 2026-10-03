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
