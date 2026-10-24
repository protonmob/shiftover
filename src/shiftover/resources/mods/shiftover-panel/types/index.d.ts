// The values the shiftover-panel mod keeps in $.state: what the pane draws.

/**
 * One usage window of an account, as `shiftover status --json` reports it.
 */
export type Limit = {
  /** `session` (the 5-hour window), `weekly_all`, or `weekly_scoped`. */
  kind: string
  /** The model a `weekly_scoped` window counts (`Fable`); empty otherwise. */
  model: string
  /** Percent used, 0 to 100. */
  used: number
  /** When the window resets, in ms since the epoch; null when unknown. */
  resetsAtMs: number | null
}

/**
 * One shiftover account and its windows, or why they could not be read.
 */
export type Account = {
  name: string
  email: string
  /** The account's Claude config directory, absolute. */
  dir: string
  limits: Limit[]
  /** Why shiftover could not read the limits; null when it could. */
  err: string | null
}

/**
 * The accounts as last read, with the one this session runs on.
 */
export type AccountsSnapshot = {
  list: Account[]
  /** The name of the account this session runs on; null when unknown. */
  current: string | null
  /** The last successful read, in ms since the epoch; 0 before the first. */
  at: number
  /** Why the last read failed; null when it succeeded. */
  error: string | null
}

/**
 * One delegate job, from its `~/.cache/shiftover/jobs/<id>.json` file.
 */
export type Job = {
  id: string
  /** The account it ran on, or `codex` for a Codex job. */
  account: string
  /** Empty when the job named none (Codex jobs). */
  model: string
  label: string
  /** `running`, `done`, `failed`, `cancelled`, or `stale`: still `running`
   * in its file while its process is gone. */
  status: string
  pid: number
  startedMs: number
  /** Null while the job runs. */
  finishedMs: number | null
  durationMs: number | null
  costUsd: number | null
}

/**
 * The jobs the pane lists: the running ones, then the latest finished ones.
 */
export type JobsSnapshot = {
  list: Job[]
  /** The last successful read, in ms since the epoch; 0 before the first. */
  at: number
  /** Why the last read failed; null when it succeeded. */
  error: string | null
}

/** Only the summary figures the pane draws, without engine-only metadata. */
export type SessionSnapshot = {
  usage: {
    startedAt: number
    context: { tokens?: number; window: number; percent?: number; breakdown?: { totalTokens: number } }
    cost?: { usd: number }
  } | null
  mcpServers: number | null
  at: number
  error: string | null
}

/** Per-response accounting; turn aggregates must never be counted twice. */
export type UsageTotals = {
  startedAt: number | null
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  responses: number
  usageResponses: number
  responseIds: string[]
  activeMs: number
  turns: number
  turnIds: string[]
}

export type PaneAgent = {
  id: string
  teammateId?: string
  description: string
  type: string
  status: 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'
  parentId?: string
  spawnedBy?: string
  name?: string
  observedAt: number
  finishedAt: number | null
}
export type AgentsSnapshot = { list: PaneAgent[]; at: number; error: string | null }
export type CodexSnapshot = { limits: Limit[]; at: number; error: string | null }
export type ChatSession = {
  id: string
  surfaceId: string
  workspaceId: string
  pid: number
  title: string
  account: string
  status: 'waiting' | 'running' | 'idle'
  isCurrent: boolean
  transcriptPath: string
}
export type ChatsSnapshot = { list: ChatSession[]; at: number; error: string | null }

declare module 'claude-code' {
  interface PluginState {
    'shiftover-panel': {
      accounts: Shaped<AccountsSnapshot>
      jobs: Shaped<JobsSnapshot>
      isDismissed: boolean
      session: Shaped<SessionSnapshot>
      totals: Shaped<UsageTotals>
      agents: Shaped<AgentsSnapshot>
      codex: Shaped<CodexSnapshot>
      chats: Shaped<ChatsSnapshot>
    }
  }
}
