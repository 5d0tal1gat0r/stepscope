// Text from tool calls is untrusted: a command can carry terminal escape
// sequences or credentials. Everything shown or exported passes through here.

const WHITESPACE_CONTROLS = /[\t\n\r]/g
const OTHER_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

export function stripControl(text: string): string {
  return text.replace(WHITESPACE_CONTROLS, ' ').replace(OTHER_CONTROLS, '')
}

const REDACTED = '[redacted]'

const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi
const AUTH_HEADER = /(authorization:\s*(?:bearer|basic|token)\s+)[^\s"']+/gi
const SECRET_ASSIGNMENT = /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*=)("[^"]*"|'[^']*'|[^\s"']+)/gi
const KNOWN_TOKENS = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})/g

export function redactSecrets(text: string): string {
  return text
    .replace(URL_PASSWORD, '$1' + REDACTED + '@')
    .replace(AUTH_HEADER, '$1' + REDACTED)
    .replace(SECRET_ASSIGNMENT, '$1' + REDACTED)
    .replace(KNOWN_TOKENS, REDACTED)
}

export function sanitize(text: string): string {
  return redactSecrets(stripControl(text))
}
