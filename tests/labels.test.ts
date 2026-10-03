import { expect, test } from 'claude-code/testing'
import { ICONS, LABEL_MAX, describeCall, normalizeCommand } from '../src/labels.ts'

test('edit tools resolve the path and label it relative to root', async () => {
  const s = describeCall('1', 'Edit', { file_path: 'src/api.ts' }, '/repo', '/repo')
  expect(s).toEqual({ id: '1', tool: 'Edit', kind: 'edit', label: 'src/api.ts', path: '/repo/src/api.ts' })
  const w = describeCall('2', 'Write', { file_path: '/tmp/x.md' }, '/repo', '/repo')
  expect(w.label).toBe('/tmp/x.md')
  const n = describeCall('3', 'NotebookEdit', { notebook_path: '/repo/n.ipynb' }, '/repo', '/repo')
  expect(n.kind).toBe('edit')
  expect(n.label).toBe('n.ipynb')
})

test('bash collapses whitespace and truncates', async () => {
  const s = describeCall('1', 'Bash', { command: '  npm   test\n -- --watch=false ' }, '/r', '/r')
  expect(s.kind).toBe('bash')
  expect(s.command).toBe('npm test -- --watch=false')
  expect(s.label).toBe('npm test -- --watch=false')
  const long = describeCall('2', 'Bash', { command: 'x'.repeat(100) }, '/r', '/r')
  expect(long.label.length).toBe(LABEL_MAX)
  expect(long.command?.length).toBe(100)
})

test('read tools use path or pattern', async () => {
  expect(describeCall('1', 'Read', { file_path: '/r/a.ts' }, '/r', '/r').label).toBe('a.ts')
  expect(describeCall('2', 'Grep', { pattern: 'TODO' }, '/r', '/r').label).toBe('TODO')
  expect(describeCall('3', 'Glob', { pattern: '**/*.ts' }, '/r', '/r').kind).toBe('read')
})

test('other tools and missing input fall back to the tool name', async () => {
  expect(describeCall('1', 'mcp__x__y', {}, '/r', '/r')).toEqual({ id: '1', tool: 'mcp__x__y', kind: 'other', label: 'mcp__x__y' })
  expect(describeCall('2', 'Edit', {}, '/r', '/r').label).toBe('Edit')
  expect(describeCall('3', 'Bash', {}, '/r', '/r').label).toBe('Bash')
})

test('normalizeCommand and icons', async () => {
  expect(normalizeCommand(' a \t b ')).toBe('a b')
  expect(ICONS).toEqual({ edit: '✎', bash: '$', read: '◎', other: '·' })
})
