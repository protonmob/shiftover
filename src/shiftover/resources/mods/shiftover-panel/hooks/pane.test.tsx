import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { AgentInfo, On, SessionUsage, TurnUsage } from 'claude-code'
import { chatStatus, parsePanels, parseSessions, parseWorkspaces } from './sessions'

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
type RawAccount = { name: string; email: string; dir: string; err?: string; limits?: RawLimit[] }
type RawJob = {
  id: string; account: string; model: string | null; label: string; cwd?: string; status: string;
  pid: number; started: number; finished: number; cost_usd: number | null; duration_ms: number | null;
}
const STATUS: RawAccount[] = [
  { name: 'kadir', email: '', dir: `${HOME}/.claude`, err: 'HTTP 401 (token expired)' },
  { name: 'aras', email: '', dir: `${HOME}/.claude-aras`, limits: [
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
const USAGE: SessionUsage = { startedAt: NOW - 3_600_000, context: { window: 1_000_000, tokens: 40_300, percent: 4 },
  rateLimits: [], cost: { usd: 0.32 } }
const TOKENS: TurnUsage = { model: 'claude-fable', input_tokens: 4_000, output_tokens: 300,
  cache_read_input_tokens: 34_000, cache_creation_input_tokens: 2_000 }
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
  isOpen: boolean; isPlaced: boolean; jobsRevision: number; sessionsRevision: number;
  accountsGate: Promise<void> | null; isShiftoverDown: boolean; isJobsDown: boolean; isJobGone: boolean;
  jobPsFailure: 'deny' | 'exit' | 'stderr' | null;
  isFocusDown: boolean; hasCmux: boolean; accounts: RawAccount[]; jobs: RawJob[]; agents: AgentInfo[];
  sessions: Record<string, unknown>; panels: { id: string; title: string }[]; alivePids: Set<number>;
  codexFiles: Map<string, { mtimeMs: number; text: string }>; grepMatches: string[];
  calls: ProcessCall[]; reads: string[]; usageCalls: unknown[]; agentCalls: number; toasts: string[]; views: unknown[];
  usage: SessionUsage; stepUsage: TurnUsage | null; stepStopped: boolean; snapshots: Map<string, unknown>;
}

// Every external operation is answered here, including click commands. No test
// reaches the owner's cmux process, transcripts, account files, or terminal.
function world(on: On, env: Record<string, string> = {}, isPlaced = true): World {
  const state: World = {
    isOpen: false, isPlaced, jobsRevision: 1, sessionsRevision: 1, accountsGate: null,
    isShiftoverDown: false, isJobsDown: false, isJobGone: false, isFocusDown: false, hasCmux: true,
    jobPsFailure: null,
    accounts: STATUS, jobs: [RUNNING, DONE], agents: [], panels: PANELS,
    sessions: {
      'current-session': rawSession(CURRENT, 1001),
      'idle-session': rawSession(IDLE, 1004, { launchCommand: { environment: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-aras` } } }),
      'runner-session': rawSession(RUNNER, 1003, { agentLifecycle: 'running', runtimeStatus: 'running' }),
      'waiting-session': rawSession(WAITING, 1002, { agentLifecycle: 'needsInput', hookEventName: 'Notification' }),
      'closed-session': rawSession(CLOSED, 1005), 'dead-session': rawSession(DEAD, 1006),
    },
    alivePids: new Set([1001, 1002, 1003, 1004]), codexFiles: new Map(), grepMatches: [],
    calls: [], reads: [], usageCalls: [], agentCalls: 0, toasts: [], views: [], usage: USAGE,
    stepUsage: TOKENS, stepStopped: true, snapshots: new Map(),
  }
  mock.env(on, { HOME, CMUX_SURFACE_ID: CURRENT, ...env })
  on('state.set', async (_, e, next) => {
    const result = await next(e)
    state.snapshots.set(e.key, e.value)
    return result
  })
  on('command.register', () => ({ value: { command: 'shiftover-panel' } }))
  on('command.run', () => ({ text: 'engine' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'current-session' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.step', async function* (_, e) {
    const usage = state.stepUsage
    const stopReason = state.stepStopped ? 'end_turn' as const : null
    yield { kind: 'stop' as const, stopReason, usage }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason, usage }
  })
  on('ui.open', () => {
    state.isOpen = true
    return { value: state.isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'below 144 columns' } }
  })
  on('ui.close', () => { state.isOpen = false; return { value: undefined } })
  on('ui.panes', () => ({ value: state.isOpen ? [{ id: 'shiftover-panel', title: 'Shiftover',
    isShown: true, isFocused: false, isPlaced: state.isPlaced }] : [] }))
  on('ui.toast', (_, e) => { state.toasts.push(e.text); return { value: undefined } })
  on('ui.view', (_, e) => { state.views.push(e); return { value: {} } })
  on('session.usage', (_, e) => { state.usageCalls.push(e); return { value: state.usage } })
  on('agent.list', () => { state.agentCalls += 1; return { value: state.agents } })
  on('fs.exists', (_, e) => {
    state.reads.push(`exists:${e.path}`)
    return { value: e.path === CMUX ? state.hasCmux : true }
  })
  on('fs.stat', (_, e) => {
    state.reads.push(`stat:${e.path}`)
    return { value: { kind: 'file', size: 100, mtimeMs: state.sessionsRevision, isLink: false } }
  })
  on('fs.list', (_, e) => {
    state.reads.push(`list:${e.path}`)
    if (e.path === JOBS) {
      if (state.isJobsDown) return { deny: 'jobs unavailable' }
      return { value: [...state.jobs.map(job => `${job.id}.json`), 'ignored.out'].map(name => ({
        name, kind: 'file' as const, size: 100, mtimeMs: state.jobsRevision, isLink: false,
      })) }
    }
    return { value: [...state.codexFiles.entries()].filter(([path]) => path.slice(0, path.lastIndexOf('/')) === e.path)
      .map(([path, file]) => ({ name: path.slice(path.lastIndexOf('/') + 1), kind: 'file' as const,
        size: file.text.length, mtimeMs: file.mtimeMs, isLink: false })) }
  })
  on('fs.read', (_, e) => {
    state.reads.push(`read:${e.path}`)
    if (e.path === CONFIG) return { value: CONFIG_TEXT }
    if (e.path === SESSIONS) return { value: JSON.stringify({ sessions: state.sessions }) }
    const codex = state.codexFiles.get(e.path)
    if (codex) return { value: codex.text }
    const job = state.jobs.find(candidate => e.path === `${JOBS}/${candidate.id}.json`)
    return job ? { value: JSON.stringify(job) } : { deny: `unexpected read ${e.path}` }
  })
  on('process.run', async (_, e) => {
    state.calls.push({ argv: [...e.argv], timeoutMs: e.init?.timeoutMs })
    if (e.argv[0] === 'ps') {
      if (e.argv.includes('pid=')) return ran(0, [...state.alivePids].join('\n'))
      if (state.jobPsFailure === 'deny') return { deny: 'ps not permitted' }
      if (state.jobPsFailure !== null) return ran(state.jobPsFailure === 'exit' ? 2 : 1, '', 'ps: operation not permitted\n')
      return state.isJobGone ? ran(1, '') : ran(0, '4242 /opt/bin/codex exec -\n')
    }
    if (e.argv[0] === 'grep') return ran(state.grepMatches.length > 0 ? 0 : 1, state.grepMatches.join('\n'))
    if (e.argv[1] === 'list-workspaces') return ran(0, `* workspace:1 ${WS} Main\n`)
    if (e.argv[1] === 'list-panels') return ran(0, state.panels.map((panel, index) =>
      `surface:${index + 1} ${panel.id} terminal ${index === 0 ? '[focused] ' : ''}${JSON.stringify(panel.title)}`).join('\n'))
    if (e.argv[1] === 'select-workspace' || e.argv[1] === 'focus-panel') return ran(state.isFocusDown ? 1 : 0, '')
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
    if (current.type === 'Text') return [shownText(node)]
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
type DrawnNode = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
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
const capsules = (tree: unknown): DrawnNode[] => drawnNodes(tree).filter(node =>
  node.type === 'Box' && node.props?.borderStyle === 'round' &&
  laidOutRows(node, Number(node.props.width ?? 0)).length === 4)
const capsuleFor = (tree: unknown, title: string): DrawnNode | undefined =>
  capsules(tree).find(node => shownText(node).includes(title))
const accountCapsule = (tree: unknown, name: string): DrawnNode | undefined => drawnNodes(tree).find(node =>
  node.type === 'Box' && node.props?.borderStyle === 'round' && node.props?.borderColor === 'subtle' &&
  ['●', '○', '◎'].some(marker => contentRows(node)[0] === `${marker} ${name}`))
const contentRows = (tree: unknown): string[] => {
  if (typeof tree !== 'object' || tree === null) return []
  const node = tree as DrawnNode
  return node.type === 'Text' ? [shownText(node)] : (node.children ?? []).flatMap(contentRows)
}
const start = async ($: Engine, clock: { settle: () => Promise<void>; advance: (ms: number) => Promise<void> }) => {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await clock.advance(1000)
}
const oneAccount = (limits: RawLimit[]): RawAccount[] => [{ name: 'kadir', email: '', dir: `${HOME}/.claude`, limits }]
const limit = (used: number, kind = 'session', model = ''): RawLimit => ({ kind, model, used, resets_at: null })
const idle = (state: World): void => { state.accounts = []; state.jobs = []; state.agents = []; state.sessions = {} }
const cmuxCalls = (state: World, command: string) => state.calls.filter(call => call.argv[1] === command)
const statusCalls = (state: World) => state.calls.filter(call => call.argv[1] === 'status')
const actionCalls = (state: World) => state.calls.filter(call => call.argv[1] === 'select-workspace' || call.argv[1] === 'focus-panel')
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

test('four compact cards and their round capsules render on every surface without wrapped rows', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); world(on)
  await start($, clock)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    for (const title of ['Oturum', 'Hesaplar', 'Sohbetler', 'İşler']) {
      expect(await rowText(ui, new RegExp(title))).toBeDefined()
      expect((await ui.findAll({ type: 'Text', text: new RegExp(`^ ${title} $`) })).some(node => node.props.weight === 'bold' && node.props.color === 'text')).toBe(true)
    }
    const cards = (await ui.findAll({ type: 'Box' })).filter(box => box.props.borderStyle === 'round' && box.props.width === 42)
    expect(cards).toHaveLength(4)
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

test('the session card uses local summary usage, API value, memory bar, and unavailable totals', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(state.usageCalls).toEqual([{ breakdown: 'summary' }])
  expect(await rowText(ui, /^API değeri$/)).toBeDefined()
  expect(await rowText(ui, /^sohbet boyu$/)).toBeDefined()
  expect(await rowText(ui, /önbellek/)).toBeDefined()
  expect(await rowText(ui, /\$0\.32/)).toBeDefined()
  expect(await rowText(ui, /hafıza %4/)).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: /^-$/ })).length).toBeGreaterThanOrEqual(2)
  await ui.unmount()
})

test('session stats preserve full labels and values in three, two plus one, or single capsule rows', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.usage = { ...USAGE, cost: { usd: 123456789.12 } }
  await start($, clock)
  for await (const _chunk of $.turn.step({ turnId: 'stats', index: 0, model: 'claude-fable', messageCount: 1 })) { /* exact totals */ }
  for (const [width, grouping] of [[42, [2, 1]], [32, [1, 1, 1]], [60, [3]]] as const) {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
    const tree = await ui.drawn()
    const stats = ['sohbet boyu', 'API değeri', 'önbellek'].map(label => capsuleFor(tree, label)!)
    expect(stats).toHaveLength(3)
    for (const [index, stat] of stats.entries()) {
      expect(stat).toBeDefined()
      expect(stat.props).toMatchObject({ borderColor: 'subtle', paddingX: 1, flexShrink: 0 })
      const rows = contentRows(stat)
      expect(rows).toEqual([['40.3k', '$123456789.12', '%85'][index], ['sohbet boyu', 'API değeri', 'önbellek'][index]])
      const room = Number(stat.props?.width) - 4
      expect(rows.every(row => cells(row) <= room && !row.includes('…'))).toBe(true)
      const texts = drawnNodes(stat).filter(node => node.type === 'Text')
      expect(texts.some(node => node.props?.weight === 'bold')).toBe(true)
      expect(texts.some(node => node.props?.dimColor === true)).toBe(true)
    }
    const rows = laidOutRows(tree, width)
    const labelRows = rows.filter(row => /sohbet boyu|API değeri|önbellek/.test(row))
    expect(labelRows.map(row => ['sohbet boyu', 'API değeri', 'önbellek'].filter(label => row.includes(label)).length)).toEqual([...grouping])
    expect(rows.filter(row => cells(row) > width)).toEqual([])
    const memoryAt = rows.findIndex(row => /hafıza %4/.test(row))
    expect(memoryAt).toBeGreaterThan(rows.findIndex(row => /önbellek/.test(row)))
    await ui.unmount()
  }
})

test('every account, Codex and memory bar uses fixed whole heavy-line cells with severity and subtle colors', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.accounts = oneAccount([limit(5), limit(73, 'weekly_all'), limit(96, 'weekly_scoped', 'Fable')])
  state.jobs = []; state.sessions = {}
  state.codexFiles.set(`${CODEX}/rates.jsonl`, { mtimeMs: 1, text: rateLine(
    { used_percent: 50, window_minutes: 300, resets_at: NOW / 1000 + 3600 },
    { used_percent: 90, window_minutes: 10080, resets_at: NOW / 1000 + 3600 }) })
  await start($, clock)
  for (const width of [42, 32, 60]) {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
    const rows = await paneRows(ui)
    expect(rows.join('')).not.toMatch(/[▏▎▍▌▋▊▉█░▁▇]/)
    const tree = await ui.drawn()
    const account = contentRows(accountCapsule(tree, 'kadir'))[1]!
    const codex = contentRows(accountCapsule(tree, 'codex'))[1]!
    const accountBox = accountCapsule(tree, 'kadir')!
    const accountRoom = Number(accountBox.props?.width) - 2 - 2 * Number(accountBox.props?.paddingX ?? 0)
    const miniCells = Math.floor((accountRoom - 2) / 3) - 5
    expect(account.match(/━+/g)?.map(bar => bar.length)).toEqual([miniCells, miniCells, miniCells])
    expect(codex.match(/━+/g)?.map(bar => bar.length)).toEqual([miniCells, miniCells])
    const bars = await ui.findAll({ type: 'Text', text: /^━+$/ })
    expect(bars.length).toBeGreaterThan(5)
    expect(bars.every(bar => ['success', 'warning', 'error', 'subtle'].includes(String(bar.props.color)))).toBe(true)
    expect(bars.some(bar => bar.props.color === 'subtle')).toBe(true)
    const lines = await ui.findAll({ type: 'Text', text: /^━+$/ })
    expect(lines.some(line => line.text.length === Math.round((width - 4 - 'hafıza %100'.length - 1) * .04) && line.props.color === 'success')).toBe(true)
    await clock.advance(2000)
    expect(contentRows(accountCapsule(await ui.drawn(), 'kadir'))[1]).toBe(account)
    await ui.unmount()
  }
})

test('context bars keep the same cell count across percent digit boundaries and missing usage', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on); idle(state)
  state.usage = { ...USAGE, context: { ...USAGE.context, percent: 9 } }
  await start($, clock)
  for (const width of [42, 32]) {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
    for (const percent of [9, 10, 100, null]) {
      state.usage = percent === null ? { ...USAGE, context: { window: USAGE.context.window } } : { ...USAGE, context: { ...USAGE.context, percent } }
      await clock.advance(10_000)
      const row = (await paneRows(ui)).find(line => /hafıza/.test(line))!
      expect(row.match(/━/g)).toHaveLength(width - 4 - 12)
      expect(cells(row)).toBe(width - 4)
      expect(row).toMatch(percent === null ? /hafıza -$/ : new RegExp(`hafıza %${percent}$`))
      expect(laidOutRows(await ui.drawn(), width).filter(line => cells(line) > width)).toEqual([])
    }
    await ui.unmount()
  }
})

test('session usage and agents refresh every ten seconds only while placed', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  await start($, clock)
  await clock.advance(9000)
  expect(state.usageCalls).toHaveLength(2)
  expect(state.agentCalls).toBe(2)
  state.isPlaced = false
  await clock.advance(30_000)
  expect(state.usageCalls).toHaveLength(2)
  expect(state.agentCalls).toBe(2)
  expect(state.usageCalls.every(call => (call as { breakdown: string }).breakdown === 'summary')).toBe(true)
})

test('per-response token and cache totals deduplicate stop/result, repeated steps, and turn aggregates', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.usage = { ...USAGE, context: { ...USAGE.context, tokens: 12_345 } }
  await start($, clock)
  const step = { turnId: 'turn-1', index: 0, model: 'claude-fable', messageCount: 2 }
  for await (const _chunk of $.turn.step(step)) { /* Drain the response, including its stop chunk. */ }
  for await (const _chunk of $.turn.step(step)) { /* A replay must not add usage again. */ }
  await $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 500, isAborted: false, reason: 'answer', usage: TOKENS })
  const total = state.snapshots.get('totals')
  expect(total).toMatchObject({ shape: 'totals-1', value: { input: 4000, output: 300, cacheRead: 34000,
    cacheWrite: 2000, responses: 1, usageResponses: 1, turns: 1, activeMs: 500 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await rowText(ui, /40\.3k/)).toBeDefined()
  expect(await rowText(ui, /12\.3k/)).toBeUndefined()
  expect(await rowText(ui, /%85/)).toBeDefined()
  expect(state.usageCalls).toHaveLength(2)
  await ui.unmount()
})

test('main and agent responses have distinct identities and missing usage keeps totals unavailable', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  await start($, clock)
  const step = { turnId: 'same-turn', index: 0, model: 'claude-fable', messageCount: 2 }
  for await (const _chunk of $.turn.step(step)) { /* main response */ }
  for await (const _chunk of $.turn.step({ ...step, agentId: 'agent-1' })) { /* agent response */ }
  state.stepUsage = null
  for await (const _chunk of $.turn.step({ ...step, index: 1 })) { /* unreported response */ }
  const total = state.snapshots.get('totals')
  expect(total).toMatchObject({ shape: 'totals-1', value: { responses: 3, usageResponses: 2, input: 8000, cacheRead: 68000 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Text', text: /^-$/ })).length).toBeGreaterThanOrEqual(2)
  await ui.unmount()
})

test('an interrupted request with neither response nor usage adds no response', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  await start($, clock); state.stepUsage = null; state.stepStopped = false
  for await (const _chunk of $.turn.step({ turnId: 'interrupted', index: 0, model: 'claude-fable', messageCount: 1 })) { /* no response */ }
  const total = state.snapshots.get('totals')
  expect(total).toMatchObject({ shape: 'totals-1', value: { responses: 0, usageResponses: 0 } })
})

test('every account has its own round capsule with a name, ordered cells, and only critical reset notes', async ($, on) => {
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
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const tree = await ui.drawn()
  for (const name of ['kadir', 'aras', 'yusa', 'codex']) {
    const capsule = accountCapsule(tree, name)!
    expect(capsule).toBeDefined()
    expect(capsule.props).toMatchObject({ borderStyle: 'round', borderColor: 'subtle', paddingX: 1, width: 38 })
    const rows = contentRows(capsule)
    expect(rows[0]).toMatch(new RegExp(`[●○◎] ${name}$`))
    expect(rows).toHaveLength(name === 'kadir' ? 3 : 2)
    expect(laidOutRows(capsule, 38)).toHaveLength(name === 'kadir' ? 5 : 4)
  }
  const kadir = accountCapsule(tree, 'kadir')!
  const rows = contentRows(kadir)
  expect(rows[1]).toMatch(/5%.*73%.*96%/)
  expect(rows[1]?.match(/━{5}/g)).toHaveLength(3)
  expect(rows[2]).toBe('Fable 2g 18sa sonra açılır')
  expect((await paneRows(ui)).filter(row => /sonra açılır$/.test(row))).toEqual(['Fable 2g 18sa sonra açılır'])
  const name = drawnNodes(kadir).find(node => node.type === 'Text' && shownText(node) === 'kadir')
  expect(name?.props).toMatchObject({ color: 'text', weight: 'bold' })
  const limitName = drawnNodes(kadir).find(node => node.type === 'Text' && shownText(node) === 'Fable')
  expect(limitName?.props).toMatchObject({ color: 'error', dimColor: true })
  const note = drawnNodes(kadir).find(node => node.type === 'Text' && shownText(node) === ' 2g 18sa sonra açılır')
  expect(note?.props?.dimColor).toBe(true)
  await ui.unmount()
})

test('critical notes remain complete at 32 columns and compact reset time only when the row needs it', async ($, on) => {
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
  for (const width of [32, 42, 60]) {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
    const tree = await ui.drawn()
    for (const [name, note] of [
      ['kadir', width === 32 ? '5 saat 4sa sonra açılır' : '5 saat 4sa 59dk sonra açılır'],
      ['aras', width === 32 ? '5 saat 2g18sa sonra açılır' : '5 saat 2g 18sa sonra açılır'],
      ['yusa', 'Fable 2g 18sa sonra açılır'],
    ] as const) {
      const capsule = accountCapsule(tree, name)!
      const rows = contentRows(capsule)
      expect(rows).toHaveLength(3)
      expect(rows[2]).toBe(note)
      expect(rows[2]).not.toMatch(/…|[\r\n—]/)
      const room = Number(capsule.props?.width) - 2 - 2 * Number(capsule.props?.paddingX ?? 0)
      expect(cells(note)).toBeLessThanOrEqual(room)
      expect(laidOutRows(capsule, width - 4)).toHaveLength(5)
    }
    expect(laidOutRows(tree, width).filter(row => cells(row) > width)).toEqual([])
    await ui.unmount()
  }
})

test('several critical limits still use only one third capsule line for the highest usage', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.accounts = oneAccount(['session', 'weekly_all', 'weekly_scoped'].map((kind, index) => ({
    ...limit(90 + index, kind, kind === 'weekly_scoped' ? 'Fable' : ''), resets_at: iso(NOW + 67 * 3_600_000 + 60_000),
  }))); state.jobs = []
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const capsule = accountCapsule(await ui.drawn(), 'kadir')!
  const rows = contentRows(capsule)
  expect(rows).toHaveLength(3)
  expect(rows[2]).toBe('Fable 2g 19sa sonra açılır')
  expect((await paneRows(ui)).filter(row => /sonra açılır$/.test(row))).toHaveLength(1)
  expect((await ui.findAll({ type: 'Text', text: /^Fable$/ }))
    .some(name => name.props.color === 'error' && name.props.dimColor === true)).toBe(true)
  expect(laidOutRows(capsule, 38)).toHaveLength(5)
  await ui.unmount()
})

test('percent severity uses success below 75, warning through 89, and bold error at 90', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.accounts = oneAccount([limit(74), limit(89, 'weekly_all'), limit(90, 'weekly_scoped', 'Fable')]); state.jobs = []
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const [percent, color] of [[74, 'success'], [89, 'warning'], [90, 'error']] as const) {
    const node = await ui.find({ type: 'Text', text: new RegExp(`^ *${percent}%$`) })
    expect(node?.props.color).toBe(color)
    expect(node?.props.weight).toBe(percent >= 90 ? 'bold' : undefined)
  }
  expect((await ui.findAll({ type: 'Text', text: /^━+$/ })).some(node => node.props.color === 'subtle')).toBe(true)
  await ui.unmount()
})

test('current account follows CLAUDE_CONFIG_DIR and warning errors replace only the second capsule line', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); world(on, { CLAUDE_CONFIG_DIR: `${HOME}/.claude-aras/`, SHIFTOVER_ACCOUNT: 'kadir' })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
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

test('missing account windows display dim dashes under fixed Turkish table headers', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.accounts = oneAccount([limit(12, 'weekly_scoped', 'Sonnet')]); state.jobs = []
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await rowText(ui, /5 saat.*hafta.*Fable/)).toBeDefined()
  expect(contentRows(accountCapsule(await ui.drawn(), 'kadir'))[1]).toMatch(/–.*–.*12%/)
  expect((await ui.findAll({ type: 'Text', text: /^ *– *$/ })).every(node => node.props.dimColor === true)).toBe(true)
  await ui.unmount()
})

test('account headers end at fixed percent columns across differently sized values', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.accounts = [
    ...oneAccount([limit(5), limit(73, 'weekly_all'), limit(100, 'weekly_scoped', 'Fable')]),
    { name: 'aras', email: '', dir: `${HOME}/.claude-aras`, limits: [limit(100), limit(8, 'weekly_all'), limit(40, 'weekly_scoped', 'Fable')] },
  ]
  await start($, clock)
  for (const width of [42, 32, 60]) {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
    const tree = await ui.drawn()
    const rows = laidOutRows(tree, width)
    expect(rows.filter(row => /5 saat.*hafta.*Fable/.test(row))).toHaveLength(1)
    for (const label of ['5 saat', 'hafta', 'Fable']) {
      expect(drawnNodes(tree).filter(node => node.type === 'Text' && shownText(node) === label && node.props?.dimColor === true && node.props?.color !== 'error')).toHaveLength(1)
    }
    const header = rows.find(row => /5 saat.*hafta.*Fable/.test(row))!
    const ends = ['5 saat', 'hafta', 'Fable'].map(label => header.indexOf(label) + label.length)
    for (const account of ['kadir', 'aras']) {
      const accountRows = laidOutRows(accountCapsule(tree, account), width - 4)
      const row = '│ ' + accountRows[2]!
      expect([...row.matchAll(/\d+%/g)].map(match => match.index + match[0].length)).toEqual(ends)
    }
    await ui.unmount()
  }
})

const rateLine = (primary: { used_percent: number; window_minutes: number; resets_at: number }, secondary?: typeof primary): string =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary, secondary } } })

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
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(contentRows(accountCapsule(await ui.drawn(), 'codex'))[1]).toMatch(/16%.*77%.*–/)
  expect(state.reads.filter(path => path === `read:${CODEX}/older.jsonl`)).toHaveLength(0)
  await ui.unmount()
})

test('Codex searches at most seven dated folders and shows missing limits when none exists', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.accounts = []; state.jobs = []
  await start($, clock)
  const dirs = state.reads.filter(path => path.startsWith(`list:${HOME}/.codex/sessions/`))
  expect(dirs).toHaveLength(7)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(contentRows(accountCapsule(await ui.drawn(), 'codex'))[1]).toMatch(/–.*–.*–/)
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
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(contentRows(accountCapsule(await ui.drawn(), 'aras'))[1]).toMatch(/10%.*75%.*92%/)
  expect(await rowText(ui, /tvOSBrowser/)).toBeDefined()
  await ui.unmount()
})

test('session records are filtered by open panel and alive PID, and use cmux titles and config accounts', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  await start($, clock)
  const chats = state.snapshots.get('chats')
  expect(chats).toMatchObject({ shape: 'chats-1', value: { list: [
    { id: 'waiting-session', title: 'Needs approval', status: 'waiting', account: 'kadir' },
    { id: 'runner-session', title: 'Analysis tab', status: 'running' },
    { id: 'current-session', title: 'Current tab', isCurrent: true },
    { id: 'idle-session', title: 'Idle tab', account: 'aras' },
  ] } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await rowText(ui, /Dead process|Closed tab/)).toBeUndefined()
  expect(await rowText(ui, /Current tab/)).not.toMatch(/›/)
  expect(await rowText(ui, /kadir · bu sekme/)).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'chat:current-session' })).toBeUndefined()
  expect(cmuxCalls(state, 'list-workspaces')).toHaveLength(1)
  expect(cmuxCalls(state, 'list-panels')).toHaveLength(1)
  expect(state.calls.filter(call => call.argv[0] === 'grep')).toHaveLength(0)
  await ui.unmount()
})

test('each chat has a self-contained two-line round capsule, with an arrow only when pressable', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); world(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const tree = await ui.drawn()
  const expected = [
    ['Needs approval', 'kadir · cevap bekliyor', true],
    ['Analysis tab', 'kadir · çalışıyor', true],
    ['Current tab', 'kadir · bu sekme', false],
    ['Idle tab', 'aras · boşta', true],
  ] as const
  for (const [title, metadata, pressable] of expected) {
    const capsule = capsuleFor(tree, title)!
    expect(capsule).toBeDefined()
    expect(capsule.props).toMatchObject({ borderStyle: 'round', borderColor: 'subtle', paddingX: 1 })
    const rows = laidOutRows(capsule, 38)
    expect(rows).toHaveLength(4)
    expect(rows[1]).toMatch(new RegExp(title))
    expect(rows[1]?.includes('›')).toBe(pressable)
    expect(rows[2]).toMatch(new RegExp(metadata))
    const titleNode = await ui.find({ type: 'Text', text: new RegExp(`^${title}$`) })
    expect(titleNode?.props.color).toBe('text')
    expect(titleNode?.props.weight).toBe(title === 'Needs approval' ? 'bold' : undefined)
  }
  const rows = laidOutRows(tree, 42)
  const first = rows.findIndex(row => /Needs approval/.test(row))
  const second = rows.findIndex(row => /Analysis tab/.test(row))
  const third = rows.findIndex(row => /Current tab/.test(row))
  expect(second - first).toBe(4)
  expect(third - second).toBe(4)
  expect(await rowText(ui, /sohbet daha/)).toBeUndefined()
  expect(await rowText(ui, /Idle tab/)).toBeDefined()
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

test('all open chats render in full beyond the pane window, retaining waiting and running first', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  for (let index = 0; index < 7; index += 1) {
    const id = `extra-${index}`; const pid = 2000 + index
    state.panels = [...state.panels, { id, title: `Extra tab ${index}` }]
    state.sessions[id] = rawSession(id, pid); state.alivePids.add(pid)
  }
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 5 } }, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Button' })).filter(node => /^chat:/.test(node.key ?? ''))).toHaveLength(10)
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

test('unchanged sessions skip full reads for thirty seconds, while mtime changes refresh on the next poll', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  await start($, clock)
  await clock.advance(19_000)
  expect(cmuxCalls(state, 'list-workspaces')).toHaveLength(1)
  expect(state.reads.filter(path => path === `read:${SESSIONS}`)).toHaveLength(1)
  state.sessionsRevision += 1
  await clock.advance(10_000)
  expect(cmuxCalls(state, 'list-workspaces')).toHaveLength(2)
  await clock.advance(20_000)
  expect(cmuxCalls(state, 'list-workspaces')).toHaveLength(2)
  await clock.advance(10_000)
  expect(cmuxCalls(state, 'list-workspaces')).toHaveLength(3)
})

test('pressing a tab selects its workspace then focuses its panel, using only mocked commands', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
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
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'chat:runner-session' })
  expect(actionCalls(state).map(call => call.argv)).toEqual([['cmux', 'select-workspace', '--workspace', WS]])
  expect(state.toasts).toEqual(['sekme açılamadı'])
  await ui.unmount()
})

test('pressing a delegate searches only open transcripts once then focuses the starter, caching the answer', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.grepMatches = ['/transcripts/1003.jsonl']
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `job:${RUNNING.id}` })
  await ui.press({ key: `job:${RUNNING.id}` })
  const grep = state.calls.filter(call => call.argv[0] === 'grep')
  expect(grep).toHaveLength(1)
  expect(grep[0]?.argv).toEqual(['grep', '-l', '-F', '--', RUNNING.id,
    '/transcripts/1002.jsonl', '/transcripts/1003.jsonl', '/transcripts/1001.jsonl', '/transcripts/1004.jsonl'])
  expect(grep[0]?.timeoutMs).toBe(5000)
  expect(actionCalls(state).map(call => call.argv)).toEqual([
    [CMUX, 'select-workspace', '--workspace', WS], [CMUX, 'focus-panel', '--panel', RUNNER, '--workspace', WS],
    [CMUX, 'select-workspace', '--workspace', WS], [CMUX, 'focus-panel', '--panel', RUNNER, '--workspace', WS],
  ])
  await ui.unmount()
})

test('a delegate started in this session shows bu sohbette without focus commands', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.grepMatches = ['/transcripts/1001.jsonl']
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `job:${RUNNING.id}` })
  expect(state.toasts).toEqual(['bu sohbette'])
  expect(actionCalls(state)).toHaveLength(0)
  await ui.unmount()
})

test('a delegate with no open starter shows başlatan sekme kapalı and caches the missing answer', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `job:${RUNNING.id}` }); await ui.press({ key: `job:${RUNNING.id}` })
  expect(state.toasts).toEqual(['başlatan sekme kapalı', 'başlatan sekme kapalı'])
  expect(state.calls.filter(call => call.argv[0] === 'grep')).toHaveLength(1)
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
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'agent:agent-live' })
  expect(state.views).toEqual([{ agentId: 'agent-live' }])
  const tasks = (await ui.findAll({ type: 'Button' })).filter(node => /^(agent|job):/.test(node.key ?? ''))
  expect(tasks).toHaveLength(3)
  expect(tasks.slice(0, 2).every(node => /Inspect tests|ads review/.test(node.text))).toBe(true)
  expect(tasks[2]?.text).toMatch(/Recent agent/)
  const tree = await ui.drawn()
  for (const title of ['Inspect tests', 'ads review', 'Recent agent']) {
    const capsule = capsuleFor(tree, title)!
    expect(capsule).toBeDefined()
    expect(capsule.props).toMatchObject({ borderStyle: 'round', borderColor: 'subtle', paddingX: 1 })
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
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
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
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
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
  idle(state); state.jobs = [RUNNING]; state.isJobGone = true
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await rowText(ui, /ads review/)).toMatch(/^\? .*ads review/)
  expect((await ui.find({ type: 'Text', text: /^\?$/ }))?.props.color).toBe('warning')
  expect(state.snapshots.get('jobs')).toMatchObject({ value: { list: [{ id: RUNNING.id, status: 'stale' }] } })
  expect(await rowText(ui, /codex · durdu/)).toBeDefined()
  for (const row of await paneRows(ui)) expect(row).not.toMatch(/[✗⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|1 (?:aktif|çalışan|koşuyor)/)
  const ps = state.calls.filter(call => call.argv[0] === 'ps')
  expect(ps).toHaveLength(1)
  expect(ps[0]?.argv).toEqual(['ps', '-ww', '-o', 'pid=,command=', '-p', '4242'])
  await ui.unmount()
})

for (const failure of ['deny', 'exit', 'stderr'] as const) {
  test(`an unavailable delegate liveness check (${failure}) retains only jobs younger than two hours`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW }); const state = world(on)
    idle(state); state.jobPsFailure = failure
    const cases = [
      { id: 'recent', label: 'yeni iş', started: (NOW - 2 * 3_600_000 + 5_000) / 1000, pid: 4242, status: 'running' },
      { id: 'boundary', label: 'sınır işi', started: (NOW - 2 * 3_600_000) / 1000, pid: 4243, status: 'stale' },
      { id: 'older', label: 'eski iş', started: (NOW - 2 * 3_600_000 - 5_000) / 1000, pid: 4244, status: 'stale' },
      { id: 'missing', label: 'tarihsiz iş', started: 0, pid: 4245, status: 'stale' },
      { id: 'future', label: 'gelecek iş', started: (NOW + 5_000) / 1000, pid: 4246, status: 'stale' },
      { id: 'no-pid', label: 'süreçsiz iş', started: (NOW - 5_000) / 1000, pid: 0, status: 'stale' },
    ]
    state.jobs = cases.map(job => ({ ...RUNNING, ...job, status: 'running' }))
    await start($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const snapshot = state.snapshots.get('jobs') as { value: { list: { id: string; status: string }[] } }
    for (const job of cases) expect(snapshot.value.list.find(row => row.id === job.id)?.status).toBe(job.status)
    const visible = (await ui.findAll({ type: 'Button' })).filter(node => /^job:/.test(node.key ?? ''))
    expect(visible).toHaveLength(3)
    expect(visible[0]?.text).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /)
    expect(visible.slice(1).every(node => /^\? /.test(node.text))).toBe(true)
    expect((await paneRows(ui)).filter(row => /· durdu$/.test(row))).toHaveLength(2)
    expect(visible.every(node => !/✗/.test(node.text))).toBe(true)
    const questions = await ui.findAll({ type: 'Text', text: /^\?$/ })
    expect(questions).toHaveLength(2)
    expect(questions.every(node => node.props.color === 'warning')).toBe(true)
    expect(await rowText(ui, /^\+3 iş daha$/)).toBeDefined()
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
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
    expect((await ui.find({ key: `job:${RUNNING.id}` }))?.text).toMatch(/…/)
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
  await clock.settle()
  expect(state.reads.length).toBeGreaterThan(reads)
})

test('one adaptive spinner clock follows time and respects the maximum frame rate', async ($, on) => {
  const clock = observedClock(on); const redraws: number[] = []
  on('ui.invalidate', { event: 'ui.render' }, async (_, e, next) => { redraws.push(clock.now()); return next(e) })
  const state = world(on); idle(state); state.jobs = [RUNNING]
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const before = (await rowText(ui, /ads review/))?.[0]
  await clock.advance(200)
  const after = (await rowText(ui, /ads review/))?.[0]
  expect(after).not.toBe(before)
  expect(after).toBe(spinner[Math.floor(redraws[redraws.length - 1]! / 100) % spinner.length])
  expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(1)
  for (let index = 1; index < redraws.length; index += 1) expect(redraws[index]! - redraws[index - 1]!).toBeGreaterThanOrEqual(67)
  await ui.unmount()
})

test('spinner, waiting blink and completion pop never change row count or rendered width', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.jobs = [RUNNING, { ...DONE, label: 'yeni tamamlandı', finished: NOW / 1000 }]
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  for (const width of [42, 32, 60]) {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
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
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(contentRows(accountCapsule(await ui.drawn(), 'kadir'))[1]).toMatch(/40%.*92%/)
  const initial = contentRows(accountCapsule(await ui.drawn(), 'kadir'))[1]
  await clock.advance(2000)
  expect(contentRows(accountCapsule(await ui.drawn(), 'kadir'))[1]).toBe(initial)
  expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(0)
  expect(clock.waits().filter(wait => wait.ms < 10_000)).toHaveLength(0)
  state.accounts = oneAccount([limit(70), limit(96, 'weekly_scoped', 'Fable')])
  await clock.advance(58_000)
  expect(contentRows(accountCapsule(await ui.drawn(), 'kadir'))[1]).toMatch(/70%.*96%/)
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
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
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
  expect(clock.waits().filter(wait => wait.kind === 'after')).toEqual([{ kind: 'after', ms: 600 }])
  await clock.advance(600)
  expect(await marker()).toBe(initial)
  expect(redraws).toHaveLength(2)
  state.sessions = {}; state.sessionsRevision += 1
  await clock.advance(10_000)
  expect(await rowText(ui, /Needs approval/)).toBeUndefined()
  expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(0)
  expect(clock.waits().filter(wait => wait.ms < 10_000)).toHaveLength(0)
  await ui.unmount()
})

test('idle dots blink inactive and subtle at 1500 ms edges without spinner frames', async ($, on) => {
  const clock = observedClock(on); const redraws: number[] = []
  on('ui.invalidate', { event: 'ui.render' }, async (_, e, next) => { redraws.push(clock.now()); return next(e) })
  const state = world(on); idle(state)
  state.sessions = { idle: rawSession(IDLE, 1004) }
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Let the one deferred refresh repaint settle before measuring blink-only work.
  await clock.advance(67)
  const marker = async () => (await ui.find({ type: 'Text', text: /^●$/ }))?.props.color
  const initial = await marker()
  expect(initial).toBe(Math.floor(clock.now() / 1500) % 2 === 0 ? 'inactive' : 'subtle')
  expect(clock.waits().filter(wait => wait.kind === 'after')).toEqual([{ kind: 'after', ms: 1500 - clock.now() % 1500 }])
  redraws.length = 0
  await clock.advance(1500 - clock.now() % 1500 - 1)
  expect(await marker()).toBe(initial)
  expect(redraws).toHaveLength(0)
  await clock.advance(1)
  expect(await marker()).toBe(initial === 'inactive' ? 'subtle' : 'inactive')
  expect(redraws).toHaveLength(1)
  expect(clock.waits().filter(wait => wait.kind === 'after')).toEqual([{ kind: 'after', ms: 1500 }])
  await clock.advance(1500)
  expect(await marker()).toBe(initial)
  expect(redraws).toHaveLength(2)
  await ui.unmount()
})

test('mixed blink-only chats share one timer that always schedules the next waiting or idle edge', async ($, on) => {
  const clock = observedClock(on); const redraws: number[] = []
  on('ui.invalidate', { event: 'ui.render' }, async (_, e, next) => { redraws.push(clock.now()); return next(e) })
  const state = world(on); idle(state)
  state.sessions = {
    waiting: rawSession(WAITING, 1002, { agentLifecycle: 'needsInput' }), idle: rawSession(IDLE, 1004),
  }
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Let the one deferred refresh repaint settle before measuring blink-only work.
  await clock.advance(67)
  for (let edge = 0; edge < 6; edge += 1) {
    const next = Math.min(600 - clock.now() % 600, 1500 - clock.now() % 1500)
    expect(clock.waits().filter(wait => wait.kind === 'after')).toEqual([{ kind: 'after', ms: next }])
    expect(clock.waits().filter(wait => wait.ms < 300)).toHaveLength(0)
    redraws.length = 0
    await clock.advance(next - 1)
    expect(redraws).toHaveLength(0)
    await clock.advance(1)
    expect(redraws).toHaveLength(1)
    const tree = await ui.drawn()
    for (const [title, period, color] of [['Needs approval', 600, 'error'], ['Idle tab', 1500, 'inactive']] as const) {
      const capsule = capsuleFor(tree, title)!
      const dot = drawnNodes(capsule).find(node => node.type === 'Text' && shownText(node) === '●')
      expect(dot?.props?.color).toBe(Math.floor(clock.now() / period) % 2 === 0 ? color : 'subtle')
    }
  }
  await ui.unmount()
})

test('a recent completion pops to its final glyph and then stops its animation', async ($, on) => {
  const clock = observedClock(on); const state = world(on); idle(state)
  state.jobs = [{ ...DONE, label: 'just completed', finished: NOW / 1000 }]
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await rowText(ui, /just completed/)).toMatch(/^·/)
  await clock.advance(125); await ui.redraw(); await clock.settle()
  expect(await rowText(ui, /just completed/)).toMatch(/^•/)
  await clock.advance(175)
  expect(await rowText(ui, /just completed/)).toMatch(/^✓/)
  await clock.advance(1800)
  expect(clock.waits().filter(wait => wait.kind === 'after')).toHaveLength(0)
  await ui.unmount()
})

test('a refresh spinner is active only while account status is in flight', async ($, on) => {
  const clock = observedClock(on); const state = world(on); idle(state)
  state.accountsGate = clock.sleep(500)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }); await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
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
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
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
    shape: 'accounts-1', value: { list: [{ name: 'kadir', email: '', dir: `${HOME}/.claude`, err: null,
      limits: [{ kind: 'session', model: '', used: 70, resetsAtMs: null }] }], current: 'kadir', at: NOW, error: null },
  }, version: 1 } }))
  on('state.get', { key: 'jobs' }, () => ({ value: { value: {
    shape: 'jobs-1', value: { list: [{ id: 'cached-done', account: 'aras', model: '', label: 'cached completion',
      status: 'done', pid: 1, startedMs: NOW - 1000, finishedMs: NOW, durationMs: 1000, costUsd: null }], at: NOW, error: null },
  }, version: 1 } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(contentRows(accountCapsule(await ui.drawn(), 'kadir'))[1]).toMatch(/70%/)
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
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.advance(400)
  expect(redraws.length).toBeGreaterThan(3)
  for (let index = 1; index < redraws.length; index += 1) expect(redraws[index]! - redraws[index - 1]!).toBeGreaterThanOrEqual(67)
  expect(await rowText(ui, /ads review/)).toBeDefined()
  await ui.unmount()
})

test('external text stays on one line and long names truncate inside their own capsule', async ($, on) => {
  const clock = mock.clock(on, { now: NOW }); const state = world(on)
  state.jobs = [{ ...RUNNING, label: 'review — pending\n tasks', account: 'very-long-account-owner-name-that-will-not-fit' }]
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
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
