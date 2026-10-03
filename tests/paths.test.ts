import { expect, test } from 'claude-code/testing'
import { isInside, relativeTo, resolvePath } from '../src/paths.ts'

test('resolvePath handles relative, dot segments and absolute', async () => {
  expect(resolvePath('src/a.ts', '/repo')).toBe('/repo/src/a.ts')
  expect(resolvePath('./src/../b.ts', '/repo/')).toBe('/repo/b.ts')
  expect(resolvePath('../../etc/x', '/repo/sub')).toBe('/etc/x')
  expect(resolvePath('/abs/x', '/repo')).toBe('/abs/x')
  expect(resolvePath('../../../..', '/a')).toBe('/')
  expect(resolvePath('my notes.md', '/repo')).toBe('/repo/my notes.md')
})

test('isInside respects segment boundaries', async () => {
  expect(isInside('/repo/src/a.ts', '/repo')).toBe(true)
  expect(isInside('/repo', '/repo')).toBe(true)
  expect(isInside('/repo-other/a.ts', '/repo')).toBe(false)
  expect(isInside('/etc/passwd', '/repo/')).toBe(false)
})

test('isInside never flags non-POSIX paths', async () => {
  expect(isInside('C:\\x\\a.ts', 'C:\\repo')).toBe(true)
})

test('relativeTo strips the root only when inside', async () => {
  expect(relativeTo('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
  expect(relativeTo('/other/a.ts', '/repo')).toBe('/other/a.ts')
})
