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
