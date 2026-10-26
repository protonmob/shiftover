"""OpenAI Codex CLI as a delegate backend: `codex exec` run headless, events parsed from its JSONL stream."""
import json
import shutil
import subprocess

SANDBOX = {"default": "read-only", "plan": "read-only", "dontAsk": "read-only",
           "acceptEdits": "workspace-write", "bypassPermissions": "danger-full-access"}
# Codex reads its reasoning effort from its own config; "max" is left to that default.
EFFORTS = {"low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh"}


def binary(cfg) -> str | None:
    if not cfg or not cfg.codex_enabled:
        return None
    return shutil.which(cfg.codex_bin or "codex")


def version(path: str) -> str:
    try:
        return subprocess.run([path, "--version"], capture_output=True, text=True, timeout=15).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def build_args(*, model, effort, cwd, permission_mode, resume_session_id, last_message_file, schema_file) -> list[str]:
    sandbox = SANDBOX.get(permission_mode or "default", "read-only")
    if resume_session_id:
        # `exec resume` takes neither -C nor -s: the job starts in cwd and the sandbox goes in as config.
        args = ["exec", "resume", resume_session_id, "--json", "--skip-git-repo-check", "-o", str(last_message_file),
                "-c", f'sandbox_mode="{sandbox}"']
    else:
        args = ["exec", "--json", "--skip-git-repo-check", "-C", str(cwd), "-o", str(last_message_file), "-s", sandbox]
    if model:
        args += ["-m", model]
    if effort in EFFORTS:
        args += ["-c", f'model_reasoning_effort="{EFFORTS[effort]}"']
    if schema_file:
        args += ["--output-schema", str(schema_file)]
    args.append("-")
    return args


def parse_events(raw: str) -> dict:
    """Pulls session id, final message, errors and token usage out of the JSONL event stream."""
    out = {"session_id": "", "result": "", "error": "", "usage": None, "turns": 0}
    for line in raw.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if not isinstance(ev, dict):
            continue
        kind = ev.get("type")
        if kind == "thread.started":
            out["session_id"] = str(ev.get("thread_id") or "")
        elif kind == "turn.started":
            out["turns"] += 1
        elif kind == "turn.completed":
            out["usage"] = ev.get("usage")
        elif kind == "turn.failed":
            out["error"] = str((ev.get("error") or {}).get("message") or ev.get("error") or "turn failed")
        elif kind == "item.completed":
            item = ev.get("item") or {}
            if item.get("type") == "agent_message":
                out["result"] = str(item.get("text") or "")
            elif item.get("type") == "error" and "hook" not in str(item.get("message", "")):
                out["error"] = str(item.get("message") or "error")
    return out
