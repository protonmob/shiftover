# CODEMAP — shiftover-panel

> Update this file whenever you move, rename or add code: line numbers below are the map future agents trust.

A Claude Code mod: a docked pane ("Shiftover") beside the chat with three cards — **Hesaplar** (shiftover accounts + Codex usage gauges), **Sohbetler** (open Claude Code tabs from cmux, with running delegate rows), **İşler** (delegate jobs + engine agents). UI strings are Turkish.

## Files

| File | Job |
|---|---|
| `.claude-plugin/plugin.json` | Manifest: name `shiftover-panel`, `types: ./types/index.d.ts`. |
| `.claude-plugin/types/` | Engine typings (`claude-code/index.d.ts`, ≈17k lines) — the engine docs. Read, never edit. |
| `hooks/hooks.json` | `{ "modules": ["./register.tsx"] }` — the one hooks module. |
| `hooks/register.tsx` | Everything: state atoms, refreshers, timers, layout, render, presses, slash command. Map below. |
| `hooks/sessions.ts` | Open chats from the cmux sessions file + cmux CLI; transcript tails (model/effort/titles); starter search for parentless jobs; click-to-jump (`focusChat`, `followJob`, `openDelegate`). |
| `hooks/codex.ts` | Codex rate limits from `~/.codex/sessions/YYYY/MM/DD/*.jsonl` tails: `parseCodexLimits` :21, `readCodexLimits` :73 (7 day-folders, newest 10 files, 1 MiB tail, mtime/size cache). |
| `hooks/steps.ts` | Delegate "what it does now" in Turkish: `claudeStep` :40, `codexStep` :66, `commandStep` :21, `projectFolders` :99 (cwd → `projects/<escaped>`), `delegateLabel` :109 (`delegate:<label>` from `custom-title`/`agent-name`). |
| `hooks/capsule.tsx` | Client surface module drawing one clickable capsule (chat/job/agent + delegate rows). `CapsuleProps` :16, `targetAt` :45 hit-test, default `Capsule` :53: hover lights border only, left down+up on same part → `surface.post({ target })`. |
| `types/index.d.ts` | State shapes: `Limit` :6, `Account` :23, `AccountsSnapshot` :41, `Job` :54, `JobsSnapshot` :84, `PaneAgent` :92, `AgentsSnapshot`/`CodexSnapshot` :104-105, `ChatSession` :110, `ChatsSnapshot` :126, `PluginState` augmentation :128. |
| `hooks/pane.test.tsx` | ≈4100 lines, 167 tests (145 `test(` calls, some looped), `claude-code/testing`. Map below. |

## hooks/register.tsx section map

| Lines | Section | Key names |
|---|---|---|
| 14-57 | Constants/timers | `JOBS_MS` 10 s poll, `ACCOUNTS_MS` 60 s, retry 30 s→5 min ×2 +20% jitter (:23-25), `FRAME_MS` 250, `MIN_FRAME_MS` 67, `WAITING_BLINK_MS` 600, waiting border flash 1 s/10 s (:30-31), `POP_MS`/`FINISH_MS`, `CAPSULES_SHOWN` 3, `JOBS_KEPT` 10 / 24 h, `UNVERIFIED_RUNNING_MS` 2 h, `TAIL_BYTES` 256 KiB, `TAILS_PER_RUN` 12, `HEAD_BYTES` 16 KiB, `DEEP_TAIL_BYTES` 3 MiB, `ACCOUNT_COLORS` :55, `DOCK_COLUMNS` 76 |
| 59-132 | State | atoms :69-77 with shape tags `accounts-3`, `jobs-2`, `codex-1`, `chats-2`, `agents-1` (bump the tag when a snapshot's fields change; old stored values are declined); plain `isDismissed`, `isAccountsOpen`. Module vars :94-132 (timers, in-flight flags, `faultedSurfaces`, caches `jobFiles`/`jobOuts`/`jobSteps`/`sessionLabels`) |
| 134-249 | Parsing | `toEpochMs` :148, `parseLimit` :158, `parseAccounts` :166 (drops email), `nextAccountRefresh` :185, `retryDelay` :191, `parseJob` :196, `outcomeOf` :234 (.out end → done/failed) |
| 251-357 | Accounts refresh | `locate` :253 (HOME, XDG dirs, `~/.local/bin/shiftover` else PATH), `isSame` :277, `readMain` :283, `currentAccount` :300 (CLAUDE_CONFIG_DIR → `SHIFTOVER_ACCOUNT` → config `main`), `refreshAccounts` :312 (`shiftover status --json`, 25 s timeout, back-off bookkeeping) |
| 359-631 | Jobs refresh | `readJobs` :361 (changed `.json` only), `fileEnds` :394 (batched `tail`/`head -c`), `stepSource` :430, `stepSources` :461, `readRunning` :493 (.out outcome + step, deep tail fallback), `livePids` :550 (`ps`, zombies = dead), `pickJobs` :574, `refreshJobs` :583 (finished-job detection: .out outcome > ps check > 2 h guard → `stale`) |
| 633-705 | Agents / Codex / chats | `agentIsRunning` :633, `refreshAgents` :637 (`$.agent.list()`), `refreshCodex` :671, `refreshConversations` :688 (→ `sessions.refreshChats`) |
| 707-903 | Scheduling/motion | `isVisible` :711 (placed && shown), `stopAnimation` :719, `settleMotion` :727, `observeJobs/Agents/Chats` :732-747, `observeTaskMotion` :749 (completion pop), `reconcileMotion` :775 (one adaptive timer: spinner frames, waiting blink/flash, minute + reset boundaries, server refresh target, 67 ms frame budget), `tick` :868, `startPolling` :893, `dismissPane` :899 |
| 905-941 | Presses | `pressTarget` :912 — keys `chat:<id>` focus tab, `follow:<jobId>` new cmux tab following job, `agent:<id>` `$.ui.view`, `job:<id>` `openDelegate` |
| 943-1283 | Formatting/layout helpers | `Seg`/`Line`/`CapsuleRow`/`Gauge` :945-950, `spinner` :954, `chatMarker` :955, `delegateRows` :962, cell math `cellsOf`/`textCells`/`lineCells`/`prefix`/`fitLine`/`align` :980-1033, `untilReset` :1035, `bar` :1045, `severity` :1053 (<75 success, <90 warning, ≥90 error), `usedNow` :1058 (passed reset → 0), `shortError` :1063, `gaugesOf` :1073, `centered` :1093, `gaugeColumns` :1099 (narrow layout), `listedAccounts` :1124 (+codex row), `displayName` :1130, `accountSummary` :1133 (collapsed card), `accountLines` :1151 (inline vs column layout, critical note, reset-border parts, weekly resets ≤1 h grouped), `glyphOf` :1227, `tasksOf` :1244, `duration` :1254, `taskLines` :1261, `styleOf` :1279 |
| 1285-1606 | Hooks + render | `register` :1287. `session.start` :1288 (registers `/shiftover-panel`, restores `isAccountsOpen` from `$.store`, opens pane unless dismissed), `command.run` :1314 (toggle), `session.end` :1333 (clear → reset agents), `turn.complete` :1344, `ui.close` :1351 (person close → `isDismissed`), `session.detach` :1361, `ui.focus` :1367, `ui.message` :1379 (capsule posts; only own key or `follow:` under `chat:`), `ui.fault` :1391 (surface → `faultedSurfaces`, Buttons from then on), `ui.render` :1401 |

`ui.render` internals: `Client` chosen only on terminal/desktop and non-faulted surfaces :1407; `draw` :1418; `card` :1427 (title painted by an absolute Box over the top border; accounts title is the toggle Button); `capsule` :1457 (Button fallback: one Button per capsule + one per delegate row, each in its own keyed Box; reset/title overlays :1511-1517); `clickable` :1524 (`<Client module="./capsule.tsx">` else `capsule`); tree :1536-1601 (Hesaplar ▾/▸, Sohbetler, İşler with `+N iş daha`).

## Data sources the panel reads

- **`shiftover status --json`** (array): `name`, `display`, `dir`, `limits[]` {`kind` session|weekly_all|weekly_scoped, `model`, `used`, `resets_at`}, `err`, `fetched_at`, `next_refresh_at`. `email` is ignored on purpose ($.state is readable by any plugin).
- **Shiftover config** `$XDG_CONFIG_HOME/shiftover/config.toml`: top-level `main = "..."`; `[accounts.<name>] dir = "..."` (sessions.ts `configAccounts`).
- **Job files** `$XDG_CACHE_HOME/shiftover/jobs/<id>.json`: `id`, `account`, `model`, `label`, `status`, `pid`, `started`, `finished`, `duration_ms`, `cost_usd`, `backend`, `cwd`, `dir`, `parent_session_id`, `parent_pid`, `transcript_path`, `log_path`. `session_id` is not read. Sibling `<id>.out`: claude `result` line / codex `turn.completed|turn.failed`.
- **Session model cache** `$XDG_CACHE_HOME/shiftover/sessions/<sessionId>.json` → `model.display_name|id`.
- **cmux**: sessions file `~/.cmuxterm/claude-hook-sessions.json` (`sessions{id: {surfaceId, pid, cwd, transcriptPath, launchCommand.environment.CLAUDE_CONFIG_DIR, agentLifecycle, runtimeStatus, hookEventName, notification*}}`); CLI (app binary, else `cmux` on PATH): `list-workspaces`, `list-panels --workspace <id> --id-format both`, `select-workspace` + `focus-panel` (focus), `new-surface --workspace <id> --command "shiftover jobs follow <id>" --focus true`. cmux and `ps` run at most every 30 s unless an unknown surface/pid appears.
- **Transcripts** (`tail -c`): `assistant` lines → `message.model`, `effort`, last content block (`tool_use` name/input, `text`, `thinking`) for steps; `custom-title` (`/rename`), `ai-title`; first lines (`head`) `custom-title`/`agent-name` = `delegate:<label>`. Starter search: one `grep` for `"job_id":"<id>"` across open transcripts (sessions.ts :400-460).
- **Codex**: `rate_limits.primary|secondary` {`window_minutes`, `used_percent`, `resets_at`}; codex job logs `item.type` command_execution / file_change / agent_message / reasoning.
- **Engine**: `$.agent.list()` for agents; `$.session.id()`, env `CMUX_SURFACE_ID` for the current chat.

## Engine gotchas (cite `.claude-plugin/types/claude-code/index.d.ts`)

- **Buttons always invert under the pointer and focus** (`ButtonProps.plain` :1139, `hover` :1183). Hover can only restyle runs, so the fallback mutes every run to `MUTED` to read as one grey block.
- **An absolute Box's pointer is its parent's** (`BoxProps.position` :948-952). Never cover a Button with an overlay; overlays hang from a borderless, unpadded frame (test :1342).
- **Button children: strings and `Text` only**; any other element is refused (`ButtonProps.label` :1106-1110). Give a stable `key` when the text changes (:1098).
- **Client surface modules** get raw pointer events and draw with no inversion (`ClientElements` :1438, `ClientSurface` :1586, `onPointer` :1626, `Client` element :3936 — `module` must be a string literal). Only terminal/desktop run them; VS Code/mobile tables have no Client (:3964-3992) → fall back to Buttons; also after `ui.fault`.
- **`$.store` is a file under the account's Claude config dir** (:3436-3453): per `CLAUDE_CONFIG_DIR`, not shared across accounts.
- **fs reads over 4 MiB reject** (`fs` :3309, `fs.read` :3317); process stdout caps at 4 MiB and sets `isStdoutTruncated` (:8237). Read big files with `tail -c`/`head -c`, ≤12 files per run.
- **Hidden panes should do no work**: check `isPlaced && isShown` (`UiPane` :15119-15145) before every read/timer; a skipped tick sets `missedTick` and catches up on next draw.
- **Notification ≠ waiting**: `ui.notify` is heard twice and can loop (:7226); `NotificationHookInput` :6875. Only permission/elicitation notifications count as waiting; the `idle_prompt` reminder does not (sessions.ts `notificationAsks` :94, `chatStatus` :104).

## hooks/pane.test.tsx map

| Lines | Content |
|---|---|
| 1-90 | Imports, fixtures: `NOW`, fake `HOME`, paths (`JOBS`, `SESSIONS`, `CONFIG`, `CODEX`, `CMUX`), session UUIDs, `STATUS`, `RUNNING`, `DONE`, `PANELS`, `World` type |
| 91-237 | `world(on, env, isPlaced)` — mocks fs, process (shiftover, cmux, ps, tail, head, grep), agents, panes; records `calls` |
| 238-523 | Drawing helpers: `paneRows`, `laidOutRows` :268, `layoutRects` :322, `coveredButtons` :361, `absoluteParents`, `capsules`, `capsuleFor`, `accountCapsule` :379, `accountsCard`, `resetOverlay`, `titleOverlay`, `followButtons`, `subRows`, `contentRows` :410, `expectLimitColumns` :421, `targetsOf` :449; call filters `grepCalls`…`surfaceCalls` :461-501; `start` :488; `observedClock` :506 |
| 524-592 | Capsule clients: `clientKeys`, `expanded` :539, `click` :549, `withClients` :553, `mount` :590 |
| 593-1123 | Layout, gauges, severity, inline vs columns, critical notes, 5-hour countdowns (:934), Codex limits, minute refresh |
| 1124-1271 | Chat parsing/metadata: cmux panels, model ids, transcript tails |
| 1272-1427 | Capsule targets, no absolute Box over Buttons, one key per capsule |
| 1428-1682 | Chat status spellings, ordering, cmux 30 s cadence, focus/toasts, parent lookup |
| 1683-1823 | Job capsules, glyphs, durations, stale/liveness, truncation |
| 1824-2230 | Visibility guards, command toggle, spinner/blink/pop clock, account refresh scheduling + back-off |
| 2231-2530 | Truncation, hover/focus on Client and Button fallback, VS Code/mobile/fault fallback, waiting border flash |
| 2531-2621 | Delegate rows under chats |
| 2622-2746 | Starters of older jobs (grep search) |
| 2747-3119 | Finished jobs (.out, zombies, batched ps), reset borders |
| 3120-3295 | Compact (collapsed) accounts, persisted open/closed |
| 3296-3340 | Codex history (4 MiB tail, fallback files) |
| 3341-3371 | Passed windows |
| 3372-3412 | Visibility and load (hidden tab does nothing; no-op polls write nothing) |
| 3413-3460 | Notifications vs waiting |
| 3461-3592 | Job history, starter answers, state others read (no emails, shape tags), account errors, cache dir |
| 3593-4061 | Delegate steps (`claudeStep`/`codexStep`, step sources, heads, deep tails, follow rows, hidden = no reads) |
| 4062-4144 | Chat titles, display names |

## Commands

```sh
npx -y -p typescript@5.9.3 tsc -p .   # typecheck
claude plugin validate .
claude plugin test .                    # runs hooks/pane.test.tsx
```
