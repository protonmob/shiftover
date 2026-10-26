import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, FsEntry, Register, RenderChildren, TextHoverProps, TextProps,
  Timer } from 'claude-code'

import type { Account, AccountsSnapshot, AgentsSnapshot, ChatSession, CodexSnapshot, Job, JobsSnapshot,
  Limit, PaneAgent } from '../types'

import { readCodexLimits } from './codex'
import { refreshChats, refreshStarters, focusChat, followJob, openDelegate, parentChat } from './sessions'
import type { ChatsSnapshot } from './sessions'
import { claudeStep, codexStep, projectFolders } from './steps'

// MARK: - Constants

const PANE = 'shiftover-panel'
const TITLE = 'Shiftover'
const JOBS_MS = 10_000
const ACCOUNTS_MS = 60_000
// A read that failed, or left the server's next read in the past, is tried
// again after 30 s, then twice as long each time up to five minutes, plus up
// to a fifth more at random, so panes in other tabs fall out of step.
const ACCOUNTS_RETRY_MS = 30_000
const ACCOUNTS_RETRY_MAX_MS = 5 * 60_000
const ACCOUNTS_RETRY_JITTER = 0.2
// Four spinner frames a second keep a pane in every tab cheap to redraw.
const FRAME_MS = 250
const MIN_FRAME_MS = 67
const WAITING_BLINK_MS = 600
const WAITING_BORDER_MS = 10_000
const WAITING_BORDER_FLASH_MS = 1_000
const CURRENT_COLOR: Color = 'claude'
// The theme's dim color: a muted capsule inverts to a soft grey block.
const MUTED: Color = 'inactive'
const POP_MS = 250
const FINISH_MS = 2_000
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const CAPSULES_SHOWN = 3
// The jobs kept: every running one, then those finished within a day.
const JOBS_KEPT = 10
const JOBS_KEPT_MS = 24 * 60 * 60_000
const UNVERIFIED_RUNNING_MS = 2 * 60 * 60 * 1000
const RESET_GROUP_MS = 60 * 60_000
const TAIL_BYTES = 256 * 1024
// Files one `tail` reads at most: their ends stay under its 4 MiB of output.
const TAILS_PER_RUN = 12
// The accounts' own colors, by name, for a delegate's row; text for others.
const ACCOUNT_COLORS: Record<string, Color> = { codex: 'success', aras: 'suggestion', yusa: 'remember', kadir: CURRENT_COLOR }
// Requested dock width; drawing uses the actual bodyColumns grant.
const DOCK_COLUMNS = 76

// MARK: - State

const NO_ACCOUNTS: AccountsSnapshot = { list: [], current: null, at: 0, error: null }
const NO_JOBS: JobsSnapshot = { list: [], at: 0, error: null }
const NO_CODEX: CodexSnapshot = { limits: [], at: 0, error: null }
const NO_CHATS: ChatsSnapshot = { list: [], at: 0, error: null }
const NO_AGENTS: AgentsSnapshot = { list: [], at: 0, error: null }

// Bump a tag when its snapshot's fields change: what an earlier version
// stored outlives a reload, and the tag is how the new code declines it.
const accounts = atom({ plugin: 'shiftover-panel', key: 'accounts' } as const, NO_ACCOUNTS, {
  shape: 'accounts-3',
})
const jobs = atom({ plugin: 'shiftover-panel', key: 'jobs' } as const, NO_JOBS, { shape: 'jobs-2' })
const isDismissed = atom({ plugin: 'shiftover-panel', key: 'isDismissed' } as const, false)
const isAccountsOpen = atom({ plugin: 'shiftover-panel', key: 'isAccountsOpen' } as const, true)
const codex = atom({ plugin: 'shiftover-panel', key: 'codex' } as const, NO_CODEX, { shape: 'codex-1' })
const chats = atom({ plugin: 'shiftover-panel', key: 'chats' } as const, NO_CHATS, { shape: 'chats-2' })
const agents = atom({ plugin: 'shiftover-panel', key: 'agents' } as const, NO_AGENTS, { shape: 'agents-1' })

// What the module keeps between timer ticks; a reload starts it over.
type Files = { home: string; cacheDir: string; jobsDir: string; configFile: string; bin: string }
// The backend, the job's folders and where it records its steps stay here,
// out of the stored Job shape: an empty path is one the file does not name.
type JobPlace = { backend: string; cwd: string; dir: string; transcriptPath: string; logPath: string }
type CachedJob = JobPlace & { mtimeMs: number; size: number; job: Job | null }
type CachedOut = { mtimeMs: number; size: number; verdict: string | null }
type CachedStep = { path: string; mtimeMs: number; size: number; step: string }
type JobRead = JobPlace & { job: Job; out: FsEntry | undefined }
// A file as a listing or a stat last saw it.
type FileMark = { path: string; size: number; mtimeMs: number }

let files: Files | null = null
let poller: Timer | null = null
let animation: Timer | null = null
let animationDue = Number.POSITIVE_INFINITY
let animationGeneration = 0
let lastFrameAt = Number.NEGATIVE_INFINITY
let repaintPending = false
let focusedCapsule: string | undefined
let chatsRunning = false
let chatsWaiting = false
let motionJobs = NO_JOBS
let motionAgents = NO_AGENTS
let jobsObserved = false
let agentsObserved = false
// Whether a refresh has read the open chats since this module loaded.
let chatsObserved = false
const jobStatuses = new Map<string, string>()
const finishedMotion = new Map<string, number>()
let isReadingJobs = false
let isReadingAccounts = false
let isReadingAgents = false
let isReadingChats = false
let isReadingCodex = false
let agentsGeneration = 0
let accountsTriedAt = Number.NEGATIVE_INFINITY
let accountsRetryAt = Number.NEGATIVE_INFINITY
let codexTriedAt = Number.NEGATIVE_INFINITY
// Stale or failed account reads in a row: how far the next retry backs off.
let accountsFailures = 0
// A tick skipped while no surface showed the pane: its next drawing catches up.
let missedTick = false
const jobFiles = new Map<string, CachedJob>()
const jobOuts = new Map<string, CachedOut>()
const jobSteps = new Map<string, CachedStep>()

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

// The email shiftover reports stays out: any plugin may read $.state. A
// display name, when set, is what the pane draws for the account.
function parseAccounts(stdout: string): Account[] {
  const data: unknown = JSON.parse(stdout)
  if (!Array.isArray(data)) throw new Error('shiftover status: liste bekleniyordu')
  return data
    .filter(isRecord)
    .map(row => ({
      name: asText(row.name),
      display: asText(row.display).trim() || null,
      dir: asText(row.dir),
      nextRefreshAtMs: toEpochMs(row.next_refresh_at),
      fetchedAtMs: toEpochMs(row.fetched_at),
      limits: Array.isArray(row.limits) ? row.limits.filter(isRecord).flatMap(parseLimit) : [],
      err: asText(row.err) === '' ? null : asText(row.err),
    }))
    .filter(account => account.name !== '')
}

// The server's earliest next read. An account it could not read may keep a
// target that never moves on: that one schedules nothing.
function nextAccountRefresh(list: Account[]): number | null {
  const times = list.flatMap(account => account.err === null && typeof account.nextRefreshAtMs === 'number' &&
    Number.isFinite(account.nextRefreshAtMs) ? [account.nextRefreshAtMs] : [])
  return times.length === 0 ? null : Math.min(...times)
}

function retryDelay(failures: number): number {
  const delay = Math.min(ACCOUNTS_RETRY_MAX_MS, ACCOUNTS_RETRY_MS * 2 ** Math.max(0, failures - 1))
  return Math.round(delay * (1 + ACCOUNTS_RETRY_JITTER * Math.random()))
}

function parseJob(raw: string, fileName: string): (JobPlace & { job: Job }) | null {
  const row: unknown = JSON.parse(raw)
  if (!isRecord(row)) return null
  const finished = asNumber(row.finished)
  const account = asText(row.account)
  return {
    cwd: asText(row.cwd),
    // The account's config folder, when the file names it.
    dir: asText(row.dir),
    // A claude job's live session and a codex job's JSON-lines log.
    transcriptPath: asText(row.transcript_path),
    logPath: asText(row.log_path),
    job: {
      id: asText(row.id) || fileName.replace(/\.json$/, ''),
      account,
      model: asText(row.model),
      // Keep the stored job shape: the directory is only a display fallback.
      label: asText(row.label).trim() === ''
        ? asText(row.cwd).replace(/\/+$/, '').split('/').pop() ?? ''
        : asText(row.label),
      status: asText(row.status) || 'unknown',
      pid: asNumber(row.pid) ?? 0,
      parentSessionId: asText(row.parent_session_id) || undefined,
      parentPid: asNumber(row.parent_pid) ?? undefined,
      startedMs: (asNumber(row.started) ?? 0) * 1000,
      finishedMs: finished !== null && finished > 0 ? finished * 1000 : null,
      durationMs: asNumber(row.duration_ms),
      costUsd: asNumber(row.cost_usd),
    },
    // Older job files name no backend: only the codex account runs Codex.
    backend: asText(row.backend) || (account === 'codex' ? 'codex' : 'claude'),
  }
}

// claude -p ends its .out with one result line; codex exec --json ends a turn
// with turn.completed or turn.failed. Null while neither shows.
function outcomeOf(tail: string, backend: string, truncated: boolean): string | null {
  const lines = tail.split('\n').slice(truncated ? 1 : 0)
  if (backend === 'codex') {
    const text = lines.join('\n')
    const done = text.lastIndexOf('"type":"turn.completed"')
    const failed = text.lastIndexOf('"type":"turn.failed"')
    return done < 0 && failed < 0 ? null : done > failed ? 'done' : 'failed'
  }
  try {
    const row: unknown = JSON.parse(lines.filter(line => line.trim() !== '').pop() ?? '')
    if (isRecord(row) && row.type === 'result') return row.is_error === true ? 'failed' : 'done'
  } catch {
    // A last line still being written is a job still running.
  }
  return null
}

// MARK: - Reading

async function locate($: EngineInterface): Promise<Files> {
  if (files !== null) return files
  if (!(await isVisible($))) throw new Error('panel yerleştirilmedi')
  const home = (await $.env.get('HOME')) ?? ''
  if (home === '') throw new Error('HOME tanımsız')
  if (!(await isVisible($))) throw new Error('panel yerleştirilmedi')
  const cache = (await $.env.get('XDG_CACHE_HOME')) || `${home}/.cache`
  if (!(await isVisible($))) throw new Error('panel yerleştirilmedi')
  const config = (await $.env.get('XDG_CONFIG_HOME')) || `${home}/.config`
  const local = `${home}/.local/bin/shiftover`
  if (!(await isVisible($))) throw new Error('panel yerleştirilmedi')
  const hasLocal = await $.fs.exists(local).catch(() => false)
  files = {
    home,
    cacheDir: `${cache}/shiftover`,
    jobsDir: `${cache}/shiftover/jobs`,
    configFile: `${config}/shiftover/config.toml`,
    bin: hasLocal ? local : 'shiftover',
  }
  return files
}

// A write draws every site that reads the value again: one that would change
// nothing but its read time is skipped, so `at` is the last read that did.
const isSame = <T extends { at: number }>(held: T, next: T): boolean =>
  JSON.stringify({ ...held, at: 0 }) === JSON.stringify({ ...next, at: 0 })

const normalizeDir = (dir: string, home: string): string =>
  dir.replace(/^~(?=\/|$)/, home).replace(/\/+$/, '')

async function readMain($: EngineInterface, configFile: string): Promise<string | null> {
  try {
    if (!(await isVisible($))) return null
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
  if (!(await isVisible($))) return null
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${at.home}/.claude`
  const byDir = list.find(account => normalizeDir(account.dir, at.home) === normalizeDir(dir, at.home))
  if (byDir) return byDir.name
  if (!(await isVisible($))) return null
  const named = await $.env.get('SHIFTOVER_ACCOUNT')
  if (named && list.some(account => account.name === named)) return named
  const main = await readMain($, at.configFile)
  return main !== null && list.some(account => account.name === main) ? main : null
}

async function refreshAccounts($: EngineInterface): Promise<void> {
  if (isReadingAccounts) return
  if (!(await isVisible($)) || isReadingAccounts) return
  isReadingAccounts = true
  // Null while the read never ended: the pane hid on the way.
  let outcome: 'read' | 'failed' | null = null
  try {
    await reconcileMotion($, true)
    accountsTriedAt = await $.clock.now()
    const at = await locate($)
    if (!(await isVisible($))) return
    const ran = await $.process.run([at.bin, 'status', '--json'], { timeoutMs: 25_000 })
    if (ran.exitCode !== 0) {
      const why = firstLine(ran.stderr)
      throw new Error(`shiftover status ${ran.exitCode}${why === '' ? '' : `: ${why}`}`)
    }
    if (!(await isVisible($))) return
    const list = parseAccounts(ran.stdout)
    const current = await currentAccount($, list, at)
    if (!(await isVisible($))) return
    const now = await $.clock.now()
    const snapshot = { list, current, at: now, error: null }
    if (!isSame(await read($, accounts), snapshot)) await update($, accounts, () => snapshot)
    outcome = 'read'
  } catch (err) {
    if (!(await isVisible($))) return
    outcome = 'failed'
    const error = describe(err)
    if ((await read($, accounts).catch(() => NO_ACCOUNTS)).error !== error) {
      await update($, accounts, held => ({ ...held, error })).catch(() => undefined)
    }
  } finally {
    try {
      const now = await $.clock.now()
      const target = nextAccountRefresh((await read($, accounts)).list)
      if (outcome !== null) {
        const isStale = outcome === 'failed' || (target !== null && target <= now)
        accountsFailures = isStale ? accountsFailures + 1 : 0
        accountsRetryAt = isStale ? now + retryDelay(accountsFailures) : Number.NEGATIVE_INFINITY
      }
    } finally {
      isReadingAccounts = false
      await reconcileMotion($, true)
    }
  }
}

// Reads only the job files that changed since the last tick, each with the
// listing's entry for its .out.
async function readJobs($: EngineInterface, dir: string): Promise<JobRead[]> {
  if (!(await isVisible($))) return []
  if (!(await $.fs.exists(dir))) {
    jobFiles.clear()
    return []
  }
  if (!(await isVisible($))) return []
  const listing = (await $.fs.list(dir)).filter(f => f.kind === 'file')
  const entries = listing.filter(f => f.name.endsWith('.json'))
  const outs = new Map(listing.filter(f => f.name.endsWith('.out')).map(f => [f.name, f]))
  const names = new Set(entries.map(entry => entry.name))
  for (const name of [...jobFiles.keys()]) if (!names.has(name)) jobFiles.delete(name)
  const unread: JobPlace = { backend: 'claude', cwd: '', dir: '', transcriptPath: '', logPath: '' }
  for (const entry of entries) {
    const held = jobFiles.get(entry.name)
    if (held && held.mtimeMs === entry.mtimeMs && held.size === entry.size) continue
    try {
      if (!(await isVisible($))) return []
      const parsed = parseJob(await $.fs.read(`${dir}/${entry.name}`), entry.name)
      jobFiles.set(entry.name, { ...unread, ...parsed, mtimeMs: entry.mtimeMs, size: entry.size, job: parsed?.job ?? null })
    } catch {
      // Caught mid-write: keep what it held, read it again next tick.
      jobFiles.set(entry.name, { ...unread, ...held, mtimeMs: -1, size: -1, job: held?.job ?? null })
    }
  }
  return [...jobFiles.values()].flatMap(({ mtimeMs, size, job, ...place }) => (job
    ? [{ ...place, job, out: outs.get(`${job.id}.out`) }] : []))
}

// The ends of several files from one `tail`, a dozen at most per run. With
// more than one file it heads each with `==> path <==`, every later head after
// a newline of its own; a file it cannot read gets no head and no entry.
async function tailFiles($: EngineInterface, paths: string[]): Promise<Map<string, string>> {
  const tails = new Map<string, string>()
  for (let at = 0; at < paths.length; at += TAILS_PER_RUN) {
    const batch = paths.slice(at, at + TAILS_PER_RUN)
    try {
      if (!(await isVisible($))) return tails
      const ran = await $.process.run(['tail', '-c', String(TAIL_BYTES), '--', ...batch], { timeoutMs: 5_000 })
      // A cut output may have cut a file's end: read them all again next tick.
      if (ran.isStdoutTruncated) continue
      if (batch.length === 1) {
        if (ran.exitCode === 0) tails.set(batch[0]!, ran.stdout)
        continue
      }
      const heads: { path: string; start: number; end: number }[] = []
      for (const path of batch) {
        const head = `==> ${path} <==\n`
        const start = ran.stdout.indexOf(head, heads[heads.length - 1]?.end ?? 0)
        if (start >= 0) heads.push({ path, start, end: start + head.length })
      }
      heads.forEach((head, index) => {
        const next = heads[index + 1]
        tails.set(head.path, ran.stdout.slice(head.end, next === undefined ? undefined : Math.max(head.end, next.start - 1)))
      })
    } catch {
      // A refused or slow `tail` leaves these for the next tick.
    }
  }
  return tails
}

// Where a running job records its steps, as it stands now: a codex job's log,
// else its .out; a claude job's transcript, else the newest session in its
// account's folder for its cwd changed since it started that no open chat is
// on, once the open chats are known. Undefined while there is none.
async function stepSource($: EngineInterface, dir: string, read: JobRead, home: string,
  list: Account[], open: ReadonlySet<string> | null): Promise<FileMark | undefined> {
  const stat = (path: string): Promise<FileMark | undefined> => $.fs.stat(path)
    .then(found => ({ path, size: found.size, mtimeMs: found.mtimeMs })).catch(() => undefined)
  const { job, out } = read
  if (read.backend === 'codex') {
    const outPath = `${dir}/${job.id}.out`
    if (read.logPath !== '' && read.logPath !== outPath) return stat(read.logPath)
    return out === undefined ? undefined : { path: outPath, size: out.size, mtimeMs: out.mtimeMs }
  }
  if (read.transcriptPath !== '') return stat(read.transcriptPath)
  const config = normalizeDir(read.dir || list.find(account => account.name === job.account)?.dir || '', home)
  if (open === null || config === '' || read.cwd === '') return undefined
  for (const name of projectFolders(normalizeDir(read.cwd, home))) {
    const folder = `${config}/projects/${name}`
    const entries = await $.fs.list(folder).catch(() => null)
    if (entries === null) continue
    const newest = entries.filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl') &&
      entry.mtimeMs >= job.startedMs && !open.has(`${folder}/${entry.name}`))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
    return newest === undefined ? undefined : { path: `${folder}/${newest.name}`, size: newest.size, mtimeMs: newest.mtimeMs }
  }
  return undefined
}

// A running job's .out can say how it ended before its file does, and its
// step source what it does now; a codex job's source is often that same
// .out. Each end is read again only after its size or time changed, all of
// them in one `tail`.
async function readRunning($: EngineInterface, dir: string, running: JobRead[],
  sources: Map<string, FileMark>): Promise<{ outcomes: Map<string, string>; steps: Map<string, string> }> {
  const ids = new Set(running.map(({ job }) => job.id))
  for (const id of [...jobOuts.keys()]) if (!ids.has(id)) jobOuts.delete(id)
  for (const id of [...jobSteps.keys()]) if (!ids.has(id)) jobSteps.delete(id)
  const isFresh = (held: { size: number; mtimeMs: number } | undefined, mark: { size: number; mtimeMs: number }): boolean =>
    held !== undefined && held.size === mark.size && held.mtimeMs === mark.mtimeMs
  const due = new Set<string>()
  for (const { job, out } of running) {
    if (out !== undefined && !isFresh(jobOuts.get(job.id), out)) due.add(`${dir}/${job.id}.out`)
    const source = sources.get(job.id)
    const held = jobSteps.get(job.id)
    if (source !== undefined && !(held?.path === source.path && isFresh(held, source))) due.add(source.path)
  }
  const tails = await tailFiles($, [...due])
  const outcomes = new Map<string, string>()
  const steps = new Map<string, string>()
  for (const { job, backend, out } of running) {
    const outPath = `${dir}/${job.id}.out`
    let held = jobOuts.get(job.id)
    if (out !== undefined && due.has(outPath)) {
      const tail = tails.get(outPath)
      // Unread, it keeps what it said and is read again next tick.
      held = tail === undefined ? { mtimeMs: -1, size: -1, verdict: held?.verdict ?? null }
        : { mtimeMs: out.mtimeMs, size: out.size, verdict: outcomeOf(tail, backend, out.size > TAIL_BYTES) }
      jobOuts.set(job.id, held)
    }
    if (held?.verdict) outcomes.set(job.id, held.verdict)
    const source = sources.get(job.id)
    let step = jobSteps.get(job.id)
    if (source !== undefined && !(step?.path === source.path && isFresh(step, source))) {
      const tail = tails.get(source.path)
      const read = backend === 'codex' ? codexStep : claudeStep
      step = tail === undefined ? { path: source.path, mtimeMs: -1, size: -1, step: step?.step ?? 'çalışıyor' }
        : { path: source.path, mtimeMs: source.mtimeMs, size: source.size, step: read(tail, source.size > TAIL_BYTES) }
      jobSteps.set(job.id, step)
    }
    // Unknown until a source shows one.
    steps.set(job.id, source === undefined ? 'çalışıyor' : step?.step ?? 'çalışıyor')
  }
  return { outcomes, steps }
}

// A job's file says `running` until shiftover collects it; `ps` says whether
// its process is still there, a zombie not. Null when `ps` gave no answer.
async function livePids($: EngineInterface, pids: number[]): Promise<Set<number> | null> {
  if (pids.length === 0) return new Set()
  try {
    if (!(await isVisible($))) return null
    const ran = await $.process.run(['ps', '-ww', '-o', 'pid=,stat=,command=', '-p', pids.join(',')], {
      timeoutMs: 5_000,
    })
    if ((ran.exitCode !== 0 && ran.exitCode !== 1) ||
      (ran.exitCode === 1 && ran.stderr.trim() !== '')) return null
    const live = new Set<number>()
    for (const line of ran.stdout.split('\n')) {
      // macOS names a zombie's command `(codex)`; only its Z state tells.
      const found = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
      if (found && !(found[2] ?? '').startsWith('Z') && /claude|codex/i.test(found[3] ?? '')) live.add(Number(found[1]))
    }
    return live
  } catch {
    return null
  }
}

// The jobs directory keeps every job ever run: the state keeps the running
// ones, then those that ended within a day, newest first, ten in all unless
// more than ten run. A job with no time at all is older than any day.
function pickJobs(all: Job[], now: number): Job[] {
  const ended = (job: Job): number => job.finishedMs ?? job.startedMs
  const running = all.filter(job => job.status === 'running').sort((a, b) => b.startedMs - a.startedMs)
  const finished = all
    .filter(job => job.status !== 'running' && ended(job) > 0 && now - ended(job) <= JOBS_KEPT_MS)
    .sort((a, b) => ended(b) - ended(a))
  return [...running, ...finished].slice(0, Math.max(JOBS_KEPT, running.length))
}

async function refreshJobs($: EngineInterface): Promise<void> {
  if (isReadingJobs || !(await isVisible($))) return
  isReadingJobs = true
  try {
    const at = await locate($)
    const dir = at.jobsDir
    const all = await readJobs($, dir)
    if (!(await isVisible($))) return
    const running = all.filter(({ job }) => job.status === 'running')
    // A claude job's fallback session is never one an open chat is on: none
    // is looked for before the chats have been read once.
    const [held, open] = await Promise.all([read($, accounts), read($, chats)])
    const paths = chatsObserved ? new Set(open.list.map(chat => chat.transcriptPath)) : null
    const sources = new Map<string, FileMark>()
    for (const job of running) {
      if (!(await isVisible($))) return
      const source = await stepSource($, dir, job, at.home, held.list, paths)
      if (source !== undefined) sources.set(job.job.id, source)
    }
    const { outcomes, steps } = await readRunning($, dir, running, sources)
    const pids = running.filter(({ job }) => !outcomes.has(job.id) && job.pid > 0).map(({ job }) => job.pid)
    const live = await livePids($, pids)
    const now = await $.clock.now()
    const isStale = (job: Job): boolean => {
      if (job.status !== 'running') return false
      if (job.pid <= 0) return true
      if (live !== null) return !live.has(job.pid)
      const age = now - job.startedMs
      return !(job.startedMs > 0 && age >= 0 && age < UNVERIFIED_RUNNING_MS)
    }
    // An ended .out outranks the process check; its time stops the duration.
    // Only a job still running carries its step.
    const list = pickJobs(all.map(({ job, out }) => {
      const outcome = outcomes.get(job.id)
      if (outcome !== undefined) return { ...job, status: outcome, finishedMs: job.finishedMs ?? out?.mtimeMs ?? now }
      if (isStale(job)) return { ...job, status: 'stale' }
      return job.status === 'running' ? { ...job, step: steps.get(job.id) ?? 'çalışıyor' } : job
    }), now)
    const snapshot = { list, at: now, error: null }
    observeJobs(snapshot, now, await isVisible($))
    if (!isSame(await read($, jobs), snapshot)) await update($, jobs, () => snapshot)
  } catch (err) {
    const error = describe(err)
    if ((await read($, jobs).catch(() => NO_JOBS)).error !== error) {
      await update($, jobs, held => ({ ...held, error })).catch(() => undefined)
    }
  } finally {
    isReadingJobs = false
    await reconcileMotion($)
  }
}

const agentIsRunning = (agent: Pick<PaneAgent, 'status'>): boolean =>
  agent.status === 'running' || agent.status === 'pending' || agent.status === 'waiting'

// Even a forced tick may not read agents for an unplaced pane.
async function refreshAgents($: EngineInterface): Promise<void> {
  if (isReadingAgents || !(await isVisible($))) return
  isReadingAgents = true
  const generation = agentsGeneration
  try {
    const listed = await $.agent.list()
    if (generation !== agentsGeneration || !(await isVisible($))) return
    const now = await $.clock.now()
    const held = await read($, agents)
    const previous = new Map(held.list.map(agent => [agent.id, agent]))
    const list = listed.map(agent => {
      const prior = previous.get(agent.id)
      return {
        ...agent, observedAt: prior?.observedAt ?? now,
        finishedAt: agentIsRunning(agent) ? null : prior?.finishedAt ?? now,
      }
    })
    const snapshot = { list, at: now, error: null }
    observeAgents(snapshot, now, await isVisible($))
    if (!isSame(held, snapshot)) await update($, agents, () => snapshot)
  } catch {
    const error = 'Ajanlar okunamadı'
    if ((await read($, agents).catch(() => NO_AGENTS)).error !== error) {
      await update($, agents, held => ({ ...held, error })).catch(() => undefined)
    }
  } finally {
    isReadingAgents = false
    await reconcileMotion($)
  }
}

// No limits found keeps the last ones read: a new session names none until
// its first turn ends, and a window that has since reset draws as reset. A
// missing Codex history, never read, is an unreadable-limits row.
async function refreshCodex($: EngineInterface): Promise<void> {
  if (isReadingCodex || !(await isVisible($))) return
  isReadingCodex = true
  try {
    const limits = await readCodexLimits($, (await locate($)).home, await $.clock.now())
    if (limits === null || !(await isVisible($))) return
    const now = await $.clock.now()
    const snapshot = { limits, at: now, error: null }
    if (!isSame(await read($, codex), snapshot)) await update($, codex, () => snapshot)
  } catch {
    // An unreadable history keeps what was read before.
  } finally {
    isReadingCodex = false
    await reconcileMotion($)
  }
}

async function refreshConversations($: EngineInterface, force = false): Promise<void> {
  if (isReadingChats || !(await isVisible($))) return
  isReadingChats = true
  try {
    const at = await locate($)
    if (!(await isVisible($))) return
    const snapshot = await refreshChats($, { home: at.home, cacheDir: at.cacheDir, configFile: at.configFile,
      accounts: (await read($, accounts)).list, now: await $.clock.now(), force })
    if (snapshot !== null) {
      observeChats(snapshot)
      if (!isSame(await read($, chats), snapshot)) await update($, chats, () => snapshot)
      chatsObserved = true
    }
  } finally {
    isReadingChats = false
    await reconcileMotion($)
  }
}

// MARK: - Timers

// Work and motion only for a pane a surface places and shows: one waiting
// unplaced, or behind another pane's tab, reads and animates nothing.
async function isVisible($: EngineInterface): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced && pane.isShown)
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

function observeChats(snapshot: ChatsSnapshot): void {
  chatsRunning = snapshot.list.some(chat => chat.status === 'running')
  chatsWaiting = snapshot.list.some(chat => chat.status === 'waiting')
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
// during running work, or the next refresh, reset, blink or completion change.
// Neither rendering nor polling resets an already scheduled earlier frame.
async function reconcileMotion($: EngineInterface, repaint = false,
  generation = animationGeneration): Promise<void> {
  try {
    const [visible, now, held, limits] = await Promise.all([
      isVisible($), $.clock.now(), read($, accounts), read($, codex),
    ])
    if (generation !== animationGeneration) return
    if (!visible) {
      settleMotion()
      return
    }
    let next = Number.POSITIVE_INFINITY
    const due = (at: number): void => { next = Math.min(next, at) }
    const target = nextAccountRefresh(held.list)
    const refreshAt = target === null || isReadingAccounts ? Number.POSITIVE_INFINITY
      : Math.max(target, accountsRetryAt)
    if (Number.isFinite(refreshAt)) {
      if (refreshAt <= now) {
        void refreshAccounts($)
        return
      }
      // Wake at the server target itself, or once the stale-read back-off ends.
      due(refreshAt)
    }
    const resets = [...held.list.flatMap(account => account.limits), ...limits.limits]
      .flatMap(limit => limit.resetsAtMs !== null && limit.resetsAtMs > now ? [limit.resetsAtMs] : [])
    if (resets.length > 0) {
      // Countdowns change on the minute; a window draws as reset at its time.
      due((Math.floor(now / ACCOUNTS_MS) + 1) * ACCOUNTS_MS)
      due(Math.min(...resets))
    }
    const shown = tasksOf(motionJobs, motionAgents).slice(0, CAPSULES_SHOWN)
    // A running job spins in İşler or on its starter chat's row.
    const spinning = shown.some(taskRunning) || motionJobs.list.some(job => job.status === 'running') ||
      chatsRunning || isReadingAccounts
    // Each frame lands where every spinner's glyph changes.
    if (spinning) due((Math.floor(now / FRAME_MS) + 1) * FRAME_MS)
    if (chatsWaiting) {
      due((Math.floor(now / WAITING_BLINK_MS) + 1) * WAITING_BLINK_MS)
      const phase = now % WAITING_BORDER_MS
      due(now - phase + (phase < WAITING_BORDER_FLASH_MS ? WAITING_BORDER_FLASH_MS : WAITING_BORDER_MS))
    }
    const visibleIds = new Set(shown.map(taskId))
    for (const [id, start] of finishedMotion) {
      if (now >= start + FINISH_MS) finishedMotion.delete(id)
      else if (!visibleIds.has(id)) continue
      else if (now < start + POP_MS / 2) due(start + POP_MS / 2)
      else if (now < start + POP_MS) due(start + POP_MS)
      else due(start + FINISH_MS)
    }
    // A frame already due paints now, whichever wake reaches it first: a
    // poll landing on it takes that wait over instead of dropping the frame.
    if (animationDue <= now) {
      animation?.cancel()
      animation = null
      animationDue = Number.POSITIVE_INFINITY
      animationGeneration += 1
      repaint = true
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
    // Refreshing may wake sooner; drawing still respects the frame budget.
    next = Math.min(refreshAt, Math.max(next, lastFrameAt + MIN_FRAME_MS))
    if (animation !== null && (animationDue >= lastFrameAt + MIN_FRAME_MS || animationDue === refreshAt) &&
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

// Jobs every tick, accounts and Codex once a minute; nothing while no surface
// shows the pane. A forced refresh changes cadence, never the placement guard.
async function tick($: EngineInterface, force: boolean): Promise<void> {
  try {
    if (!(await isVisible($))) {
      missedTick = true
      settleMotion()
      return
    }
    missedTick = false
    const now = await $.clock.now()
    const isDue = force || (now - accountsTriedAt >= ACCOUNTS_MS && now >= accountsRetryAt)
    const isCodexDue = force || now - codexTriedAt >= ACCOUNTS_MS
    if (isCodexDue) codexTriedAt = now
    await Promise.all([
      refreshJobs($), refreshAgents($),
      isDue ? refreshAccounts($) : undefined, isCodexDue ? refreshCodex($) : undefined,
      refreshConversations($, force),
    ])
    // Starters of parentless jobs are searched once both lists are fresh.
    const [listed, open] = await Promise.all([read($, jobs), read($, chats)])
    await reconcileMotion($, await refreshStarters($, listed.list, open.list))
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
// A one-line Button drawn under a capsule's own lines.
type CapsuleRow = { key: string; line: Line; label: string; press: () => void }
type Gauge = { kind: string; label: string; used: number; reset: string; resetsAtMs: number | null; countdown: string }

const plain = (text: string): Seg => ({ text })
const faint = (text: string): Seg => ({ text, dim: true })
const spinner = (now: number): string => SPINNER[Math.floor(now / FRAME_MS) % SPINNER.length]!
const chatMarker = (chat: ChatSession, now: number): Seg => chat.status === 'running'
  ? { text: spinner(now), color: 'suggestion' }
  : chat.status === 'waiting' ? { text: '●', color: Math.floor(now / WAITING_BLINK_MS) % 2 === 0 ? 'error' : 'subtle' }
    : { text: '○', color: 'text' }

// The running jobs a chat started, oldest first, each a row under the chat:
// `└ ⠋ <account>  <step>`, the spinner and account in the account's color.
function delegateRows(chat: ChatSession, chats: ChatSession[], listed: JobsSnapshot, list: Account[],
  now: number): { job: Job; line: Line }[] {
  return listed.list.filter(job => job.status === 'running' && parentChat(job, chats)?.id === chat.id)
    .sort((a, b) => a.startedMs - b.startedMs)
    .map(job => {
      const color = ACCOUNT_COLORS[job.account] ?? 'text'
      return { job, line: [faint('└ '), { text: `${spinner(now)} `, color },
        { text: job.account === '' ? 'ajan' : displayName(job.account, list), color }, plain('  '),
        faint(job.step ?? 'çalışıyor')] }
    })
}

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

// A window whose reset time has passed has started over: 0% until a read
// says otherwise.
const usedNow = (limit: Limit, now: number): number =>
  limit.resetsAtMs !== null && limit.resetsAtMs <= now ? 0 : limit.used

// A key shiftover is renewing will work again by itself; only an expired one
// needs the person to log in again.
function shortError(err: string): string {
  if (/renewing|yenileniyor/i.test(err)) return 'anahtar yenileniyor'
  if (/401|token expired/i.test(err)) return 'yeniden giriş gerekli'
  if (/login required|(?<!yeniden )giriş gerekli/i.test(err)) return 'giriş gerekli'
  if (/429/.test(err)) return 'şu an okunamıyor'
  if (/not logged in/i.test(err)) return 'giriş yapılmamış'
  if (/time[ -]?out|timed out/i.test(err)) return 'zaman aşımı'
  return fitLine([plain(err)], 30).map(seg => seg.text).join('')
}

function gaugesOf(account: Account, now: number): Gauge[] {
  const isCodex = account.name === 'codex'
  const kinds = isCodex ? ['session', 'weekly_all', 'rate_window'] : ['session', 'weekly_all', 'weekly_scoped']
  // A 5-hour window counts down on the border times' minute sample.
  const minute = Math.floor(now / ACCOUNTS_MS) * ACCOUNTS_MS
  return kinds.flatMap(kind => account.limits.filter(limit => limit.kind === kind).map(limit => {
    const minutes = limit.windowMinutes ?? (kind === 'session' ? 300 : 10_080)
    return {
      kind,
      label: isCodex ? minutes === 300 ? '5 saat' : minutes === 10_080 ? 'hafta' : `${Math.round(minutes / 1440)} gün`
        : kind === 'session' ? '5 saat' : kind === 'weekly_all' ? 'hafta' : limit.model || 'Fable',
      used: usedNow(limit, now),
      reset: untilReset(limit.resetsAtMs, now),
      resetsAtMs: limit.resetsAtMs,
      countdown: kind === 'session' && limit.resetsAtMs !== null && limit.resetsAtMs > now
        ? untilReset(limit.resetsAtMs, minute) : '',
    }
  }))
}

function centered(line: Line, width: number): Line {
  const fitted = fitLine(line, width)
  const space = Math.max(0, width - lineCells(fitted))
  return [plain(' '.repeat(Math.floor(space / 2))), ...fitted, plain(' '.repeat(Math.ceil(space / 2)))]
}

function gaugeColumns(gauges: Gauge[], room: number): Line[] {
  const width = Math.max(1, Math.floor((room - gauges.length + 1) / gauges.length))
  const inset = Math.max(0, Math.floor((room - (width + 1) * gauges.length + 1) / 2))
  const join = (column: (gauge: Gauge) => Line): Line => [plain(' '.repeat(inset)),
    ...gauges.flatMap((gauge, index) => [...(index === 0 ? [] : [plain(' ')]), ...column(gauge)])]
  // A countdown keeps its arrow only where the column holds both.
  const labelOf = (gauge: Gauge): string => gauge.countdown === ''
    ? gauge.label === '5 saat' && width < 6 ? '5s' : gauge.label
    : textCells(`↻ ${gauge.countdown}`) <= width ? `↻ ${gauge.countdown}` : gauge.countdown
  return [
    join(gauge => centered([faint(labelOf(gauge))], width)),
    join(gauge => centered([{ text: `${Math.round(clamp(gauge.used, 0, 100))}%`,
      color: severity(gauge.used), weight: 'bold' }], width)),
    join(gauge => bar(gauge.used, width, severity(gauge.used))),
  ]
}

const listedAccounts = (snapshot: AccountsSnapshot, limits: CodexSnapshot): Account[] =>
  [...snapshot.list.filter(account => account.name !== 'codex'), { name: 'codex', display: null, dir: '',
    limits: limits.limits, err: limits.error }]

// What the pane draws for an account it knows by name: its display name when
// shiftover sets one. Codex keeps its own.
const displayName = (name: string, list: Account[]): string =>
  name === 'codex' ? name : list.find(account => account.name === name)?.display || name

function accountSummary(snapshot: AccountsSnapshot, limits: CodexSnapshot, room: number, now: number): Line {
  const parts = listedAccounts(snapshot, limits).map((account): Line => {
    const current = account.name === snapshot.current
    const used = account.limits.length === 0 ? null : Math.max(...account.limits.map(limit => usedNow(limit, now)))
    return [account.name === 'codex' ? faint('◎ ') : current ? { text: '● ', color: CURRENT_COLOR } : faint('○ '),
      { text: `${displayName(account.name, snapshot.list)} `, ...(current ? { color: 'text', weight: 'bold' } as const : {}) },
      { text: used === null ? '?' : `${Math.round(clamp(used, 0, 100))}%`,
        color: used === null ? 'warning' : severity(used), weight: 'bold' }]
  })
  const joined = (): Line => parts.flatMap((part, index) => [...(index === 0 ? [] : [plain('  ')]), ...part])
  let omitted = false
  while (parts.length > 0 && lineCells(joined()) + (omitted ? 3 : 0) > room) {
    parts.pop()
    omitted = true
  }
  return [...joined(), ...(omitted ? [faint(parts.length === 0 ? '…' : '  …')] : [])]
}

function accountLines(snapshot: AccountsSnapshot, limits: CodexSnapshot, now: number, room: number) {
  const listed = listedAccounts(snapshot, limits)
  const sets = listed.map(account => gaugesOf(account, now))
  const names = listed.map(account => displayName(account.name, snapshot.list))
  const nameWidth = Math.max(...names.map(textCells)) + 2
  const cellWidth = Math.floor((room - 2 - nameWidth - 4) / 3)
  const labelOf = (gauge: Gauge, arrow: boolean): string => gauge.countdown === ''
    ? gauge.label === '5 saat' ? '5s' : gauge.label : `${arrow ? '↻ ' : ''}${gauge.countdown}`
  // Inline keeps a six-cell bar beside the widest label: countdowns try the
  // arrow, then bare, in one form for every account; else columns.
  const fits = (arrow: boolean): boolean =>
    cellWidth >= Math.max(5, ...sets.flat().map(gauge => textCells(labelOf(gauge, arrow)))) + 6 + 6
  const arrow = fits(true)
  const inline = (arrow || fits(false)) && sets.every(gauges => gauges.every(gauge => gauge.kind !== 'rate_window'))
  // Session labels share one slot, so their bars line up across accounts.
  const slot = Math.max(0, ...sets.flat().filter(gauge => gauge.kind === 'session')
    .map(gauge => textCells(labelOf(gauge, arrow))))
  return listed.map((account, at) => {
    const current = account.name === snapshot.current
    const marker = account.name === 'codex' ? faint('◎ ')
      : current ? { text: '● ', color: CURRENT_COLOR } : faint('○ ')
    const name = names[at] ?? account.name
    let first: Line = [marker, { text: name, ...(current ? { color: 'text', weight: 'bold' } as const : {}) }]
    const gauges = sets[at] ?? []
    const unreadable = gauges.length === 0
    let body: Line[] = unreadable ? [[{ text: shortError(account.err || 'şu an okunamıyor'), color: 'warning' }]]
      : gaugeColumns(gauges, room)
    const notes: Line[] = unreadable ? [] : gauges.filter(gauge => gauge.used >= 90)
      .sort((a, b) => b.used - a.used).slice(0, 1).map(gauge => {
        let reset = gauge.reset
        if (textCells(`${gauge.label} ${reset} sonra açılır`) > room - (inline ? 2 : 0)) {
          reset = reset.replace(/(\d+)g (\d+)sa/, '$1g$2sa').replace(/(\d+)sa \d+dk/, '$1sa')
        }
        return [...(inline ? [plain('  ')] : []), { text: gauge.label, color: 'error', weight: 'bold' },
          faint(` ${reset === '' ? 'açılış -' : `${reset} sonra açılır`}`)]
      })
    if (inline) {
      first.push(plain(' '.repeat(nameWidth - textCells(name))))
      if (unreadable) first.push(...body[0]!)
      else first.push(...['session', 'weekly_all', 'weekly_scoped'].flatMap((kind, index) => {
        const gauge = gauges.find(gauge => gauge.kind === kind)
        const gap = index === 0 ? [] : [plain('  ')]
        if (!gauge) return [...gap, plain(' '.repeat(cellWidth))]
        const label = labelOf(gauge, arrow)
        const size = kind === 'session' ? slot : textCells(label)
        const color = severity(gauge.used)
        return [...gap, faint(`${label}${' '.repeat(size - textCells(label))} `), ...bar(gauge.used, cellWidth - size - 6, color),
          plain(' '), { text: `${Math.round(clamp(gauge.used, 0, 100))}%`.padStart(4), color, weight: 'bold' as const }]
      }))
      body = []
    }
    // Border times share a minute sample even when spinners redraw faster.
    const minute = Math.floor(now / ACCOUNTS_MS) * ACCOUNTS_MS
    const weekly = unreadable ? [] : gauges.filter(gauge => (gauge.kind === 'weekly_all' ||
      gauge.kind === 'weekly_scoped') && gauge.resetsAtMs !== null && gauge.resetsAtMs > now)
    const value = (gauge: Gauge, used: number): Seg => {
      const reset = untilReset(gauge.resetsAtMs, minute)
      return used >= 90 ? { text: reset, color: severity(used) } : faint(reset)
    }
    const times = weekly.map(gauge => gauge.resetsAtMs ?? now)
    const earliest = weekly[times.indexOf(Math.min(...times))]
    // Weekly resets within an hour read as one time: the earliest, colored
    // for the most used window.
    const resets: Line[] = earliest !== undefined && Math.max(...times) - Math.min(...times) <= RESET_GROUP_MS
      ? [[faint('↻ '), value(earliest, Math.max(...weekly.map(gauge => gauge.used)))]]
      : weekly.map(gauge => [faint(`${gauge.label} `), value(gauge, gauge.used)])
    return { key: account.name, first, body, notes, resets }
  })
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

function taskLines(task: Task, now: number, width: number, list: Account[]): [Line, Line] {
  const isJob = task.kind === 'job'
  const id = taskId(task)
  const status = isJob ? task.job.status : agentIsRunning(task.agent) ? 'running'
    : task.agent.status === 'completed' ? 'done'
      : task.agent.status === 'failed' || task.agent.status === 'killed' ? 'failed' : task.agent.status
  const label = isJob ? task.job.label || 'adsız iş' : task.agent.description || 'adsız ajan'
  const start = finishedMotion.get(id)
  const title: Seg = { text: label, ...(start !== undefined && now - start < FINISH_MS
    ? { color: status === 'failed' ? 'error' : 'success' } : { color: 'text' }) }
  const who = isJob && task.job.account !== '' ? displayName(task.job.account, list) : 'ajan'
  const elapsed = isJob
    ? task.job.durationMs ?? ((task.job.finishedMs ?? now) - task.job.startedMs)
    : (task.agent.finishedAt ?? now) - task.agent.observedAt
  return [align([glyphOf({ id, status }, now), plain(' '), title], [faint('›')], width),
    fitLine([faint(`${who} · ${status === 'stale' ? 'durdu' : duration(elapsed)}`)], width)]
}

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
      // The host store belongs to this mod, across reloads and new tabs. It
      // is a file under the account's Claude config directory and the engine
      // offers none shared across accounts: each account keeps its own choice.
      const open = await $.store.get('isAccountsOpen')
      await update($, isAccountsOpen, () => open !== false)
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

  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    if (e.reason === 'clear') {
      agentsGeneration += 1
      await update($, agents, () => NO_AGENTS).catch(() => undefined)
      observeAgents(NO_AGENTS, await $.clock.now(), false)
      await reconcileMotion($)
    }
    return ended
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    await refreshAgents($)
    return completed
  })

  // The person's own close holds across a reload of this module.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    if (!(await isVisible($))) settleMotion()
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

  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const focused = await next(e)
    if (!('deny' in focused)) {
      focusedCapsule = e.plugin === PANE ? e.element : undefined
      await reconcileMotion($, true)
    }
    return focused
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(1, Math.floor(e.props.bodyColumns))
    const bordered = width >= 4
    const padding = width >= 6 ? 1 : 0
    const innerWidth = Math.max(1, width - (bordered ? 2 : 0) - 2 * padding)
    const isPlain = (seg: Seg): boolean => seg.color === undefined && seg.dim !== true && seg.weight === undefined
    // Hover mutes every run of a pressable block, so the block inverted under
    // the pointer is one grey block; focus mutes it at rest for the same reason.
    const muteHover: TextHoverProps = { color: MUTED }
    const muted = (line: Line): Line => line.map(seg => ({ ...seg, color: MUTED }))
    const draw = (line: Line, room = innerWidth, hover?: TextHoverProps) => (
      <Text wrap="truncate-end" mono hover={hover}>
        {fitLine(line.length === 0 ? [plain(' ')] : line, room)
          .filter(seg => seg.text !== '')
          .map(seg => (isPlain(seg) ? seg.text : <Text {...styleOf(seg)} hover={hover}>{seg.text}</Text>))}
      </Text>
    )
    // Box has no title prop. A final absolute sibling paints over its top
    // border, including the surrounding spaces, without adding a content row.
    const card = (title: string, children: RenderChildren, detail: Line = [], press?: () => void) => {
      const titleWidth = Math.max(1, width - 4)
      const compact = press === undefined ? {} : { gap: 0, paddingY: 0, marginY: 0 }
      const heading: Line = [{ text: ` ${title} `, color: 'text', weight: 'bold' },
        ...detail, ...(detail.length === 0 ? [] : [plain(' ')])]
      // A pressable title is the Button itself; its keyed Box scopes the hover.
      const scope = press === undefined ? {} : { key: 'accounts:title' }
      const isFocused = e.props.isFocused && focusedCapsule === 'accounts:toggle'
      return <Box width={width} flexShrink={0} flexDirection="column" position="relative" {...compact}>
          <Box width={width} flexShrink={0} flexDirection="column" overflow="hidden"
            paddingX={padding} borderStyle={bordered ? 'round' : undefined} borderColor="inactive" borderDimColor {...compact}>
            {children}
          </Box>
          <Box {...scope} position="absolute" top={0} left={bordered ? 2 : 0} width={Math.min(titleWidth, lineCells(heading))} {...compact}>
            {press === undefined ? draw(heading, titleWidth) : <Button key="accounts:toggle" plain label={title}
              hover={muteHover} onPress={press}>
              {draw(isFocused ? muted(heading) : heading, titleWidth, muteHover)}
            </Button>}
          </Box>
        </Box>
    }
    const capsuleWidth = innerWidth
    const capsuleRoom = Math.max(1, capsuleWidth - 4)
    // A pressable capsule is one Button holding every line, so a press
    // anywhere inside its border opens it and no line is selected alone. A
    // Markdown link would lose the runs' colors, take no focus ring and open
    // its URL on a modified click. The pointer still inverts the Button: hover
    // mutes every run, the padding columns included, to one grey block, and
    // the keyed Box lights the border. Rows below it are Buttons of their own.
    const capsule = (key: string, first: Line, second: Line | undefined, press?: () => void,
      notes: Line[] = [], capsulePadding = 1, fixedColor?: Color, borderParts: Line[] = [], rows: CapsuleRow[] = []) => {
      const room = Math.max(1, capsuleWidth - 2 - 2 * capsulePadding)
      const lines = [first, ...(second === undefined ? [] : [second]), ...notes]
      // The ring rests on the capsule's Button, keyed as the capsule, or on a
      // row's; either lights the border.
      const isFocused = (target: string): boolean => e.props.isFocused && focusedCapsule === target
      const isRinged = (press !== undefined && isFocused(key)) || rows.some(row => isFocused(row.key))
      const borderColor = fixedColor ?? (isRinged ? 'text' : 'subtle')
      const parts = [...borderParts]
      const borderLine = (): Line => [faint(' '), ...parts.flatMap((part, index) =>
        [...(index === 0 ? [] : [faint(' · ')]), ...part]), faint(' ')]
      // Leave a border cell at either corner; drop complete trailing parts.
      while (parts.length > 0 && lineCells(borderLine()) > capsuleWidth - 4) parts.pop()
      const detail = parts.length === 0 ? [] : borderLine()
      const compact = key.startsWith('account:') ? { gap: 0, paddingY: 0, marginY: 0 } : {}
      const label = first.map(seg => seg.text).join('').replace(/\s+/g, ' ').trim()
      // With a Button inside, every line runs across the padding columns too.
      const isFlush = press !== undefined || rows.length > 0
      const side = ' '.repeat(capsulePadding)
      const across = (line: Line): Line => {
        const fitted = fitLine(line, room)
        return [...fitted, plain(' '.repeat(Math.max(0, room - lineCells(fitted))))]
      }
      // A Button's lines sit between padding columns of their own Text.
      const block = (content: Line[], isMuted: boolean): RenderChildren[] => content.flatMap((line, index) => {
        const edge = capsulePadding === 0 ? []
          : [<Text {...(isMuted ? { color: MUTED } : {})} hover={muteHover}>{side}</Text>]
        const row = across(line)
        return [...(index === 0 ? [] : ['\n']), ...edge, draw(isMuted ? muted(row) : row, room, muteHover), ...edge]
      })
      // Each Button has a keyed Box of its own: the pointer inverts and mutes
      // the one target under it, never its neighbours.
      const target = (buttonKey: string, buttonLabel: string, onPress: () => void, content: Line[]) => (
        <Box key={`target:${buttonKey}`} flexDirection="column">
          <Button key={buttonKey} plain label={buttonLabel} hover={muteHover} onPress={onPress}>
            {block(content, isFocused(buttonKey))}
          </Button>
        </Box>
      )
      return <Box key={`capsule:${key}`} width={capsuleWidth} flexShrink={0} flexDirection="column" position="relative" {...compact}>
        <Box width={capsuleWidth} flexShrink={0} flexDirection="column" borderStyle="round" borderColor={borderColor}
          hover={isFlush && fixedColor === undefined ? { borderColor: 'text' } : undefined}
          paddingX={isFlush ? 0 : capsulePadding} {...compact}>
          {press !== undefined ? target(key, label, press, lines) : lines.map(line => isFlush
            ? draw([plain(side), ...across(line), plain(side)], capsuleWidth - 2) : draw(fitLine(line, room), room))}
          {rows.map(row => target(row.key, row.label, row.press, [row.line]))}
        </Box>
        {detail.length === 0 ? null : <Box position="absolute" top={0}
          left={capsuleWidth - 2 - lineCells(detail)} width={lineCells(detail)}>
          {draw(detail, lineCells(detail))}
        </Box>}
      </Box>
    }
    try {
      const [held, listed, roster, limits, conversations, now, accountsOpen] = await Promise.all([
        read($, accounts), read($, jobs), read($, agents),
        read($, codex), read($, chats), $.clock.now(), read($, isAccountsOpen),
      ])
      // Cached tasks after a hot reload are a steady baseline. Fresh reads
      // prepare their completion pop before publishing it above.
      // Seed once: an older in-flight render must not overwrite a fresh
      // transition prepared just before its state update resolves.
      if (!jobsObserved) observeJobs(listed, now, false)
      if (!agentsObserved) observeAgents(roster, now, false)
      observeChats(conversations)
      await reconcileMotion($)
      // Ticks skipped while no surface showed the pane: once drawn, catch up
      // at once rather than at the next poll, outside this drawing.
      if (missedTick) {
        missedTick = false
        $.clock.after(1, () => { void tick($, false) })
      }
      const tasks = tasksOf(listed, roster)
      // Every account shares the capsule's padded inner width.
      const accountRows = accountLines(held, limits, now, capsuleRoom)
      // A refresh orders the chats; drawing keeps that order.
      const conversationList = conversations.list
      // Pane.scroll is an engine-owned window over this entire tree.
      const chatRows = conversationList.map(chat => {
        const glyph = chatMarker(chat, now)
        const title: Line = [glyph, plain(' '), { text: chat.title, color: 'text',
          ...(chat.status === 'waiting' ? { weight: 'bold' as const } : {}) }]
        const line = chat.isCurrent ? fitLine(title, capsuleRoom) : align(title, [faint('›')], capsuleRoom)
        const state = chat.isCurrent ? 'bu sekme' : chat.status === 'waiting' ? 'cevap bekliyor'
          : chat.status === 'running' ? 'çalışıyor' : 'boşta'
        const metadata = [displayName(chat.account, held.list), chat.model, chat.effort]
          .filter(part => part && !/^[-–]$/.test(part)).join(' · ')
        // Each running job the chat started opens a tab that follows it live.
        const delegates = delegateRows(chat, conversationList, listed, held.list, now).map(({ job, line: row }) => ({
          key: `follow:${job.id}`, line: row, label: row.map(seg => seg.text).join('').replace(/\s+/g, ' ').trim(),
          press: async () => {
            const at = await locate($).catch(() => null)
            if (at !== null) await followJob($, chat, job.id, at.bin)
          },
        }))
        return capsule(`chat:${chat.id}`, line, [faint(metadata || ' ')],
          chat.isCurrent ? undefined : () => focusChat($, chat), [[faint(state)]], 1,
          chat.isCurrent ? CURRENT_COLOR : chat.status === 'waiting'
            ? now % WAITING_BORDER_MS < WAITING_BORDER_FLASH_MS ? 'error' : 'subtle' : undefined,
          [], delegates)
      })
      const jobRows = tasks.slice(0, CAPSULES_SHOWN).map(task => {
        const [title, metadata] = taskLines(task, now, capsuleRoom, held.list)
        return capsule(taskId(task), title, metadata, async () => {
          if (!(await isVisible($))) return
          if (task.kind === 'agent') await $.ui.view({ agentId: task.agent.id })
          else await openDelegate($, task.job, (await read($, chats)).list)
        })
      })
      return (
        <Box width={width} flexDirection="column" overflow="hidden">
          {card(`Hesaplar ${accountsOpen ? '▾' : '▸'}`, accountsOpen ? <Box flexDirection="column" gap={0} paddingY={0} marginY={0}>
            {held.list.length === 0 && held.error !== null ? draw([faint('hesaplar okunamadı')]) : null}
            {accountRows.map(row => capsule(`account:${row.key}`, row.first, row.body[0], undefined,
              [...row.body.slice(1), ...row.notes], 1, undefined, row.resets))}
          </Box> : draw(accountSummary(held, limits, innerWidth, now)),
            isReadingAccounts ? [{ text: spinner(now), color: 'suggestion' }] : [], async () => {
              const open = await update($, isAccountsOpen, value => !value)
              await $.store.set('isAccountsOpen', open)
            })}
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
