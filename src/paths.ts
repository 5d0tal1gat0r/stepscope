export function resolvePath(p: string, base: string): string {
  const abs = p.startsWith('/') ? p : base.replace(/\/+$/, '') + '/' + p
  const out: string[] = []
  for (const part of abs.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

export function isInside(path: string, root: string): boolean {
  if (!path.startsWith('/') || !root.startsWith('/')) return true
  const r = resolvePath(root, '/')
  if (r === '/') return true
  const p = resolvePath(path, '/')
  return p === r || p.startsWith(r + '/')
}

export function relativeTo(path: string, root: string): string {
  if (!path.startsWith('/') || !root.startsWith('/')) return path
  const r = resolvePath(root, '/')
  return path.startsWith(r + '/') ? path.slice(r.length + 1) : path
}
