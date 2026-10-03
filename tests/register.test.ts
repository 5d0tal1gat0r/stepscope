import { expect, mock, test } from 'claude-code/testing'

function stubSession(on: any, written: Map<string, string>, toasts: string[]) {
  mock.clock(on, { now: new Date(2026, 9, 3, 14, 0, 0).getTime() })
  on('session.cwd', () => ({ value: '/work' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('ui.toast', ($: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))
  on('fs.exists', ($: any, e: any) => ({ value: written.has(e.path) }))
  on('fs.write', ($: any, e: any) => { written.set(e.path, e.text); return { value: undefined } })
}

test('a successful call is recorded and its result returned unchanged', async ($, on) => {
  const written = new Map<string, string>()
  const toasts: string[] = []
  stubSession(on, written, toasts)
  on('tool.call', () => ({ result: 'done' }))
  const out = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(out).toEqual({ result: 'done' })
  const answer = await $.command.run({ command: 'fr', args: 'export' })
  expect(answer.text).toMatch(/^Exported 1 step to \/work\/flight-recorder-20261003-1400\.md$/)
  expect([...written.values()][0]).toContain('| Bash ls | ok |')
})

test('isError and deny count as failures; three in a row raise the loop toast', async ($, on) => {
  const written = new Map<string, string>()
  const toasts: string[] = []
  stubSession(on, written, toasts)
  on('tool.call', () => ({ result: 'boom', text: 'Exit code 1', isError: true }))
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(toasts).toEqual(['Same command failed 3× — Claude may be stuck: npm test'])
  await $.command.run({ command: 'fr', args: 'export out.md' })
  expect(written.get('/work/out.md')).toContain('- 14:00:00 `npm test` — Exit code 1')
})

test('a throwing call is recorded as failed and the same error propagates', async ($, on) => {
  const written = new Map<string, string>()
  const toasts: string[] = []
  stubSession(on, written, toasts)
  // The kit skips a stub that throws, so next(e) rejects with the kit's own
  // error; the recorder must let that same rejection through.
  on('tool.call', () => { throw new Error('interrupted') })
  let message = ''
  try {
    await $.tool.call({ tool: 'Bash', command: 'sleep 9' })
  } catch (error: any) {
    message = error.message
  }
  expect(message).toBe('no implementation for tool.call')
  await $.command.run({ command: 'fr', args: 'export' })
  expect([...written.values()][0]).toContain('| FAIL |')
})

test('edit outside the project raises a toast once', async ($, on) => {
  const toasts: string[] = []
  stubSession(on, new Map(), toasts)
  on('tool.call', () => ({ result: 'ok' }))
  await $.tool.call({ tool: 'Edit', file_path: '../other/x.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: '/other/x.ts', old_string: 'a', new_string: 'b' })
  expect(toasts).toEqual(['Edit outside the project: /other/x.ts'])
})

test('export never overwrites and resolves paths with spaces and dots', async ($, on) => {
  const written = new Map<string, string>([['/work/taken.md', 'old']])
  stubSession(on, written, [])
  on('tool.call', () => ({ result: 'ok' }))
  await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
  const refused = await $.command.run({ command: 'fr', args: 'export taken.md' })
  expect(refused.text).toBe('Not written: /work/taken.md already exists.')
  expect(written.get('/work/taken.md')).toBe('old')
  const spaced = await $.command.run({ command: 'fr', args: 'export logs/../my log.md' })
  expect(spaced.text).toBe('Exported 1 step to /work/my log.md')
})

test('clear resets; unknown subcommand prints usage', async ($, on) => {
  const written = new Map<string, string>()
  stubSession(on, written, [])
  on('tool.call', () => ({ result: 'ok' }))
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect((await $.command.run({ command: 'fr', args: 'clear' })).text).toBe('Timeline cleared.')
  expect((await $.command.run({ command: 'fr', args: 'export' })).text).toMatch(/^Exported 0 steps/)
  expect((await $.command.run({ command: 'fr', args: 'nope' })).text).toBe('Usage: /fr [export [path] | clear]')
})

test('/fr prints a text summary where nothing draws', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('session.surfaces', () => ({ value: [] }))
  const answer = await $.command.run({ command: 'fr', args: '' })
  expect(answer.text).toBe('No steps recorded yet.')
})

test('/fr toggles the pane where something draws', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('session.surfaces', () => ({ value: ['terminal'] }))
  const opened: string[] = []
  let open = false
  on('ui.panes', () => ({ value: open ? [{ id: 'flight-recorder' }] : [] }))
  on('ui.open', ($: any, e: any) => { opened.push(e.id); open = true; return { value: { isPlaced: true } } })
  on('ui.close', () => { open = false; return { value: undefined } })
  await $.command.run({ command: 'fr', args: '' })
  expect(opened).toEqual(['flight-recorder'])
  expect(open).toBe(true)
  await $.command.run({ command: 'fr', args: '' })
  expect(open).toBe(false)
})

test('band draws the summary after the first step', async ($, on) => {
  stubSession(on, new Map(), [])
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  const BAND = {
    plugin: 'stepscope', component: 'AbovePrompt', requestId: 'band', surface: 'terminal',
    viewport: { columns: 100, rows: 30 },
    props: { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 100, scroll: { offset: 0, bodyRows: 5 }, view: {} },
  } as const
  const before = await $.ui.mount(BAND as any)
  expect(await before.find({ type: 'Text', text: /steps?/ })).toBeUndefined()
  await before.unmount()
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const after = await $.ui.mount(BAND as any)
  expect(await after.find({ type: 'Text', text: /^1 step · 0 edits · 0 fails/ })).toBeDefined()
})

test('a step still finishes when the clock call rejects after the tool ran', async ($, on) => {
  const written = new Map<string, string>()
  let calls = 0
  on('clock.now', () => (++calls === 2 ? { deny: 'aborted' } : { value: new Date(2026, 9, 3, 14, 0, 0).getTime() }))
  on('clock.every', () => ({ value: { cancel() {} } }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.root', () => ({ value: '/work' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.exists', ($: any, e: any) => ({ value: written.has(e.path) }))
  on('fs.write', ($: any, e: any) => { written.set(e.path, e.text); return { value: undefined } })
  on('tool.call', () => ({ result: 'ok' }))
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.command.run({ command: 'fr', args: 'export' })
  const md = [...written.values()][0] ?? ''
  expect(md).toContain('| Bash npm test | ok |')
  expect(md).not.toContain('running')
})

test('an inline pane shows the newest steps within the rows it asked for', async ($, on) => {
  stubSession(on, new Map(), [])
  on('tool.call', () => ({ result: 'ok' }))
  for (let i = 0; i < 30; i++) await $.tool.call({ tool: 'Read', file_path: '/work/f' + i + '.ts' })
  const ui = await $.ui.mount({
    plugin: 'stepscope', component: 'Pane', requestId: 'flight-recorder', surface: 'terminal',
    viewport: { columns: 100, rows: 30 },
    props: { title: 'Flight Recorder', isFocused: false, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 4 }, view: {} },
  } as any)
  expect(await ui.find({ type: 'Text', text: /f29\.ts/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /f20\.ts/ })).toBeUndefined()
})
