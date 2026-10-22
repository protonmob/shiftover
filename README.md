# shiftover

Pool several Claude Code subscriptions on one machine. Your main account always drives; when it runs out of room the
*same conversation* continues on another account, and from inside any session Claude can hand self-contained work to
another account with the model and effort you choose.

- **Main first.** `claude` opens your main account. If one of its windows is full, it opens the account with the most
  headroom and says why in one line. Model-aware: `--model opus` looks at each account's Opus window.
- **Hand-off, not restart.** At the end of a turn, when the active account crosses a threshold or hits a rate limit, the
  conversation is resumed on the next account with the same history, model and effort. `/handoff [account] [model] [effort]`
  does it on demand.
- **Delegate.** An MCP server gives Claude three tools: `accounts`, `delegate` and `monitor`. A delegate is a headless
  Claude Code run on another account; its answer comes back into the calling session, long jobs run in the background.
- **Tips.** When it matters, Claude gets one factual line such as *account X has used 88% of its 5-hour window; Y has 80%
  headroom*, and passes it on to you. The status line shows the active account and its windows all the time.
- **Quality of life.** Directory → account map, `sync-mcp` to copy local MCP server definitions between accounts,
  `doctor`, an arrow-key picker, English or Turkish messages.

Everything runs locally. No credentials are copied, moved or shared: each account lives in its own `CLAUDE_CONFIG_DIR`
and spends its own quota.

## Requirements

- macOS (Linux should work but is untested; credentials are read through the macOS Keychain or `.credentials.json`)
- Claude Code ≥ 2.1.224 on `PATH`
- Python ≥ 3.11 (`pipx` or `uv` bring their own)
- Two or more claude.ai accounts you own, each signed into its own config directory

## Install

```bash
pipx install shiftover            # or: uv tool install shiftover
shiftover init --import           # finds ~/.claude and ~/.claude-* and writes ~/.config/shiftover/config.toml
shiftover install                 # hooks + status line + MCP server + /handoff + skill (backs up settings.json first)
echo 'eval "$(shiftover shell-init)"' >> ~/.zshrc   # `claude` now goes through the pool; `cl` opens the picker
shiftover doctor
```

Don't have a second account directory yet?

```bash
shiftover add second              # creates ~/.claude-second, shares skills/settings/sessions with main, opens the sign-in
```

Restart any open Claude Code sessions afterwards so they pick up the hooks.

## How it works

```
shiftover run  ──spawns──▶  claude (CLAUDE_CONFIG_DIR=<account>)
      ▲                        │ status line → sessions/<sid>.json  (rate_limits, model)      official data
      │ SIGUSR1                │ Stop / StopFailure hook → "hand off to <account>"             official hooks
      └────────────────────────┘ resumes `claude --resume <sid>` under the next account
```

- The status line Claude Code already renders carries `rate_limits.five_hour` / `seven_day` for the active account.
  shiftover's status line command stores them per session and appends `account 5h 78% wk 41%` to whatever status line
  you had before.
- The `Stop` hook runs after every turn. If the stored usage is at or above `threshold`, or a `StopFailure` with
  `rate_limit` fires, the hook picks the account with the most headroom for the session's model, writes a hand-off
  request and signals the wrapper. The wrapper ends the `claude` process and starts `claude --resume <session-id>` under the
  other account with the same flags. Transcripts are shared between accounts (symlinked `projects/`), so the conversation
  is intact. If no account has headroom, nothing happens and Claude Code's own wait-for-reset behaviour takes over.
- Other accounts' windows come from the OAuth usage endpoint Claude Code itself uses, read with each account's own token,
  cached for five minutes. It is not a documented API; when it fails shiftover degrades to the official data it has.
- `delegate` runs `claude -p --output-format json` under the chosen account. Nothing from the calling conversation is
  shared except the prompt you write.

## Commands

| Command | What it does |
| --- | --- |
| `shiftover run [--menu] [-a ACCOUNT] [claude args…]` | what the `claude` shell function calls; `--menu` shows the picker, `SHIFTOVER_ACCOUNT=name` forces an account |
| `shiftover status [--refresh] [--json]` | accounts with their windows |
| `shiftover doctor` | sign-in drift, shared directories, hooks, MCP registration, shell wiring |
| `shiftover init --import [--main NAME] [--name DIR=NAME…]` | create the config from existing directories |
| `shiftover add NAME [--dir D] [--no-share] [--main]` / `remove NAME` | manage account directories |
| `shiftover install [--dry-run]` / `uninstall` | wire into / out of Claude Code |
| `shiftover handoff [ACCOUNT] [--model M] [--effort E]` | what `/handoff` runs; takes effect when the turn ends |
| `shiftover map add DIR ACCOUNT` / `map remove DIR` / `map` | directory → account rules |
| `shiftover sync-mcp [--from A] [--to B\|all] [--overwrite]` | copy `mcpServers` definitions between accounts |
| `shiftover jobs [--show ID] [--cancel ID] [--purge]` | delegate jobs |
| `shiftover shell-init` | prints the `claude()` / `cl()` shell functions |

## Config

`~/.config/shiftover/config.toml` (see [`config.example.toml`](config.example.toml)):

```toml
main = "main"
threshold = 95
lang = "en"

[accounts.main]
dir = "~/.claude"
email = "you@example.com"

[accounts.second]
dir = "~/.claude-second"
email = "you+2@example.com"
models = ["opus", "sonnet"]      # optional: this account is skipped when another model is requested

[handoff]
mode = "auto"                    # auto | ask | off

[delegate]
wait_seconds = 90                # foreground wait before a job goes to the background
permission_mode = "default"
mcp = "none"                     # main: give delegates the main account's local MCP servers
allow_bypass = false

[tips]
enabled = true
min_interval_min = 10
levels = [75, 90]

[statusline]
wrap = "bash ~/.claude/my-statusline.sh"   # filled in by `install` from your existing status line

[map]
"~/work/acme" = "second"
```

`email` is what `doctor` and the picker compare against: `/login` takes whatever account the browser has open, so a
directory can silently end up holding the wrong account.

## The delegate tool

Once installed, every account has an MCP server named `shiftover`. The bundled skill tells Claude how to use it; the
short version:

```
delegate(prompt="Review src/payments for race conditions. Repo: /Users/me/app. Return findings as a markdown list.",
         model="opus", effort="max", permission_mode="default")
delegate(prompt="…", background=true)          → job_id
monitor(job_ids=["20261022-141503-a1b2"], wait_seconds=120)
accounts()
```

- `account="auto"` (default) picks the account with the most headroom for the requested model, never the calling one.
- A delegate sees only the prompt. Put the goal, paths, constraints and the output format in it.
- Nobody answers permission prompts in a delegate: read-only work needs nothing, file edits need `permission_mode="acceptEdits"`.
- claude.ai connectors (Gmail, Amplitude, the browser extension, …) are not available in a delegate; do that part in the
  session and delegate the heavy reasoning with the data in the prompt or in files.
- Each delegate spends the target account's quota. Results longer than 8 KB are truncated in the tool result and kept in
  full under `~/.cache/shiftover/jobs/`.

## Shared vs separate directories

`shiftover add` symlinks `CLAUDE.md settings.json settings.local.json agents commands skills hooks output-styles plugins
projects` from the main directory into the new one, so every account has the same setup and can resume any conversation.
If your directories are not shared, shiftover still works, with two caveats: `install` writes hooks into each
`settings.json`, and a hand-off needs the transcript to be visible from the target directory (share at least `projects/`).

User-scoped MCP servers live in each directory's `.claude.json` and are not shared. `sync-mcp` copies the definitions;
servers that authenticate with OAuth must be authorized once in each account (`/mcp`).

## Terms of service

Read Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) and
[Usage Policy](https://www.anthropic.com/legal/aup) before using this. shiftover is built for one person using accounts
they pay for, on their own machine, through Anthropic's own CLI. It never shares credentials, never gives anyone else
access to an account and uses no account you are not signed into yourself. Even so, the Usage Policy forbids
*intentionally bypassing restrictions established within the products*, and switching accounts when one is throttled can
be read that way. Whether that applies to your situation is your call, not the author's. Not legal advice.

## Privacy and security

- Tokens are read from the Keychain (`security find-generic-password`) only to call the usage endpoint, never written or logged.
- State lives in `~/.cache/shiftover` with `0600` files. Temporary `--mcp-config` files are removed when the job ends.
- No telemetry, no network calls other than Anthropic's usage endpoint and whatever `claude` itself does.

## Related tools

[clauth](https://github.com/uwuclxdy/clauth) (switching by swapping credential files, delegate without model-aware
routing), [claude-swap](https://github.com/realiti4/claude-swap) (threshold switching, no delegate),
[cc-same](https://github.com/songkeys/cc-same) (keeps the Desktop app's session list identical across accounts),
[teamclaude](https://github.com/KarpelesLab/teamclaude) (a proxy that rotates tokens). shiftover keeps every account in
its own directory, moves live conversations instead of restarting them, and lets the session itself delegate.

## Development

```bash
git clone https://github.com/kadiraktastr/shiftover && cd shiftover
pipx install --editable .
uv run --with pytest --no-project pytest     # tests use a fake `claude`; no quota is spent
```

MIT © Kadir Aktaş
