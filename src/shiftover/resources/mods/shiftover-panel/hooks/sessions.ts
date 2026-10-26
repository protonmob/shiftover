import type { EngineInterface } from 'claude-code'
import type { Account, ChatSession, ChatsSnapshot, Job } from '../types'
export type { ChatSession, ChatsSnapshot } from '../types'

// MARK: - Session sources

export type OpenPanel = { surfaceId: string; workspaceId: string; title: string }

const PANE = 'shiftover-panel'
const CMUX = '/Applications/cmux.app/Contents/Resources/bin/cmux'
const REFRESH_MS = 30_000
const TIMEOUT_MS = 5_000
const TRANSCRIPT_TAIL_BYTES = 256 * 1024
const STARTER_RETRY_MS = 60_000
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const key = (value: string): string => value.toLowerCase()
const normalizeDir = (value: string, home: string): string =>
  value.replace(/^~(?=\/|$)/, home).replace(/\/+$/, '')

// The sessions file changes with every hook event of every tab; cmux's tabs
// and their processes change far less. The file is read again on each change,
// cmux and ps only every thirty seconds, or at once for a tab or a process no
// earlier listing saw.
type SourceCache = { file: string; mtimeMs: number; raw: string; configText: string }
type TabsCache = { panels: OpenPanel[]; missing: Set<string>; at: number }
type PidsCache = { checked: Set<number>; alive: Set<number>; at: number }
type ChatModel = { model: string; effort: string }
type TranscriptCache = { size: number; mtimeMs: number; value: ChatModel }
type Starter = { sessionId: string | null; at: number }
let sourceCache: SourceCache | null = null
let tabsCache: TabsCache | null = null
let pidsCache: PidsCache | null = null
// Counts every change of the three caches above: the last list parsed names
// the revision and accounts it was parsed from. The last list answered.
let revision = 0
let parsed: { list: ChatSession[]; basis: string } | null = null
let lastList: ChatSession[] = []
let isReading = false
let isSearching = false
let cmux: string | null = null
// Each chat's place in the order it was first seen: see inSeenOrder.
const seen = new Map<string, number>()
let seenCount = 0
// Transcript search answers by job id, from refreshes and clicks: a found tab
// holds while open; a miss or a closed tab is searched again after a minute.
const starters = new Map<string, Starter>()
const transcripts = new Map<string, TranscriptCache>()

// Work only for a pane a surface places and shows, not one behind another tab.
async function isVisible($: EngineInterface): Promise<boolean> {
  return $.ui.panes().then(panes => panes.some(pane => pane.id === PANE && pane.isPlaced && pane.isShown))
    .catch(() => false)
}

async function executable($: EngineInterface): Promise<string> {
  if (cmux === null) cmux = await $.fs.exists(CMUX).then(exists => exists ? CMUX : 'cmux').catch(() => 'cmux')
  return cmux
}

// MARK: - Session parsing

export function parseWorkspaces(stdout: string): string[] {
  const ids = new Set<string>()
  for (const line of stdout.split('\n')) {
    const found = /\bworkspace:\d+\s+(\S+)/.exec(line)
    if (found?.[1]) ids.add(found[1])
  }
  return [...ids]
}

export function parsePanels(stdout: string, workspaceId: string): OpenPanel[] {
  const panels: OpenPanel[] = []
  for (const line of stdout.split('\n')) {
    const found = /\bsurface:\d+\s+(\S+)\s+terminal\b/.exec(line)
    if (!found?.[1]) continue
    const quoted = /"((?:\\.|[^"\\])*)"\s*$/.exec(line)
    let title = quoted?.[1] ?? ''
    if (quoted) {
      try { title = JSON.parse(`"${title}"`) as string } catch { /* Keep the terminal's literal title. */ }
    }
    panels.push({ surfaceId: found[1], workspaceId, title })
  }
  return panels
}

// Claude Code's Notification hook names its kind and says why: a permission
// prompt or an MCP elicitation asks the person, while the reminder after a
// minute at an idle prompt (`idle_prompt`) asks nothing new. A record that
// keeps neither asks only from inside a turn: the reminder follows its end.
function notificationAsks(row: Record<string, unknown>, lifecycle: string): boolean {
  const nested = isRecord(row.notification) ? row.notification : {}
  const first = (...values: unknown[]): string => values.map(text).find(value => value !== '')?.toLowerCase() ?? ''
  const kind = first(row.notificationType, row.notification_type, nested.notification_type, nested.type)
  if (kind !== '') return /permission|elicitation|approv/.test(kind)
  const message = first(row.notificationMessage, row.message, nested.message)
  if (message !== '') return /permission|approv|needs your (?:input|answer)/.test(message)
  return row.turnSettled !== true && lifecycle !== 'idle'
}

export function chatStatus(row: Record<string, unknown>): ChatSession['status'] {
  // cmux currently writes camelCase needsInput and backgroundWorkPending.
  // Notification can accompany idle runtimeStatus while a prompt is waiting.
  const lifecycle = text(row.agentLifecycle).toLowerCase().replace(/[^a-z]/g, '')
  const runtime = text(row.runtimeStatus).toLowerCase().replace(/[^a-z]/g, '')
  const waiting = /^(waiting(?:for(?:input|user|permission|approval))?|awaiting(?:user)?input|needs(?:input|approval)|permission(?:prompt|required)?)$/
  if (waiting.test(lifecycle) || waiting.test(runtime)) return 'waiting'
  const isNotified = text(row.hookEventName) === 'Notification' || lifecycle === 'notification' || runtime === 'notification'
  if (isNotified && notificationAsks(row, lifecycle)) return 'waiting'
  if (lifecycle === 'running' || runtime === 'running') return 'running'
  return 'idle'
}

function configAccounts(config: string, home: string): Map<string, string> {
  const names = new Map<string, string>()
  let account = ''
  for (const line of config.split('\n')) {
    const section = /^\s*\[accounts\.([\w-]+|"[^"]+"|'[^']+')\]\s*(?:#.*)?$/.exec(line)
    if (section) { account = (section[1] ?? '').replace(/^["']|["']$/g, ''); continue }
    if (/^\s*\[/.test(line)) { account = ''; continue }
    const dir = /^\s*dir\s*=\s*["']([^"']+)["']/.exec(line)
    if (account && dir?.[1]) names.set(normalizeDir(dir[1], home), account)
  }
  return names
}

type ParseOptions = {
  home: string
  accounts: Account[]
  configText: string
  panels: OpenPanel[]
  alivePids: ReadonlySet<number>
  currentSessionId: string
  currentSurfaceId: string
}

function sessionRecords(raw: string): [string, Record<string, unknown>][] {
  const data: unknown = JSON.parse(raw)
  if (!isRecord(data) || !isRecord(data.sessions)) return []
  return Object.entries(data.sessions).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
}

export function parseSessions(raw: string, options: ParseOptions): ChatSession[] {
  const panels = new Map(options.panels.map(panel => [key(panel.surfaceId), panel]))
  const names = configAccounts(options.configText, options.home)
  for (const account of options.accounts) {
    if (account.dir) names.set(normalizeDir(account.dir, options.home), account.name)
  }
  const chats: ChatSession[] = []
  const seenSurfaces = new Set<string>()
  for (const [id, row] of sessionRecords(raw)) {
    const surfaceId = text(row.surfaceId)
    const panel = panels.get(key(surfaceId))
    const pid = typeof row.pid === 'number' ? row.pid : 0
    if (!panel || !options.alivePids.has(pid) || seenSurfaces.has(key(surfaceId))) continue
    const launch = isRecord(row.launchCommand) ? row.launchCommand : {}
    const environment = isRecord(launch.environment) ? launch.environment : {}
    const dir = text(environment.CLAUDE_CONFIG_DIR) || `${options.home}/.claude`
    const fallback = text(row.cwd).replace(/\/+$/, '').split('/').pop() || 'Claude Code'
    chats.push({
      id,
      surfaceId,
      workspaceId: panel.workspaceId,
      pid,
      title: panel.title || fallback,
      account: names.get(normalizeDir(dir, options.home)) ?? '-',
      model: '',
      effort: '',
      status: chatStatus(row),
      isCurrent: id === options.currentSessionId || (options.currentSurfaceId !== '' && key(surfaceId) === key(options.currentSurfaceId)),
      transcriptPath: text(row.transcriptPath),
    })
    seenSurfaces.add(key(surfaceId))
  }
  const rank = { waiting: 0, running: 1, idle: 2 }
  // A stable sort preserves the source order within each status group.
  return chats.sort((a, b) => rank[a.status] - rank[b.status])
}

// A chat keeps the place it first took within its status group, whatever
// order cmux writes its file in: capsules move only when a status changes,
// so a click lands on the capsule that was under the pointer.
function inSeenOrder(list: ChatSession[]): ChatSession[] {
  const ids = new Set(list.map(chat => chat.id))
  for (const id of [...seen.keys()]) if (!ids.has(id)) seen.delete(id)
  for (const chat of list) if (!seen.has(chat.id)) seen.set(chat.id, seenCount++)
  const rank = { waiting: 0, running: 1, idle: 2 }
  return [...list].sort((a, b) => rank[a.status] - rank[b.status] || (seen.get(a.id) ?? 0) - (seen.get(b.id) ?? 0))
}

// MARK: - Chat models

export function formatModelId(id: string): string {
  const clean = id.replace(/^claude-/, '').replace(/\[[^\]]*\]/g, '').replace(/-\d{8}$/, '')
  const [family = '', ...version] = clean.split('-').filter(Boolean)
  return [family.charAt(0).toUpperCase() + family.slice(1), version.join('.')].filter(Boolean).join(' ')
}

export function parseTranscriptTail(raw: string, truncated = false): ChatModel {
  const lines = raw.split('\n')
  for (let index = lines.length - 1; index >= (truncated ? 1 : 0); index -= 1) {
    try {
      const row: unknown = JSON.parse(lines[index]!)
      if (!isRecord(row) || row.type !== 'assistant') continue
      const message = isRecord(row.message) ? row.message : {}
      return { model: text(message.model), effort: text(row.effort) }
    } catch { /* A tail can start mid-line or end during a write. */ }
  }
  return { model: '', effort: '' }
}

async function transcriptModel($: EngineInterface, path: string): Promise<ChatModel> {
  const unknown = { model: '', effort: '' }
  if (path === '') return unknown
  try {
    const stat = await $.fs.stat(path)
    const cached = transcripts.get(path)
    if (cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.value
    let value = unknown
    try {
      const result = await $.process.run(['tail', '-c', String(TRANSCRIPT_TAIL_BYTES), '--', path], { timeoutMs: TIMEOUT_MS })
      if (result.exitCode === 0) value = parseTranscriptTail(result.stdout, stat.size > TRANSCRIPT_TAIL_BYTES)
    } catch { /* An unreadable transcript leaves the model and effort unknown. */ }
    transcripts.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, value })
    return value
  } catch {
    return unknown
  }
}

// shiftover keeps each session's model under its cache directory, which
// honours XDG_CACHE_HOME as its jobs do.
async function chatModels($: EngineInterface, list: ChatSession[], cacheDir: string): Promise<ChatSession[]> {
  const paths = new Set(list.map(chat => chat.transcriptPath))
  for (const path of transcripts.keys()) if (!paths.has(path)) transcripts.delete(path)
  return Promise.all(list.map(async chat => {
    const [last, current] = await Promise.all([
      transcriptModel($, chat.transcriptPath),
      $.fs.read(`${cacheDir}/sessions/${chat.id}.json`).then(raw => {
        const row: unknown = JSON.parse(raw)
        return isRecord(row) && isRecord(row.model) ? row.model : {}
      }).catch(() => ({} as Record<string, unknown>)),
    ])
    return { ...chat, model: text(current.display_name) || formatModelId(text(current.id) || last.model), effort: last.effort }
  }))
}

// MARK: - Reading open tabs

async function listTabs($: EngineInterface, bin: string): Promise<OpenPanel[]> {
  const workspaces = await $.process.run([bin, 'list-workspaces', '--id-format', 'both'], { timeoutMs: TIMEOUT_MS })
  if (workspaces.exitCode !== 0) throw new Error('sekmeler okunamadı')
  const panelResults = await Promise.all(parseWorkspaces(workspaces.stdout).map(async workspaceId => {
    const result = await $.process.run([bin, 'list-panels', '--workspace', workspaceId, '--id-format', 'both'], { timeoutMs: TIMEOUT_MS })
    if (result.exitCode !== 0) throw new Error('sekmeler okunamadı')
    return parsePanels(result.stdout, workspaceId)
  }))
  return panelResults.flat()
}

async function alive($: EngineInterface, pids: number[]): Promise<Set<number>> {
  const found = new Set<number>()
  if (pids.length === 0) return found
  const result = await $.process.run(['ps', '-p', pids.join(','), '-o', 'pid='], { timeoutMs: TIMEOUT_MS })
  if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error('süreçler okunamadı')
  for (const pid of result.stdout.trim().split(/\s+/)) {
    const value = Number(pid)
    if (Number.isInteger(value) && value > 0) found.add(value)
  }
  return found
}

// Null when there is nothing to say, as while the pane is hidden. A failure
// keeps the last list and names the error; the next tick tries cmux again.
export async function refreshChats($: EngineInterface, options: {
  home: string; cacheDir: string; configFile: string; accounts: Account[]; now: number; force?: boolean
}): Promise<ChatsSnapshot | null> {
  if (isReading) return null
  isReading = true
  const path = `${options.home}/.cmuxterm/claude-hook-sessions.json`
  const force = options.force === true
  const isDue = (at: number): boolean => force || options.now - at >= REFRESH_MS
  try {
    if (!(await isVisible($))) return null
    const stat = await $.fs.stat(path)
    if (force || sourceCache?.file !== path || sourceCache.mtimeMs !== stat.mtimeMs) {
      if (!(await isVisible($))) return null
      const [raw, configText] = await Promise.all([$.fs.read(path), $.fs.read(options.configFile).catch(() => '')])
      sourceCache = { file: path, mtimeMs: stat.mtimeMs, raw, configText }
      revision += 1
    }
    const source = sourceCache
    const records = sessionRecords(source.raw)
    const surfaces = records.map(([, row]) => key(text(row.surfaceId)))
    const isListed = (tabs: TabsCache, surface: string): boolean =>
      tabs.missing.has(surface) || tabs.panels.some(panel => key(panel.surfaceId) === surface)
    let tabs = tabsCache
    if (tabs === null || isDue(tabs.at) || !surfaces.every(surface => isListed(tabs!, surface))) {
      const bin = await executable($)
      if (!(await isVisible($))) return null
      const panels = await listTabs($, bin)
      const open = new Set(panels.map(panel => key(panel.surfaceId)))
      tabs = tabsCache = { panels, missing: new Set(surfaces.filter(surface => !open.has(surface))), at: options.now }
      revision += 1
    }
    const open = new Set(tabs.panels.map(panel => key(panel.surfaceId)))
    const pids = [...new Set(records.map(([, row]) =>
      open.has(key(text(row.surfaceId))) && typeof row.pid === 'number' && Number.isInteger(row.pid) && row.pid > 0 ? row.pid : 0,
    ).filter(pid => pid > 0))]
    let checked = pidsCache
    if (checked === null || isDue(checked.at) || !pids.every(pid => checked!.checked.has(pid))) {
      if (!(await isVisible($))) return null
      checked = pidsCache = { checked: new Set(pids), alive: await alive($, pids), at: options.now }
      revision += 1
    }
    const basis = `${revision}\n${options.accounts.map(account => `${account.name}=${account.dir}`).join('\n')}`
    let list = parsed?.basis === basis && !force ? parsed.list : null
    if (list === null) {
      if (!(await isVisible($))) return null
      const [currentSessionId, currentSurfaceId] = await Promise.all([
        $.session.id().catch(() => ''),
        $.env.get('CMUX_SURFACE_ID').then(value => value ?? '').catch(() => ''),
      ])
      list = inSeenOrder(parseSessions(source.raw, { ...options, configText: source.configText, panels: tabs.panels,
        alivePids: checked.alive, currentSessionId, currentSurfaceId }))
      parsed = { list, basis }
    }
    const modeled = await chatModels($, list, options.cacheDir)
    if (!(await isVisible($))) return null
    lastList = modeled
    return { list: modeled, at: options.now, error: null }
  } catch {
    // A transient cmux, ps or half-written file: read all again next tick.
    sourceCache = null
    tabsCache = null
    pidsCache = null
    if (!(await isVisible($))) return null
    return { list: lastList, at: options.now, error: 'sohbetler okunamadı' }
  } finally {
    isReading = false
  }
}

// MARK: - Starters

const hasParent = (job: Pick<Job, 'parentSessionId' | 'parentPid'>): boolean =>
  Boolean(job.parentSessionId) || (job.parentPid !== undefined && job.parentPid > 0)

const starterChat = (jobId: string, chats: ChatSession[]): ChatSession | undefined => {
  const sessionId = starters.get(jobId)?.sessionId
  return sessionId ? chats.find(chat => chat.id === sessionId) : undefined
}

function isSearchDue(jobId: string, chats: ChatSession[], now: number): boolean {
  const held = starters.get(jobId)
  if (held === undefined) return true
  if (held.sessionId !== null && chats.some(chat => chat.id === held.sessionId)) return false
  return now - held.at >= STARTER_RETRY_MS
}

// The delegate tool answers with its job as JSON, `"job_id": "<id>"`, which a
// transcript keeps inside an escaped string. Only that answer names the
// starter: a tab that merely printed the id, as `shiftover jobs` does, not.
const jobIdPattern = (id: string): string =>
  `job_id\\\\?"[[:space:]]*:[[:space:]]*\\\\?"${id.replace(/[.[\]()*+?^$|\\{}]/g, '\\$&')}\\\\?"`

// One grep answers every id: the first open chat, in list order, whose
// transcript holds its delegate answer, else null. Null when no transcript
// can be searched.
async function searchTranscripts($: EngineInterface, ids: string[], chats: ChatSession[]): Promise<Map<string, string | null> | null> {
  const paths = [...new Set(chats.map(chat => chat.transcriptPath).filter(path => path !== ''))]
  if (paths.length === 0) return null
  let stdout = ''
  try {
    // Exit 1 is no match and 2 an unreadable transcript; the output holds.
    const args = ['-o', '-H', '-E', '-s', ...ids.flatMap(id => ['-e', jobIdPattern(id)]), '--', ...paths]
    stdout = (await $.process.run(['grep', ...args], { timeoutMs: TIMEOUT_MS })).stdout
  } catch { /* A refused search finds no starter. */ }
  const found = new Map<string, Set<string>>()
  for (const line of stdout.split('\n')) {
    // Each line is `<path>:<match>`, the match ending in the id and a quote.
    const path = paths.filter(candidate => line.startsWith(`${candidate}:`))
      .sort((a, b) => b.length - a.length)[0]
    if (path === undefined) continue
    const match = line.slice(path.length + 1).replace(/\\?"$/, '')
    const id = ids.find(candidate => match.endsWith(`"${candidate}`))
    if (id !== undefined) found.set(id, (found.get(id) ?? new Set<string>()).add(path))
  }
  return new Map(ids.map(id => [id, chats.find(chat => found.get(id)?.has(chat.transcriptPath))?.id ?? null]))
}

// Older shiftover writes no parent fields: a search names their starter.
export function parentChat(job: Pick<Job, 'id' | 'parentSessionId' | 'parentPid'>, chats: ChatSession[]): ChatSession | undefined {
  if (!hasParent(job)) return starterChat(job.id, chats)
  return (job.parentSessionId ? chats.find(chat => chat.id === job.parentSessionId) : undefined)
    ?? (job.parentPid !== undefined && job.parentPid > 0 ? chats.find(chat => chat.pid === job.parentPid) : undefined)
}

// A refresh searches only for parentless running jobs that are due, in one
// grep; true when it found a new starter. Never runs from a render.
export async function refreshStarters($: EngineInterface, jobs: Job[], chats: ChatSession[]): Promise<boolean> {
  const running = jobs.filter(job => job.status === 'running')
  // An answer lasts while its job is listed: a finished job's press reuses it.
  const listed = new Set(jobs.map(job => job.id))
  for (const id of [...starters.keys()]) if (!listed.has(id)) starters.delete(id)
  if (isSearching) return false
  isSearching = true
  try {
    if (!(await isVisible($))) return false
    const now = await $.clock.now()
    const due = running.filter(job => !hasParent(job) && isSearchDue(job.id, chats, now)).map(job => job.id)
    if (due.length === 0) return false
    const found = await searchTranscripts($, due, chats)
    if (found === null || !(await isVisible($))) return false
    let isNew = false
    for (const [id, sessionId] of found) {
      isNew ||= sessionId !== null && starters.get(id)?.sessionId !== sessionId
      starters.set(id, { sessionId, at: now })
    }
    return isNew
  } finally {
    isSearching = false
  }
}

// MARK: - Click to jump

export async function focusChat($: EngineInterface, chat: ChatSession): Promise<void> {
  if (!(await isVisible($))) return
  try {
    const bin = await executable($)
    if (!(await isVisible($))) return
    const selected = await $.process.run([bin, 'select-workspace', '--workspace', chat.workspaceId], { timeoutMs: TIMEOUT_MS })
    if (selected.exitCode !== 0) throw new Error('workspace')
    // Selecting another workspace can detach the originating pane. Finish
    // the click's navigation even when that first command hides its source.
    const focused = await $.process.run([bin, 'focus-panel', '--panel', chat.surfaceId, '--workspace', chat.workspaceId], { timeoutMs: TIMEOUT_MS })
    if (focused.exitCode !== 0) throw new Error('panel')
  } catch {
    $.ui.toast('sekme açılamadı')
  }
}

export async function openDelegate($: EngineInterface, job: Job, chats: ChatSession[]): Promise<void> {
  if (!(await isVisible($))) return
  let chat = parentChat(job, chats)
  // No open parent: the cached search answer, searched again once it is due.
  // A cached tab that closed is never focused; another may hold its transcript.
  if (!chat) {
    const now = await $.clock.now()
    if (isSearchDue(job.id, chats, now)) {
      const found = await searchTranscripts($, [job.id], chats)
      if (!(await isVisible($))) return
      if (found !== null) starters.set(job.id, { sessionId: found.get(job.id) ?? null, at: now })
    }
    chat = starterChat(job.id, chats)
  }
  if (!chat) $.ui.toast('başlatan sekme kapalı')
  else if (chat.isCurrent) $.ui.toast('bu sohbette')
  else await focusChat($, chat)
}
