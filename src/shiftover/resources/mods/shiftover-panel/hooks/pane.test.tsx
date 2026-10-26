import { expect, mock, test } from 'claude-code/testing'
import type { ElementQuery, Engine, FoundElement, Mounted, MountPointerEvent, MountPressTarget, MountTarget } from 'claude-code/testing'
import type { AgentInfo, On, RenderSurface } from 'claude-code'
import type { CapsuleProps } from './capsule'
import { chatStatus, formatModelId, isShellTitle, parsePanels, parseSessions, parseTranscriptTail, parseWorkspaces } from './sessions'
import { claudeStep, codexStep, commandStep, delegateLabel, projectFolders } from './steps'

const PANE = {
  plugin: 'shiftover-panel', component: 'Pane', requestId: 'shiftover-panel',
  props: { title: 'Shiftover', isFocused: false, bodyColumns: 42, placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const NOW = Date.UTC(2026, 9, 24, 20, 20, 0)
const HOME = '/Users/k'
const JOBS = `${HOME}/.cache/shiftover/jobs`
const SESSIONS = `${HOME}/.cmuxterm/claude-hook-sessions.json`
const CONFIG = `${HOME}/.config/shiftover/config.toml`
const CODEX = `${HOME}/.codex/sessions/2026/10/24`
const CMUX = '/Applications/cmux.app/Contents/Resources/bin/cmux'
const WS = '11111111-1111-4111-8111-111111111111'
const CURRENT = '22222222-2222-4222-8222-222222222222'
const WAITING = '33333333-3333-4333-8333-333333333333'
const RUNNER = '44444444-4444-4444-8444-444444444444'
const IDLE = '55555555-5555-4555-8555-555555555555'
const DEAD = '66666666-6666-4666-8666-666666666666'
const CLOSED = '77777777-7777-4777-8777-777777777777'
const iso = (ms: number): string => new Date(ms).toISOString()
const spinner = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

type RawLimit = { kind: string; model: string; used: number; resets_at: string | null }
type RawAccount = { name: string; email: string; dir: string; err?: string; limits?: RawLimit[];
  next_refresh_at?: number | string | null; fetched_at?: number | string | null; display?: string | null }
type RawJob = {
  id: string; account: string; model: string | null; label: string; cwd?: string; status: string;
  pid: number; started: number; finished: number; cost_usd: number | null; duration_ms: number | null;
  parent_session_id?: string; parent_pid?: number; backend?: string;
  transcript_path?: string; log_path?: string; dir?: string;
}
const STATUS: RawAccount[] = [
  { name: 'kadir', email: 'kadir@example.com', dir: `${HOME}/.claude`, err: 'HTTP 401 (token expired)' },
  { name: 'aras', email: 'aras@example.com', dir: `${HOME}/.claude-aras`, limits: [
    { kind: 'session', model: '', used: 10, resets_at: iso(NOW + 202 * 60_000) },
    { kind: 'weekly_all', model: '', used: 75, resets_at: iso(NOW + 67 * 3_600_000 + 60_000) },
    { kind: 'weekly_scoped', model: 'Fable', used: 92, resets_at: iso(NOW + 67 * 3_600_000 + 60_000) },
  ] },
]
const RUNNING: RawJob = {
  id: '20261024-231738-2e9c', account: 'codex', model: null, label: 'ads review', status: 'running',
  pid: 4242, started: (NOW - 55_000) / 1000, finished: 0, cost_usd: null, duration_ms: null,
}
const DONE: RawJob = {
  id: '20261024-214814-5cd4', account: 'aras', model: 'haiku', label: '', cwd: '/Users/k/tvOSBrowser',
  status: 'done', pid: 79123, started: (NOW - 3_600_000) / 1000, finished: (NOW - 3_590_000) / 1000,
  cost_usd: 0.0052, duration_ms: 454_686,
}
const CONFIG_TEXT = 'main = "kadir"\n[accounts.kadir]\ndir = "~/.claude"\n[accounts.aras]\ndir = "~/.claude-aras"\n'
const rawSession = (surfaceId: string, pid: number, extra: Record<string, unknown> = {}) => ({
  surfaceId, workspaceId: WS, pid, agentLifecycle: 'idle', runtimeStatus: 'idle', hookEventName: 'Stop',
  turnSettled: true, transcriptPath: `/transcripts/${pid}.jsonl`, cwd: '/Users/k/project', ...extra,
})
const PANELS = [
  { id: CURRENT, title: 'Current tab' }, { id: WAITING, title: 'Needs approval' },
  { id: RUNNER, title: 'Analysis tab' }, { id: IDLE, title: 'Idle tab' }, { id: DEAD, title: 'Dead process' },
]
const ran = (exitCode: number, stdout: string, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})
type ProcessCall = { argv: readonly string[]; timeoutMs?: number }
type World = {
  isOpen: boolean; isPlaced: boolean; isShown: boolean; jobsRevision: number; sessionsRevision: number;
  accountsGate: Promise<void> | null; isShiftoverDown: boolean; isJobsDown: boolean;
  jobPsFailure: 'deny' | 'exit' | 'stderr' | null; isCmuxDown: boolean;
  isFocusDown: boolean; hasCmux: boolean; accounts: RawAccount[]; jobs: RawJob[]; agents: AgentInfo[];
  sessions: Record<string, unknown>; panels: { id: string; title: string }[]; alivePids: Set<number>;
  // A size stands in for a file too big to hold: the engine refuses to read
  // past 4 MiB, and `tail` serves the text's end.
  codexFiles: Map<string, { mtimeMs: number; text: string; size?: number }>;
  chatFiles: Map<string, { mtimeMs: number; text: string; size?: number }>; openColumns: number[];
  // Job processes as `ps` reports them, job .out files by job id, and the
  // transcript text grep searches.
  processes: Map<number, { stat: string; command: string }>;
  outs: Map<string, { mtimeMs: number; text: string; size?: number }>; transcripts: Map<string, string>;
  calls: ProcessCall[]; reads: string[]; usageCalls: unknown[]; agentCalls: number; toasts: string[]; views: unknown[];
  // Every $.state write by key, in order, and the last value written.
  writes: string[]; snapshots: Map<string, unknown>; store: Map<string, unknown>; storeReads: string[];
}

// Every external operation is answered here, including click commands. No test
// reaches the owner's cmux process, transcripts, account files, or terminal.
function world(on: On, env: Record<string, string> = {}, isPlaced = true): World {
  const state: World = {
    isOpen: false, isPlaced, isShown: true, jobsRevision: 1, sessionsRevision: 1, accountsGate: null,
    isShiftoverDown: false, isJobsDown: false, isFocusDown: false, hasCmux: true,
    jobPsFailure: null, isCmuxDown: false,
    accounts: STATUS, jobs: [RUNNING, DONE], agents: [], panels: PANELS,
    sessions: {
      'current-session': rawSession(CURRENT, 1001),
      'idle-session': rawSession(IDLE, 1004, { launchCommand: { environment: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-aras` } } }),
      'runner-session': rawSession(RUNNER, 1003, { agentLifecycle: 'running', runtimeStatus: 'running' }),
      'waiting-session': rawSession(WAITING, 1002, { agentLifecycle: 'needsInput', hookEventName: 'Notification' }),
      'closed-session': rawSession(CLOSED, 1005), 'dead-session': rawSession(DEAD, 1006),
    },
    alivePids: new Set([1001, 1002, 1003, 1004]), codexFiles: new Map(),
    chatFiles: new Map(), openColumns: [],
    processes: new Map([[4242, { stat: 'S', command: '/opt/bin/codex exec -' }]]), outs: new Map(), transcripts: new Map(),
    calls: [], reads: [], usageCalls: [], agentCalls: 0, toasts: [], views: [], writes: [], snapshots: new Map(), store: new Map(),
    storeReads: [],
  }
  on('store.get', (_, e) => { state.storeReads.push(e.key); return { value: state.store.get(e.key) } })
  on('store.set', (_, e) => { state.store.set(e.key, e.value); return { value: undefined } })
  mock.env(on, { HOME, CMUX_SURFACE_ID: CURRENT, ...env })
  on('state.set', async (_, e, next) => {
    const result = await next(e)
    state.writes.push(e.key)
    state.snapshots.set(e.key, e.value)
    return result
  })
  on('command.register', () => ({ value: { command: 'shiftover-panel' } }))
  on('command.run', () => ({ text: 'engine' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'current-session' }))
  on('ui.open', (_, e) => {
    if (e.columns !== undefined) state.openColumns.push(e.columns)
    state.isOpen = true
    return { value: state.isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'below 144 columns' } }
  })
  on('ui.close', () => { state.isOpen = false; return { value: undefined } })
  on('ui.panes', () => ({ value: state.isOpen ? [{ id: 'shiftover-panel', title: 'Shiftover',
    isShown: state.isShown, isFocused: false, isPlaced: state.isPlaced }] : [] }))
  on('ui.toast', (_, e) => { state.toasts.push(e.text); return { value: undefined } })
  on('ui.view', (_, e) => { state.views.push(e); return { value: {} } })
  on('session.usage', (_, e) => { state.usageCalls.push(e); return { deny: 'session usage is unused by the pane' } })
  on('agent.list', () => { state.agentCalls += 1; return { value: state.agents } })
  on('fs.exists', (_, e) => {
    state.reads.push(`exists:${e.path}`)
    return { value: e.path === CMUX ? state.hasCmux : true }
  })
  on('fs.stat', (_, e) => {
    state.reads.push(`stat:${e.path}`)
    const file = state.chatFiles.get(e.path)
    if (file) return { value: { kind: 'file', size: file.size ?? file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
    if (e.path.startsWith('/transcripts/')) return { deny: 'transcript unavailable' }
    return { value: { kind: 'file', size: 100, mtimeMs: state.sessionsRevision, isLink: false } }
  })
  on('fs.list', (_, e) => {
    state.reads.push(`list:${e.path}`)
    if (e.path === JOBS) {
      if (state.isJobsDown) return { deny: 'jobs unavailable' }
      return { value: [...[...state.jobs.map(job => `${job.id}.json`), 'ignored.out'].map(name => ({
        name, kind: 'file' as const, size: 100, mtimeMs: state.jobsRevision, isLink: false,
      })), ...[...state.outs].map(([id, out]) => ({
        name: `${id}.out`, kind: 'file' as const, size: out.size ?? out.text.length, mtimeMs: out.mtimeMs, isLink: false,
      }))] }
    }
    // Codex's dated folders and Claude's session folders hold what the test
    // put there; a session folder with nothing in it is not there at all.
    const entries = [...state.codexFiles.entries(), ...state.chatFiles.entries()]
      .filter(([path]) => path.slice(0, path.lastIndexOf('/')) === e.path)
      .map(([path, file]) => ({ name: path.slice(path.lastIndexOf('/') + 1), kind: 'file' as const,
        size: file.size ?? file.text.length, mtimeMs: file.mtimeMs, isLink: false }))
    return entries.length === 0 && e.path.includes('/projects/') ? { deny: `ENOENT ${e.path}` } : { value: entries }
  })
  on('fs.read', (_, e) => {
    state.reads.push(`read:${e.path}`)
    if (e.path === CONFIG) return { value: CONFIG_TEXT }
    if (e.path === SESSIONS) return { value: JSON.stringify({ sessions: state.sessions }) }
    const chat = state.chatFiles.get(e.path)
    if (chat) return { value: chat.text }
    const codex = state.codexFiles.get(e.path)
    if (codex) return (codex.size ?? codex.text.length) > 4 * 1024 * 1024 ? { deny: 'file is over 4 MiB' } : { value: codex.text }
    const job = state.jobs.find(candidate => e.path === `${JOBS}/${candidate.id}.json`)
    return job ? { value: JSON.stringify(job) } : { deny: `unexpected read ${e.path}` }
  })
  on('process.run', async (_, e) => {
    state.calls.push({ argv: [...e.argv], timeoutMs: e.init?.timeoutMs })
    if (e.argv[0] === 'ps') {
      if (e.argv.includes('pid=')) return ran(0, [...state.alivePids].join('\n'))
      if (state.jobPsFailure === 'deny') return { deny: 'ps not permitted' }
      if (state.jobPsFailure !== null) return ran(state.jobPsFailure === 'exit' ? 2 : 1, '', 'ps: operation not permitted\n')
      // `ps -o pid=,stat=,command=` prints one padded row per live pid and exits 1 with none.
      const rows = [...new Set((e.argv[e.argv.indexOf('-p') + 1] ?? '').split(','))].flatMap(pid => {
        const entry = state.processes.get(Number(pid))
        return entry ? [`${pid.padStart(5)} ${entry.stat.padEnd(4)} ${entry.command}\n`] : []
      })
      return ran(rows.length > 0 ? 0 : 1, rows.join(''))
    }
    if (e.argv[0] === 'grep') {
      // `grep -o -H -E -s -e <pattern>... -- <paths>` prints `path:match` per
      // match; exit 2 when a file is unreadable, whatever it printed.
      const end = e.argv.indexOf('--')
      const patterns = e.argv.slice(1, end).filter((_, index, args) => args[index - 1] === '-e')
        .map(pattern => new RegExp(pattern.replace(/\[\[:space:\]\]/g, '\\s'), 'g'))
      let isMissing = false
      const found: string[] = []
      for (const path of e.argv.slice(end + 1)) {
        const text = state.transcripts.get(path)
        if (text === undefined) { isMissing = true; continue }
        for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.push(`${path}:${match[0]}\n`)
      }
      return ran(isMissing ? 2 : found.length > 0 ? 0 : 1, found.join(''))
    }
    if (e.argv[0] === 'tail' || e.argv[0] === 'head') {
      // As BSD tail and head: with several files, each one's end or start
      // under `==> path <==`, a newline before every later head; a missing
      // file gets no head.
      const fileOf = (path: string) => (path.startsWith(`${JOBS}/`) && path.endsWith('.out')
        ? state.outs.get(path.slice(JOBS.length + 1, -4)) : undefined) ?? state.chatFiles.get(path) ?? state.codexFiles.get(path)
      const paths = e.argv.slice(e.argv.indexOf('--') + 1)
      const bytes = Number(e.argv[2])
      const part = (text: string): string => e.argv[0] === 'tail' ? text.slice(-bytes) : text.slice(0, bytes)
      if (paths.length === 1) {
        const file = fileOf(paths[0]!)
        return file ? ran(0, part(file.text)) : ran(1, '', 'transcript unavailable')
      }
      let stdout = ''
      let isMissing = false
      for (const path of paths) {
        const file = fileOf(path)
        if (!file) { isMissing = true; continue }
        stdout += `${stdout === '' ? '' : '\n'}==> ${path} <==\n${part(file.text)}`
      }
      return ran(isMissing ? 1 : 0, stdout, isMissing ? `${e.argv[0]}: No such file or directory\n` : '')
    }
    if (state.isCmuxDown && (e.argv[1] === 'list-workspaces' || e.argv[1] === 'list-panels')) return ran(1, '', 'socket unavailable\n')
    if (e.argv[1] === 'list-workspaces') return ran(0, `* workspace:1 ${WS} Main\n`)
    if (e.argv[1] === 'list-panels') return ran(0, state.panels.map((panel, index) =>
      `surface:${index + 1} ${panel.id} terminal ${index === 0 ? '[focused] ' : ''}${JSON.stringify(panel.title)}`).join('\n'))
    if (e.argv[1] === 'select-workspace' || e.argv[1] === 'focus-panel' || e.argv[1] === 'new-surface') {
      return ran(state.isFocusDown ? 1 : 0, '')
    }
    if (state.accountsGate) await state.accountsGate
    return state.isShiftoverDown ? ran(2, '', 'config not found\n') : ran(0, JSON.stringify(state.accounts))
  })
  return state
}

const rowText = async (ui: Pick<Mounted, 'find'>, text: RegExp) => (await ui.find({ type: 'Text', text }))?.text
const paneRows = async (ui: Pick<Mounted, 'drawn'>): Promise<string[]> => {
  const rows = (node: unknown): string[] => {
    if (typeof node !== 'object' || node === null) return []
    const current = node as { type?: string; children?: unknown[] }
    if (current.type === 'Text' || current.type === 'Button') return contentRows(node)
    return (current.children ?? []).flatMap(rows)
  }
  return rows(await ui.drawn())
}
function shownText(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node !== 'object' || node === null) return ''
  return ((node as { children?: unknown[] }).children ?? []).map(shownText).join('')
}

// The kit exposes an element tree rather than terminal paint. Include every
// row and column box, border and padding cell without clipping overflow away.
const graphemes = new Intl.Segmenter('tr', { granularity: 'grapheme' })
const cells = (text: string): number => [...graphemes.segment(text)].reduce((sum, part) => {
  if (/^[\p{Mark}\p{Format}]+$/u.test(part.segment)) return sum
  return sum + (/\p{Emoji_Presentation}|\uFE0F|[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]/u.test(part.segment) ? 2 : 1)
}, 0)
const padRow = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - cells(text)))
type DrawnNode = { type?: string; props?: Record<string, unknown>; hover?: Record<string, unknown>; children?: unknown[] }
const drawnNodes = (value: unknown): DrawnNode[] => {
  if (typeof value !== 'object' || value === null) return []
  const node = value as DrawnNode
  return [node, ...(node.children ?? []).flatMap(drawnNodes)]
}
function laidOutRows(value: unknown, available: number): string[] {
  if (typeof value !== 'object' || value === null) return []
  const node = value as DrawnNode
  const props = node.props ?? {}
  if (props.display === 'none') return []
  if (node.type === 'Text') return [shownText(node)]
  if (node.type === 'Button') return shownText(node).split('\n')
  const width = typeof props.width === 'number' ? props.width : available
  const border = typeof props.borderStyle === 'string' ? 1 : 0
  const left = Number(props.paddingLeft ?? props.paddingX ?? props.padding ?? 0)
  const right = Number(props.paddingRight ?? props.paddingX ?? props.padding ?? 0)
  const top = Number(props.paddingTop ?? props.paddingY ?? props.padding ?? 0)
  const bottom = Number(props.paddingBottom ?? props.paddingY ?? props.padding ?? 0)
  const inside = Math.max(0, width - 2 * border - left - right)
  const children = node.children ?? []
  const flow = children.filter(child => (child as DrawnNode | null)?.props?.position !== 'absolute')
  let rows: string[]
  if (props.flexDirection === 'row') {
    const gap = Number(props.columnGap ?? props.gap ?? 0)
    const fixed = flow.reduce<number>((sum, child) => {
      const childWidth = (child as DrawnNode | null)?.props?.width
      return sum + (typeof childWidth === 'number' ? childWidth : 0)
    }, 0)
    const flexible = flow.filter(child => typeof (child as DrawnNode | null)?.props?.width !== 'number').length
    const share = Math.max(0, Math.floor((inside - fixed - gap * Math.max(0, flow.length - 1)) / Math.max(1, flexible)))
    const columns = flow.map(child => laidOutRows(child, share))
    rows = Array.from({ length: Math.max(0, ...columns.map(column => column.length)) }, (_, index) =>
      columns.map((column, at) => {
        const childWidth = (flow[at] as DrawnNode | null)?.props?.width
        return padRow(column[index] ?? '', typeof childWidth === 'number' ? childWidth : share)
      }).join(' '.repeat(gap)))
  } else rows = flow.flatMap(child => laidOutRows(child, inside))
  const padded = [
    ...Array.from({ length: top }, () => ''), ...rows, ...Array.from({ length: bottom }, () => ''),
  ].map(row => `${border ? '│' : ''}${' '.repeat(left)}${padRow(row, inside)}${' '.repeat(right)}${border ? '│' : ''}`)
  if (border) {
    padded.unshift(`╭${'─'.repeat(Math.max(0, width - 2))}╮`)
    padded.push(`╰${'─'.repeat(Math.max(0, width - 2))}╯`)
  }
  for (const child of children.filter(candidate => (candidate as DrawnNode | null)?.props?.position === 'absolute')) {
    const absolute = child as DrawnNode
    const x = Number(absolute.props?.left ?? 0)
    const y = Number(absolute.props?.top ?? 0)
    const overlay = laidOutRows(child, Math.max(0, width - x))
    for (const [offset, row] of overlay.entries()) {
      const target = padded[y + offset] ?? ''
      padded[y + offset] = padRow(target.slice(0, x), x) + row + target.slice(x + cells(row))
    }
  }
  return padded
}
// Cell rectangles in document order, under laidOutRows's model: absolute
// children sit at their parent's origin plus top and left.
type Rect = { node: DrawnNode; x: number; y: number; w: number; h: number }
function layoutRects(value: unknown, available: number, x = 0, y = 0): Rect[] {
  if (typeof value !== 'object' || value === null) return []
  const node = value as DrawnNode
  const props = node.props ?? {}
  if (props.display === 'none') return []
  if (node.type === 'Text' || node.type === 'Button') {
    const lines = shownText(node).split('\n')
    return [{ node, x, y, w: Math.max(...lines.map(cells)), h: lines.length }]
  }
  const width = typeof props.width === 'number' ? props.width : available
  const border = typeof props.borderStyle === 'string' ? 1 : 0
  const left = Number(props.paddingLeft ?? props.paddingX ?? props.padding ?? 0)
  const right = Number(props.paddingRight ?? props.paddingX ?? props.padding ?? 0)
  const top = Number(props.paddingTop ?? props.paddingY ?? props.padding ?? 0)
  const inside = Math.max(0, width - 2 * border - left - right)
  const children = (node.children ?? []) as (DrawnNode | null)[]
  const isAbsolute = (child: DrawnNode | null): boolean => child?.props?.position === 'absolute'
  const fixedWidth = (child: DrawnNode | null): number | undefined =>
    typeof child?.props?.width === 'number' ? child.props.width : undefined
  const flow = children.filter(child => !isAbsolute(child))
  const isRow = props.flexDirection === 'row'
  const gap = Number(props.columnGap ?? props.gap ?? 0)
  const share = Math.max(0, Math.floor((inside - flow.reduce((sum, child) => sum + (fixedWidth(child) ?? 0), 0) -
    gap * Math.max(0, flow.length - 1)) / Math.max(1, flow.filter(child => fixedWidth(child) === undefined).length)))
  let cursor = isRow ? x + border + left : y + border + top
  const nested = children.flatMap(child => {
    if (isAbsolute(child)) {
      const at = Number(child?.props?.left ?? 0)
      return layoutRects(child, Math.max(0, width - at), x + at, y + Number(child?.props?.top ?? 0))
    }
    const placed = isRow ? layoutRects(child, share, cursor, y + border + top)
      : layoutRects(child, inside, x + border + left, cursor)
    cursor += isRow ? (fixedWidth(child) ?? share) + gap : laidOutRows(child, inside).length
    return placed
  })
  return [{ node, x, y, w: width, h: laidOutRows(node, available).length }, ...nested]
}
// An absolute Box paints over what precedes it and takes the pointer there:
// it must never cover a Button drawn before it.
function coveredButtons(tree: unknown, width: number): string[] {
  const rects = layoutRects(tree, width)
  return rects.flatMap((button, index) => button.node.type !== 'Button' ? [] : rects.slice(index + 1)
    .filter(box => box.node.type === 'Box' && box.node.props?.position === 'absolute' &&
      !drawnNodes(box.node).includes(button.node) && box.x < button.x + button.w && button.x < box.x + box.w &&
      box.y < button.y + button.h && button.y < box.y + box.h)
    .map(box => `${String(button.node.props?.key)} under ${shownText(box.node)}`))
}
const absoluteParents = (tree: unknown): DrawnNode[] => drawnNodes(tree).filter(node =>
  (node.children ?? []).some(child => (child as DrawnNode | null)?.props?.position === 'absolute'))
const isUnpadded = (node: DrawnNode): boolean => ['padding', 'paddingX', 'paddingY', 'paddingTop', 'paddingBottom',
  'paddingLeft', 'paddingRight'].every(name => Number(node.props?.[name] ?? 0) === 0)
const capsules = (tree: unknown): DrawnNode[] => drawnNodes(tree).filter(node =>
  node.type === 'Box' && /^capsule:(chat|job|agent):/.test(String(node.props?.key)))
const capsuleFor = (tree: unknown, title: string): DrawnNode | undefined =>
  capsules(tree).find(node => shownText(node).includes(title))
const accountCapsule = (tree: unknown, name: string): DrawnNode | undefined => drawnNodes(tree).find(node =>
  node.type === 'Box' && node.props?.borderStyle === 'round' && node.props?.borderColor === 'subtle' &&
  ['●', '○', '◎'].some(marker => contentRows(node)[0] === `${marker} ${name}` ||
    contentRows(node)[0]?.startsWith(`${marker} ${name} `)))
const accountsCard = (tree: unknown): DrawnNode | undefined => drawnNodes(tree).find(node =>
  node.type === 'Box' && node.props?.position === 'relative' && shownText(node).includes('Hesaplar'))
const accountFrame = (tree: unknown, name: string): DrawnNode | undefined => drawnNodes(tree).find(node =>
  node.type === 'Box' && node.props?.key === `capsule:account:${name}`)
const resetOverlay = (tree: unknown, name: string): DrawnNode | undefined =>
  (accountFrame(tree, name)?.children as DrawnNode[] | undefined)?.find(node => node.props?.position === 'absolute')
const capsuleBorder = (tree: unknown, title: string): DrawnNode | undefined =>
  drawnNodes(capsuleFor(tree, title)).find(node => node.type === 'Box' && node.props?.borderStyle === 'round')
const borderOverlay = (frame: DrawnNode | undefined): DrawnNode | undefined =>
  (frame?.children as DrawnNode[] | undefined)?.find(node =>
    node.type === 'Box' && node.props?.position === 'absolute' && node.props.borderStyle === undefined)
// A chat's running delegates: a row each under the chat's own lines, a keyed
// Box the capsule module drew or, without it, a Button.
const followButtonsIn = (capsule: DrawnNode | undefined): DrawnNode[] => drawnNodes(capsule)
  .filter(node => (node.type === 'Button' || node.type === 'Box') && String(node.props?.key).startsWith('follow:'))
const followButtons = (tree: unknown, title: string): DrawnNode[] => followButtonsIn(capsuleFor(tree, title))
const subRows = (tree: unknown, title: string): string[] => followButtons(tree, title).flatMap(node => contentRows(node))
const subRow = (name: string, step = 'çalışıyor'): RegExp => new RegExp(`^└ [${spinner}] ${name}  ${step}$`)
const contentRows = (tree: unknown): string[] => {
  if (typeof tree !== 'object' || tree === null) return []
  const node = tree as DrawnNode
  // A capsule Button holds every line between its padding columns, each row
  // padded across; the content is what follows the one-cell padding and
  // precedes the rest, including intentionally aligned spaces.
  if (node.type === 'Button') return shownText(node).split('\n').map(row => row.replace(/^ /, '').trimEnd())
  if (node.type === 'Text') return [shownText(node)]
  return (node.children ?? []).flatMap(contentRows)
}
const accountRoom = (capsule: DrawnNode): number => Number(capsule.props?.width) - 2 - 2 * Number(capsule.props?.paddingX ?? 0)
function expectLimitColumns(capsule: DrawnNode, limits: readonly { label: string; percent: number }[]): void {
  const rows = contentRows(capsule)
  const room = accountRoom(capsule)
  const width = Math.floor((room - limits.length + 1) / limits.length)
  const bars = [...(rows[3] ?? '').matchAll(/━+/g)]
  expect(bars.map(bar => cells(bar[0]))).toEqual(limits.map(() => width))
  for (const [index, entry] of limits.entries()) {
    const start = bars[index]!.index
    if (index > 0) expect(start - bars[index - 1]!.index).toBe(width + 1)
    const label = rows[1]!.slice(start, start + width)
    const percent = rows[2]!.slice(start, start + width)
    expect(label.trim()).toBe(entry.label === '5 saat' && width < 6 ? '5s' : entry.label)
    expect(percent.trim()).toBe(`${entry.percent}%`)
    for (const value of [label, percent]) {
      const before = value.length - value.trimStart().length
      const after = value.length - value.trimEnd().length
      expect(Math.abs(before - after)).toBeLessThanOrEqual(1)
    }
  }
  expect(rows.slice(1, 4).every(row => cells(row) <= room)).toBe(true)
}
const lineButtons = (tree: unknown): DrawnNode[] => drawnNodes(tree).filter(node => node.type === 'Button')
// The pane's press targets in drawing order: the capsule Clients where the
// surface runs the capsule module, each with its lines' text and whether a
// click on them acts; elsewhere the Buttons.
type Target = { key: string; label: string; text: string; isPressable: boolean }
async function targetsOf(ui: Pick<Mounted, 'findAll'>): Promise<Target[]> {
  const clients = await ui.findAll({ type: 'Client' })
  if (clients.length > 0) {
    return clients.map(node => {
      const props = node.props.props as CapsuleProps
      const lines = props.lines.map(line => line.map(seg => seg.text).join(''))
      return { key: node.key ?? '', label: lines[0] ?? '', text: lines.join('\n'), isPressable: props.isPressable }
    })
  }
  return (await ui.findAll({ type: 'Button' })).map(node =>
    ({ key: node.key ?? '', label: String(node.props.label), text: node.text, isPressable: true }))
}
const grepCalls = (state: World) => state.calls.filter(call => call.argv[0] === 'grep')
const jobPsCalls = (state: World) => state.calls.filter(call => call.argv[0] === 'ps' && !call.argv.includes('pid='))
const chatPsCalls = (state: World) => state.calls.filter(call => call.argv[0] === 'ps' && call.argv.includes('pid='))
const tailCalls = (state: World) => state.calls.filter(call => call.argv[0] === 'tail')
const headCalls = (state: World) => state.calls.filter(call => call.argv[0] === 'head')
// A transcript the starter search finds: the delegate tool's answer for each
// id, its JSON kept inside an escaped string as a transcript row keeps it.
const mention = (state: World, path: string, ...ids: string[]): void => {
  state.transcripts.set(path, ids.map(id => JSON.stringify({ type: 'user', message: { role: 'user', content: [{
    type: 'tool_result', tool_use_id: `toolu_${id}`, content: [{ type: 'text',
      text: JSON.stringify({ job_id: id, status: 'running', account: 'codex' }, null, 1).replace(/\n */g, ' ') }],
  }] } })).join('\n'))
}
// A tab that only printed the id, as `shiftover jobs` does: no starter.
const printed = (state: World, path: string, ...ids: string[]): void => {
  state.transcripts.set(path, ids.map(id => JSON.stringify({ type: 'user', message: { role: 'user', content: [{
    type: 'tool_result', tool_use_id: 'toolu_bash', content: `ID                    STATUS\n${id}  running` }] } })).join('\n'))
}
// The open chats' transcripts in list order: the waiting one first, then the
// file's order while no transcript has changed.
const OPEN_TRANSCRIPTS = ['/transcripts/1002.jsonl', '/transcripts/1001.jsonl', '/transcripts/1004.jsonl', '/transcripts/1003.jsonl']
const jobIdPattern = (id: string): string => `job_id\\\\?"[[:space:]]*:[[:space:]]*\\\\?"${id}\\\\?"`
const starterSearch = (...ids: string[]): string[] =>
  ['grep', '-o', '-H', '-E', '-s', ...ids.flatMap(id => ['-e', jobIdPattern(id)]), '--', ...OPEN_TRANSCRIPTS]
// The spinner advances every 250 ms.
const spinnerAt = (now: number): string => spinner[Math.floor(now / 250) % spinner.length]!
const codexLine = (type: string): string => JSON.stringify({ type })
const start = async ($: Engine, clock: { settle: () => Promise<void>; advance: (ms: number) => Promise<void> }) => {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await clock.advance(1000)
}
const oneAccount = (limits: RawLimit[]): RawAccount[] => [{ name: 'kadir', email: 'kadir@example.com', dir: `${HOME}/.claude`, limits }]
// An account read without an error, so its refresh target counts.
const readable = (account: RawAccount): RawAccount => ({ ...account, err: undefined })
const limit = (used: number, kind = 'session', model = ''): RawLimit => ({ kind, model, used, resets_at: null })
const idle = (state: World): void => { state.accounts = []; state.jobs = []; state.agents = []; state.sessions = {} }
const cmuxCalls = (state: World, command: string) => state.calls.filter(call => call.argv[1] === command)
const statusCalls = (state: World) => state.calls.filter(call => call.argv[1] === 'status')
const actionCalls = (state: World) => state.calls.filter(call => call.argv[1] === 'select-workspace' || call.argv[1] === 'focus-panel')
const surfaceCalls = (state: World) => state.calls.filter(call => call.argv[1] === 'new-surface')
const TYPED = { command: 'shiftover-panel', args: '', origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 } } as const

// Observe the engine's pending waits and cancellations, using only its clock.
function observedClock(on: On) {
  const waits = new Set<{ kind: 'after' | 'every'; ms: number }>()
  on('clock.after', { ms: /./ }, async (_, e, next) => {
    const wait = { kind: 'after' as const, ms: e.ms }; waits.add(wait)
    const remove = () => { waits.delete(wait) }
    next.signal.addEventListener('abort', remove, { once: true })
    try { return await next(e) } finally { remove(); next.signal.removeEventListener('abort', remove) }
  })
  on('clock.every', { ms: /./ }, async (_, e, next) => {
    const wait = { kind: 'every' as const, ms: e.ms }; waits.add(wait)
    const remove = () => { waits.delete(wait) }
    next.signal.addEventListener('abort', remove, { once: true })
    try { return await next(e) } finally { remove(); next.signal.removeEventListener('abort', remove) }
  })
  const clock = mock.clock(on, { now: NOW })
  return { ...clock, waits: () => [...waits] }
}

// MARK: - Capsule clients

// On the terminal and the desktop the chat and job capsules are Clients the
// capsule module draws. A drawing mounted here reads as one tree, each Client
// replaced by what its module drew, and a press of a capsule or a delegate
// row is a left click on that part; a Button is pressed as before.
type Handle = {
  drawn: (scope?: { in?: string }) => Promise<unknown>
  find: (query: ElementQuery) => Promise<FoundElement | undefined>
  findAll: (query: ElementQuery) => Promise<FoundElement[]>
  press: (target: MountPressTarget) => Promise<unknown>
  pointer?: (event: MountPointerEvent) => Promise<void>
}
const clientKeys = (tree: unknown): string[] =>
  drawnNodes(tree).filter(node => node.type === 'Client').map(node => String(node.props?.key))
async function expanded(ui: Handle, node: unknown): Promise<unknown> {
  if (typeof node !== 'object' || node === null) return node
  const element = node as DrawnNode
  if (element.type === 'Client') return ui.drawn({ in: String(element.props?.key) })
  return element.children === undefined ? node
    : { ...element, children: await Promise.all(element.children.map(child => expanded(ui, child))) }
}
// The row of a capsule's region a part sits on: its border's row is 0.
const rowIn = (capsule: unknown, key: string): number =>
  ((capsule as DrawnNode).children ?? []).findIndex(child => (child as DrawnNode | null)?.props?.key === key) + 1
const click = async (ui: Handle, key: string, y = 1, button: 'left' | 'middle' | 'right' = 'left'): Promise<void> => {
  await ui.pointer!({ type: 'down', x: 2, y, button, in: key })
  await ui.pointer!({ type: 'up', x: 2, y, button, in: key })
}
function withClients<M>(mounted: M): M {
  const raw = mounted as unknown as Handle
  const members: Record<string, unknown> = { surface: (mounted as { surface: string }).surface }
  for (const name of ['drawn', 'find', 'findAll', 'press', 'input', 'select', 'key', 'pointer', 'post', 'advance',
    'resize', 'redraw', 'unmount']) {
    const member = (mounted as Record<string, unknown>)[name]
    if (typeof member === 'function') members[name] = member.bind(mounted)
  }
  const handle = members as unknown as Handle
  return Object.assign(members, {
    drawn: async (scope?: { in?: string }) => scope?.in === undefined ? expanded(handle, await raw.drawn()) : raw.drawn(scope),
    find: async (query: ElementQuery) => {
      const own = await raw.find(query)
      if (own !== undefined || query.in !== undefined) return own
      for (const key of clientKeys(await raw.drawn())) {
        const found = await raw.find({ ...query, in: key })
        if (found !== undefined) return found
      }
      return undefined
    },
    findAll: async (query: ElementQuery) => {
      const own = await raw.findAll(query)
      if (query.in !== undefined) return own
      const inner = await Promise.all(clientKeys(await raw.drawn()).map(key => raw.findAll({ ...query, in: key })))
      return [...own, ...inner.flat()]
    },
    press: async (target: MountPressTarget) => {
      const keys = target.plugin === undefined && target.link === undefined ? clientKeys(await raw.drawn()) : []
      if (keys.includes(target.key)) return click(handle, target.key)
      for (const key of target.key.startsWith('follow:') ? keys : []) {
        const y = rowIn(await raw.drawn({ in: key }), target.key)
        if (y > 0) return click(handle, key, y)
      }
      return raw.press(target)
    },
  }) as unknown as M
}
const mount = <P extends RenderSurface>($: Engine, target: MountTarget<P, 'Pane'>): Promise<Mounted<P, 'Pane'>> =>
  $.ui.mount(target).then(withClients)

test('three compact cards and their round capsules render on every surface without wrapped rows', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); world(on)
  await start($, clock)
  for (const surface of SURFACES) {
    const ui = await mount($,{ ...PANE, surface })
    for (const title of ['Hesaplar ▾', 'Sohbetler', 'İşler']) {
      expect(await rowText(ui, new RegExp(title))).toBeDefined()
      expect((await ui.findAll({ type: 'Text', text: new RegExp(`^ ${title} $`) })).some(node => node.props.weight === 'bold' && node.props.color === 'text')).toBe(true)
    }
    const cards = (await ui.findAll({ type: 'Box' })).filter(box => box.props.borderStyle === 'round' && box.props.width === 42)
    expect(cards).toHaveLength(3)
    expect(cards.every(card => card.props.paddingX === 1)).toBe(true)
    expect(await rowText(ui, /^yeniden giriş gerekli$/)).toBeDefined()
    expect(await rowText(ui, /ads review/)).toMatch(/ads review.*›$/)
    expect(await rowText(ui, /tvOSBrowser/)).toMatch(/tvOSBrowser.*›$/)
    expect(await rowText(ui, /güncellendi|bu oturum|koşuyor|\$0\.01/)).toBeUndefined()
    expect(laidOutRows(await ui.drawn(), 42).filter(row => cells(row) > 42)).toEqual([])
    for (const row of laidOutRows(await ui.drawn(), 42)) {
      expect(cells(row)).toBeLessThanOrEqual(42)
      expect(row).not.toMatch(/[\r\n—]/)
    }
    await ui.unmount()
  }
})

test('the pane starts with Hesaplar, has no Oturum card, and never reads session usage', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  for (const elapsed of [0, 60_000]) {
    await clock.advance(elapsed)
    expect((await paneRows(ui)).join('')).not.toMatch(/Oturum/)
    expect(laidOutRows(await ui.drawn(), 42)[0]).toMatch(/Hesaplar/)
    expect(state.usageCalls).toHaveLength(0)
  }
  await ui.unmount()
})

test('every account and Codex bar uses fixed whole heavy-line cells with severity and subtle colors', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.accounts = oneAccount([limit(5), limit(75, 'weekly_all'), limit(96, 'weekly_scoped', 'Fable')])
  state.jobs = []; state.sessions = {}
  state.codexFiles.set(`${CODEX}/rates.jsonl`, { mtimeMs: 1, text: rateLine(
    { used_percent: 50, window_minutes: 300, resets_at: NOW / 1000 + 3600 },
    { used_percent: 90, window_minutes: 10080, resets_at: NOW / 1000 + 3600 }) })
  await start($, clock)
  for (const width of [32, 42, 58]) {
    const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
    const rows = await paneRows(ui)
    expect(rows.join('')).not.toMatch(/[▏▎▍▌▋▊▉█░▁▇]/)
    const tree = await ui.drawn()
    const account = contentRows(accountCapsule(tree, 'kadir'))[3]!
    const accountBox = accountCapsule(tree, 'kadir')!
    expectLimitColumns(accountBox, [{ label: '5 saat', percent: 5 }, { label: 'hafta', percent: 75 }, { label: 'Fable', percent: 96 }])
    // Codex's 5-hour window resets in an hour: its label is that countdown.
    expectLimitColumns(accountCapsule(tree, 'codex')!, [{ label: '↻ 1sa 0dk', percent: 50 }, { label: 'hafta', percent: 90 }])
    const bars = await ui.findAll({ type: 'Text', text: /^━+$/ })
    expect(bars.length).toBeGreaterThan(5)
    expect(bars.every(bar => ['success', 'warning', 'error', 'subtle'].includes(String(bar.props.color)))).toBe(true)
    for (const color of ['success', 'warning', 'error', 'subtle']) expect(bars.some(bar => bar.props.color === color)).toBe(true)
    await clock.advance(2000)
    expect(contentRows(accountCapsule(await ui.drawn(), 'kadir'))[3]).toBe(account)
    await ui.unmount()
  }
})

test('agents refresh every ten seconds only while placed', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  await start($, clock)
  await clock.advance(9000)
  expect(state.agentCalls).toBe(2)
  state.isPlaced = false
  await clock.advance(30_000)
  expect(state.agentCalls).toBe(2)
})

test('every account has its own round capsule with a name, ordered mini columns, and only critical reset notes', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.accounts = [
    ...oneAccount([
      { ...limit(96, 'weekly_scoped', 'Fable'), resets_at: iso(NOW + 66 * 3_600_000 + 60_000) },
      limit(73, 'weekly_all'), limit(5),
    ]),
    { name: 'aras', email: '', dir: `${HOME}/.claude-aras`, limits: [limit(20)] },
    { name: 'yusa', email: '', dir: `${HOME}/.claude-yusa`, limits: [] },
  ]; state.jobs = []; state.sessions = {}
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  const tree = await ui.drawn()
  for (const name of ['kadir', 'aras', 'yusa', 'codex']) {
    const capsule = accountCapsule(tree, name)!
    expect(capsule).toBeDefined()
    expect(capsule.props).toMatchObject({ borderStyle: 'round', borderColor: 'subtle', paddingX: 1, width: 38 })
    const rows = contentRows(capsule)
    expect(rows[0]).toMatch(new RegExp(`[●○◎] ${name}$`))
    const height = name === 'kadir' ? 5 : name === 'aras' ? 4 : 2
    expect(rows).toHaveLength(height)
    expect(laidOutRows(capsule, 38)).toHaveLength(height + 2)
  }
  const kadir = accountCapsule(tree, 'kadir')!
  const rows = contentRows(kadir)
  expectLimitColumns(kadir, [{ label: '5 saat', percent: 5 }, { label: 'hafta', percent: 73 }, { label: 'Fable', percent: 96 }])
  expect(rows[4]).toBe('Fable 2g 18sa sonra açılır')
  expect((await paneRows(ui)).filter(row => /sonra açılır$/.test(row))).toEqual(['Fable 2g 18sa sonra açılır'])
  const name = drawnNodes(kadir).find(node => node.type === 'Text' && shownText(node) === 'kadir')
  expect(name?.props).toMatchObject({ color: 'text', weight: 'bold' })
  const limitName = drawnNodes(kadir).find(node => node.type === 'Text' && shownText(node) === 'Fable' && node.props?.color === 'error')
  expect(limitName?.props).toMatchObject({ color: 'error', weight: 'bold' })
  const note = drawnNodes(kadir).find(node => node.type === 'Text' && shownText(node) === ' 2g 18sa sonra açılır')
  expect(note?.props?.dimColor).toBe(true)
  await ui.unmount()
})

test('critical notes compact reset time before truncating and never overflow narrow capsules', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.accounts = [
    ...oneAccount([{ ...limit(95), resets_at: iso(NOW + 300 * 60_000) }]),
    { name: 'aras', email: '', dir: `${HOME}/.claude-aras`, limits: [
      { ...limit(96), resets_at: iso(NOW + 66 * 3_600_000 + 60_000) },
    ] },
    { name: 'yusa', email: '', dir: `${HOME}/.claude-yusa`, limits: [
      { ...limit(97, 'weekly_scoped', 'Fable'), resets_at: iso(NOW + 66 * 3_600_000 + 60_000) },
    ] },
  ]; state.jobs = []; state.sessions = {}
  await start($, clock)
  for (const width of [32, 42, 58]) {
    const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
    const tree = await ui.drawn()
    for (const [name, note] of [
      ['kadir', width === 32 ? '5 saat 4sa sonra açılır' : '5 saat 4sa 59dk sonra açılır'],
      ['aras', width === 32 ? '5 saat 2g18sa sonra açı…' : '5 saat 2g 18sa sonra açılır'],
      ['yusa', width === 32 ? 'Fable 2g18sa sonra açıl…' : 'Fable 2g 18sa sonra açılır'],
    ] as const) {
      const capsule = accountCapsule(tree, name)!
      const rows = contentRows(capsule)
      expect(rows).toHaveLength(5)
      expect(rows[4]).toBe(note)
      expect(rows[4]).not.toMatch(/[\r\n—]/)
      const room = Number(capsule.props?.width) - 2 - 2 * Number(capsule.props?.paddingX ?? 0)
      expect(cells(note)).toBeLessThanOrEqual(room)
      expect(laidOutRows(capsule, width - 4)).toHaveLength(7)
    }
    expect(laidOutRows(tree, width).filter(row => cells(row) > width)).toEqual([])
    await ui.unmount()
  }
})

test('several critical limits use one note after the bars for the highest usage', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.accounts = oneAccount(['session', 'weekly_all', 'weekly_scoped'].map((kind, index) => ({
    ...limit(90 + index, kind, kind === 'weekly_scoped' ? 'Fable' : ''), resets_at: iso(NOW + 67 * 3_600_000 + 60_000),
  }))); state.jobs = []
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  const capsule = accountCapsule(await ui.drawn(), 'kadir')!
  const rows = contentRows(capsule)
  expect(rows).toHaveLength(5)
  expect(rows[4]).toBe('Fable 2g 19sa sonra açılır')
  expect((await paneRows(ui)).filter(row => /sonra açılır$/.test(row))).toHaveLength(1)
  expect((await ui.findAll({ type: 'Text', text: /^Fable$/ }))
    .some(name => name.props.color === 'error' && name.props.weight === 'bold')).toBe(true)
  expect(laidOutRows(capsule, 38)).toHaveLength(7)
  await ui.unmount()
})

test('percent severity uses success below 75, warning through 89, and bold error at 90', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.accounts = oneAccount([limit(74), limit(89, 'weekly_all'), limit(90, 'weekly_scoped', 'Fable')]); state.jobs = []
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  for (const [percent, color] of [[74, 'success'], [89, 'warning'], [90, 'error']] as const) {
    const node = await ui.find({ type: 'Text', text: new RegExp(`^ *${percent}%$`) })
    expect(node?.props.color).toBe(color)
    expect(node?.props.weight).toBe('bold')
  }
  expect((await ui.findAll({ type: 'Text', text: /^━+$/ })).some(node => node.props.color === 'subtle')).toBe(true)
  await ui.unmount()
})

test('current account follows CLAUDE_CONFIG_DIR and warning errors replace only the second capsule line', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); world(on, { CLAUDE_CONFIG_DIR: `${HOME}/.claude-aras/`, SHIFTOVER_ACCOUNT: 'kadir' })
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  const tree = await ui.drawn()
  const kadir = accountCapsule(tree, 'kadir')!
  expect(contentRows(kadir)).toEqual(['○ kadir', 'yeniden giriş gerekli'])
  expect(drawnNodes(kadir).some(node => node.type === 'Text' && shownText(node) === 'yeniden giriş gerekli' && node.props?.color === 'warning')).toBe(true)
  expect(shownText(kadir)).not.toMatch(/━|%|sonra açılır/)
  const aras = accountCapsule(tree, 'aras')!
  expect(contentRows(aras)[0]).toBe('● aras')
  expect(drawnNodes(aras).some(node => node.type === 'Text' && shownText(node) === 'aras' && node.props?.color === 'text' && node.props?.weight === 'bold')).toBe(true)
  expect(drawnNodes(kadir).some(node => node.type === 'Text' && shownText(node) === 'kadir' && node.props?.weight === 'bold')).toBe(false)
  expect((await ui.find({ type: 'Text', text: /^● ?$/ }))?.props.color).toBe('claude')
  await ui.unmount()
})

test('Hesaplar shows only existing limits with their model names and never uses dash placeholders', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.accounts = [
    ...oneAccount([limit(12, 'weekly_scoped', 'Sonnet')]),
    { name: 'aras', email: '', dir: `${HOME}/.claude-aras`, err: 'HTTP 401 (token expired)', limits: [limit(0), limit(43, 'weekly_scoped', 'Fable')] },
    { name: 'yusa', email: '', dir: `${HOME}/.claude-yusa`, err: 'şu an okunamıyor' },
  ]; state.jobs = []; state.sessions = {}
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  const tree = await ui.drawn()
  expectLimitColumns(accountCapsule(tree, 'kadir')!, [{ label: 'Sonnet', percent: 12 }])
  expectLimitColumns(accountCapsule(tree, 'aras')!, [{ label: '5 saat', percent: 0 }, { label: 'Fable', percent: 43 }])
  const yusa = accountCapsule(tree, 'yusa')!
  expect(contentRows(yusa)).toEqual(['○ yusa', 'şu an okunamıyor'])
  expect(drawnNodes(yusa).some(node => node.type === 'Text' && shownText(node) === 'şu an okunamıyor' && node.props?.color === 'warning')).toBe(true)
  const card = accountsCard(tree)!
  expect(card).toBeDefined()
  expect(shownText(card)).not.toContain('–')
  expect(shownText(accountCapsule(tree, 'kadir'))).not.toMatch(/5 saat|hafta|Fable/)
  await ui.unmount()
})

test('each capsule centers labels and complete percentages over equal columns at 32, 42, and 58 cells', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.accounts = [
    ...oneAccount([limit(5), limit(73, 'weekly_all'), limit(100, 'weekly_scoped', 'Fable')]),
    { name: 'aras', email: '', dir: `${HOME}/.claude-aras`, limits: [limit(100), limit(40, 'weekly_scoped', 'Fable')] },
  ]; state.jobs = []; state.sessions = {}
  await start($, clock)
  for (const width of [32, 42, 58]) {
    const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
    const tree = await ui.drawn()
    const rows = laidOutRows(tree, width)
    expect(rows.filter(row => /5 saat.*hafta.*Fable/.test(row))).toHaveLength(1)
    const kadir = accountCapsule(tree, 'kadir')!
    const aras = accountCapsule(tree, 'aras')!
    expectLimitColumns(kadir, [{ label: '5 saat', percent: 5 }, { label: 'hafta', percent: 73 }, { label: 'Fable', percent: 100 }])
    expectLimitColumns(aras, [{ label: '5 saat', percent: 100 }, { label: 'Fable', percent: 40 }])
    for (const capsule of [kadir, aras]) {
      const labels = drawnNodes(capsule).filter(node => node.type === 'Text' && /^(5 saat|5s|hafta|Fable)$/.test(shownText(node)) && node.props?.color !== 'error')
      expect(labels.every(node => node.props?.dimColor === true)).toBe(true)
      expect(capsule.props?.paddingX).toBe(1)
    }
    expect(rows.filter(row => cells(row) > width)).toEqual([])
    expect(rows.every(row => !/[\r\n—]/.test(row))).toBe(true)
    await ui.unmount()
  }
})

test('the approved 58-column account fixture has the critical Fable note and no shared header', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.accounts = [
    ...oneAccount([limit(0), limit(74, 'weekly_all'), {
      ...limit(96, 'weekly_scoped', 'Fable'), resets_at: iso(NOW + 54 * 3_600_000 + 60_000),
    }]),
    { name: 'aras', email: '', dir: `${HOME}/.claude-aras`, limits: [limit(0), limit(43, 'weekly_scoped', 'Fable')] },
    { name: 'yusa', email: '', dir: `${HOME}/.claude-yusa`, err: 'HTTP 429' },
  ]; state.jobs = []; state.sessions = {}
  state.codexFiles.set(`${CODEX}/weekly.jsonl`, { mtimeMs: 1, text: rateLine({ used_percent: 6, window_minutes: 10080, resets_at: NOW / 1000 + 3600 }) })
  await start($, clock)
  const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: 58 }, surface: 'terminal' })
  const tree = await ui.drawn()
  const card = accountsCard(tree)!
  expect(card).toBeDefined()
  expectLimitColumns(accountCapsule(tree, 'kadir')!, [{ label: '5 saat', percent: 0 }, { label: 'hafta', percent: 74 }, { label: 'Fable', percent: 96 }])
  expectLimitColumns(accountCapsule(tree, 'aras')!, [{ label: '5 saat', percent: 0 }, { label: 'Fable', percent: 43 }])
  expect(contentRows(accountCapsule(tree, 'kadir'))[4]).toBe('Fable 2g 6sa sonra açılır')
  expect(contentRows(accountCapsule(tree, 'yusa'))).toEqual(['○ yusa', 'şu an okunamıyor'])
  expectLimitColumns(accountCapsule(tree, 'codex')!, [{ label: 'hafta', percent: 6 }])
  const preview = laidOutRows(card, 58)
  expect(preview.every(row => cells(row) === 58)).toBe(true)
  expect(preview[1]).toMatch(/╭━*|╭─/)
  expect(shownText(card)).not.toMatch(/–|—|[\r\n]/)
  await ui.unmount()
})

test('wide accounts align three inline cells, leave missing limits blank, and indent the critical note', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.accounts = [
    ...oneAccount([limit(2), limit(75, 'weekly_all'), {
      ...limit(96, 'weekly_scoped', 'Fable'), resets_at: iso(NOW + 52 * 3_600_000 + 60_000),
    }]),
    { name: 'aras', email: '', dir: `${HOME}/.claude-aras`, limits: [limit(10), limit(45, 'weekly_scoped', 'Fable')] },
    { name: 'yusa', email: '', dir: `${HOME}/.claude-yusa`, err: 'HTTP 429' },
  ]; state.jobs = []; state.sessions = {}
  state.codexFiles.set(`${CODEX}/weekly.jsonl`, { mtimeMs: 1, text: rateLine({ used_percent: 1, window_minutes: 10080, resets_at: NOW / 1000 + 3600 }) })
  await start($, clock)
  for (const width of [76, 96]) {
    for (const surface of SURFACES) {
      const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface })
      const tree = await ui.drawn()
      const kadir = accountCapsule(tree, 'kadir')!
      const room = accountRoom(kadir)
      const cellWidth = Math.floor((room - 9 - 4) / 3)
      const starts = [9, 9 + cellWidth + 2, 9 + 2 * (cellWidth + 2)]
      const expected = [
        ['kadir', '● kadir  ', [['5s', 2], ['hafta', 75], ['Fable', 96]]],
        ['aras', '○ aras   ', [['5s', 10], null, ['Fable', 45]]],
        ['codex', '◎ codex  ', [null, ['hafta', 1], null]],
      ] as const
      for (const [name, prefix, limits] of expected) {
        const capsule = accountCapsule(tree, name)!
        const rows = contentRows(capsule)
        expect(rows).toHaveLength(name === 'kadir' ? 2 : 1)
        expect(rows[0]!.slice(0, 9)).toBe(prefix)
        for (const [index, entry] of limits.entries()) {
          const cell = rows[0]!.slice(starts[index], starts[index]! + cellWidth)
          if (entry === null) expect(cell).toBe(' '.repeat(cellWidth))
          else {
            const [label, used] = entry
            const barWidth = cellWidth - label.length - 6
            expect(barWidth).toBeGreaterThanOrEqual(6)
            expect(cell).toBe(`${label} ${'━'.repeat(barWidth)} ${`${used}%`.padStart(4)}`)
          }
        }
      }
      expect(contentRows(kadir)[1]).toBe('  Fable 2g 4sa sonra açılır')
      const yusa = accountCapsule(tree, 'yusa')!
      expect(contentRows(yusa)).toEqual(['○ yusa   şu an okunamıyor'])
      expect(drawnNodes(yusa).some(node => node.type === 'Text' && shownText(node) === 'şu an okunamıyor' && node.props?.color === 'warning')).toBe(true)
      for (const color of ['success', 'warning', 'error', 'subtle']) expect(
        drawnNodes(accountsCard(tree)).some(node => node.type === 'Text' && /^━+$/.test(shownText(node)) && node.props?.color === color)).toBe(true)
      expect(shownText(accountsCard(tree))).not.toMatch(/–|—|[▏▎▍▌▋▊▉█░▁▇]/)
      expect(laidOutRows(tree, width).every(row => cells(row) <= width)).toBe(true)
      await ui.unmount()
    }
  }
  const narrow = await mount($,{ ...PANE, surface: 'terminal' })
  const tree = await narrow.drawn()
  expectLimitColumns(accountCapsule(tree, 'kadir')!, [{ label: '5 saat', percent: 2 }, { label: 'hafta', percent: 75 }, { label: 'Fable', percent: 96 }])
  expectLimitColumns(accountCapsule(tree, 'aras')!, [{ label: '5 saat', percent: 10 }, { label: 'Fable', percent: 45 }])
  expectLimitColumns(accountCapsule(tree, 'codex')!, [{ label: 'hafta', percent: 1 }])
  expect(contentRows(accountCapsule(tree, 'kadir'))[4]).toBe('Fable 2g 4sa sonra açılır')
  expect(contentRows(accountCapsule(tree, 'yusa'))).toEqual(['○ yusa', 'şu an okunamıyor'])
  await narrow.unmount()
})

const rateLine = (primary: { used_percent: number; window_minutes: number; resets_at: number }, secondary?: typeof primary): string =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary, secondary } } })

// MARK: - 5-hour countdowns

const countdownAccounts = (sessionAt: number | null): RawAccount[] => [
  ...oneAccount([{ ...limit(12), resets_at: sessionAt === null ? null : iso(NOW + sessionAt) },
    limit(40, 'weekly_all'), limit(60, 'weekly_scoped', 'Fable')]),
  { name: 'aras', email: '', dir: '/aras', limits: [limit(20), limit(30, 'weekly_all'), limit(35, 'weekly_scoped', 'Fable')] },
  { name: 'yusa', email: '', dir: '/yusa', limits: [{ ...limit(25), resets_at: iso(NOW - 60_000) },
    limit(45, 'weekly_all'), limit(55, 'weekly_scoped', 'Fable')] },
]

test('5-hour columns show their reset countdown with an arrow where it fits, else bare, else truncated', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  state.accounts = countdownAccounts(108 * 60_000)
  state.codexFiles.set(`${CODEX}/rates.jsonl`, { mtimeMs: 1, text: rateLine(
    { used_percent: 15, window_minutes: 300, resets_at: NOW / 1000 + 35 * 60 },
    { used_percent: 5, window_minutes: 10080, resets_at: NOW / 1000 + 50 * 3600 }) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  for (const [width, label] of [[42, '↻ 1sa 48dk'], [38, '1sa 48dk'], [32, '1sa 48…']] as const) {
    const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
    const tree = await ui.drawn()
    const kadir = accountCapsule(tree, 'kadir')!
    expectLimitColumns(kadir, [{ label, percent: 12 }, { label: 'hafta', percent: 40 }, { label: 'Fable', percent: 60 }])
    expect(drawnNodes(kadir).find(node => node.type === 'Text' && shownText(node) === label)?.props).toMatchObject({ dimColor: true })
    // A missing or passed reset keeps the window's name; a passed one has
    // started over at 0%.
    expectLimitColumns(accountCapsule(tree, 'aras')!, [{ label: '5 saat', percent: 20 }, { label: 'hafta', percent: 30 }, { label: 'Fable', percent: 35 }])
    expectLimitColumns(accountCapsule(tree, 'yusa')!, [{ label: '5 saat', percent: 0 }, { label: 'hafta', percent: 45 }, { label: 'Fable', percent: 55 }])
    expectLimitColumns(accountCapsule(tree, 'codex')!, [{ label: '↻ 35dk', percent: 15 }, { label: 'hafta', percent: 5 }])
    expect(laidOutRows(tree, width).every(row => cells(row) <= width)).toBe(true)
    await ui.unmount()
  }
  // Too narrow for the name, a fallback still shortens to 5s.
  const tiny = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: 24 }, surface: 'terminal' })
  expect(contentRows(accountCapsule(await tiny.drawn(), 'aras'))[1]!.trim()).toMatch(/^5s /)
  await tiny.unmount()
})

test('wide inline cells give 5-hour countdowns one shared slot so bars line up, bare when the arrow does not fit', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  state.accounts = [
    ...oneAccount([{ ...limit(12), resets_at: iso(NOW + 108 * 60_000) }, limit(40, 'weekly_all'), limit(60, 'weekly_scoped', 'Fable')]),
    { name: 'aras', email: '', dir: '/aras', limits: [{ ...limit(30), resets_at: iso(NOW + 35 * 60_000) }, limit(45, 'weekly_scoped', 'Fable')] },
    { name: 'yusa', email: '', dir: '/yusa', limits: [{ ...limit(8), resets_at: iso(NOW - 60_000) }, limit(20, 'weekly_all')] },
  ]
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  for (const [width, labels] of [
    [96, { kadir: '↻ 1sa 48dk', aras: '↻ 35dk', yusa: '5s' }], [86, { kadir: '1sa 48dk', aras: '35dk', yusa: '5s' }],
  ] as const) {
    const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
    const tree = await ui.drawn()
    const cellWidth = Math.floor((accountRoom(accountCapsule(tree, 'kadir')!) - 9 - 4) / 3)
    const starts = [9, 9 + cellWidth + 2, 9 + 2 * (cellWidth + 2)]
    const slot = labels.kadir.length
    const cell = (label: string, used: number, size = label.length) =>
      `${label.padEnd(size)} ${'━'.repeat(cellWidth - size - 6)} ${`${used}%`.padStart(4)}`
    // yusa's 5-hour window reset a minute ago: it has started over at 0%.
    for (const [name, used, rest] of [
      ['kadir', 12, [cell('hafta', 40), cell('Fable', 60)]], ['aras', 30, [' '.repeat(cellWidth), cell('Fable', 45)]],
      ['yusa', 0, [cell('hafta', 20), ' '.repeat(cellWidth)]],
    ] as const) {
      const rows = contentRows(accountCapsule(tree, name))
      expect(rows).toHaveLength(1)
      expect(starts.map(at => rows[0]!.slice(at, at + cellWidth))).toEqual([cell(labels[name], used, slot), ...rest])
      // Every session bar starts in the same column.
      expect(rows[0]!.indexOf('━')).toBe(9 + slot + 1)
    }
    expect(laidOutRows(tree, width).every(row => cells(row) <= width)).toBe(true)
    await ui.unmount()
  }
})

test('at 76 columns a 5-hour countdown under an hour stays inline and a longer one falls back to columns', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  state.accounts = countdownAccounts(59 * 60_000 + 30_000).slice(0, 2)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: 76 }, surface: 'terminal' })
  let tree = await ui.drawn()
  const room = accountRoom(accountCapsule(tree, 'kadir')!)
  expect(Math.floor((room - 9 - 4) / 3)).toBe(18)
  expect(contentRows(accountCapsule(tree, 'kadir'))).toEqual([
    `● kadir  ↻ 59dk ${'━'.repeat(6)}  12%  hafta ${'━'.repeat(7)}  40%  Fable ${'━'.repeat(7)}  60%`])
  expect(contentRows(accountCapsule(tree, 'aras'))[0]!.slice(9, 27)).toBe(`5s     ${'━'.repeat(6)}  20%`)
  state.accounts = countdownAccounts(108 * 60_000 + 60_000).slice(0, 2)
  await clock.advance(60_000)
  tree = await ui.drawn()
  expect(contentRows(accountCapsule(tree, 'kadir'))).toHaveLength(4)
  expectLimitColumns(accountCapsule(tree, 'kadir')!, [{ label: '↻ 1sa 48dk', percent: 12 }, { label: 'hafta', percent: 40 }, { label: 'Fable', percent: 60 }])
  expectLimitColumns(accountCapsule(tree, 'aras')!, [{ label: '5 saat', percent: 20 }, { label: 'hafta', percent: 30 }, { label: 'Fable', percent: 35 }])
  expect(laidOutRows(tree, 76).every(row => cells(row) <= 76)).toBe(true)
  await ui.unmount()
})

test('a 5-hour countdown changes on the minute boundary with no timer of its own', async ($, on) => {
  const clock = observedClock(on); const redraws: number[] = []
  on('ui.invalidate', { event: 'ui.render' }, async (_, e, next) => { redraws.push(clock.now()); return next(e) })
  const state = world(on); idle(state)
  state.accounts = oneAccount([{ ...limit(10), resets_at: iso(NOW + 35 * 60_000) }])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  await clock.advance(67); redraws.length = 0
  const label = async () => contentRows(accountCapsule(await ui.drawn(), 'kadir'))[1]?.trim()
  expect(await label()).toBe('↻ 35dk')
  expect(clock.waits().filter(wait => wait.kind === 'after')).toEqual([{ kind: 'after', ms: 59_933 }])
  expect(clock.waits().filter(wait => wait.ms < 10_000)).toHaveLength(0)
  await clock.advance(59_932)
  expect(redraws).toHaveLength(0)
  expect(await label()).toBe('↻ 35dk')
  await clock.advance(101)
  expect(await label()).toBe('↻ 34dk')
  expect(clock.waits().filter(wait => wait.ms < 10_000)).toHaveLength(0)
  await ui.unmount()
})

test('Codex reads the newest JSONL last rate_limits and maps primary 10080 to the weekly column', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.accounts = []; state.jobs = []
  const window = (used_percent: number, window_minutes: number) => ({ used_percent, window_minutes, resets_at: NOW / 1000 + 3600 })
  state.codexFiles.set(`${CODEX}/older.jsonl`, { mtimeMs: 1, text: rateLine(window(99, 300), window(99, 10080)) })
  state.codexFiles.set(`${CODEX}/newer.jsonl`, { mtimeMs: 2, text: [rateLine(window(1, 300), window(2, 10080)),
    '{a partial write', rateLine(window(77, 10080), window(16, 300)), JSON.stringify({ type: 'event_msg', payload: { type: 'message' } })].join('\n') })
  await start($, clock)
  const snapshot = state.snapshots.get('codex')
  expect(snapshot).toMatchObject({ shape: 'codex-1', value: { limits: [
    { kind: 'weekly_all', used: 77 }, { kind: 'session', used: 16 },
  ] } })
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expectLimitColumns(accountCapsule(await ui.drawn(), 'codex')!, [{ label: '↻ 1sa 0dk', percent: 16 }, { label: 'hafta', percent: 77 }])
  expect(state.reads.filter(path => path === `read:${CODEX}/older.jsonl`)).toHaveLength(0)
  await ui.unmount()
})

test('Codex renders only hafta for a 10080-minute primary window and never adds a model column', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.accounts = []; state.jobs = []; state.sessions = {}
  state.codexFiles.set(`${CODEX}/weekly.jsonl`, { mtimeMs: 1, text: rateLine({ used_percent: 6, window_minutes: 10080, resets_at: NOW / 1000 + 3600 }) })
  await start($, clock)
  for (const width of [32, 42, 58]) {
    const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
    const capsule = accountCapsule(await ui.drawn(), 'codex')!
    expectLimitColumns(capsule, [{ label: 'hafta', percent: 6 }])
    expect(contentRows(capsule)).toHaveLength(4)
    expect(shownText(capsule)).not.toMatch(/5 saat|5s|Fable|–/)
    expect(laidOutRows(await ui.drawn(), width).every(row => cells(row) <= width)).toBe(true)
    await ui.unmount()
  }
})

test('Codex labels other readable windows by their rounded day count', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.accounts = []; state.jobs = []; state.sessions = {}
  state.codexFiles.set(`${CODEX}/custom.jsonl`, { mtimeMs: 1, text: rateLine({ used_percent: 24, window_minutes: 2880, resets_at: NOW / 1000 + 3600 }) })
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expectLimitColumns(accountCapsule(await ui.drawn(), 'codex')!, [{ label: '2 gün', percent: 24 }])
  await ui.unmount()
})

test('Codex searches at most seven dated folders and shows a warning instead of unreadable limits', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.accounts = []; state.jobs = []
  await start($, clock)
  const dirs = state.reads.filter(path => path.startsWith(`list:${HOME}/.codex/sessions/`))
  expect(dirs).toHaveLength(7)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  const capsule = accountCapsule(await ui.drawn(), 'codex')!
  expect(contentRows(capsule)).toEqual(['◎ codex', 'şu an okunamıyor'])
  expect(drawnNodes(capsule).some(node => node.type === 'Text' && shownText(node) === 'şu an okunamıyor' && node.props?.color === 'warning')).toBe(true)
  await ui.unmount()
})

test('accounts and Codex refresh once a minute and preserve successful data after a read failure', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  await start($, clock)
  const firstCodexLists = state.reads.filter(path => path.startsWith(`list:${HOME}/.codex/`)).length
  await clock.advance(49_000)
  expect(statusCalls(state)).toHaveLength(1)
  expect(state.reads.filter(path => path.startsWith(`list:${HOME}/.codex/`))).toHaveLength(firstCodexLists)
  state.isShiftoverDown = true; state.isJobsDown = true
  await clock.advance(10_000)
  expect(statusCalls(state)).toHaveLength(2)
  expect(state.reads.filter(path => path.startsWith(`list:${HOME}/.codex/`))).toHaveLength(firstCodexLists * 2)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expect(contentRows(accountCapsule(await ui.drawn(), 'aras'))[2]).toMatch(/10%.*75%.*92%/)
  // The kept 5-hour window still counts down: 202 minutes, one gone.
  expect(contentRows(accountCapsule(await ui.drawn(), 'aras'))[1]?.trim()).toMatch(/^↻ 3sa 21dk /)
  expect(await rowText(ui, /tvOSBrowser/)).toBeDefined()
  await ui.unmount()
})

test('session records are filtered by open panel and alive PID, and use cmux titles and config accounts', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  await start($, clock)
  const chats = state.snapshots.get('chats')
  // Waiting first; no transcript has changed yet, so the rest keep the file's order.
  expect(chats).toMatchObject({ shape: 'chats-2', value: { list: [
    { id: 'waiting-session', title: 'Needs approval', status: 'waiting', account: 'kadir' },
    { id: 'current-session', title: 'Current tab', isCurrent: true },
    { id: 'idle-session', title: 'Idle tab', account: 'aras' },
    { id: 'runner-session', title: 'Analysis tab', status: 'running' },
  ] } })
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expect(await rowText(ui, /Dead process|Closed tab/)).toBeUndefined()
  expect(await rowText(ui, /Current tab/)).not.toMatch(/›/)
  expect(await rowText(ui, /^bu sekme$/)).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'chat:current-session' })).toBeUndefined()
  expect(cmuxCalls(state, 'list-workspaces')).toHaveLength(1)
  expect(cmuxCalls(state, 'list-panels')).toHaveLength(1)
  // The parentless running delegate's starter search covers open tabs only.
  expect(grepCalls(state).map(call => call.argv)).toEqual([starterSearch(RUNNING.id)])
  await ui.unmount()
})

test('each chat has a self-contained three-line round capsule, with an arrow only when pressable', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); world(on)
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  const tree = await ui.drawn()
  const expected = [
    ['Needs approval', 'kadir', 'cevap bekliyor', true],
    ['Analysis tab', 'kadir', 'çalışıyor', true],
    ['Current tab', 'kadir', 'bu sekme', false],
    ['Idle tab', 'aras', 'boşta', true],
  ] as const
  for (const [title, metadata, status, pressable] of expected) {
    const capsule = capsuleFor(tree, title)!
    expect(capsule).toBeDefined()
    expect(capsule.props).toMatchObject({ width: 38, flexDirection: 'column' })
    const rows = laidOutRows(capsule, 38)
    expect(rows).toHaveLength(5)
    expect(rows[1]).toMatch(new RegExp(title))
    expect(rows[1]?.includes('›')).toBe(pressable)
    expect(rows[2]).toMatch(new RegExp(metadata))
    expect(rows[3]).toMatch(new RegExp(status))
    expect(rows[0]).toBe(`╭${'─'.repeat(36)}╮`)
    expect(rows[4]).toBe(`╰${'─'.repeat(36)}╯`)
    for (const text of [metadata, status]) expect(drawnNodes(capsule).some(node =>
      node.type === 'Text' && shownText(node) === text && node.props?.dimColor === true)).toBe(true)
    const titleNode = await ui.find({ type: 'Text', text: new RegExp(`^${title}$`) })
    expect(titleNode?.props.color).toBe('text')
    expect(titleNode?.props.weight).toBe(title === 'Needs approval' ? 'bold' : undefined)
  }
  const rows = laidOutRows(tree, 42)
  const first = rows.findIndex(row => /Needs approval/.test(row))
  const second = rows.findIndex(row => /Current tab/.test(row))
  const third = rows.findIndex(row => /Idle tab/.test(row))
  expect(second - first).toBe(5)
  expect(third - second).toBe(5)
  expect(await rowText(ui, /sohbet daha/)).toBeUndefined()
  expect(await rowText(ui, /Idle tab/)).toBeDefined()
  await ui.unmount()
})

test('model IDs format families, version digits, context suffixes and date stamps', async () => {
  for (const [id, display] of [
    ['claude-opus-5-5', 'Opus 5.5'], ['claude-fable-5-1', 'Fable 5.1'],
    ['claude-sonnet-5-5[1m]', 'Sonnet 5.5'], ['claude-haiku-5-5-20261001', 'Haiku 5.5'],
    ['claude-unknown-6-2-20261001[1m]', 'Unknown 6.2'], ['claude-opus-5-5[1m]-20261001', 'Opus 5.5'],
    ['claude-newfamily-7', 'Newfamily 7'], ['', ''],
  ]) expect(formatModelId(id!)).toBe(display)
})

const assistantLine = (model: string, effort?: string): string => JSON.stringify({ type: 'assistant', message: { model }, effort })

test('transcript tails scan backwards, ignore partial lines and take model and effort from the last assistant', async () => {
  const earlier = assistantLine('claude-fable-5-1', 'low')
  const last = assistantLine('claude-opus-5-5', 'xhigh')
  expect(parseTranscriptTail([earlier, '{broken', last, JSON.stringify({ type: 'user' }), '{partial'].join('\n')))
    .toEqual({ model: 'claude-opus-5-5', effort: 'xhigh' })
  expect(parseTranscriptTail([last, assistantLine('claude-haiku-5-5')].join('\n')))
    .toEqual({ model: 'claude-haiku-5-5', effort: '' })
  expect(parseTranscriptTail(`truncated first line\n${earlier}\n${last}\n`, true))
    .toEqual({ model: 'claude-opus-5-5', effort: 'xhigh' })
  expect(parseTranscriptTail(last, true)).toEqual({ model: '', effort: '' })
  expect(parseTranscriptTail('not JSON\n{"type":"user"}\n')).toEqual({ model: '', effort: '' })
})

for (const [account, model, effort, expected] of [
  ['kadir', 'claude-opus-5-5', 'xhigh', 'kadir · Opus 5.5 · xhigh'],
  ['kadir', 'claude-fable-5-1', '', 'kadir · Fable 5.1'],
  ['kadir', '', 'max', 'kadir · max'],
  ['', 'claude-sonnet-5-5', 'high', 'Sonnet 5.5 · high'],
  ['', 'claude-haiku-5-5', '', 'Haiku 5.5'], ['', '', 'medium', 'medium'], ['', '', '', ''],
] as const) {
  test(`chat metadata omits missing parts cleanly: ${expected || 'all unknown'}`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
    state.sessions = { metadata: rawSession(IDLE, 1004, { launchCommand: { environment: {
      CLAUDE_CONFIG_DIR: account ? `${HOME}/.claude` : `${HOME}/.unmapped`,
    } } }) }
    state.chatFiles.set('/transcripts/1004.jsonl', { mtimeMs: 1, text: assistantLine(model, effort) })
    await start($, clock)
    const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: 76 }, surface: 'terminal' })
    const capsule = capsuleFor(await ui.drawn(), 'Idle tab')!
    const rows = laidOutRows(capsule, 72)
    expect(rows).toHaveLength(5)
    expect(rows[2]!.slice(2, -2).trimEnd()).toBe(expected)
    expect(rows[2]).not.toMatch(/–| ·  · | · +│/)
    expect(drawnNodes(capsule).some(node => node.type === 'Text' && shownText(node) === (expected || ' ') && node.props?.dimColor === true)).toBe(true)
    await ui.unmount()
  })
}

test('chat metadata reads only transcript tails, caches size and mtime, and sees model switches without a cmux refresh', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  state.sessions = { metadata: rawSession(IDLE, 1004) }
  const path = '/transcripts/1004.jsonl'
  const cachePath = `${HOME}/.cache/shiftover/sessions/metadata.json`
  const file = { mtimeMs: 1, text: `${'x'.repeat(300_000)}\n${assistantLine('claude-opus-5-5', 'xhigh')}\n` }
  state.chatFiles.set(path, file)
  state.chatFiles.set(cachePath, { mtimeMs: 1, text: JSON.stringify({ model: { id: 'claude-fable-5-1', display_name: 'Fable 5.1' } }) })
  await start($, clock)
  const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: 76 }, surface: 'terminal' })
  expect(await rowText(ui, /^kadir · Fable 5.1 · xhigh$/)).toBeDefined()
  const tails = () => state.calls.filter(call => call.argv[0] === 'tail')
  expect(tails().map(call => call.argv)).toEqual([['tail', '-c', '262144', '--', path]])
  expect(state.reads).not.toContain(`read:${path}`)
  state.chatFiles.set(cachePath, { mtimeMs: 2, text: JSON.stringify({ model: { id: 'claude-opus-5-5', display_name: 'Opus switched' } }) })
  await clock.advance(9000)
  expect(await rowText(ui, /^kadir · Opus switched · xhigh$/)).toBeDefined()
  expect(tails()).toHaveLength(1)
  expect(cmuxCalls(state, 'list-workspaces')).toHaveLength(1)
  file.text = file.text.replace('"xhigh"', '"high"') + ' '
  file.mtimeMs += 1
  await clock.advance(10_000)
  expect(await rowText(ui, /^kadir · Opus switched · high$/)).toBeDefined()
  expect(tails()).toHaveLength(2)
  file.text += `\n${assistantLine('claude-haiku-5-5', 'low')}`
  state.chatFiles.delete(cachePath)
  await clock.advance(10_000)
  expect(await rowText(ui, /^kadir · Haiku 5.5 · low$/)).toBeDefined()
  expect(tails()).toHaveLength(3)
  state.chatFiles.delete(path)
  await clock.advance(10_000)
  expect(contentRows(capsuleFor(await ui.drawn(), 'Idle tab')).includes('kadir')).toBe(true)
  expect(tails()).toHaveLength(3)
  await ui.unmount()
})

test('a clickable capsule is one target holding every line inside its border: the capsule module where the surface runs one, else one Button', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  mention(state, '/transcripts/1003.jsonl', RUNNING.id)
  await start($, clock)
  for (const surface of SURFACES) {
    const ui = await mount($,{ ...PANE, surface })
    const hasClient = surface === 'terminal' || surface === 'desktop'
    for (const [key, title, height] of [
      ['chat:waiting-session', 'Needs approval', 5], [`job:${RUNNING.id}`, 'ads review', 4],
    ] as const) {
      const capsule = capsuleFor(await ui.drawn(), title)!
      if (hasClient) {
        // A region the capsule's size, keyed as the capsule; its module draws
        // the border and every line, and no Button.
        const client = (await ui.find({ type: 'Client', key }))!
        // The module's path as the engine resolved it, under the plugin folder.
        expect(client.props).toMatchObject({ module: 'hooks/capsule.tsx', width: 38, height })
        expect(client.props.props).toMatchObject({ key, width: 38, padding: 1, isPressable: true })
        expect(lineButtons(capsule)).toEqual([])
        expect(capsule.props).toMatchObject({ key: `capsule:${key}`, borderStyle: 'round', paddingX: 1 })
        const lines = (capsule.children ?? []) as DrawnNode[]
        expect(lines).toHaveLength(height - 2)
        expect(lines.every(node => node.type === 'Text' && !shownText(node).includes('\n'))).toBe(true)
        expect(shownText(lines[0])).toContain(title)
      } else {
        // One Button, keyed as the capsule: no line is a target of its own.
        const buttons = lineButtons(capsule)
        expect(buttons.map(button => button.props?.key)).toEqual([key])
        const button = buttons[0]!
        expect(button.props).toMatchObject({ plain: true })
        expect(String(button.props?.label)).toContain(title)
        // Every content row, each across all 36 cells inside the border.
        const lines = shownText(button).split('\n')
        expect(lines).toHaveLength(height - 2)
        expect(lines.map(cells)).toEqual(lines.map(() => 36))
        expect(lines[0]).toContain(title)
        // Strings and Text alone, every Text one row: newlines only between them.
        for (const child of button.children ?? []) {
          if (typeof child === 'string') expect(child).toBe('\n')
          else expect((child as DrawnNode).type).toBe('Text')
        }
        expect(drawnNodes(button).filter(node => node.type === 'Text').every(node => !shownText(node).includes('\n'))).toBe(true)
        // The Button's own keyed Box scopes its hover to it alone.
        const frame = capsuleBorder(capsule, title)!
        expect(frame.props?.position).toBeUndefined()
        expect(frame.props?.paddingX).toBe(0)
        expect(frame.children).toHaveLength(1)
        const target = frame.children![0] as DrawnNode
        expect(target).toMatchObject({ type: 'Box', props: { key: `target:${key}` } })
        expect(target.children).toEqual([button])
        expect((capsule.children ?? [])[0]).toBe(frame)
      }
      const rows = laidOutRows(capsule, 38)
      expect(rows).toHaveLength(height)
      expect(rows[0]).toBe(`╭${'─'.repeat(36)}╮`)
      expect(rows[height - 1]).toBe(`╰${'─'.repeat(36)}╯`)
      expect(rows.every(row => cells(row) === 38)).toBe(true)
      expect(rows[1]).toMatch(new RegExp(`^│ . ${title}.*› │$`))
      expect(coveredButtons(await ui.drawn(), 42)).toEqual([])
      const before = actionCalls(state).length
      await ui.press({ key })
      expect(actionCalls(state)).toHaveLength(before + 2)
    }
    // The current chat's lines press nothing.
    expect(drawnNodes(capsuleFor(await ui.drawn(), 'Current tab')).some(node => node.type === 'Button')).toBe(false)
    if (hasClient) expect((await ui.find({ type: 'Client', key: 'chat:current-session' }))?.props.props).toMatchObject({ isPressable: false })
    await ui.unmount()
  }
})

test('no absolute Box covers a Button, and every overlay hangs from a borderless, unpadded frame', async ($, on) => {
  // The check itself catches the old pattern: a blank Button, then a Box painted over it.
  const old = { type: 'Box', props: { width: 12, flexDirection: 'column', position: 'relative' }, children: [
    { type: 'Button', props: { key: 'blank', label: 'blank', plain: true }, children: [`${' '.repeat(12)}\n${' '.repeat(12)}`] },
    { type: 'Box', props: { position: 'absolute', top: 0, left: 0, width: 12 }, children: [
      { type: 'Text', props: {}, children: ['painted over'] }] },
  ] }
  expect(coveredButtons(old, 12)).toEqual(['blank under painted over'])
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.jobs = [RUNNING, DONE, { ...RUNNING, id: 'waiting-badge', parent_session_id: 'waiting-session' },
    { ...RUNNING, id: 'idle-badge', account: 'aras', parent_pid: 1004 }]
  state.accounts = [...STATUS, { name: 'yusa', email: '', dir: '/yusa', limits: [
    { ...limit(40, 'weekly_all'), resets_at: iso(NOW + 26 * 3_600_000) },
    { ...limit(95, 'weekly_scoped', 'Fable'), resets_at: iso(NOW + 50 * 3_600_000) },
  ] }]
  await start($, clock)
  // Hold the next account read open, so the title carries its spinner.
  let release!: () => void
  state.accountsGate = new Promise<void>(resolve => { release = resolve })
  await clock.advance(59_000)
  expect(statusCalls(state)).toHaveLength(2)
  for (const surface of SURFACES) {
    for (const width of [76, 42, 32]) {
      const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface })
      for (const isOpen of [true, false]) {
        const tree = await ui.drawn()
        expect(await rowText(ui, /Hesaplar/)).toMatch(new RegExp(`^ Hesaplar ${isOpen ? '▾' : '▸'} [${spinner}] $`))
        if (isOpen) for (const name of ['aras', 'yusa']) expect(resetOverlay(tree, name)).toBeDefined()
        // Delegates are rows inside their chats now, never a border overlay.
        expect(subRows(tree, 'Needs approval')).toEqual([expect.stringMatching(subRow('codex'))])
        expect(subRows(tree, 'Idle tab')).toEqual([expect.stringMatching(subRow('aras'))])
        for (const title of ['Needs approval', 'Idle tab']) expect(borderOverlay(capsuleFor(tree, title))).toBeUndefined()
        expect(capsuleBorder(tree, 'Current tab')?.props?.borderColor).toBe('claude')
        // Three chats, three jobs, two delegate rows and the title: one Button
        // each, or the title's alone where the capsule module draws the rest.
        expect(lineButtons(tree)).toHaveLength(surface === 'terminal' || surface === 'desktop' ? 1 : 9)
        expect(coveredButtons(tree, width)).toEqual([])
        // Three card titles, and two accounts' reset times while open.
        expect(absoluteParents(tree)).toHaveLength(isOpen ? 5 : 3)
        for (const parent of absoluteParents(tree)) {
          expect(parent.props?.borderStyle).toBeUndefined()
          expect(isUnpadded(parent)).toBe(true)
        }
        await ui.press({ key: 'accounts:toggle' }); await clock.settle()
      }
      await ui.unmount()
    }
  }
  release(); await clock.settle()
})

test('a chat, job or agent capsule has one key that presses its action, and the title toggles accounts', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.agents = [{ id: 'agent-live', description: 'Inspect tests', type: 'Explore', status: 'running' }]
  mention(state, '/transcripts/1003.jsonl', RUNNING.id)
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  const keys = async (capsule: string) => (await targetsOf(ui))
    .map(target => target.key).filter(key => key === capsule || key.startsWith(`${capsule}:`))
  const focusCalls = (panel: string) => [
    [CMUX, 'select-workspace', '--workspace', WS], [CMUX, 'focus-panel', '--panel', panel, '--workspace', WS]]
  for (const [key, panel] of [['chat:waiting-session', WAITING], [`job:${RUNNING.id}`, RUNNER]] as const) {
    expect(await keys(key)).toEqual([key])
    for (let press = 0; press < 2; press += 1) {
      const before = actionCalls(state).length
      await ui.press({ key })
      expect(actionCalls(state).slice(before).map(call => call.argv)).toEqual(focusCalls(panel))
    }
  }
  expect(grepCalls(state)).toHaveLength(1)
  expect(await keys('agent:agent-live')).toEqual(['agent:agent-live'])
  await ui.press({ key: 'agent:agent-live' })
  expect(state.views).toEqual([{ agentId: 'agent-live' }])
  expect(state.toasts).toEqual([])
  await ui.press({ key: 'accounts:toggle' }); await clock.settle()
  expect(await rowText(ui, /Hesaplar/)).toBe(' Hesaplar ▸ ')
  expect(accountFrame(await ui.drawn(), 'aras')).toBeUndefined()
  expect(state.store.get('isAccountsOpen')).toBe(false)
  await ui.press({ key: 'accounts:toggle' }); await clock.settle()
  expect(await rowText(ui, /Hesaplar/)).toBe(' Hesaplar ▾ ')
  expect(accountFrame(await ui.drawn(), 'aras')).toBeDefined()
  expect(state.store.get('isAccountsOpen')).toBe(true)
  await ui.unmount()
})

test('real cmux lifecycle spellings map to waiting, running, and idle with waiting taking priority', async () => {
  for (const agentLifecycle of ['needsInput', 'needs-input', 'waiting', 'waitingForInput', 'permission']) {
    expect(chatStatus({ agentLifecycle, runtimeStatus: 'running' })).toBe('waiting')
  }
  expect(chatStatus({ agentLifecycle: 'running', hookEventName: 'Notification' })).toBe('waiting')
  expect(chatStatus({ agentLifecycle: 'idle', runtimeStatus: 'needs-input' })).toBe('waiting')
  expect(chatStatus({ agentLifecycle: 'running', runtimeStatus: 'idle' })).toBe('running')
  expect(chatStatus({ agentLifecycle: 'backgroundWorkPending', runtimeStatus: 'running' })).toBe('running')
  expect(chatStatus({ agentLifecycle: 'backgroundWorkPending', runtimeStatus: 'idle', hookEventName: 'Stop' })).toBe('idle')
  expect(chatStatus({ agentLifecycle: 'idle', runtimeStatus: 'idle', hookEventName: 'PreToolUse' })).toBe('idle')
})

test('cmux parsing handles multiple workspaces, terminal titles, escaped quotes, and case-insensitive surfaces', async () => {
  expect(parseWorkspaces(`* workspace:1 ${WS} Main\n  workspace:2 other-workspace Other\n* workspace:1 ${WS} Main`)).toEqual([WS, 'other-workspace'])
  const panels = parsePanels(`surface:1 ${CURRENT.toUpperCase()} terminal [focused] "Title \\"quoted\\""\nsurface:2 web browser "Ignored"`, WS)
  expect(panels).toHaveLength(1)
  const list = parseSessions(JSON.stringify({ sessions: { s: rawSession(CURRENT, 1001) } }), {
    home: HOME, accounts: [], configText: CONFIG_TEXT, panels, alivePids: new Set([1001]),
    currentSessionId: '', currentSurfaceId: CURRENT,
  })
  expect(list).toHaveLength(1)
  expect(list[0]).toMatchObject({ isCurrent: true, account: 'kadir' })
})

test('all open chats render in full beyond the pane window, waiting first, then by last activity', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  for (let index = 0; index < 7; index += 1) {
    const id = `extra-${index}`; const pid = 2000 + index
    state.panels = [...state.panels, { id, title: `Extra tab ${index}` }]
    state.sessions[id] = rawSession(id, pid); state.alivePids.add(pid)
  }
  // The analysis tab's transcript changed after the current tab's.
  state.chatFiles.set('/transcripts/1003.jsonl', { mtimeMs: NOW - 1000, text: '' })
  state.chatFiles.set('/transcripts/1001.jsonl', { mtimeMs: NOW - 5000, text: '' })
  await start($, clock)
  const ui = await mount($,{ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 5 } }, surface: 'terminal' })
  // Every chat a capsule, all but the current one pressable.
  const chatTargets = (await targetsOf(ui)).filter(target => /^chat:/.test(target.key))
  expect(new Set(chatTargets.map(target => target.key)).size).toBe(11)
  expect(chatTargets.filter(target => target.isPressable)).toHaveLength(10)
  const tree = await ui.drawn()
  expect(capsules(tree).filter(node => /Needs approval|Analysis tab|Current tab|Idle tab|Extra tab \d/.test(shownText(node)))).toHaveLength(11)
  for (let index = 0; index < 7; index += 1) expect(await rowText(ui, new RegExp(`Extra tab ${index}`))).toBeDefined()
  expect(await rowText(ui, /sohbet daha/)).toBeUndefined()
  const rows = laidOutRows(tree, 42)
  expect(rows.length).toBeGreaterThan(PANE.props.scroll.bodyRows)
  expect(rows.findIndex(row => /Needs approval/.test(row))).toBeLessThan(rows.findIndex(row => /Analysis tab/.test(row)))
  expect(rows.findIndex(row => /Analysis tab/.test(row))).toBeLessThan(rows.findIndex(row => /Current tab/.test(row)))
  expect((await ui.findAll({ type: 'Text', text: /^● ?$/ })).some(node => node.props.color === 'error' || node.props.color === 'subtle')).toBe(true)
  expect((await ui.findAll({ type: 'Text', text: /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] ?$/ })).some(node => node.props.color === 'suggestion')).toBe(true)
  await ui.unmount()
})

test('a sessions file change is read on the next poll, while cmux and ps run only every thirty seconds', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  const chats = () => (state.snapshots.get('chats') as { value: { list: { id: string; status: string }[] } }).value.list
  await start($, clock)
  await clock.advance(9_000)
  expect(cmuxCalls(state, 'list-workspaces')).toHaveLength(1)
  expect(chatPsCalls(state)).toHaveLength(1)
  expect(state.reads.filter(path => path === `read:${SESSIONS}`)).toHaveLength(1)
  // Every hook event of every tab rewrites the file: a status is read at once,
  // with no cmux listing or ps for tabs and processes already known.
  state.sessions['idle-session'] = { ...(state.sessions['idle-session'] as object), agentLifecycle: 'running' }
  state.sessionsRevision += 1
  await clock.advance(10_000)
  expect(state.reads.filter(path => path === `read:${SESSIONS}`)).toHaveLength(2)
  expect(chats().find(chat => chat.id === 'idle-session')?.status).toBe('running')
  expect(cmuxCalls(state, 'list-workspaces')).toHaveLength(1)
  expect(cmuxCalls(state, 'list-panels')).toHaveLength(1)
  expect(chatPsCalls(state)).toHaveLength(1)
  // Thirty seconds after the last listing, tabs and processes are checked again.
  await clock.advance(10_000)
  expect(cmuxCalls(state, 'list-workspaces')).toHaveLength(2)
  expect(chatPsCalls(state)).toHaveLength(2)
  await clock.advance(20_000)
  expect(cmuxCalls(state, 'list-workspaces')).toHaveLength(2)
  await clock.advance(10_000)
  expect(cmuxCalls(state, 'list-workspaces')).toHaveLength(3)
})

test('a session on a tab no listing saw lists cmux at once, while a closed tab left in the file does not', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  const NEW = '88888888-8888-4888-8888-888888888888'
  await start($, clock)
  expect(cmuxCalls(state, 'list-workspaces')).toHaveLength(1)
  // The closed tab's record stays in the file: the listing that missed it holds.
  state.sessionsRevision += 1
  await clock.advance(9_000)
  expect(state.reads.filter(path => path === `read:${SESSIONS}`)).toHaveLength(2)
  expect(cmuxCalls(state, 'list-workspaces')).toHaveLength(1)
  state.panels = [...state.panels, { id: NEW, title: 'New tab' }]
  state.sessions['new-session'] = rawSession(NEW, 1007); state.alivePids.add(1007)
  state.sessionsRevision += 1
  await clock.advance(10_000)
  expect(cmuxCalls(state, 'list-workspaces')).toHaveLength(2)
  expect(chatPsCalls(state)).toHaveLength(2)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expect(await rowText(ui, /New tab/)).toBeDefined()
  await ui.unmount()
})

test('a transient cmux failure keeps the open chats, names the error, and lists again on the next poll', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  const chats = () => (state.snapshots.get('chats') as { value: { list: { id: string }[]; error: string | null } }).value
  const ids = ['waiting-session', 'current-session', 'idle-session', 'runner-session']
  await start($, clock)
  expect(chats().list.map(chat => chat.id)).toEqual(ids)
  state.isCmuxDown = true
  await clock.advance(29_000)
  expect(cmuxCalls(state, 'list-workspaces')).toHaveLength(2)
  expect(chats().list.map(chat => chat.id)).toEqual(ids)
  expect(chats().error).toBe('sohbetler okunamadı')
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expect(await rowText(ui, /Idle tab/)).toBeDefined()
  expect(await rowText(ui, /sohbetler okunamadı|sohbet yok/)).toBeUndefined()
  state.isCmuxDown = false
  await clock.advance(10_000)
  expect(cmuxCalls(state, 'list-workspaces')).toHaveLength(3)
  expect(chats().error).toBeNull()
  expect(chats().list.map(chat => chat.id)).toEqual(ids)
  await ui.unmount()
})

test('waiting chats lead, the rest follow their transcripts\' last change, newest first, re-sorted once a tick', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  const order = () => (state.snapshots.get('chats') as { value: { list: { id: string }[] } }).value.list.map(chat => chat.id)
  const touch = (pid: number, mtimeMs: number) => state.chatFiles.set(`/transcripts/${pid}.jsonl`, { mtimeMs, text: '' })
  // The idle tab spoke last, then the current one, the running one long ago;
  // the waiting tab's transcript is oldest of all.
  touch(1004, NOW - 1000); touch(1001, NOW - 2000); touch(1003, NOW - 60_000); touch(1002, NOW - 90_000)
  await start($, clock)
  expect(order()).toEqual(['waiting-session', 'idle-session', 'current-session', 'runner-session'])
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  const at = (rows: string[], title: string) => rows.findIndex(row => row.includes(title))
  const drawnOrder = async () => {
    const rows = laidOutRows(await ui.drawn(), 42)
    return ['Needs approval', 'Idle tab', 'Current tab', 'Analysis tab'].sort((a, b) => at(rows, a) - at(rows, b))
  }
  expect(await drawnOrder()).toEqual(['Needs approval', 'Idle tab', 'Current tab', 'Analysis tab'])
  // The running tab writes now: frames redraw its spinner, the order waits for the tick.
  touch(1003, NOW + 2000)
  await clock.advance(5_000)
  expect(order()).toEqual(['waiting-session', 'idle-session', 'current-session', 'runner-session'])
  expect(await drawnOrder()).toEqual(['Needs approval', 'Idle tab', 'Current tab', 'Analysis tab'])
  await clock.advance(4_000)
  expect(order()).toEqual(['waiting-session', 'runner-session', 'idle-session', 'current-session'])
  expect(await drawnOrder()).toEqual(['Needs approval', 'Analysis tab', 'Idle tab', 'Current tab'])
  // Waiting chats lead whatever their transcripts say, newest of them first.
  state.sessions['idle-session'] = { ...(state.sessions['idle-session'] as object), agentLifecycle: 'needsInput' }
  state.sessionsRevision += 1
  await clock.advance(10_000)
  expect(order()).toEqual(['idle-session', 'waiting-session', 'runner-session', 'current-session'])
  await ui.unmount()
})

test('pressing a tab selects its workspace then focuses its panel, using only mocked commands', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'chat:waiting-session' })
  expect(actionCalls(state).map(call => call.argv)).toEqual([
    [CMUX, 'select-workspace', '--workspace', WS], [CMUX, 'focus-panel', '--panel', WAITING, '--workspace', WS],
  ])
  await ui.unmount()
})

test('tab focus failures show the Turkish toast and cmux falls back to PATH if the app binary is missing', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.hasCmux = false; state.isFocusDown = true
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'chat:runner-session' })
  expect(actionCalls(state).map(call => call.argv)).toEqual([['cmux', 'select-workspace', '--workspace', WS]])
  expect(state.toasts).toEqual(['sekme açılamadı'])
  await ui.unmount()
})

test('a delegate without parent fields searches only open transcripts once, then presses focus the cached starter', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  mention(state, '/transcripts/1003.jsonl', RUNNING.id)
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  await ui.press({ key: `job:${RUNNING.id}` })
  await ui.press({ key: `job:${RUNNING.id}` })
  const grep = grepCalls(state)
  expect(grep).toHaveLength(1)
  expect(grep[0]?.argv).toEqual(['grep', '-o', '-H', '-E', '-s', '-e', `job_id\\\\?"[[:space:]]*:[[:space:]]*\\\\?"${RUNNING.id}\\\\?"`,
    '--', '/transcripts/1002.jsonl', '/transcripts/1001.jsonl', '/transcripts/1004.jsonl', '/transcripts/1003.jsonl'])
  expect(grep[0]?.timeoutMs).toBe(5000)
  expect(actionCalls(state).map(call => call.argv)).toEqual([
    [CMUX, 'select-workspace', '--workspace', WS], [CMUX, 'focus-panel', '--panel', RUNNER, '--workspace', WS],
    [CMUX, 'select-workspace', '--workspace', WS], [CMUX, 'focus-panel', '--panel', RUNNER, '--workspace', WS],
  ])
  await ui.unmount()
})

for (const [name, parent] of [
  ['session before pid', { parent_session_id: 'runner-session', parent_pid: 1004 }],
  ['pid only', { parent_pid: 1003 }],
  ['pid after a closed session', { parent_session_id: 'closed-session', parent_pid: 1003 }],
] as const) {
  test(`pressing a delegate focuses its parent by ${name} without transcript grep`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW }); const state = world(on)
    state.jobs = [{ ...RUNNING, ...parent }]
    mention(state, '/transcripts/1004.jsonl', RUNNING.id)
    await start($, clock)
    const ui = await mount($,{ ...PANE, surface: 'terminal' })
    await ui.press({ key: `job:${RUNNING.id}` }); await ui.press({ key: `job:${RUNNING.id}` })
    expect(grepCalls(state)).toHaveLength(0)
    expect(actionCalls(state).map(call => call.argv)).toEqual([
      [CMUX, 'select-workspace', '--workspace', WS], [CMUX, 'focus-panel', '--panel', RUNNER, '--workspace', WS],
      [CMUX, 'select-workspace', '--workspace', WS], [CMUX, 'focus-panel', '--panel', RUNNER, '--workspace', WS],
    ])
    await ui.unmount()
  })
}

test('parent fields added after a cached missing grep take priority on the next delegate click', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  await ui.press({ key: `job:${RUNNING.id}` })
  expect(state.toasts).toEqual(['başlatan sekme kapalı'])
  state.jobs = [{ ...RUNNING, parent_session_id: 'current-session' }]; state.jobsRevision += 1
  await clock.advance(10_000)
  await ui.press({ key: `job:${RUNNING.id}` })
  expect(state.toasts).toEqual(['başlatan sekme kapalı', 'bu sohbette'])
  expect(grepCalls(state)).toHaveLength(1)
  expect(actionCalls(state)).toHaveLength(0)
  await ui.unmount()
})

test('a delegate started in this session shows bu sohbette without focus commands', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  mention(state, '/transcripts/1001.jsonl', RUNNING.id)
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  await ui.press({ key: `job:${RUNNING.id}` })
  expect(state.toasts).toEqual(['bu sohbette'])
  expect(actionCalls(state)).toHaveLength(0)
  await ui.unmount()
})

test('a delegate with no open starter shows başlatan sekme kapalı and caches the missing answer', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  await ui.press({ key: `job:${RUNNING.id}` }); await ui.press({ key: `job:${RUNNING.id}` })
  expect(state.toasts).toEqual(['başlatan sekme kapalı', 'başlatan sekme kapalı'])
  expect(grepCalls(state)).toHaveLength(1)
  expect(actionCalls(state)).toHaveLength(0)
  await ui.unmount()
})

test('jobs show three two-line round capsules, running first, and agents still open their transcript', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.agents = [{ id: 'agent-live', description: 'Inspect tests', type: 'Explore', status: 'running' },
    { id: 'agent-done', description: 'Recent agent', type: 'general-purpose', status: 'completed' }]
  state.jobs = [RUNNING, ...Array.from({ length: 8 }, (_, index) => ({ ...DONE, id: `done-${index}`,
    label: `Old job ${index}`, finished: NOW / 1000 - 100 - index }))]
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'agent:agent-live' })
  expect(state.views).toEqual([{ agentId: 'agent-live' }])
  const tasks = (await targetsOf(ui)).filter(target => /^(agent|job):/.test(target.key))
  // One target per capsule: the two running tasks, then the latest finished.
  expect(tasks.map(target => target.key).slice(0, 2).sort()).toEqual(['agent:agent-live', `job:${RUNNING.id}`])
  expect(tasks.map(target => target.key).slice(2)).toEqual(['agent:agent-done'])
  expect(tasks.slice(0, 2).every(target => /Inspect tests|ads review/.test(target.label))).toBe(true)
  expect(tasks.slice(2).every(target => /Recent agent/.test(target.label))).toBe(true)
  const tree = await ui.drawn()
  for (const title of ['Inspect tests', 'ads review', 'Recent agent']) {
    const capsule = capsuleFor(tree, title)!
    expect(capsule).toBeDefined()
    expect(capsule.props).toMatchObject({ width: 38, flexDirection: 'column' })
    const rows = laidOutRows(capsule, 38)
    expect(rows).toHaveLength(4)
    expect(rows[1]).toMatch(/› │$/)
    expect(rows[2]).toMatch(/(?:ajan|codex) · \d+ sn/)
  }
  expect(drawnNodes(tree).some(node => node.type === 'Text' && shownText(node) === '+8 iş daha' && node.props?.dimColor === true)).toBe(true)
  expect(await rowText(ui, /Old job/)).toBeUndefined()
  await ui.unmount()
})

test('a missing or whitespace delegate label falls back to the cwd basename inside its capsule', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.jobs = [{ ...DONE, id: 'empty-label', label: '', cwd: '/Users/k/tvOSBrowser' },
    { ...DONE, id: 'blank-label', account: 'codex', label: ' \t ', cwd: '/Users/k/another-project/' }]
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expect(await rowText(ui, /tvOSBrowser/)).toMatch(/^✓.*tvOSBrowser.*›$/)
  expect(await rowText(ui, /another-project/)).toMatch(/^✓.*another-project.*›$/)
  expect(await rowText(ui, /aras · 7 dk/)).toBeDefined()
  expect(await rowText(ui, /codex · 7 dk/)).toBeDefined()
  await ui.unmount()
})

test('job capsules show success and error glyphs with concise second-line durations', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  state.jobs = [
    { ...DONE, id: 'seconds', label: 'saniye işi', account: 'codex', duration_ms: 42_000 },
    { ...DONE, id: 'minutes', label: 'dakika işi', account: 'aras', duration_ms: 121_000 },
    { ...DONE, id: 'hours', label: 'saat işi', account: '', status: 'failed', duration_ms: 7_380_000 },
  ]
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  const tree = await ui.drawn()
  for (const [title, glyph, metadata] of [
    ['saniye işi', '✓', 'codex · 42 sn'], ['dakika işi', '✓', 'aras · 2 dk'], ['saat işi', '✗', 'ajan · 2 sa 3 dk'],
  ]) {
    const capsule = capsuleFor(tree, title!)!
    const rows = laidOutRows(capsule, 38)
    expect(rows[1]).toMatch(new RegExp(`^│ ${glyph} .*› │$`))
    expect(rows[2]).toMatch(new RegExp(metadata!))
    expect(drawnNodes(capsule).some(node => node.type === 'Text' && shownText(node) === metadata && node.props?.dimColor === true)).toBe(true)
  }
  expect((await ui.find({ type: 'Text', text: /^✗$/ }))?.props.color).toBe('error')
  state.jobs = [{ ...DONE, id: 'cancelled', label: 'iptal işi', status: 'cancelled', duration_ms: 7000 }]
  state.jobsRevision += 1
  await clock.advance(10_000)
  expect(await rowText(ui, /iptal işi/)).toMatch(/^✗ .*›$/)
  expect((await ui.find({ type: 'Text', text: /^✗$/ }))?.props.color).toBe('error')
  expect(await rowText(ui, /aras · 7 sn/)).toBeDefined()
  await ui.unmount()
})

test('a delegate whose process disappeared shows a warning question mark and no running header', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  idle(state); state.jobs = [RUNNING]; state.processes.clear()
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expect(await rowText(ui, /ads review/)).toMatch(/^\? .*ads review/)
  expect((await ui.find({ type: 'Text', text: /^\?$/ }))?.props.color).toBe('warning')
  expect(state.snapshots.get('jobs')).toMatchObject({ value: { list: [{ id: RUNNING.id, status: 'stale' }] } })
  expect(await rowText(ui, /codex · durdu/)).toBeDefined()
  for (const row of await paneRows(ui)) expect(row).not.toMatch(/[✗⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|1 (?:aktif|çalışan|koşuyor)/)
  const ps = state.calls.filter(call => call.argv[0] === 'ps')
  expect(ps).toHaveLength(1)
  expect(ps[0]?.argv).toEqual(['ps', '-ww', '-o', 'pid=,stat=,command=', '-p', '4242'])
  await ui.unmount()
})

for (const failure of ['deny', 'exit', 'stderr'] as const) {
  test(`an unavailable delegate liveness check (${failure}) retains only jobs younger than two hours`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW }); const state = world(on)
    idle(state); state.jobPsFailure = failure
    // A stale job with no start time is older than the day the list keeps.
    const cases = [
      { id: 'recent', label: 'yeni iş', started: (NOW - 2 * 3_600_000 + 5_000) / 1000, pid: 4242, status: 'running' },
      { id: 'boundary', label: 'sınır işi', started: (NOW - 2 * 3_600_000) / 1000, pid: 4243, status: 'stale' },
      { id: 'older', label: 'eski iş', started: (NOW - 2 * 3_600_000 - 5_000) / 1000, pid: 4244, status: 'stale' },
      { id: 'missing', label: 'tarihsiz iş', started: 0, pid: 4245, status: undefined },
      { id: 'future', label: 'gelecek iş', started: (NOW + 5_000) / 1000, pid: 4246, status: 'stale' },
      { id: 'no-pid', label: 'süreçsiz iş', started: (NOW - 5_000) / 1000, pid: 0, status: 'stale' },
    ]
    state.jobs = cases.map(job => ({ ...RUNNING, ...job, status: 'running' }))
    await start($, clock)
    const ui = await mount($,{ ...PANE, surface: 'terminal' })
    const snapshot = state.snapshots.get('jobs') as { value: { list: { id: string; status: string }[] } }
    for (const job of cases) expect(snapshot.value.list.find(row => row.id === job.id)?.status).toBe(job.status)
    const visible = (await targetsOf(ui)).filter(target => /^job:/.test(target.key))
    expect(new Set(visible.map(target => target.key)).size).toBe(3)
    expect(visible).toHaveLength(3)
    const rows = capsules(await ui.drawn()).filter(node => /^capsule:job:/.test(String(node.props?.key)))
    expect(laidOutRows(rows[0], 38)[1]).toMatch(/^│ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /)
    expect(rows.slice(1).every(node => /^│ \? /.test(laidOutRows(node, 38)[1]!))).toBe(true)
    expect((await paneRows(ui)).filter(row => /· durdu$/.test(row))).toHaveLength(2)
    expect(visible.every(target => !/✗/.test(target.text))).toBe(true)
    const questions = await ui.findAll({ type: 'Text', text: /^\?$/ })
    expect(questions).toHaveLength(2)
    expect(questions.every(node => node.props.color === 'warning')).toBe(true)
    expect(await rowText(ui, /^\+2 iş daha$/)).toBeDefined()
    expect(snapshot.value.list.filter(job => job.status === 'running')).toHaveLength(1)
    await ui.unmount()
  })
}

test('narrow cards truncate long rows with an ellipsis and never wrap or contain em dashes', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.jobs = [{ ...RUNNING, label: 'memora ads and trial cancel review that needs truncating' }]
  state.panels = state.panels.map(panel => panel.id === WAITING ? { ...panel, title: 'A very long permission prompt title that will not fit' } : panel)
  await start($, clock)
  for (const width of [60, 42, 32, 24, 18]) {
    const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
    expect(laidOutRows(capsules(await ui.drawn()).find(node => node.props?.key === `capsule:job:${RUNNING.id}`), width - 4)[1]).toMatch(/…/)
    expect(laidOutRows(await ui.drawn(), width).filter(row => cells(row) > width)).toEqual([])
    for (const node of await ui.findAll({ type: 'Text' })) {
      expect(node.text.length).toBeLessThanOrEqual(width)
      expect(node.text).not.toMatch(/[\r\n—]/)
    }
    await ui.unmount()
  }
})

test('nothing expensive is read while no surface places the pane, including forced startup and open', async ($, on) => {
  const clock = observedClock(on); const state = world(on, {}, false)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  await clock.advance(5 * 60_000)
  expect(state.isOpen).toBe(true)
  expect(state.reads).toHaveLength(0)
  expect(state.calls).toHaveLength(0)
  expect(state.usageCalls).toHaveLength(0)
  expect(state.agentCalls).toBe(0)
  expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(0)
  await $.command.run(TYPED); await $.command.run(TYPED)
  expect(state.reads).toHaveLength(0)
  expect(state.calls).toHaveLength(0)
})

test('the command closes and reopens the pane and resumes polling when it becomes placed', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  await start($, clock)
  expect((await $.command.run(TYPED)).text).toBe('Shiftover paneli kapatıldı.')
  expect(state.isOpen).toBe(false)
  const reads = state.reads.length
  await clock.advance(20_000)
  expect(state.reads).toHaveLength(reads)
  expect((await $.command.run(TYPED)).text).toBe('Shiftover paneli açıldı.')
  expect(state.isOpen).toBe(true)
  expect(state.openColumns).toEqual([76, 76])
  await clock.settle()
  expect(state.reads.length).toBeGreaterThan(reads)
})

test('one adaptive spinner clock follows time at four frames a second and respects the maximum frame rate', async ($, on) => {
  const clock = observedClock(on); const redraws: number[] = []
  on('ui.invalidate', { event: 'ui.render' }, async (_, e, next) => { redraws.push(clock.now()); return next(e) })
  const state = world(on); idle(state); state.jobs = [RUNNING]
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  const before = (await rowText(ui, /ads review/))?.[0]
  await clock.advance(300)
  const after = (await rowText(ui, /ads review/))?.[0]
  expect(after).not.toBe(before)
  expect(after).toBe(spinnerAt(redraws[redraws.length - 1]!))
  expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(1)
  for (let index = 1; index < redraws.length; index += 1) expect(redraws[index]! - redraws[index - 1]!).toBeGreaterThanOrEqual(67)
  // A running spinner redraws four times a second, not ten.
  redraws.length = 0
  await clock.advance(2000)
  expect(redraws.length).toBeGreaterThanOrEqual(7)
  expect(redraws.length).toBeLessThanOrEqual(9)
  await ui.unmount()
})

test('spinner, waiting blink and completion pop never change row count or rendered width', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.jobs = [RUNNING, { ...DONE, label: 'yeni tamamlandı', finished: NOW / 1000 }]
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  for (const width of [42, 32, 60]) {
    const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
    const initial = laidOutRows(await ui.drawn(), width).map(cells)
    expect(initial.every(size => size <= width)).toBe(true)
    for (const elapsed of [125, 175, 300, 600]) {
      await clock.advance(elapsed)
      expect(laidOutRows(await ui.drawn(), width).map(cells)).toEqual(initial)
    }
    await ui.unmount()
  }
})

test('gauge values appear immediately and refresh instantly without any idle animation clock', async ($, on) => {
  const clock = observedClock(on); const state = world(on); idle(state)
  state.accounts = oneAccount([limit(40), limit(92, 'weekly_scoped', 'Fable')])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expect(contentRows(accountCapsule(await ui.drawn(), 'kadir'))[2]).toMatch(/40%.*92%/)
  const initial = contentRows(accountCapsule(await ui.drawn(), 'kadir'))[2]
  await clock.advance(2000)
  expect(contentRows(accountCapsule(await ui.drawn(), 'kadir'))[2]).toBe(initial)
  expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(0)
  expect(clock.waits().filter(wait => wait.ms < 10_000)).toHaveLength(0)
  state.accounts = oneAccount([limit(70), limit(96, 'weekly_scoped', 'Fable')])
  await clock.advance(58_000)
  expect(contentRows(accountCapsule(await ui.drawn(), 'kadir'))[2]).toMatch(/70%.*96%/)
  await clock.advance(100)
  expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(0)
  expect((await ui.findAll({ type: 'Text', text: /^━+$/ })).some(node => node.props.color === 'text')).toBe(false)
  await ui.unmount()
})

test('waiting dots blink error and subtle at 600 ms edges using one quiet after timer', async ($, on) => {
  const clock = observedClock(on); const redraws: number[] = []
  on('ui.invalidate', { event: 'ui.render' }, async (_, e, next) => { redraws.push(clock.now()); return next(e) })
  const state = world(on); idle(state)
  state.sessions = { waiting: rawSession(WAITING, 1002, { agentLifecycle: 'needsInput' }) }
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  // Let the one deferred refresh repaint settle before measuring blink-only work.
  await clock.advance(67)
  const marker = async () => (await ui.find({ type: 'Text', text: /^●$/ }))?.props.color
  const initial = await marker()
  expect(initial).toBe(Math.floor(clock.now() / 600) % 2 === 0 ? 'error' : 'subtle')
  expect(clock.waits().filter(wait => wait.kind === 'after')).toEqual([{ kind: 'after', ms: 600 - clock.now() % 600 }])
  expect(clock.waits().filter(wait => wait.kind === 'every' && wait.ms < 10_000)).toHaveLength(0)
  redraws.length = 0
  const untilEdge = 600 - clock.now() % 600
  await clock.advance(untilEdge - 1)
  expect(await marker()).toBe(initial)
  expect(redraws).toHaveLength(0)
  await clock.advance(1)
  expect(await marker()).toBe(initial === 'error' ? 'subtle' : 'error')
  expect(redraws).toHaveLength(1)
  expect(clock.waits().filter(wait => wait.kind === 'after')).toEqual([{ kind: 'after', ms: 400 }])
  await clock.advance(600)
  expect(await marker()).toBe(initial)
  expect(redraws).toHaveLength(3)
  state.sessions = {}; state.sessionsRevision += 1
  await clock.advance(10_000)
  expect(await rowText(ui, /Needs approval/)).toBeUndefined()
  expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(0)
  expect(clock.waits().filter(wait => wait.ms < 10_000)).toHaveLength(0)
  await ui.unmount()
})

test('idle chats show a steady text-colored open circle without an animation timer', async ($, on) => {
  const clock = observedClock(on); const redraws: number[] = []
  on('ui.invalidate', { event: 'ui.render' }, async (_, e, next) => { redraws.push(clock.now()); return next(e) })
  const state = world(on); idle(state)
  state.sessions = { idle: rawSession(IDLE, 1004) }
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  // Let the one deferred refresh repaint settle before measuring idle work.
  await clock.advance(67)
  redraws.length = 0
  for (const elapsed of [0, 1432, 1, 1500, 1500]) {
    await clock.advance(elapsed)
    expect((await ui.find({ type: 'Text', text: /^○$/ }))?.props.color).toBe('text')
    expect(await ui.find({ type: 'Text', text: /^●$/ })).toBeUndefined()
    expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(0)
    expect(clock.waits().filter(wait => wait.ms < 10_000)).toHaveLength(0)
    expect(redraws).toHaveLength(0)
  }
  await ui.unmount()
})

test('waiting and idle chats schedule only dot and border edges while the idle marker stays steady', async ($, on) => {
  const clock = observedClock(on); const redraws: number[] = []
  on('ui.invalidate', { event: 'ui.render' }, async (_, e, next) => { redraws.push(clock.now()); return next(e) })
  const state = world(on); idle(state)
  state.sessions = {
    waiting: rawSession(WAITING, 1002, { agentLifecycle: 'needsInput' }), idle: rawSession(IDLE, 1004),
  }
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  // Let the one deferred refresh repaint settle before measuring blink-only work.
  await clock.advance(67)
  for (let edge = 0; edge < 6; edge += 1) {
    const phase = clock.now() % 10_000
    const next = Math.min(600 - clock.now() % 600, (phase < 1000 ? 1000 : 10_000) - phase)
    expect(clock.waits().filter(wait => wait.kind === 'after')).toEqual([{ kind: 'after', ms: next }])
    expect(clock.waits().filter(wait => wait.ms < 100)).toHaveLength(0)
    redraws.length = 0
    await clock.advance(next - 1)
    expect(redraws).toHaveLength(0)
    await clock.advance(1)
    expect(redraws).toHaveLength(1)
    const tree = await ui.drawn()
    for (const title of ['Needs approval', 'Idle tab']) {
      const capsule = capsuleFor(tree, title)!
      const waiting = title === 'Needs approval'
      const dot = drawnNodes(capsule).find(node => node.type === 'Text' && shownText(node) === (waiting ? '●' : '○'))
      expect(dot?.props?.color).toBe(waiting ? Math.floor(clock.now() / 600) % 2 === 0 ? 'error' : 'subtle' : 'text')
    }
  }
  await ui.unmount()
})

test('a recent completion pops to its final glyph and then stops its animation', async ($, on) => {
  const clock = observedClock(on); const state = world(on); idle(state)
  state.jobs = [{ ...DONE, label: 'just completed', finished: NOW / 1000 }]
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expect(await rowText(ui, /just completed/)).toMatch(/^·/)
  await clock.advance(125); await ui.redraw(); await clock.settle()
  expect(await rowText(ui, /just completed/)).toMatch(/^•/)
  await clock.advance(175)
  expect(await rowText(ui, /just completed/)).toMatch(/^✓/)
  await clock.advance(1800)
  expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(0)
  await ui.unmount()
})

test('accounts draw no refresh countdown and schedule the earliest finite server target directly', async ($, on) => {
  const clock = observedClock(on); const state = world(on); idle(state)
  const account = readable(STATUS[0]!)
  state.accounts = [
    { ...account, next_refresh_at: null, fetched_at: null },
    { ...account, name: 'later', next_refresh_at: iso(NOW + 300_000) },
    { ...account, name: 'older' },
    { ...account, name: 'first', next_refresh_at: (NOW + 42_250) / 1000, fetched_at: (NOW - 500) / 1000 },
    // An account shiftover could not read keeps a target that never moves.
    { ...STATUS[0]!, name: 'stuck', next_refresh_at: (NOW - 600_000) / 1000 },
  ]
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  await clock.advance(67)
  expect(await rowText(ui, /Hesaplar/)).toBe(' Hesaplar ▾ ')
  expect(shownText(accountsCard(await ui.drawn()))).not.toMatch(/↻|\d+sn/)
  expect(clock.waits().filter(wait => wait.kind === 'after')).toEqual([{ kind: 'after', ms: 42_183 }])
  const snapshot = state.snapshots.get('accounts') as { value: { list: { nextRefreshAtMs: number | null; fetchedAtMs: number | null }[] } }
  expect(snapshot.value.list[0]).toMatchObject({ nextRefreshAtMs: null, fetchedAtMs: null })
  expect(snapshot.value.list[2]).toMatchObject({ nextRefreshAtMs: null, fetchedAtMs: null })
  expect(snapshot.value.list[3]).toMatchObject({ nextRefreshAtMs: NOW + 42_250, fetchedAtMs: NOW - 500 })
  await clock.advance(42_182)
  expect(statusCalls(state)).toHaveLength(1)
  await clock.advance(1)
  expect(statusCalls(state)).toHaveLength(2)
  expect(clock.waits().some(wait => wait.ms === 1000)).toBe(false)
  await ui.unmount()
})

test('older shiftover without reset times has no countdown or additional clock waits', async ($, on) => {
  const clock = observedClock(on); const state = world(on); idle(state)
  state.accounts = oneAccount([limit(10)])
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expect(await rowText(ui, /Hesaplar/)).not.toMatch(/↻/)
  expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(0)
  await ui.unmount()
})

test('the single refresh deadline stops when the pane loses placement', async ($, on) => {
  const clock = observedClock(on); const state = world(on); idle(state)
  state.accounts = [{ ...readable(STATUS[0]!), next_refresh_at: (NOW + 42_000) / 1000 }]
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expect(clock.waits().filter(wait => wait.kind === 'after')).toEqual([{ kind: 'after', ms: 41_933 }])
  state.isPlaced = false
  await clock.advance(9000)
  expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(0)
  await clock.advance(60_000)
  expect(statusCalls(state)).toHaveLength(1)
  await ui.unmount()
})

for (const failed of [false, true]) {
  test(`expiry refreshes immediately and backs off 30 seconds plus jitter after a ${failed ? 'failed' : 'stale'} read`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
    state.accounts = [{ ...readable(STATUS[0]!), next_refresh_at: (NOW + 2000) / 1000 }]
    await start($, clock)
    const ui = await mount($,{ ...PANE, surface: 'terminal' })
    let release!: () => void
    state.accountsGate = new Promise<void>(resolve => { release = resolve })
    state.isShiftoverDown = failed
    await clock.advance(999)
    expect(statusCalls(state)).toHaveLength(1)
    await clock.advance(1)
    expect(statusCalls(state)).toHaveLength(2)
    const border = await rowText(ui, /Hesaplar/)
    expect(border).toMatch(/^ Hesaplar ▾ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] $/)
    expect(border).not.toMatch(/↻/)
    expect((border?.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g) ?? [])).toHaveLength(1)
    await clock.advance(1000)
    expect(statusCalls(state)).toHaveLength(2)
    const readAt = clock.now()
    release(); await clock.settle(); await clock.advance(100)
    expect(await rowText(ui, /Hesaplar/)).toBe(' Hesaplar ▾ ')
    await clock.advance(29_899)
    expect(statusCalls(state)).toHaveLength(2)
    state.isShiftoverDown = false
    state.accounts = [{ ...readable(STATUS[0]!), next_refresh_at: (clock.now() + 42_001) / 1000 }]
    // The retry comes at 30 s plus up to a fifth more, at random.
    while (statusCalls(state).length === 2 && clock.now() - readAt <= 36_000) await clock.advance(100)
    expect(statusCalls(state)).toHaveLength(3)
    expect(clock.now() - readAt).toBeGreaterThanOrEqual(30_000)
    expect(clock.now() - readAt).toBeLessThanOrEqual(36_100)
    await clock.advance(100)
    expect(await rowText(ui, /Hesaplar/)).toBe(' Hesaplar ▾ ')
    await ui.unmount()
  })

  test(`repeated ${failed ? 'failed' : 'stale'} reads double their back-off up to five minutes, each with up to a fifth more`, { timeoutMs: 60_000 }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
    // Every read leaves the server's next read two seconds after the start.
    state.accounts = [{ ...readable(STATUS[0]!), next_refresh_at: (NOW + 2000) / 1000 }]
    await start($, clock)
    state.isShiftoverDown = failed
    await clock.advance(1000)
    expect(statusCalls(state)).toHaveLength(2)
    const gaps: number[] = []
    let last = clock.now()
    while (gaps.length < 6) {
      const calls = statusCalls(state).length
      await clock.advance(1000)
      if (statusCalls(state).length > calls) { gaps.push(clock.now() - last); last = clock.now() }
    }
    for (const [index, base] of [30, 60, 120, 240, 300, 300].entries()) {
      expect(gaps[index]!).toBeGreaterThanOrEqual(base * 1000)
      expect(gaps[index]!).toBeLessThanOrEqual(base * 1200 + 1000)
    }
    // A good read with a future target ends the back-off: the minute's cadence again.
    state.isShiftoverDown = false
    state.accounts = [{ ...readable(STATUS[0]!), next_refresh_at: (clock.now() + 3_600_000) / 1000 }]
    const calls = statusCalls(state).length
    while (statusCalls(state).length === calls) await clock.advance(1000)
    await clock.advance(70_000)
    expect(statusCalls(state)).toHaveLength(calls + 2)
  })
}

test('the accounts border contains just its title at 76 and 42 columns', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  state.accounts = [{ ...readable(STATUS[0]!), next_refresh_at: (NOW + 11_000) / 1000 }]
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  for (const width of [76, 42]) {
    const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
    const before = laidOutRows(await ui.drawn(), width)[0]!
    expect(before).toMatch(/^╭─ Hesaplar ▾ ─+╮$/)
    expect(cells(before)).toBe(width)
    await clock.advance(2000)
    const after = laidOutRows(await ui.drawn(), width)[0]!
    expect(after).toMatch(/^╭─ Hesaplar ▾ ─+╮$/)
    expect(cells(after)).toBe(width)
    expect(after.indexOf('Hesaplar')).toBe(before.indexOf('Hesaplar'))
    expect(laidOutRows(await ui.drawn(), width).every(row => cells(row) <= width)).toBe(true)
    await ui.unmount()
  }
  const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: 20 }, surface: 'terminal' })
  const border = laidOutRows(await ui.drawn(), 20)[0]!
  expect(border).toMatch(/^╭─ Hesaplar /)
  expect(border).not.toMatch(/↻/)
  expect(cells(border)).toBe(20)
  await ui.unmount()
})

test('a refresh spinner is active only while account status is in flight', async ($, on) => {
  const clock = observedClock(on); const state = world(on); idle(state)
  state.accountsGate = clock.sleep(500)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expect(await rowText(ui, /Hesaplar/)).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
  await clock.advance(500)
  expect(await rowText(ui, /Hesaplar/)).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
  expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(0)
  await ui.unmount()
})

test('the current-account marker stays steady while work runs', async ($, on) => {
  const clock = observedClock(on); const state = world(on); idle(state)
  state.accounts = oneAccount([]); state.jobs = [RUNNING]
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  const before = (await ui.find({ type: 'Text', text: /^● ?$/ }))?.props
  expect(before?.color).toBe('claude')
  expect(before?.dimColor).not.toBe(true)
  await clock.advance(1300)
  expect((await ui.find({ type: 'Text', text: /^● ?$/ }))?.props).toEqual(before)
  await ui.unmount()
})

test('closing during an in-flight account read prevents late motion and further expensive reads', async ($, on) => {
  const clock = observedClock(on); const state = world(on); idle(state)
  state.accounts = oneAccount([limit(95)]); state.accountsGate = clock.sleep(500)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  await clock.advance(100)
  await $.command.run(TYPED)
  expect(state.isOpen).toBe(false)
  expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(0)
  await clock.advance(500)
  expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(0)
  const reads = state.reads.length
  await clock.advance(20_000)
  expect(state.reads).toHaveLength(reads)
})

test('cached snapshots after reload form a steady baseline without entrance or completion motion', async ($, on) => {
  const clock = observedClock(on); const state = world(on)
  state.isOpen = true
  on('state.get', { key: 'accounts' }, () => ({ value: { value: {
    shape: 'accounts-3', value: { list: [{ name: 'kadir', display: null, dir: `${HOME}/.claude`, err: null,
      limits: [{ kind: 'session', model: '', used: 70, resetsAtMs: null }] }], current: 'kadir', at: NOW, error: null },
  }, version: 1 } }))
  on('state.get', { key: 'jobs' }, () => ({ value: { value: {
    shape: 'jobs-2', value: { list: [{ id: 'cached-done', account: 'aras', model: '', label: 'cached completion',
      status: 'done', pid: 1, startedMs: NOW - 1000, finishedMs: NOW, durationMs: 1000, costUsd: null }], at: NOW, error: null },
  }, version: 1 } }))
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expect(contentRows(accountCapsule(await ui.drawn(), 'kadir'))[2]).toMatch(/70%/)
  expect(await rowText(ui, /cached completion/)).toMatch(/^✓/)
  expect(clock.waits()).toHaveLength(0)
  await clock.advance(300)
  expect(clock.waits()).toHaveLength(0)
  expect(state.reads).toHaveLength(0)
  expect(state.calls).toHaveLength(0)
  await ui.unmount()
})

test('refresh completion cannot invalidate less than 67 ms before a scheduled animation frame', async ($, on) => {
  const clock = observedClock(on); const redraws: number[] = []
  on('ui.invalidate', { event: 'ui.render' }, async (_, e, next) => { redraws.push(clock.now()); return next(e) })
  const state = world(on); idle(state); state.jobs = [RUNNING]; state.accountsGate = clock.sleep(90)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  await clock.advance(1000)
  expect(redraws.length).toBeGreaterThan(3)
  for (let index = 1; index < redraws.length; index += 1) expect(redraws[index]! - redraws[index - 1]!).toBeGreaterThanOrEqual(67)
  expect(await rowText(ui, /ads review/)).toBeDefined()
  await ui.unmount()
})

test('external text stays on one line and long names truncate inside their own capsule', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.jobs = [{ ...RUNNING, label: 'review — pending\n tasks', account: 'very-long-account-owner-name-that-will-not-fit' }]
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  const tree = await ui.drawn()
  const capsule = capsuleFor(tree, 'review')!
  const rows = laidOutRows(capsule, 38)
  expect(rows[1]).toMatch(/review +· +pending +tasks.*›/)
  expect(rows[2]).toMatch(/very-long.*…/)
  for (const row of rows) {
    expect(row).not.toMatch(/[\r\n—]/)
    expect(cells(row)).toBeLessThanOrEqual(38)
  }
  await ui.unmount()
})

test('hovering a capsule lights its border alone: its text and background stay as at rest and nothing inverts', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); world(on)
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, { ...PANE, surface })
    const region = async (key: string) => await ui.drawn({ in: key }) as DrawnNode
    // Nothing the capsule module draws fills: no Button, no inverse or
    // background, no hover style of the surface's own.
    const fills = (node: DrawnNode) => drawnNodes(node).filter(one => one.type === 'Button' || one.hover !== undefined ||
      one.props?.inverse !== undefined || one.props?.backgroundColor !== undefined)
    for (const key of ['chat:runner-session', 'chat:idle-session', `job:${RUNNING.id}`, 'chat:waiting-session']) {
      const rest = await region(key)
      expect(fills(rest)).toEqual([])
      expect(rest.props?.borderColor).toBe('subtle')
      // Over its lines, its border and its padding alike, the border is text.
      for (const event of [{ type: 'enter', x: 5, y: 1 }, { type: 'move', x: 30, y: 2 }, { type: 'move', x: 0, y: 0 },
        { type: 'move', x: 37, y: 3 }] as const) {
        await ui.pointer({ ...event, in: key })
        const lit = await region(key)
        expect(lit.props?.borderColor).toBe('text')
        expect({ ...lit, props: { ...lit.props, borderColor: 'subtle' } }).toEqual(rest)
        expect(fills(lit)).toEqual([])
        // Another capsule stays as it was.
        expect((await region(key === 'chat:idle-session' ? 'chat:runner-session' : 'chat:idle-session')).props?.borderColor).toBe('subtle')
      }
      await ui.pointer({ type: 'leave', x: 37, y: 3, in: key })
      expect(await region(key)).toEqual(rest)
    }
    // The current chat's lines press nothing: no light over them.
    await ui.pointer({ type: 'enter', x: 5, y: 1, in: 'chat:current-session' })
    expect((await region('chat:current-session')).props?.borderColor).toBe('claude')
    expect(fills(await region('chat:current-session'))).toEqual([])
    await ui.unmount()
  }
})

test('spinner and blink frames reach the capsule module as new props: a hovered capsule stays lit across them, and the module keeps no clock', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); world(on)
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, { ...PANE, surface })
    const key = 'chat:runner-session'
    const glyph = async () => ((await ui.find({ type: 'Client', key }))?.props.props as CapsuleProps).lines[0]![0]!.text
    const first = await glyph()
    expect(first).toBe(spinnerAt(clock.now()))
    await ui.pointer({ type: 'enter', x: 3, y: 1, in: key })
    const lit = await ui.drawn({ in: key })
    // Its own frame clock moves nothing: no timer of its own redraws it.
    const at = clock.now()
    await ui.advance(5_000)
    expect(await ui.drawn({ in: key })).toEqual(lit)
    expect([clock.now(), await glyph()]).toEqual([at, first])
    // The pane's next frame does, as new props (a blink just before it puts it
    // off by the frame budget); the hover holds across them.
    await clock.advance(300)
    expect((await ui.drawn({ in: key }) as DrawnNode).props?.borderColor).toBe('text')
    expect(await glyph()).toBe(spinnerAt(clock.now()))
    expect(await glyph()).not.toBe(first)
    const next = await ui.drawn({ in: key }) as DrawnNode
    expect(next.props?.borderColor).toBe('text')
    expect(contentRows(next)[0]).toMatch(new RegExp(`^${spinnerAt(clock.now())} Analysis tab +›$`))
    await ui.unmount()
  }
})

test('a capsule acts on its own parts alone: a post naming another capsule, another chat\'s row or nothing does nothing', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.jobs = [{ ...RUNNING, parent_session_id: 'idle-session' }]
  state.agents = [{ id: 'agent-live', description: 'Inspect tests', type: 'Explore', status: 'running' }]
  await start($, clock)
  const ui = await mount($, { ...PANE, surface: 'terminal' })
  for (const [data, key] of [
    [{ target: 'chat:waiting-session' }, 'chat:idle-session'], [{ target: `follow:${RUNNING.id}` }, 'chat:runner-session'],
    [{ target: `follow:${RUNNING.id}` }, `job:${RUNNING.id}`], [{ target: 'agent:agent-live' }, `job:${RUNNING.id}`],
    [{}, 'chat:idle-session'], ['chat:idle-session', 'chat:idle-session'], [{ target: 'chat:current-session' }, 'chat:current-session'],
  ] as const) await ui.post(data, { in: key })
  expect([actionCalls(state), surfaceCalls(state), state.views]).toEqual([[], [], []])
  // Its own: the chat focuses its tab, its row follows the job, an agent opens.
  await ui.post({ target: 'chat:idle-session' }, { in: 'chat:idle-session' })
  await ui.post({ target: `follow:${RUNNING.id}` }, { in: 'chat:idle-session' })
  await ui.post({ target: 'agent:agent-live' }, { in: 'agent:agent-live' })
  expect([actionCalls(state).length, surfaceCalls(state).length, state.views]).toEqual([2, 1, [{ agentId: 'agent-live' }]])
  await ui.unmount()
})

test('VS Code and mobile draw no Client, and a surface whose capsule module failed draws Buttons from then on', { timeoutMs: 60_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  const logs: string[] = []
  on('ui.log', (_, e) => { logs.push(`${e.to}: ${e.text}`); return { value: undefined } })
  await start($, clock)
  for (const surface of ['vscode', 'mobile'] as const) {
    const ui = await mount($, { ...PANE, surface })
    expect(await ui.findAll({ type: 'Client' })).toEqual([])
    expect((await targetsOf(ui)).map(target => target.key).filter(key => /^(chat|job):/.test(key)).sort())
      .toEqual(['chat:idle-session', 'chat:runner-session', 'chat:waiting-session', `job:${DONE.id}`, `job:${RUNNING.id}`].sort())
    await ui.press({ key: 'chat:idle-session' })
    await ui.unmount()
  }
  expect(actionCalls(state)).toHaveLength(4)
  const terminal = await mount($, { ...PANE, surface: 'terminal' })
  expect(await terminal.findAll({ type: 'Client' })).toHaveLength(6)
  // Hundreds of delegates under one chat: a tree past what a surface module
  // may draw, so the chat's capsule fails on the terminal.
  const jobs = state.jobs
  state.jobs = [...jobs, ...Array.from({ length: 300 }, (_, index) =>
    ({ ...RUNNING, id: `flood-${index}`, parent_session_id: 'idle-session' }))]
  state.jobsRevision += 1
  await clock.advance(10_000)
  expect(logs.length).toBeGreaterThan(0)
  expect(logs.every(line => /^debug: Shiftover kapsülü çizilemedi \(render\): ./.test(line))).toBe(true)
  // The terminal falls back whole, and stays so once the flood is gone: its
  // capsules are Buttons again, pressed as before.
  state.jobs = jobs; state.jobsRevision += 1
  await clock.advance(10_000)
  expect(await terminal.findAll({ type: 'Client' })).toEqual([])
  expect((await terminal.find({ type: 'Button', key: 'chat:idle-session' }))?.props.label).toBe('○ Idle tab ›')
  await terminal.press({ key: 'chat:idle-session' })
  expect(actionCalls(state)).toHaveLength(6)
  // Another surface keeps its own.
  const desktop = await mount($, { ...PANE, surface: 'desktop' })
  expect(await desktop.findAll({ type: 'Client' })).toHaveLength(6)
  await terminal.unmount(); await desktop.unmount()
})

test('without the capsule module a capsule is a Button: hover mutes its one block and lights its border, rest styles stay', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); world(on)
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'vscode' })
  const tree = await ui.drawn()
  // The kit has no pointer driver for a Button: a hover is the data drawn.
  for (const title of ['Analysis tab', 'Idle tab', 'ads review', 'Needs approval']) {
    const capsule = capsuleFor(tree, title)!
    const border = capsuleBorder(tree, title)!
    const isWaiting = title === 'Needs approval'
    expect(border.props?.position).toBeUndefined()
    expect(border.props?.backgroundColor).toBeUndefined()
    // The keyed capsule Box scopes the hover; a waiting border keeps its own
    // flash: no border hover.
    expect(String(capsule.props?.key)).toMatch(/^capsule:/)
    expect(border.hover).toEqual(isWaiting ? undefined : { borderColor: 'text' })
    if (!isWaiting) expect(border.props?.borderColor).toBe('subtle')
    // One Button: every run in it, padding columns included, mutes on hover,
    // so the block the pointer inverts is one grey block, never white bars.
    const buttons = lineButtons(capsule)
    expect(buttons).toHaveLength(1)
    const button = buttons[0]!
    expect(button.hover).toEqual({ color: 'inactive' })
    const texts = drawnNodes(button).filter(node => node.type === 'Text')
    expect(texts.length).toBeGreaterThan(6)
    for (const text of texts) expect(text.hover).toEqual({ color: 'inactive' })
    expect(texts.some(node => node.props?.color === 'inactive')).toBe(false)
    const strings = (button.children ?? []).filter(child => typeof child === 'string')
    expect(strings.every(child => child === '\n')).toBe(true)
    const name = texts.find(node => shownText(node) === title)
    expect(name?.props).toMatchObject({ color: 'text' })
    expect(name?.props?.weight).toBe(isWaiting ? 'bold' : undefined)
    expect(texts.find(node => shownText(node) === '›')?.props?.dimColor).toBe(true)
    expect(texts.filter(node => node.props?.dimColor === true && /·|sn|bekliyor|çalışıyor|boşta/.test(shownText(node))).length)
      .toBeGreaterThanOrEqual(1)
  }
  const glyph = drawnNodes(capsuleFor(tree, 'Analysis tab')).find(node =>
    node.type === 'Text' && shownText(node).length === 1 && spinner.includes(shownText(node)))
  expect(glyph?.props?.color).toBe('suggestion')
  // Account capsules and the current chat press nothing and change nothing on hover.
  for (const frame of [accountFrame(tree, 'kadir'), accountFrame(tree, 'aras'), accountFrame(tree, 'codex'), capsuleFor(tree, 'Current tab')]) {
    expect(frame).toBeDefined()
    expect(drawnNodes(frame).filter(node => node.hover !== undefined || node.type === 'Button')).toEqual([])
  }
  // The title is the Button: muted on hover, bold text color at rest.
  const title = lineButtons(accountsCard(tree)).find(node => node.props?.key === 'accounts:toggle')!
  expect(title.hover).toEqual({ color: 'inactive' })
  const titleTexts = drawnNodes(title).filter(node => node.type === 'Text')
  expect(titleTexts.length).toBeGreaterThan(1)
  for (const text of titleTexts) expect(text.hover).toEqual({ color: 'inactive' })
  expect(titleTexts.find(node => shownText(node) === ' Hesaplar ▾ ' && node.props?.weight === 'bold')?.props?.color).toBe('text')
  await ui.unmount()
})

// The focus ring stops on Buttons alone: where the capsule module draws the
// capsules, only the Hesaplar title is a stop.
test('without the capsule module, keyboard focus on a capsule lights its border and mutes its whole block at rest; a denied move keeps it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); world(on)
  let denied = false
  on('ui.focus', () => denied ? { deny: 'test refusal' } : {})
  await start($, clock)
  const ui = await mount($,{ ...PANE, props: { ...PANE.props, isFocused: true }, surface: 'vscode' })
  const focus = (element?: string, plugin = 'shiftover-panel') => $.ui.focus({
    component: 'Pane', requestId: 'shiftover-panel', plugin, element, origin: { kind: 'person' },
  })
  // Focus inverts the Button: with every run muted, its padding columns too,
  // that is one grey block, never white. Only newlines stand outside a Text.
  const isMuted = async (title: string) => lineButtons(capsuleFor(await ui.drawn(), title)).every(button =>
    drawnNodes(button).filter(node => node.type === 'Text' && node.props?.color === 'inactive').map(shownText).join('') ===
      shownText(button).replace(/\n/g, ''))
  const before = contentRows(capsuleBorder(await ui.drawn(), 'Idle tab'))
  expect(await isMuted('Idle tab')).toBe(false)
  for (let move = 0; move < 2; move += 1) {
    await focus('chat:idle-session'); await clock.advance(100)
    expect(capsuleBorder(await ui.drawn(), 'Idle tab')?.props?.borderColor).toBe('text')
    expect(contentRows(capsuleBorder(await ui.drawn(), 'Idle tab'))).toEqual(before)
    expect(await isMuted('Idle tab')).toBe(true)
    expect(capsuleBorder(await ui.drawn(), 'Analysis tab')?.props?.borderColor).toBe('subtle')
    expect(await isMuted('Analysis tab')).toBe(false)
  }
  const heading = async () => drawnNodes(accountsCard(await ui.drawn())).find(node =>
    node.type === 'Text' && shownText(node) === ' Hesaplar ▾ ' && node.props?.weight === 'bold')?.props?.color
  expect(await heading()).toBe('text')
  denied = true
  await focus('chat:runner-session:0'); await clock.advance(100)
  expect(capsuleBorder(await ui.drawn(), 'Idle tab')?.props?.borderColor).toBe('text')
  expect(await isMuted('Analysis tab')).toBe(false)
  denied = false
  await focus('accounts:toggle'); await clock.advance(100)
  expect(await heading()).toBe('inactive')
  expect(capsuleBorder(await ui.drawn(), 'Idle tab')?.props?.borderColor).toBe('subtle')
  expect(await isMuted('Idle tab')).toBe(false)
  await focus(); await clock.advance(100)
  expect(await heading()).toBe('text')
  await ui.unmount()
})

test('waiting borders share a one-second flash every ten seconds while dots keep their 600 ms phase', async ($, on) => {
  const clock = observedClock(on); const state = world(on); idle(state)
  state.sessions = {
    'waiting-session': rawSession(WAITING, 1002, { agentLifecycle: 'needsInput' }),
    'idle-session': rawSession(IDLE, 1004, { agentLifecycle: 'needsInput' }),
    'current-session': rawSession(CURRENT, 1001, { agentLifecycle: 'needsInput' }),
  }
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  for (const elapsed of [67, 599, 600, 999, 1000, 1200, 9900, 9999, 10_000, 10_999, 11_000, 19_999, 20_000]) {
    await clock.set(NOW + elapsed)
    const tree = await ui.drawn()
    const color = Math.floor(clock.now() / 600) % 2 === 0 ? 'error' : 'subtle'
    for (const title of ['Needs approval', 'Idle tab', 'Current tab']) {
      const capsule = capsuleFor(tree, title)!
      const dot = drawnNodes(capsule).find(node => node.type === 'Text' && shownText(node) === '●')
      expect(dot?.props?.color).toBe(color)
      expect(capsuleBorder(tree, title)?.props?.borderColor).toBe(title === 'Current tab'
        ? 'claude' : elapsed % 10_000 < 1000 ? 'error' : 'subtle')
      expect(capsuleBorder(tree, title)?.hover).toBeUndefined()
    }
    expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(1)
  }
  // Hovered, a waiting chat's border is text; let go, it flashes as before.
  await clock.set(NOW + 30_000)
  await ui.pointer({ type: 'enter', x: 3, y: 1, in: 'chat:waiting-session' })
  expect(capsuleBorder(await ui.drawn(), 'Needs approval')?.props?.borderColor).toBe('text')
  await ui.pointer({ type: 'leave', x: 3, y: 1, in: 'chat:waiting-session' })
  expect(capsuleBorder(await ui.drawn(), 'Needs approval')?.props?.borderColor).toBe('error')
  state.isPlaced = false
  await clock.advance(600)
  expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(0)
  const reads = state.reads.length
  await clock.advance(20_000)
  expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(0)
  expect(state.reads).toHaveLength(reads)
  await ui.unmount()
})

for (const status of ['idle', 'running'] as const) {
  test(`the current ${status} chat has the account marker's steady orange border and no hit target`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW }); const state = world(on)
    state.sessions['current-session'] = rawSession(CURRENT, 1001, { agentLifecycle: status })
    await start($, clock)
    const ui = await mount($,{ ...PANE, surface: 'terminal' })
    for (const elapsed of [0, 600, 9400]) {
      await clock.advance(elapsed)
      const tree = await ui.drawn()
      const marker = drawnNodes(accountFrame(tree, 'kadir')).find(node => shownText(node) === '● ')
      expect(marker?.props?.color).toBe('claude')
      expect(capsuleBorder(tree, 'Current tab')?.props?.borderColor).toBe(marker?.props?.color)
      expect(drawnNodes(capsuleFor(tree, 'Current tab')).filter(node => node.type === 'Button')).toHaveLength(0)
      expect((await ui.find({ type: 'Client', key: 'chat:current-session' }))?.props.props)
        .toMatchObject({ border: 'claude', isPressable: false, rows: [] })
    }
    // A click on it acts on nothing.
    await ui.press({ key: 'chat:current-session' })
    expect(actionCalls(state)).toEqual([])
    await ui.unmount()
  })
}

test('delegate rows match session ids before pids and ignore old, closed, finished and stale jobs', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.jobs = [
    { ...RUNNING, id: 'session', parent_session_id: 'waiting-session', parent_pid: 1004 },
    { ...RUNNING, id: 'pid', account: 'aras', parent_pid: 1004 },
    { ...RUNNING, id: 'fallback', account: 'yusa', parent_session_id: 'closed-session', parent_pid: 1002 },
    { ...RUNNING, id: 'closed', parent_session_id: 'closed-session', parent_pid: 1005 },
    RUNNING,
    ...['done', 'failed', 'cancelled', 'stale'].map(status => ({ ...RUNNING, id: status, status,
      parent_session_id: 'waiting-session' })),
    { ...RUNNING, id: 'no-process', account: 'kadir', pid: 0, parent_pid: 1002 },
    { ...RUNNING, id: 'gone', account: 'kadir', pid: 9999, parent_pid: 1002 },
    { ...RUNNING, id: 'empty', parent_session_id: '', parent_pid: 0 },
  ]
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  const tree = await ui.drawn()
  const glyph = spinnerAt(clock.now())
  expect(subRows(tree, 'Needs approval')).toEqual([`└ ${glyph} codex  çalışıyor`, `└ ${glyph} yusa  çalışıyor`])
  expect(subRows(tree, 'Idle tab')).toEqual([`└ ${glyph} aras  çalışıyor`])
  for (const title of ['Current tab', 'Analysis tab']) expect(subRows(tree, title)).toEqual([])
  expect(followButtons(tree, 'Needs approval').map(node => node.props?.key)).toEqual(['follow:session', 'follow:fallback'])
  // Only the two running jobs without parent fields are searched, in one call.
  expect(grepCalls(state).map(call => call.argv)).toEqual([starterSearch(RUNNING.id, 'empty')])
  await ui.unmount()
})

test('delegate rows list each running job by earliest start, share the spinner, color the account and fit narrow capsules', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.jobs = ['kadir', 'codex', 'yusa', 'aras', 'codex'].map((account, index) => ({
    ...RUNNING, id: `row-${index}`, account, parent_session_id: 'idle-session',
    started: (NOW - (index + 1) * 1000) / 1000,
  }))
  await start($, clock)
  for (const width of [76, 42, 16]) {
    const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
    for (const elapsed of [0, 250]) {
      await clock.advance(elapsed)
      await ui.redraw(); await clock.settle()
      const tree = await ui.drawn()
      // Narrow titles truncate: the capsules are found by key.
      const byKey = (key: string) => capsules(tree).find(node => node.props?.key === `capsule:chat:${key}`)!
      const idleCapsule = byKey('idle-session')
      const buttons = followButtonsIn(idleCapsule)
      const glyph = spinnerAt(clock.now())
      const room = width - 4 - 4
      const names = ['codex', 'aras', 'yusa', 'codex', 'kadir']
      expect(buttons.map(node => node.props?.key)).toEqual(['row-4', 'row-3', 'row-2', 'row-1', 'row-0'].map(id => `follow:${id}`))
      const rows = buttons.flatMap(node => contentRows(node))
      expect(rows).toHaveLength(5)
      for (const [index, row] of rows.entries()) {
        const full = `└ ${glyph} ${names[index]}  çalışıyor`
        expect(row).toBe(cells(full) <= room ? full : `${[...full].slice(0, room - 1).join('')}…`)
        expect(cells(row)).toBeLessThanOrEqual(room)
      }
      // The spinner and account in the account's color; the branch and step faint.
      if (width === 76) {
        for (const [index, color] of ['success', 'suggestion', 'remember', 'success', 'claude'].entries()) {
          const spans = drawnNodes(buttons[index]).filter(node => node.type === 'Text')
          expect(spans.find(node => shownText(node) === names[index])?.props?.color).toBe(color)
          expect(spans.find(node => shownText(node) === `${glyph} `)?.props?.color).toBe(color)
          expect(spans.find(node => shownText(node) === '└ ')?.props?.dimColor).toBe(true)
          expect(spans.find(node => shownText(node) === 'çalışıyor')?.props?.dimColor).toBe(true)
        }
      }
      // One spinner phase for the rows and the running chat's marker.
      expect(drawnNodes(byKey('runner-session')).some(node => node.type === 'Text' && shownText(node) === glyph)).toBe(true)
      // The capsule grows a row per job; no overlay rides its border.
      const laid = laidOutRows(idleCapsule, width - 4)
      expect(laid).toHaveLength(10)
      expect(laid[0]).toBe(`╭${'─'.repeat(width - 6)}╮`)
      expect(borderOverlay(idleCapsule)).toBeUndefined()
      expect(laidOutRows(tree, width).every(row => cells(row) <= width)).toBe(true)
    }
    await ui.unmount()
  }
})

test('delegate rows retain the existing two-hour staleness guard when ps is unavailable', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.jobPsFailure = 'deny'
  state.jobs = [
    { ...RUNNING, parent_pid: 1004 },
    { ...RUNNING, id: 'old-parent', account: 'aras', parent_pid: 1004, started: (NOW - 2 * 3_600_000) / 1000 },
  ]
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expect(subRows(await ui.drawn(), 'Idle tab')).toEqual([expect.stringMatching(subRow('codex'))])
  await ui.unmount()
})

// MARK: - Starters of older jobs

test('parentless running delegates find their starters in one batched grep of open transcripts and keep them', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.jobs = [RUNNING, { ...RUNNING, id: 'second-job', account: 'aras', started: (NOW - 100_000) / 1000 },
    { ...RUNNING, id: 'with-parent', account: 'yusa', parent_pid: 1002 }, DONE]
  mention(state, '/transcripts/1004.jsonl', RUNNING.id)
  mention(state, '/transcripts/1003.jsonl', 'second-job', DONE.id)
  // A closed tab's transcript is never searched.
  mention(state, '/transcripts/1005.jsonl', RUNNING.id, 'second-job')
  await start($, clock)
  expect(grepCalls(state).map(call => call.argv)).toEqual([starterSearch(RUNNING.id, 'second-job')])
  expect(grepCalls(state)[0]?.timeoutMs).toBe(5000)
  // Many refreshes later the found starters still hold without a search.
  for (const elapsed of [0, 5 * 60_000]) {
    await clock.advance(elapsed)
    const ui = await mount($,{ ...PANE, surface: 'terminal' })
    const tree = await ui.drawn()
    expect(subRows(tree, 'Idle tab')).toEqual([expect.stringMatching(subRow('codex'))])
    expect(subRows(tree, 'Analysis tab')).toEqual([expect.stringMatching(subRow('aras'))])
    expect(subRows(tree, 'Needs approval')).toEqual([expect.stringMatching(subRow('yusa'))])
    expect(subRows(tree, 'Current tab')).toEqual([])
    expect(grepCalls(state)).toHaveLength(1)
    await ui.unmount()
  }
})

test('an unmatched starter is searched again only after a minute, and presses reuse the cached answer', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  await start($, clock)
  expect(grepCalls(state).map(call => call.argv)).toEqual([starterSearch(RUNNING.id)])
  mention(state, '/transcripts/1004.jsonl', RUNNING.id)
  await clock.advance(58_000)
  const early = await mount($,{ ...PANE, surface: 'terminal' })
  expect(subRows(await early.drawn(), 'Idle tab')).toEqual([])
  await early.press({ key: `job:${RUNNING.id}` })
  expect(state.toasts).toEqual(['başlatan sekme kapalı'])
  expect(grepCalls(state)).toHaveLength(1)
  await early.unmount()
  await clock.advance(1_000)
  expect(grepCalls(state)).toHaveLength(2)
  const found = await mount($,{ ...PANE, surface: 'terminal' })
  expect(subRows(await found.drawn(), 'Idle tab')).toEqual([expect.stringMatching(subRow('codex'))])
  await found.press({ key: `job:${RUNNING.id}` })
  expect(actionCalls(state).map(call => call.argv)).toEqual([
    [CMUX, 'select-workspace', '--workspace', WS], [CMUX, 'focus-panel', '--panel', IDLE, '--workspace', WS]])
  await found.unmount()
  await clock.advance(3 * 60_000)
  expect(grepCalls(state)).toHaveLength(2)
})

test('delegates with parent fields, finished or stale ones are never searched in the background', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.jobs = [{ ...RUNNING, id: 'closed-parent', parent_session_id: 'closed-session', parent_pid: 1005 },
    { ...RUNNING, id: 'gone', pid: 9999 }, { ...RUNNING, id: 'failed-job', status: 'failed' }, DONE]
  for (const path of OPEN_TRANSCRIPTS) mention(state, path, 'closed-parent', 'gone', 'failed-job', DONE.id)
  await start($, clock)
  await clock.advance(3 * 60_000)
  expect(grepCalls(state)).toHaveLength(0)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  for (const title of ['Needs approval', 'Analysis tab', 'Current tab', 'Idle tab']) {
    expect(subRows(await ui.drawn(), title)).toEqual([])
  }
  // A press still searches for a job whose parent tab closed.
  await ui.press({ key: 'job:closed-parent' })
  expect(grepCalls(state).map(call => call.argv)).toEqual([starterSearch('closed-parent')])
  expect(actionCalls(state).map(call => call.argv)).toEqual([
    [CMUX, 'select-workspace', '--workspace', WS], [CMUX, 'focus-panel', '--panel', WAITING, '--workspace', WS]])
  await ui.unmount()
})

test('starter searches pause while the pane is unplaced and resume once it is placed', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  await start($, clock)
  expect(grepCalls(state)).toHaveLength(1)
  state.isPlaced = false
  await clock.advance(5 * 60_000)
  expect(grepCalls(state)).toHaveLength(1)
  state.isPlaced = true
  await clock.advance(10_000)
  expect(grepCalls(state)).toHaveLength(2)
})

test('a starter search waits for an open transcript without spending an attempt', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.sessions = {}
  await start($, clock)
  await clock.advance(20_000)
  expect(grepCalls(state)).toHaveLength(0)
  state.sessions = { 'idle-session': rawSession(IDLE, 1004) }; state.sessionsRevision += 1
  mention(state, '/transcripts/1004.jsonl', RUNNING.id)
  await clock.advance(10_000)
  expect(grepCalls(state).map(call => call.argv)).toEqual([
    ['grep', '-o', '-H', '-E', '-s', '-e', jobIdPattern(RUNNING.id), '--', '/transcripts/1004.jsonl']])
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expect(subRows(await ui.drawn(), 'Idle tab')).toEqual([expect.stringMatching(subRow('codex'))])
  await ui.unmount()
})

test('a finished delegate keeps its found starter for presses until it leaves the job list', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  mention(state, '/transcripts/1004.jsonl', RUNNING.id)
  await start($, clock)
  expect(grepCalls(state).map(call => call.argv)).toEqual([starterSearch(RUNNING.id)])
  const running = await mount($,{ ...PANE, surface: 'terminal' })
  expect(subRows(await running.drawn(), 'Idle tab')).toEqual([expect.stringMatching(subRow('codex'))])
  await running.unmount()
  state.jobs = [{ ...RUNNING, status: 'done', finished: (NOW + 5_000) / 1000, duration_ms: 60_000 }, DONE]
  state.jobsRevision += 1
  await clock.advance(3 * 60_000)
  const done = await mount($,{ ...PANE, surface: 'terminal' })
  expect(subRows(await done.drawn(), 'Idle tab')).toEqual([])
  await done.press({ key: `job:${RUNNING.id}` })
  expect(actionCalls(state).map(call => call.argv)).toEqual([
    [CMUX, 'select-workspace', '--workspace', WS], [CMUX, 'focus-panel', '--panel', IDLE, '--workspace', WS]])
  expect(grepCalls(state)).toHaveLength(1)
  await done.unmount()
  // Off the list, its answer goes too: running again, it is searched afresh.
  state.jobs = [DONE]; state.jobsRevision += 1
  await clock.advance(10_000)
  state.jobs = [RUNNING, DONE]; state.jobsRevision += 1
  await clock.advance(10_000)
  expect(grepCalls(state).map(call => call.argv)).toEqual([starterSearch(RUNNING.id), starterSearch(RUNNING.id)])
})

// MARK: - Finished jobs

test('a zombie delegate process is not running: its job is stale and loses its row', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.jobs = [{ ...RUNNING, parent_session_id: 'idle-session' }]
  state.processes.set(4242, { stat: 'Z', command: '(codex)' })
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expect(state.snapshots.get('jobs')).toMatchObject({ value: { list: [{ id: RUNNING.id, status: 'stale' }] } })
  expect(await rowText(ui, /ads review/)).toMatch(/^\? .*ads review/)
  expect(subRows(await ui.drawn(), 'Idle tab')).toEqual([])
  expect(jobPsCalls(state).map(call => call.argv)).toEqual([['ps', '-ww', '-o', 'pid=,stat=,command=', '-p', '4242']])
  state.processes.set(4242, { stat: 'S+', command: '/opt/bin/codex exec -' })
  await clock.advance(10_000)
  expect(state.snapshots.get('jobs')).toMatchObject({ value: { list: [{ id: RUNNING.id, status: 'running' }] } })
  expect(subRows(await ui.drawn(), 'Idle tab')).toEqual([expect.stringMatching(subRow('codex'))])
  await ui.unmount()
})

for (const [name, job, lines, status, glyph] of [
  ['codex turn.completed', { account: 'codex' }, [codexLine('thread.started'), codexLine('turn.started'),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12 } })], 'done', '✓'],
  ['codex turn.failed', { account: 'codex' }, [codexLine('turn.started'),
    JSON.stringify({ type: 'turn.failed', error: { message: 'stream error' } })], 'failed', '✗'],
  ['claude result line', { account: 'aras' }, [JSON.stringify({ type: 'assistant' }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false })], 'done', '✓'],
  ['claude error result', { account: 'aras' }, [JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true })], 'failed', '✗'],
  ['a codex backend named in the file', { account: 'yusa', backend: 'codex' }, [codexLine('turn.completed')], 'done', '✓'],
] as const) {
  test(`a running job whose .out ended (${name}) shows ${status} with a fixed duration and no row`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW }); const state = world(on)
    state.jobs = [{ ...RUNNING, ...job, parent_session_id: 'idle-session', started: (NOW - 10 * 60_000) / 1000 }]
    state.outs.set(RUNNING.id, { mtimeMs: NOW - 2 * 60_000, text: `${lines.join('\n')}\n` })
    await start($, clock)
    expect(state.snapshots.get('jobs')).toMatchObject({ value: { list: [{ id: RUNNING.id, status, finishedMs: NOW - 2 * 60_000 }] } })
    expect(tailCalls(state).map(call => call.argv)).toEqual([['tail', '-c', '262144', '--', `${JOBS}/${RUNNING.id}.out`]])
    // An ended .out outranks the process check, so no ps runs for it.
    expect(jobPsCalls(state)).toHaveLength(0)
    // Its duration stops at the .out's time and the unchanged .out is not read again.
    for (const elapsed of [0, 60_000]) {
      await clock.advance(elapsed)
      const ui = await mount($,{ ...PANE, surface: 'terminal' })
      expect(await rowText(ui, /ads review/)).toMatch(new RegExp(`^${glyph} .*ads review`))
      expect(await rowText(ui, new RegExp(`^${job.account} · 8 dk`))).toBeDefined()
      expect(subRows(await ui.drawn(), 'Idle tab')).toEqual([])
      await ui.unmount()
    }
    expect(tailCalls(state)).toHaveLength(1)
    expect(jobPsCalls(state)).toHaveLength(0)
  })
}

test('a still-running .out keeps its job running and is tailed again only after it changes', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.jobs = [{ ...RUNNING, parent_session_id: 'idle-session' }]
  const out = { mtimeMs: NOW - 1000, text: `${codexLine('thread.started')}\n${codexLine('turn.started')}\n` }
  state.outs.set(RUNNING.id, out)
  await start($, clock)
  expect(tailCalls(state).map(call => call.argv)).toEqual([['tail', '-c', '262144', '--', `${JOBS}/${RUNNING.id}.out`]])
  expect(state.snapshots.get('jobs')).toMatchObject({ value: { list: [{ id: RUNNING.id, status: 'running', finishedMs: null }] } })
  const running = await mount($,{ ...PANE, surface: 'terminal' })
  expect(subRows(await running.drawn(), 'Idle tab')).toEqual([expect.stringMatching(subRow('codex'))])
  await running.unmount()
  await clock.advance(30_000)
  expect(tailCalls(state)).toHaveLength(1)
  expect(jobPsCalls(state).length).toBeGreaterThan(1)
  out.text += `${codexLine('turn.completed')}\n`; out.mtimeMs = clock.now()
  await clock.advance(10_000)
  expect(tailCalls(state)).toHaveLength(2)
  expect(state.snapshots.get('jobs')).toMatchObject({ value: { list: [{ id: RUNNING.id, status: 'done' }] } })
  const done = await mount($,{ ...PANE, surface: 'terminal' })
  expect(subRows(await done.drawn(), 'Idle tab')).toEqual([])
  await done.unmount()
})

test('a truncated .out tail ignores its partial first line, both ends read by one tail', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  state.jobs = [RUNNING, { ...RUNNING, id: 'claude-job', account: 'aras' }]
  // Cut mid-line, a first line that looks ended is no evidence.
  state.outs.set(RUNNING.id, { mtimeMs: NOW - 1000, size: 300_000,
    text: `"type":"turn.failed","error":{}}\n${codexLine('turn.started')}\n` })
  state.outs.set('claude-job', { mtimeMs: NOW - 1000, size: 300_000, text: '{"type":"result","is_error":false}\n' })
  await start($, clock)
  const list = (state.snapshots.get('jobs') as { value: { list: { id: string; status: string }[] } }).value.list
  expect(list.map(job => [job.id, job.status])).toEqual([[RUNNING.id, 'running'], ['claude-job', 'running']])
  // Both ends in one tail; the codex .out, its step source too, named no step
  // there, so all of it a tail can hold is read for one, alone.
  expect(tailCalls(state).map(call => call.argv)).toEqual([['tail', '-c', '262144', '--',
    `${JOBS}/${RUNNING.id}.out`, `${JOBS}/claude-job.out`], ['tail', '-c', '300001', '--', `${JOBS}/${RUNNING.id}.out`]])
})

test('one batched ps checks every running delegate whose .out has not ended, zombies included', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  state.jobs = [
    { ...RUNNING, id: 'live', pid: 4242 },
    { ...RUNNING, id: 'zombie', pid: 4243, started: (NOW - 60_000) / 1000 },
    { ...RUNNING, id: 'gone', pid: 4244, started: (NOW - 65_000) / 1000 },
    { ...RUNNING, id: 'ended', pid: 4245, started: (NOW - 70_000) / 1000 },
  ]
  state.processes.set(4243, { stat: 'Z+', command: '(codex)' })
  state.processes.set(4245, { stat: 'S', command: '/opt/bin/codex exec -' })
  state.outs.set('ended', { mtimeMs: NOW - 30_000, text: `${codexLine('turn.completed')}\n` })
  await start($, clock)
  expect(jobPsCalls(state).map(call => call.argv)).toEqual([['ps', '-ww', '-o', 'pid=,stat=,command=', '-p', '4242,4243,4244']])
  const list = (state.snapshots.get('jobs') as { value: { list: { id: string; status: string }[] } }).value.list
  expect(Object.fromEntries(list.map(job => [job.id, job.status]))).toEqual({ live: 'running', zombie: 'stale', gone: 'stale', ended: 'done' })
})

test('account borders list reset times over an hour apart with faint labels and critical value colors at 76 and 42 cells', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  state.accounts = [
    ...oneAccount([
      { ...limit(96, 'weekly_scoped', 'Fable'), resets_at: iso(NOW + 50 * 3_600_000) },
      { ...limit(75, 'weekly_all'), resets_at: iso(NOW + 26 * 3_600_000) },
      { ...limit(3), resets_at: iso(NOW + 35 * 60_000) },
    ]),
    { name: 'aras', email: '', dir: '/aras', limits: [
      { ...limit(45, 'weekly_scoped', 'Fable'), resets_at: iso(NOW + 63 * 3_600_000) },
      { ...limit(16), resets_at: iso(NOW + 35 * 60_000) },
    ] },
  ]
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  for (const width of [76, 42]) {
    const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
    const tree = await ui.drawn()
    const kadir = resetOverlay(tree, 'kadir')!
    expect(shownText(kadir)).toBe(' hafta 1g 2sa · Fable 2g 2sa ')
    // The border never carries the 5-hour window.
    expect(shownText(kadir)).not.toMatch(/5s|5 saat|35dk/)
    expect(shownText(resetOverlay(tree, 'aras'))).toBe(' ↻ 2g 15sa ')
    for (const name of ['kadir', 'aras']) {
      const frame = accountFrame(tree, name)!
      const border = laidOutRows(frame, width - 4)[0]!
      expect(border).toMatch(/^╭─+ .* ─╮$/)
      expect(cells(border)).toBe(width - 4)
      expect(Number(resetOverlay(tree, name)?.props?.left)).toBeGreaterThanOrEqual(2)
    }
    const spans = drawnNodes(kadir).filter(node => node.type === 'Text')
    for (const label of ['hafta ', 'Fable ']) {
      expect(spans.find(node => shownText(node) === label)?.props?.dimColor).toBe(true)
    }
    const weekly = spans.find(node => shownText(node) === '1g 2sa')
    expect(weekly?.props?.dimColor).toBe(true)
    expect(weekly?.props?.color).toBeUndefined()
    expect(spans.find(node => shownText(node) === '2g 2sa')?.props).toMatchObject({ color: 'error' })
    expect(contentRows(accountCapsule(tree, 'kadir')).slice(-1)[0]).toBe(
      `${width === 76 ? '  ' : ''}Fable 2g 2sa sonra açılır`)
    expect(laidOutRows(tree, width).every(row => cells(row) <= width)).toBe(true)
    await ui.unmount()
  }
})

test('reset borders omit missing and passed resets, use the cell model name, and omit unreadable accounts', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  state.codexFiles.set(`${CODEX}/session.jsonl`, { mtimeMs: 1, text: rateLine(
    { used_percent: 95, window_minutes: 300, resets_at: NOW / 1000 + 35 * 60 }) })
  state.accounts = [
    ...oneAccount([
      { ...limit(90, 'weekly_scoped', 'Sonnet'), resets_at: iso(NOW + 35 * 60_000) },
      { ...limit(30), resets_at: iso(NOW - 1) }, limit(40, 'weekly_all'),
    ]),
    { name: 'named', email: '', dir: '/named', limits: [
      { ...limit(90, 'weekly_scoped', 'Sonnet'), resets_at: iso(NOW + 35 * 60_000) },
      { ...limit(40, 'weekly_all'), resets_at: iso(NOW + 50 * 3_600_000) },
    ] },
    { name: 'passed', email: '', dir: '/passed', limits: [
      { ...limit(40, 'weekly_all'), resets_at: iso(NOW - 1) }, limit(20, 'weekly_scoped', 'Fable'),
    ] },
    { ...STATUS[0]!, name: 'unreadable' },
    { name: 'unknown', email: '', dir: '/unknown', limits: [limit(5)] },
    { name: 'session-only', email: '', dir: '/session-only', limits: [
      { ...limit(95), resets_at: iso(NOW + 35 * 60_000) },
    ] },
  ]
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  for (const width of [76, 42]) {
    const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
    const tree = await ui.drawn()
    const overlay = resetOverlay(tree, 'kadir')!
    expect(shownText(overlay)).toBe(' ↻ 35dk ')
    expect(drawnNodes(overlay).find(node => shownText(node) === '35dk')?.props).toMatchObject({ color: 'error' })
    const named = resetOverlay(tree, 'named')!
    expect(shownText(named)).toBe(' hafta 2g 2sa · Sonnet 35dk ')
    expect(drawnNodes(named).find(node => shownText(node) === '35dk')?.props).toMatchObject({ color: 'error' })
    for (const name of ['passed', 'unreadable', 'unknown', 'session-only', 'codex']) expect(resetOverlay(tree, name)).toBeUndefined()
    await ui.unmount()
  }
})

test('reset parts are dropped from the end and disappear completely before touching the left corner', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  // Two hours apart, the weekly times stay a labelled list to drop from.
  state.accounts = oneAccount([
    { ...limit(5), resets_at: iso(NOW + 108 * 60_000) },
    { ...limit(80, 'weekly_all'), resets_at: iso(NOW + 50 * 3_600_000) },
    { ...limit(95, 'weekly_scoped', 'Extremely long model name'), resets_at: iso(NOW + 52 * 3_600_000) },
  ])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  for (const [width, expected] of [[42, ' hafta 2g 2sa '], [24, ' hafta 2g 2sa '], [16, '']] as const) {
    const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
    const tree = await ui.drawn()
    expect(shownText(resetOverlay(tree, 'kadir'))).toBe(expected)
    const border = laidOutRows(accountFrame(tree, 'kadir'), width - 4)[0]!
    expect(border).toMatch(/^╭─.*─╮$/)
    expect(cells(border)).toBe(width - 4)
    expect(border).not.toMatch(/…/)
    await ui.unmount()
  }
})

test('Codex reset borders use only its existing windows and their actual reset timestamps', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  state.codexFiles.set(`${CODEX}/limits.jsonl`, { mtimeMs: 1, text: rateLine(
    { used_percent: 93, window_minutes: 10080, resets_at: NOW / 1000 + 50 * 3600 },
    { used_percent: 20, window_minutes: 300, resets_at: NOW / 1000 + 35 * 60 }) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  for (const width of [76, 42]) {
    const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
    const overlay = resetOverlay(await ui.drawn(), 'codex')!
    expect(shownText(overlay)).toBe(' ↻ 2g 2sa ')
    expect(shownText(overlay)).not.toMatch(/5s|35dk/)
    expect(drawnNodes(overlay).find(node => shownText(node) === '2g 2sa')?.props?.color).toBe('error')
    expect(drawnNodes(overlay).find(node => shownText(node) === '↻ ')?.props?.dimColor).toBe(true)
    expect(shownText(overlay)).not.toContain('Fable')
    await ui.unmount()
  }
})

test('reset border text changes only on minute boundaries even while another row spins', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  state.jobs = [RUNNING]
  state.accounts = oneAccount([{ ...limit(10, 'weekly_all'), resets_at: iso(NOW + 108 * 60_000) }])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expect(shownText(resetOverlay(await ui.drawn(), 'kadir'))).toBe(' ↻ 1sa 48dk ')
  for (const target of [NOW + 1000, NOW + 30_000, NOW + 59_900]) {
    await clock.set(target)
    expect(shownText(resetOverlay(await ui.drawn(), 'kadir'))).toBe(' ↻ 1sa 48dk ')
  }
  await clock.set(NOW + 60_100)
  expect(shownText(resetOverlay(await ui.drawn(), 'kadir'))).toBe(' ↻ 1sa 47dk ')
  await ui.unmount()
})

test('quiet reset borders schedule a minute callback with no one-second timer', async ($, on) => {
  const clock = observedClock(on); const redraws: number[] = []
  on('ui.invalidate', { event: 'ui.render' }, async (_, e, next) => { redraws.push(clock.now()); return next(e) })
  const state = world(on); idle(state)
  state.accounts = oneAccount([{ ...limit(10, 'weekly_all'), resets_at: iso(NOW + 35 * 60_000) }])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  await clock.advance(67); redraws.length = 0
  expect(clock.waits().filter(wait => wait.kind === 'after')).toEqual([{ kind: 'after', ms: 59_933 }])
  expect(clock.waits().some(wait => wait.ms === 1000)).toBe(false)
  await clock.advance(59_932)
  expect(redraws).toHaveLength(0)
  expect(shownText(resetOverlay(await ui.drawn(), 'kadir'))).toBe(' ↻ 35dk ')
  await clock.advance(101)
  expect(shownText(resetOverlay(await ui.drawn(), 'kadir'))).toBe(' ↻ 34dk ')
  await ui.unmount()
})

test('weekly resets at most an hour apart show one earliest time, colored for the most used window', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  const hour = 3_600_000
  const weekly = (allAt: number, scopedAt: number, allUsed = 40, scopedUsed = 50): RawLimit[] => [
    { ...limit(allUsed, 'weekly_all'), resets_at: iso(NOW + allAt) },
    { ...limit(scopedUsed, 'weekly_scoped', 'Fable'), resets_at: iso(NOW + scopedAt) },
    { ...limit(10), resets_at: iso(NOW + 35 * 60_000) },
  ]
  state.accounts = [
    { name: 'same', email: '', dir: '/same', limits: weekly(50 * hour, 50 * hour) },
    { name: 'hour', email: '', dir: '/hour', limits: weekly(51 * hour, 50 * hour) },
    { name: 'apart', email: '', dir: '/apart', limits: weekly(51 * hour + 60_000, 50 * hour) },
    { name: 'days', email: '', dir: '/days', limits: weekly(26 * hour, 50 * hour) },
    { name: 'one', email: '', dir: '/one', limits: [
      { ...limit(20, 'weekly_scoped', 'Fable'), resets_at: iso(NOW + 35 * 60_000) }, limit(10, 'weekly_all')] },
    { name: 'hot', email: '', dir: '/hot', limits: weekly(50 * hour, 50 * hour + 30 * 60_000, 75, 96) },
  ]
  state.codexFiles.set(`${CODEX}/weekly.jsonl`, { mtimeMs: 1, text: rateLine(
    { used_percent: 93, window_minutes: 10080, resets_at: NOW / 1000 + 26 * 3600 }) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  for (const width of [76, 42]) {
    const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
    const tree = await ui.drawn()
    for (const [name, shown] of [
      ['same', ' ↻ 2g 2sa '], ['hour', ' ↻ 2g 2sa '], ['apart', ' hafta 2g 3sa · Fable 2g 2sa '],
      ['days', ' hafta 1g 2sa · Fable 2g 2sa '], ['one', ' ↻ 35dk '], ['hot', ' ↻ 2g 2sa '], ['codex', ' ↻ 1g 2sa '],
    ] as const) {
      expect(shownText(resetOverlay(tree, name))).toBe(shown)
      const border = laidOutRows(accountFrame(tree, name), width - 4)[0]!
      expect(border).toMatch(/^╭─+ .* ─╮$/)
      expect(cells(border)).toBe(width - 4)
    }
    const span = (name: string, text: string) => drawnNodes(resetOverlay(tree, name)).find(node =>
      node.type === 'Text' && shownText(node) === text)?.props
    for (const name of ['same', 'hour', 'one', 'hot', 'codex']) {
      expect(span(name, '↻ ')).toMatchObject({ dimColor: true })
      expect(span(name, '↻ ')?.color).toBeUndefined()
    }
    for (const [name, value] of [['same', '2g 2sa'], ['hour', '2g 2sa'], ['one', '35dk']] as const) {
      expect(span(name, value)).toMatchObject({ dimColor: true })
      expect(span(name, value)?.color).toBeUndefined()
    }
    expect(span('hot', '2g 2sa')).toMatchObject({ color: 'error' })
    expect(span('codex', '1g 2sa')).toMatchObject({ color: 'error' })
    expect(laidOutRows(tree, width).every(row => cells(row) <= width)).toBe(true)
    await ui.unmount()
  }
})

test('a server refresh deadline between spinner frames is not delayed by the repaint budget', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const redraws: number[] = []
  on('ui.invalidate', { event: 'ui.render' }, async (_, e, next) => { redraws.push(clock.now()); return next(e) })
  const state = world(on); idle(state); state.jobs = [RUNNING]
  state.accounts = [{ ...readable(STATUS[0]!), next_refresh_at: (NOW + 250) / 1000 }]
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  await clock.advance(249)
  expect(statusCalls(state)).toHaveLength(1)
  await clock.advance(1)
  expect(statusCalls(state)).toHaveLength(2)
  await clock.advance(100)
  for (let index = 1; index < redraws.length; index += 1) {
    expect(redraws[index]! - redraws[index - 1]!).toBeGreaterThanOrEqual(67)
  }
  await ui.unmount()
})

// MARK: - Compact accounts

const summaryAccounts = (): RawAccount[] => [
  ...oneAccount([limit(4), limit(75, 'weekly_all'), limit(96, 'weekly_scoped', 'Fable')]),
  { name: 'aras', email: '', dir: '/aras', limits: [limit(46), limit(20, 'weekly_all')] },
  { name: 'yusa', email: '', dir: '/yusa', limits: [limit(64, 'weekly_all')] },
]
const summaryRows = (tree: unknown): string[] => contentRows(accountsCard(tree)).filter(row => !row.includes('Hesaplar'))

for (const width of [76, 42]) {
  test(`Hesaplar has no vertical spacing or blank rows at ${width} columns`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
    state.accounts = summaryAccounts()
    state.codexFiles.set(`${CODEX}/weekly.jsonl`, { mtimeMs: 1, text: rateLine(
      { used_percent: 2, window_minutes: 10080, resets_at: NOW / 1000 + 3600 }) })
    await start($, clock)
    const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
    const tree = await ui.drawn()
    const card = accountsCard(tree)!
    const rows = laidOutRows(card, width)
    const frames = drawnNodes(card).filter(node => /^capsule:account:/.test(String(node.props?.key)))
    const expectedHeight = frames.reduce((sum, frame) => sum + laidOutRows(frame, width - 4).length, 2)
    expect(rows).toHaveLength(expectedHeight)
    expect(rows).toHaveLength(width === 76 ? 15 : 27)
    expect(rows.every(row => !/^[│\s]*$/.test(row))).toBe(true)
    expect(rows[1]).toMatch(/╭─/)
    expect(rows[rows.length - 2]).toMatch(/╰─/)
    for (const capsule of frames) {
      expect(contentRows(capsule).every(row => row.trim() !== '')).toBe(true)
      for (const node of drawnNodes(capsule).filter(node => node.type === 'Box' && node.props?.position !== 'absolute')) {
        expect(node.props).toMatchObject({ gap: 0, paddingY: 0, marginY: 0 })
      }
    }
    const otherCards = (tree as DrawnNode).children!.slice(1)
    expect(otherCards.every(node => (node as DrawnNode).props?.paddingY === undefined)).toBe(true)
    await ui.press({ key: 'accounts:toggle' }); await clock.settle()
    const collapsed = laidOutRows(accountsCard(await ui.drawn()), width)
    expect(collapsed).toHaveLength(3)
    expect(collapsed.length).toBeLessThan(rows.length)
    expect(collapsed.every(row => cells(row) === width)).toBe(true)
    await ui.unmount()
  })
}

test('only the accounts title toggles, through a Button that is the visible title itself, on every surface', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  state.accounts = summaryAccounts()
  await start($, clock)
  for (const surface of SURFACES) {
    const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: 76 }, surface })
    expect(await rowText(ui, /Hesaplar/)).toBe(' Hesaplar ▾ ')
    const card = accountsCard(await ui.drawn())!
    expect(drawnNodes(card).filter(node => node.type === 'Button')).toHaveLength(1)
    const button = drawnNodes(card).find(node => node.type === 'Button')!
    expect(button.props).toMatchObject({ key: 'accounts:toggle', plain: true, label: 'Hesaplar ▾' })
    expect(shownText(button)).toBe(' Hesaplar ▾ ')
    // The keyed title Box holds only the Button, on the border row, painted
    // over by nothing: it is the card's last child.
    const title = drawnNodes(card).find(node => (node.children ?? []).includes(button))!
    expect(title.props).toMatchObject({ key: 'accounts:title', position: 'absolute', top: 0, left: 2,
      width: cells(' Hesaplar ▾ ') })
    expect(title.children).toHaveLength(1)
    expect((card.children ?? []).indexOf(title)).toBe((card.children ?? []).length - 1)
    expect(coveredButtons(await ui.drawn(), 76)).toEqual([])
    await ui.press({ key: 'accounts:toggle' }); await clock.settle()
    expect(await rowText(ui, /Hesaplar/)).toBe(' Hesaplar ▸ ')
    expect(accountFrame(await ui.drawn(), 'kadir')).toBeUndefined()
    expect(summaryRows(await ui.drawn())).toHaveLength(1)
    expect(state.store.get('isAccountsOpen')).toBe(false)
    await ui.press({ key: 'accounts:toggle' }); await clock.settle()
    expect(await rowText(ui, /Hesaplar/)).toBe(' Hesaplar ▾ ')
    expect(accountFrame(await ui.drawn(), 'kadir')).toBeDefined()
    expect(state.store.get('isAccountsOpen')).toBe(true)
    await ui.unmount()
  }
})

test('collapsed accounts show ordered markers and their maximum usage in the matching value color', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  state.accounts = [...summaryAccounts(), { name: 'lost', email: '', dir: '/lost', err: 'HTTP 401' }]
  state.codexFiles.set(`${CODEX}/weekly.jsonl`, { mtimeMs: 1, text: rateLine(
    { used_percent: 2, window_minutes: 10080, resets_at: NOW / 1000 + 3600 }) })
  await start($, clock)
  const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: 76 }, surface: 'terminal' })
  await ui.press({ key: 'accounts:toggle' }); await clock.settle()
  const card = accountsCard(await ui.drawn())!
  expect(summaryRows(card)).toEqual(['● kadir 96%  ○ aras 46%  ○ yusa 64%  ○ lost ?  ◎ codex 2%'])
  for (const [value, color] of [['96%', 'error'], ['46%', 'success'], ['64%', 'success'], ['?', 'warning'], ['2%', 'success']]) {
    expect(drawnNodes(card).find(node => node.type === 'Text' && shownText(node) === value)?.props?.color).toBe(color)
  }
  expect(drawnNodes(card).find(node => node.type === 'Text' && shownText(node) === '● ')?.props?.color).toBe('claude')
  state.accounts = oneAccount([limit(89)]); await clock.advance(60_000)
  const warning = drawnNodes(accountsCard(await ui.drawn())).find(node => node.type === 'Text' && shownText(node) === '89%')
  expect(warning?.props?.color).toBe('warning')
  await ui.unmount()
})

test('collapsed summaries drop whole trailing accounts and append an ellipsis within the available cells', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  state.accounts = summaryAccounts()
  state.codexFiles.set(`${CODEX}/weekly.jsonl`, { mtimeMs: 1, text: rateLine(
    { used_percent: 2, window_minutes: 10080, resets_at: NOW / 1000 + 3600 }) })
  await start($, clock)
  const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: 76 }, surface: 'terminal' })
  await ui.press({ key: 'accounts:toggle' }); await clock.settle()
  await ui.unmount()
  for (const [width, expected] of [
    [76, '● kadir 96%  ○ aras 46%  ○ yusa 64%  ◎ codex 2%'],
    [42, '● kadir 96%  ○ aras 46%  ○ yusa 64%  …'],
    [27, '● kadir 96%  …'], [16, '…'],
  ] as const) {
    const narrow = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
    const tree = await narrow.drawn()
    expect(summaryRows(tree)).toEqual([expected])
    expect(laidOutRows(tree, width).every(row => cells(row) <= width)).toBe(true)
    await narrow.unmount()
  }
})

for (const stored of [false, true, 'invalid', undefined]) {
  test(`the persistent accounts preference restores ${String(stored)} with open as the default`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
    state.store.set('isAccountsOpen', stored)
    await start($, clock)
    const ui = await mount($,{ ...PANE, surface: 'terminal' })
    expect(await rowText(ui, /Hesaplar/)).toBe(stored === false ? ' Hesaplar ▸ ' : ' Hesaplar ▾ ')
    await ui.unmount()
  })
}

test('the accounts choice survives remounts and is reloaded from storage on session start', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'accounts:toggle' }); await clock.settle()
  expect(state.store.get('isAccountsOpen')).toBe(false)
  await ui.unmount()
  const reload = await mount($,{ ...PANE, surface: 'terminal' })
  expect(await rowText(reload, /Hesaplar/)).toBe(' Hesaplar ▸ ')
  await reload.unmount()
  state.snapshots.delete('isAccountsOpen')
  const reads = state.storeReads.length
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  expect(state.storeReads.length).toBeGreaterThan(reads)
  expect(state.snapshots.get('isAccountsOpen')).toBe(false)
  const tab = await mount($,{ ...PANE, surface: 'terminal' })
  expect(await rowText(tab, /Hesaplar/)).toBe(' Hesaplar ▸ ')
  await tab.press({ key: 'accounts:toggle' }); await clock.settle()
  expect(state.store.get('isAccountsOpen')).toBe(true)
  await tab.unmount()
})

test('collapsed accounts keep refreshing data and retain the spinner beside their title', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  state.accounts = [{ ...summaryAccounts()[0]!, next_refresh_at: (NOW + 2000) / 1000 }]
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'accounts:toggle' }); await clock.settle()
  expect(summaryRows(await ui.drawn())).toEqual(['● kadir 96%  ◎ codex ?'])
  let release!: () => void
  state.accountsGate = new Promise<void>(resolve => { release = resolve })
  state.accounts = [{ ...oneAccount([limit(24)])[0]!, next_refresh_at: (NOW + 60_000) / 1000 }]
  await clock.advance(1000)
  expect(statusCalls(state)).toHaveLength(2)
  expect(await rowText(ui, /Hesaplar/)).toMatch(/^ Hesaplar ▸ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] $/)
  expect(laidOutRows(accountsCard(await ui.drawn()), 42)).toHaveLength(3)
  release(); await clock.settle(); await clock.advance(100)
  expect(await rowText(ui, /Hesaplar/)).toBe(' Hesaplar ▸ ')
  expect(summaryRows(await ui.drawn())).toEqual(['● kadir 24%  ◎ codex ?'])
  expect(accountFrame(await ui.drawn(), 'kadir')).toBeUndefined()
  await ui.unmount()
})

// MARK: - Codex history

const codexWindow = (used_percent: number, window_minutes: number, resets_at = NOW / 1000 + 3600) =>
  ({ used_percent, window_minutes, resets_at })
const codexUsed = (state: World): number[] =>
  (state.snapshots.get('codex') as { value: { limits: { used: number }[] } }).value.limits.map(limit => limit.used)

test('a Codex file over 4 MiB is read by its tail, never whole', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  const text = `${`${'x'.repeat(2000)}\n`.repeat(20)}${rateLine(codexWindow(33, 300), codexWindow(44, 10080))}\n`
  state.codexFiles.set(`${CODEX}/huge.jsonl`, { mtimeMs: 2, size: 5 * 1024 * 1024, text })
  await start($, clock)
  expect(state.reads.filter(path => path.startsWith(`read:${HOME}/.codex/`))).toEqual([])
  expect(tailCalls(state).map(call => call.argv)).toEqual([['tail', '-c', String(1024 * 1024), '--', `${CODEX}/huge.jsonl`]])
  expect(codexUsed(state)).toEqual([33, 44])
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expectLimitColumns(accountCapsule(await ui.drawn(), 'codex')!, [{ label: '↻ 1sa 0dk', percent: 33 }, { label: 'hafta', percent: 44 }])
  await ui.unmount()
})

test('a newest Codex file with no rate limits yet falls back to older files, and finding none keeps the last limits', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  state.codexFiles.set(`${CODEX}/older.jsonl`, { mtimeMs: 1, text: rateLine(codexWindow(21, 300), codexWindow(31, 10080)) })
  // A delegate's new session: no turn has ended, so its limits are still null.
  state.codexFiles.set(`${CODEX}/newest.jsonl`, { mtimeMs: 3, text: [codexLine('session_meta'),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: null } })].join('\n') })
  await start($, clock)
  expect(tailCalls(state).map(call => call.argv[4])).toEqual([`${CODEX}/newest.jsonl`, `${CODEX}/older.jsonl`])
  expect(codexUsed(state)).toEqual([21, 31])
  // Unchanged files are not read again.
  await clock.advance(60_000)
  expect(tailCalls(state)).toHaveLength(2)
  // The files with limits rotated away: the last limits stand, unwritten.
  const writes = state.writes.filter(key => key === 'codex').length
  state.codexFiles.clear()
  state.codexFiles.set(`${CODEX}/fresh.jsonl`, { mtimeMs: 4, text: codexLine('session_meta') })
  await clock.advance(60_000)
  expect(tailCalls(state).slice(2).map(call => call.argv[4])).toEqual([`${CODEX}/fresh.jsonl`])
  expect(state.writes.filter(key => key === 'codex')).toHaveLength(writes)
  expect(codexUsed(state)).toEqual([21, 31])
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expectLimitColumns(accountCapsule(await ui.drawn(), 'codex')!, [{ label: '↻ 58dk', percent: 21 }, { label: 'hafta', percent: 31 }])
  await ui.unmount()
})

// MARK: - Passed windows

test('a window whose reset has passed draws as reset at that time: 0%, no critical note, collapsed and for Codex too', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  state.accounts = oneAccount([
    { ...limit(92), resets_at: iso(NOW + 30_000) },
    // Reset three days ago and not read since: no longer 95% used.
    { ...limit(95, 'weekly_all'), resets_at: iso(NOW - 3 * 24 * 3_600_000) },
    limit(40, 'weekly_scoped', 'Fable'),
  ])
  state.codexFiles.set(`${CODEX}/old.jsonl`, { mtimeMs: 1, text: rateLine(
    codexWindow(97, 300, NOW / 1000 - 60), codexWindow(50, 10080)) })
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  let tree = await ui.drawn()
  expectLimitColumns(accountCapsule(tree, 'kadir')!, [{ label: '↻ <1dk', percent: 92 }, { label: 'hafta', percent: 0 },
    { label: 'Fable', percent: 40 }])
  expect(contentRows(accountCapsule(tree, 'kadir'))[4]).toBe('5 saat <1dk sonra açılır')
  expectLimitColumns(accountCapsule(tree, 'codex')!, [{ label: '5 saat', percent: 0 }, { label: 'hafta', percent: 50 }])
  expect(shownText(accountsCard(tree))).not.toMatch(/95%|97%/)
  // The 5-hour window resets thirty seconds in: it draws as reset right then.
  await clock.advance(29_000)
  tree = await ui.drawn()
  expectLimitColumns(accountCapsule(tree, 'kadir')!, [{ label: '5 saat', percent: 0 }, { label: 'hafta', percent: 0 },
    { label: 'Fable', percent: 40 }])
  expect(contentRows(accountCapsule(tree, 'kadir'))).toHaveLength(4)
  await ui.press({ key: 'accounts:toggle' }); await clock.settle()
  expect(summaryRows(await ui.drawn())).toEqual(['● kadir 40%  ◎ codex 50%'])
  await ui.unmount()
})

// MARK: - Visibility and load

test('a pane behind another pane\'s tab reads and animates nothing, then catches up once shown again', async ($, on) => {
  const clock = observedClock(on); const state = world(on); idle(state)
  state.jobs = [RUNNING]
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(1)
  state.isShown = false
  await clock.advance(10_000)
  expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(0)
  const reads = state.reads.length
  const calls = state.calls.length
  const agentCalls = state.agentCalls
  await clock.advance(5 * 60_000)
  expect(state.reads).toHaveLength(reads)
  expect(state.calls).toHaveLength(calls)
  expect(state.agentCalls).toBe(agentCalls)
  expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(0)
  // Shown again: its next drawing catches up at once, not at the next poll.
  state.isShown = true
  state.jobs = [RUNNING, { ...DONE, id: 'while-hidden', label: 'gizliyken bitti' }]; state.jobsRevision += 1
  await ui.redraw(); await clock.advance(1)
  expect(state.calls.length).toBeGreaterThan(calls)
  expect(await rowText(ui, /gizliyken bitti/)).toBeDefined()
  expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(1)
  await ui.unmount()
})

test('polls that find nothing new write nothing to $.state, so nothing is redrawn for them', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  await start($, clock)
  await clock.advance(60_000)
  const writes = state.writes.length
  await clock.advance(5 * 60_000)
  expect(state.writes.slice(writes)).toEqual([])
  state.jobs = [...state.jobs, { ...DONE, id: 'new-done', label: 'yeni' }]; state.jobsRevision += 1
  await clock.advance(10_000)
  expect(state.writes.slice(writes)).toEqual(['jobs'])
})

// MARK: - Notifications

test('only a permission or input request counts as waiting: the idle reminder and other notifications do not', async () => {
  const notified = { hookEventName: 'Notification' }
  for (const row of [
    // The reminder after a minute at an idle prompt, however cmux keeps it.
    { ...notified, notification_type: 'idle_prompt', agentLifecycle: 'idle' },
    { ...notified, notificationType: 'idle_prompt' },
    { ...notified, notification: { notification_type: 'idle_prompt' } },
    { ...notified, message: 'Claude is waiting for your input', runtimeStatus: 'idle' },
    { ...notified, agentLifecycle: 'idle', runtimeStatus: 'idle', turnSettled: true },
    { ...notified, turnSettled: true },
    { ...notified, notificationType: 'auth_success' },
    { agentLifecycle: 'notification', turnSettled: true },
  ]) expect(chatStatus(row), JSON.stringify(row)).toBe('idle')
  for (const row of [
    { ...notified, notification_type: 'permission_prompt', agentLifecycle: 'idle', turnSettled: true },
    { ...notified, notificationType: 'elicitation_dialog' },
    { ...notified, message: 'Claude needs your permission to use Bash', turnSettled: true },
    { ...notified, notification: { type: 'permission_prompt' }, runtimeStatus: 'idle' },
    // Neither kept: a notification inside an open turn asks.
    { ...notified, agentLifecycle: 'running', runtimeStatus: 'idle' },
    { ...notified, turnSettled: false },
  ]) expect(chatStatus(row), JSON.stringify(row)).toBe('waiting')
  // The reminder of a tab still at work leaves it running.
  expect(chatStatus({ ...notified, notification_type: 'idle_prompt', agentLifecycle: 'running' })).toBe('running')
})

test('a tab whose last event is the idle reminder stays boşta and steady; a permission prompt waits and blinks', async ($, on) => {
  const clock = observedClock(on); const state = world(on); idle(state)
  state.sessions = { 'idle-session': rawSession(IDLE, 1004, { hookEventName: 'Notification',
    notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }) }
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  await clock.advance(67)
  expect(contentRows(capsuleFor(await ui.drawn(), 'Idle tab'))).toContain('boşta')
  expect((await ui.find({ type: 'Text', text: /^○$/ }))?.props.color).toBe('text')
  expect(await ui.find({ type: 'Text', text: /^●$/ })).toBeUndefined()
  expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(0)
  state.sessions = { 'waiting-session': rawSession(WAITING, 1002, { hookEventName: 'Notification',
    notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }) }
  state.sessionsRevision += 1
  await clock.advance(10_000)
  expect(contentRows(capsuleFor(await ui.drawn(), 'Needs approval'))).toContain('cevap bekliyor')
  expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(1)
  await ui.unmount()
})

// MARK: - Job history

test('the jobs state keeps every running job, then those finished within a day, ten in all', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  const hour = 3_600_000
  const ids = () => (state.snapshots.get('jobs') as { value: { list: { id: string }[] } }).value.list.map(job => job.id)
  state.jobs = [
    RUNNING,
    ...Array.from({ length: 12 }, (_, index) => ({ ...DONE, id: `day-${index}`, label: `gün ${index}`,
      started: (NOW - (index + 2) * hour) / 1000, finished: (NOW - (index + 1) * hour) / 1000 })),
    { ...DONE, id: 'yesterday', label: 'dünkü iş', started: (NOW - 26 * hour) / 1000, finished: (NOW - 25 * hour) / 1000 },
  ]
  await start($, clock)
  expect(ids()).toEqual([RUNNING.id, ...Array.from({ length: 9 }, (_, index) => `day-${index}`)])
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expect(await rowText(ui, /^\+7 iş daha$/)).toBeDefined()
  await ui.unmount()
  state.jobs = [{ ...DONE, id: 'recent', started: (NOW - 24 * hour) / 1000, finished: (NOW - 23 * hour) / 1000 },
    { ...DONE, id: 'old', started: (NOW - 26 * hour) / 1000, finished: (NOW - 25 * hour) / 1000 }]
  state.jobsRevision += 1
  await clock.advance(10_000)
  expect(ids()).toEqual(['recent'])
  // More than ten running stay whole: their badges and starters need them.
  state.jobs = [...Array.from({ length: 11 }, (_, index) => ({ ...RUNNING, id: `run-${index}`, started: (NOW - index * 1000) / 1000 })),
    { ...DONE, id: 'done-now', finished: NOW / 1000 }]
  state.jobsRevision += 1
  await clock.advance(10_000)
  expect(ids()).toEqual(Array.from({ length: 11 }, (_, index) => `run-${index}`))
})

// MARK: - Starter answers

test('only the delegate tool answer names a starter: a tab that printed the id, or a longer id, does not', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  // The waiting tab comes first in list order and printed `shiftover jobs`;
  // the analysis tab started another job whose id begins with this one's.
  printed(state, '/transcripts/1002.jsonl', RUNNING.id)
  mention(state, '/transcripts/1003.jsonl', `${RUNNING.id}-2`)
  mention(state, '/transcripts/1004.jsonl', RUNNING.id)
  await start($, clock)
  expect(grepCalls(state).map(call => call.argv)).toEqual([starterSearch(RUNNING.id)])
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  const tree = await ui.drawn()
  expect(subRows(tree, 'Needs approval')).toEqual([])
  expect(subRows(tree, 'Analysis tab')).toEqual([])
  expect(subRows(tree, 'Idle tab')).toEqual([expect.stringMatching(subRow('codex'))])
  await ui.press({ key: `job:${RUNNING.id}` })
  expect(actionCalls(state).map(call => call.argv)).toEqual([
    [CMUX, 'select-workspace', '--workspace', WS], [CMUX, 'focus-panel', '--panel', IDLE, '--workspace', WS]])
  await ui.unmount()
})

test('a compact delegate answer, as a structured tool result keeps it, names its starter too', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.transcripts.set('/transcripts/1003.jsonl', JSON.stringify({ type: 'user',
    toolUseResult: { job_id: RUNNING.id, status: 'running' } }))
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expect(subRows(await ui.drawn(), 'Analysis tab')).toEqual([expect.stringMatching(subRow('codex'))])
  await ui.unmount()
})

// MARK: - State others read

test('account emails never reach $.state, which any plugin may read', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  await start($, clock)
  expect(state.accounts.every(account => account.email.endsWith('@example.com'))).toBe(true)
  expect(state.snapshots.get('accounts')).toMatchObject({ shape: 'accounts-3', value: { list: [{ name: 'kadir' }, { name: 'aras' }] } })
  expect(JSON.stringify([...state.snapshots.values()])).not.toMatch(/@example\.com|"email"/)
})

test('a reload raises session.start again: an old accounts-1 value is declined, the fresh one has no email, one poller runs', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  // What the code before the reload stored, an email in it, and its open pane.
  state.isOpen = true
  on('state.get', { key: 'accounts' }, async (_, e, next) => state.snapshots.has('accounts') ? next(e) : { value: { value: {
    shape: 'accounts-1', value: { list: [{ name: 'kadir', email: 'old@example.com', dir: `${HOME}/.claude`, err: null,
      limits: [{ kind: 'session', model: '', used: 70, resetsAtMs: null }] }], current: 'kadir', at: NOW, error: null },
  }, version: 1 } })
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expect(accountFrame(await ui.drawn(), 'kadir')).toBeUndefined()
  expect(shownText(await ui.drawn())).not.toMatch(/70%/)
  // As the engine raises it for a module it loaded fresh.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  expect(statusCalls(state)).toHaveLength(1)
  expect(state.snapshots.get('accounts')).toMatchObject({ shape: 'accounts-3' })
  expect(JSON.stringify(state.snapshots.get('accounts'))).not.toMatch(/@example\.com|"email"/)
  expect(contentRows(accountCapsule(await ui.drawn(), 'aras'))[2]).toMatch(/10%.*75%.*92%/)
  const agentCalls = state.agentCalls
  await clock.advance(30_000)
  expect(state.agentCalls).toBe(agentCalls + 3)
  await ui.unmount()
})

// MARK: - Account errors

test('account errors read briefly: a renewing key, a needed login, an expired token, and the older words', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  const cases = [
    ['renew', 'oauth token renewing', 'anahtar yenileniyor'], ['yenile', 'anahtar yenileniyor (2/3)', 'anahtar yenileniyor'],
    ['both', 'HTTP 401 (token expired), renewing', 'anahtar yenileniyor'],
    ['login', 'login required', 'giriş gerekli'], ['giris', 'giriş gerekli', 'giriş gerekli'],
    ['expired', 'HTTP 401 (token expired)', 'yeniden giriş gerekli'], ['again', 'yeniden giriş gerekli', 'yeniden giriş gerekli'],
    ['busy', 'HTTP 429', 'şu an okunamıyor'], ['out', 'not logged in', 'giriş yapılmamış'], ['slow', 'request timed out', 'zaman aşımı'],
  ] as const
  state.accounts = cases.map(([name, err]) => ({ name, email: `${name}@example.com`, dir: `/${name}`, err }))
  await start($, clock)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  const tree = await ui.drawn()
  for (const [name, , shown] of cases) expect(contentRows(accountCapsule(tree, name)), name).toEqual([`○ ${name}`, shown])
  await ui.unmount()
})

// MARK: - Cache directory

test('chat models come from shiftover\'s session cache under XDG_CACHE_HOME, as its jobs do', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on, { XDG_CACHE_HOME: '/xdg' }); idle(state)
  state.sessions = { metadata: rawSession(IDLE, 1004) }
  state.chatFiles.set('/xdg/shiftover/sessions/metadata.json', { mtimeMs: 1,
    text: JSON.stringify({ model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' } }) })
  await start($, clock)
  const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: 76 }, surface: 'terminal' })
  expect(await rowText(ui, /^kadir · Opus 5\.5$/)).toBeDefined()
  expect(state.reads).toContain('list:/xdg/shiftover/jobs')
  expect(state.reads.filter(path => path.startsWith(`read:${HOME}/.cache/`))).toEqual([])
  await ui.unmount()
})

// MARK: - Delegate steps

const assistantBlocks = (...content: Record<string, unknown>[]): string => JSON.stringify({ type: 'assistant', message: { content } })
const toolUse = (name: string, input: Record<string, unknown>): string => assistantBlocks({ type: 'tool_use', name, input })
const codexItem = (type: string, item: Record<string, unknown>): string => JSON.stringify({ type, item })

test('a claude step reads the last assistant block: the tool with its file or command, text or thinking', async () => {
  for (const [line, step] of [
    [toolUse('Edit', { file_path: '/x/hooks/register.tsx' }), 'register.tsx düzenleniyor'],
    [toolUse('Write', { file_path: '/x/README.md' }), 'README.md düzenleniyor'],
    [toolUse('MultiEdit', { file_path: '/x/a.ts', edits: [] }), 'a.ts düzenleniyor'],
    [toolUse('NotebookEdit', { notebook_path: '/x/n.ipynb' }), 'n.ipynb düzenleniyor'],
    [toolUse('Read', { file_path: '/x/hooks/sessions.ts' }), 'sessions.ts okunuyor'],
    [toolUse('Grep', { pattern: 'isVisible' }), 'aranıyor'], [toolUse('Glob', { pattern: '**/*.ts' }), 'aranıyor'],
    [toolUse('Bash', { command: 'npx -y -p typescript@5.9.3 tsc -p .' }), 'testler çalışıyor'],
    [toolUse('Bash', { command: 'claude plugin test .' }), 'testler çalışıyor'],
    [toolUse('Bash', { command: 'git status' }), 'komut çalışıyor'],
    [toolUse('Agent', { prompt: 'look' }), 'alt ajan çalışıyor'], [toolUse('Task', { prompt: 'look' }), 'alt ajan çalışıyor'],
    [assistantBlocks({ type: 'text', text: 'Bitti.' }), 'yazıyor'],
    [assistantBlocks({ type: 'thinking', thinking: '…' }), 'düşünüyor'],
    [toolUse('NewTool', { x: 1 }), 'çalışıyor'],
    [toolUse('Edit', {}), 'çalışıyor'],
  ] as const) expect(claudeStep(`${line}\n`), line).toBe(step)
  // The last assistant line counts, past the tool's result; of its blocks, the last.
  expect(claudeStep([toolUse('Read', { file_path: '/a/b.ts' }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } })].join('\n'))).toBe('b.ts okunuyor')
  expect(claudeStep(assistantBlocks({ type: 'thinking' }, { type: 'tool_use', name: 'Grep', input: {} }))).toBe('aranıyor')
  // A tail cut mid-line drops its first line; one with no assistant line
  // names no step.
  expect(claudeStep(`${toolUse('Edit', { file_path: '/x/cut.ts' })}\n`, true)).toBeNull()
  expect(claudeStep('')).toBeNull()
  expect(claudeStep(`${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } })}\n`)).toBeNull()
})

test('the web, plan, skill, MCP and question tools say what they do', async () => {
  for (const [name, step] of [
    ['WebSearch', "web'de arıyor"], ['WebFetch', "web'de arıyor"], ['TodoWrite', 'plan güncelleniyor'],
    ['Skill', 'beceri kullanıyor'], ['mcp__firecrawl__scrape', 'araç kullanıyor'], ['mcp__claude_ai_Gmail__search', 'araç kullanıyor'],
    ['AskUserQuestion', 'soru soruyor'], ['mcp', 'çalışıyor'], ['toString', 'çalışıyor'], ['__proto__', 'çalışıyor'],
  ] as const) expect(claudeStep(`${toolUse(name, {})}\n`), name).toBe(step)
})

test('a command reads as tests running when a test, typecheck or build tool runs it', async () => {
  for (const command of ['npm test', 'bun test --watch', 'pytest -q tests/', 'npx tsc --noEmit', 'npx jest', 'vitest run',
    'claude plugin test .', 'xcodebuild -scheme App test', './gradlew build', 'gradle test', 'go test ./...', 'pnpm run test:unit']) {
    expect(commandStep(command), command).toBe('testler çalışıyor')
  }
  for (const command of ['git status', 'cat test.txt', 'ls tests-old', 'rg testing', 'npm run lint', 'swift build']) {
    expect(commandStep(command), command).toBe('komut çalışıyor')
  }
})

test('a codex step reads the last item: a command, a file change, a message or reasoning', async () => {
  for (const [line, step] of [
    [codexItem('item.started', { id: 'a', type: 'command_execution', command: "bash -lc 'npm test'" }), 'testler çalışıyor'],
    [codexItem('item.completed', { type: 'command_execution', command: ['bash', '-lc', 'ls -la'] }), 'komut çalışıyor'],
    [codexItem('item.started', { type: 'file_change', changes: [{ path: '/x/a.ts', kind: 'update' },
      { path: '/x/hooks/register.tsx', kind: 'update' }] }), 'register.tsx düzenleniyor'],
    [codexItem('item.completed', { type: 'agent_message', text: 'Bitti.' }), 'yazıyor'],
    [codexItem('item.completed', { type: 'reasoning', text: '…' }), 'düşünüyor'],
    [codexItem('item.completed', { item_type: 'reasoning', text: '…' }), 'düşünüyor'],
    [codexItem('item.started', { type: 'mcp_tool_call', server: 'x' }), 'çalışıyor'],
  ] as const) expect(codexStep(`${codexLine('turn.started')}\n${line}\n${codexLine('turn.started')}\n`), line).toBe(step)
  // No item yet names no step.
  expect(codexStep(`${codexLine('thread.started')}\n${codexLine('turn.started')}\n`)).toBeNull()
})

test('a cwd names its session folder with / and . made -, its other characters tried both ways', async () => {
  expect(projectFolders('/Users/kadir/Documents/claude-mods/work/shiftover-panel'))
    .toEqual(['-Users-kadir-Documents-claude-mods-work-shiftover-panel'])
  expect(projectFolders('/Users/k/my_app.v2/')).toEqual(['-Users-k-my-app-v2', '-Users-k-my_app-v2'])
  expect(projectFolders('/Users/k/Belgeler/şirket app')).toEqual(['-Users-k-Belgeler--irket-app', '-Users-k-Belgeler-şirket app'])
})

test('a claude delegate\'s row says its step from its live transcript, read again only after it changes', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  const transcript = `${HOME}/.claude-aras/projects/-Users-k-project/delegate.jsonl`
  state.jobs = [{ ...RUNNING, id: 'claude-job', account: 'aras', parent_session_id: 'idle-session', transcript_path: transcript }]
  const file = { mtimeMs: NOW - 1000, text: `${toolUse('Edit', { file_path: '/Users/k/project/hooks/register.tsx' })}\n` }
  state.chatFiles.set(transcript, file)
  await start($, clock)
  const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: 76 }, surface: 'terminal' })
  expect(subRows(await ui.drawn(), 'Idle tab')).toEqual([expect.stringMatching(subRow('aras', 'register.tsx düzenleniyor'))])
  expect(state.snapshots.get('jobs')).toMatchObject({ value: { list: [{ id: 'claude-job', step: 'register.tsx düzenleniyor' }] } })
  const tails = () => tailCalls(state).filter(call => call.argv.includes(transcript)).length
  expect(tails()).toBe(1)
  await clock.advance(20_000)
  expect(tails()).toBe(1)
  file.text += `${toolUse('Bash', { command: 'claude plugin test .' })}\n`; file.mtimeMs = clock.now()
  await clock.advance(10_000)
  expect(tails()).toBe(2)
  expect(subRows(await ui.drawn(), 'Idle tab')).toEqual([expect.stringMatching(subRow('aras', 'testler çalışıyor'))])
  await ui.unmount()
})

test('a codex delegate\'s row says its step from its .out, the one tail that also tells how it ended', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.jobs = [{ ...RUNNING, parent_session_id: 'idle-session' }]
  const out = { mtimeMs: NOW - 1000, text: `${codexLine('turn.started')}\n${codexItem('item.started',
    { type: 'file_change', changes: [{ path: '/Users/k/project/hooks/sessions.ts', kind: 'update' }] })}\n` }
  state.outs.set(RUNNING.id, out)
  await start($, clock)
  const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: 76 }, surface: 'terminal' })
  expect(subRows(await ui.drawn(), 'Idle tab')).toEqual([expect.stringMatching(subRow('codex', 'sessions.ts düzenleniyor'))])
  // At 42 columns the step is cut to the row, with an ellipsis.
  const narrow = await mount($,{ ...PANE, surface: 'desktop' })
  expect(subRows(await narrow.drawn(), 'Idle tab')).toEqual([expect.stringMatching(/^└ . codex  sessions\.ts düzenleniy…$/)])
  expect(cells(subRows(await narrow.drawn(), 'Idle tab')[0]!)).toBe(34)
  await narrow.unmount()
  expect(tailCalls(state).map(call => call.argv)).toEqual([['tail', '-c', '262144', '--', `${JOBS}/${RUNNING.id}.out`]])
  out.text += `${codexItem('item.started', { type: 'command_execution', command: "bash -lc 'npx vitest run'" })}\n`
  out.mtimeMs = clock.now()
  await clock.advance(10_000)
  expect(tailCalls(state)).toHaveLength(2)
  expect(subRows(await ui.drawn(), 'Idle tab')).toEqual([expect.stringMatching(subRow('codex', 'testler çalışıyor'))])
  await ui.unmount()
})

test('every changed end, .outs, transcripts and logs, is read by one tail a tick', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  const transcript = '/delegates/claude.jsonl'
  const log = '/delegates/codex.jsonl'
  state.jobs = [{ ...RUNNING, id: 'claude-job', account: 'aras', parent_pid: 1004, transcript_path: transcript },
    { ...RUNNING, id: 'codex-job', parent_pid: 1004, log_path: log }]
  state.chatFiles.set(transcript, { mtimeMs: NOW - 1000, text: `${assistantBlocks({ type: 'text', text: 'x' })}\n` })
  state.chatFiles.set(log, { mtimeMs: NOW - 1000, text: `${codexItem('item.completed', { type: 'reasoning', text: 'x' })}\n` })
  state.outs.set('claude-job', { mtimeMs: NOW - 1000, text: '' })
  state.outs.set('codex-job', { mtimeMs: NOW - 1000, text: `${codexLine('turn.started')}\n` })
  await start($, clock)
  expect(tailCalls(state).map(call => call.argv.slice(4).sort())).toEqual([[transcript, log,
    `${JOBS}/claude-job.out`, `${JOBS}/codex-job.out`].sort()])
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expect(subRows(await ui.drawn(), 'Idle tab').sort()).toEqual([expect.stringMatching(subRow('aras', 'yazıyor')),
    expect.stringMatching(subRow('codex', 'düşünüyor'))].sort())
  await clock.advance(30_000)
  expect(tailCalls(state)).toHaveLength(1)
  await ui.unmount()
})

for (const folderName of ['-Users-k-my-app-v2', '-Users-k-my_app-v2']) {
  test(`a claude delegate with no transcript path follows its account folder's newest session since it started (${folderName})`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW }); const state = world(on)
    const folder = `${HOME}/.claude-aras/projects/${folderName}`
    state.jobs = [{ ...RUNNING, id: 'found', account: 'aras', cwd: '/Users/k/my_app.v2', parent_session_id: 'idle-session',
      started: (NOW - 60_000) / 1000 }]
    // Older than the job, the delegate's own, and newer but an open chat's.
    state.chatFiles.set(`${folder}/before.jsonl`, { mtimeMs: NOW - 120_000, text: toolUse('Read', { file_path: '/x/old.ts' }) })
    state.chatFiles.set(`${folder}/delegate.jsonl`, { mtimeMs: NOW - 5_000, text: toolUse('Grep', { pattern: 'x' }) })
    state.chatFiles.set(`${folder}/chat.jsonl`, { mtimeMs: NOW - 1_000, text: toolUse('Edit', { file_path: '/x/chat.ts' }) })
    state.sessions['idle-session'] = { ...(state.sessions['idle-session'] as object), transcriptPath: `${folder}/chat.jsonl` }
    await start($, clock)
    // Until the open chats are known no folder is searched, so no open chat's
    // session passes for the delegate's.
    expect(state.reads).not.toContain(`list:${folder}`)
    await clock.advance(9_000)
    const ui = await mount($,{ ...PANE, surface: 'terminal' })
    expect(subRows(await ui.drawn(), 'Idle tab')).toEqual([expect.stringMatching(subRow('aras', 'aranıyor'))])
    expect(state.reads).toContain(`list:${folder}`)
    expect(tailCalls(state).some(call => call.argv.includes(`${folder}/delegate.jsonl`))).toBe(true)
    expect(tailCalls(state).some(call => call.argv.includes(`${folder}/before.jsonl`))).toBe(false)
    await ui.unmount()
  })
}

test('a job file\'s own config folder outranks its account\'s for the fallback session', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  const folder = '/other/claude/projects/-Users-k-project'
  state.jobs = [{ ...RUNNING, id: 'own-dir', account: 'aras', cwd: '/Users/k/project', dir: '/other/claude', parent_pid: 1004 }]
  state.chatFiles.set(`${folder}/delegate.jsonl`, { mtimeMs: NOW - 1_000, text: toolUse('Read', { file_path: '/x/notes.md' }) })
  await start($, clock)
  await clock.advance(9_000)
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expect(subRows(await ui.drawn(), 'Idle tab')).toEqual([expect.stringMatching(subRow('aras', 'notes\\.md okunuyor'))])
  expect(state.reads.some(path => path.startsWith(`list:${HOME}/.claude-aras/`))).toBe(false)
  await ui.unmount()
})

// A delegate's session as Claude Code 2.1.310 writes it: its title first,
// bookkeeping between turns, one block per assistant line, and a screenshot
// the delegate reads, whose result line and the next request's copy of it
// are each far longer than a tail.
const YUSA_SESSION = 'c6c67aef-8541-4084-b484-39497379bac0'
const ARAS_SESSION = '5cd70b5b-492e-4347-841f-4cc4ed4dc5fd'
const HOME_TAB = '88888888-8888-4888-8888-888888888888'
const titled = (label: string, sessionId: string): string[] => [
  JSON.stringify({ type: 'custom-title', customTitle: `delegate:${label}`, sessionId }),
  JSON.stringify({ type: 'agent-name', agentName: `delegate:${label}`, sessionId }),
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-26T15:08:40.988Z', sessionId }),
]
const said = (sessionId: string, block: Record<string, unknown>): string => JSON.stringify({ parentUuid: 'p', isSidechain: false,
  message: { model: 'claude-opus-5-5', type: 'message', role: 'assistant', content: [block], stop_reason: 'tool_use' },
  requestId: 'req', type: 'assistant', uuid: 'u', sessionId, version: '2.1.310' })
const between = (label: string, sessionId: string): string[] => [
  JSON.stringify({ type: 'api-request', sessionId, id: 'r', params: { model: 'claude-opus-5-5', output_config: { effort: 'max' } } }),
  JSON.stringify({ type: 'last-prompt', lastPrompt: 'Implement GitHub issue #107…', sessionId }),
  JSON.stringify({ type: 'custom-title', customTitle: `delegate:${label}`, sessionId }),
  JSON.stringify({ type: 'agent-name', agentName: `delegate:${label}`, sessionId }),
  JSON.stringify({ type: 'atis-latch', atis: '', sessionId }),
]
const screenshot = (sessionId: string, bytes: number): string[] => {
  const image = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo'.padEnd(bytes, 'A') } }]
  return [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: image }] }, sessionId }),
    JSON.stringify({ type: 'attachment', attachment: { type: 'total_tokens_reminder', text: '<total_tokens>…' }, sessionId }),
    JSON.stringify({ type: 'api-request-blob', sessionId, hash: 'h', message: { role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't', content: image }] } }),
  ]
}
const lines = (...rows: string[]): string => `${rows.join('\n')}\n`

test('a session names its delegate in its first lines; a head with no whole line yet names nothing', async () => {
  expect(delegateLabel(lines(...titled('verify seedance notes', ARAS_SESSION)))).toBe('verify seedance notes')
  expect(delegateLabel(JSON.stringify({ type: 'agent-name', agentName: 'delegate: spaced ' }))).toBe('spaced')
  expect(delegateLabel(lines(JSON.stringify({ type: 'queue-operation' }), JSON.stringify({ type: 'custom-title', customTitle: 'Benim adım' }))))
    .toBeNull()
  expect(delegateLabel('')).toBeUndefined()
  expect(delegateLabel('{"type":"custom-title","customTitle":"deleg')).toBeUndefined()
})

test('a delegate whose session ends in a screenshot and its copy keeps its last step: the lines it gained are read further back', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  const label = 'muslimcar #107 welcome screen code'
  const folder = `${HOME}/.claude-hesap3/projects/-Users-k-muslimcarplay-worktrees-107-welcome-screen`
  const path = `${folder}/${YUSA_SESSION}.jsonl`
  // As its job file has it: the account's config folder, no transcript path.
  state.jobs = [{ ...RUNNING, id: '20261026-174431-9dd9', account: 'yusa', model: 'opus', backend: 'claude', label,
    dir: `${HOME}/.claude-hesap3`, cwd: '/Users/k/muslimcarplay-worktrees/107-welcome-screen', parent_session_id: 'idle-session',
    started: (NOW - 600_000) / 1000 }]
  const file = { mtimeMs: NOW - 2_000, text: lines(...titled(label, YUSA_SESSION),
    said(YUSA_SESSION, { type: 'thinking', thinking: '', signature: 'sig' }),
    said(YUSA_SESSION, { type: 'tool_use', name: 'Bash', input: { command: "sed -i '' 's/a/b/' Welcome.swift && xcodebuild build" } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'build exit 0' }] } }),
    ...between(label, YUSA_SESSION),
    said(YUSA_SESSION, { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/107-work/shots/dt-ax5-bottom-small.png' } }),
    ...screenshot(YUSA_SESSION, 200_000)) }
  state.chatFiles.set(path, file)
  const reads = () => tailCalls(state).filter(call => call.argv.includes(path)).map(call => Number(call.argv[2]))
  const step = () => (state.snapshots.get('jobs') as { value: { list: { step?: string }[] } }).value.list[0]?.step
  await start($, clock)
  await clock.advance(9_000)
  // Its end, a tail's worth inside the screenshot, names no step: all of it
  // is read once, and the screenshot's Read is the step.
  expect(reads()).toEqual([262_144, file.text.length + 1])
  expect(step()).toBe('dt-ax5-bottom-small.png okunuyor')
  const ui = await mount($, { ...PANE, props: { ...PANE.props, bodyColumns: 76 }, surface: 'terminal' })
  expect(subRows(await ui.drawn(), 'Idle tab')).toEqual([expect.stringMatching(subRow('yusa', 'dt-ax5-bottom-small\\.png okunuyor'))])
  // Another screenshot and no step since: only what it gained is read, and
  // the step stays.
  let size = file.text.length
  file.text += lines(...screenshot(YUSA_SESSION, 150_000)); file.mtimeMs = clock.now()
  await clock.advance(10_000)
  expect(reads().slice(2)).toEqual([262_144, file.text.length - size + 1])
  expect(step()).toBe('dt-ax5-bottom-small.png okunuyor')
  // A test run, then a screenshot over it: the run is found behind it.
  size = file.text.length
  file.text += lines(...between(label, YUSA_SESSION), said(YUSA_SESSION, { type: 'tool_use', name: 'Bash',
    input: { command: 'xcodebuild -scheme MuslimCarPlay test' } }), ...screenshot(YUSA_SESSION, 150_000))
  file.mtimeMs = clock.now()
  await clock.advance(10_000)
  expect(reads().slice(4)).toEqual([262_144, file.text.length - size + 1])
  expect(step()).toBe('testler çalışıyor')
  // A step within a tail's reach needs no more.
  file.text += lines(...between(label, YUSA_SESSION), said(YUSA_SESSION, { type: 'thinking', thinking: '', signature: 's' }))
  file.mtimeMs = clock.now()
  await clock.advance(10_000)
  expect(reads().slice(6)).toEqual([262_144])
  expect(subRows(await ui.drawn(), 'Idle tab')).toEqual([expect.stringMatching(subRow('yusa', 'düşünüyor'))])
  // Its head is read once: it never changes.
  expect(headCalls(state).map(call => call.argv)).toEqual([['head', '-c', '16384', '--', path]])
  await ui.unmount()
})

test('a WebFetch delegate in the home folder every account shares reads web\'de arıyor from its own session alone', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  const label = 'verify seedance notes'
  const folder = `${HOME}/.claude-hesap2/projects/-Users-k`
  const own = `${folder}/${ARAS_SESSION}.jsonl`
  state.jobs = [{ ...RUNNING, id: '20261026-180839-fa03', account: 'aras', model: 'opus', backend: 'claude', label,
    dir: `${HOME}/.claude-hesap2`, cwd: HOME, parent_session_id: 'idle-session', started: (NOW - 300_000) / 1000 }]
  state.chatFiles.set(own, { mtimeMs: NOW - 3_000, text: lines(...titled(label, ARAS_SESSION),
    said(ARAS_SESSION, { type: 'thinking', thinking: '', signature: 'sig' }),
    said(ARAS_SESSION, { type: 'tool_use', name: 'WebFetch', input: { url: 'https://seed.bytedance.com', prompt: 'notes' } }),
    said(ARAS_SESSION, { type: 'tool_use', name: 'WebFetch', input: { url: 'https://docs.byteplus.com', prompt: 'notes' } }),
    ...between(label, ARAS_SESSION)) })
  // Newer: an open chat in the same folder, its path spelled under another
  // account's config folder, and another delegate's session.
  state.panels = [...state.panels, { id: HOME_TAB, title: 'Home chat' }]
  state.sessions['home-chat'] = rawSession(HOME_TAB, 1007, { cwd: HOME, transcriptPath: `${HOME}/.claude/projects/-Users-k/home-chat.jsonl` })
  state.alivePids.add(1007)
  state.chatFiles.set(`${folder}/home-chat.jsonl`, { mtimeMs: NOW - 1_000, text: lines(
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }), assistantBlocks({ type: 'text', text: 'Merhaba' })) })
  state.chatFiles.set(`${folder}/other.jsonl`, { mtimeMs: NOW - 500, text: lines(...titled('another job', 'other'),
    toolUse('Edit', { file_path: '/x/other.ts' })) })
  // Older than the job: no candidate at all.
  state.chatFiles.set(`${folder}/old.jsonl`, { mtimeMs: NOW - 900_000, text: lines(toolUse('Read', { file_path: '/x/old.ts' })) })
  await start($, clock)
  await clock.advance(9_000)
  const ui = await mount($, { ...PANE, surface: 'terminal' })
  expect(subRows(await ui.drawn(), 'Idle tab')).toEqual([expect.stringMatching(subRow('aras', "web'de arıyor"))])
  // Only the two candidates' heads are read, in one head; only its own end.
  expect(headCalls(state).map(call => call.argv.slice(0, 4))).toEqual([['head', '-c', '16384', '--']])
  expect(headCalls(state).flatMap(call => call.argv.slice(4)).sort()).toEqual([own, `${folder}/other.jsonl`].sort())
  const tailed = tailCalls(state).flatMap(call => call.argv.slice(4))
  expect(tailed).toContain(own)
  for (const name of ['home-chat', 'other', 'old']) expect(tailed).not.toContain(`${folder}/${name}.jsonl`)
  await clock.advance(30_000)
  expect(headCalls(state)).toHaveLength(1)
  await ui.unmount()
})

test('pressing a delegate row opens a cmux tab in its chat\'s workspace that follows the job live', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.jobs = [{ ...RUNNING, parent_session_id: 'idle-session' }, { ...RUNNING, id: "odd id's", parent_session_id: 'idle-session' }]
  await start($, clock)
  for (const surface of SURFACES) {
    const ui = await mount($,{ ...PANE, surface })
    expect(followButtons(await ui.drawn(), 'Idle tab').map(node => node.props?.key)).toEqual([`follow:${RUNNING.id}`, "follow:odd id's"])
    const before = surfaceCalls(state).length
    await ui.press({ key: `follow:${RUNNING.id}` })
    expect(surfaceCalls(state).slice(before).map(call => call.argv)).toEqual([[CMUX, 'new-surface', '--workspace', WS,
      '--command', `${HOME}/.local/bin/shiftover jobs follow ${RUNNING.id}`, '--focus', 'true']])
    await ui.unmount()
  }
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  // An id a shell would split stays one word.
  await ui.press({ key: "follow:odd id's" })
  expect(surfaceCalls(state).slice(-1)[0]?.argv[5]).toBe(`${HOME}/.local/bin/shiftover jobs follow 'odd id'\\''s'`)
  // The row neither focuses the chat nor is the chat's Button; that one still does.
  expect(actionCalls(state)).toHaveLength(0)
  await ui.press({ key: 'chat:idle-session' })
  expect(actionCalls(state).map(call => call.argv)).toEqual([
    [CMUX, 'select-workspace', '--workspace', WS], [CMUX, 'focus-panel', '--panel', IDLE, '--workspace', WS]])
  // A tab cmux would not open says so.
  state.isFocusDown = true
  await ui.press({ key: `follow:${RUNNING.id}` })
  expect(state.toasts).toEqual(['sekme açılamadı'])
  await ui.unmount()
})

test('the current chat shows its delegates as rows too, and a job whose starter tab closed stays only in İşler', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.jobs = [{ ...RUNNING, parent_session_id: 'current-session' },
    { ...RUNNING, id: 'orphan', label: 'yetim iş', account: 'aras', parent_session_id: 'closed-session', parent_pid: 1005 }]
  await start($, clock)
  for (const surface of SURFACES) {
    const ui = await mount($,{ ...PANE, surface })
    const hasClient = surface === 'terminal' || surface === 'desktop'
    const tree = await ui.drawn()
    const current = capsuleFor(tree, 'Current tab')!
    // Its own lines press nothing; the row, under them, is a target of its
    // own: a part of the capsule module's region, else the one Button.
    expect(followButtons(tree, 'Current tab').map(node => node.props?.key)).toEqual([`follow:${RUNNING.id}`])
    expect(lineButtons(current).map(node => node.props?.key)).toEqual(hasClient ? [] : [`follow:${RUNNING.id}`])
    expect(subRows(tree, 'Current tab')).toEqual([expect.stringMatching(subRow('codex'))])
    expect(capsuleBorder(tree, 'Current tab')?.props).toMatchObject({ borderColor: 'claude', paddingX: hasClient ? 1 : 0 })
    expect(capsuleBorder(tree, 'Current tab')?.hover).toBeUndefined()
    const rows = laidOutRows(current, 38)
    expect(rows.slice(1, 4).map(row => row.slice(0, 4))).toEqual(['│ ○ ', '│ ka', '│ bu'])
    expect(rows).toHaveLength(6)
    // The orphan has no chat to sit under: İşler alone lists it.
    for (const title of ['Needs approval', 'Analysis tab', 'Idle tab']) expect(subRows(tree, title)).toEqual([])
    expect(await rowText(ui, /yetim iş/)).toMatch(/yetim iş.*›$/)
    expect(coveredButtons(tree, 42)).toEqual([])
    await ui.unmount()
  }
})

test('a delegate row is its own part of the chat\'s region: over it the border lights, a click follows the job, by the row it hit', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.jobs = [{ ...RUNNING, parent_session_id: 'idle-session' }, { ...RUNNING, id: 'mine', parent_session_id: 'current-session' }]
  await start($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, { ...PANE, surface })
    const region = async (key: string) => await ui.drawn({ in: key }) as DrawnNode
    const click = async (key: string, y: number, button: 'left' | 'middle' | 'right' = 'left', to = y) => {
      await ui.pointer({ type: 'down', x: 4, y, button, in: key })
      await ui.pointer({ type: 'up', x: 4, y: to, button, in: key })
    }
    // Rows 1 to 3 are the chat's own lines, row 4 the delegate's.
    const idle = await region('chat:idle-session')
    expect(rowIn(idle, `follow:${RUNNING.id}`)).toBe(4)
    expect(laidOutRows(idle, 38)[4]).toMatch(new RegExp(`^│ ${subRow('codex').source.slice(1, -1)} *│$`))
    const follows = () => surfaceCalls(state).map(call => call.argv[5])
    const focuses = () => actionCalls(state).length
    let [followed, focused] = [follows().length, focuses()]
    // The current chat: its lines neither light nor press; its row does both.
    for (const [y, color] of [[1, 'claude'], [4, 'text'], [2, 'claude'], [5, 'claude']] as const) {
      await ui.pointer({ type: y === 1 ? 'enter' : 'move', x: 6, y, in: 'chat:current-session' })
      expect((await region('chat:current-session')).props?.borderColor).toBe(color)
    }
    await click('chat:current-session', 1)
    expect([follows().length, focuses()]).toEqual([followed, focused])
    await click('chat:current-session', 4)
    expect(follows().slice(followed)).toEqual([`${HOME}/.local/bin/shiftover jobs follow mine`])
    // Another chat: its lines focus its tab, its row follows its own job.
    ;[followed, focused] = [follows().length, focuses()]
    const before = JSON.stringify((await region('chat:idle-session')).children)
    await ui.pointer({ type: 'enter', x: 6, y: 4, in: 'chat:idle-session' })
    expect((await region('chat:idle-session')).props?.borderColor).toBe('text')
    expect(JSON.stringify((await region('chat:idle-session')).children)).toBe(before)
    await click('chat:idle-session', 4)
    expect(follows().slice(followed)).toEqual([`${HOME}/.local/bin/shiftover jobs follow ${RUNNING.id}`])
    expect(focuses()).toBe(focused)
    await click('chat:idle-session', 1)
    expect(focuses()).toBe(focused + 2)
    // A right or middle click does nothing; nor does a press let go elsewhere.
    ;[followed, focused] = [follows().length, focuses()]
    await click('chat:idle-session', 1, 'right'); await click('chat:idle-session', 4, 'middle')
    await click('chat:idle-session', 1, 'left', 4); await click('chat:idle-session', 4, 'left', 9)
    expect([follows().length, focuses()]).toEqual([followed, focused])
    await ui.unmount()
  }
})

test('without the capsule module a delegate row has its own keyed Box: hover and focus mute it alone and light the chat\'s border', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  on('ui.focus', () => ({}))
  state.jobs = [{ ...RUNNING, parent_session_id: 'idle-session' }]
  await start($, clock)
  const ui = await mount($,{ ...PANE, props: { ...PANE.props, isFocused: true }, surface: 'vscode' })
  let tree = await ui.drawn()
  const row = followButtons(tree, 'Idle tab')[0]!
  const target = drawnNodes(capsuleFor(tree, 'Idle tab')).find(node => (node.children ?? []).includes(row))!
  expect(target.props).toMatchObject({ key: `target:follow:${RUNNING.id}` })
  expect(row.hover).toEqual({ color: 'inactive' })
  expect(drawnNodes(row).filter(node => node.type === 'Text').every(node => node.hover?.color === 'inactive')).toBe(true)
  expect(contentRows(row)).toHaveLength(1)
  expect(cells(shownText(row))).toBe(36)
  expect(coveredButtons(tree, 42)).toEqual([])
  await $.ui.focus({ component: 'Pane', requestId: 'shiftover-panel', plugin: 'shiftover-panel',
    element: `follow:${RUNNING.id}`, origin: { kind: 'person' } })
  await clock.advance(100)
  tree = await ui.drawn()
  expect(capsuleBorder(tree, 'Idle tab')?.props?.borderColor).toBe('text')
  const muted = drawnNodes(followButtons(tree, 'Idle tab')[0]).filter(node => node.type === 'Text' && node.props?.color === 'inactive')
  expect(muted.map(shownText).join('')).toBe(shownText(followButtons(tree, 'Idle tab')[0]))
  // The chat's own lines stay as they were.
  expect(drawnNodes(lineButtons(capsuleFor(tree, 'Idle tab')).find(node => node.props?.key === 'chat:idle-session'))
    .some(node => node.type === 'Text' && node.props?.color === 'inactive')).toBe(false)
  await ui.unmount()
})

test('delegate steps are read only while the pane shows: hidden, no stat, listing or tail of a transcript or log', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  const transcript = `${HOME}/.claude-aras/projects/-Users-k-project/delegate.jsonl`
  state.jobs = [{ ...RUNNING, id: 'claude-job', account: 'aras', parent_session_id: 'idle-session', transcript_path: transcript },
    { ...RUNNING, id: 'fallback-job', account: 'aras', cwd: '/Users/k/project', parent_pid: 1004 },
    { ...RUNNING, id: 'codex-job', parent_pid: 1004, log_path: '/delegates/codex.jsonl' }]
  const file = { mtimeMs: NOW - 1000, text: `${toolUse('Read', { file_path: '/x/a.ts' })}\n` }
  state.chatFiles.set(transcript, file)
  await start($, clock)
  expect(state.reads.some(path => path === `stat:${transcript}`)).toBe(true)
  state.isShown = false
  await clock.advance(10_000)
  const reads = state.reads.length
  const calls = state.calls.length
  file.text += `${toolUse('Grep', { pattern: 'x' })}\n`; file.mtimeMs = NOW + 5_000
  await clock.advance(60_000)
  expect(state.reads.slice(reads)).toEqual([])
  expect(state.calls.slice(calls)).toEqual([])
  // Shown again, the changed transcript is read at once.
  state.isShown = true
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  await clock.advance(1)
  expect(tailCalls(state).slice(-1)[0]?.argv).toContain(transcript)
  expect(subRows(await ui.drawn(), 'Idle tab')[0]).toMatch(subRow('aras', 'aranıyor'))
  await ui.unmount()
})

// MARK: - Chat titles

test('a plain shell\'s tab title is no chat title', async () => {
  for (const title of ['kadir@Kadirs-MacBook-Pro:~', 'kadir@host: ~/Documents/project', 'user@host', '~/Documents/x', '/Users/k', '~',
    'zsh', '-zsh', 'bash', 'fish']) expect(isShellTitle(title), title).toBe(true)
  for (const title of ['Analysis tab', '✳ Refactor auth', 'Fix login@home page', 'tests: green']) {
    expect(isShellTitle(title), title).toBe(false)
  }
  const tail = [JSON.stringify({ type: 'ai-title', aiTitle: 'Eski AI' }), JSON.stringify({ type: 'custom-title', customTitle: 'Eski ad' }),
    assistantLine('claude-opus-5-5', 'high'), JSON.stringify({ type: 'ai-title', aiTitle: 'Yeni AI' }),
    JSON.stringify({ type: 'custom-title', customTitle: ' Yeni ad ' })].join('\n')
  expect(parseTranscriptTail(tail)).toEqual({ model: 'claude-opus-5-5', effort: 'high', customTitle: 'Yeni ad', aiTitle: 'Yeni AI' })
})

test('a chat\'s title is its /rename, else its tab title unless a shell\'s, else Claude\'s own, else its folder', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.panels = state.panels.map(panel => panel.id === IDLE ? { ...panel, title: 'kadir@Kadirs-MacBook-Pro:~/project' }
    : panel.id === RUNNER ? { ...panel, title: 'zsh' } : panel)
  const transcript = (pid: number, ...rows: object[]) => {
    const file = { mtimeMs: NOW - pid, text: `${rows.map(row => JSON.stringify(row)).join('\n')}\n` }
    state.chatFiles.set(`/transcripts/${pid}.jsonl`, file)
    return file
  }
  // Renamed twice, though its tab has a title of its own: the latest name.
  transcript(1002, { type: 'ai-title', aiTitle: 'AI başlığı' }, { type: 'custom-title', customTitle: 'Eski ad' },
    { type: 'custom-title', customTitle: 'Yeni ad' })
  // A shell's tab title: Claude's own title.
  const idleFile = transcript(1004, { type: 'ai-title', aiTitle: 'Önbellek düzeltmesi' })
  // A shell's tab title and no titles at all: the folder's name.
  transcript(1003, { type: 'user', message: { content: 'hi' } })
  await start($, clock)
  const titles = () => Object.fromEntries((state.snapshots.get('chats') as { value: { list: { id: string; title: string }[] } })
    .value.list.map(chat => [chat.id, chat.title]))
  expect(titles()).toEqual({ 'waiting-session': 'Yeni ad', 'idle-session': 'Önbellek düzeltmesi', 'runner-session': 'project',
    'current-session': 'Current tab' })
  const ui = await mount($,{ ...PANE, surface: 'terminal' })
  expect(await rowText(ui, /Önbellek düzeltmesi/)).toMatch(/^○ Önbellek düzeltmesi +›$/)
  // A /rename shows on the next tick, cmux not listed again.
  idleFile.text += `${JSON.stringify({ type: 'custom-title', customTitle: 'Yeniden adlandırıldı' })}\n`
  idleFile.mtimeMs = NOW + 1000
  await clock.advance(9_000)
  expect(titles()['idle-session']).toBe('Yeniden adlandırıldı')
  expect(await rowText(ui, /Yeniden adlandırıldı/)).toBeDefined()
  expect(cmuxCalls(state, 'list-workspaces')).toHaveLength(1)
  // A tail that no longer reaches the rename keeps it.
  idleFile.text = `${'x'.repeat(300_000)}\n`; idleFile.mtimeMs = NOW + 2000
  await clock.advance(10_000)
  expect(titles()['idle-session']).toBe('Yeniden adlandırıldı')
  await ui.unmount()
})

// MARK: - Display names

test('accounts draw their display name wherever one is set, else their name; Codex keeps its own', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.accounts = [{ ...STATUS[0]!, display: null }, { ...STATUS[1]!, display: 'mehemed' }]
  state.jobs = [{ ...RUNNING, id: 'aras-job', account: 'aras', label: 'aras işi', parent_session_id: 'idle-session' },
    { ...RUNNING, parent_session_id: 'idle-session' }]
  await start($, clock)
  expect(state.snapshots.get('accounts')).toMatchObject({ value: { list: [{ name: 'kadir', display: null },
    { name: 'aras', display: 'mehemed' }] } })
  expect(JSON.stringify(state.snapshots.get('accounts'))).not.toMatch(/@example\.com/)
  for (const width of [42, 76]) {
    const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
    const tree = await ui.drawn()
    // Hesaplar: the display name, else the name; the codex row as it was.
    expect(accountCapsule(tree, 'mehemed')).toBeDefined()
    expect(accountCapsule(tree, 'aras')).toBeUndefined()
    expect(accountCapsule(tree, 'kadir')).toBeDefined()
    expect(accountCapsule(tree, 'codex')).toBeDefined()
    // The chat's second line, the job's in İşler and the delegate row.
    expect(contentRows(capsuleFor(tree, 'Idle tab'))[1]).toBe('mehemed')
    expect(await rowText(ui, /^mehemed · \d+ sn$/)).toBeDefined()
    expect(subRows(tree, 'Idle tab').sort()).toEqual([expect.stringMatching(subRow('codex')), expect.stringMatching(subRow('mehemed'))].sort())
    expect(laidOutRows(tree, width).every(row => cells(row) <= width)).toBe(true)
    await ui.unmount()
  }
  // Collapsed, the summary names it the same way.
  const ui = await mount($,{ ...PANE, props: { ...PANE.props, bodyColumns: 76 }, surface: 'terminal' })
  await ui.press({ key: 'accounts:toggle' }); await clock.settle()
  expect(summaryRows(await ui.drawn())).toEqual(['● kadir ?  ○ mehemed 92%  ◎ codex ?'])
  await ui.unmount()
})
