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
