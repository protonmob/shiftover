import type { EngineInterface } from 'claude-code'
import type { Limit } from '../types'

const PANE = 'shiftover-panel'
// A file's end holds its latest turn; `$.fs.read` refuses one over 4 MiB.
const TAIL_BYTES = 1024 * 1024
const TIMEOUT_MS = 5_000
// How many of the newest files one read searches before it gives up.
const FILES_SEARCHED = 10

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// What each searched file's tail held: an unchanged file is not read again.
type Searched = { mtimeMs: number; size: number; limits: Limit[] }
const searched = new Map<string, Searched>()

// A partial last line is normal while Codex appends to its transcript. Keep
// the last complete rate_limits object, wherever that event nests it. A tail
// cut mid-line drops its first line.
export function parseCodexLimits(raw: string, truncated = false): Limit[] {
  let latest: Record<string, unknown> | null = null
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const child of value) visit(child)
    } else if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'rate_limits' && isRecord(child)) latest = child
        visit(child)
      }
    }
  }
  for (const line of raw.split('\n').slice(truncated ? 1 : 0)) {
    if (!line.includes('"rate_limits"')) continue
    try {
      visit(JSON.parse(line) as unknown)
    } catch {
      // Ignore malformed or still-incomplete events.
    }
  }
  if (latest === null) return []
  const windows: Record<string, unknown> = latest
  const limits: Limit[] = []
  for (const key of ['primary', 'secondary']) {
    const window = windows[key]
    if (!isRecord(window)) continue
    const minutes = window.window_minutes
    const used = window.used_percent
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0
      || typeof used !== 'number' || !Number.isFinite(used)) continue
    const kind = minutes === 300 ? 'session'
      : minutes === 10_080 ? 'weekly_all' : 'rate_window'
    const reset = window.resets_at
    limits.push({
      kind,
      model: '',
      windowMinutes: minutes,
      used,
      resetsAtMs: typeof reset === 'number' && Number.isFinite(reset) ? reset * 1000 : null,
    })
  }
  return limits
}

async function isVisible($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes().catch(() => [])).some(pane => pane.id === PANE && pane.isPlaced && pane.isShown)
}

// Sort across all seven calendar folders: a recently updated older session
// can be newer than every file in today's folder. Newest first, each file's
// tail is read until one holds rate limits: a fresh session names none before
// its first turn ends. Null when none does, so the last answer stands.
export async function readCodexLimits($: EngineInterface, home: string, now: number): Promise<Limit[] | null> {
  if (home === '' || !(await isVisible($))) return null
  const folders = Array.from({ length: 7 }, (_, back) => {
    const day = new Date(now)
    day.setDate(day.getDate() - back)
    const date = [day.getFullYear(), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0')]
    return `${home}/.codex/sessions/${date.join('/')}`
  })
  const batches = await Promise.all(folders.map(async folder => {
    if (!(await isVisible($))) return []
    const entries = await $.fs.list(folder).catch(() => [])
    return entries
      .filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl'))
      .map(entry => ({ path: `${folder}/${entry.name}`, mtimeMs: entry.mtimeMs, size: entry.size }))
  }))
  const files = batches.flat().sort((a, b) => b.mtimeMs - a.mtimeMs)
  const listed = new Set(files.map(file => file.path))
  for (const path of [...searched.keys()]) if (!listed.has(path)) searched.delete(path)
  for (const file of files.slice(0, FILES_SEARCHED)) {
    let held = searched.get(file.path)
    if (held?.mtimeMs !== file.mtimeMs || held.size !== file.size) {
      if (!(await isVisible($))) return null
      try {
        const ran = await $.process.run(['tail', '-c', String(TAIL_BYTES), '--', file.path], { timeoutMs: TIMEOUT_MS })
        if (ran.exitCode !== 0) throw new Error('tail')
        held = { mtimeMs: file.mtimeMs, size: file.size, limits: parseCodexLimits(ran.stdout, file.size > TAIL_BYTES) }
        searched.set(file.path, held)
      } catch {
        // Unreadable now: an older file may answer, and this one is read next time.
        continue
      }
    }
    if (held.limits.length > 0) return held.limits
  }
  return null
}
