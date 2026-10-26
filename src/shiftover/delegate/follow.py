"""`shiftover jobs follow`: a delegate job's steps as they happen, read from its Claude Code transcript or its codex
event stream. Tool results, thinking and full tool inputs stay out: each step is a short label."""
import json
import os
import re
import sys
import time
from pathlib import Path

from .. import claude, usage
from ..i18n import t
from . import jobs

POLL = 1.0
SKEW = 2.0
TEXT_MAX = 160
LABEL_MAX = 80
EDITS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
SEARCHES = {"Grep", "Glob"}
AGENTS = {"Agent", "Task"}
# Common secret shapes, masked in anything printed: a command line or a message can carry one.
SECRETS = [
    re.compile(r"(?i)(bearer\s+)[^\s'\"]+"),
    re.compile(r"(?i)((?:api[_-]?key|token|secret|passw(?:or)?d)['\"]?\s*[=:]\s*['\"]?)[^\s'\"&]+"),
    re.compile(r"()\b(?:sk-[\w-]{12,}|gh[pousr]_\w{12,}|github_pat_\w{12,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16})"),
]
# codex runs every command through a login shell: show what it runs.
SHELL = re.compile(r"^\S*?sh\s+-l?c\s+(['\"])(.*)\1$", re.S)


def mask(text: str) -> str:
    for rx in SECRETS:
        text = rx.sub(lambda m: m.group(1) + "***", text)
    return text


def _line(text, limit: int) -> str:
    """The first non-empty line, masked and cut to limit; "…" marks anything left out."""
    lines = [ln.strip() for ln in str(text or "").splitlines() if ln.strip()]
    line = mask(lines[0]) if lines else ""
    if len(line) > limit:
        return line[:limit - 1] + "…"
    return line + "…" if len(lines) > 1 else line


def _rel(path, cwd: str) -> str:
    """path as seen from the job's folder; one outside it stays whole, with ~ for home."""
    p = os.path.normpath(os.path.join(cwd or "/", str(path)))
    for base in dict.fromkeys((cwd, os.path.realpath(cwd))) if cwd else ():
        if p == base or p.startswith(base.rstrip("/") + "/"):
            return os.path.relpath(p, base)
    home = str(Path.home())
    return "~" + p[len(home):] if p.startswith(home + "/") else p


def _tool(name: str, inp: dict, cwd: str) -> str:
    if name in EDITS:
        return t("follow_edit", path=_rel(inp.get("file_path") or inp.get("notebook_path") or "?", cwd))
    if name == "Read":
        return t("follow_read", path=_rel(inp.get("file_path") or "?", cwd))
    if name in SEARCHES:
        return t("follow_search", pattern=_line(inp.get("pattern"), LABEL_MAX))
    if name == "Bash":
        return t("follow_command", command=_line(inp.get("command"), LABEL_MAX))
    if name in AGENTS:
        return t("follow_agent", desc=_line(inp.get("description") or inp.get("subagent_type"), LABEL_MAX))
    return t("follow_tool", name=name)


def claude_steps(entry, cwd: str) -> list[str]:
    """The steps in one transcript line. Only the agent's own messages count: results, request copies
    (api-request-blob repeats earlier blocks) and subagents' lines stay out."""
    if not isinstance(entry, dict) or entry.get("type") != "assistant" or entry.get("isSidechain"):
        return []
    msg = entry.get("message")
    content = msg.get("content") if isinstance(msg, dict) else None
    if isinstance(content, str):
        content = [{"type": "text", "text": content}]
    out = []
    for block in content if isinstance(content, list) else []:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            text = _line(block.get("text"), TEXT_MAX)
            if text:
                out.append(f"› {text}")
        elif block.get("type") in ("tool_use", "server_tool_use"):
            inp = block.get("input")
            out.append(_tool(str(block.get("name") or "?"), inp if isinstance(inp, dict) else {}, cwd))
    return out


def in_run(entry, job: jobs.Job) -> bool:
    """Whether a transcript line was written during this job: a resumed session's file also holds the runs before
    it, and any run that resumes it later."""
    when = usage.parse_ts(entry.get("timestamp")) if isinstance(entry, dict) else None
    if when is None:
        return True
    ts = when.timestamp()
    return ts >= job.started - SKEW and (job.status == "running" or not job.finished or ts <= job.finished + SKEW)


def _unwrap(command) -> str:
    if isinstance(command, list):
        command = " ".join(map(str, command))
    m = SHELL.match(str(command))
    return m.group(2) if m else str(command)


def codex_steps(ev, cwd: str, seen: set) -> list[str]:
    """The steps in one codex event; an item shows once, when it first carries what its label needs."""
    item = ev.get("item") if isinstance(ev, dict) else None
    if not isinstance(item, dict) or ev.get("type") not in ("item.started", "item.updated", "item.completed"):
        return []
    key, kind = item.get("id"), item.get("type")
    if key is not None and key in seen:
        return []
    out = []
    if kind == "agent_message" and ev["type"] == "item.completed":
        text = _line(item.get("text"), TEXT_MAX)
        out = [f"› {text}"] if text else []
    elif kind == "command_execution" and item.get("command"):
        out = [t("follow_command", command=_line(_unwrap(item["command"]), LABEL_MAX))]
    elif kind == "file_change" and item.get("changes"):
        out = [t("follow_edit", path=_rel(c.get("path") or "?", cwd)) for c in item["changes"] if isinstance(c, dict)]
    elif kind == "web_search" and item.get("query"):
        out = [t("follow_search", pattern=_line(item["query"], LABEL_MAX))]
    elif kind == "mcp_tool_call" and item.get("tool"):
        out = [t("follow_tool", name=f"{item.get('server') or '?'}.{item['tool']}")]
    if out and key is not None:
        seen.add(key)
    return out


def _newest(folder: Path, since: float, skip: str) -> Path | None:
    try:
        found = [(p.stat().st_mtime, p) for p in folder.glob("*.jsonl") if not p.name.startswith("agent-") and p.stem != skip]
    except OSError:
        return None
    return max((x for x in found if x[0] >= since), default=(0, None))[1]


def source(job: jobs.Job) -> Path | None:
    """The file a job's steps are read from, once it exists."""
    if job.backend == "codex":
        path = Path(job.log_path) if job.log_path else jobs._p(job.id, "out")
        return path if path.exists() else None
    if job.transcript_path and Path(job.transcript_path).exists():
        return Path(job.transcript_path)
    if not job.dir:
        return None
    if job.session_id:
        return claude.find_transcript(job.dir, job.session_id)
    # A job from before ids were chosen up front: the newest transcript its folder gained since it started,
    # never the calling chat's own.
    return _newest(claude.project_dir(job.dir, job.cwd), job.started, job.parent_session_id)


class Tail:
    """The complete lines a growing file gains between reads; a missing file has none yet."""

    def __init__(self, path: Path | None = None):
        self.path, self.pos, self.rest = path, 0, b""

    def lines(self) -> list[str]:
        if self.path is None:
            return []
        try:
            with open(self.path, "rb") as f:
                if os.fstat(f.fileno()).st_size < self.pos:
                    self.pos, self.rest = 0, b""
                f.seek(self.pos)
                data = f.read()
        except OSError:
            return []
        self.pos += len(data)
        *done, self.rest = (self.rest + data).split(b"\n")
        return [x.decode("utf-8", "replace") for x in done if x.strip()]


def _duration(seconds: float) -> str:
    s = max(0, int(seconds))
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    if h:
        return t("follow_hm", h=h, m=m)
    return t("follow_ms", m=m, s=s) if m else t("follow_s", s=s)


def summary_line(job: jobs.Job) -> str:
    """How the job ended, in one line, from its record."""
    word = {"done": "follow_done", "failed": "follow_failed", "cancelled": "follow_cancelled"}.get(job.status)
    parts = [t(word) if word else job.status, _duration((job.finished or time.time()) - job.started)]
    if isinstance(job.cost_usd, (int, float)):
        parts.append(f"${job.cost_usd:.2f}")
    if job.num_turns:
        parts.append(t("follow_turns", n=job.num_turns))
    line = " · ".join(parts)
    if job.status == "failed" and job.error:
        line += ": " + _line(job.error, LABEL_MAX)
    return line


def run(job_id: str, out=None, poll: float = POLL) -> int:
    """Prints the steps so far, then each new one, until the job's record says it ended; 0 when it is done."""
    out = out or sys.stdout
    job = jobs.load(job_id)
    tail, seen = Tail(), set()
    try:
        while True:
            # The status is read before the file, so every step written before the end is printed.
            job = jobs.refresh(jobs.load(job_id) or job)
            if tail.path is None:
                tail.path = source(job)
            for raw in tail.lines():
                try:
                    entry = json.loads(raw)
                except ValueError:
                    continue
                if job.backend == "codex":
                    steps = codex_steps(entry, job.cwd, seen)
                else:
                    steps = claude_steps(entry, job.cwd) if in_run(entry, job) else []
                for step in steps:
                    print(mask(step), file=out, flush=True)
            if job.status != "running":
                print(summary_line(job), file=out, flush=True)
                return 0 if job.status == "done" else 1
            time.sleep(poll)
    except KeyboardInterrupt:
        return 130
    except BrokenPipeError:
        # Read through `| head`: nobody is left to print to, not even at exit.
        try:
            os.dup2(os.open(os.devnull, os.O_WRONLY), out.fileno())
        except (OSError, ValueError):
            pass
        return 0
