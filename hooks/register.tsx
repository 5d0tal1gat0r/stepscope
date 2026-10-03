import { DEFAULT_CONFIG, type AlertConfig, type AlertState, createAlertState, onStepFinish, onStepStart } from '../src/alerts.ts'
import { exportFileName, toMarkdown } from '../src/export.ts'
import { describeCall } from '../src/labels.ts'
import { resolvePath } from '../src/paths.ts'
import { bandSegments, paneView, summaryText } from '../src/render.ts'
import { type Step, type Timeline, createTimeline, currentStep, finishStep, startStep } from '../src/timeline.ts'

const PANE_ID = 'flight-recorder'
const INLINE_ROWS = 12
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
  let now = step.startedAt
  try {
    now = await $.clock.now()
  } catch {}
  finishStep(step, failed ? 'fail' : 'ok', now, error)
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
  const opened = await $.ui.open({ id: PANE_ID, title: 'Flight Recorder', rows: INLINE_ROWS })
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
    const args = (e.args ?? '').trim()
    const sub = args.split(/\s+/)[0]
    if (sub === 'export') return { text: await exportLog($, args.slice('export'.length).trim()) }
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
    const rowsAvailable = (e.props.placement === 'dock' ? e.props.scroll.bodyRows : INLINE_ROWS) - 3
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
