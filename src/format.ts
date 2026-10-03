export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms)
  if (safe < 10_000) return (Math.round(safe / 100) / 10).toFixed(1) + 's'
  const totalSeconds = Math.floor(safe / 1000)
  if (totalSeconds < 60) return totalSeconds + 's'
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return minutes + 'm' + String(totalSeconds % 60).padStart(2, '0') + 's'
  return Math.floor(minutes / 60) + 'h' + String(minutes % 60).padStart(2, '0') + 'm'
}

export function formatClock(epochMs: number): string {
  const d = new Date(epochMs)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

export function truncate(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length <= width) return text
  if (width === 1) return '…'
  return text.slice(0, width - 1) + '…'
}

export function plural(n: number, word: string, many: string = word + 's'): string {
  return n + ' ' + (n === 1 ? word : many)
}
