# shiftover code map

> Keep this current: when you move, add or rename a module, function, data file or config key, update its line here.

shiftover routes Claude Code across several accounts (`~/.claude`, `~/.claude-<name>`): picks the one with usage
headroom, hands a conversation over at the end of a turn, and runs headless delegate jobs on other accounts or Codex.
Entry point: `shiftover = shiftover.cli:main` (`python -m shiftover` works too).

## src/shiftover/

| Where | What |
|---|---|
| `cli.py:691` `main` / `:606` `build_parser` | argparse front end; one `cmd_*` per subcommand |
| `cli.py:45` `cmd_run` | `shiftover run`: choose the account (map, menu, headroom) and start `runner.run` |
| `cli.py:128` `cmd_status`, `:162` `cmd_doctor`, `:282` `cmd_setup`, `:251` `cmd_init` | status table, health checks, one-shot setup, config import |
| `cli.py:386` `cmd_add`, `:423` `cmd_remove`, `:441` `cmd_install`, `:454` `cmd_uninstall` | account and install management |
| `cli.py:541` `cmd_jobs`, `:577` `cmd_usage` | delegate job list/follow/cancel/purge; usage cache refresh (`--stale` = detached renewal pass) |
| `config.py:15` `Account` | name, dir, email, models, enabled, pool, display; `.label` is what UIs show (`display` or name) |
| `config.py:40` `Config` | `ordered()` main first, `pooled()`, `by_dir()`, `resolve()` (name / number / substring), `for_cwd()` (map) |
| `config.py:118` `from_dict`, `:175` `to_toml`, `:147` `load`, `:205` `save` | TOML read/write; `save` writes 0600 |
| `config.py:242` `import_existing`, `:258` `adopt_emails`, `:270` `merge_discovered` | find and adopt `~/.claude*` dirs |
| `claude.py:41` `norm`, `:51` `config_json`, `:59` `project_dir`, `:75` `transcript` | Claude Code paths for an account dir |
| `claude.py:121` `access_token` → `Token` (`:109`) | keychain (or `.credentials.json`) lookup; `Token.expires_at` epoch seconds |
| `claude.py:179` `env_for`, `:193` `renew_env`, `:198` `renew` | child env per account (strips auth overrides and run identity); token renewal run |
| `claude.py:99` `default_model`, `:221` `current_dir`, `:236` `launch_flags`, `:288` `effective_model` | model/account of the current session; flags carried over a hand-off |
| `usage.py:309` `refresh` | `{dir: entry}` from cache or OAuth usage endpoint; budgeted, single-flight (see rules) |
| `usage.py:327` `_refresh`, `:271` `_cached_probe`, `:231` `_probe`, `:252` `_renew` | lock-held probe of stale entries; renewal only in the detached pass |
| `usage.py:360` `refresh_stale`, `:375` `refresh_detached`, `:366` `store` | background renewal pass; spawn it; write one entry under the lock |
| `usage.py:180` `fresh`, `:193` `_settled`, `:198` `next_refresh`, `:206` `known_limits` | TTL / Retry-After / token fingerprint checks; windows kept through failed reads |
| `usage.py:123` `headroom`, `:119` `blocking`, `:113` `applies`, `:103` `model_family` | window math; `weekly_scoped` windows apply only to their model family |
| `pick.py:16` `rows_for` | cache entries → display rows (`next_refresh_at` jittered by `usage.JITTER`) |
| `pick.py:66` `choose`, `:107` `best`, `:116` `warnings` | account to open / delegate target / drift and duplicate warnings |
| `runner.py:131` `run`, `:48` `spawn` | interactive loop: start claude, apply hand-off requests, resume on the target |
| `runner.py:74` `pretrust`, `:99` `resume_args`, `:109` `transcript_visible` | folder trust copy, resume argv, shared-transcript check |
| `handoff.py:21` `schedule`, `:13` `apply` | queue a hand-off (`pending.json`) / commit it (`handoff.json`) |
| `hooks.py:256` `main` → `HANDLERS` (`:253`) | `session-start`, `stop`, `stop-failure`, `prompt` hooks; must never fail loudly |
| `hooks.py:177` `prompt`, `:135` `stop`, `:100` `_switch` | usage tips and auto hand-off at the end of a turn |
| `statusline.py:47` `main`, `:12` `segment` | status line; writes the session state file; wraps a user command (`statusline.wrap`) |
| `install.py:208` `install`, `:247` `uninstall`, `:49` `merge_settings`, `:432` `_panel_install` | hooks, status line, MCP registration, `/handoff`, skill, side panel |
| `install.py:280` `share`, `:353` `ensure_shell_init` | symlink shared files into a new account; shell wiring |
| `ui.py:46` `build_lines`, `:132` `menu` | usage bars and the arrow-key account menu |
| `i18n.py:164` `t`, `:159` `set_lang`, `:3` `STRINGS` | every user-facing string, `en` and `tr` |
| `paths.py` | XDG dirs (`cache_dir`, `jobs_dir`, `runs_dir`, `sessions_dir`, `tmp_dir`, `mods_dir`), atomic `write_private`/`write_json` (0600), `read_json` |
| `runstate.py` | per-run dir from `SHIFTOVER_RUN_ID`, session id, wrapper pid |

## src/shiftover/delegate/

| Where | What |
|---|---|
| `mcp.py:213` `serve`, `:65` `Server`, `:14` `TOOLS` | stdio JSON-RPC MCP server: `accounts`, `delegate`, `monitor` |
| `mcp.py:128` `Server.delegate`, `:103` `_pick_account` | validate args, pick account (`auto` never the caller; Codex fallback only without a named model), start + wait |
| `mcp.py:181` `Server.monitor`, `:75` `Server.accounts` | wait / cancel / list jobs; account windows and errors |
| `jobs.py:26` `Job` | job record (see data files) |
| `jobs.py:100` `build_args` | `claude -p` argv: session id or `--resume`, `--append-system-prompt HEADLESS_NOTE` (`:20`), strict MCP config, `--allowedTools` last (variadic) |
| `jobs.py:126` `start`, `:149` `start_codex`, `:172` `_launch` | spawn in the job cwd, own process group, prompt on stdin, 0600 output files |
| `jobs.py:207` `_wait_for_exit` | per-job daemon thread: reaps the process and finalizes the record |
| `jobs.py:285` `finalize`, `:298` `_finalize`, `:256` `_finalize_codex`, `:277` `_save_final` | parse output once under `_lock`; a `cancelled` on disk always wins |
| `jobs.py:223` `alive`, `:342` `refresh`, `:348` `wait`, `:376` `cancel`, `:400` `summary` | liveness (pid + `ps` check after restarts), blocking wait, SIGTERM→SIGKILL to the group, tool output |
| `jobs.py:72` `list_all`, `:85` `purge` | read all records (finalizing stale ones); drop finished jobs older than a day |
| `codex.py:25` `build_args` | `codex exec --json -C cwd -s sandbox`; on resume `exec resume ID` with `-c sandbox_mode="..."` (resume takes no `-C`/`-s`) |
| `codex.py:43` `parse_events`, `:6` `SANDBOX` | JSONL events → session id, result, error, usage; permission mode → sandbox |
| `follow.py:204` `run`, `:143` `source`, `:159` `Tail` | `shiftover jobs follow ID`: tail the transcript / event stream as short step labels |
| `follow.py:70` `claude_steps`, `:110` `codex_steps`, `:31` `mask` | step labels; secrets masked before printing |

## Data files

All under `~/.cache/shiftover/` (`$XDG_CACHE_HOME`) unless noted; written atomically with mode 0600.

- `~/.config/shiftover/config.toml`: top-level `main`, `threshold`, `lang`, `ignore`; `[accounts.<name>]` `dir`, `email`,
  `display` (UI name; the key stays the name), `models`, `enabled`, `pool` (false = pinned, never an automatic target);
  `[handoff] mode`; `[delegate] wait_seconds`, `permission_mode`, `mcp` (`none`/`main`), `allow_bypass`;
  `[tips] enabled`, `min_interval_min`, `levels`; `[statusline] wrap`; `[codex] enabled`, `bin`; `[map] "<dir>" = "<account>"`.
- `usage.json`: `{"<account dir>": {ts, email, token_fp, limits: [{kind: session|weekly_all|weekly_scoped, model, used,
  resets_at}], extra, err?, retry_at? (429), limits_ts? (windows kept through a failed read), renew_at? (last renewal)}}`.
  `usage.lock` is the cross-process flock.
- `jobs/<id>.json`: `Job` fields: id, account, dir, model, effort, cwd, label, status (running/done/failed/cancelled), pid,
  started, finished, session_id, result, cost_usd, num_turns, duration_ms, error, permission_denials, mcp_file,
  prompt_chars, backend (claude/codex), usage (codex tokens), parent_session_id, parent_pid, transcript_path, log_path.
  Siblings: `<id>.out` (stdout; codex event stream), `<id>.err`, `<id>.last` (codex last message), `<id>.schema`.
- `tmp/mcp-<id>.json`: the delegate's strict MCP config, deleted at finalize. `tmp/renew/`: fixed cwd for renewal runs.
- `runs/<run id>/`: `state.json` (account, dir, cwd, started, flags), `sid`, `pending.json`, `handoff.json`, `notice.json`, `tips.json`.
- `sessions/<session id>.json`: written by the status line (ts, dir, account, model, rate_limits, cwd); `<sid>.tips.json`.
- `~/.local/share/shiftover/mods/`: installed side-panel mod.

## Cross-cutting rules

- **i18n**: every user-facing string goes through `i18n.t(key)` with `en` and `tr` entries in `STRINGS`. Cached
  values stay language-neutral (`usage.RENEWING`, `LOGIN_REQUIRED`) and are worded at display time (`usage.error`).
- **Single flight**: one process probes usage at a time (`usage._lock`, flock with a short wait). A process that cannot
  get it reports the cache instead of probing twice. `_refresh` re-reads the cache under the lock and merges only its updates.
- **Token fingerprint / renewal**: entries carry `token_fp` (sha256 prefix); a different readable token invalidates the
  entry. Tokens within `RENEW_MARGIN` of expiry are never sent. Only the detached `usage --stale` pass runs
  `claude.renew` (at most once per `RENEW_BACKOFF`); interactive callers show "renewing token" with the kept windows.
- **Never log tokens**: tokens live only in memory; store fingerprints, never the token. `follow.mask` hides secret
  shapes in anything printed. No personal data (emails, home paths) in code, docs or tests.
- **Headless delegates**: `claude -p` exits when its turn ends and kills background agents/shells it started, so
  `build_args` appends `HEADLESS_NOTE`. Delegates get `SHIFTOVER_DEPTH=1` and cannot delegate, see only their prompt,
  get an explicit strict MCP config (no user/project servers), and nobody answers their permission prompts.
  `--allowedTools` must stay last. Jobs run in their own process group; cancel signals the group.
- **Hooks never fail loudly**: a hook error would land in the user's session.

## Tests

```sh
uv run --with pytest python -m pytest -q -p no:cacheprovider
```

`tests/conftest.py`: a session sandbox for XDG dirs, a `home` fixture with three fake accounts, `fake_claude` /
`fake_codex` shims that log argv/env/cwd to `claude-calls.jsonl` / `codex-calls.jsonl`, and `SLOW_START` (the generous
wait for a fake process: a fresh script can stall in exec for seconds on a busy machine). `stop_jobs()` kills leftover
jobs and joins their waiter threads.

## Side panel

The Claude Code side-panel mod lives in `src/shiftover/resources/mods/shiftover-panel/`; see its own
`CODEMAP.md` there.
