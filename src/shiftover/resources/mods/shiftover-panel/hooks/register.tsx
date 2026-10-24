import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register, RenderChildren, TextProps, Timer, TurnStepResult } from 'claude-code'

import type { Account, AccountsSnapshot, AgentsSnapshot, ChatSession, Job, JobsSnapshot, Limit, PaneAgent,
  SessionSnapshot, UsageTotals, CodexSnapshot } from '../types'

import { readCodexLimits } from './codex'
import { refreshChats, focusChat, openDelegate } from './sessions'
import type { ChatsSnapshot } from './sessions'

// MARK: - Constants

const PANE = 'shiftover-panel'
const TITLE = 'Shiftover'
const JOBS_MS = 10_000
const ACCOUNTS_MS = 60_000
const FRAME_MS = 100
const MIN_FRAME_MS = 67
const WAITING_BLINK_MS = 600
const IDLE_BLINK_MS = 1_500
const POP_MS = 250
const FINISH_MS = 2_000
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const CAPSULES_SHOWN = 3
const UNVERIFIED_RUNNING_MS = 2 * 60 * 60 * 1000
// Requested dock width; drawing uses the actual bodyColumns grant.
const DOCK_COLUMNS = 42

// MARK: - State

const NO_ACCOUNTS: AccountsSnapshot = { list: [], current: null, at: 0, error: null }
const NO_JOBS: JobsSnapshot = { list: [], at: 0, error: null }
const NO_SESSION: SessionSnapshot = { usage: null, mcpServers: null, at: 0, error: null }
const NO_CODEX: CodexSnapshot = { limits: [], at: 0, error: null }
const NO_CHATS: ChatsSnapshot = { list: [], at: 0, error: null }
const NO_AGENTS: AgentsSnapshot = { list: [], at: 0, error: null }
const NO_TOTALS: UsageTotals = {
  startedAt: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
  responses: 0, usageResponses: 0, responseIds: [], activeMs: 0, turns: 0, turnIds: [],
}

// Bump a tag when its snapshot's fields change: what an earlier version
// stored outlives a reload, and the tag is how the new code declines it.
const accounts = atom({ plugin: 'shiftover-panel', key: 'accounts' } as const, NO_ACCOUNTS, {
  shape: 'accounts-1',
})
const jobs = atom({ plugin: 'shiftover-panel', key: 'jobs' } as const, NO_JOBS, { shape: 'jobs-1' })
const isDismissed = atom({ plugin: 'shiftover-panel', key: 'isDismissed' } as const, false)
const session = atom({ plugin: 'shiftover-panel', key: 'session' } as const, NO_SESSION, { shape: 'session-2' })
const totals = atom({ plugin: 'shiftover-panel', key: 'totals' } as const, NO_TOTALS, { shape: 'totals-1' })
const codex = atom({ plugin: 'shiftover-panel', key: 'codex' } as const, NO_CODEX, { shape: 'codex-1' })
const chats = atom({ plugin: 'shiftover-panel', key: 'chats' } as const, NO_CHATS, { shape: 'chats-1' })
const agents = atom({ plugin: 'shiftover-panel', key: 'agents' } as const, NO_AGENTS, { shape: 'agents-1' })

// What the module keeps between timer ticks; a reload starts it over.
type Files = { home: string; jobsDir: string; configFile: string; bin: string }
type CachedJob = { mtimeMs: number; size: number; job: Job | null }

let files: Files | null = null
let poller: Timer | null = null
let animation: Timer | null = null
let animationDue = Number.POSITIVE_INFINITY
let animationGeneration = 0
let lastFrameAt = Number.NEGATIVE_INFINITY
let repaintPending = false
let chatsRunning = false
let chatsWaiting = false
let chatsIdle = false
let motionJobs = NO_JOBS
let motionAgents = NO_AGENTS
let jobsObserved = false
let agentsObserved = false
const jobStatuses = new Map<string, string>()
const finishedMotion = new Map<string, number>()
let isReadingJobs = false
let isReadingAccounts = false
let isReadingSession = false
let isReadingChats = false
let isReadingCodex = false
let sessionGeneration = 0
let accountsTriedAt = Number.NEGATIVE_INFINITY
const jobFiles = new Map<string, CachedJob>()

// MARK: - Parsing

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const asText = (value: unknown): string => (typeof value === 'string' ? value : '')
const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value))
const firstLine = (value: string): string => value.trim().split('\n')[0] ?? ''
const describe = (err: unknown): string =>
  firstLine(err instanceof Error ? err.message : String(err)).slice(0, 80)

// shiftover writes ISO times with microseconds; a bare number is epoch seconds.
function toEpochMs(value: unknown): number | null {
  const seconds = asNumber(value)
  if (seconds !== null) return seconds < 1e12 ? seconds * 1000 : seconds
  const iso = asText(value)
  if (iso === '') return null
  const ms = Date.parse(iso)
  const fallback = Number.isFinite(ms) ? ms : Date.parse(iso.replace(/(\.\d{3})\d+/, '$1'))
  return Number.isFinite(fallback) ? fallback : null
}

function parseLimit(row: Record<string, unknown>): Limit[] {
  const used = asNumber(row.used)
  if (used === null) return []
  return [{ kind: asText(row.kind), model: asText(row.model), used, resetsAtMs: toEpochMs(row.resets_at) }]
}

function parseAccounts(stdout: string): Account[] {
  const data: unknown = JSON.parse(stdout)
  if (!Array.isArray(data)) throw new Error('shiftover status: liste bekleniyordu')
  return data
    .filter(isRecord)
    .map(row => ({
      name: asText(row.name),
      email: asText(row.email),
      dir: asText(row.dir),
      limits: Array.isArray(row.limits) ? row.limits.filter(isRecord).flatMap(parseLimit) : [],
      err: asText(row.err) === '' ? null : asText(row.err),
    }))
    .filter(account => account.name !== '')
}

function parseJob(raw: string, fileName: string): Job | null {
  const row: unknown = JSON.parse(raw)
  if (!isRecord(row)) return null
  const finished = asNumber(row.finished)
  return {
    id: asText(row.id) || fileName.replace(/\.json$/, ''),
    account: asText(row.account),
    model: asText(row.model),
    // Keep the stored job shape: the directory is only a display fallback.
    label: asText(row.label).trim() === ''
      ? asText(row.cwd).replace(/\/+$/, '').split('/').pop() ?? ''
      : asText(row.label),
    status: asText(row.status) || 'unknown',
    pid: asNumber(row.pid) ?? 0,
    startedMs: (asNumber(row.started) ?? 0) * 1000,
    finishedMs: finished !== null && finished > 0 ? finished * 1000 : null,
    durationMs: asNumber(row.duration_ms),
    costUsd: asNumber(row.cost_usd),
  }
}

// MARK: - Reading

async function locate($: EngineInterface): Promise<Files> {
  if (files !== null) return files
  const home = (await $.env.get('HOME')) ?? ''
  if (home === '') throw new Error('HOME tanımsız')
  const cache = (await $.env.get('XDG_CACHE_HOME')) || `${home}/.cache`
  const config = (await $.env.get('XDG_CONFIG_HOME')) || `${home}/.config`
  const local = `${home}/.local/bin/shiftover`
  const hasLocal = await $.fs.exists(local).catch(() => false)
  files = {
    home,
    jobsDir: `${cache}/shiftover/jobs`,
    configFile: `${config}/shiftover/config.toml`,
    bin: hasLocal ? local : 'shiftover',
  }
  return files
}

const normalizeDir = (dir: string, home: string): string =>
  dir.replace(/^~(?=\/|$)/, home).replace(/\/+$/, '')

async function readMain($: EngineInterface, configFile: string): Promise<string | null> {
  try {
    if (!(await isPlaced($))) return null
    for (const raw of (await $.fs.read(configFile)).split('\n')) {
      const line = raw.trim()
      if (line.startsWith('[')) break
      const found = /^main\s*=\s*["']([^"']+)["']/.exec(line)
      if (found) return found[1] ?? null
    }
  } catch {
    // No config file: the account stays unknown.
  }
  return null
}

// Claude Code reads CLAUDE_CONFIG_DIR, else ~/.claude: the account on that
// dir is this session's. Then shiftover's own word, then its main account.
async function currentAccount($: EngineInterface, list: Account[], at: Files): Promise<string | null> {
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${at.home}/.claude`
  const byDir = list.find(account => normalizeDir(account.dir, at.home) === normalizeDir(dir, at.home))
  if (byDir) return byDir.name
  const named = await $.env.get('SHIFTOVER_ACCOUNT')
  if (named && list.some(account => account.name === named)) return named
  const main = await readMain($, at.configFile)
  return main !== null && list.some(account => account.name === main) ? main : null
}

async function refreshAccounts($: EngineInterface): Promise<void> {
  if (isReadingAccounts || !(await isPlaced($))) return
  isReadingAccounts = true
  try {
    await reconcileMotion($, true)
    accountsTriedAt = await $.clock.now()
    const at = await locate($)
    if (!(await isPlaced($))) return
    const ran = await $.process.run([at.bin, 'status', '--json'], { timeoutMs: 25_000 })
    if (ran.exitCode !== 0) {
      const why = firstLine(ran.stderr)
      throw new Error(`shiftover status ${ran.exitCode}${why === '' ? '' : `: ${why}`}`)
    }
    if (!(await isPlaced($))) return
    const list = parseAccounts(ran.stdout)
    const current = await currentAccount($, list, at)
    const now = await $.clock.now()
    const snapshot = { list, current, at: now, error: null }
    await update($, accounts, () => snapshot)
  } catch (err) {
    const error = describe(err)
    await update($, accounts, held => ({ ...held, error })).catch(() => undefined)
  } finally {
    isReadingAccounts = false
    await reconcileMotion($, true)
  }
}

// Reads only the job files that changed since the last tick.
async function readJobs($: EngineInterface, dir: string): Promise<Job[]> {
  if (!(await isPlaced($))) return []
  if (!(await $.fs.exists(dir))) {
    jobFiles.clear()
    return []
  }
  if (!(await isPlaced($))) return []
  const entries = (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.json'))
  const names = new Set(entries.map(entry => entry.name))
  for (const name of [...jobFiles.keys()]) if (!names.has(name)) jobFiles.delete(name)
  for (const entry of entries) {
    const held = jobFiles.get(entry.name)
    if (held && held.mtimeMs === entry.mtimeMs && held.size === entry.size) continue
    try {
      if (!(await isPlaced($))) return []
      const job = parseJob(await $.fs.read(`${dir}/${entry.name}`), entry.name)
      jobFiles.set(entry.name, { mtimeMs: entry.mtimeMs, size: entry.size, job })
    } catch {
      // Caught mid-write: keep what it held, read it again next tick.
      jobFiles.set(entry.name, { mtimeMs: -1, size: -1, job: held?.job ?? null })
    }
  }
  return [...jobFiles.values()].flatMap(held => (held.job ? [held.job] : []))
}

// A job's file says `running` until shiftover collects it; `ps` says whether
// its process is still there. Null when `ps` gave no answer.
async function livePids($: EngineInterface, pids: number[]): Promise<Set<number> | null> {
  if (pids.length === 0) return new Set()
  try {
    if (!(await isPlaced($))) return null
    const ran = await $.process.run(['ps', '-ww', '-o', 'pid=,command=', '-p', pids.join(',')], {
      timeoutMs: 5_000,
    })
    if ((ran.exitCode !== 0 && ran.exitCode !== 1) ||
      (ran.exitCode === 1 && ran.stderr.trim() !== '')) return null
    const live = new Set<number>()
    for (const line of ran.stdout.split('\n')) {
      const found = /^\s*(\d+)\s+(.*)$/.exec(line)
      if (found && /claude|codex/i.test(found[2] ?? '')) live.add(Number(found[1]))
    }
    return live
  } catch {
    return null
  }
}

function pickJobs(all: Job[]): Job[] {
  const ended = (job: Job): number => job.finishedMs ?? job.startedMs
  const running = all.filter(job => job.status === 'running').sort((a, b) => b.startedMs - a.startedMs)
  const finished = all
    .filter(job => job.status !== 'running')
    .sort((a, b) => ended(b) - ended(a))
  return [...running, ...finished]
}

async function refreshJobs($: EngineInterface): Promise<void> {
  if (isReadingJobs || !(await isPlaced($))) return
  isReadingJobs = true
  try {
    const all = await readJobs($, (await locate($)).jobsDir)
    if (!(await isPlaced($))) return
    const pids = all.filter(job => job.status === 'running' && job.pid > 0).map(job => job.pid)
    const live = await livePids($, pids)
    const now = await $.clock.now()
    const isStale = (job: Job): boolean => {
      if (job.status !== 'running') return false
      if (job.pid <= 0) return true
      if (live !== null) return !live.has(job.pid)
      const age = now - job.startedMs
      return !(job.startedMs > 0 && age >= 0 && age < UNVERIFIED_RUNNING_MS)
    }
    const list = pickJobs(all.map(job => (isStale(job) ? { ...job, status: 'stale' } : job)))
    const snapshot = { list, at: now, error: null }
    observeJobs(snapshot, now, await isPlaced($))
    await update($, jobs, () => snapshot)
  } catch (err) {
    const error = describe(err)
    await update($, jobs, held => ({ ...held, error })).catch(() => undefined)
  } finally {
    isReadingJobs = false
    await reconcileMotion($)
  }
}

const agentIsRunning = (agent: Pick<PaneAgent, 'status'>): boolean =>
  agent.status === 'running' || agent.status === 'pending' || agent.status === 'waiting'

async function recordResponse($: EngineInterface, result: TurnStepResult, agentId?: string): Promise<void> {
  if (result.stopReason === null && result.usage === null) return
  const id = JSON.stringify([agentId ?? null, result.turnId, result.index])
  await update($, totals, held => {
    if (held.responseIds.includes(id)) return held
    const usage = result.usage
    return {
      ...held,
      input: held.input + (usage?.input_tokens ?? 0),
      output: held.output + (usage?.output_tokens ?? 0),
      cacheRead: held.cacheRead + (usage?.cache_read_input_tokens ?? 0),
      cacheWrite: held.cacheWrite + (usage?.cache_creation_input_tokens ?? 0),
      responses: held.responses + 1,
      usageResponses: held.usageResponses + (usage === null ? 0 : 1),
      responseIds: [...held.responseIds, id],
    }
  })
}

// All three sources are local engine reads. In particular, summary never
// uses the token-count API. Even a forced tick may not read an unplaced pane.
async function refreshSession($: EngineInterface): Promise<void> {
  if (isReadingSession) return
  isReadingSession = true
  const generation = sessionGeneration
  try {
    if (!(await isPlaced($))) return
    const [usageResult, agentsResult] = await Promise.allSettled([
      $.session.usage({ breakdown: 'summary' }), $.agent.list(),
    ])
    if (generation !== sessionGeneration) return
    const now = await $.clock.now()
    if (usageResult.status === 'fulfilled') {
      const usage = usageResult.value
      await update($, totals, held => held.startedAt === null || held.startedAt === usage.startedAt
        ? { ...held, startedAt: usage.startedAt }
        : { ...NO_TOTALS, startedAt: usage.startedAt })
      const context = usage.context
      const summary = { startedAt: usage.startedAt,
        context: { window: context.window,
          ...(context.tokens === undefined ? {} : { tokens: context.tokens }),
          ...(context.percent === undefined ? {} : { percent: context.percent }),
          ...(context.breakdown === undefined ? {} : { breakdown: { totalTokens: context.breakdown.totalTokens } }) },
        ...(usage.cost === undefined ? {} : { cost: { usd: usage.cost.usd } }) }
      await update($, session, () => ({ usage: summary, mcpServers: null, at: now, error: null }))
    } else {
      await update($, session, held => ({ ...held, error: 'oturum okunamadı' }))
    }
    if (agentsResult.status === 'fulfilled') {
      const held = await read($, agents)
      const previous = new Map(held.list.map(agent => [agent.id, agent]))
      const list = agentsResult.value.map(agent => {
        const prior = previous.get(agent.id)
        return {
          ...agent, observedAt: prior?.observedAt ?? now,
          finishedAt: agentIsRunning(agent) ? null : prior?.finishedAt ?? now,
        }
      })
      const snapshot = { list, at: now, error: null }
      observeAgents(snapshot, now, await isPlaced($))
      await update($, agents, () => snapshot)
    } else {
      await update($, agents, held => ({ ...held, error: 'Ajanlar okunamadı' }))
    }
  } catch {
    // Keep the last good snapshot if the surface disappears during a read.
  } finally {
    isReadingSession = false
    await reconcileMotion($)
  }
}

async function refreshCodex($: EngineInterface): Promise<void> {
  if (isReadingCodex || !(await isPlaced($))) return
  isReadingCodex = true
  try {
    const limits = await readCodexLimits($, (await locate($)).home, await $.clock.now())
    const now = await $.clock.now()
    const snapshot = { limits, at: now, error: null }
    await update($, codex, () => snapshot)
  } catch {
    // A missing Codex history is a row of unknown limits.
    const now = await $.clock.now()
    await update($, codex, () => ({ ...NO_CODEX, at: now }))
  } finally {
    isReadingCodex = false
    await reconcileMotion($)
  }
}

async function refreshConversations($: EngineInterface, force = false): Promise<void> {
  if (isReadingChats || !(await isPlaced($))) return
  isReadingChats = true
  try {
    const at = await locate($)
    const snapshot = await refreshChats($, { home: at.home, configFile: at.configFile,
      accounts: (await read($, accounts)).list, now: await $.clock.now(), force })
    if (snapshot !== null) {
      observeChats(snapshot)
      await update($, chats, () => snapshot)
    }
  } finally {
    isReadingChats = false
    await reconcileMotion($)
  }
}

// MARK: - Timers

async function isPlaced($: EngineInterface): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
  } catch {
    return false
  }
}

function stopAnimation(): void {
  animation?.cancel()
  animation = null
  animationDue = Number.POSITIVE_INFINITY
  animationGeneration += 1
  repaintPending = false
}

function settleMotion(): void {
  stopAnimation()
  finishedMotion.clear()
}

function observeJobs(snapshot: JobsSnapshot, now: number, animate: boolean): void {
  motionJobs = snapshot
  jobsObserved = true
  observeTaskMotion(now, animate)
}

function observeAgents(snapshot: AgentsSnapshot, now: number, animate: boolean): void {
  motionAgents = snapshot
  agentsObserved = true
  observeTaskMotion(now, animate)
}

function chatsOf(snapshot: ChatsSnapshot): ChatSession[] {
  const rank = { waiting: 0, running: 1, idle: 2 }
  return [...snapshot.list].sort((a, b) => rank[a.status] - rank[b.status])
}

function observeChats(snapshot: ChatsSnapshot): void {
  chatsRunning = snapshot.list.some(chat => chat.status === 'running')
  chatsWaiting = snapshot.list.some(chat => chat.status === 'waiting')
  chatsIdle = snapshot.list.some(chat => chat.status === 'idle')
}

function observeTaskMotion(now: number, animate: boolean): void {
  const tasks = [
    ...motionJobs.list.map(job => ({ id: `job:${job.id}`, status: job.status, finishedMs: job.finishedMs })),
    ...motionAgents.list.map(agent => ({ id: `agent:${agent.id}`,
      status: agentIsRunning(agent) ? 'running' : agent.status === 'completed' ? 'done'
        : agent.status === 'failed' ? 'failed' : agent.status,
      finishedMs: agent.finishedAt })),
  ]
  const ids = new Set(tasks.map(task => task.id))
  for (const job of tasks) {
    const previous = jobStatuses.get(job.id)
    const age = job.finishedMs === null ? Number.POSITIVE_INFINITY : now - job.finishedMs
    if (animate && (job.status === 'done' || job.status === 'failed') && previous !== job.status &&
      (previous === 'running' || (job.id.startsWith('job:') && previous === undefined && age >= 0 && age <= 5_000))) {
      finishedMotion.set(job.id, now)
    }
    if (job.status !== 'done' && job.status !== 'failed') finishedMotion.delete(job.id)
    jobStatuses.set(job.id, job.status)
  }
  for (const id of jobStatuses.keys()) if (!ids.has(id)) jobStatuses.delete(id)
  for (const id of finishedMotion.keys()) if (!ids.has(id)) finishedMotion.delete(id)
}

// One adaptive clock serves every row. Its single pending wait is a frame
// during running work, or the next chat-dot or completion change.
// Neither rendering nor polling resets an already scheduled earlier frame.
async function reconcileMotion($: EngineInterface, repaint = false,
  generation = animationGeneration): Promise<void> {
  try {
    const [placed, now] = await Promise.all([isPlaced($), $.clock.now()])
    if (generation !== animationGeneration) return
    if (!placed) {
      settleMotion()
      return
    }
    let next = Number.POSITIVE_INFINITY
    const due = (at: number): void => { next = Math.min(next, at) }
    const shown = tasksOf(motionJobs, motionAgents).slice(0, CAPSULES_SHOWN)
    const spinning = shown.some(taskRunning) || chatsRunning || isReadingAccounts
    if (spinning) due(now + FRAME_MS)
    if (chatsWaiting) due((Math.floor(now / WAITING_BLINK_MS) + 1) * WAITING_BLINK_MS)
    if (chatsIdle) due((Math.floor(now / IDLE_BLINK_MS) + 1) * IDLE_BLINK_MS)
    const visibleIds = new Set(shown.map(taskId))
    for (const [id, start] of finishedMotion) {
      if (now >= start + FINISH_MS) finishedMotion.delete(id)
      else if (!visibleIds.has(id)) continue
      else if (now < start + POP_MS / 2) due(start + POP_MS / 2)
      else if (now < start + POP_MS) due(start + POP_MS)
      else due(start + FINISH_MS)
    }
    repaintPending ||= repaint
    if (repaintPending) {
      if (now >= lastFrameAt + MIN_FRAME_MS) {
        $.ui.invalidate('ui.render')
        lastFrameAt = now
        repaintPending = false
      } else due(lastFrameAt + MIN_FRAME_MS)
    }
    if (!Number.isFinite(next)) {
      stopAnimation()
      return
    }
    // Exact blink/pop boundaries also respect the terminal's frame budget.
    next = Math.max(next, lastFrameAt + MIN_FRAME_MS)
    if (animation !== null && animationDue >= lastFrameAt + MIN_FRAME_MS &&
      (animationDue === next || (spinning && animationDue <= next))) return
    animation?.cancel()
    animationDue = next
    const scheduledGeneration = ++animationGeneration
    animation = $.clock.after(Math.max(1, next - now), () => {
      if (scheduledGeneration !== animationGeneration) return
      animation = null
      animationDue = Number.POSITIVE_INFINITY
      // reconcileMotion catches failures, including a disappearing surface.
      void reconcileMotion($, true, scheduledGeneration)
    })
  } catch {
    // A clock callback must never reject into the host.
    settleMotion()
  }
}

// Jobs every tick, accounts once a minute; nothing while no surface draws
// the pane. A forced refresh changes cadence, never the placement guard.
async function tick($: EngineInterface, force: boolean): Promise<void> {
  try {
    const placed = await isPlaced($)
    if (!placed) {
      settleMotion()
      return
    }
    const now = await $.clock.now()
    const isDue = force || now - accountsTriedAt >= ACCOUNTS_MS
    await Promise.all([
      refreshJobs($), refreshSession($),
      isDue ? refreshAccounts($) : undefined, isDue ? refreshCodex($) : undefined,
      refreshConversations($, force),
    ])
    await reconcileMotion($)
  } catch {
    // Each refresh records its own failure; a timer never sees one.
  }
}

function startPolling($: EngineInterface): void {
  poller ??= $.clock.every(JOBS_MS, () => {
    void tick($, false)
  })
}

async function dismissPane($: EngineInterface): Promise<void> {
  await update($, isDismissed, () => true)
  await $.ui.close({ id: PANE })
  settleMotion()
}

// MARK: - Formatting

type Seg = { text: string; color?: Color; dim?: boolean; weight?: TextProps['weight'] }
type Line = Seg[]
type Gauge = { kind: string; label: string; used: number; reset: string }

const plain = (text: string): Seg => ({ text })
const faint = (text: string): Seg => ({ text, dim: true })
const spinner = (now: number): string => SPINNER[Math.floor(now / FRAME_MS) % SPINNER.length]!
const chatMarker = (chat: ChatSession, now: number): Seg => chat.status === 'running'
  ? { text: spinner(now), color: 'suggestion' }
  : { text: '●', color: chat.status === 'waiting'
    ? Math.floor(now / WAITING_BLINK_MS) % 2 === 0 ? 'error' : 'subtle'
    : Math.floor(now / IDLE_BLINK_MS) % 2 === 0 ? 'inactive' : 'subtle' }

// Measure display cells, so wide names and emoji do not displace the right
// column. Controls become spaces before any row is measured or drawn.
const segments = new Intl.Segmenter('tr', { granularity: 'grapheme' })
const oneLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/—/g, ' · ')
const letters = (text: string): string[] =>
  Array.from(segments.segment(oneLine(text)), part => part.segment)
function cellsOf(letter: string): number {
  if (/^[\p{Mark}\p{Format}]+$/u.test(letter)) return 0
  const point = letter.codePointAt(0) ?? 0
  if (/\p{Emoji_Presentation}|\uFE0F/u.test(letter)) return 2
  return point >= 0x1100 && (
    point <= 0x115f || point === 0x2329 || point === 0x232a ||
    (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f) ||
    (point >= 0xac00 && point <= 0xd7a3) || (point >= 0xf900 && point <= 0xfaff) ||
    (point >= 0xfe10 && point <= 0xfe19) || (point >= 0xfe30 && point <= 0xfe6f) ||
    (point >= 0xff00 && point <= 0xff60) || (point >= 0xffe0 && point <= 0xffe6) ||
    (point >= 0x20000 && point <= 0x3fffd)
  ) ? 2 : 1
}
const textCells = (text: string): number => letters(text).reduce((sum, letter) => sum + cellsOf(letter), 0)
const lineCells = (line: Line): number => line.reduce((sum, seg) => sum + textCells(seg.text), 0)
function prefix(text: string, room: number): string {
  let result = ''
  for (const letter of letters(text)) {
    const cells = cellsOf(letter)
    if (cells > room) break
    result += letter
    room -= cells
  }
  return result
}

// Clip before creating the Text tree, retaining each run's style and a
// visible ellipsis. Text's truncate-end is an additional surface safeguard.
function fitLine(line: Line, width: number): Line {
  if (width <= 0) return []
  const clean = line.map(seg => ({ ...seg, text: oneLine(seg.text) }))
  if (lineCells(clean) <= width) return clean
  const result: Line = []
  let room = width - 1
  for (const seg of clean) {
    const size = textCells(seg.text)
    if (size <= room) {
      result.push(seg)
      room -= size
    } else {
      result.push({ ...seg, text: `${prefix(seg.text, room)}…` })
      break
    }
  }
  return result
}

// Reserve the right column first, then shorten the left when needed.
function align(left: Line, right: Line, width: number): Line {
  const rightSize = lineCells(right)
  if (rightSize >= width) return fitLine(right, width)
  const fitted = fitLine(left, width - rightSize - 1)
  return [...fitted, plain(' '.repeat(width - lineCells(fitted) - rightSize)), ...right]
}

function untilReset(resetsAtMs: number | null, now: number): string {
  if (resetsAtMs === null || resetsAtMs <= now) return ''
  const minutes = Math.floor((resetsAtMs - now) / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (minutes < 1) return '<1dk'
  if (days > 0) return `${days}g ${hours}sa`
  return hours > 0 ? `${hours}sa ${minutes % 60}dk` : `${minutes}dk`
}

function bar(used: number, cells: number, color: Color): Line {
  const filled = Math.round(clamp(used, 0, 100) * cells / 100)
  return [
    { text: '━'.repeat(filled), color },
    { text: '━'.repeat(cells - filled), color: 'subtle' },
  ]
}

const severity = (used: number): Color =>
  used >= 90 ? 'error' : used >= 75 ? 'warning' : 'success'

function shortError(err: string): string {
  if (/401|token expired/i.test(err)) return 'yeniden giriş gerekli'
  if (/429/.test(err)) return 'şu an okunamıyor'
  if (/not logged in/i.test(err)) return 'giriş yapılmamış'
  if (/time[ -]?out|timed out/i.test(err)) return 'zaman aşımı'
  return fitLine([plain(err)], 30).map(seg => seg.text).join('')
}

function gaugesOf(account: Account, now: number): Gauge[] {
  return ['session', 'weekly_all', 'weekly_scoped'].flatMap(kind =>
    account.limits.filter(limit => limit.kind === kind).map(limit => ({
      kind,
      label: kind === 'session' ? '5 saat' : kind === 'weekly_all' ? 'hafta' : limit.model || 'Fable',
      used: limit.used,
      reset: untilReset(limit.resetsAtMs, now),
    })),
  )
}

function miniGauge(gauge: Gauge | undefined, columnWidth: number): Line {
  if (gauge === undefined) return [faint('–'.padStart(columnWidth))]
  const barCells = Math.max(0, columnWidth - 5)
  const tone = severity(gauge.used)
  return fitLine([...bar(gauge.used, barCells, tone),
    { text: ` ${`${Math.round(clamp(gauge.used, 0, 100))}%`.padStart(4)}`, color: tone,
      ...(gauge.used >= 90 ? { weight: 'bold' as const } : {}) }], columnWidth)
}

function accountLines(snapshot: AccountsSnapshot, limits: CodexSnapshot, now: number, room: number) {
  const columnWidth = Math.max(1, Math.floor((room - 2) / 3))
  const header: Line = [
    ...['5 saat', 'hafta', 'Fable'].flatMap((label, index): Line => [
      ...(index === 0 ? [] : [plain(' ')]),
      faint(' '.repeat(Math.max(0, columnWidth - Math.min(columnWidth, textCells(label))))),
      ...fitLine([faint(label)], columnWidth),
    ])]
  const listed = [...snapshot.list.filter(account => account.name !== 'codex'), { name: 'codex', email: '', dir: '',
    limits: limits.limits, err: null }]
  const rows = listed.map(account => {
    const current = account.name === snapshot.current
    const marker = account.name === 'codex' ? faint('◎ ')
      : current ? { text: '● ', color: 'claude' as const } : faint('○ ')
    const first: Line = [marker, { text: account.name, ...(current ? { color: 'text', weight: 'bold' } as const : {}) }]
    const gauges = gaugesOf(account, now)
    const second: Line = account.err !== null ? [{ text: shortError(account.err), color: 'warning' }]
      : ['session', 'weekly_all', 'weekly_scoped'].flatMap((kind, index): Line => [
        ...(index === 0 ? [] : [plain(' ')]),
        ...miniGauge(gauges.find(gauge => gauge.kind === kind), columnWidth),
      ])
    const notes: Line[] = account.err !== null ? [] : gauges.filter(gauge => gauge.used >= 90)
      .sort((a, b) => b.used - a.used).slice(0, 1).map(gauge => {
        let reset = gauge.reset
        if (textCells(`${gauge.label} ${reset} sonra açılır`) > room) {
          reset = reset.replace(/(\d+)g (\d+)sa/, '$1g$2sa').replace(/(\d+)sa \d+dk/, '$1sa')
        }
        return [{ text: gauge.label, color: 'error', dim: true },
          faint(` ${reset === '' ? 'açılış -' : `${reset} sonra açılır`}`)]
      })
    return { key: account.name, first, second, notes }
  })
  return { header, rows }
}

function glyphOf(job: { id: string; status: string }, now: number): Seg {
  const status = job.status
  if (status === 'running') return { text: spinner(now), color: 'suggestion' }
  if (status === 'stale') return { text: '?', color: 'warning' }
  const start = finishedMotion.get(job.id)
  if (start !== undefined && now - start < POP_MS) {
    return { text: now - start < POP_MS / 2 ? '·' : '•', color: status === 'failed' ? 'error' : 'success' }
  }
  if (status === 'done' || status === 'idle') return { text: '✓', color: 'success' }
  return { text: '✗', color: 'error' }
}

type Task = { kind: 'job'; job: Job; at: number } | { kind: 'agent'; agent: PaneAgent; at: number }
const taskId = (task: Task): string => task.kind === 'job' ? `job:${task.job.id}` : `agent:${task.agent.id}`
const taskRunning = (task: Task): boolean => task.kind === 'job'
  ? task.job.status === 'running' : agentIsRunning(task.agent)

function tasksOf(listed: JobsSnapshot, roster: AgentsSnapshot): Task[] {
  const all: Task[] = [
    ...listed.list.map(job => ({ kind: 'job' as const, job, at: job.finishedMs ?? job.startedMs })),
    ...roster.list.map(agent => ({ kind: 'agent' as const, agent, at: agent.finishedAt ?? agent.observedAt })),
  ]
  const recent = (a: Task, b: Task): number => b.at - a.at
  return [...all.filter(taskRunning).sort(recent),
    ...all.filter(task => !taskRunning(task)).sort(recent)]
}

function duration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  if (seconds < 60) return `${seconds} sn`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes} dk` : `${Math.floor(minutes / 60)} sa ${minutes % 60} dk`
}

function taskLines(task: Task, now: number, width: number): [Line, Line] {
  const isJob = task.kind === 'job'
  const id = taskId(task)
  const status = isJob ? task.job.status : agentIsRunning(task.agent) ? 'running'
    : task.agent.status === 'completed' ? 'done'
      : task.agent.status === 'failed' || task.agent.status === 'killed' ? 'failed' : task.agent.status
  const label = isJob ? task.job.label || 'adsız iş' : task.agent.description || 'adsız ajan'
  const start = finishedMotion.get(id)
  const title: Seg = { text: label, ...(start !== undefined && now - start < FINISH_MS
    ? { color: status === 'failed' ? 'error' : 'success' } : { color: 'text' }) }
  const who = isJob ? task.job.account || 'ajan' : 'ajan'
  const elapsed = isJob
    ? task.job.durationMs ?? ((task.job.finishedMs ?? now) - task.job.startedMs)
    : (task.agent.finishedAt ?? now) - task.agent.observedAt
  return [align([glyphOf({ id, status }, now), plain(' '), title], [faint('›')], width),
    fitLine([faint(`${who} · ${status === 'stale' ? 'durdu' : duration(elapsed)}`)], width)]
}

const compactNumber = (value: number): string => value >= 1_000_000
  ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value))

const styleOf = (seg: Seg): TextProps => ({
  ...(seg.color === undefined ? {} : { color: seg.color }),
  ...(seg.dim === true ? { dimColor: true } : {}),
  ...(seg.weight === undefined ? {} : { weight: seg.weight }),
})

// MARK: - Hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'shiftover-panel',
        description: 'Shiftover hesap ve iş panelini aç/kapat',
      })
    } catch {
      // The pane works without its command.
    }
    if (e.isInteractive) {
      startPolling($)
      const isClosedByHand = await read($, isDismissed).catch(() => false)
      if (!isClosedByHand) {
        await $.ui.open({ id: PANE, title: TITLE, columns: DOCK_COLUMNS }).catch(() => undefined)
      }
      void tick($, true)
    }

    return next(e)
  })

  on('command.run', { command: 'shiftover-panel' }, async $ => {
    try {
      const pane = (await $.ui.panes()).find(one => one.id === PANE)
      if (pane !== undefined && pane.isPlaced && pane.isShown) {
        await dismissPane($)

        return { text: 'Shiftover paneli kapatıldı.' }
      }
      await update($, isDismissed, () => false)
      const opened = await $.ui.open({ id: PANE, title: TITLE, columns: DOCK_COLUMNS })
      startPolling($)
      void tick($, true)

      return { text: opened.isPlaced ? 'Shiftover paneli açıldı.' : `Shiftover paneli bekliyor: ${opened.reason}` }
    } catch (err) {
      return { text: `Shiftover paneli: ${describe(err)}` }
    }
  })

  on('turn.step', async function* ($, e, next) {
    const generation = sessionGeneration
    const result = yield* next(e)
    // The result and stop chunk contain the same usage. Count the result
    // once; turn.complete's aggregate must never be added a second time.
    if (generation === sessionGeneration) await recordResponse($, result, e.agentId).catch(() => undefined)
    return result
  })

  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    if (e.reason === 'clear') {
      sessionGeneration += 1
      await Promise.all([
        update($, totals, () => NO_TOTALS), update($, session, () => NO_SESSION),
        update($, agents, () => NO_AGENTS),
      ]).catch(() => undefined)
      observeAgents(NO_AGENTS, await $.clock.now(), false)
      await reconcileMotion($)
    }
    return ended
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId === undefined) {
      await update($, totals, held => held.turnIds.includes(e.turnId) ? held : {
        ...held, activeMs: held.activeMs + Math.max(0, e.durationMs), turns: held.turns + 1,
        turnIds: [...held.turnIds, e.turnId],
      }).catch(() => undefined)
    }
    await refreshSession($)
    return completed
  })

  // The person's own close holds across a reload of this module.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    if (!(await isPlaced($))) settleMotion()
    if (e.origin.kind === 'person') {
      await update($, isDismissed, () => true).catch(() => undefined)
    }

    return closed
  })

  on('session.detach', async ($, e, next) => {
    const detached = await next(e)
    await reconcileMotion($)
    return detached
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(1, Math.floor(e.props.bodyColumns))
    const bordered = width >= 4
    const padding = width >= 6 ? 1 : 0
    const innerWidth = Math.max(1, width - (bordered ? 2 : 0) - 2 * padding)
    const isPlain = (seg: Seg): boolean => seg.color === undefined && seg.dim !== true && seg.weight === undefined
    const draw = (line: Line, room = innerWidth) => (
      <Text wrap="truncate-end" mono>
        {fitLine(line.length === 0 ? [plain(' ')] : line, room)
          .filter(seg => seg.text !== '')
          .map(seg => (isPlain(seg) ? seg.text : <Text {...styleOf(seg)}>{seg.text}</Text>))}
      </Text>
    )
    // Box has no title prop. A final absolute sibling paints over its top
    // border, including the surrounding spaces, without adding a content row.
    const card = (title: string, children: RenderChildren, detail: Line = []) => {
      // The refresh spinner owns a fixed slot, so its frames never resize
      // the title overlay or erase the remaining top border.
      const titleWidth = Math.max(1, Math.min(width - 4,
        textCells(` ${title} `) + (title === 'Hesaplar' ? 2 : 0)))
      return <Box width={width} flexShrink={0} flexDirection="column" position="relative">
          <Box width={width} flexShrink={0} flexDirection="column" overflow="hidden"
            paddingX={padding} borderStyle={bordered ? 'round' : undefined} borderColor="inactive" borderDimColor>
            {children}
          </Box>
          <Box position="absolute" top={0} left={bordered ? 2 : 0} width={titleWidth}>
            {draw([{ text: ` ${title} `, color: 'text', weight: 'bold' }, ...detail], titleWidth)}
          </Box>
        </Box>
    }
    const capsuleWidth = innerWidth
    const capsuleRoom = Math.max(1, capsuleWidth - 4)
    const capsule = (key: string, first: Line, second: Line, press?: () => void,
      notes: Line[] = [], capsulePadding = 1) => (
      <Box key={`capsule:${key}`} width={capsuleWidth} flexShrink={0} flexDirection="column"
        borderStyle="round" borderColor="subtle" paddingX={capsulePadding}>
        {press === undefined ? draw(first, capsuleWidth - 2 - 2 * capsulePadding)
          : <Button key={key} plain onPress={press}>{draw(first, capsuleRoom)}</Button>}
        {draw(second, capsuleWidth - 2 - 2 * capsulePadding)}
        {notes.map(note => draw(note, capsuleWidth - 2 - 2 * capsulePadding))}
      </Box>
    )
    try {
      const [held, listed, measured, counted, roster, limits, conversations, now] = await Promise.all([
        read($, accounts), read($, jobs), read($, session), read($, totals), read($, agents),
        read($, codex), read($, chats), $.clock.now(),
      ])
      // Cached tasks after a hot reload are a steady baseline. Fresh reads
      // prepare their completion pop before publishing it above.
      // Seed once: an older in-flight render must not overwrite a fresh
      // transition prepared just before its state update resolves.
      if (!jobsObserved) observeJobs(listed, now, false)
      if (!agentsObserved) observeAgents(roster, now, false)
      observeChats(conversations)
      await reconcileMotion($)
      const tasks = tasksOf(listed, roster)
      const usage = measured.usage
      const context = usage?.context
      const exact = counted.responses > 0 && counted.responses === counted.usageResponses
      const input = counted.input + counted.cacheRead + counted.cacheWrite
      const hit = exact && input > 0 ? `%${Math.round(counted.cacheRead / input * 100)}` : '-'
      const cost = usage?.cost?.usd
      const value = exact ? compactNumber(input + counted.output) : '-'
      const percent = context?.percent
      const memory = percent === undefined ? 'hafıza -' : `hafıza %${Math.round(percent)}`
      const memoryColumn = Math.min(innerWidth, textCells('hafıza %100'))
      const memoryCells = Math.max(0, innerWidth - memoryColumn - 1)
      const stats = [value, cost === undefined ? '-' : `$${cost.toFixed(2)}`, hit]
      const labels = ['sohbet boyu', 'API değeri', 'önbellek']
      // Pick one column count for the section from the actual labels and
      // values, then share the remaining room without shortening either.
      const statNeeds = stats.map((stat, index) => Math.max(textCells(stat), textCells(labels[index]!)) + 4)
      const statColumns = statNeeds.reduce((sum, need) => sum + need, 2) <= innerWidth ? 3
        : statNeeds[0]! + statNeeds[1]! + 1 <= innerWidth ? 2 : 1
      const statRows = []
      for (let start = 0; start < stats.length; start += statColumns) {
        const indices = Array.from({ length: Math.min(statColumns, stats.length - start) }, (_, index) => start + index)
        const spare = Math.max(0, innerWidth - indices.reduce((sum, index) => sum + statNeeds[index]!, 0) - indices.length + 1)
        statRows.push(<Box width={innerWidth} flexDirection="row" flexWrap="nowrap" gap={1}>
          {indices.map((index, position) => {
            const statWidth = Math.min(innerWidth, statNeeds[index]! + Math.floor(spare / indices.length)
              + (position < spare % indices.length ? 1 : 0))
            const statPadding = statWidth >= statNeeds[index]! ? 1 : 0
            const statRoom = Math.max(1, statWidth - 2 - 2 * statPadding)
            return <Box key={`stat:${index}`} width={statWidth} flexShrink={0}
              flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={statPadding}>
              {draw([{ text: stats[index]!, color: 'text', weight: 'bold' }], statRoom)}
              {draw([faint(labels[index]!)], statRoom)}
            </Box>
          })}
        </Box>)
      }
      // At the narrow dock, the note gets all 26 cells inside the border.
      const accountPadding = capsuleRoom >= 26 ? 1 : 0
      const accountRoom = Math.max(1, capsuleWidth - 2 - 2 * accountPadding)
      const accountRows = accountLines(held, limits, now, accountRoom)
      const conversationList = chatsOf(conversations)
      // Pane.scroll is an engine-owned window over this entire tree.
      const chatRows = conversationList.map(chat => {
        const glyph = chatMarker(chat, now)
        const title: Line = [glyph, plain(' '), { text: chat.title, color: 'text',
          ...(chat.status === 'waiting' ? { weight: 'bold' as const } : {}) }]
        const line = chat.isCurrent ? fitLine(title, capsuleRoom) : align(title, [faint('›')], capsuleRoom)
        const state = chat.isCurrent ? 'bu sekme' : chat.status === 'waiting' ? 'cevap bekliyor'
          : chat.status === 'running' ? 'çalışıyor' : 'boşta'
        return capsule(`chat:${chat.id}`, line, [faint(`${chat.account || held.current || '–'} · ${state}`)],
          chat.isCurrent ? undefined : () => focusChat($, chat))
      })
      const jobRows = tasks.slice(0, CAPSULES_SHOWN).map(task => {
        const [title, metadata] = taskLines(task, now, capsuleRoom)
        return capsule(taskId(task), title, metadata, async () => {
          if (!(await isPlaced($))) return
          if (task.kind === 'agent') await $.ui.view({ agentId: task.agent.id })
          else await openDelegate($, task.job.id, (await read($, chats)).list)
        })
      })
      return (
        <Box width={width} flexDirection="column" overflow="hidden">
          {card('Oturum', <Box flexDirection="column">
            {statRows}
            {draw([...bar(percent ?? 0, memoryCells, severity(percent ?? 0)), plain(' '),
              faint(' '.repeat(Math.max(0, memoryColumn - textCells(memory)))), faint(memory)])}
          </Box>)}
          {card('Hesaplar', <Box flexDirection="column">
            {draw([plain(' '.repeat(1 + accountPadding)), ...accountRows.header])}
            {held.list.length === 0 && held.error !== null ? draw([faint('hesaplar okunamadı')]) : null}
            {accountRows.rows.map(row => capsule(`account:${row.key}`, row.first, row.second, undefined, row.notes, accountPadding))}
          </Box>, isReadingAccounts ? [{ text: spinner(now), color: 'suggestion' }] : [])}
          {card('Sohbetler', <Box flexDirection="column">
            {chatRows.length > 0 ? chatRows : draw([faint(conversations.error === null ? 'sohbet yok' : 'sohbetler okunamadı')])}
          </Box>)}
          {card('İşler', <Box flexDirection="column">
            {jobRows.length > 0 ? jobRows : draw([faint('iş yok')])}
            {tasks.length > CAPSULES_SHOWN ? draw([faint(`+${tasks.length - CAPSULES_SHOWN} iş daha`)]) : null}
          </Box>)}
        </Box>
      )
    } catch (err) {
      return draw([{ text: `Shiftover paneli çizilemedi: ${describe(err)}`, color: 'error' }], width)
    }
  })
}
