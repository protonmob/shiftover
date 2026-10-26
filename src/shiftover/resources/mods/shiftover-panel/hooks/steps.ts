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
// Tools that say what they do by name alone; an MCP server's, by its prefix.
const TOOL_STEPS = new Map([
  ['WebSearch', "web'de arıyor"], ['WebFetch', "web'de arıyor"], ['TodoWrite', 'plan güncelleniyor'],
  ['Skill', 'beceri kullanıyor'], ['AskUserQuestion', 'soru soruyor'],
])

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
  if (name.startsWith('mcp__')) return 'araç kullanıyor'
  return TOOL_STEPS.get(name) ?? 'çalışıyor'
}

// The last assistant line's last block: the tool it called, the text it
// writes or its thinking. A tail cut mid-line drops its first line. Null
// while the tail holds no assistant line: a session's end is often one huge
// line, a tool's image or a request's copy of it, and says no step.
export function claudeStep(tail: string, truncated = false): string | null {
  const lines = tail.split('\n')
  for (let index = lines.length - 1; index >= (truncated ? 1 : 0); index -= 1) {
    // Only an assistant line is parsed; the huge ones in between are not.
    if (!lines[index]!.includes('"assistant"')) continue
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
  return null
}

// `codex exec --json` reports each step as an item, started and completed:
// a command, a file change, a message or reasoning. The last one is the step;
// null while the tail holds none.
export function codexStep(tail: string, truncated = false): string | null {
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
  return null
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

// A delegate's session names itself in its first lines: shiftover titles it
// `delegate:<label>` (`custom-title`, then `agent-name`). Every account's
// sessions for one folder share it, so this tells the job's own apart. The
// label; null when the whole lines read name no delegate; undefined before
// the session holds a whole line.
export function delegateLabel(head: string): string | null | undefined {
  let isRead = false
  for (const line of head.split('\n')) {
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    isRead = true
    if (!isRecord(row)) continue
    const title = row.type === 'custom-title' ? text(row.customTitle) : row.type === 'agent-name' ? text(row.agentName) : ''
    if (title.startsWith('delegate:')) return title.slice('delegate:'.length).trim()
  }
  return isRead ? null : undefined
}
