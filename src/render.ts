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
