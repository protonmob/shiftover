// The values the shiftover-panel mod keeps in $.state: what the pane draws.

/**
 * One usage window from `shiftover status --json` or a Codex rate limit.
 */
export type Limit = {
  /** `session` (5 hours), `weekly_all`, `weekly_scoped`, or Codex `rate_window`. */
  kind: string
  /** The model a `weekly_scoped` window counts (`Fable`); empty otherwise. */
  model: string
  /** Codex's actual window length, in minutes; absent for Claude windows. */
  windowMinutes?: number
  /** Percent used, 0 to 100. */
  used: number
  /** When the window resets, in ms since the epoch; null when unknown. */
  resetsAtMs: number | null
}

/**
 * One shiftover account and its windows, or why they could not be read. Any
 * plugin may read $.state, so no email is kept: the pane never shows one.
 */
export type Account = {
  /** What jobs and chats name the account by; drawn only without a `display`. */
  name: string
  /** The name shiftover shows for it (`display`); null when unset. */
  display: string | null
  /** The account's Claude config directory, absolute. */
  dir: string
  limits: Limit[]
  /** The server's next usage read and last fetch, in ms; absent on older shiftover. */
  nextRefreshAtMs?: number | null
  fetchedAtMs?: number | null
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
  /** The last read that changed the list, in ms since the epoch; 0 before the first. */
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
   * in its file while its process is gone. `done` or `failed` also when its
   * `.out` ended before its file says so. */
  status: string
  pid: number
  /** The starter's session and Claude pid; absent in older job files. */
  parentSessionId?: string
  parentPid?: number
  startedMs: number
  /** Null while the job runs; the `.out`'s time when only it shows the end. */
  finishedMs: number | null
  durationMs: number | null
  costUsd: number | null
  /** What a running job does now, in Turkish (`register.tsx düzenleniyor`),
   * from its live transcript or log: the last step it named, `çalışıyor`
   * before any; absent once it no longer runs. */
  step?: string
}

/**
 * The jobs the pane lists: the running ones, then those finished within the
 * last day, newest first; ten in all unless more than ten run.
 */
export type JobsSnapshot = {
  list: Job[]
  /** The last read that changed the list, in ms since the epoch; 0 before the first. */
  at: number
  /** Why the last read failed; null when it succeeded. */
  error: string | null
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
/**
 * One open Claude Code tab. The list keeps waiting chats first, then the rest
 * by their transcript's last change, newest first.
 */
export type ChatSession = {
  id: string
  surfaceId: string
  workspaceId: string
  pid: number
  /** A `/rename` title, else the tab's title unless a shell's, else Claude's
   * own title for the chat, else the folder's name. */
  title: string
  /** The account's `name`; its display name is the accounts list's. */
  account: string
  model: string
  effort: string
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
      isAccountsOpen: boolean
      agents: Shaped<AgentsSnapshot>
      codex: Shaped<CodexSnapshot>
      chats: Shaped<ChatsSnapshot>
    }
  }
}
