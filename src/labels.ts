import { truncate } from './format.ts'
import { relativeTo, resolvePath } from './paths.ts'
import type { StepInfo, StepKind } from './timeline.ts'

export const LABEL_MAX = 60

export const ICONS: Record<StepKind, string> = { edit: '✎', bash: '$', read: '◎', other: '·' }

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])

export function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, ' ')
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key]
  return typeof v === 'string' && v !== '' ? v : undefined
}

export function describeCall(
  id: string,
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  root: string,
): StepInfo {
  if (EDIT_TOOLS.has(tool)) {
    const raw = str(input, 'file_path') ?? str(input, 'notebook_path')
    if (!raw) return { id, tool, kind: 'edit', label: tool }
    const path = resolvePath(raw, cwd)
    return { id, tool, kind: 'edit', label: truncate(relativeTo(path, root), LABEL_MAX), path }
  }
  if (tool === 'Bash') {
    const command = normalizeCommand(str(input, 'command') ?? '')
    if (!command) return { id, tool, kind: 'bash', label: tool }
    return { id, tool, kind: 'bash', label: truncate(command, LABEL_MAX), command }
  }
  if (READ_TOOLS.has(tool)) {
    const target = str(input, 'file_path') ?? str(input, 'pattern') ?? str(input, 'path') ?? tool
    return { id, tool, kind: 'read', label: truncate(relativeTo(target, root), LABEL_MAX) }
  }
  return { id, tool, kind: 'other', label: truncate(tool, LABEL_MAX) }
}
