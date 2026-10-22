---
name: shiftover
description: Use when a task could run on another Claude Code account (the `delegate` MCP tool), when the current account is near its usage limit, or when the user mentions handing off, delegating, quotas, or other accounts.
---

# shiftover: several accounts, one conversation

The machine has several Claude Code accounts pooled by `shiftover`. Each account has its own 5-hour and weekly usage
windows. The session you are in runs on one of them; the others can do work for you.

## Delegate a task (MCP server `shiftover`)

- `accounts()` lists every account with its usage windows and headroom, and the Codex CLI backend when it is installed.
  Call it before choosing an account by hand; `delegate(account="auto")` already picks the account with the most
  headroom for the requested model. Accounts marked `pinned` are kept out of the pool on purpose: never use them unless
  the user names one.
- `delegate(account="codex")` runs the task on the OpenAI Codex CLI (its own subscription, no Claude quota). Good for a
  second opinion, a review, or when every Claude account is low. `permission_mode` becomes Codex's sandbox;
  `allowed_tools`, `mcp` and `max_budget_usd` do not apply there.
- `delegate(prompt, account="auto", model=None, effort=None, cwd=None, background=False, wait_seconds=90,
  permission_mode="default", allowed_tools=[], mcp="none", json_schema=None, max_budget_usd=None, resume_session_id=None,
  label=None)` runs a headless Claude Code session on that account and returns its answer.
- `monitor(job_ids=[...], wait_seconds=0, cancel=False)` collects background jobs.

Rules that make delegation work:

1. The delegate sees **only the prompt**. Put everything it needs in there: the goal, the working directory (`cwd`),
   exact file paths, constraints, the format you want back. It cannot see this conversation.
2. Nobody answers permission prompts in a delegate. Analysis and read-only work need nothing. Work that edits files needs
   `permission_mode="acceptEdits"` (or `allowed_tools`). Never ask for `bypassPermissions` unless the user did.
3. Anything that may take more than a minute goes `background=true`; keep working and collect it with `monitor` later,
   or ask for a `notify`-style check when the user wants the result.
4. Delegates have no claude.ai connectors (Gmail, Amplitude, browser, etc.). Do connector work here, then delegate the
   heavy reasoning, refactor, review or generation with the data in the prompt or in files.
5. The result includes a `session_id`; `resume_session_id` continues that delegate with follow-up questions instead of
   starting over.
6. Each delegate spends the target account's quota. Prefer one well-written prompt over many small ones.

Good fits: long refactors, exhaustive reviews, test generation, "think hard about X" at `effort="max"`, parallel
independent chunks (one delegate each), anything you would otherwise do here while the account is near its limit.

## Hand the conversation off

`/handoff [account] [model] [effort]` moves this very conversation (full history) to another account at the end of the
turn. Automatic hand-off is configured in `~/.config/shiftover/config.toml`; when a tip from shiftover says the current
account is near its limit, mention it to the user in one line and keep going.
