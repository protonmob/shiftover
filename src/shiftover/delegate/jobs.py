"""Headless `claude -p` (or `codex exec`) runs on another account, tracked as jobs on disk."""
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
from . import codex

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
    backend: str = "claude"
    usage: dict | None = None


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
            for ext in ("json", "out", "err", "last", "schema"):
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
    # An explicit (possibly empty) strict config is the only way to keep user/project servers out.
    f = paths.tmp_dir() / f"mcp-{job.id}.json"
    paths.write_json(f, {"mcpServers": mcp_servers or {}})
    job.mcp_file = str(f)
    env = claude.env_for(acct.path, {"SHIFTOVER_DEPTH": "1", "SHIFTOVER_ACCOUNT": acct.name,
                                     "SHIFTOVER_ACCOUNT_DIR": str(acct.path)})
    args = build_args(model=model, effort=effort, permission_mode=permission_mode, allowed_tools=allowed_tools,
                      json_schema=json_schema, max_budget_usd=max_budget_usd, resume_session_id=resume_session_id,
                      label=label, mcp_file=job.mcp_file)
    return _launch(job, [binary, *args], env, prompt)


def start_codex(binary: str, prompt: str, *, model=None, effort=None, cwd=None, permission_mode=None, json_schema=None,
                resume_session_id=None, label="") -> Job:
    job = Job(id=new_id(), account="codex", dir="", model=model, effort=effort, cwd=str(cwd or os.getcwd()),
              label=label or "", started=time.time(), prompt_chars=len(prompt), backend="codex")
    paths.ensure_dir(paths.jobs_dir())
    schema_file = None
    if json_schema:
        schema_file = _p(job.id, "schema")
        paths.write_json(schema_file, json_schema)
    args = codex.build_args(model=model, effort=effort, cwd=job.cwd, permission_mode=permission_mode,
                            resume_session_id=resume_session_id, last_message_file=_p(job.id, "last"), schema_file=schema_file)
    env = dict(os.environ)
    for k in ("SHIFTOVER_RUN_ID", "SHIFTOVER_PID", "CLAUDE_CONFIG_DIR"):
        env.pop(k, None)
    env["SHIFTOVER_DEPTH"] = "1"
    return _launch(job, [binary, *args], env, prompt)


def _private_file(path):
    return os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "wb")


def _launch(job: Job, argv: list[str], env: dict, prompt: str) -> Job:
    for k in ("SHIFTOVER_RUN_ID", "SHIFTOVER_PID"):
        env.pop(k, None)
    paths.ensure_dir(paths.jobs_dir())
    out = _private_file(_p(job.id, "out"))
    err = _private_file(_p(job.id, "err"))
    try:
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=out, stderr=err,
                                cwd=job.cwd, env=env, start_new_session=True)
    except OSError as e:
        out.close()
        err.close()
        job.status, job.error, job.finished = "failed", f"cannot start {argv[0]}: {e}", time.time()
        _cleanup(job)
        save(job)
        return job
    finally:
        if not out.closed:
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


def _command_of(pid: int) -> str:
    try:
        return subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def alive(job: Job) -> bool:
    proc = _procs.get(job.id)
    if proc is not None:
        return proc.poll() is None
    if not job.pid or not claude.pid_alive(job.pid):
        return False
    # After a restart the pid may belong to anything; only our own backend binary counts.
    return job.backend in _command_of(job.pid) or "claude" in _command_of(job.pid)


def _tail(path, n=2000) -> str:
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - n))
            data = f.read()
    except OSError:
        return ""
    return data.decode("utf-8", "replace").strip()


def _cleanup(job: Job) -> None:
    if job.mcp_file:
        try:
            os.unlink(job.mcp_file)
        except OSError:
            pass
        job.mcp_file = ""
    _procs.pop(job.id, None)


def _finalize_codex(job: Job) -> Job:
    ev = codex.parse_events(_tail(_p(job.id, "out"), 50_000_000))
    job.session_id = ev["session_id"] or job.session_id
    job.result = ev["result"]
    if not job.result:
        job.result = _tail(_p(job.id, "last"), 50_000_000)
    job.num_turns = ev["turns"] or None
    job.usage = ev["usage"]
    if job.status != "cancelled":
        job.status = "failed" if (ev["error"] and not job.result) else "done"
    if ev["error"]:
        job.error = ev["error"]
    elif job.status == "failed":
        job.error = _tail(_p(job.id, "err")) or "no output"
    job.finished = job.finished or time.time()
    job.duration_ms = int((job.finished - job.started) * 1000)
    _cleanup(job)
    save(job)
    return job


def finalize(job: Job) -> Job:
    if job.backend == "codex":
        return _finalize_codex(job)
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
        structured = data.get("structured_output")
        if structured is not None:
            job.result = json.dumps(structured, ensure_ascii=False)
        else:
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
    _cleanup(job)
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


def _signal_group(job: Job, sig) -> None:
    # The job started its own session, so its pid is the process group: children go with it.
    try:
        os.killpg(job.pid, sig)
    except OSError:
        try:
            os.kill(job.pid, sig)
        except OSError:
            pass


def cancel(job: Job) -> Job:
    refresh(job)
    if job.status == "running" and alive(job):
        _signal_group(job, signal.SIGTERM)
        job.status = "cancelled"
        deadline = time.time() + 3
        while alive(job) and time.time() < deadline:
            time.sleep(0.1)
        if alive(job):
            _signal_group(job, signal.SIGKILL)
            time.sleep(0.2)
        proc = _procs.get(job.id)
        if proc is not None:
            try:
                proc.wait(1)
            except subprocess.TimeoutExpired:
                pass
        finalize(job)
    return job


def summary(job: Job, max_chars: int = RESULT_MAX) -> dict:
    d = {
        "job_id": job.id, "status": job.status, "account": job.account, "backend": job.backend, "model": job.model,
        "effort": job.effort, "label": job.label, "cwd": job.cwd, "session_id": job.session_id,
        "elapsed_s": round((job.finished or time.time()) - job.started, 1),
    }
    if job.status != "running":
        d.update({"cost_usd": job.cost_usd, "num_turns": job.num_turns, "duration_ms": job.duration_ms,
                  "permission_denials": job.permission_denials})
        if job.usage:
            d["usage"] = job.usage
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
