import { expect, test } from 'claude-code/testing'
import { redactSecrets, stripControl } from '../src/redact.ts'

test('stripControl removes C0/C1 controls and bidi overrides', async () => {
  expect(stripControl('a\x1b[31mb\x07c\x9bd')).toBe('a[31mbcd')
  expect(stripControl('safe‮evil⁦x')).toBe('safeevilx')
  expect(stripControl('tab\tand\nnewline')).toBe('tab and newline')
})

test('redactSecrets hides known token shapes', async () => {
  expect(redactSecrets('gh auth ghp_' + 'a'.repeat(36))).toBe('gh auth [redacted]')
  expect(redactSecrets('key sk-' + 'b'.repeat(40))).toBe('key [redacted]')
  expect(redactSecrets('AKIA' + 'C'.repeat(16) + ' x')).toBe('[redacted] x')
  expect(redactSecrets('xoxb-123456789012-abc')).toBe('[redacted]')
})

test('redactSecrets hides assignments, auth headers and URL passwords', async () => {
  expect(redactSecrets('export GITHUB_TOKEN=abc123 && run')).toBe('export GITHUB_TOKEN=[redacted] && run')
  expect(redactSecrets('DB_PASSWORD="p a s s" npm start')).toBe('DB_PASSWORD=[redacted] npm start')
  expect(redactSecrets('curl -H "Authorization: Bearer abc.def" x')).toBe('curl -H "Authorization: Bearer [redacted]" x')
  expect(redactSecrets('git clone https://me:hunter2@github.com/a/b')).toBe('git clone https://me:[redacted]@github.com/a/b')
})

test('redactSecrets leaves ordinary commands alone', async () => {
  expect(redactSecrets('npm test -- --watch=false')).toBe('npm test -- --watch=false')
  expect(redactSecrets('git log --oneline')).toBe('git log --oneline')
})
