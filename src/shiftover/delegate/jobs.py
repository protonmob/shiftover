"""Headless `claude -p` runs on another account, tracked as jobs on disk."""
import json
import os
import secrets
import signal
import subprocess
import time
import uuid
from dataclasses import asdict, dataclass, field

from .. import claude, paths
from ..config import Account

_procs: dict[str, subprocess.Popen] = {}
RESULT_MAX = 8000


@dataclass
class Job:
    id: str
    account: str
    dir: str
    model: str | None = None
    effort: str | None = None
    cwd: str = ""
    label: str = ""
    status: str = "running"
    pid: int = 0
    started: float = 0.0
    finished: float = 0.0
    session_id: str = ""
    result: str = ""
    cost_usd: float | None = None
    num_turns: int | None = None
    duration_ms: int | None = None
    error: str = ""
    permission_denials: list = field(default_factory=list)
    mcp_file: str = ""
    prompt_chars: int = 0


def _p(job_id: str, ext: str):
    return paths.jobs_dir() / f"{job_id}.{ext}"


def save(job: Job) -> None:
    paths.write_json(_p(job.id, "json"), asdict(job))


def load(job_id: str) -> Job | None:
    d = paths.read_json(_p(job_id, "json"))
    if not isinstance(d, dict):
        return None
    known = {f for f in Job.__dataclass_fields__}
    return Job(**{k: v for k, v in d.items() if k in known})


def list_all() -> list[Job]:
    out = []
    try:
        files = list(paths.jobs_dir().glob("*.json"))
    except OSError:
        return out
    for f in files:
        j = load(f.stem)
        if j:
            out.append(j)
    return sorted(out, key=lambda j: j.started, reverse=True)


def purge(max_age: float = 86400.0) -> int:
    n = 0
    for j in list_all():
        refresh(j)
        if j.status != "running" and time.time() - (j.finished or j.started) > max_age:
            for ext in ("json", "out", "err"):
                _p(j.id, ext).unlink(missing_ok=True)
            n += 1
    return n


def new_id() -> str:
    return time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)


def build_args(*, model, effort, permission_mode, allowed_tools, json_schema, max_budget_usd, resume_session_id,
               label, mcp_file) -> list[str]:
    args = ["-p", "--output-format", "json", "--name", f"delegate:{label or 'job'}"]
    if resume_session_id:
        args += ["--resume", resume_session_id]
    else:
        args += ["--session-id", str(uuid.uuid4())]
    if model:
        args += ["--model", model]
    if effort:
        args += ["--effort", effort]
    if permission_mode:
        args += ["--permission-mode", permission_mode]
    if json_schema:
        args += ["--json-schema", json.dumps(json_schema)]
    if max_budget_usd is not None:
        args += ["--max-budget-usd", str(max_budget_usd)]
    if mcp_file:
        args += ["--mcp-config", mcp_file, "--strict-mcp-config"]
    if allowed_tools:
        # Variadic flags must come last: they would swallow anything that follows.
        args += ["--allowedTools", *allowed_tools]
    return args


def start(acct: Account, prompt: str, *, model=None, effort=None, cwd=None, permission_mode=None, allowed_tools=None,
          json_schema=None, max_budget_usd=None, resume_session_id=None, label="", mcp_servers: dict | None = None) -> Job:
    binary = claude.claude_bin()
    if not binary:
        raise RuntimeError("claude binary not found")
    job = Job(id=new_id(), account=acct.name, dir=str(acct.path), model=model, effort=effort,
              cwd=str(cwd or os.getcwd()), label=label or "", started=time.time(), prompt_chars=len(prompt))
    if mcp_servers:
        f = paths.tmp_dir() / f"mcp-{job.id}.json"
        paths.write_json(f, {"mcpServers": mcp_servers})
        job.mcp_file = str(f)
    env = claude.env_for(acct.path, {"SHIFTOVER_DEPTH": "1", "SHIFTOVER_ACCOUNT": acct.name,
                                     "SHIFTOVER_ACCOUNT_DIR": str(acct.path)})
    for k in ("SHIFTOVER_RUN_ID", "SHIFTOVER_PID"):
        env.pop(k, None)
    args = build_args(model=model, effort=effort, permission_mode=permission_mode, allowed_tools=allowed_tools,
                      json_schema=json_schema, max_budget_usd=max_budget_usd, resume_session_id=resume_session_id,
                      label=label, mcp_file=job.mcp_file)
    paths.ensure_dir(paths.jobs_dir())
    out = open(_p(job.id, "out"), "wb")
    err = open(_p(job.id, "err"), "wb")
    try:
        proc = subprocess.Popen([binary, *args], stdin=subprocess.PIPE, stdout=out, stderr=err,
                                cwd=job.cwd, env=env, start_new_session=True)
    finally:
        out.close()
        err.close()
    job.pid = proc.pid
    _procs[job.id] = proc
    try:
        proc.stdin.write(prompt.encode("utf-8"))
        proc.stdin.close()
    except (OSError, ValueError):
        pass
    save(job)
    return job


def alive(job: Job) -> bool:
    proc = _procs.get(job.id)
    if proc is not None:
        return proc.poll() is None
    return bool(job.pid) and claude.pid_alive(job.pid)


def _tail(path, n=2000) -> str:
    try:
        data = path.read_bytes()
    except OSError:
        return ""
    return data[-n:].decode("utf-8", "replace").strip()


def finalize(job: Job) -> Job:
    raw = _tail(_p(job.id, "out"), 50_000_000)
    data = None
    try:
        data = json.loads(raw)
    except ValueError:
        for line in reversed(raw.splitlines()):
            try:
                data = json.loads(line)
                break
            except ValueError:
                continue
    if isinstance(data, dict):
        job.session_id = data.get("session_id") or job.session_id
        job.result = data.get("result") if isinstance(data.get("result"), str) else json.dumps(data.get("result"))
        job.cost_usd = data.get("total_cost_usd")
        job.num_turns = data.get("num_turns")
        job.duration_ms = data.get("duration_ms")
        job.permission_denials = data.get("permission_denials") or []
        failed = bool(data.get("is_error")) or (data.get("subtype") not in (None, "success"))
        if job.status != "cancelled":
            job.status = "failed" if failed else "done"
        if failed and not job.result:
            job.error = str(data.get("subtype") or "error")
    else:
        if job.status != "cancelled":
            job.status = "failed"
        job.error = _tail(_p(job.id, "err")) or (raw[-2000:] if raw else "no output")
    job.finished = job.finished or time.time()
    if job.mcp_file:
        try:
            os.unlink(job.mcp_file)
        except OSError:
            pass
        job.mcp_file = ""
    _procs.pop(job.id, None)
    save(job)
    return job


def refresh(job: Job) -> Job:
    if job.status == "running" and not alive(job):
        finalize(job)
    return job


def wait(job: Job, seconds: float) -> Job:
    deadline = time.time() + max(0.0, seconds)
    proc = _procs.get(job.id)
    while job.status == "running" and alive(job):
        left = deadline - time.time()
        if left <= 0:
            break
        if proc is not None:
            try:
                proc.wait(timeout=min(left, 5.0))
            except subprocess.TimeoutExpired:
                pass
        else:
            time.sleep(min(left, 0.5))
    return refresh(job)


def cancel(job: Job) -> Job:
    if job.status == "running" and alive(job):
        try:
            os.kill(job.pid, signal.SIGTERM)
        except OSError:
            pass
        job.status = "cancelled"
        time.sleep(0.5)
        if alive(job):
            try:
                os.kill(job.pid, signal.SIGKILL)
            except OSError:
                pass
            time.sleep(0.2)
        finalize(job)
    return job


def summary(job: Job, max_chars: int = RESULT_MAX) -> dict:
    d = {
        "job_id": job.id, "status": job.status, "account": job.account, "model": job.model, "effort": job.effort,
        "label": job.label, "cwd": job.cwd, "session_id": job.session_id,
        "elapsed_s": round((job.finished or time.time()) - job.started, 1),
    }
    if job.status != "running":
        d.update({"cost_usd": job.cost_usd, "num_turns": job.num_turns, "duration_ms": job.duration_ms,
                  "permission_denials": job.permission_denials})
        res = job.result or ""
        if len(res) > max_chars:
            d["result"] = res[:max_chars]
            d["result_truncated"] = True
            d["result_file"] = str(_p(job.id, "out"))
        else:
            d["result"] = res
        if job.error:
            d["error"] = job.error
    return d
