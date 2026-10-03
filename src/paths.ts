const DRIVE = /^[A-Za-z]:/

function toSlashes(p: string): string {
  return p.replace(/\\/g, '/')
}

function isAbsolute(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:(\/|$)/.test(p)
}

export function resolvePath(p: string, base: string): string {
  const path = toSlashes(p)
  const abs = isAbsolute(path) ? path : toSlashes(base).replace(/\/+$/, '') + '/' + path
  const drive = abs.match(DRIVE)?.[0].toUpperCase() ?? ''
  const out: string[] = []
  for (const part of abs.slice(drive.length).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return drive + '/' + out.join('/')
}

// Resolved root without a trailing slash ('' for '/'), and whether to compare
// case-insensitively (Windows drive paths).
function rootKey(root: string): { key: string; fold: boolean } {
  const r = resolvePath(root, '/')
  return { key: r.endsWith('/') ? r.slice(0, -1) : r, fold: DRIVE.test(r) }
}

export function isInside(path: string, root: string): boolean {
  const { key, fold } = rootKey(root)
  if (key === '') return true
  const p = resolvePath(path, '/')
  const a = fold || DRIVE.test(p) ? p.toLowerCase() : p
  const b = fold || DRIVE.test(p) ? key.toLowerCase() : key
  return a === b || a.startsWith(b + '/')
}

export function relativeTo(path: string, root: string): string {
  if (!isAbsolute(toSlashes(path)) || !isAbsolute(toSlashes(root))) return path
  const { key } = rootKey(root)
  if (key === '' || !isInside(path, root)) return path
  const p = resolvePath(path, '/')
  return p.length > key.length ? p.slice(key.length + 1) : path
}
