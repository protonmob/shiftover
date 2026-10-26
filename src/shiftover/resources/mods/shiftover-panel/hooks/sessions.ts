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

type SourceCache = { file: string; mtimeMs: number; refreshedAt: number; list?: ChatSession[] }
type ChatModel = { model: string; effort: string }
type TranscriptCache = { size: number; mtimeMs: number; value: ChatModel }
type Starter = { sessionId: string | null; at: number }
let sourceCache: SourceCache | null = null
let isReading = false
let isSearching = false
let cmux: string | null = null
// Transcript search answers by job id, from refreshes and clicks: a found tab
// holds while open; a miss or a closed tab is searched again after a minute.
const starters = new Map<string, Starter>()
const transcripts = new Map<string, TranscriptCache>()

async function isPlaced($: EngineInterface): Promise<boolean> {
  return $.ui.panes().then(panes => panes.some(pane => pane.id === PANE && pane.isPlaced)).catch(() => false)
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

export function chatStatus(row: Record<string, unknown>): ChatSession['status'] {
  // cmux currently writes camelCase needsInput and backgroundWorkPending.
  // Notification can accompany idle runtimeStatus while a prompt is waiting.
  const lifecycle = text(row.agentLifecycle).toLowerCase().replace(/[^a-z]/g, '')
  const runtime = text(row.runtimeStatus).toLowerCase().replace(/[^a-z]/g, '')
  const waiting = /^(waiting(?:for(?:input|user|permission|approval))?|awaiting(?:user)?input|needs(?:input|approval)|permission(?:prompt|required)?|notification)$/
  if (text(row.hookEventName) === 'Notification' || waiting.test(lifecycle) || waiting.test(runtime)) return 'waiting'
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
  const seen = new Set<string>()
  for (const [id, row] of sessionRecords(raw)) {
    const surfaceId = text(row.surfaceId)
    const panel = panels.get(key(surfaceId))
    const pid = typeof row.pid === 'number' ? row.pid : 0
    if (!panel || !options.alivePids.has(pid) || seen.has(key(surfaceId))) continue
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
    seen.add(key(surfaceId))
  }
  const rank = { waiting: 0, running: 1, idle: 2 }
  // A stable sort preserves the source order within each status group.
  return chats.sort((a, b) => rank[a.status] - rank[b.status])
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

async function chatModels($: EngineInterface, list: ChatSession[], home: string): Promise<ChatSession[]> {
  const paths = new Set(list.map(chat => chat.transcriptPath))
  for (const path of transcripts.keys()) if (!paths.has(path)) transcripts.delete(path)
  return Promise.all(list.map(async chat => {
    const [last, current] = await Promise.all([
      transcriptModel($, chat.transcriptPath),
      $.fs.read(`${home}/.cache/shiftover/sessions/${chat.id}.json`).then(raw => {
        const row: unknown = JSON.parse(raw)
        return isRecord(row) && isRecord(row.model) ? row.model : {}
      }).catch(() => ({} as Record<string, unknown>)),
    ])
    return { ...chat, model: text(current.display_name) || formatModelId(text(current.id) || last.model), effort: last.effort }
  }))
}

// MARK: - Reading open tabs

export async function refreshChats($: EngineInterface, options: {
  home: string; configFile: string; accounts: Account[]; now: number; force?: boolean
}): Promise<ChatsSnapshot | null> {
  if (isReading) return null
  isReading = true
  const path = `${options.home}/.cmuxterm/claude-hook-sessions.json`
  try {
    if (!(await isPlaced($))) return null
    const stat = await $.fs.stat(path)
    if (!options.force && sourceCache?.file === path && sourceCache.mtimeMs === stat.mtimeMs &&
      options.now - sourceCache.refreshedAt < REFRESH_MS) {
      if (sourceCache.list === undefined) return null
      const list = await chatModels($, sourceCache.list, options.home)
      return await isPlaced($) ? { list, at: options.now, error: null } : null
    }
    if (!(await isPlaced($))) return null
    // A temporarily unavailable cmux socket still follows the same cadence.
    sourceCache = { file: path, mtimeMs: stat.mtimeMs, refreshedAt: options.now }
    const bin = await executable($)
    if (!(await isPlaced($))) { sourceCache = null; return null }
    const [raw, configText, workspaceResult, currentSessionId, currentSurfaceId] = await Promise.all([
      $.fs.read(path),
      $.fs.read(options.configFile).catch(() => ''),
      $.process.run([bin, 'list-workspaces', '--id-format', 'both'], { timeoutMs: TIMEOUT_MS }),
      $.session.id().catch(() => ''),
      $.env.get('CMUX_SURFACE_ID').then(value => value ?? '').catch(() => ''),
    ])
    if (workspaceResult.exitCode !== 0) throw new Error('sekmeler okunamadı')
    if (!(await isPlaced($))) { sourceCache = null; return null }
    const panelResults = await Promise.all(parseWorkspaces(workspaceResult.stdout).map(async workspaceId => {
      const result = await $.process.run([bin, 'list-panels', '--workspace', workspaceId, '--id-format', 'both'], { timeoutMs: TIMEOUT_MS })
      if (result.exitCode !== 0) throw new Error('sekmeler okunamadı')
      return parsePanels(result.stdout, workspaceId)
    }))
    const panels = panelResults.flat()
    const surfaces = new Set(panels.map(panel => key(panel.surfaceId)))
    const pids = [...new Set(sessionRecords(raw).map(([, row]) =>
      surfaces.has(key(text(row.surfaceId))) && typeof row.pid === 'number' && Number.isInteger(row.pid) && row.pid > 0 ? row.pid : 0,
    ).filter(pid => pid > 0))]
    const alivePids = new Set<number>()
    if (pids.length > 0) {
      if (!(await isPlaced($))) { sourceCache = null; return null }
      const result = await $.process.run(['ps', '-p', pids.join(','), '-o', 'pid='], { timeoutMs: TIMEOUT_MS })
      if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error('süreçler okunamadı')
      for (const pid of result.stdout.trim().split(/\s+/)) {
        const value = Number(pid)
        if (Number.isInteger(value) && value > 0) alivePids.add(value)
      }
    }
    if (!(await isPlaced($))) { sourceCache = null; return null }
    const list = parseSessions(raw, { ...options, configText, panels, alivePids, currentSessionId, currentSurfaceId })
    sourceCache.list = list
    const modeled = await chatModels($, list, options.home)
    return await isPlaced($) ? { list: modeled, at: options.now, error: null } : null
  } catch {
    if (!(await isPlaced($))) { sourceCache = null; return null }
    return { list: [], at: options.now, error: 'sohbetler okunamadı' }
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

// One grep answers every id: the first open chat, in list order, whose
// transcript holds it, else null. Null when no transcript can be searched.
async function searchTranscripts($: EngineInterface, ids: string[], chats: ChatSession[]): Promise<Map<string, string | null> | null> {
  const paths = [...new Set(chats.map(chat => chat.transcriptPath).filter(path => path !== ''))]
  if (paths.length === 0) return null
  let stdout = ''
  try {
    // Exit 1 is no match and 2 an unreadable transcript; the output holds.
    const args = ['-o', '-H', '-F', '-s', ...ids.flatMap(id => ['-e', id]), '--', ...paths]
    stdout = (await $.process.run(['grep', ...args], { timeoutMs: TIMEOUT_MS })).stdout
  } catch { /* A refused search finds no starter. */ }
  const found = new Map<string, Set<string>>()
  for (const line of stdout.split('\n')) {
    const id = ids.find(candidate => line.endsWith(`:${candidate}`))
    if (id !== undefined) found.set(id, (found.get(id) ?? new Set<string>()).add(line.slice(0, -id.length - 1)))
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
    if (!(await isPlaced($))) return false
    const now = await $.clock.now()
    const due = running.filter(job => !hasParent(job) && isSearchDue(job.id, chats, now)).map(job => job.id)
    if (due.length === 0) return false
    const found = await searchTranscripts($, due, chats)
    if (found === null || !(await isPlaced($))) return false
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
  if (!(await isPlaced($))) return
  try {
    const bin = await executable($)
    if (!(await isPlaced($))) return
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
  if (!(await isPlaced($))) return
  let chat = parentChat(job, chats)
  // No open parent: the cached search answer, searched again once it is due.
  // A cached tab that closed is never focused; another may hold its transcript.
  if (!chat) {
    const now = await $.clock.now()
    if (isSearchDue(job.id, chats, now)) {
      const found = await searchTranscripts($, [job.id], chats)
      if (!(await isPlaced($))) return
      if (found !== null) starters.set(job.id, { sessionId: found.get(job.id) ?? null, at: now })
    }
    chat = starterChat(job.id, chats)
  }
  if (!chat) $.ui.toast('başlatan sekme kapalı')
  else if (chat.isCurrent) $.ui.toast('bu sohbette')
  else await focusChat($, chat)
}
