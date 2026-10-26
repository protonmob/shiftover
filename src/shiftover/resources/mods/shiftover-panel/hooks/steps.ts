// What a delegate job does now, read from the end of its live record: a
// claude job's session transcript, a codex job's JSON-lines log. The pane
// says it in a few Turkish words.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const basename = (path: string): string => path.replace(/\/+$/, '').split('/').pop() ?? ''

// MARK: - Steps

// A test, typecheck or build reads as tests running, any other command as a
// command: the tool's word standing alone, not inside a file name.
const TEST_COMMAND = /(?:^|[^\w.-])(?:test|pytest|tsc|jest|vitest|xcodebuild|gradlew?)(?=$|[^\w.-])/

export function commandStep(command: string): string {
  return TEST_COMMAND.test(command) ? 'testler çalışıyor' : 'komut çalışıyor'
}

function toolStep(name: string, input: Record<string, unknown>): string {
  const file = basename(text(input.file_path) || text(input.notebook_path))
  if (/^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return file === '' ? 'çalışıyor' : `${file} düzenleniyor`
  if (name === 'Read') return file === '' ? 'çalışıyor' : `${file} okunuyor`
  if (name === 'Grep' || name === 'Glob') return 'aranıyor'
  if (name === 'Bash') return commandStep(text(input.command))
  if (name === 'Agent' || name === 'Task') return 'alt ajan çalışıyor'
  return 'çalışıyor'
}

// The last assistant line's last block: the tool it called, the text it
// writes or its thinking. A tail cut mid-line drops its first line.
export function claudeStep(tail: string, truncated = false): string {
  const lines = tail.split('\n')
  for (let index = lines.length - 1; index >= (truncated ? 1 : 0); index -= 1) {
    let row: unknown
    try {
      row = JSON.parse(lines[index]!)
    } catch {
      continue
    }
    if (!isRecord(row) || row.type !== 'assistant' || !isRecord(row.message)) continue
    const blocks = Array.isArray(row.message.content) ? row.message.content.filter(isRecord) : []
    const block = blocks[blocks.length - 1]
    if (block === undefined) continue
    if (block.type === 'tool_use') return toolStep(text(block.name), isRecord(block.input) ? block.input : {})
    if (block.type === 'text') return 'yazıyor'
    if (block.type === 'thinking' || block.type === 'redacted_thinking') return 'düşünüyor'
    return 'çalışıyor'
  }
  return 'çalışıyor'
}

// `codex exec --json` reports each step as an item, started and completed:
// a command, a file change, a message or reasoning. The last one is the step.
export function codexStep(tail: string, truncated = false): string {
  const lines = tail.split('\n')
  for (let index = lines.length - 1; index >= (truncated ? 1 : 0); index -= 1) {
    let row: unknown
    try {
      row = JSON.parse(lines[index]!)
    } catch {
      continue
    }
    if (!isRecord(row) || !isRecord(row.item)) continue
    const item = row.item
    const kind = text(item.type) || text(item.item_type)
    if (kind === 'command_execution') {
      return commandStep(Array.isArray(item.command) ? item.command.map(text).join(' ') : text(item.command))
    }
    if (kind === 'file_change') {
      const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : []
      const file = basename(text(changes[changes.length - 1]?.path))
      return file === '' ? 'çalışıyor' : `${file} düzenleniyor`
    }
    if (kind === 'agent_message') return 'yazıyor'
    if (kind === 'reasoning') return 'düşünüyor'
    return 'çalışıyor'
  }
  return 'çalışıyor'
}

// MARK: - Session folders

// Claude Code keeps a folder's sessions under `projects/<cwd>`, `/` and `.`
// made `-` (`/Users/k/app` is `-Users-k-app`). Its own escaping makes every
// character but a letter or digit `-`: that spelling first, then the one
// escaping `/` and `.` alone, for a version that did no more.
export function projectFolders(cwd: string): string[] {
  const clean = cwd.replace(/\/+$/, '')
  return [...new Set([clean.replace(/[^a-zA-Z0-9]/g, '-'), clean.replace(/[/.]/g, '-')])]
}
