import type { EngineInterface } from 'claude-code'
import type { Account, ChatSession, ChatsSnapshot } from '../types'
export type { ChatSession, ChatsSnapshot } from '../types'

// MARK: - Session sources

export type OpenPanel = { surfaceId: string; workspaceId: string; title: string }

const PANE = 'shiftover-panel'
const CMUX = '/Applications/cmux.app/Contents/Resources/bin/cmux'
const REFRESH_MS = 30_000
const TIMEOUT_MS = 5_000
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const key = (value: string): string => value.toLowerCase()
const normalizeDir = (value: string, home: string): string =>
  value.replace(/^~(?=\/|$)/, home).replace(/\/+$/, '')

type SourceCache = { file: string; mtimeMs: number; refreshedAt: number }
let sourceCache: SourceCache | null = null
let isReading = false
let cmux: string | null = null
// Only a click fills this cache; refreshes never search transcripts.
const delegateSessions = new Map<string, string | null>()

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

// MARK: - Reading open tabs

export async function refreshChats($: EngineInterface, options: {
  home: string; configFile: string; accounts: Account[]; now: number; force?: boolean
}): Promise<ChatsSnapshot | null> {
  if (isReading || !(await isPlaced($))) return null
  isReading = true
  const path = `${options.home}/.cmuxterm/claude-hook-sessions.json`
  try {
    const stat = await $.fs.stat(path)
    if (!options.force && sourceCache?.file === path && sourceCache.mtimeMs === stat.mtimeMs && options.now - sourceCache.refreshedAt < REFRESH_MS) return null
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
    const list = parseSessions(raw, { ...options, configText, panels, alivePids, currentSessionId, currentSurfaceId })
    return { list, at: options.now, error: null }
  } catch {
    return { list: [], at: options.now, error: 'sohbetler okunamadı' }
  } finally {
    isReading = false
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

export async function openDelegate($: EngineInterface, jobId: string, chats: ChatSession[]): Promise<void> {
  if (!(await isPlaced($))) return
  let matchedId = delegateSessions.get(jobId)
  // A cached tab that closed must never be focused; a different open tab may
  // now hold the starter's resumed transcript, so search this new set again.
  if (matchedId !== undefined && matchedId !== null && !chats.some(chat => chat.id === matchedId)) {
    delegateSessions.delete(jobId)
    matchedId = undefined
  }
  if (matchedId === undefined) {
    const paths = [...new Set(chats.map(chat => chat.transcriptPath).filter(path => path !== ''))]
    let match: ChatSession | undefined
    if (paths.length > 0) {
      try {
        const result = await $.process.run(['grep', '-l', '-F', '--', jobId, ...paths], { timeoutMs: TIMEOUT_MS })
        const found = new Set(result.stdout.split('\n').filter(path => path !== ''))
        match = chats.find(chat => found.has(chat.transcriptPath))
      } catch { /* A missing transcript has the same action as a closed starter. */ }
    }
    matchedId = match?.id ?? null
    delegateSessions.set(jobId, matchedId)
  }
  const chat = chats.find(candidate => candidate.id === matchedId)
  if (!chat) $.ui.toast('başlatan sekme kapalı')
  else if (chat.isCurrent) $.ui.toast('bu sohbette')
  else await focusChat($, chat)
}
