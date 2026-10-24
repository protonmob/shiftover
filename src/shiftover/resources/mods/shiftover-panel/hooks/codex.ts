import type { EngineInterface } from 'claude-code'
import type { Limit } from '../types'

const PANE = 'shiftover-panel'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// A partial last line is normal while Codex appends to its transcript. Keep
// the last complete rate_limits object, wherever that event nests it.
export function parseCodexLimits(raw: string): Limit[] {
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
  for (const line of raw.split('\n')) {
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
    const kind = window.window_minutes === 300 ? 'session'
      : window.window_minutes === 10_080 ? 'weekly_all' : null
    const used = window.used_percent
    if (kind === null || typeof used !== 'number' || !Number.isFinite(used)) continue
    const reset = window.resets_at
    limits.push({
      kind,
      model: '',
      used,
      resetsAtMs: typeof reset === 'number' && Number.isFinite(reset) ? reset * 1000 : null,
    })
  }
  return limits
}

async function isPlaced($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes().catch(() => [])).some(pane => pane.id === PANE && pane.isPlaced)
}

// Sort across all seven calendar folders: a recently updated older session
// can be newer than every file in today's folder.
export async function readCodexLimits($: EngineInterface, home: string, now: number): Promise<Limit[]> {
  if (home === '' || !(await isPlaced($))) return []
  const folders = Array.from({ length: 7 }, (_, back) => {
    const day = new Date(now)
    day.setDate(day.getDate() - back)
    const date = [day.getFullYear(), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0')]
    return `${home}/.codex/sessions/${date.join('/')}`
  })
  const batches = await Promise.all(folders.map(async folder => {
    const entries = await $.fs.list(folder).catch(() => [])
    return entries
      .filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl'))
      .map(entry => ({ path: `${folder}/${entry.name}`, mtimeMs: entry.mtimeMs }))
  }))
  const newest = batches.flat().sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  if (newest === undefined || !(await isPlaced($))) return []
  try {
    return parseCodexLimits(await $.fs.read(newest.path))
  } catch {
    return []
  }
}
