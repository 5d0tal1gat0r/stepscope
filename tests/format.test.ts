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
