# Changelog

## Unreleased

- Accounts can be kept out of the pool (`pool = false`, or the second `setup` question): opened only on request, never a hand-off or delegate target, and never left for another account when full.
- `shiftover remove` is remembered (`ignore` list); `setup` no longer re-adds a removed directory.
- Delegate to the OpenAI Codex CLI: `delegate(account="codex")`, listed by `accounts()`, `status` and `doctor`.
- Hand-off checks that the target can see the transcript before leaving an account; when it cannot, the session resumes where it was and Claude is told why.
- Review fixes: auth-override environment variables are dropped for pooled launches; resume flags keep `--flag=value`, variadic and `--` forms intact; hooks no longer wait past their budget on slow usage probes; the status-line wrapper runs in its own process group with a hard timeout; settings writes keep file modes and never touch the home directory's; only shiftover's own hooks are removed on uninstall, which now also removes the shell line; MCP registration failures are reported; delegates always get an explicit (strict) MCP config, cancellation kills the whole process group, finished-but-unpolled jobs finalize, structured output is returned when present; malformed JSON-RPC envelopes no longer stop the MCP server.
- `shiftover setup`: one command that finds every signed-in account, asks only for the main one, installs everything and wires the shell; plain-language output in English and Turkish (picked from the OS locale on first run). Account names default to the e-mail's local part.
- README: plain-language intro, diagrams and terminal mock-ups under `docs/`.
- Initial release: account pool, main-first launch with automatic fallback, mid-conversation hand-off, `delegate` MCP tool, tips, status line, directory map, `sync-mcp`.
