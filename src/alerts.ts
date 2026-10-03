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
